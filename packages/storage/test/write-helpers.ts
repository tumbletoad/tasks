// Shared set-up for the write-path tests: a fixture space with a writer, three actors, two areas
// and a project, and a history checker that every test runs on the result. Fixture text only.
import { expect } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { rebuildSearchIndex } from "../src/search/documents.ts";
import { SEARCH_TABLE_STATEMENTS } from "../src/search/tables.ts";
import { openSpace } from "../src/space.ts";
import { CHILD_FIELDS, TASK_FIELDS, type TaskField } from "../src/write/fields.ts";
import { isPosition } from "../src/write/positions.ts";
import {
  formatAsOf,
  type Credential,
  type Operation,
  type WriteRequest,
  type WriteResult,
} from "../src/write/request.ts";
import { SpaceWriter, type MachineInfo, type WriterOptions } from "../src/write/writer.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE } from "./space-helpers.ts";

export const MACHINE: MachineInfo = { id: TEST_MACHINE, name: "mira-desktop", os: "linux" };

export interface Fixture {
  folder: string;
  spaceId: Id<"sp">;
  writer: SpaceWriter;
  /** Closes the writer and opens a new one on the same space. */
  reopen: (options?: Partial<WriterOptions>) => SpaceWriter;
  /** A reader connection on the same space, for checks. */
  reader: Connection;
  human: Credential;
  codex: Credential;
  claude: Credential;
  areas: { lumen: Id<"a">; home: Id<"a"> };
  project: Id<"p">;
  /** Aliases written with the fixture: a legacy task ID, an old prefix and an old project slug. */
  legacy: { alias: string; task: Id<"t">; prefix: string; slug: string };
  /** A request with a fresh request ID. */
  request: (actor: Credential, ops: Operation[], extra?: Partial<WriteRequest>) => WriteRequest;
  /** The current as_of, wire form. */
  base: () => string;
  close: () => void;
}

/** A legacy task ID from the prototype (A7 3.15), and the task ID it names. */
export const LEGACY = { alias: "t-c71c0065", task: "t_0c71c0065aaaaaaaaaaaaaaaaa" as Id<"t"> };

/** A clock that moves one second per call, from 2026-11-12 08:00 UTC. */
export function steppingClock(): () => number {
  let now = Date.UTC(2026, 10, 12, 8, 0, 0);
  return () => (now += 1000);
}

/**
 * Creates the fixture space in `parent`, with the writer open on it. The areas and the project are
 * fixture rows written before the writer opens: their operations arrive in later steps. With
 * `search`, the space also gets the search tables, filled by a rebuild, as the schema step that
 * adds them will do (A1 3.12), so the writer keeps the index.
 *
 * `flush: false`: the writer's connection commits without a flush (`synchronous=OFF`), for a test
 * whose subject is which writes apply, not what survives a power cut, and that commits thousands
 * of times: a flush costs about 4 ms on GitHub's Windows runner and far more while other tests
 * flush beside it. What survives a crash is the crash harness's subject (A7 3.18.1), at FULL.
 */
export async function writeFixture(
  parent: string,
  options: { search?: boolean; flush?: boolean } = {},
): Promise<Fixture> {
  const created = await createFixtureSpace(parent);
  const checked = await checkedDriver();
  const opened = openSpace(checked, created.folder, { role: "writer" });
  const conn = opened.conn;
  if (options.flush === false) conn.pragma("synchronous", "OFF");
  const ids = {
    codex: newId("ac"),
    claude: newId("ac"),
    lumen: newId("a"),
    home: newId("a"),
    project: newId("p"),
  };
  conn.transaction("immediate", () => {
    const actor = conn.prepare(
      "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
        "VALUES ($id, 'agent', $label, NULL, NULL, 0)",
    );
    actor.run({ id: ids.codex, label: "Codex · work" });
    actor.run({ id: ids.claude, label: "Claude Code · work" });
    const area = conn.prepare(
      "INSERT INTO areas (id, slug, title, position, created_at, created_by, created_seq, version) " +
        "VALUES ($id, $slug, $title, $position, 0, $by, 0, 0)",
    );
    area.run({
      id: ids.lumen,
      slug: "lumen",
      title: "Lumen",
      position: "a0",
      by: created.actors.human,
    });
    area.run({
      id: ids.home,
      slug: "home",
      title: "Home",
      position: "a1",
      by: created.actors.human,
    });
    conn
      .prepare(
        "INSERT INTO projects (id, area_id, slug, title, position, created_at, created_by, " +
          "created_seq, version) VALUES ($id, $area, 'portal', 'Portal', 'a0', 0, $by, 0, 0)",
      )
      .run({ id: ids.project, area: ids.lumen, by: created.actors.human });
    const alias = conn.prepare(
      "INSERT INTO aliases (namespace, alias, entity_kind, entity_id, created_at) " +
        "VALUES ($namespace, $alias, $kind, $id, 0)",
    );
    alias.run({ namespace: "planning", alias: LEGACY.alias, kind: "task", id: LEGACY.task });
    alias.run({ namespace: "ref_prefix", alias: "MI", kind: "space", id: created.space.spaceId });
    alias.run({ namespace: "slug", alias: "old-portal", kind: "project", id: ids.project });
    if (options.search === true) {
      for (const statement of SEARCH_TABLE_STATEMENTS) conn.exec(statement);
      rebuildSearchIndex(conn);
    }
  });
  let writer = SpaceWriter.open(opened, { machine: MACHINE, now: steppingClock() });
  const reader = openSpace(checked, created.folder, { role: "reader" }).conn;
  const credential = (id: Id<"ac">, kind: "human" | "agent", scope: string): Credential => ({
    scope_id: scope,
    principal_id: id,
    actor_kind: kind,
    machine_id: TEST_MACHINE,
    origin: kind === "human" ? "cli" : "mcp",
  });
  let counter = 0;
  const fixture: Fixture = {
    folder: created.folder,
    spaceId: created.space.spaceId,
    writer,
    reopen: (writerOptions = {}) => {
      fixture.writer.close();
      const again = openSpace(checked, created.folder, { role: "writer" });
      if (options.flush === false) again.conn.pragma("synchronous", "OFF");
      writer = SpaceWriter.open(again, {
        machine: MACHINE,
        now: steppingClock(),
        ...writerOptions,
      });
      fixture.writer = writer;
      return writer;
    },
    reader,
    human: credential(created.actors.human, "human", "cli:fixture"),
    codex: credential(ids.codex, "agent", "grant:codex"),
    claude: credential(ids.claude, "agent", "grant:claude"),
    areas: { lumen: ids.lumen, home: ids.home },
    project: ids.project,
    legacy: { ...LEGACY, prefix: "MI", slug: "old-portal" },
    request: (actor, ops, extra = {}) => {
      counter += 1;
      return {
        space_id: created.space.spaceId,
        request_id: `fixture-request-${String(counter).padStart(6, "0")}`,
        actor,
        ops,
        ...extra,
      };
    },
    base: () => formatAsOf(fixture.writer.asOf()),
    close: () => {
      reader.close();
      fixture.writer.close();
    },
  };
  return fixture;
}

/** Asserts a result's status, with its error in the message when it differs. */
export function expectStatus(result: WriteResult, status: WriteResult["status"]): void {
  expect(result.status, JSON.stringify(result.error ?? result.conflicts)).toBe(status);
}

const one = (conn: Connection, sql: string, params = {}): unknown =>
  Object.values(conn.prepare(sql).get(params) ?? {})[0];

interface ChangeRow {
  seq: number;
  op: number;
  entity: string;
  entity_id: string;
  action: string;
  field: string | null;
  before: string | null;
  after: string;
  before_ver: number | null;
  before_prov: number | null;
  after_prov: number;
}

/**
 * Checks one field's chain of change rows against the row (A1 3.4, 3.5, 3.10): each change's
 * before-value, before-version and before-provenance are the previous change's after-value, seq and
 * after-provenance, or the create row's; an ordinary write holds its own provenance and an undo or
 * redo sets back an earlier one; the row holds the latest after-value; `fv` names the latest change
 * and `fp` its provenance (a missing key means created_seq); and the field holds exactly the value
 * its provenance commit wrote for it. Returns the field's latest seq.
 */
function checkChain(
  label: string,
  history: readonly ChangeRow[],
  created: { seq: number; row: Record<string, unknown> },
  row: Record<string, unknown>,
  columns: readonly string[],
  maps: { fv: Record<string, number>; fp: Record<string, number> },
  field: string,
  kinds: ReadonlyMap<number, string>,
): number {
  const valueOf = (r: Record<string, unknown>): string =>
    JSON.stringify(
      columns.length === 1
        ? (r[columns[0] ?? ""] ?? null)
        : Object.fromEntries(columns.map((c) => [c, r[c] ?? null])),
    );
  let value = valueOf(created.row);
  let at = created.seq;
  let prov = created.seq;
  const chain = history.filter((c) => c.field === field);
  for (const change of chain) {
    expect(change.action).toBe("set");
    expect(change.before, `${label}.${field} before-value at ${String(change.seq)}`).toBe(value);
    expect(change.before_ver, `${label}.${field} before-version`).toBe(at);
    expect(change.before_prov, `${label}.${field} before-provenance`).toBe(prov);
    if (kinds.get(change.seq) === "ops") {
      expect(change.after_prov, `${label}.${field} an ordinary write's provenance`).toBe(
        change.seq,
      );
    } else {
      expect(change.after_prov, `${label}.${field} an inversion's provenance`).toBeLessThanOrEqual(
        change.seq,
      );
    }
    value = change.after;
    at = change.seq;
    prov = change.after_prov;
  }
  expect(valueOf(row), `${label}.${field} holds its latest change`).toBe(value);
  expect(maps.fv[field], `fv of ${label}.${field} is its latest change row`).toBe(
    at === created.seq ? undefined : at,
  );
  expect(maps.fp[field] ?? created.seq, `fp of ${label}.${field} is its provenance`).toBe(prov);
  // A1 3.10's invariant: the value is the after-value its provenance commit wrote.
  const wrote =
    prov === created.seq
      ? valueOf(created.row)
      : chain.find((c) => c.seq === prov && c.after_prov === prov)?.after;
  expect(wrote, `${label}.${field} holds its provenance commit's write`).toBe(value);
  return at;
}

/** Each commit's kind by seq: `ops`, `undo`, `redo`, `migration`. */
function commitKinds(conn: Connection): Map<number, string> {
  return new Map(
    conn
      .prepare("SELECT seq, kind FROM commits")
      .all<{ seq: number; kind: string }>()
      .map((c) => [c.seq, c.kind]),
  );
}

/**
 * A1's history invariants on every task (A1 3.4, 3.5, 3.7, 3.10):
 * - commits are gapless from 1 to last_seq, and every change belongs to one;
 * - a commit has at most one change row per (row, field), and none whose value did not change;
 * - per (task, field), the chain of change rows has no hole (checkChain), so no write was lost
 *   between two recorded changes, and the field holds its provenance commit's write;
 * - the row's version is the latest change to any field;
 * - every changed task waits in the outbox for the projection.
 */
export function checkHistory(conn: Connection): void {
  const lastSeq = one(conn, "SELECT last_seq FROM space");
  expect(one(conn, "SELECT count(*) FROM commits")).toBe(lastSeq);
  expect(one(conn, "SELECT coalesce(max(seq), 0) FROM commits")).toBe(lastSeq);
  expect(one(conn, "SELECT count(*) FROM changes WHERE seq NOT IN (SELECT seq FROM commits)")).toBe(
    0,
  );
  expect(
    one(
      conn,
      "SELECT count(*) FROM (SELECT seq, entity_id, field FROM changes " +
        "GROUP BY seq, entity_id, coalesce(field, '') HAVING count(*) > 1)",
    ),
  ).toBe(0);
  expect(one(conn, "SELECT count(*) FROM changes WHERE action = 'set' AND before = after")).toBe(0);
  const kinds = commitKinds(conn);
  const tasks = conn
    .prepare("SELECT * FROM tasks")
    .all<Record<string, unknown> & { id: string; fv: string; fp: string }>();
  for (const task of tasks) {
    const history = conn
      .prepare("SELECT * FROM changes WHERE entity = 'tasks' AND entity_id = $id ORDER BY seq, n")
      .all<ChangeRow>({ id: task.id });
    const create = history[0];
    expect(create?.action, `${task.id} starts with its create`).toBe("create");
    if (create === undefined) continue;
    expect(task["created_seq"]).toBe(create.seq);
    expect(isPosition(task["position"])).toBe(true);
    const created = { seq: create.seq, row: JSON.parse(create.after) as Record<string, unknown> };
    const maps = {
      fv: JSON.parse(task.fv) as Record<string, number>,
      fp: JSON.parse(task.fp) as Record<string, number>,
    };
    let version = create.seq;
    for (const field of Object.keys(TASK_FIELDS) as TaskField[]) {
      const at = checkChain(
        task.id,
        history,
        created,
        task,
        TASK_FIELDS[field],
        maps,
        field,
        kinds,
      );
      version = Math.max(version, at);
    }
    expect(task["version"]).toBe(version);
    // A task is touched by its own changes and by those of its child rows (A1 3.5).
    const touched = Math.max(
      version,
      Number(one(conn, "SELECT max(seq) FROM changes WHERE task_id = $id", { id: task.id })),
    );
    expect(task["touched"]).toBe(touched);
    expect(
      one(conn, "SELECT seq FROM outbox WHERE topic = 'projection' AND key = $id", { id: task.id }),
    ).toBe(touched);
  }
  checkChildHistory(conn);
}

/**
 * The same invariants on the child rows a request can change after their create: links, places,
 * launches, runs, learnings, and the tombstones of notes, log entries and sources (A1 3.4, 3.10),
 * and on sessions, which no operation changes yet. Each starts with its create row, every field's
 * chain holds (checkChain), and the row's version is the latest change to any of its fields. A
 * table a space's schema does not have yet (runs and sessions before 0.3) holds no rows.
 */
function checkChildHistory(conn: Connection): void {
  const commits = commitKinds(conn);
  const id = { key: "id" };
  const exists = (table: string): boolean =>
    conn
      .prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = $table")
      .get({ table }) !== undefined;
  const kinds = [
    {
      table: "task_sources",
      key: "task_id || '|' || source_id",
      fields: CHILD_FIELDS.task_sources,
    },
    { table: "places", ...id, fields: CHILD_FIELDS.places },
    { table: "launches", ...id, fields: CHILD_FIELDS.launches },
    { table: "runs", ...id, fields: CHILD_FIELDS.runs },
    { table: "sessions", ...id, fields: {} },
    { table: "learnings", ...id, fields: CHILD_FIELDS.learnings },
    { table: "notes", ...id, fields: CHILD_FIELDS.notes },
    { table: "log_entries", ...id, fields: CHILD_FIELDS.log_entries },
    { table: "sources", ...id, fields: CHILD_FIELDS.sources },
  ] as const;
  for (const { table, key, fields } of kinds) {
    if (!exists(table)) continue;
    const rows = conn
      .prepare(`SELECT ${key} AS entity_id, * FROM ${table}`)
      .all<Record<string, unknown> & { entity_id: string; fv: string; fp: string }>();
    for (const row of rows) {
      const history = conn
        .prepare("SELECT * FROM changes WHERE entity = $table AND entity_id = $id ORDER BY seq, n")
        .all<ChangeRow>({ table, id: row.entity_id });
      const create = history[0];
      expect(create?.action, `${table} ${row.entity_id} starts with its create`).toBe("create");
      if (create === undefined) continue;
      const created = { seq: create.seq, row: JSON.parse(create.after) as Record<string, unknown> };
      const maps = {
        fv: JSON.parse(row.fv) as Record<string, number>,
        fp: JSON.parse(row.fp) as Record<string, number>,
      };
      let version = create.seq;
      for (const [field, columns] of Object.entries(fields) as [string, readonly string[]][]) {
        const at = checkChain(
          `${table} ${row.entity_id}`,
          history,
          created,
          row,
          columns,
          maps,
          field,
          commits,
        );
        version = Math.max(version, at);
      }
      expect(row["version"], `${table} ${row.entity_id} version`).toBe(version);
    }
  }
}
