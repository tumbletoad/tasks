// Schema revisions and the facts about the current schema that code and the schema lint share.
//
// A schema revision `major.minor` (A1 3.17) is stored in PRAGMA user_version, which is a 32-bit
// integer, as major × 1000 + minor: 0.1 is 1, 0.2 is 2 and 1.0 would be 1000. A fresh SQLite
// database reads 0, which is no revision: a file that never finished its create. The steps that
// produce each revision live in migrations/NNNN-*.ts (A1 3.17).
import type { Connection } from "./driver.ts";
import type { SpaceFormat } from "./rows.ts";

/**
 * PRAGMA application_id of every space database (A1 3.4). Chosen at random, and not derived from
 * the placeholder product name, so a rename keeps every existing space readable.
 */
export const APP_ID = 0x7a3c91e5;

/** A schema revision, `major.minor`. */
export interface Revision {
  major: number;
  minor: number;
}

const MINOR_LIMIT = 1000;

/** The user_version that stores a revision. */
export function encodeRevision({ major, minor }: Revision): number {
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < 0 ||
    minor < 0 ||
    minor >= MINOR_LIMIT ||
    major > 2_000_000
  ) {
    throw new RangeError("A revision is major.minor with a minor below 1000");
  }
  return major * MINOR_LIMIT + minor;
}

/** The revision a user_version stores, or undefined for 0 and for values no revision has. */
export function decodeRevision(userVersion: unknown): Revision | undefined {
  if (typeof userVersion !== "number" || !Number.isSafeInteger(userVersion) || userVersion < 1) {
    return undefined;
  }
  if (userVersion > 2_000_000_999) return undefined;
  return { major: Math.floor(userVersion / MINOR_LIMIT), minor: userVersion % MINOR_LIMIT };
}

export const formatRevision = ({ major, minor }: Revision): string =>
  `${String(major)}.${String(minor)}`;

/**
 * One migration step (A1 3.17): `{ id, from, kind, format, up, verify, undoFloor, reviewPrompt? }`,
 * plus the revision it produces, the app versions that may read and write that revision (copied
 * into space.json) and the tables the schema holds after it. Creating a space runs every step from
 * an empty database (`from: 0`) in one transaction. M1.06's runner runs the steps after a space's
 * revision, behind the verified barrier backup, and writes one system commit per step.
 */
export interface SchemaStep {
  /** NNNN in the file name. */
  id: number;
  /** The user_version this step starts from. 0 is an empty database. */
  from: number;
  /** The revision this step produces. */
  revision: Revision;
  kind: "additive" | "breaking";
  /** The space format after this step (space row and space.json). */
  format: SpaceFormat;
  /** The oldest app version that can read, and that can write, this revision (A1 3.17). */
  minReader: string;
  minWriter: string;
  /** Whether the step raises undo_floor_seq, so older commits can no longer be undone. */
  undoFloor: boolean;
  /** Every table of the schema after this step, by name. */
  tables: readonly string[];
  /** The schema change, inside the caller's write transaction. */
  up(conn: Connection): void;
  /** Throws when the schema after `up` is not what the step promises. */
  verify(conn: Connection): void;
  /** For a step that needs judgement: the prompt an agent follows afterwards (A1 3.17). */
  reviewPrompt?: string;
}

// ---------------------------------------------------------------------------------------------
// Facts about the current schema. The schema lint checks each one against a freshly created
// database, so these lists cannot drift from the SQL.

/** Words no column name may contain (A1 3.4, R10, A6 L4), between underscores or alone. */
export const FORBIDDEN_COLUMN_WORDS = [
  "command",
  "argv",
  "args",
  "exec",
  "executable",
  "env",
  "shell",
  "token",
  "secret",
] as const;

/**
 * Closed enumerations: sets A1 fixes and code branches on. Each column has a CHECK with exactly
 * these values. Integer flags count as enumerations.
 */
export const CLOSED_ENUMS: Readonly<
  Record<string, Readonly<Record<string, readonly (string | number)[]>>>
> = {
  actors: { kind: ["human", "agent", "routine", "system", "import"] },
  machines: { os: ["linux", "windows", "macos"] },
  areas: { lifecycle: ["active", "archived"] },
  projects: { lifecycle: ["active", "completed", "archived"] },
  tasks: {
    lifecycle: ["active", "completed", "archived"],
    inbox: [0, 1],
    wrap_state: ["pending", "wrapped"],
  },
  notes: { addressee: ["self", "agents"], audience: ["all", "owner", "members"] },
  log_entries: { kind: ["progress", "evidence", "blocker", "decision", "question", "handoff"] },
  task_sources: { role: ["origin", "related", "evidence"] },
  places: { owner_kind: ["task", "project", "area"], kind: ["folder", "file"] },
  preferences: { policy: [0, 1] },
  commits: {
    actor_kind: ["human", "agent", "routine", "system", "import"],
    origin: ["ui", "cli", "mcp", "http", "import", "system", "migration"],
    undo_status: ["done", "undone", "dead"],
    compacted: [0, 1],
  },
  changes: { action: ["create", "set"] },
  receipts: { status: ["applied", "proposed", "unchanged", "conflict", "rejected"] },
  // A4 3.9.1's states. A4 owns them and the edges between them (launches.ts: LAUNCH_EDGES).
  launches: {
    state: ["prepared", "dispatching", "dispatched", "confirmed", "failed", "unknown"],
  },
  // Schema 0.2 (M3.01): A1 3.4's proposal origins and states, and A1 3.14's exchange states.
  proposals: {
    origin: ["autonomy", "import_conflict", "burst_brake", "migration_review"],
    state: ["pending", "accepted", "rejected", "superseded"],
  },
  exchanges: { state: ["open", "applied", "abandoned"] },
  // Schema 0.3 (M6.01): A4 3.10's session kinds and states.
  sessions: {
    kind: ["interactive", "run"],
    state: ["opening", "live", "ended", "unknown"],
    bound: [0, 1],
  },
  // Schema 0.4: the search index's document kinds (search/tables.ts SEARCH_DOC_KINDS).
  search_docs: { kind: ["task", "note", "log", "learning", "project", "area"] },
  // Schema 0.5: a folder belongs to a project or a task.
  folders: { owner_kind: ["project", "task"] },
};

/**
 * Open sets: values other appendices extend (A1 3.4, 3.7). The writer validates them against these
 * lists. They have no CHECK, because changing a CHECK means rebuilding the table, and `commits` and
 * `changes` are the largest tables. `changes.entity` is the name of a table with history (every
 * table with `created_seq`), and grows with each such table, and of the two tables whose rows have
 * no versions but change only through change rows too (`VERSIONLESS_TABLES`: an alias and an
 * exchange's item, A1 3.4). `aliases.entity_kind` is what an alias
 * names: a legacy task ID, an old slug of an area, project or label, or an old reference prefix
 * of the space (A1 3.3). `tasks.status` and `tasks.effort` are neither: they hold keys of the
 * space's preferences `tasks.statuses` and `tasks.effort_scale` (A1 3.16), which the writer checks.
 */
export const OPEN_SETS = {
  "sources.kind": [
    "email",
    "chat",
    "ticket",
    "pr",
    "issue",
    "doc",
    "calendar",
    "crash",
    "session",
    "book",
    "web",
    "other",
  ],
  "commits.kind": [
    "ops",
    "undo",
    "redo",
    "revert",
    "revert_session",
    "proposal",
    "migration",
    "redact",
  ],
  "aliases.namespace": ["planning", "slug", "ref_prefix"],
  "aliases.entity_kind": ["task", "area", "project", "label", "space"],
  "changes.entity": [
    "machines",
    "areas",
    "projects",
    "tasks",
    "notes",
    "log_entries",
    "sources",
    "task_sources",
    "places",
    "preferences",
    "launches",
    // Schema 0.2 (M3.01).
    "labels",
    "task_labels",
    "learnings",
    "attachments",
    "proposals",
    "exchanges",
    // Rows without versions, written with their create change rows (VERSIONLESS_TABLES, M7.05).
    "aliases",
    "exchange_items",
    // Schema 0.3 (M6.01).
    "sessions",
    "runs",
    // Schema 0.5.
    "folders",
  ],
  "outbox.topic": ["projection", "redact"],
  // A4 3.1's routes. Later targets may add one (remote launches, A1 3.4's open-set rule).
  "launches.route": ["terminal", "link", "t3-mcp", "t3-cli", "clipboard"],
  // A4 3.11.1's run adapters, and A4 3.11.2's run states: A1 3.4 gives `runs.state` no CHECK, so
  // a later adapter's state needs no table rebuild (packages/contracts: RUN_ADAPTERS, RUN_STATES).
  "runs.adapter": ["claude-print", "codex-exec"],
  "runs.state": [
    "queued",
    "starting",
    "running",
    "waiting_for_input",
    "cancelling",
    "reconciling",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "unknown",
  ],
  // A4 3.10's native ID sources and end reasons, which M4.06's session operations write.
  "sessions.native_id_source": ["preset", "returned", "bridge", "reference-match"],
  "sessions.end_reason": ["exit", "error", "terminal-closed", "lost", "stale"],
} as const;

/** The JSON columns of each table. Each one is TEXT with a json_valid CHECK (A1 3.4). */
export const JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  space: ["lineage", "transfer", "hold"],
  machines: ["fv", "fp"],
  areas: ["fv", "fp", "ext"],
  projects: ["defaults", "fv", "fp", "ext"],
  tasks: ["fv", "fp", "ext"],
  notes: ["fv", "fp"],
  log_entries: ["fv", "fp"],
  sources: ["fv", "fp", "ext"],
  task_sources: ["fv", "fp"],
  places: ["identity", "fv", "fp"],
  preferences: ["value", "fv", "fp"],
  commits: ["ops"],
  receipts: ["result"],
  changes: ["before", "after"],
  launches: ["detail", "fv", "fp"],
  labels: ["fv", "fp"],
  task_labels: ["fv", "fp"],
  learnings: ["fv", "fp"],
  attachments: ["fv", "fp"],
  proposals: ["ops", "alternatives", "fv", "fp"],
  exchanges: ["fv", "fp"],
  exchange_items: ["base"],
  sessions: ["detail", "fv", "fp"],
  runs: ["spec", "detail", "result", "fv", "fp"],
  folders: ["fv", "fp"],
};

/**
 * The tables stored WITHOUT ROWID. The rule (A1 3.4): a table is WITHOUT
 * ROWID when its primary key is not a single INTEGER column and every row is small and bounded,
 * with no free text, no JSON beyond a one-key version map and no history value. Rows over about a
 * quarter of a page spill to overflow pages in an index b-tree, so every other table keeps a rowid.
 */
export const WITHOUT_ROWID_TABLES = ["aliases", "outbox", "task_labels", "task_sources"] as const;

/**
 * The tables whose rows have no `created_seq`, `version`, `fv` or `fp` and still change only
 * through change rows (A1 3.4): a legacy ID's alias and an exchange's item, each written once with
 * what it belongs to; an alias's move is a `set` row. Undo never inverts them.
 */
export const VERSIONLESS_TABLES = ["aliases", "exchange_items"] as const;
