// What the Trash holds: the tasks someone removed on purpose. A task's tombstone holds the
// provenance of the commit whose write it is (A1 3.10). A creation an earlier version undid holds
// the undo of the very commit that created the task: that task is not in the Trash, as it was not
// when it was undone. Undo of a restore writes its tombstone as an ordinary removal, so only the
// undo of the creating commit counts. The Trash's listing, a read of one task and the writer's
// restore all decide it here.

/** The seq of the commit whose write the tombstone of task row `t` holds; its creation's without one. */
export const removalSeqSql = (t: string): string =>
  `coalesce(json_extract(${t}.fp, '$.deleted'), ${t}.created_seq)`;

/** Whether task row `t` (an alias in the statement) was removed on purpose: 1 or 0. */
export const inTrashSql = (t: string): string =>
  `(${t}.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commits trash_c WHERE ` +
  `trash_c.seq = ${removalSeqSql(t)} AND trash_c.undo_of = ${t}.created_seq))`;

/**
 * How many tasks hold each effort size, by state: live ones and those in the Trash. One whose
 * creation was undone holds nothing.
 */
export const EFFORT_HOLDERS_SQL =
  "SELECT effort, sum(deleted_at IS NULL AND lifecycle = 'active') AS active, " +
  "sum(deleted_at IS NULL AND lifecycle <> 'active') AS finished, " +
  "sum(deleted_at IS NOT NULL) AS trash FROM tasks t " +
  `WHERE effort IS NOT NULL AND (deleted_at IS NULL OR ${inTrashSql("t")}) GROUP BY effort`;
