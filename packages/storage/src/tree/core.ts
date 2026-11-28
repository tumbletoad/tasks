// The tree's writer: one request is one named command, run inside one BEGIN IMMEDIATE on the
// space's writer connection:
//
//   space checks → receipt lookup → SAVEPOINT → commit row → the command, each statement reading
//   what the one before wrote → change rows, field versions → Undo's mark → receipt → COMMIT
//
// A command writes rows through its Tx and never touches commits, changes or receipts. A command
// may call another inside the same request (a finish's follow-ups): one commit and one receipt
// answer all of it, and a failure anywhere leaves nothing. The base is checked against each field's
// version as it stood before the request, so a request's second write to a field never conflicts
// with its first. Coalescing compares each written field with its value before the request: a
// commit holds one change row per (row, field), and a field that ends where it began has none and
// keeps its versions.
//
// Table and column names reach SQL text only from FIELDS and KEYS (fields.ts), so no input can.
import type { Connection, Row, SqlValue } from "../driver.ts";
import { misuse } from "../errors.ts";
import { newId, osRandom, type Id, type RandomSource } from "../ids.ts";
import { takeTaskRef } from "../refs.ts";
import { RowReader } from "../rows.ts";
import { columnsValue, fieldJson } from "../write/fields.ts";
import { intentFingerprint } from "../write/receipts.ts";
import { formatAsOf, incarnationTag, parseAsOf } from "../write/request.ts";
import { provenanceOf, rowState, versionOf, type RowState } from "../write/row-state.ts";
import { COMMANDS } from "./commands.ts";
import { columnsOf, FIELDS, KEYS, TreeProblem, type Entity, type FieldOf } from "./fields.ts";
import { planHistory, STEP_SQL } from "./steps.ts";

export { TreeProblem };

/** Columns a create change leaves out: each follows from the change's seq. */
const DERIVED = new Set(["created_seq", "version", "touched", "fv", "fp"]);

const SQL = {
  space: "SELECT * FROM space WHERE one = 1",
  receipt: "SELECT * FROM receipts WHERE scope_id = $scope AND request_id = $request",
  insertReceipt:
    "INSERT INTO receipts (scope_id, request_id, fingerprint, status, seq, epoch, incarnation, " +
    "result, at) VALUES ($scope, $request, $fingerprint, $status, $seq, $epoch, $incarnation, " +
    "$result, $at)",
  actor: "SELECT kind FROM actors WHERE id = $id",
  insertCommit:
    "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, author_id, " +
    "scope_id, machine_id, session_id, run_id, origin, request_id, kind, ops, affected, reason, " +
    "undo_of, redo_of) VALUES ($seq, $id, $epoch, $incarnation, $at, $actor_kind, $principal, " +
    "$author, $scope, $machine, $session, $run, $origin, $request, $kind, $ops, 0, $reason, " +
    "$undo_of, $redo_of)",
  affected: "UPDATE commits SET affected = $n WHERE seq = $seq",
  insertChange:
    "INSERT INTO changes (seq, n, entity, entity_id, node_id, action, field, before, after, " +
    "before_ver, before_prov, after_prov) VALUES ($seq, $n, $entity, $entity_id, $node, $action, " +
    "$field, $before, $after, $before_ver, $before_prov, $seq)",
  touched: "UPDATE nodes SET touched = $seq WHERE id = $id",
  lastSeq: "UPDATE space SET last_seq = $seq WHERE one = 1",
  markStep: `UPDATE commits SET undo_status = 'done' WHERE seq = $seq AND ${STEP_SQL("$seq")}`,
  deadUndone:
    "UPDATE commits SET undo_status = 'dead' WHERE principal_id = $principal AND undo_status = 'undone'",
  markUndone: "UPDATE commits SET undo_status = 'undone', undone_by = $seq WHERE seq = $target",
  markRedone: "UPDATE commits SET undo_status = 'done', undone_by = NULL WHERE seq = $target",
  markDead: "UPDATE commits SET undo_status = 'dead' WHERE seq = $target",
} as const;

const rowSql = (entity: Entity): string => `SELECT * FROM ${entity} WHERE id = $id`;

export type ActorKind = "human" | "agent" | "routine" | "system" | "import";

export interface TreeActor {
  scope_id: string;
  principal_id: Id<"ac">;
  /** Who wrote it, when another than the principal: an agent acting on the person's authority. */
  author_id?: Id<"ac">;
  actor_kind: ActorKind;
  machine_id: string;
  origin: "ui" | "cli" | "mcp" | "http" | "import" | "system";
  session_id?: string;
  run_id?: string;
}

export interface TreeRequest {
  space_id: string;
  request_id: string;
  actor: TreeActor;
  /** The `as_of` of the read the request was made from: a field changed after it conflicts. */
  base?: string;
  /** One line of what changed and why. */
  reason?: string;
  /** The tool entry the request comes from: its refusals store no receipt. */
  entry?: string;
  command: string;
  input: Record<string, unknown>;
}

export type TreeStatus = "applied" | "unchanged" | "conflict" | "rejected";

export interface TreeConflict {
  entity: Entity;
  id: string;
  field: string;
  version: number;
}

export interface TreeResult {
  status: TreeStatus;
  as_of: string;
  seq: number;
  commit?: Id<"op">;
  /** What the command did, as it said: stored with the receipt and returned on a retry. */
  result?: unknown;
  error?: { code: string; message: string; field?: string; data?: unknown };
  conflicts?: TreeConflict[];
  replayed?: true;
}

/** The rows a request wrote, in order, with what they were before it. */
interface Written {
  entity: Entity;
  id: string;
  node: string | null;
  created: boolean;
  start: RowState | undefined;
  fields: Set<string>;
  order: number;
}

interface SpaceState {
  spaceId: string;
  refPrefix: string;
  lastSeq: number;
  epoch: number;
  incarnation: Id<"ai">;
  machine: string;
}

/** What a command writes through, inside the request's transaction. */
export class Tx {
  readonly conn: Connection;
  readonly seq: number;
  readonly at: number;
  readonly request: TreeRequest;
  readonly space: SpaceState;
  readonly random: RandomSource;
  readonly #base: number | undefined;
  readonly #rows = new Map<string, Written>();
  readonly conflicts: TreeConflict[] = [];

  constructor(
    conn: Connection,
    seq: number,
    at: number,
    request: TreeRequest,
    space: SpaceState,
    base: number | undefined,
    random: RandomSource,
  ) {
    this.conn = conn;
    this.seq = seq;
    this.at = at;
    this.request = request;
    this.space = space;
    this.#base = base;
    this.random = random;
  }

  /** The person or agent the request writes as. */
  get author(): Id<"ac"> {
    return this.request.actor.author_id ?? this.request.actor.principal_id;
  }

  get(sql: string, params: Record<string, SqlValue> = {}): Row | undefined {
    return this.conn.prepare(sql).get(params);
  }

  all(sql: string, params: Record<string, SqlValue> = {}): Row[] {
    return this.conn.prepare(sql).all(params);
  }

  /** The next reference of the space's one counter. */
  ref(): number {
    return takeTaskRef(this.conn);
  }

  newId<P extends "t" | "p" | "n" | "s">(prefix: P): Id<P> {
    return newId(prefix, this.random);
  }

  /** Runs another command in this request: its writes are this commit's. */
  call(command: string, input: Record<string, unknown>): unknown {
    const run = COMMANDS[command];
    if (run === undefined) throw misuse("No command of that name");
    return run(this, input);
  }

  /** Inserts a new row. `node` is the node it belongs to. */
  create(entity: Entity, values: Record<string, SqlValue>, node: string | null): void {
    const allowed = new Set([
      ...KEYS[entity],
      ...Object.values(FIELDS[entity] as Record<string, readonly string[]>).flat(),
    ]);
    const columns = Object.keys(values);
    if (columns.some((c) => !allowed.has(c))) throw misuse("A column the table does not have");
    const all = [...columns, "created_seq", "version", ...(entity === "nodes" ? ["touched"] : [])];
    const sql =
      `INSERT INTO ${entity} (${all.join(", ")}) VALUES (` +
      `${[...columns.map((c) => `$${c}`), "$seq", "$seq", ...(entity === "nodes" ? ["$seq"] : [])].join(", ")})`;
    this.conn.prepare(sql).run({ ...values, seq: this.seq });
    const id = String(values["id"]);
    this.#rows.set(`${entity}|${id}`, {
      entity,
      id,
      node,
      created: true,
      start: undefined,
      fields: new Set(),
      order: this.#rows.size,
    });
  }

  /**
   * Sets fields of an existing row, each as an object of its columns (a one-column field may be
   * given as its value). A field whose version before the request is newer than the base is a
   * conflict: it is collected and not written, and the request writes nothing.
   */
  set<E extends Entity>(
    entity: E,
    id: string,
    node: string | null,
    fields: Partial<Record<FieldOf<E>, SqlValue | Record<string, SqlValue>>>,
  ): void {
    const key = `${entity}|${id}`;
    let row = this.#rows.get(key);
    if (row === undefined) {
      const raw = this.conn.prepare(rowSql(entity)).get({ id });
      if (raw === undefined) throw misuse("A command set a row it did not read");
      row = {
        entity,
        id,
        node,
        created: false,
        start: rowState(entity, raw, FIELDS[entity]),
        fields: new Set(),
        order: this.#rows.size,
      };
      this.#rows.set(key, row);
    }
    const assign: string[] = [];
    const params: Record<string, SqlValue> = { id };
    for (const [field, given] of Object.entries<unknown>(fields)) {
      const columns = columnsOf(entity, field);
      if (row.start !== undefined && this.#base !== undefined) {
        const version = versionOf(row.start, field);
        if (version > this.#base) {
          if (
            !this.conflicts.some((c) => c.entity === entity && c.id === id && c.field === field)
          ) {
            this.conflicts.push({ entity, id, field, version });
          }
          continue;
        }
      }
      const value =
        columns.length === 1 && (typeof given !== "object" || given === null)
          ? { [columns[0] ?? ""]: given as SqlValue }
          : (given as Record<string, SqlValue>);
      for (const column of columns) {
        if (!(column in value)) continue;
        assign.push(`${column} = $${column}`);
        params[column] = value[column] ?? null;
      }
      row.fields.add(field);
    }
    if (assign.length > 0) {
      this.conn.prepare(`UPDATE ${entity} SET ${assign.join(", ")} WHERE id = $id`).run(params);
    }
  }

  /** The change rows of the request, coalesced; sets the versions of each changed row. */
  finish(): ChangeRow[] {
    const changes: ChangeRow[] = [];
    const nodes = new Set<string>();
    const tasks = new Set<string>();
    for (const row of [...this.#rows.values()].sort((a, b) => a.order - b.order)) {
      const final = this.conn.prepare(rowSql(row.entity)).get({ id: row.id });
      if (final === undefined) throw misuse("A written row is gone");
      if (row.created) {
        const after = Object.fromEntries(Object.entries(final).filter(([c]) => !DERIVED.has(c)));
        changes.push({
          ...head(row),
          action: "create",
          field: null,
          before: null,
          after: fieldJson(after),
          beforeVer: null,
          beforeProv: null,
        });
      } else {
        const start = row.start;
        if (start === undefined) throw misuse("A written row has no start");
        const fv = { ...start.fv };
        const fp = { ...start.fp };
        for (const field of row.fields) {
          const columns = columnsOf(row.entity, field);
          const before = fieldJson(columnsValue(start.raw, columns));
          const after = fieldJson(columnsValue(final, columns));
          if (before === after) continue;
          changes.push({
            ...head(row),
            action: "set",
            field,
            before,
            after,
            beforeVer: versionOf(start, field),
            beforeProv: provenanceOf(start, field),
          });
          fv[field] = this.seq;
          fp[field] = this.seq;
        }
        if (!changes.some((c) => c.entity === row.entity && c.entityId === row.id)) continue;
        this.conn
          .prepare(`UPDATE ${row.entity} SET version = $seq, fv = $fv, fp = $fp WHERE id = $id`)
          .run({ seq: this.seq, fv: JSON.stringify(fv), fp: JSON.stringify(fp), id: row.id });
      }
      if (row.node !== null) nodes.add(row.node);
      if (row.entity === "tasks") tasks.add(row.id);
    }
    for (const id of nodes) this.conn.prepare(SQL.touched).run({ id, seq: this.seq });
    this.conn.prepare(SQL.affected).run({ n: tasks.size, seq: this.seq });
    return changes;
  }
}

export interface ChangeRow {
  entity: Entity;
  entityId: string;
  node: string | null;
  action: "create" | "set";
  field: string | null;
  before: string | null;
  after: string;
  beforeVer: number | null;
  beforeProv: number | null;
}

const head = (row: Written) => ({ entity: row.entity, entityId: row.id, node: row.node });

/** A command: it reads and writes through its Tx and returns what it did. */
export type Command = (tx: Tx, input: Record<string, unknown>) => unknown;

/** What Undo and Redo ask the core for: the commit they answer, and what to run. */
export interface HistoryRun {
  kind: "undo" | "redo";
  target: number;
  /** The opposite commands, in order. */
  calls: { command: string; input: Record<string, unknown> }[];
}

export interface TreeWriterOptions {
  machineId: string;
  random?: RandomSource;
  clock?: () => number;
  /** Called before COMMIT and after it: the crash harness stops the process there. */
  at?: (point: "before-commit" | "after-commit", result: TreeResult) => void;
}

/** The writer of one tree space, on its writer connection. Synchronous. */
export class TreeWriter {
  readonly #conn: Connection;
  readonly #machine: string;
  readonly #random: RandomSource;
  readonly #clock: () => number;
  readonly #at: TreeWriterOptions["at"];
  #last = 0;

  constructor(conn: Connection, options: TreeWriterOptions) {
    this.#conn = conn;
    this.#machine = options.machineId;
    this.#random = options.random ?? osRandom;
    this.#clock = options.clock ?? Date.now;
    this.#at = options.at;
  }

  get connection(): Connection {
    return this.#conn;
  }

  submit(request: TreeRequest): TreeResult {
    const result = this.#conn.transaction("immediate", () => {
      const decided = this.#decide(request);
      this.#at?.("before-commit", decided);
      return decided;
    });
    this.#at?.("after-commit", result);
    return result;
  }

  #space(): SpaceState {
    const r = new RowReader("space", this.#conn.prepare(SQL.space).get() ?? {});
    return {
      spaceId: r.text("space_id"),
      refPrefix: r.text("ref_prefix"),
      lastSeq: r.int("last_seq", "seq"),
      epoch: r.int("authority_epoch", "epoch"),
      incarnation: r.id("authority_incarnation", "ai"),
      machine: r.text("authority_machine"),
    };
  }

  #decide(request: TreeRequest): TreeResult {
    const space = this.#space();
    const asOf = { epoch: space.epoch, incarnation: space.incarnation, seq: space.lastSeq };
    const now = (status: TreeStatus, more: Partial<TreeResult> = {}): TreeResult => ({
      status,
      as_of: formatAsOf(asOf),
      seq: asOf.seq,
      ...more,
    });
    // Nothing here decides the intent, so nothing stores a receipt.
    if (request.space_id !== space.spaceId) {
      return now("rejected", {
        error: {
          code: "SPACE_MISMATCH",
          message: "The request names another space",
          field: "space_id",
        },
      });
    }
    if (space.machine !== this.#machine) {
      return now("rejected", {
        error: { code: "SPACE_READ_ONLY", message: "This machine is not the space's authority" },
      });
    }
    if (this.#conn.prepare(SQL.actor).get({ id: request.actor.principal_id }) === undefined) {
      return now("rejected", {
        error: {
          code: "ACTOR_UNKNOWN",
          message: "The space does not know this actor",
          field: "actor.principal_id",
        },
      });
    }
    const lookup = { scope: request.actor.scope_id, request: request.request_id };
    const fingerprint = intentFingerprint({
      space_id: request.space_id,
      entry: request.entry ?? request.command,
      input: request.input,
      reason: request.reason ?? null,
    });
    const prior = this.#conn.prepare(SQL.receipt).get(lookup);
    if (prior !== undefined) {
      const stored = JSON.parse(String(prior["result"])) as TreeResult;
      if (prior["fingerprint"] === fingerprint) return { ...stored, replayed: true };
      return now("rejected", {
        error: {
          code: "REQUEST_ID_REUSED",
          message: "This request ID was used for another change: review it, then use a new ID",
          field: "request_id",
        },
      });
    }
    const result = this.#judge(request, space, now);
    const accepted = result.status === "applied" || result.status === "unchanged";
    if (accepted || request.entry === undefined) {
      this.#conn.prepare(SQL.insertReceipt).run({
        ...lookup,
        fingerprint,
        status: result.status,
        seq: result.commit === undefined ? null : result.seq,
        epoch: space.epoch,
        incarnation: space.incarnation,
        result: JSON.stringify(result),
        at: this.#instant(),
      });
    }
    return result;
  }

  /** A clock that never goes back within this writer. */
  #instant(): number {
    this.#last = Math.max(this.#last, this.#clock());
    return this.#last;
  }

  #judge(
    request: TreeRequest,
    space: SpaceState,
    now: (status: TreeStatus, more?: Partial<TreeResult>) => TreeResult,
  ): TreeResult {
    let base: number | undefined;
    if (request.base !== undefined) {
      const parsed = parseAsOf(request.base);
      if (parsed === undefined) {
        return now("rejected", {
          error: {
            code: "VALIDATION_FAILED",
            message: "Copy as_of verbatim as the base",
            field: "base",
          },
        });
      }
      if (
        parsed.epoch !== space.epoch ||
        parsed.incarnation !== incarnationTag(space.incarnation)
      ) {
        return now("rejected", {
          error: {
            code: "EPOCH_CHANGED",
            message: "The space was restored or claimed since that read: read again",
            field: "base",
          },
        });
      }
      base = parsed.seq;
    }
    const history = request.command === "undo" || request.command === "redo";
    const run = history ? undefined : COMMANDS[request.command];
    if (!history && run === undefined) {
      return now("rejected", {
        error: { code: "VALIDATION_FAILED", message: "No command of that name", field: "command" },
      });
    }
    const seq = space.lastSeq + 1;
    const at = this.#instant();
    const commit = newId("op", this.#random);
    this.#conn.exec("SAVEPOINT tree");
    let plan: HistoryRun | undefined;
    try {
      const tx = new Tx(this.#conn, seq, at, request, space, base, this.#random);
      let said: unknown;
      if (history) {
        plan = planHistory(tx, request.command as "undo" | "redo", request.input);
      }
      this.#insertCommit(tx, commit, plan);
      if (plan !== undefined) for (const call of plan.calls) tx.call(call.command, call.input);
      else said = run?.(tx, request.input);
      if (tx.conflicts.length > 0) {
        const message = "A field changed after the base: read again";
        throw new TreeProblem("VERSION_CONFLICT", message, undefined, tx.conflicts);
      }
      const changes = tx.finish();
      if (changes.length === 0) {
        // Already as it was: a step leaves the stack, as one newer work kept.
        if (plan !== undefined)
          throw new TreeProblem("STEP_KEPT", "Already as it was", undefined, {
            target: plan.target,
            work: [],
          });
        this.#conn.exec("ROLLBACK TO tree");
        this.#conn.exec("RELEASE tree");
        return now("unchanged", said === undefined ? {} : { result: said });
      }
      const insert = this.#conn.prepare(SQL.insertChange);
      changes.forEach((c, i) => {
        insert.run({
          seq,
          n: i + 1,
          entity: c.entity,
          entity_id: c.entityId,
          node: c.node,
          action: c.action,
          field: c.field,
          before: c.before,
          after: c.after,
          before_ver: c.beforeVer,
          before_prov: c.beforeProv,
        });
      });
      if (plan !== undefined) {
        const target = plan.target;
        if (plan.kind === "undo") this.#conn.prepare(SQL.markUndone).run({ target, seq });
        else this.#conn.prepare(SQL.markRedone).run({ target });
      } else if (
        request.actor.actor_kind === "human" &&
        this.#conn.prepare(SQL.markStep).run({ seq }).changes > 0
      ) {
        // A new step ends what could be redone.
        this.#conn.prepare(SQL.deadUndone).run({ principal: request.actor.principal_id });
      }
      this.#conn.prepare(SQL.lastSeq).run({ seq });
      this.#conn.exec("RELEASE tree");
      return {
        status: "applied",
        as_of: formatAsOf({ epoch: space.epoch, incarnation: space.incarnation, seq }),
        seq,
        commit,
        ...(said === undefined ? {} : { result: said }),
      };
    } catch (error) {
      this.#conn.exec("ROLLBACK TO tree");
      this.#conn.exec("RELEASE tree");
      if (!(error instanceof TreeProblem)) throw error;
      if (error.code === "VERSION_CONFLICT") {
        const conflicts = error.data as TreeConflict[];
        return now("conflict", { error: { code: error.code, message: error.message }, conflicts });
      }
      // Newer work stands in the way, or the opposite cannot be applied now (a task in the Trash):
      // the step leaves the stack, and the answer says whose work or why.
      const kept =
        error.code === "STEP_KEPT"
          ? (error.data as { target: number; work: unknown[] })
          : plan === undefined
            ? undefined
            : { target: plan.target, work: [], reason: error.message };
      if (kept !== undefined) {
        this.#conn.prepare(SQL.markDead).run({ target: kept.target });
        return now("applied", { result: { kept } });
      }
      return now("rejected", {
        error: {
          code: error.code,
          message: error.message,
          ...(error.field === undefined ? {} : { field: error.field }),
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      });
    }
  }

  #insertCommit(tx: Tx, id: Id<"op">, plan: HistoryRun | undefined): void {
    const { actor } = tx.request;
    this.#conn.prepare(SQL.insertCommit).run({
      seq: tx.seq,
      id,
      epoch: tx.space.epoch,
      incarnation: tx.space.incarnation,
      at: tx.at,
      actor_kind: actor.actor_kind,
      principal: actor.principal_id,
      author: tx.author,
      scope: actor.scope_id,
      machine: actor.machine_id,
      session: actor.session_id ?? null,
      run: actor.run_id ?? null,
      origin: actor.origin,
      request: tx.request.request_id,
      kind: plan?.kind ?? "command",
      ops: JSON.stringify([{ v: 1, command: tx.request.command, input: tx.request.input }]),
      reason: tx.request.reason ?? null,
      undo_of: plan?.kind === "undo" ? plan.target : null,
      redo_of: plan?.kind === "redo" ? plan.target : null,
    });
  }
}
