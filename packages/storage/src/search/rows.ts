// Pages by frozen IDs (A1 3.12): `rows_by_ids`. A search cursor freezes an ordered list of task or
// learning IDs at a snapshot, and every later page reads its own slice of that list fresh, in one
// read transaction, with one entry per ID, in order, never fewer:
//
// - `current`: the row as it is now (it may be newer than the cursor's snapshot);
// - `deleted`: a tombstoned task, or a deleted learning or one whose task is tombstoned, with the
//   task's reference and no content;
// - `redacted`: an ID with no row at all, with no content.
//
// A row leaves its table only through entity redaction (A1 3.11.4: nothing else deletes a row), so
// a missing row is a redacted one, and no `redactions` table is needed to say so; once that table
// exists, every ID in it has no row either. The caller runs ROWS_BY_IDS_SQL in the page's read
// transaction, with `$ids` the JSON array of the slice, and decodes the rows here.
import type { Row } from "../driver.ts";
import { StorageError } from "../errors.ts";
import { inRange } from "../rows.ts";

/**
 * When a finished task (`t`) was finished: its completion, or for a dropped task, which keeps no
 * completion time, the commit whose write its lifecycle holds (its provenance, else its create),
 * so an undo that brings a drop back keeps the drop's own time.
 */
export const FINISHED_AT_SQL =
  "COALESCE(t.completed_at, (SELECT c.at FROM commits c WHERE c.seq = " +
  "COALESCE(json_extract(t.fp, '$.lifecycle'), t.created_seq)), t.created_at)";

/** The columns a page shows of a task, with its area and project titles. */
const TASK_COLUMNS =
  "t.id, t.ref, t.title, t.summary, t.lifecycle, t.status, t.inbox, t.priority, t.effort, " +
  "t.due_date, t.due_at, t.due_tz, t.focus_on, t.completed_at, t.outcome, t.archived_reason, " +
  `t.wrap_state, t.touched, t.version, t.deleted_at, CASE WHEN t.lifecycle <> 'active' THEN ` +
  `${FINISHED_AT_SQL} END AS finished_at, a.title AS area_title, p.title AS project_title`;

export const ROWS_BY_IDS_SQL = {
  tasks:
    `SELECT j.key AS i, j.value AS wanted, ${TASK_COLUMNS} FROM json_each($ids) j ` +
    "LEFT JOIN tasks t ON t.id = j.value LEFT JOIN areas a ON a.id = t.area_id " +
    "LEFT JOIN projects p ON p.id = t.project_id ORDER BY j.key",
  learnings:
    "SELECT j.key AS i, j.value AS wanted, l.id AS learning_id, l.body AS learning, " +
    "l.created_at AS learned_at, l.deleted_at AS learning_deleted_at, " +
    `l.version AS learning_version, ${TASK_COLUMNS} FROM json_each($ids) j ` +
    "LEFT JOIN learnings l ON l.id = j.value LEFT JOIN tasks t ON t.id = l.task_id " +
    "LEFT JOIN areas a ON a.id = t.area_id LEFT JOIN projects p ON p.id = t.project_id " +
    "ORDER BY j.key",
} as const;

export type FrozenKind = keyof typeof ROWS_BY_IDS_SQL;

/** One entry of a page read by frozen IDs. */
export type FrozenEntry =
  | { readonly state: "current"; readonly id: string; readonly row: Row }
  | { readonly state: "deleted"; readonly id: string; readonly ref: number }
  | { readonly state: "redacted"; readonly id: string };

/**
 * The entries of `ids`, in order, from the rows ROWS_BY_IDS_SQL returned for them. A result that
 * does not hold exactly one row per ID, in order, is SPACE_INVALID: `json_each` gives one row per
 * element and each join matches at most one row by its key.
 */
export function decodeRowsByIds(
  kind: FrozenKind,
  ids: readonly string[],
  rows: readonly Row[],
): FrozenEntry[] {
  if (rows.length !== ids.length) {
    throw new StorageError("SPACE_INVALID", "A page by frozen IDs lost an entry");
  }
  return ids.map((id, i): FrozenEntry => {
    const row = rows[i];
    if (row === undefined || row["i"] !== i || row["wanted"] !== id) {
      throw new StorageError("SPACE_INVALID", "A page by frozen IDs lost an entry");
    }
    const present = kind === "tasks" ? row["id"] === id : row["learning_id"] === id;
    if (!present || typeof row["id"] !== "string") return { state: "redacted", id };
    const deleted =
      row["deleted_at"] !== null || (kind === "learnings" && row["learning_deleted_at"] !== null);
    if (deleted) {
      const ref = row["ref"];
      if (!inRange(ref, "taskRef")) throw new StorageError("SPACE_INVALID", "A task has no ref");
      return { state: "deleted", id, ref };
    }
    return { state: "current", id, row };
  });
}
