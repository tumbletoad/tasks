// A disposable tree space for the tree writer's tests and the crash harness, and the check that
// every row is exactly its history played back. Fixture text only.
import { join } from "node:path";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { openSpaceConnection } from "../src/open.ts";
import type { CheckedDriver } from "../src/startup-check.ts";
import { TreeWriter, type TreeActor, type TreeResult } from "../src/tree/core.ts";
import { columnsOf, FIELDS, isEntity } from "../src/tree/fields.ts";
import { createTreeSpace } from "../src/tree/schema.ts";
import { TEST_MACHINE } from "./space-helpers.ts";

export const TREE_FILE = "tree.db";

export interface TreeFixture {
  conn: Connection;
  writer: TreeWriter;
  spaceId: Id<"sp">;
  human: TreeActor;
  agent: TreeActor;
  /** Sends one command as `who` (the person by default) with a fresh request ID. */
  send(command: string, input: Record<string, unknown>, more?: Partial<Send>): TreeResult;
  close(): void;
}

interface Send {
  who: TreeActor;
  base: string;
  request_id: string;
  entry: string;
}

const actor = (id: Id<"ac">, kind: "human" | "agent", scope: string): TreeActor => ({
  scope_id: scope,
  principal_id: id,
  actor_kind: kind,
  machine_id: TEST_MACHINE,
  origin: kind === "human" ? "ui" : "mcp",
});

/** Opens the tree space in `folder`, making it when `create`. */
export function openTree(
  checked: CheckedDriver,
  folder: string,
  create: boolean,
  at?: ConstructorParameters<typeof TreeWriter>[1]["at"],
): TreeFixture {
  const conn = openSpaceConnection(checked, join(folder, TREE_FILE), "writer", { create });
  if (create) {
    createTreeSpace(conn, {
      name: "Mira",
      refPrefix: "M",
      machineId: TEST_MACHINE,
      human: "user",
      at: 1_794_000_000_000,
    });
    conn
      .prepare(
        "INSERT INTO actors (id, kind, label, created_at) VALUES ($id, 'agent', 'agent:codex', 0)",
      )
      .run({ id: newId("ac") });
  }
  const spaceId = conn.prepare("SELECT space_id FROM space").get()?.["space_id"] as Id<"sp">;
  const id = (kind: string) =>
    conn.prepare("SELECT id FROM actors WHERE kind = $kind").get({ kind })?.["id"] as Id<"ac">;
  const human = actor(id("human"), "human", "ui:test");
  const agent = actor(id("agent"), "agent", "mcp:codex");
  const writer = new TreeWriter(conn, {
    machineId: TEST_MACHINE,
    ...(at === undefined ? {} : { at }),
  });
  return {
    conn,
    writer,
    spaceId,
    human,
    agent,
    send: (command, input, more = {}) =>
      writer.submit({
        space_id: spaceId,
        request_id: more.request_id ?? newId("op").slice(3),
        actor: more.who ?? human,
        command,
        input,
        ...(more.base === undefined ? {} : { base: more.base }),
        ...(more.entry === undefined ? {} : { entry: more.entry }),
      }),
    close: () => {
      conn.close();
    },
  };
}

const DERIVED = new Set(["created_seq", "version", "touched", "fv", "fp"]);

/**
 * Every problem with the history: per commit at most one change row per (row, field) and none with
 * an unchanged value; each field's changes chain (before is the previous after, before_ver its
 * seq); every row is exactly its create played forward by its sets, with fv, fp and version the
 * seqs of its latest changes; commits are numbered without a gap and each has its receipt.
 */
export function treeHistoryProblems(conn: Connection): string[] {
  const problems: string[] = [];
  const last = Number(conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);
  const seqs = conn
    .prepare("SELECT seq FROM commits ORDER BY seq")
    .all()
    .map((r) => Number(r["seq"]));
  if (seqs.length !== last || seqs.some((s, i) => s !== i + 1)) problems.push("seq-gapless");
  const unreceipted = conn
    .prepare(
      "SELECT count(*) AS n FROM commits k WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE " +
        "r.scope_id = k.scope_id AND r.request_id = k.request_id AND r.status = 'applied' AND r.seq = k.seq)",
    )
    .get()?.["n"];
  const orphan = conn
    .prepare(
      "SELECT count(*) AS n FROM receipts r WHERE r.seq IS NOT NULL AND NOT EXISTS " +
        "(SELECT 1 FROM commits k WHERE k.seq = r.seq AND k.request_id = r.request_id)",
    )
    .get()?.["n"];
  if (unreceipted !== 0 || orphan !== 0) problems.push("receipt-per-commit");
  const rows = new Map<string, Record<string, unknown>>();
  const versions = new Map<
    string,
    { fv: Record<string, number>; created: number; version: number }
  >();
  const seen = new Set<string>();
  for (const c of conn.prepare("SELECT * FROM changes ORDER BY seq, n").all()) {
    const entity = String(c["entity"]);
    const key = `${entity}|${String(c["entity_id"])}`;
    const seq = Number(c["seq"]);
    if (!isEntity(entity)) {
      problems.push(`history: ${entity} is no table`);
      continue;
    }
    if (c["action"] === "create") {
      rows.set(key, JSON.parse(String(c["after"])) as Record<string, unknown>);
      versions.set(key, { fv: {}, created: seq, version: seq });
      continue;
    }
    const field = String(c["field"]);
    const once = `${String(seq)}|${key}|${field}`;
    if (seen.has(once)) problems.push(`history: two rows for one field in commit ${String(seq)}`);
    seen.add(once);
    const row = rows.get(key);
    const v = versions.get(key);
    if (row === undefined || v === undefined) {
      problems.push(`history: a set before its create in commit ${String(seq)}`);
      continue;
    }
    const columns = columnsOf(entity, field);
    const before = JSON.stringify(
      columns.length === 1
        ? (row[columns[0] ?? ""] ?? null)
        : Object.fromEntries(columns.map((k) => [k, row[k] ?? null])),
    );
    if (before !== c["before"])
      problems.push(`history: ${field} does not chain in commit ${String(seq)}`);
    if (c["before"] === c["after"])
      problems.push(`history: an unchanged ${field} in commit ${String(seq)}`);
    if (Number(c["before_ver"]) !== (v.fv[field] ?? v.created))
      problems.push(`history: before_ver of ${field} in ${String(seq)}`);
    const after = JSON.parse(String(c["after"])) as unknown;
    if (columns.length === 1) row[columns[0] ?? ""] = after;
    else Object.assign(row, after);
    v.fv[field] = seq;
    v.version = seq;
  }
  for (const entity of Object.keys(FIELDS)) {
    for (const live of conn.prepare(`SELECT * FROM ${entity}`).all()) {
      if (Number(live["created_seq"]) === 0) continue; // the space's own root, made with it
      const key = `${entity}|${String(live["id"])}`;
      const played = rows.get(key);
      const v = versions.get(key);
      if (played === undefined || v === undefined) {
        problems.push(`history: a ${entity} row without its create`);
        continue;
      }
      for (const [column, value] of Object.entries(live)) {
        if (DERIVED.has(column)) continue;
        if (JSON.stringify(value) !== JSON.stringify(played[column] ?? null)) {
          problems.push(`history: ${entity}.${column} is not its history`);
        }
      }
      const fv = JSON.parse(String(live["fv"])) as Record<string, number>;
      if (
        JSON.stringify(fv) !== JSON.stringify(v.fv) ||
        JSON.stringify(live["fp"]) !== JSON.stringify(live["fv"])
      ) {
        problems.push(`history: ${entity} versions are not its history`);
      }
      if (Number(live["version"]) !== v.version) problems.push(`history: ${entity} version`);
    }
  }
  const refs =
    conn.prepare("SELECT max(ref) AS top, (SELECT next_ref FROM space) AS next FROM tasks").get() ??
    {};
  if (refs["top"] !== null && Number(refs["next"]) <= Number(refs["top"])) {
    problems.push("counters: the counter is behind a reference");
  }
  return problems;
}
