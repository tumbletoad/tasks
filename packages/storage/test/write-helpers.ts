// Shared set-up for the write-path tests: a fixture space with a writer, three actors, two areas
// and a project, and a history checker that every test runs on the result. Fixture text only.
import { expect } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { rebuildSearchIndex } from "../src/search/documents.ts";
import { SEARCH_TABLE_STATEMENTS } from "../src/search/tables.ts";
import { openSpace } from "../src/space.ts";
import { TASK_FIELDS, type TaskField } from "../src/write/fields.ts";
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
 */
export async function writeFixture(
  parent: string,
  options: { search?: boolean } = {},
): Promise<Fixture> {
  const created = await createFixtureSpace(parent);
  const checked = await checkedDriver();
  const opened = openSpace(checked, created.folder, { role: "writer" });
  const conn = opened.conn;
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
    reopen: (options = {}) => {
      fixture.writer.close();
      writer = SpaceWriter.open(openSpace(checked, created.folder, { role: "writer" }), {
        machine: MACHINE,
        now: steppingClock(),
        ...options,
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
 * A1's history invariants on every task (A1 3.4, 3.5, 3.7):
 * - commits are gapless from 1 to last_seq, and every change belongs to one;
 * - a commit has at most one change row per (row, field), and none whose value did not change;
 * - per (task, field), each change's before-value and before-version are the previous change's
 *   after-value and seq, or the create row's value and seq: the chain has no hole, so no write
 *   was lost between two recorded changes;
 * - every `fv` entry equals the field's latest change row, and a field without one has no entry;
 * - the row's current value is the latest change's after-value, and its version is the latest
 *   change to any field;
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
    const createdRow = JSON.parse(create.after) as Record<string, unknown>;
    const fv = JSON.parse(task.fv) as Record<string, number>;
    expect(JSON.parse(task.fp)).toEqual(fv);
    let version = create.seq;
    for (const field of Object.keys(TASK_FIELDS) as TaskField[]) {
      const columns: readonly string[] = TASK_FIELDS[field];
      const valueOf = (row: Record<string, unknown>): string =>
        JSON.stringify(
          columns.length === 1
            ? row[columns[0] ?? ""]
            : Object.fromEntries(columns.map((c) => [c, row[c]])),
        );
      let value = valueOf(createdRow);
      let at = create.seq;
      for (const change of history.filter((c) => c.field === field)) {
        expect(change.action).toBe("set");
        expect(change.before, `${field} before-value at ${String(change.seq)}`).toBe(value);
        expect(change.before_ver).toBe(at);
        expect(change.before_prov).toBe(at);
        expect(change.after_prov).toBe(change.seq);
        value = change.after;
        at = change.seq;
      }
      expect(valueOf(task), `${field} holds its latest change`).toBe(value);
      expect(fv[field], `fv.${field} is its latest change row`).toBe(
        at === create.seq ? undefined : at,
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
 * The same invariants on the child rows a request can change after their create: links and
 * places (A1 3.4). Each starts with its create row, every `fv` entry is its field's latest change,
 * and the row's version is the latest change to any of its fields.
 */
function checkChildHistory(conn: Connection): void {
  const kinds = [
    {
      table: "task_sources",
      key: "task_id || '|' || source_id",
      fields: { removed: ["removed_at"] },
    },
    {
      table: "places",
      key: "id",
      fields: { folder: ["root_id", "rel_path", "kind", "identity"], deleted: ["deleted_at"] },
    },
    {
      table: "launches",
      key: "id",
      fields: { state: ["state", "reason", "detail", "updated_at"] },
    },
  ] as const;
  for (const { table, key, fields } of kinds) {
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
      const createdRow = JSON.parse(create.after) as Record<string, unknown>;
      const fv = JSON.parse(row.fv) as Record<string, number>;
      expect(JSON.parse(row.fp)).toEqual(fv);
      let version = create.seq;
      for (const [field, columns] of Object.entries(fields) as [string, readonly string[]][]) {
        const valueOf = (r: Record<string, unknown>): string =>
          JSON.stringify(
            columns.length === 1
              ? r[columns[0] ?? ""]
              : Object.fromEntries(columns.map((c) => [c, r[c]])),
          );
        let value = valueOf(createdRow);
        let at = create.seq;
        for (const change of history.filter((c) => c.field === field)) {
          expect(change.before, `${table}.${field} before-value at ${String(change.seq)}`).toBe(
            value,
          );
          expect(change.before_ver).toBe(at);
          value = change.after;
          at = change.seq;
        }
        expect(valueOf(row), `${table}.${field} holds its latest change`).toBe(value);
        expect(fv[field]).toBe(at === create.seq ? undefined : at);
        version = Math.max(version, at);
      }
      expect(row["version"], `${table} ${row.entity_id} version`).toBe(version);
    }
  }
}
