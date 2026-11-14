// The projection's side of the outbox (A1 3.7 "Outbox consumers", A1 3.13 steps 5 and 6).
//
// Commits upsert one `projection` row per task they touch, and `*` when the catalogue or an index
// changes: `seq` is the newest commit, `first_seq` the oldest the projection has not rendered. The
// projection renders a batch at a snapshot T, then reports here which keys it rendered:
//
// - a reported row with `seq <= T` is deleted: every commit it stands for is rendered;
// - a reported row that a commit after T upserted again stays, with `first_seq = T + 1`, so the
//   newer commit is never lost (A1 3.7);
// - a row the projection did not report keeps its `first_seq`.
//
// The watermark W (A1 3.13 step 6) is then T when no task row with `first_seq <= T` remains, and
// otherwise the smallest such `first_seq` minus 1: every commit up to W is rendered for every task,
// so W moves only through a fully rendered prefix. It is computed here, in the transaction that
// deleted the rows, so no commit can slip between the two.
//
// These are bookkeeping writes (A1 3.7): they write no commit, no change row and no receipt, and
// they change nothing the space's history or its readers depend on. Every statement is a constant.
import type { Connection } from "../driver.ts";
import { misuse } from "../errors.ts";
import { isId } from "../ids.ts";
import { decodeSpaceRow } from "../rows.ts";

/** The outbox key that stands for the catalogue and the indexes (A1 3.7). */
export const PROJECTION_ALL = "*";

/** A1 3.13: a batch renders at most 200 tasks, and reports them with `*`. */
export const PROJECTION_BATCH = 200;

const SQL = {
  space: "SELECT * FROM space WHERE one = 1",
  done: "DELETE FROM outbox WHERE topic = 'projection' AND key = $key AND seq <= $seq",
  again:
    "UPDATE outbox SET first_seq = $next WHERE topic = 'projection' AND key = $key " +
    "AND first_seq <= $seq",
  backlog:
    "SELECT min(first_seq) AS first FROM outbox WHERE topic = 'projection' AND key <> '*'",
  // `WHERE true` keeps SQLite from reading ON CONFLICT as part of the SELECT's join.
  queueTasks:
    "INSERT INTO outbox (topic, key, first_seq, seq) SELECT 'projection', id, 1, touched " +
    "FROM tasks WHERE true ON CONFLICT (topic, key) DO UPDATE SET first_seq = 1",
  queueAll:
    "INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', '*', 1, $seq) " +
    "ON CONFLICT (topic, key) DO UPDATE SET first_seq = 1",
} as const;

/** What the projection reports after a batch: the snapshot it rendered and the keys it rendered. */
export interface ProjectedBatch {
  /** The batch's snapshot T: `space.last_seq` of its read transaction. */
  readonly seq: number;
  /** Task IDs and `*`, at most PROJECTION_BATCH + 1, each once. */
  readonly keys: readonly string[];
}

/** A batch from another thread, checked at run time. */
function checkBatch(batch: unknown, lastSeq: number): ProjectedBatch {
  const { seq, keys } = (batch ?? {}) as Partial<Record<string, unknown>>;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq > lastSeq) {
    throw misuse("A projected batch names a snapshot of this space");
  }
  if (!Array.isArray(keys) || keys.length > PROJECTION_BATCH + 1) {
    throw misuse("A projected batch names at most 201 keys");
  }
  const seen = new Set<string>();
  for (const key of keys as unknown[]) {
    if (typeof key !== "string" || (key !== PROJECTION_ALL && !isId(key, "t")) || seen.has(key)) {
      throw misuse("A projected batch names task IDs and `*`, each once");
    }
    seen.add(key);
  }
  return { seq, keys: [...seen] };
}

/**
 * Marks the keys of a batch rendered at snapshot `seq` (A1 3.13 step 5) and returns the watermark
 * (step 6). Runs in the caller's IMMEDIATE transaction on the space's writer connection.
 */
export function markProjected(conn: Connection, input: unknown): number {
  if (!conn.inTransaction) throw misuse("The outbox is written inside a write transaction");
  const space = decodeSpaceRow(conn.prepare(SQL.space).get());
  const { seq, keys } = checkBatch(input, space.lastSeq);
  const done = conn.prepare(SQL.done);
  const again = conn.prepare(SQL.again);
  for (const key of keys) {
    done.run({ key, seq });
    again.run({ key, seq, next: seq + 1 });
  }
  const first = conn.prepare(SQL.backlog).get()?.["first"];
  return typeof first === "number" && first <= seq ? first - 1 : seq;
}

/**
 * Queues every task and the catalogue for the projection (A1 3.13 "A full rebuild"): each gets a
 * row whose `first_seq` is 1, so the watermark stays at 0 until every task is rendered again.
 * Returns the tasks queued. Runs in the caller's IMMEDIATE transaction.
 */
export function queueProjection(conn: Connection): number {
  if (!conn.inTransaction) throw misuse("The outbox is written inside a write transaction");
  const space = decodeSpaceRow(conn.prepare(SQL.space).get());
  const queued = conn.prepare(SQL.queueTasks).run().changes;
  // A space without commits has nothing to render, and `first_seq <= seq` needs a commit.
  if (space.lastSeq >= 1) conn.prepare(SQL.queueAll).run({ seq: space.lastSeq });
  return Number(queued);
}
