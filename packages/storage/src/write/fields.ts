// A task's logical fields (A1 3.4): each maps to one or more columns and changes as a unit. Field
// versions (`fv`), provenance (`fp`), bases, conflicts and change rows are all per logical field.
// The column names here are the only ones the write path puts into SQL text, so no input can reach
// a statement's text.

/** Every logical field of a task row, with its columns in a fixed order. */
export const TASK_FIELDS = {
  title: ["title"],
  summary: ["summary"],
  context: ["context"],
  status: ["status"],
  inbox: ["inbox"],
  priority: ["priority"],
  effort: ["effort"],
  planned_for: ["planned_for"],
  focus: ["focus_on"],
  owner: ["owner"],
  waiting_on: ["waiting_on"],
  source_at: ["source_at"],
  reviewed_at: ["reviewed_at"],
  due: ["due_date", "due_at", "due_tz"],
  grouping: ["area_id", "project_id", "position"],
  lifecycle: ["lifecycle", "completed_at", "completed_by", "archived_reason"],
  wrap: ["wrap_state", "outcome", "wrapped_at", "wrapped_by"],
  deleted: ["deleted_at", "deleted_by"],
} as const satisfies Record<string, readonly string[]>;

export type TaskField = keyof typeof TASK_FIELDS;

/** The fields `task.patch` sets and unsets. Lifecycle, wrap and grouping are not patchable. */
export const PATCHABLE_FIELDS = [
  "title",
  "summary",
  "context",
  "status",
  "inbox",
  "priority",
  "effort",
  "planned_for",
  "focus",
  "owner",
  "waiting_on",
  "source_at",
  "reviewed_at",
  "due",
] as const satisfies readonly TaskField[];

export type PatchableField = (typeof PATCHABLE_FIELDS)[number];

/**
 * The logical fields of the rows other than tasks that an operation of this build changes after
 * their create (A1 3.4): a link's one field `removed` (a revival clears it), a place's folder,
 * which `place.set` binds as a unit, and a launch's `state`, which `launch.transition` writes as a
 * unit with its reason, its evidence and the time (A4 3.9), a learning's tombstone, which a
 * wrap-up sets when it removes the learning (A1 3.11.2), and a preference's `value` (A1 3.16,
 * `pref.set`). Later steps add the fields their
 * operations change (`note.patch`, `source.patch`, the deletes).
 */
export const CHILD_FIELDS = {
  task_sources: { removed: ["removed_at"] },
  places: { folder: ["root_id", "rel_path", "kind", "identity"], deleted: ["deleted_at"] },
  launches: { state: ["state", "reason", "detail", "updated_at"] },
  learnings: { deleted: ["deleted_at"] },
  // A preference's value with the version of its shape, which `pref.set` writes as a unit.
  preferences: { value: ["value", "schema_ver"] },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type ChildEntity = keyof typeof CHILD_FIELDS;

/** Columns a create change leaves out of its row: each follows from the change's seq. */
export const DERIVED_COLUMNS = ["created_seq", "version", "touched", "fv", "fp"] as const;

/** A value of the given columns: the column's value for one, else an object in their order. */
export function columnsValue(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): unknown {
  if (columns.length === 1) return row[columns[0] ?? ""] ?? null;
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}

/**
 * A logical field's value as `changes.before` and `changes.after` hold it: the column's value for
 * a one-column field, else an object of its columns in their fixed order. Integer flags stay
 * integers, so a replica writes the value back without business logic (A1 3.4).
 */
export function fieldValue(row: Readonly<Record<string, unknown>>, field: TaskField): unknown {
  return columnsValue(row, TASK_FIELDS[field]);
}

/** The one spelling of a field value, for equality and storage. */
export const fieldJson = (value: unknown): string => JSON.stringify(value);
