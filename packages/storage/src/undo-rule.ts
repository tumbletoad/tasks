// Undo's one rule, for today's writer and the tree's alike: which of a person's commits are steps
// on their stack, and which step Undo and Redo take. A commit is a step when it changed something
// and every row it changed is of one of the kinds below; each schema says, kind by kind, how its
// change rows show that kind, so a kind added to one writer cannot be forgotten in the other.

/** The changes a person takes back with Undo. */
export const UNDO_KINDS = [
  /** A check-off, a drop or a reopen, with the wrap-up that comes with it. */
  "finish",
  /** A move to the Trash or out of it, with what comes along with the task. */
  "trash",
  /** A note removed or put back. */
  "note",
  /** Words: a task's title, brief or description, a note's or a page's. */
  "words",
  /** Out of the Inbox or into it, with the status set with it. */
  "inbox",
  /** A task's first filing, or one into a group the person's change right before made. */
  "filing",
  /** A new group or project, and its archive and unarchive. */
  "group",
  /** Questions set aside. */
  "dismissal",
] as const;

export type UndoKind = (typeof UNDO_KINDS)[number];

/** For each kind, an SQL condition on change row `c`: that row is of the kind. */
export type KindRows = Readonly<Record<UndoKind, string>>;

export interface UndoRule {
  /** Whether commit `seq` (an SQL expression) is a step. */
  step: (seq: string) => string;
  /** The step an undo of `$principal` takes, with `applied`: the commit that last applied it. */
  undoTarget: string;
  /** The step a redo of `$principal` takes: the one undone last, answered through its undo. */
  redoTarget: string;
}

export function undoRule(kinds: KindRows): UndoRule {
  const kept = UNDO_KINDS.map((kind) => `(${kinds[kind]})`).join(" OR ");
  const step = (seq: string): string =>
    `(EXISTS (SELECT 1 FROM changes c WHERE c.seq = ${seq}) AND NOT EXISTS (SELECT 1 FROM changes c ` +
    `WHERE c.seq = ${seq} AND NOT coalesce(${kept}, 0)))`;
  // Of the principal's done steps, the one applied last: by its newest redo, else by its own seq.
  const undoTarget =
    "WITH newest AS (SELECT seq, id, undo_status, undone_by, seq AS applied FROM commits k " +
    `WHERE principal_id = $principal AND undo_status = 'done' AND ${step("k.seq")} ` +
    "ORDER BY seq DESC LIMIT 1) " +
    "SELECT * FROM (SELECT t.seq AS seq, t.id AS id, t.undo_status AS undo_status, " +
    "t.undone_by AS undone_by, r.seq AS applied FROM commits r JOIN commits t ON t.seq = r.redo_of " +
    "WHERE r.seq > coalesce((SELECT seq FROM newest), 0) AND r.principal_id = $principal " +
    `AND r.kind = 'redo' AND t.undo_status = 'done' AND ${step("t.seq")} ` +
    "ORDER BY r.seq DESC LIMIT 1) " +
    "UNION ALL SELECT * FROM newest ORDER BY applied DESC LIMIT 1";
  const redoTarget =
    "SELECT seq, id, undo_status, undone_by, undone_by AS applied FROM commits k " +
    `WHERE principal_id = $principal AND undo_status = 'undone' AND ${step("k.seq")} ` +
    "ORDER BY undone_by DESC LIMIT 1";
  return { step, undoTarget, redoTarget };
}

/**
 * Whether change row `c` files into a group the same person's commit right before made: the
 * page's new group, made and then filed into. `into` is an SQL list of the IDs `c` files into, and
 * `group` a condition on the create row `g` that holds only for a group (an area or a project),
 * never for a task made just before.
 */
export const filedIntoNewGroup = (into: string, group: string): string =>
  `EXISTS (SELECT 1 FROM changes g WHERE g.action = 'create' AND (${group}) ` +
  `AND g.entity_id IN (${into}) ` +
  "AND g.seq = (SELECT max(p.seq) FROM commits p JOIN commits me ON me.seq = c.seq " +
  "WHERE p.principal_id = me.principal_id AND p.seq < c.seq))";
