// The write and read paths the benchmarks time, at spike level. A one-task patch writes what A1
// 3.7 says a commit writes, in one BEGIN IMMEDIATE transaction: the receipt lookup, the commit row,
// the task row with its versions, the change row, the search document, the outbox rows, the
// receipt and space.last_seq. A receipt-only commit is a decided request that changed nothing
// (A1 3.8, A1 M0 item 2).
//
// Timed writes look like A1's: commit IDs are random A1 IDs (3.3), request IDs are A1 ID bodies
// (3.8), and every commit belongs to an agent session, so the unique-ID index, the receipts key and
// the commits_session index see the same insert pattern as in the product. All of it comes from a
// seeded source, so a run is repeatable.
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { closeAfterFailure } from "./connection.ts";
import { Rng } from "./rng.ts";
import { configureReader, configureWriter } from "./schema.ts";

type Row = Record<string, unknown>;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function prepareAll<K extends string>(
  db: DatabaseSync,
  sql: Record<K, string>,
): Record<K, StatementSync> {
  const out = {} as Record<K, StatementSync>;
  for (const key of Object.keys(sql) as K[]) out[key] = db.prepare(sql[key]);
  return out;
}

const getRow = (stmt: StatementSync, ...args: (string | number)[]): Row | undefined =>
  stmt.get(...args);

/** Opens and configures a connection, and closes it again when the configuration fails. */
function open(db: DatabaseSync, configure: (db: DatabaseSync) => void): DatabaseSync {
  try {
    configure(db);
  } catch (error) {
    closeAfterFailure(db);
    throw error;
  }
  return db;
}

export const openWriter = (path: string): DatabaseSync =>
  open(new DatabaseSync(path), configureWriter);

export const openReader = (path: string): DatabaseSync =>
  open(new DatabaseSync(path, { readOnly: true }), configureReader);

/** Runs `fn` in one transaction and rolls back when it throws. */
function transaction<T>(db: DatabaseSync, begin: string, fn: () => T): T {
  db.exec(begin);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

const WRITES = {
  receipt: "SELECT status FROM receipts WHERE scope_id = ? AND request_id = ?",
  space: "SELECT last_seq FROM space",
  task: "SELECT id, summary, version, fv FROM tasks WHERE ref = ?",
  commit: `INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id,
    author_id, scope_id, machine_id, session_id, origin, request_id, kind, ops)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mcp', ?, 'ops', ?)`,
  update: `UPDATE tasks SET summary = ?, version = ?, touched = ?,
    fv = json_set(fv, '$.summary', ?), fp = json_set(fp, '$.summary', ?) WHERE id = ?`,
  change: `INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before,
    after, before_ver, before_prov, after_prov)
    VALUES (?, 0, 0, 'tasks', ?, ?, 'set', 'summary', ?, ?, ?, ?, ?)`,
  doc: "SELECT doc FROM search_docs WHERE entity_id = ?",
  ftsRow: "SELECT title, body, extra FROM search_fts WHERE rowid = ?",
  ftsDelete: "DELETE FROM search_fts WHERE rowid = ?",
  ftsInsert: "INSERT INTO search_fts (rowid, title, body, extra) VALUES (?, ?, ?, ?)",
  docSeq: "UPDATE search_docs SET seq = ? WHERE doc = ?",
  outbox: `INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', ?, ?, ?)
    ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq`,
  insertReceipt: `INSERT INTO receipts (scope_id, request_id, fingerprint, status, seq, epoch,
    incarnation, result, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  lastSeq: "UPDATE space SET last_seq = ?",
} as const;

export class SpaceWriter {
  readonly #db: DatabaseSync;
  readonly #s: Record<keyof typeof WRITES, StatementSync>;
  readonly #epoch: number;
  readonly #incarnation: string;
  readonly #machine: string;
  readonly #prefix: string;
  readonly #actor: string;
  readonly #rng: Rng;
  /**
   * The agent sessions this writer simulates. Each is bound, so its session record is also its
   * writer scope (A1 3.8), as in the fixture.
   */
  readonly sessions: readonly string[];
  /** References of the active tasks, the targets of the patches. */
  readonly openRefs: readonly number[];

  /** `name` seeds the IDs, for example "r03-mira". `sessions` is the number of agent sessions. */
  constructor(db: DatabaseSync, name: string, sessions = 1) {
    this.#db = db;
    this.#s = prepareAll(db, WRITES);
    const space = db
      .prepare(
        "SELECT authority_epoch, authority_incarnation, authority_machine, ref_prefix FROM space",
      )
      .get() as Row;
    this.#epoch = space["authority_epoch"] as number;
    this.#incarnation = space["authority_incarnation"] as string;
    this.#machine = space["authority_machine"] as string;
    this.#prefix = space["ref_prefix"] as string;
    const actor = db
      .prepare("SELECT id FROM actors WHERE kind = 'agent' ORDER BY id LIMIT 1")
      .get() as Row;
    this.#actor = actor["id"] as string;
    this.#rng = new Rng(`${name}/writes`);
    this.sessions = Array.from({ length: sessions }, () => this.#rng.id("se"));
    this.openRefs = (
      db.prepare("SELECT ref FROM tasks WHERE lifecycle = 'active' ORDER BY ref").all() as Row[]
    ).map((r) => r["ref"] as number);
  }

  #session(session: number): string {
    const id = this.sessions[session];
    if (id === undefined) throw new Error(`no session ${String(session)}`);
    return id;
  }

  /**
   * One-task patch from agent session number `session`: sets the summary of the task with this
   * reference. Returns the new seq. The request ID and the commit ID are drawn before the timed
   * transaction starts in the product too (the client sends one, the writer draws the other).
   */
  patchSummary(ref: number, summary: string, session = 0): number {
    const s = this.#s;
    const scope = this.#session(session);
    const requestId = this.#rng.id("rq").slice(3);
    const opId = this.#rng.id("op");
    return transaction(this.#db, "BEGIN IMMEDIATE", () => {
      if (getRow(s.receipt, scope, requestId) !== undefined) {
        throw new Error("request ID reused");
      }
      const seq = ((getRow(s.space) as Row)["last_seq"] as number) + 1;
      const task = getRow(s.task, ref);
      if (task === undefined) throw new Error(`no task with reference ${String(ref)}`);
      const id = task["id"] as string;
      const fv = JSON.parse(task["fv"] as string) as Record<string, number>;
      const before = task["summary"] as string;
      const beforeVer = fv["summary"] ?? (task["version"] as number);
      const at = Date.now();
      const ops = JSON.stringify([{ op: "task.patch", task: id, set: { summary } }]);
      s.commit.run(
        seq,
        opId,
        this.#epoch,
        this.#incarnation,
        at,
        "agent",
        this.#actor,
        this.#actor,
        scope,
        this.#machine,
        scope,
        requestId,
        ops,
      );
      s.update.run(summary, seq, seq, seq, seq, id);
      s.change.run(
        seq,
        id,
        id,
        JSON.stringify(before),
        JSON.stringify(summary),
        beforeVer,
        beforeVer,
        seq,
      );
      const doc = getRow(s.doc, id);
      if (doc !== undefined) {
        const docId = doc["doc"] as number;
        const fts = getRow(s.ftsRow, docId) as Row;
        const body = (fts["body"] as string).replace(before, summary);
        s.ftsDelete.run(docId);
        s.ftsInsert.run(docId, fts["title"] as string, body, fts["extra"] as string);
        s.docSeq.run(seq, docId);
      }
      s.outbox.run(id, seq, seq);
      s.outbox.run("*", seq, seq);
      const result = JSON.stringify({
        status: "applied",
        epoch: this.#epoch,
        seq,
        commit: opId,
        results: [
          { i: 0, status: "updated", id, ref: `${this.#prefix}-${String(ref)}`, version: seq },
        ],
        warnings: [],
      });
      s.insertReceipt.run(
        scope,
        requestId,
        sha256(ops),
        "applied",
        seq,
        this.#epoch,
        this.#incarnation,
        result,
        at,
      );
      s.lastSeq.run(seq);
      return seq;
    });
  }

  /** A decided request that changed nothing: only its receipt is written (A1 3.8). */
  receiptOnly(session = 0): void {
    const s = this.#s;
    const scope = this.#session(session);
    const requestId = this.#rng.id("rq").slice(3);
    transaction(this.#db, "BEGIN IMMEDIATE", () => {
      if (getRow(s.receipt, scope, requestId) !== undefined) {
        throw new Error("request ID reused");
      }
      const result = JSON.stringify({
        status: "unchanged",
        epoch: this.#epoch,
        results: [],
        warnings: [],
      });
      s.insertReceipt.run(
        scope,
        requestId,
        sha256(requestId),
        "unchanged",
        null,
        this.#epoch,
        this.#incarnation,
        result,
        Date.now(),
      );
    });
  }
}

const READS = {
  task: "SELECT * FROM tasks WHERE ref = ?",
  notes: "SELECT * FROM notes WHERE task_id = ? ORDER BY ordinal",
  log: "SELECT * FROM log_entries WHERE task_id = ? ORDER BY ordinal",
  sources: `SELECT s.* FROM task_sources ts JOIN sources s ON s.id = ts.source_id
    WHERE ts.task_id = ? AND ts.removed_at IS NULL`,
  open: `SELECT id, ref, title, summary, status, priority, due_date, project_id, position
    FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL
    ORDER BY status, project_id, position`,
  lastSeq: "SELECT last_seq FROM space",
  maxSeq: "SELECT coalesce(max(seq), 0) AS seq FROM commits",
} as const;

/** The reads R02's reader workers time (A1 3.20 targets, recorded for information). */
export class SpaceReader {
  readonly #db: DatabaseSync;
  readonly #s: Record<keyof typeof READS, StatementSync>;
  /** The highest task reference. */
  readonly refs: number;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#s = prepareAll(db, READS);
    const max = db.prepare("SELECT max(ref) AS r FROM tasks").get() as Row;
    this.refs = (max["r"] as number | null) ?? 0;
  }

  /** Get a task by reference with its notes, log and sources, in one read transaction. */
  taskWithChildren(ref: number): number {
    const s = this.#s;
    return transaction(this.#db, "BEGIN", () => {
      const task = getRow(s.task, ref);
      if (task === undefined) return 0;
      const id = task["id"] as string;
      return 1 + s.notes.all(id).length + s.log.all(id).length + s.sources.all(id).length;
    });
  }

  /** The open-task view: every active task in list order. */
  openView(): number {
    return transaction(this.#db, "BEGIN", () => this.#s.open.all().length);
  }

  /**
   * In one snapshot, space.last_seq must equal the newest commit. False would mean a reader saw a
   * half-applied commit. A space without history has no commits and last_seq is not checked.
   */
  consistent(): boolean {
    const s = this.#s;
    return transaction(this.#db, "BEGIN", () => {
      const max = (getRow(s.maxSeq) as Row)["seq"] as number;
      return max === 0 || max === (getRow(s.lastSeq) as Row)["last_seq"];
    });
  }
}
