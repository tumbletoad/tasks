// A property test over random sequences of folder operations on two machines, a Linux and a Windows
// one: a person sets and clears projects' and tasks' folders, moves tasks between projects and
// projects between areas, deletes and restores tasks and projects, undoes and redoes; an agent does
// most of these too, in between, on no undo stack. Paths come from small sets per machine, so two
// projects often reach for one folder, by the same spelling or, on Windows, another case, and one
// project's folder is often inside another's. After every step:
// - an owner has at most one live folder per machine;
// - two live projects never have one folder on one machine, by that machine's case rule;
// - a deleted project holds no live folder and no live task, and a task is in its project's area;
// - a folder change that names the owners whose folders moved with it (`carry`) moved each of
//   their folders on that machine that is the old one or inside it, projects' and tasks' alike, to
//   the same place inside the new one, unless the new folder is around or inside the old one, and
//   changed no other folder; one that names none changed the owner's folder alone (worked out here
//   apart from the writer's code);
// - an undo that applied whole, of a commit nobody else's change followed, gives back the space as
//   it was before that commit, and its redo the space as that commit left it.
// Each run ends with A1's history invariants (write-helpers.ts: checkHistory). Fixture paths only:
// nothing here looks at a folder.
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { openSpace } from "../src/space.ts";
import { folderKey, type FolderOs } from "../src/write/folders.ts";
import type { Credential, Operation, WriteResult } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("folders-model");
// Each run gets its own copy of one fixture space, made once.
const fixture = fixtureCopies(temp.make, { flush: false });
afterAll(temp.cleanup);

const PATHS: Readonly<Record<FolderOs, readonly string[]>> = {
  linux: ["~/work/a", "~/work/a/x", "~/work/a/x/y", "~/work/b", "~/work/A", "/srv/c"],
  windows: ["~\\Dev\\a", "~\\dev\\A", "~\\Dev\\a\\x", "D:\\w", "D:\\w\\z", "D:\\W\\z"],
  macos: [],
};

const PROJECTS = 4;
/** Tasks start in the first two projects; the last two start empty, so they can be deleted. */
const TASKS = 4;
/** Areas a project moves between; the last index is no area. */
const AREAS = 2;

type Who = "human" | "agent";
/** The owners a folder change carries, by index: the projects, then the tasks. */
type Carry = readonly number[];

type Step =
  | { kind: "project_set"; who: Who; m: number; p: number; path: number; carry: Carry }
  | { kind: "project_clear"; m: number; p: number }
  | { kind: "task_set"; m: number; t: number; path: number; carry: Carry }
  | { kind: "task_clear"; m: number; t: number }
  | { kind: "move"; who: Who; t: number; p: number }
  | { kind: "task_delete"; who: Who; t: number; restore: boolean }
  | { kind: "regroup"; who: Who; p: number; a: number }
  | { kind: "delete"; who: Who; p: number }
  | { kind: "restore"; who: Who; p: number }
  /** An agent sets a project's folder to one a project had and lost: a delete's, a clear's. */
  | { kind: "steal"; m: number; p: number; pick: number }
  | { kind: "undo"; partial: boolean }
  | { kind: "redo" };

const m = fc.nat({ max: 1 });
const p = fc.nat({ max: PROJECTS - 1 });
const t = fc.nat({ max: TASKS - 1 });
const path = fc.nat({ max: 5 });
/** None, every owner, or some. */
const carry: fc.Arbitrary<Carry> = fc.oneof(
  fc.constant([]),
  fc.constant([...Array(PROJECTS + TASKS).keys()]),
  fc.uniqueArray(fc.nat({ max: PROJECTS + TASKS - 1 })),
);
/** Mostly the person, whose changes are on the undo stack; sometimes an agent in between. */
const who = fc.constantFrom<Who>("human", "human", "agent");
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("project_set" as const),
      who: fc.constantFrom("human" as const, "agent" as const),
      m,
      p,
      path,
      carry,
    }),
    weight: 6,
  },
  { arbitrary: fc.record({ kind: fc.constant("project_clear" as const), m, p }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("task_set" as const),
      m,
      t,
      path,
      carry,
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("task_clear" as const), m, t }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      who,
      t,
      p: fc.nat({ max: PROJECTS }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("task_delete" as const),
      who,
      t,
      restore: fc.boolean(),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("regroup" as const),
      who,
      p,
      a: fc.nat({ max: AREAS }),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), who, p }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("restore" as const), who, p }), weight: 3 },
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

/**
 * Fewer kinds, and an agent as often as the person: a project's moves, deletes and restores with an
 * agent filing tasks and setting folders in between, then the person's undo and redo.
 */
const either = fc.constantFrom<Who>("human", "agent");
const groupStep: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("regroup" as const),
      who: either,
      p,
      a: fc.nat({ max: AREAS }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      who: either,
      t,
      p: fc.nat({ max: PROJECTS }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("task_delete" as const),
      who: either,
      t,
      restore: fc.boolean(),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), who: either, p }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("restore" as const), who: either, p }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constant("project_set" as const),
      who: either,
      m,
      p,
      path,
      carry,
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("project_clear" as const), m, p }), weight: 1 },
  {
    arbitrary: fc.record({ kind: fc.constant("undo" as const), partial: fc.boolean() }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("redo" as const) }), weight: 2 },
);

/**
 * Counterexamples the random runs found, run every time: an undo held back by an agent's change, a
 * redo of it that wrote nothing again, and an undo after that.
 */
const GROUP_CASES: readonly (readonly Step[])[] = [
  // seed 565489635, path "52:3:2:3:8:8:8:8:10:6:9:11:14:14:14:11:11:11:11:11:11:11:11:11:11:11:11:11"
  [
    { kind: "move", who: "human", t: 0, p: 1 },
    { kind: "regroup", who: "agent", p: 0, a: 1 },
    { kind: "undo", partial: true },
    { kind: "redo" },
    { kind: "undo", partial: false },
    { kind: "move", who: "human", t: 0, p: 0 },
    { kind: "regroup", who: "human", p: 0, a: 0 },
    { kind: "move", who: "human", t: 0, p: 0 },
    { kind: "undo", partial: false },
  ],
  // seed -1539344306, path "0:6:7:12:12:7:8:8:7:7"
  [
    { kind: "regroup", who: "human", p: 3, a: 0 },
    { kind: "move", who: "agent", t: 0, p: 3 },
    { kind: "undo", partial: false },
    { kind: "regroup", who: "human", p: 0, a: 0 },
    { kind: "undo", partial: true },
    { kind: "redo" },
    { kind: "undo", partial: false },
  ],
];

interface FolderState {
  id: string;
  kind: string;
  owner: string;
  machine: string;
  path: string;
  live: boolean;
}

/**
 * What an undo must give back: the live folders, the live projects with their areas, and each
 * task's project, area and tombstone.
 */
interface Snapshot {
  folders: Record<string, string>;
  projects: string[];
  areas: Record<string, string | null>;
  tasks: Record<string, string | null>;
  taskAreas: Record<string, string | null>;
  deletedTasks: string[];
}

interface World {
  fx: Fixture;
  machines: { id: Id<"m">; os: FolderOs; human: Credential; agent: Credential }[];
  areas: Id<"a">[];
  projects: Id<"p">[];
  tasks: Id<"t">[];
}

async function world(): Promise<World> {
  const fx = await fixture();
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
  const areas = Array.from({ length: AREAS }, () => newId("a"));
  const projects = Array.from({ length: PROJECTS }, () => newId("p"));
  const tasks = Array.from({ length: TASKS }, () => newId("t"));
  const ops: Operation[] = [
    ...areas.map((id, k): Operation => ({ kind: "area.create", id, title: `A${String(k)}` })),
    ...projects.map((id, k): Operation => ({
      kind: "project.create",
      id,
      title: `P${String(k)}`,
      area: areas[k % AREAS] ?? null,
    })),
    ...tasks.map((id, k): Operation => ({
      kind: "task.create",
      id,
      title: `T${String(k)}`,
      project: projects[k % 2] ?? "",
    })),
  ];
  const created = fx.writer.submit(fx.request(fx.codex, ops));
  if (created.status !== "applied") throw new Error("the world was not created");
  return { fx, machines, areas, projects, tasks };
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
  const projects = w.fx.reader
    .prepare("SELECT id, area_id, deleted_at FROM projects ORDER BY id")
    .all();
  const tasks = w.fx.reader
    .prepare("SELECT id, project_id, area_id, deleted_at FROM tasks ORDER BY id")
    .all();
  const nullable = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    folders: Object.fromEntries(
      folders(w)
        .filter((f) => f.live)
        .map((f) => [f.id, f.path]),
    ),
    projects: projects.filter((r) => r["deleted_at"] === null).map((r) => String(r["id"])),
    areas: Object.fromEntries(projects.map((r) => [String(r["id"]), nullable(r["area_id"])])),
    tasks: Object.fromEntries(tasks.map((r) => [String(r["id"]), nullable(r["project_id"])])),
    taskAreas: Object.fromEntries(tasks.map((r) => [String(r["id"]), nullable(r["area_id"])])),
    deletedTasks: tasks.filter((r) => r["deleted_at"] !== null).map((r) => String(r["id"])),
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
  const now = snapshot(w);
  const liveProjects = new Set(now.projects);
  for (const machine of w.machines) {
    const keys = all
      .filter((f) => f.kind === "project" && f.machine === machine.id && liveProjects.has(f.owner))
      .map((f) => folderKey(f.path, machine.os));
    expect(new Set(keys).size, `two live projects on one folder of ${machine.os}`).toBe(
      keys.length,
    );
  }
  // A deleted project holds no live folder and no live task, and a task is in its project's area.
  for (const f of all) {
    if (f.kind === "project") {
      expect(liveProjects.has(f.owner), "a deleted project has no live folder").toBe(true);
    }
  }
  for (const [task, project] of Object.entries(now.tasks)) {
    if (project === null) continue;
    if (!now.deletedTasks.includes(task)) {
      expect(liveProjects.has(project), "a deleted project holds no live task").toBe(true);
    }
    expect(now.taskAreas[task], "a task is in its project's area").toBe(now.areas[project]);
  }
}

/**
 * Where a folder lands when the folder `from` was moved to `to`, worked out here apart from the
 * writer's code: inside the old folder it moves, unless one of the two folders is the other or
 * inside it, when nothing moves.
 */
function expectedMove(path: string, from: string, to: string, os: FolderOs): string {
  const sep = os === "windows" ? "\\" : "/";
  const fold = (s: string): string => (os === "linux" ? s : s.toLowerCase());
  const within = (a: string, b: string): boolean =>
    fold(a) === fold(b) || fold(a).startsWith(fold(b) + sep);
  if (within(to, from) || within(from, to) || !within(path, from)) return path;
  return to + path.slice(from.length);
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
  const carried = (owners: Carry): string[] =>
    owners.map((k) => (k < PROJECTS ? w.projects[k] : w.tasks[k - PROJECTS]) ?? "");
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
      if ("who" in s && s.who === "agent") actor = machine?.agent ?? w.fx.codex;
      switch (s.kind) {
        case "project_set":
          ops = [
            {
              kind: "project.folder_set",
              project: w.projects[s.p] ?? "",
              path: PATHS[machine?.os ?? "linux"][s.path] ?? "",
              ...(s.carry.length === 0 ? {} : { carry: carried(s.carry) }),
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
              ...(s.carry.length === 0 ? {} : { carry: carried(s.carry) }),
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
        case "task_delete":
          ops = [{ kind: s.restore ? "task.restore" : "task.delete", task: w.tasks[s.t] ?? "" }];
          break;
        case "regroup":
          ops = [
            {
              kind: "project.move",
              project: w.projects[s.p] ?? "",
              area: s.a === AREAS ? null : (w.areas[s.a] ?? ""),
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
      // A folder change on a machine moved exactly the folders inside the old one, when it said so.
      if (
        (s.kind === "project_set" || s.kind === "task_set") &&
        result.status === "applied" &&
        machine !== undefined
      ) {
        const kind = s.kind === "project_set" ? "project" : "task";
        const owner = s.kind === "project_set" ? (w.projects[s.p] ?? "") : (w.tasks[s.t] ?? "");
        const mine = (f: FolderState) =>
          f.kind === kind && f.owner === owner && f.machine === machine.id;
        const old = beforeFolders.find((f) => f.live && mine(f));
        const to = PATHS[machine.os][s.path] ?? "";
        const after = new Map(folders(w).map((f) => [f.id, f]));
        for (const f of beforeFolders) {
          if (!f.live) continue;
          let expected = f.path;
          if (mine(f)) expected = to;
          else if (
            carried(s.carry).includes(f.owner) &&
            old !== undefined &&
            f.machine === machine.id
          ) {
            expected = expectedMove(f.path, old.path, to, machine.os);
          }
          expect(after.get(f.id)?.path, "a folder change moves exactly the folders inside").toBe(
            expected,
          );
        }
      }
    }
    checkHistory(w.fx.reader);
  } finally {
    w.fx.close();
  }
}

describe("[A1.5.write.folders-model] random folder operations, deletes, restores, undos and redos on two machines", () => {
  test("one folder per owner and machine, never two live projects on one folder, a moved folder carries exactly every folder inside it, and undo gives back what was", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 40 }), async (steps) => {
        await run(steps);
      }),
      { numRuns: 100 },
    );
  }, 300_000);

  test("a deleted project never holds a live task or folder, and a task stays in its project's area, with an agent working in between", async () => {
    for (const steps of GROUP_CASES) await run(steps);
    await fc.assert(
      fc.asyncProperty(fc.array(groupStep, { minLength: 5, maxLength: 30 }), async (steps) => {
        await run(steps);
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
