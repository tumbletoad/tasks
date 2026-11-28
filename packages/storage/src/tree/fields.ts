// The tree's logical fields (a field changes as a unit: one change row, one version) and the one
// refusal type its commands throw. Table and column names reach SQL text only from here.

/** Each table's logical fields and their columns. */
export const FIELDS = {
  nodes: {
    title: ["title"],
    brief: ["brief"],
    description: ["description"],
    for_agents: ["for_agents"],
    place: ["parent_id", "position"],
    color: ["color"],
    archived: ["archived_at"],
    deleted: ["deleted_at", "deleted_by"],
  },
  tasks: {
    status: ["status"],
    inbox: ["inbox"],
    priority: ["priority"],
    effort: ["effort"],
    due: ["due_date", "due_at", "due_tz"],
    planned_for: ["planned_for"],
    focus: ["focus_on"],
    waiting_on: ["waiting_on"],
    source_at: ["source_at"],
    reviewed_at: ["reviewed_at"],
    lifecycle: ["lifecycle", "completed_at", "completed_by", "archived_reason"],
    wrap: ["wrap_state", "outcome", "wrapped_at", "wrapped_by"],
  },
  notes: { body: ["body", "edited_at"], deleted: ["deleted_at"] },
  pages: {
    title: ["title"],
    brief: ["brief"],
    body: ["body"],
    owner: ["owner_id"],
    deleted: ["deleted_at", "deleted_by"],
  },
  sources: { owner: ["owner_id"], deleted: ["deleted_at"] },
  links: { removed: ["removed_at"] },
  // A machine is registered once, by a system commit, and no command changes it after.
  machines: {},
  // A folder's path and its removal; a launch's and a run's state, written as a unit with its
  // reason, evidence and times.
  folders: { path: ["path"], deleted: ["deleted_at"] },
  launches: { state: ["state", "reason", "detail", "updated_at"] },
  runs: { state: ["state", "reason", "detail", "result", "started_at", "ended_at"] },
  // A preference's value with the version of its shape, which `pref.set` writes as a unit.
  preferences: { value: ["value", "schema_ver"] },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type Entity = keyof typeof FIELDS;
export type FieldOf<E extends Entity> = keyof (typeof FIELDS)[E] & string;

export const isEntity = (value: string): value is Entity => Object.hasOwn(FIELDS, value);

/** The columns a create may set besides the fields' own. */
export const KEYS: Record<Entity, readonly string[]> = {
  nodes: ["id", "kind", "slug", "created_at", "created_by"],
  tasks: ["id", "ref", "origin_source_id", "created_session"],
  notes: [
    "id",
    "owner_id",
    "ordinal",
    "kind",
    "for_agents",
    "author_id",
    "session_id",
    "run_id",
    "created_at",
  ],
  pages: ["id", "ref", "created_at", "created_by"],
  sources: [
    "id",
    "ref",
    "kind",
    "title",
    "brief",
    "body",
    "who",
    "outside_ref",
    "url",
    "at",
    "source_key",
    "created_at",
    "created_by",
  ],
  links: ["id", "owner_id", "target_id", "position", "added_by"],
  preferences: ["key", "policy"],
  machines: ["id", "name", "os", "first_seen"],
  folders: ["id", "owner_id", "machine_id", "is_default", "label", "created_at"],
  launches: [
    "id",
    "reference",
    "task_id",
    "session_id",
    "instance_id",
    "machine_id",
    "route",
    "folder_id",
    "task_version",
    "brief_hash",
    "created_at",
  ],
  runs: [
    "id",
    "task_id",
    "session_id",
    "instance_id",
    "machine_id",
    "adapter",
    "folder_id",
    "request",
    "spec",
    "attempt",
    "queued_at",
  ],
};

/** The column that names a row: its `id`, or a preference's `key`. */
export const keyOf = (entity: Entity): string => (entity === "preferences" ? "key" : "id");

/** A field's columns. */
export function columnsOf(entity: Entity, field: string): readonly string[] {
  const columns = (FIELDS[entity] as Record<string, readonly string[]>)[field];
  if (columns === undefined) throw new Error("Not a field of that table");
  return columns;
}

/** A refusal the core or a command decides: nothing of the request is written. */
export class TreeProblem extends Error {
  readonly code: string;
  readonly field: string | undefined;
  readonly data: unknown;
  constructor(code: string, message: string, field?: string, data?: unknown) {
    super(message);
    this.code = code;
    this.field = field;
    this.data = data;
  }
}
