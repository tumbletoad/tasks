// Shared set-up for the projection's tests: the Mira sample space with its writer in this thread,
// a reader for the projector, a machine-state folder of its own for the trusted record and journal,
// and the checks every test runs on a tree. Fixture text only.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect } from "vitest";
import {
  formatAsOf,
  openSpace,
  SpaceWriter,
  type Connection,
  type Credential,
  type Id,
  type MachineInfo,
  type Operation,
  type WriteResult,
} from "@tasks/storage";
import { checkedDriver, MIRA, seedMira } from "@tasks/testkit";
import {
  Projector,
  type Act,
  type Hook,
  type ProjectorOptions,
  type StepReport,
} from "../src/index.ts";

export interface World {
  readonly folder: string;
  /** The tree: the space's view/. */
  readonly dir: string;
  /** The machine-state folder that holds the trusted record and journal. */
  readonly state: string;
  readonly record: string;
  readonly journal: string;
  readonly writer: SpaceWriter;
  readonly reader: Connection;
  readonly human: Credential;
  /** Submits as Mira, with a fresh base; the request must apply. */
  submit(ops: Operation[]): WriteResult;
  /** A projector on the space, its writer this thread's. */
  projector(options?: Partial<ProjectorOptions>): Projector;
  /** A fresh render of the space as it is now, into `dir` with a state of its own. */
  fresh(dir: string): Promise<Map<string, string>>;
  close(): void;
}

/** The Mira sample with `tasks` tasks in `root`, opened for writing here. */
export async function world(root: string, tasks = 24): Promise<World> {
  const seeded = await seedMira(root, { tasks });
  const checked = await checkedDriver();
  const machine: MachineInfo = { id: seeded.machine, name: MIRA.machine.name, os: "linux" };
  const writer = SpaceWriter.open(openSpace(checked, seeded.folder, { role: "writer" }), {
    machine,
  });
  const reader = openSpace(checked, seeded.folder, { role: "reader" }).conn;
  const human: Credential = {
    scope_id: "cli:projection-test",
    principal_id: writer.actor("human", ""),
    actor_kind: "human",
    machine_id: machine.id,
    origin: "cli",
  };
  const spaceId = writer.spaceId;
  let n = 0;
  const dir = join(seeded.folder, "view");
  const state = join(root, "state", "spaces");
  const record = join(state, `${spaceId}.projection.json`);
  const journal = join(state, `${spaceId}.projection-journal.json`);
  const make = (options: Partial<ProjectorOptions> = {}): Projector =>
    new Projector({
      conn: reader,
      spaceFolder: seeded.folder,
      dir,
      record,
      journal,
      writer: {
        projected: (batch) => Promise.resolve(writer.projected(batch)),
        queueProjection: (keys) => Promise.resolve(writer.queueProjection(keys)),
      },
      timeZone: "UTC",
      ...options,
    });
  let fresh = 0;
  return {
    folder: seeded.folder,
    dir,
    state,
    record,
    journal,
    writer,
    reader,
    human,
    submit(ops) {
      n += 1;
      const result = writer.submit({
        space_id: spaceId,
        request_id: `projection-test-${String(n).padStart(6, "0")}`,
        actor: human,
        ops,
        base: formatAsOf(writer.asOf()),
      });
      expect(result.status, JSON.stringify(result.error ?? result.conflicts)).toBe("applied");
      return result;
    },
    projector: make,
    async fresh(at) {
      fresh += 1;
      const own = join(root, "state", `fresh-${String(fresh)}`);
      mkdirSync(own, { recursive: true });
      // No record of its own: its start queues every task, and it renders them all. The tasks it
      // marks rendered were rendered by the projector under test already, which has settled.
      const projector = make({
        dir: at,
        record: join(own, "record.json"),
        journal: join(own, "journal.json"),
      });
      await projector.start();
      await settle(projector);
      return treeOf(at);
    },
    close() {
      reader.close();
      writer.close();
    },
  };
}

/** The task IDs of the space, by reference. */
export function taskIds(reader: Connection): Id<"t">[] {
  return reader
    .prepare("SELECT id FROM tasks ORDER BY ref")
    .all<{ id: Id<"t"> }>()
    .map((row) => row.id);
}

/** Runs batches until nothing waits. Returns their reports. */
export async function settle(projector: Projector, limit = 1_000): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  while (projector.pending().dirty) {
    reports.push(await projector.step());
    if (reports.length > limit) throw new Error("the projection does not settle");
  }
  return reports;
}

/** Every file under `dir`, relative with `/`, mapped to its text. Links are not followed. */
export function filesOf(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) {
        files.set(relative(dir, path).split(sep).join("/"), readFileSync(path, "utf8"));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/**
 * The tree as a fresh render would give it: every file, with the instants of the catalogue's
 * header and `.projection.json` left out (generated_at), so two renders of one state compare.
 */
export function treeOf(dir: string): Map<string, string> {
  const files = filesOf(dir);
  for (const name of ["catalog.jsonl", ".projection.json"]) {
    const text = files.get(name);
    if (text !== undefined) {
      files.set(name, text.replace(/"generated_at": ?"[^"]*"/g, '"generated_at":"-"'));
    }
  }
  return files;
}

/** Two trees are the same: the same paths with the same text. A difference names the paths. */
export function expectSameTree(actual: Map<string, string>, expected: Map<string, string>): void {
  const paths = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  expect(paths.filter((path) => actual.get(path) !== expected.get(path))).toEqual([]);
}

/** A file's front matter, as key to raw value. */
export function frontMatter(text: string): Record<string, string> {
  const end = text.indexOf("\n---\n", 4);
  const block = text.slice(4, end);
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }),
  );
}

interface CatalogLine {
  readonly id?: string;
  readonly path?: string;
  readonly seq?: number;
  readonly kind?: string;
}

/** The catalogue's task lines. */
export const catalogOf = (dir: string): { id: string; path: string }[] =>
  readFileSync(join(dir, "catalog.jsonl"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as { id: string; path: string });

/**
 * A1 3.13's guarantee, checked against the database, which the tree did not write: when the folder
 * claims a watermark W, every commit up to W is reflected in every task's file (its `seq` is at
 * least the task's last change up to W), every task live at W and still live has a catalogue line
 * (one deleted or restored after W is not judged by W), and every path the catalogue names exists,
 * reached through real folders. A folder without `.projection.json` claims nothing. `skip` names
 * task IDs not checked (a person changed them).
 */
export function checkWatermark(
  dir: string,
  reader: Connection,
  skip: ReadonlySet<string> = new Set(),
): number | undefined {
  const claimPath = join(dir, ".projection.json");
  if (!existsSync(claimPath)) return undefined;
  const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { seq: number };
  const w = claim.seq;
  const lines = readFileSync(join(dir, "catalog.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CatalogLine);
  const [header, ...entries] = lines;
  expect(header?.kind).toBe("header");
  // The catalogue may be newer than the claim (written first), never older.
  expect(header?.seq ?? -1).toBeGreaterThanOrEqual(w);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (skip.has(entry.id ?? "")) continue;
    expect(inTree(dir, entry.path ?? ""), `${entry.path ?? ""} exists`).toBe(true);
  }
  const tasks = reader
    .prepare(
      "SELECT t.id, (SELECT max(seq) FROM changes c WHERE c.task_id = t.id AND c.seq <= $w) AS last " +
        "FROM tasks t WHERE t.created_seq <= $w AND t.deleted_at IS NULL AND NOT EXISTS " +
        "(SELECT 1 FROM changes d WHERE d.task_id = t.id AND d.field = 'deleted' AND d.seq > $w)",
    )
    .all<{ id: string; last: number }>({ w });
  for (const task of tasks) {
    if (skip.has(task.id)) continue;
    const entry = byId.get(task.id);
    expect(entry, `${task.id} is in the catalogue`).toBeDefined();
    const text = readFileSync(join(dir, ...(entry?.path ?? "").split("/")), "utf8");
    expect(
      Number(frontMatter(text)["seq"]),
      `${task.id} reflects commit ${String(task.last)}`,
    ).toBeGreaterThanOrEqual(task.last);
  }
  return w;
}

/** Whether `path` is a regular file of the tree, reached through real folders only. */
export function inTree(dir: string, path: string): boolean {
  const parts = path.split("/");
  for (let i = 0; i <= parts.length - 1; i += 1) {
    const at = join(dir, ...parts.slice(0, i));
    if (lstatSync(at, { throwIfNoEntry: false })?.isDirectory() !== true) return false;
  }
  return lstatSync(join(dir, ...parts), { throwIfNoEntry: false })?.isFile() === true;
}

/** No temporary file in the tree. */
export function expectClean(dir: string): void {
  for (const path of filesOf(dir).keys()) expect(path, "no temporary file").not.toMatch(/\.tmp$/);
}

/** The end of a process: thrown at the kill and at every act after it. */
export class Killed extends Error {
  override readonly name = "Killed";
}

/** A hook that kills the run at its `at`-th act: that act and every later one never happen. */
export function killAt(at: number): {
  hook: Hook;
  dead: () => boolean;
  act: () => Act | undefined;
  /** The kill now, between acts: as the writer has just answered, say. */
  kill: () => void;
} {
  let count = 0;
  let dead = false;
  let act: Act | undefined;
  return {
    hook: (what) => {
      if (dead) throw new Killed();
      count += 1;
      if (count === at) {
        dead = true;
        act = what;
        throw new Killed();
      }
    },
    dead: () => dead,
    act: () => act,
    kill: () => {
      dead = true;
    },
  };
}
