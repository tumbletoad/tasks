// A property test over random sequences of folder operations on two machines, a Linux and a Windows
// one: a person sets and clears projects' and tasks' folders, moves tasks between projects, deletes
// and restores projects, undoes and redoes; an agent sets projects' folders too, on no undo stack.
// Paths come from small sets per machine, so two projects often reach for one folder, by the same
// spelling or, on Windows, another case. After every step:
// - an owner has at most one live folder per machine;
// - two live projects never have one folder on one machine, by that machine's case rule;
// - a project's folder change moved exactly its tasks' folders inside the old one, to the same
//   place inside the new one, and changed no other folder;
// - an undo that applied whole, of a commit nobody else's change followed, gives back the space as
//   it was before that commit, and its redo the space as that commit left it.
// Each run ends with A1's history invariants (write-helpers.ts: checkHistory). Fixture paths only:
// nothing here looks at a folder.
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { openSpace } from "../src/space.ts";
import { folderKey, rebased, type FolderOs } from "../src/write/folders.ts";
import type { Credential, Operation, WriteResult } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("folders-model");
afterAll(temp.cleanup);

const PATHS: Readonly<Record<FolderOs, readonly string[]>> = {
  linux: ["~/Dev/a", "~/Dev/a/x", "~/Dev/a/x/y", "~/Dev/b", "~/Dev/A", "/srv/c"],
  windows: ["~\\Dev\\a", "~\\dev\\A", "~\\Dev\\a\\x", "D:\\w", "D:\\w\\z", "D:\\W\\z"],
  macos: [],
};

const PROJECTS = 4;
/** Tasks start in the first two projects; the last two start empty, so they can be deleted. */
const TASKS = 4;

type Step =
  | { kind: "project_set"; who: "human" | "agent"; m: number; p: number; path: number }
  | { kind: "project_clear"; m: number; p: number }
  | { kind: "task_set"; m: number; t: number; path: number }
  | { kind: "task_clear"; m: number; t: number }
  | { kind: "move"; t: number; p: number }
  | { kind: "delete"; p: number }
  | { kind: "restore"; p: number }
  /** An agent sets a project's folder to one a project had and lost: a delete's, a clear's. */
  | { kind: "steal"; m: number; p: number; pick: number }
  | { kind: "undo"; partial: boolean }
  | { kind: "redo" };

const m = fc.nat({ max: 1 });
const p = fc.nat({ max: PROJECTS - 1 });
const t = fc.nat({ max: TASKS - 1 });
const path = fc.nat({ max: 5 });
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("project_set" as const),
      who: fc.constantFrom("human" as const, "agent" as const),
      m,
      p,
      path,
    }),
    weight: 6,
  },
  { arbitrary: fc.record({ kind: fc.constant("project_clear" as const), m, p }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("task_set" as const), m, t, path }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("task_clear" as const), m, t }), weight: 1 },
  {
    arbitrary: fc.record({ kind: fc.constant("move" as const), t, p: fc.nat({ max: PROJECTS }) }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), p }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("restore" as const), p }), weight: 3 },
  {
    arbitrary: fc.record({ kind: fc.constant("steal" as const), m, p, pick: fc.nat() }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("undo" as const), partial: fc.boolean() }),
    weight: 5,
  },
  { arbitrary: fc.record({ kind: fc.constant("redo" as const) }), weight: 3 },
);

interface FolderState {
  id: string;
  kind: string;
  owner: string;
  machine: string;
  path: string;
  live: boolean;
}

/** What an undo must give back: the live folders, the live projects and each task's project. */
interface Snapshot {
  folders: Record<string, string>;
  projects: string[];
  tasks: Record<string, string | null>;
}

interface World {
  fx: Fixture;
  machines: { id: Id<"m">; os: FolderOs; human: Credential; agent: Credential }[];
  projects: Id<"p">[];
  tasks: Id<"t">[];
}

async function world(): Promise<World> {
  const fx = await writeFixture(temp.make(), { flush: false });
  const second = newId("m");
  fx.writer.close();
  const conn = openSpace(await checkedDriver(), fx.folder, { role: "writer" }).conn;
  try {
    conn.pragma("synchronous", "OFF");
    conn.transaction("immediate", () => {
      const seq = Number(conn.prepare("SELECT last_seq AS seq FROM space").get()?.["seq"]);
      conn
        .prepare(
          "INSERT INTO machines (id, name, os, first_seen, retired_at, created_seq, version, " +
            "fv, fp) VALUES ($id, 'mira-laptop', 'windows', 0, NULL, $seq, $seq, '{}', '{}')",
        )
        .run({ id: second, seq });
    });
  } finally {
    conn.close();
  }
  fx.reopen();
  const machines = [
    { id: fx.human.machine_id, os: "linux" as const },
    { id: second, os: "windows" as const },
  ].map((machine) => ({
    ...machine,
    human: { ...fx.human, machine_id: machine.id },
    agent: { ...fx.codex, machine_id: machine.id },
  }));
  const projects = Array.from({ length: PROJECTS }, () => newId("p"));
  const tasks = Array.from({ length: TASKS }, () => newId("t"));
  const ops: Operation[] = [
    ...projects.map((id, k): Operation => ({ kind: "project.create", id, title: `P${String(k)}` })),
    ...tasks.map((id, k): Operation => ({
      kind: "task.create",
      id,
      title: `T${String(k)}`,
      project: projects[k % 2] ?? "",
    })),
  ];
  const created = fx.writer.submit(fx.request(fx.codex, ops));
  if (created.status !== "applied") throw new Error("the world was not created");
  return { fx, machines, projects, tasks };
}

function folders(w: World): FolderState[] {
  return w.fx.reader
    .prepare("SELECT * FROM folders ORDER BY id")
    .all()
    .map((r) => ({
      id: String(r["id"]),
      kind: String(r["owner_kind"]),
      owner: String(r["owner_id"]),
      machine: String(r["machine_id"]),
      path: String(r["path"]),
      live: r["deleted_at"] === null,
    }));
}

function snapshot(w: World): Snapshot {
  return {
    folders: Object.fromEntries(
      folders(w)
        .filter((f) => f.live)
        .map((f) => [f.id, f.path]),
    ),
    projects: w.fx.reader
      .prepare("SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY id")
      .all()
      .map((r) => String(r["id"])),
    tasks: Object.fromEntries(
      w.fx.reader
        .prepare("SELECT id, project_id FROM tasks ORDER BY id")
        .all()
        .map((r) => [String(r["id"]), (r["project_id"] as string | null) ?? null]),
    ),
  };
}

function checkInvariants(w: World): void {
  const all = folders(w).filter((f) => f.live);
  const owners = new Set<string>();
  for (const f of all) {
    const key = `${f.kind}|${f.owner}|${f.machine}`;
    expect(owners.has(key), `one live folder per owner and machine: ${key}`).toBe(false);
    owners.add(key);
  }
  const liveProjects = new Set(snapshot(w).projects);
  for (const machine of w.machines) {
    const keys = all
      .filter((f) => f.kind === "project" && f.machine === machine.id && liveProjects.has(f.owner))
      .map((f) => folderKey(f.path, machine.os));
    expect(new Set(keys).size, `two live projects on one folder of ${machine.os}`).toBe(
      keys.length,
    );
  }
}

/** A commit on the person's stack, with the space before and after it. */
interface Entry {
  before: Snapshot;
  after: Snapshot;
  /** Nobody else's change came after it, so its undo must give back `before` exactly. */
  clean: boolean;
}

async function run(steps: readonly Step[]): Promise<void> {
  const w = await world();
  const done: Entry[] = [];
  const undone: Entry[] = [];
  const dirty = (): void => {
    for (const e of [...done, ...undone]) e.clean = false;
  };
  try {
    for (const s of steps) {
      const before = snapshot(w);
      const beforeFolders = folders(w);
      const machine = "m" in s ? w.machines[s.m] : undefined;
      const human = machine?.human ?? w.fx.human;
      let ops: Operation[] | undefined;
      let actor = human;
      switch (s.kind) {
        case "project_set":
          if (s.who === "agent") actor = machine?.agent ?? w.fx.codex;
          ops = [
            {
              kind: "project.folder_set",
              project: w.projects[s.p] ?? "",
              path: PATHS[machine?.os ?? "linux"][s.path] ?? "",
            },
          ];
          break;
        case "project_clear":
          ops = [{ kind: "project.folder_clear", project: w.projects[s.p] ?? "" }];
          break;
        case "task_set":
          ops = [
            {
              kind: "task.folder_set",
              task: w.tasks[s.t] ?? "",
              path: PATHS[machine?.os ?? "linux"][s.path] ?? "",
            },
          ];
          break;
        case "task_clear":
          ops = [{ kind: "task.folder_clear", task: w.tasks[s.t] ?? "" }];
          break;
        case "move":
          ops = [
            {
              kind: "task.move",
              task: w.tasks[s.t] ?? "",
              project: s.p === PROJECTS ? null : (w.projects[s.p] ?? ""),
            },
          ];
          break;
        case "delete":
          ops = [{ kind: "project.delete", project: w.projects[s.p] ?? "" }];
          break;
        case "restore": {
          // A deleted project when there is one: restoring a live one only tests the refusal.
          const deleted = w.projects.filter((id) => !before.projects.includes(id));
          const target = deleted.length > 0 ? deleted[s.p % deleted.length] : w.projects[s.p];
          ops = [{ kind: "project.restore", project: target ?? "" }];
          break;
        }
        case "steal": {
          const lost = beforeFolders.filter(
            (f) => !f.live && f.kind === "project" && f.machine === machine?.id,
          );
          const taken = lost[s.pick % Math.max(lost.length, 1)];
          if (taken === undefined) continue;
          actor = machine?.agent ?? w.fx.codex;
          ops = [{ kind: "project.folder_set", project: w.projects[s.p] ?? "", path: taken.path }];
          break;
        }
        case "undo":
        case "redo":
          break;
      }
      let result: WriteResult;
      if (ops !== undefined) {
        const person = actor.actor_kind === "human";
        result = w.fx.writer.submit(
          w.fx.request(actor, ops, {
            base: w.fx.base(),
            ...(person ? { undoable: true } : {}),
          }),
        );
        if (result.status === "applied") {
          if (person) {
            done.push({ before, after: snapshot(w), clean: true });
            undone.length = 0;
          } else dirty();
        }
      } else {
        result = w.fx.writer.submit(
          w.fx.request(w.fx.human, [
            s.kind === "undo"
              ? { kind: "undo", ...(s.partial ? { partial: true } : {}) }
              : { kind: "redo" },
          ]),
        );
        if (result.status === "applied") {
          const whole = result.conflicts.length === 0;
          if (s.kind === "undo") {
            const entry = done.pop();
            if (entry !== undefined) {
              if (whole && entry.clean)
                expect(snapshot(w), "an undo gives back the space").toEqual(entry.before);
              if (!whole) entry.clean = false;
              undone.unshift(entry);
            }
          } else {
            const entry = undone.shift();
            if (entry !== undefined) {
              if (entry.clean)
                expect(snapshot(w), "a redo gives back the commit").toEqual(entry.after);
              done.push(entry);
            }
          }
          if (!whole) dirty();
        }
      }
      expect(["applied", "unchanged", "conflict", "rejected"]).toContain(result.status);
      checkInvariants(w);
      // A project's folder change on a machine moved exactly its tasks' folders inside the old one.
      if (s.kind === "project_set" && result.status === "applied" && machine !== undefined) {
        const project = w.projects[s.p] ?? "";
        const old = beforeFolders.find(
          (f) => f.live && f.kind === "project" && f.owner === project && f.machine === machine.id,
        );
        const to = PATHS[machine.os][s.path] ?? "";
        const inProject = new Set(
          Object.entries(before.tasks)
            .filter(([, owner]) => owner === project)
            .map(([task]) => task),
        );
        const after = new Map(folders(w).map((f) => [f.id, f]));
        for (const f of beforeFolders) {
          if (!f.live) continue;
          const now = after.get(f.id);
          let expected = f.path;
          if (f.kind === "project" && f.owner === project && f.machine === machine.id)
            expected = to;
          else if (
            old !== undefined &&
            f.kind === "task" &&
            f.machine === machine.id &&
            inProject.has(f.owner)
          ) {
            expected = rebased(f.path, old.path, to, machine.os) ?? f.path;
          }
          expect(now?.path, "a folder change moves exactly the folders inside").toBe(expected);
        }
      }
    }
    checkHistory(w.fx.reader);
  } finally {
    w.fx.close();
  }
}

describe("[A1.5.write.folders-model] random folder operations, deletes, restores, undos and redos on two machines", () => {
  test("one folder per owner and machine, never two live projects on one folder, moves carry exactly the folders inside, and undo gives back what was", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 40 }), async (steps) => {
        await run(steps);
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
