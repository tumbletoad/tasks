// What the Trash holds: the tasks someone removed on purpose. A task's tombstone holds the
// provenance of the commit whose write it is (A1 3.10): a delete, or that same delete again after an
// undo of a restore or a redo of the delete. A creation that was undone holds the undo's own commit
// instead. That task is not in the Trash: Redo brings it back with its notes and links together,
// and a restore of it alone would leave them behind and use up the Redo. The Trash's listing, a
// read of one task and the writer's restore all decide it here.

/** The seq of the commit whose write the tombstone of task row `t` holds; its creation's without one. */
export const removalSeqSql = (t: string): string =>
  `coalesce(json_extract(${t}.fp, '$.deleted'), ${t}.created_seq)`;

/** Whether task row `t` (an alias in the statement) was removed on purpose: 1 or 0. */
export const inTrashSql = (t: string): string =>
  `(${t}.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM commits trash_c WHERE ` +
  `trash_c.seq = ${removalSeqSql(t)} AND trash_c.undo_of IS NOT NULL))`;
