// Shared set-up for the projection's tests: the Mira sample space with its writer in this thread,
// a reader for the projector, and the checks every test runs on a tree. Fixture text only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
import { Projector, type ProjectorOptions, type StepReport } from "../src/index.ts";
import { JOURNAL_FILE, RECORD_FILE } from "../src/tree.ts";

export interface World {
  readonly folder: string;
  /** The projection's folder: the space's view/. */
  readonly dir: string;
  readonly writer: SpaceWriter;
  readonly reader: Connection;
  readonly human: Credential;
  /** Submits as Mira, with a fresh base; the request must apply. */
  submit(ops: Operation[]): WriteResult;
  /** A projector on the space, its writer this thread's. */
  projector(options?: Partial<ProjectorOptions>): Projector;
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
  return {
    folder: seeded.folder,
    dir,
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
    projector(options = {}) {
      return new Projector({
        conn: reader,
        spaceFolder: seeded.folder,
        dir,
        writer: {
          projected: (batch) => Promise.resolve(writer.projected(batch)),
          queueProjection: () => Promise.resolve(writer.queueProjection()),
        },
        timeZone: "UTC",
        ...options,
      });
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

/** Every file under `dir`, relative with `/`, mapped to its text. */
export function filesOf(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(dir, path).split(sep).join("/"), readFileSync(path, "utf8"));
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
  const timed = ["catalog.jsonl", ".projection.json"];
  for (const name of timed) {
    const text = files.get(name);
    if (text !== undefined) {
      files.set(name, text.replace(/"generated_at": ?"[^"]*"/g, '"generated_at":"-"'));
    }
  }
  // The record holds those two files' hashes, which the instants change.
  const record = files.get(RECORD_FILE);
  if (record !== undefined) {
    const value = JSON.parse(record) as { files: Record<string, string> };
    for (const name of timed) {
      if (name in value.files) value.files[name] = "-";
    }
    files.set(RECORD_FILE, JSON.stringify(value));
  }
  return files;
}

/**
 * Two trees are the same: the same paths with the same text. A difference names the paths, and
 * for the record its fields, never a wall of JSON.
 */
export function expectSameTree(actual: Map<string, string>, expected: Map<string, string>): void {
  const paths = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  const differ = paths.filter((path) => actual.get(path) !== expected.get(path));
  const detail = differ.map((path) => {
    if (path !== ".projection-files.json" || !actual.has(path) || !expected.has(path)) return path;
    const a = JSON.parse(actual.get(path) ?? "{}") as Record<string, unknown>;
    const b = JSON.parse(expected.get(path) ?? "{}") as Record<string, unknown>;
    const fields = Object.keys({ ...a, ...b }).filter(
      (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
    );
    const tasks = (r: Record<string, unknown>) => (r["tasks"] ?? {}) as Record<string, unknown>;
    const ids = Object.keys({ ...tasks(a), ...tasks(b) }).filter(
      (id) => JSON.stringify(tasks(a)[id]) !== JSON.stringify(tasks(b)[id]),
    );
    return `${path} fields ${fields.join(",")} tasks ${ids.slice(0, 5).join(",")} ${JSON.stringify(
      Object.fromEntries(fields.filter((f) => f !== "tasks").map((f) => [f, [a[f], b[f]]])),
    )}`;
  });
  expect(detail).toEqual([]);
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

/**
 * A1 3.13's guarantee, checked against the database, which the tree did not write: when the folder
 * claims a watermark W, every commit up to W is reflected in every task's file (its `seq` is at
 * least the task's last change up to W), every live task created up to W has a catalogue line, and
 * every path the catalogue names exists. A folder without `.projection.json` claims nothing.
 */
export function checkWatermark(dir: string, reader: Connection): number | undefined {
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
    expect(
      existsSync(join(dir, ...(entry.path ?? "").split("/"))),
      `${entry.path ?? ""} exists`,
    ).toBe(true);
  }
  const tasks = reader
    .prepare(
      "SELECT t.id, (SELECT max(seq) FROM changes c WHERE c.task_id = t.id AND c.seq <= $w) AS last " +
        "FROM tasks t WHERE t.created_seq <= $w AND t.deleted_at IS NULL",
    )
    .all<{ id: string; last: number }>({ w });
  for (const task of tasks) {
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

/** No temporary file and no journal in the tree. */
export function expectClean(dir: string): void {
  for (const path of filesOf(dir).keys()) {
    expect(path, "no temporary file").not.toMatch(/\.tmp/);
    expect(path).not.toBe(JOURNAL_FILE);
  }
}
