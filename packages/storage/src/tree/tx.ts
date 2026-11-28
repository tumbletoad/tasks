// What a command writes through: the request's one transaction, seen as rows and fields. A
// command reads with get and all, makes rows with create, changes fields with set and calls
// another command with call; finish then coalesces what the request wrote into change rows and
// sets each changed row's versions. The base is checked against each field's version as it stood
// before the request, so a request's second write to a field never conflicts with its first.
import type { Connection, Row, SqlValue } from "../driver.ts";
import { misuse } from "../errors.ts";
import { isId, newId, type Id, type RandomSource } from "../ids.ts";
import { takeTaskRef } from "../refs.ts";
import { columnsValue, fieldJson } from "../write/fields.ts";
import { Fields, type Credential, type Envelope } from "../write/request.ts";
import { provenanceOf, rowState, versionOf, type RowState } from "../write/row-state.ts";
import {
  columnsOf,
  FIELDS,
  keyOf,
  KEYS,
  TreeProblem,
  type Entity,
  type FieldOf,
} from "./fields.ts";
import { DERIVED } from "./schema.ts";

const SQL = {
  lifecycle: "SELECT lifecycle FROM tasks WHERE id = $id",
  affected: "UPDATE commits SET affected = $n WHERE seq = $seq",
  touched: "UPDATE nodes SET touched = $seq WHERE id = $id",
} as const;

const rowSql = (entity: Entity): string => `SELECT * FROM ${entity} WHERE ${keyOf(entity)} = $id`;

/** Who asks, as today's writer reads a credential. */
export type TreeActor = Credential;

/** A tree request as a caller sends it; `checkTreeRequest` (core.ts) checks it. */
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
  /** What the caller found and decided before the writer: kept with an accepted result. */
  warnings?: string[];
  answer?: Record<string, unknown>;
  command: string;
  input: Record<string, unknown>;
}

/** A tree request as `checkTreeRequest` leaves it: today's envelope, the command and its input. */
export interface CheckedTreeRequest extends Envelope {
  command: string;
  /** The tool entry the request comes from: its refusals store no receipt. */
  entry?: string;
  input: Record<string, unknown>;
}

/**
 * A field that changed after the base: the row, the task it belongs to with its reference, the
 * value now, its version, and who changed it and when. A receipt keeps all but the value.
 */
export interface TreeConflict {
  entity: Entity;
  id: string;
  task?: string;
  ref?: string;
  field: string;
  value?: unknown;
  version: number;
  by?: { actor: string; kind: string; label: string; origin: string };
  at?: number;
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

export interface SpaceState {
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
  readonly request: CheckedTreeRequest;
  readonly space: SpaceState;
  readonly random: RandomSource;
  readonly #commands: Readonly<Record<string, Command>>;
  /** The request's base, none, or `history`: an Undo or Redo, guarded by newer work instead. */
  readonly #base: number | "history" | undefined;
  readonly #rows = new Map<string, Written>();
  readonly conflicts: TreeConflict[] = [];

  constructor(
    conn: Connection,
    seq: number,
    at: number,
    request: CheckedTreeRequest,
    space: SpaceState,
    base: number | "history" | undefined,
    random: RandomSource,
    commands: Readonly<Record<string, Command>>,
  ) {
    this.conn = conn;
    this.seq = seq;
    this.at = at;
    this.request = request;
    this.space = space;
    this.#base = base;
    this.random = random;
    this.#commands = commands;
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

  newId<P extends "t" | "p" | "n" | "pg" | "s" | "lk" | "la" | "ru" | "fo" | "oc">(
    prefix: P,
  ): Id<P> {
    return newId(prefix, this.random);
  }

  /** Runs another command in this request: its writes are this commit's. */
  call(command: string, input: Record<string, unknown>): unknown {
    const named = this.#commands[command];
    if (named === undefined) throw misuse("No command of that name");
    // Its input is checked as a request's is: an opposite or a follow-up is held to the same rules.
    return named.run(this, named.check(new Fields(input, "")));
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
    const id = String(values[keyOf(entity)]);
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

  /** The row as the request first touched it: its start, read once. */
  #touch(entity: Entity, id: string, node: string | null): Written {
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
    return row;
  }

  /**
   * The fields of `fields` that changed since the base, each collected once as a conflict. A write
   * to a row that exists needs a base; an Undo or Redo is guarded by newer work instead.
   */
  #newer(row: Written, fields: Iterable<string>): string[] {
    if (row.start === undefined || this.#base === "history") return [];
    if (this.#base === undefined) {
      throw new TreeProblem(
        "BASE_REQUIRED",
        "This change needs the as_of of a read as its base",
        "base",
      );
    }
    const newer: string[] = [];
    for (const field of fields) {
      const version = versionOf(row.start, field);
      if (version <= this.#base) continue;
      newer.push(field);
      const seen = this.conflicts.some(
        (c) => c.entity === row.entity && c.id === row.id && c.field === field,
      );
      if (seen) continue;
      const value = columnsValue(row.start.raw, columnsOf(row.entity, field));
      const task = isId(row.node, "t") ? { task: row.node } : {};
      this.conflicts.push({ entity: row.entity, id: row.id, ...task, field, value, version });
    }
    return newer;
  }

  /**
   * Holds the request to every field of a row as it stood at the base, also those it does not
   * write: a task goes to the Trash only as the person saw it, never after someone changed it.
   */
  guard(entity: Entity, id: string, node: string | null): void {
    this.#newer(this.#touch(entity, id, node), Object.keys(FIELDS[entity]));
  }

  /**
   * Holds the request to `fields` of a row as they stood at the base, written or not; true when
   * one changed since, and the request then writes nothing.
   */
  held(entity: Entity, id: string, node: string | null, fields: readonly string[]): boolean {
    if (fields.length === 0) return false;
    return this.#newer(this.#touch(entity, id, node), fields).length > 0;
  }

  /**
   * Sets fields of an existing row, each as an object of its columns (a one-column field may be
   * given as its value). The fields of one call change together: when any of them changed after
   * the base, the call writes none of them, the conflicts are collected, and the request writes
   * nothing. `based` false is for a write that holds whatever else changed, such as an edit of old
   * words to new words.
   */
  set<E extends Entity>(
    entity: E,
    id: string,
    node: string | null,
    fields: Partial<Record<FieldOf<E>, SqlValue | Record<string, SqlValue>>>,
    based = true,
  ): void {
    const row = this.#touch(entity, id, node);
    // A request marked active changes active tasks only, decided as it finds them.
    if (this.request.active === true && row.start !== undefined && isId(row.node, "t")) {
      const life = this.conn.prepare(SQL.lifecycle).get({ id: row.node })?.["lifecycle"];
      if (life !== "active")
        throw new TreeProblem("TASK_NOT_ACTIVE", "The task is not active", "task");
    }
    if (based && this.#newer(row, Object.keys(fields)).length > 0) return;
    const assign: string[] = [];
    const params: Record<string, SqlValue> = { id };
    for (const [field, given] of Object.entries<unknown>(fields)) {
      const columns = columnsOf(entity, field);
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
      const where = `WHERE ${keyOf(entity)} = $id`;
      this.conn.prepare(`UPDATE ${entity} SET ${assign.join(", ")} ${where}`).run(params);
    }
  }

  /** The change rows of the request, coalesced; sets the versions of each changed row. */
  finish(): ChangeRow[] {
    const changes: ChangeRow[] = [];
    const nodes = new Set<string>();
    /** The tasks the commit finished, reopened, put in the Trash or brought back. */
    const affected = new Set<string>();
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
        let changed = false;
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
          changed = true;
          if (field === "lifecycle" || (row.entity === "nodes" && field === "deleted")) {
            affected.add(row.id);
          }
        }
        if (!changed) continue;
        this.conn
          .prepare(
            `UPDATE ${row.entity} SET version = $seq, fv = $fv, fp = $fp WHERE ${keyOf(row.entity)} = $id`,
          )
          .run({ seq: this.seq, fv: JSON.stringify(fv), fp: JSON.stringify(fp), id: row.id });
      }
      if (row.node !== null) nodes.add(row.node);
    }
    for (const id of nodes) this.conn.prepare(SQL.touched).run({ id, seq: this.seq });
    this.conn.prepare(SQL.affected).run({ n: affected.size, seq: this.seq });
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

/**
 * A command. `check` reads its input from the request alone, normalised, and refuses what is not
 * valid whatever the space holds, so such a request is decided by nothing and stores nothing. `run`
 * reads and writes through its Tx and returns what it did.
 */
export interface Command {
  check: (input: Fields) => Record<string, unknown>;
  run: (tx: Tx, input: Record<string, unknown>) => unknown;
}

/** What Undo and Redo ask the core for: the commit they answer, and what to run. */
export interface HistoryRun {
  kind: "undo" | "redo";
  target: number;
  /** The opposite commands, in order. */
  calls: { command: string; input: Record<string, unknown> }[];
}
