// What the writer accepts and returns (A1 3.5 to 3.7, 3.21). A request names its A1
// operations, the credential fields A2 takes from the connection, an optional base and a reason.
// These are the writer's internal interface, behind the registry entries of packages/contracts:
// a handler expands an entry's input into these operations (A3 3.2.1), and the service sends them
// to the space's writer worker. Everything here is checked before the writer's transaction starts,
// because a request crosses a thread boundary as plain data.
//
// Text is normalised as A1 3.7 asks (NFC, LF line endings, NUL and the other C0 controls except tab
// and newline removed) before any limit is checked, so the limit holds for the stored text. The
// registry's SafeText (A3 3.10) normalises more at the boundary, and normalising again is harmless.
import {
  fitsShape,
  PREFERENCE_KEY,
  PREFERENCE_KEY_MAX,
  PREFERENCE_VALUE_BYTES,
  preferenceSpec,
  readPreference,
  type PrefValue,
} from "@tasks/contracts/preferences";
import { isId, type Id } from "../ids.ts";
import { inRange, RANGES } from "../rows.ts";
import { OPEN_SETS } from "../schema.ts";
import { canonicalJson, isJsonData } from "./canonical.ts";
import { PATCHABLE_FIELDS, type PatchableField } from "./fields.ts";
import { isFolderForm } from "./folders.ts";
import {
  RUN_APP_TOOLS,
  RUN_CLEANUPS,
  RUN_EVIDENCE_FIELDS,
  RUN_EVIDENCE_ID,
  RUN_LIMIT_BOUNDS,
  RUN_OUTCOMES,
  RUN_PERMISSIONS,
  RUN_REQUEST_MAX_BYTES,
  RUN_RESULT_TEXT_MAX_BYTES,
  RUN_STATES,
  RUN_TEXT_MAX_BYTES,
  RUN_USAGE_KEYS,
  type RunEvidence,
  type RunLimitsRow,
  type RunResultRow,
  type RunState,
} from "./runs.ts";

// ---------------------------------------------------------------------------------------------
// Limits (A1 3.7)

export const WRITE_LIMITS = {
  /**
   * Operations per request: one transaction holds the space's writer, and its receipt keeps a
   * result per operation. The largest call an entry takes fits: 25 task drafts, each with its log
   * entry, 10 sources, a folder and a new area and project (375).
   */
  ops: 400,
  /**
   * Bytes of JSON per request: twice the longest line a connection carries (8 MiB), because the
   * intent and its operations each hold the input's text, so no call a connection carried and its
   * entry accepted is refused for its size. A run's answer (RUN_RESULT_TEXT_MAX_BYTES), up to six
   * times longer as escaped JSON, fits too.
   */
  requestBytes: 16 * 1024 * 1024,
  /** Characters. */
  title: 300,
  summary: 400,
  /** UTF-8 bytes. */
  context: 64 * 1024,
  outcome: 4 * 1024,
  /** Characters of a free one-line field A1 does not limit (owner, waiting on), and of a reason. */
  line: 300,
  reason: 1_000,
  /** Characters of a status or effort key and of a writer scope. */
  key: 40,
  scope: 200,
  /** UTF-8 bytes of a note's and a log entry's body. */
  note: 64 * 1024,
  log: 16 * 1024,
  /** Characters of a source's title and URL, and of a source key (A1 3.6). */
  sourceTitle: 300,
  url: 2_048,
  sourceKey: 512,
  /** Characters of a place's relative path (A1 3.15). */
  path: 1_024,
  /** UTF-8 bytes of a learning, and the live learnings a task holds (A1 3.7, 3.11.2). */
  learning: 1_024,
  learnings: 20,
  /** Characters of a slug of an area or a project. */
  slug: 64,
  /** UTF-8 bytes of an area's or a project's brief. */
  brief: 4 * 1024,
  /** Characters of a folder's path, as the machine spells it. */
  folder: 4_096,
} as const;

// ---------------------------------------------------------------------------------------------
// Errors and results

/**
 * The write path's error codes (A1 3.7). M1.05 maps them to the registry's error codes. A problem
 * names the operation and the field, never a value: it can reach a log through the service.
 */
export const WRITE_ERROR_CODES = [
  "VALIDATION_FAILED",
  "TOO_LARGE",
  "NOT_FOUND",
  "DELETED",
  "SPACE_MISMATCH",
  "VERSION_CONFLICT",
  "BASE_REQUIRED",
  "BASE_FROM_FUTURE",
  "EPOCH_CHANGED",
  "INVALID_TRANSITION",
  "TASK_NOT_ACTIVE",
  "REQUEST_ID_REUSED",
  "REQUEST_ID_INVALID",
  "SPACE_READ_ONLY",
  // Undo and redo (A1 3.10.1, 3.10.4).
  "UNDO_CONFLICT",
  "NOTHING_TO_UNDO",
  "NOTHING_TO_REDO",
  "UNDO_BEFORE_FLOOR",
  /** A preference whose declaration does not list the actor as a writer (A1 3.16, A3 3.8.3). */
  "PREFERENCE_FORBIDDEN",
  /** Another live project holds this folder on this machine. */
  "FOLDER_TAKEN",
] as const;

export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[number];

export interface WriteProblem {
  code: WriteErrorCode;
  /** The index of the operation, when one operation caused it. */
  op?: number;
  /** The input path or logical field, such as `set.title` or `base`. */
  field?: string;
  /** One fixed sentence. It never quotes a value. */
  message: string;
  /** REQUEST_ID_REUSED: when the request that holds the ID was decided (A3 3.5). */
  at?: number;
  /**
   * SPACE_READ_ONLY: why the space takes no write, a word A3 3.5's `read_only` passes on:
   * `not_authority` (A2 3.1) now, `held` and `transfer_pending` with their steps (A1 3.6, 3.18).
   */
  reason?: string;
}

/** A1 3.5: an `as_of` is the triple (epoch, incarnation, last_seq) of one read. */
export interface AsOf {
  epoch: number;
  incarnation: Id<"ai">;
  seq: number;
}

/**
 * The tables whose existing rows a request can change, and so conflict on: a wrap-up's removal of
 * a learning and a preference's value among them. Undo and redo also name the child rows that
 * block a create's inversion (A1 3.10): notes, log entries, sources, learnings, attachments, label
 * links and runs.
 */
export type ConflictEntity =
  | "tasks"
  | "task_sources"
  | "places"
  | "notes"
  | "log_entries"
  | "sources"
  | "learnings"
  | "attachments"
  | "task_labels"
  | "preferences"
  | "runs"
  | "areas"
  | "projects"
  | "folders";

/**
 * One field that changed after the caller's base, or the link version the caller named (A1 3.5).
 * A revival without a link version or a base lists the removed link here too, with who removed it.
 * An undo or redo lists each field whose provenance is not the one its inversion needs (A1 3.10.1:
 * the value the commit wrote, the value now, who changed it and when), and a live child row of
 * another actor that keeps a create from being undone, as its tombstone field.
 */
export interface FieldConflict {
  op: number;
  /** The row: its table and its `changes.entity_id`, `task_id|source_id` for a link. */
  entity: ConflictEntity;
  id: string;
  /** The task the row is or belongs to, with its reference. A group's place has none. */
  task?: Id<"t">;
  ref?: string;
  field: string;
  /**
   * The field's current value, as `changes.after` holds it. It is in the reply only: a receipt
   * stores the conflict without it, so a replay never passes off an old read as current.
   */
  value?: unknown;
  /**
   * Undo and redo: the value the inverted change wrote, and the value the inversion would have
   * set back (what "Restore mine" applies, A5 3.12). In the reply only, like `value`: a receipt
   * holds no task text.
   */
  wrote?: unknown;
  restore?: unknown;
  /** Its physical version: the commit that last wrote it. */
  version: number;
  /**
   * Who wrote that commit's content, and when, with the commit's origin: text the user applied
   * through an import is labelled as an import, not as the user (A3 3.10). A receipt stored before
   * the origin was recorded has none.
   */
  by: { actor: Id<"ac">; kind: string; label: string; origin?: string };
  at: number;
}

export interface OpResult {
  i: number;
  /**
   * `existing`: a `task.create` whose draft matched a task by source key (A1 3.6), or a later
   * operation of that draft left out by the rebinding rules. It names the matched task.
   */
  status: "created" | "updated" | "unchanged" | "existing";
  /** The row the operation acts on: a task, a note, a log entry, a source or a place. */
  id: string;
  /** The task the operation acts on or under, with its reference such as `M-14`. */
  task?: Id<"t">;
  ref?: string;
  /** A note's or log entry's reference within its task, such as `n2` (A1 3.3). */
  entry?: string;
  /** The row's version after the request: for `source.add`, the link's version. */
  version: number;
  /** `source.add` on an existing source: the fields the input gives otherwise (A1 3.6). */
  differs?: string[];
  /**
   * `source.add` of a new draft whose key another active task holds: that task's reference. The
   * source was linked without the key (Dedupe.decide).
   */
  held_by?: string;
  /** A matched `task.create`: how it matched, and the matched task's lifecycle (A1 3.6). */
  matched_by?: "source_key";
  lifecycle?: TaskLifecycle;
  /**
   * A `task.create` whose keys several active tasks hold: their references, lowest first. The
   * result's task is the first of them, so the result keeps one shape; the caller picks one.
   */
  ambiguous?: string[];
}

/** A task's lifecycle (A1 3.11). */
export type TaskLifecycle = "active" | "completed" | "archived";

export type WriteStatus = "applied" | "unchanged" | "conflict" | "rejected";

export interface WriteResult {
  status: WriteStatus;
  /** The as_of after the request: the new commit for `applied`, the state it was judged on else. */
  as_of: string;
  epoch: number;
  incarnation: Id<"ai">;
  seq: number;
  /** The commit's `op_` ID, for `applied`. */
  commit?: Id<"op">;
  /**
   * For an undo or redo refused with UNDO_CONFLICT: the commit it met, so a caller that named none
   * (Ctrl+Z) can name it in what it does next (A1 3.10.1).
   */
  target?: Id<"op">;
  /** One per operation, for `applied` and `unchanged`. */
  results: OpResult[];
  /**
   * Every conflict of the request together, for `conflict`. For an `applied` partial undo, the
   * fields it left as others set them (A1 3.10.1).
   */
  conflicts: FieldConflict[];
  /** Why, for `rejected` and `conflict`. */
  error?: WriteProblem;
  warnings: string[];
  /** A retry with the same intent got the stored result of the first decision (A1 3.8). */
  replayed?: true;
}

// ---------------------------------------------------------------------------------------------
// The request

export const ACTOR_KINDS = ["human", "agent", "routine", "system", "import"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export const ORIGINS = ["ui", "cli", "mcp", "http", "import", "system", "migration"] as const;
export type Origin = (typeof ORIGINS)[number];

/** The credential fields A2 takes from the connection (A1 3.21). */
export interface Credential {
  /** The writer scope (A3 3.7.9): receipts, rate limits and audit are keyed by it. */
  scope_id: string;
  /**
   * The scope this connection wrote under before it bound (A3 3.7.9). The receipt lookup tries it
   * after `scope_id`, so a retry after binding finds the first result. New receipts go under
   * `scope_id`.
   */
  earlier_scope_id?: string;
  principal_id: Id<"ac">;
  actor_kind: ActorKind;
  /** Who wrote the content. Default: the principal. */
  author_id?: Id<"ac">;
  /** The machine the request came from. */
  machine_id: Id<"m">;
  session_id?: Id<"se">;
  run_id?: Id<"ru">;
  origin: Origin;
}

/** A base: the `as_of` of a read, with the full incarnation ID or its 8-character tag. */
export interface Base {
  epoch: number;
  /** An `ai_` ID, or the tag of the wire form. */
  incarnation: string;
  seq: number;
}

export type Due = { date: string } | { at: number; tz: string };

/** The fields a task can be created with and `task.patch` can set. */
export interface TaskValues {
  title?: string;
  summary?: string;
  context?: string;
  status?: string;
  inbox?: boolean;
  priority?: number;
  effort?: string | null;
  planned_for?: string | null;
  focus?: string | null;
  owner?: string | null;
  waiting_on?: string | null;
  source_at?: number | null;
  reviewed_at?: number | null;
  due?: Due | null;
}

/** Where a task goes: a group and, optionally, a sibling to stand next to. */
export interface Placement {
  /** An area ID or slug. `null`: no area. */
  area?: string | null;
  /** A project ID or slug. The task's area follows the project's. `null`: no project. */
  project?: string | null;
  /** A sibling task: the new position is right after it, or right before it. */
  after?: string;
  before?: string;
}

/**
 * How a `task.create` deduplicates by the source keys of its draft (A1 3.6, R4): the keys of the
 * `source.add` operations of the request that name the draft's ID.
 * - `source_key` (the default): an active task that holds a key is returned (`existing`), else a
 *   task finished within the window, else the task is created.
 * - `new`: a new task whatever the keys match (A3's `create_new`). A key an active task holds is
 *   linked to the new task without the key, so it keeps its one active holder.
 */
export const DEDUPE_MODES = ["source_key", "new"] as const;
export type DedupeMode = (typeof DEDUPE_MODES)[number];

/** Days a finished task still matches a draft's key: `tasks.dedupe_window_days`'s default. */
export const DEDUPE_WINDOW_DAYS = readPreference("tasks.dedupe_window_days", undefined)
  .value as number;

export interface TaskCreate extends TaskValues, Placement {
  kind: "task.create";
  /** A client-supplied ID (A1 3.3). Later operations of the request may name it. */
  id?: Id<"t">;
  title: string;
  /** Default `source_key` (DEDUPE_MODES). Only a draft with a client ID has sources to match. */
  dedupe?: DedupeMode;
  /**
   * On one active match, link the draft's sources to the matched task (A3's `add_sources`).
   * Without it a matched draft takes only its entries there (A1 3.6). Only with `source_key`.
   */
  link_sources?: boolean;
  /**
   * The creation instant of work that existed before it was added here, such as an agent's from
   * the tool it recreates. Absent: the commit's instant.
   */
  created_at?: number;
}

export interface TaskPatch {
  kind: "task.patch";
  /** A task ID, a reference such as `M-14`, or a legacy alias. */
  task: string;
  set?: TaskValues;
  unset?: PatchableField[];
}

/**
 * `task.context_append` (A1 3.6): an atomic append inside the writer. The new context is the
 * current one, a blank line and the text (the text alone when the context is empty), at most
 * A1's 64 KiB in all. A base-free insert (A1 3.5): it needs no base and two appends both land,
 * but it writes the `context` field, so a stale replace conflicts with it.
 */
export interface TaskContextAppend {
  kind: "task.context_append";
  task: string;
  text: string;
}

export interface TaskMove extends Placement {
  kind: "task.move";
  task: string;
}

export interface TaskComplete {
  kind: "task.complete";
  task: string;
  outcome?: string;
  /**
   * A task that is completed or archived already is left as it is (`unchanged`), instead of
   * INVALID_TRANSITION: complete_task's way to finish a task whatever the user did first (A3 3.4.8).
   */
  if_active?: boolean;
  /** `completed_at` of work done before it was recorded here. Absent: the commit's instant. */
  at?: number;
}

export interface TaskReopen {
  kind: "task.reopen";
  task: string;
  reason?: string;
}

/** `task.archive` (A1 3.11.3): active → archived, for work that will not be done. */
export interface TaskArchive {
  kind: "task.archive";
  task: string;
  reason?: string;
  /** As for `task.complete`: a finished task is left as it is. */
  if_active?: boolean;
}

/**
 * `task.wrap_up` (A1 3.11.2): additive. It writes the outcome, adds and removes learning rows and
 * marks a completed or archived task wrapped; with `clear_planning` it also clears `focus_on` and
 * `planned_for`. It never changes context, notes, log entries, sources or places.
 */
export interface TaskWrapUp {
  kind: "task.wrap_up";
  task: string;
  outcome?: string;
  learnings?: {
    /** Texts of new learnings. One the task holds already is left as it is. */
    add?: string[];
    /** IDs of the task's learnings to remove: each is tombstoned, its text stays in history. */
    remove?: Id<"lr">[];
  };
  clear_planning?: boolean;
  /**
   * complete_task's rule (A3 3.4.8): a task the request finds wrapped already is left as it is
   * when this operation would change nothing, and is a conflict on its `wrap` field otherwise,
   * whatever the base. Without it a later wrap-up rewrites the outcome, with a base.
   */
  once?: boolean;
}

/** `task.delete` (A1 3.11.4): sets the tombstone. Nothing is removed, and `task.restore` undoes it. */
export interface TaskDelete {
  kind: "task.delete";
  task: string;
}

/** `task.restore` (A1 3.11.4): clears the tombstone of a deleted task. */
export interface TaskRestore {
  kind: "task.restore";
  task: string;
}

/** Who a note is for (A1 3.4): the user, or the user's agents. */
export const ADDRESSEES = ["self", "agents"] as const;
export type Addressee = (typeof ADDRESSEES)[number];

/** A1 3.4's log kinds. */
export const LOG_KINDS = [
  "progress",
  "evidence",
  "blocker",
  "decision",
  "question",
  "handoff",
] as const;
export type LogKind = (typeof LOG_KINDS)[number];

/** A1 3.4's source kinds, an open set that the writer checks (A1 3.4). */
export const SOURCE_KINDS = OPEN_SETS["sources.kind"];
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What a source is to a task (A1 3.4). */
export const LINK_ROLES = ["origin", "related", "evidence"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const PLACE_KINDS = ["folder", "file"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** `note.add` (A1 3.6): a new note on a task, with the task's next ordinal. */
export interface NoteAdd {
  kind: "note.add";
  task: string;
  body: string;
  /** Default `self`. */
  addressee?: Addressee;
}

/** `log.add` (A1 3.6): a new log entry. Its session and run come from the credential. */
export interface LogAdd {
  kind: "log.add";
  task: string;
  body: string;
  /** Default `progress`. */
  log_kind?: LogKind;
  /** The instant of an entry made before it was added here. Absent: the commit's instant. */
  at?: number;
}

/** A source's own fields (A1 3.4). `key` is `<namespace>:<id>` (A1 3.6). */
export interface SourceFields {
  kind: SourceKind;
  title: string;
  key?: string;
  who?: string;
  ref?: string;
  url?: string;
  /** When it was sent, in milliseconds. */
  at?: number;
}

/**
 * `source.add` (A1 3.6): finds the source by its key or creates it, then links it to the task. A
 * live link is unchanged. A removed link is revived, which needs the link's version or a base.
 */
export interface SourceAdd {
  kind: "source.add";
  task: string;
  source: SourceFields;
  /** Default `origin`. */
  role?: LinkRole;
  /** The link's version, for a revival (A1 3.5). */
  link_version?: number;
}

/**
 * `place.set` (A1 3.6, 3.15): binds the owner's folder on the request's machine, as a root ID and
 * a relative path. The owner is one task, project or area. Changing an existing place needs a
 * base. A2's handler turns an absolute path into these and reads the Git remote (M2.07).
 */
export interface PlaceSet {
  kind: "place.set";
  task?: string;
  project?: string;
  area?: string;
  root: string;
  /** `/`-separated, relative. `""` is the root itself. */
  path: string;
  /** Default `folder`. */
  place_kind?: PlaceKind;
  /** The repository's remote at bind time, stored in `identity`. */
  git_remote?: string;
}

/**
 * `place.clear` (A1 3.6, 3.15): unbinds the owner's folder on the request's machine. The place
 * row stays, tombstoned (its `deleted` field), so history keeps the folder it held. Clearing an
 * existing place needs a base, as changing it does; an owner without a place here is unchanged.
 */
export interface PlaceClear {
  kind: "place.clear";
  task?: string;
  project?: string;
  area?: string;
}

/** A launch's states (A4 3.9.1). */
export const LAUNCH_STATES = [
  "prepared",
  "dispatching",
  "dispatched",
  "confirmed",
  "failed",
  "unknown",
] as const;
export type LaunchState = (typeof LAUNCH_STATES)[number];

/**
 * A launch record's evidence (A4 3.9.1, 3.16): a flat map from one of A4's keys to a value of that
 * key's kind. A4 owns the list (packages/launch: EVIDENCE_FIELDS); the writer keeps this copy, as
 * it keeps A4's edges, and checks every key and value against it, so no caller of the write path
 * can store a key outside the list or a value of another kind. A launch test compares the copies.
 */
export type LaunchEvidence = Record<string, string | number | boolean>;

/** A4's evidence keys and the kind of each value: an ID, an instant, a count or a flag. */
export const LAUNCH_EVIDENCE_FIELDS = {
  folder_id: "id",
  preset: "id",
  grant: "id",
  replayed_at: "instant",
  thread: "id",
  claim: "id",
  claimed_at: "instant",
  pid: "count",
  pid_started_at: "instant",
  folder_checked: "flag",
  exit_code: "count",
  bound_at: "instant",
  terminal: "id",
  terminal_source: "id",
  request: "id",
} as const satisfies Record<string, "id" | "instant" | "count" | "flag">;

/** An ID in evidence: a native session or thread ID, a grant, a claim, a file identity. */
export const LAUNCH_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A4's reason codes of Failed (A4 3.9.1–3.9.3). A launch test compares them with launch's. */
export const LAUNCH_FAIL_REASONS = [
  "expired",
  "cancelled",
  "refused",
  "not_claimed",
  "verify_failed",
  "agent_exited",
  "folder_mismatch",
  "interrupted",
  // The folder's own reason, when it no longer resolved right before the launch.
  "invalid_path",
  "root_missing",
  "root_unavailable",
  "path_missing",
  "not_a_directory",
  "not_a_file",
  "escapes_root",
  "identity_mismatch",
  "identity_unavailable",
  "folder_changed",
  "unsafe_folder",
  "not_answering",
] as const;

/** A4's reason codes of Unknown. */
export const LAUNCH_UNKNOWN_REASONS = ["no_answer", "lost", "regranted"] as const;

/**
 * `launch.create` (A4 3.9.1 Prepared): a click, as IDs and codes. The machine is the request's.
 * The writer gives it its `la_` ID and launch reference. A second click on the same task and
 * instance while an intent is in Dispatching or younger than 5 s returns that intent instead.
 */
export interface LaunchCreate {
  kind: "launch.create";
  /** The task's ID: a reference such as `M-14` is text a launch never takes. */
  task: Id<"t">;
  /** The instance's key in the machine's `machine.toml`. */
  instance: string;
  route: string;
  /** The place the folder resolved from, or null for the space's Tasks work folder. */
  place: Id<"pl"> | null;
  task_version: number;
  /** SHA-256 of the brief, lower-case hex. */
  brief_hash: string;
  session?: Id<"se">;
  evidence?: LaunchEvidence;
}

/**
 * `launch.transition` (A4 3.9.1, 3.16.1): one compare-and-set step of a launch. The launch must be
 * in `expect`, and, when `expect_version` is given, still at that version: the record the caller
 * decided on, so a decision on a record that has changed since (a claim landed, evidence grew)
 * moves nothing. `expect → next` must be an edge of A4's machine. Evidence only grows: a key the
 * record holds keeps its value.
 */
export interface LaunchTransition {
  kind: "launch.transition";
  launch: Id<"la">;
  expect: LaunchState;
  expect_version?: number;
  next: LaunchState;
  /** The reason code of Failed and Unknown. */
  reason?: string;
  evidence?: LaunchEvidence;
}

/**
 * `run.create` (A4 3.11.2 `queued`): a run, written before anything spawns. The machine is the
 * request's. Exactly one of `task` and `routine`. The writer gives it its `ru_` ID. `request` is
 * the person's instruction, the one text a run takes when it is queued.
 */
export interface RunCreate {
  kind: "run.create";
  task?: Id<"t">;
  routine?: Id<"ro">;
  /** The instance's key in the machine's `machine.toml`. */
  instance: string;
  adapter: string;
  /** The place the folder resolved from, or null for a Tasks work folder. */
  place: Id<"pl"> | null;
  session?: Id<"se">;
  request?: string;
  /** SHA-256 of the brief, lower-case hex. */
  brief_hash: string;
  permission: string;
  limits: RunLimitsRow;
}

/**
 * `run.transition` (A4 3.11.2, 3.16.1): one compare-and-set step of a run. The run must be in
 * `expect` and at `expect_version`, both required; `expect → next` must be an edge of A4's machine;
 * evidence only grows; a result goes in once, entering a final state.
 */
export interface RunTransition {
  kind: "run.transition";
  run: Id<"ru">;
  expect: RunState;
  expect_version: number;
  next: RunState;
  /** The reason code of `failed`, `timed_out` and `unknown`. */
  reason?: string;
  evidence?: RunEvidence;
  result?: RunResultRow;
}

/**
 * `pref.set` (A1 3.16): sets a space preference the registry declares, or resets it with null.
 * The value is checked against the key's declared shape before the transaction; whether the actor
 * may write the key is decided in it, so a refusal has its receipt (A3 3.8.3). A reset keeps the
 * row with the value null, so history and the base work as for any other value. It is not undoable
 * until undo inverts preferences (A1 3.16).
 */
export interface PrefSet {
  kind: "pref.set";
  key: string;
  value: PrefValue | null;
}

/**
 * `undo` (A1 3.10.1): inverts the principal's newest commit on its undo stack. It is guarded by
 * each field's provenance, never by a base, and is all or nothing unless `partial` asks for the
 * fields nobody changed since: then the rest stays as others set it, and the commit leaves the
 * stack even when nothing could be undone. A request holds it alone.
 */
export interface Undo {
  kind: "undo";
  /** The commit the caller means: refused unless it is the stack's newest (a toast's own undo). */
  commit?: Id<"op">;
  partial?: boolean;
}

/**
 * `redo` (A1 3.10.1): inverts the undo of the principal's oldest undone commit, so the commit's
 * values return with its own provenance. All or nothing. A request holds it alone.
 */
export interface Redo {
  kind: "redo";
  /** The commit the caller means: refused unless it is the one a redo would bring back. */
  commit?: Id<"op">;
}

/** The fields of an area or a project that `area.patch` and `project.patch` set. */
export interface GroupValues {
  title?: string;
  brief?: string;
  /** `#rrggbb` in lower case, or null for none. */
  color?: string | null;
}

/**
 * `area.create`: a new area at the end of the space's areas. Without a slug the writer makes one
 * from the title, numbered when another live area holds it.
 */
export interface AreaCreate extends GroupValues {
  kind: "area.create";
  id?: Id<"a">;
  title: string;
  slug?: string;
}

/**
 * `project.create`: a new project at the end of its area's projects, or of the projects without an
 * area. Its slug is unique among live projects, made from the title as an area's is.
 */
export interface ProjectCreate extends GroupValues {
  kind: "project.create";
  id?: Id<"p">;
  title: string;
  slug?: string;
  /** An area ID or slug, also of an area an earlier operation of the request creates. */
  area?: string | null;
}

export interface AreaPatch {
  kind: "area.patch";
  area: string;
  set: GroupValues;
}

export interface ProjectPatch {
  kind: "project.patch";
  project: string;
  set: GroupValues;
}

/** `project.move`: another area, or none. The project's tasks are in its area, so they move too. */
export interface ProjectMove {
  kind: "project.move";
  project: string;
  area: string | null;
}

/**
 * Archiving takes a group out of the lists people file work into. Its tasks keep their state and
 * their place, and an archived project keeps its folders. Both directions are idempotent.
 */
export interface GroupArchive {
  kind: "area.archive" | "area.unarchive" | "project.archive" | "project.unarchive";
  area?: string;
  project?: string;
}

/**
 * `project.delete` tombstones the project and its folders on every machine; `project.restore`
 * clears its tombstone and brings back the folders the delete removed, except one whose folder
 * another live project holds by then on that machine, which stays removed and is a conflict of
 * the applied result. A project that still holds tasks that are not deleted is not deleted.
 */
export interface ProjectDelete {
  kind: "project.delete" | "project.restore";
  project: string;
}

/**
 * `project.folder_set` and `task.folder_set`: the owner's folder on the request's machine, as that
 * machine spells it, the home written as `~`. The path is stored exactly as sent. With `carry`,
 * the folder was moved on disk: every other folder on that machine that is the old folder or
 * inside it, a project's or a task's, moves along to the same place inside the new one, unless one
 * of the two folders is the other or inside it.
 */
export interface FolderSet {
  kind: "project.folder_set" | "task.folder_set";
  project?: string;
  task?: string;
  path: string;
  carry?: boolean;
}

/** `project.folder_clear` and `task.folder_clear`: removes the owner's folder on this machine. */
export interface FolderClear {
  kind: "project.folder_clear" | "task.folder_clear";
  project?: string;
  task?: string;
}

export type Operation =
  | AreaCreate
  | ProjectCreate
  | AreaPatch
  | ProjectPatch
  | ProjectMove
  | GroupArchive
  | ProjectDelete
  | FolderSet
  | FolderClear
  | TaskCreate
  | TaskPatch
  | TaskContextAppend
  | TaskMove
  | TaskComplete
  | TaskReopen
  | TaskArchive
  | TaskWrapUp
  | TaskDelete
  | TaskRestore
  | NoteAdd
  | LogAdd
  | SourceAdd
  | PlaceSet
  | PlaceClear
  | LaunchCreate
  | LaunchTransition
  | RunCreate
  | RunTransition
  | PrefSet
  | Undo
  | Redo;
export type OperationKind = Operation["kind"];

export const OPERATION_KINDS = [
  "task.create",
  "task.patch",
  "task.context_append",
  "task.move",
  "task.complete",
  "task.reopen",
  "task.archive",
  "task.wrap_up",
  "task.delete",
  "task.restore",
  "note.add",
  "log.add",
  "source.add",
  "place.set",
  "place.clear",
  "launch.create",
  "launch.transition",
  "run.create",
  "run.transition",
  "pref.set",
  "undo",
  "redo",
  "area.create",
  "area.patch",
  "area.archive",
  "area.unarchive",
  "project.create",
  "project.patch",
  "project.move",
  "project.archive",
  "project.unarchive",
  "project.delete",
  "project.restore",
  "project.folder_set",
  "project.folder_clear",
  "task.folder_set",
  "task.folder_clear",
] as const satisfies readonly OperationKind[];

/** The operations that write a folder row. Their paths are stored exactly as sent. */
export const FOLDER_OPERATIONS: ReadonlySet<OperationKind> = new Set([
  "project.folder_set",
  "project.folder_clear",
  "task.folder_set",
  "task.folder_clear",
]);

/** The operations that invert history (A1 3.10). */
export type HistoryOperation = Undo | Redo;

export const isHistoryOperation = (op: Operation): op is HistoryOperation =>
  op.kind === "undo" || op.kind === "redo";

/**
 * What the caller asked for, as A3 3.4.1 and A1 3.8 define the intent: the registry entry and its
 * input as the caller sent it, after SafeText and the schema's normalisation, before relative
 * dates, references, dedupe and expansion. The service sends it with the operations it expanded
 * the input into, and the receipt's fingerprint covers it instead of the operations.
 */
export interface Intent {
  entry: string;
  input: unknown;
}

export interface WriteRequest {
  /** The space the caller means: a request for another space is refused (SPACE_MISMATCH). */
  space_id: Id<"sp">;
  /** 16 to 64 characters from `[A-Za-z0-9_-]`, unique within the writer scope (A1 3.8). */
  request_id: string;
  actor: Credential;
  /** Required when the request changes fields of rows that existed before it (A1 3.5). */
  base?: Base | string;
  reason?: string;
  /** A human's undoable action: the commit joins the principal's undo stack (A1 3.10.1). */
  undoable?: boolean;
  /**
   * Every task the request changes must be active: A3 3.4.6's `update_task` changes an active
   * task. A completed or archived one refuses the request with TASK_NOT_ACTIVE, decided in the
   * request's transaction, so it has a receipt and a retry answers the same.
   */
  active?: boolean;
  /** The caller's intent. Without one, the intent is the operations themselves. */
  intent?: Intent;
  /**
   * What the caller found before the writer and says with the result, such as a place bound
   * without a remote check (A3 3.4.6). An applied or unchanged result carries them and its
   * receipt stores them, so a replay says what the first answer said (A3 3.4.1); a retry's own
   * findings never replace them. Not part of the intent's fingerprint. At most 50 lines (one per
   * operation) of at most 500 characters, without controls; never task text.
   */
  warnings?: string[];
  ops: Operation[];
}

// ---------------------------------------------------------------------------------------------
// Validation

/** A request that passed validation: text normalised, base parsed. */
export interface CheckedRequest extends Omit<WriteRequest, "base"> {
  base?: Base;
}

/** A decided refusal on its way to the result. It never leaves the write path as an error. */
export class RequestProblem extends Error {
  override readonly name = "RequestProblem";
  readonly problem: WriteProblem;
  /** Rows the refusal is about, such as a removed link a revival needs the version of. */
  readonly conflicts: FieldConflict[];
  constructor(problem: WriteProblem, conflicts: FieldConflict[] = []) {
    super(problem.message);
    this.problem = problem;
    this.conflicts = conflicts;
  }
}

/** Throws the problem. An empty field means the request as a whole. */
function fail(code: WriteErrorCode, message: string, field?: string, op?: number): never {
  throw new RequestProblem({
    code,
    message,
    ...(op === undefined ? {} : { op }),
    ...(field === undefined || field === "" ? {} : { field }),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A1 3.7's normalisation: LF line endings, NUL and the C0 controls but tab and newline removed,
 * NFC. A lone surrogate becomes U+FFFD first, as SQLite's UTF-8 would store it, so the row and the
 * history hold the same text.
 */
export function normaliseStored(text: string): string {
  return (
    text
      .toWellFormed()
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- the C0 controls are what this removes.
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
      .normalize("NFC")
  );
}

const codePoints = (text: string): number => Array.from(text).length;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** A1 3.8: a request ID is 16 to 64 characters from [A-Za-z0-9_-]. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENTRY_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
/** A root's ID: a key of the machine's `machine.toml` (A1 3.15). */
const ROOT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SOURCE_NAMESPACE = /^[a-z0-9.-]+$/;
// Characters a place path never holds (A1 3.15): controls, bidirectional controls and zero-width
// characters, and the backslash, which Windows reads as a separator, so "a\..\b" would climb.
// The pattern is built from escapes, so the source holds no invisible character.
const PATH_FORBIDDEN = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" + // C0 controls, DEL and the C1 controls
    "\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069" + // bidirectional controls
    "\\u200b-\\u200d\\u2060\\ufeff" + // zero-width characters
    "\\\\" + // the backslash
    "]",
  "u",
);

/** The writer scope of the writer's own system commits, which no request may use. */
export const SYSTEM_SCOPE = "system";

/**
 * A source key as A1 3.6 stores it, or undefined: trimmed, `<namespace>:<id>` with the namespace
 * lower-cased and from `[a-z0-9.-]`, an ID that is not empty, kept as given, and at most 512
 * characters in all. The text is normalised first, like every text the writer stores.
 */
export function normaliseSourceKey(text: string): string | undefined {
  const key = normaliseStored(text).trim();
  const cut = key.indexOf(":");
  if (cut < 1 || cut === key.length - 1) return undefined;
  const namespace = key.slice(0, cut).toLowerCase();
  if (!SOURCE_NAMESPACE.test(namespace)) return undefined;
  const result = `${namespace}${key.slice(cut)}`;
  return codePoints(result) <= WRITE_LIMITS.sourceKey ? result : undefined;
}

/** A segment that starts with a drive letter and a colon, which Windows reads as a drive. */
const DRIVE = /^[A-Za-z]:/;

/**
 * Whether `path` is a place's relative path (A1 3.15): `""` for the root itself, else segments
 * joined by `/`, none empty, `.` or `..`, no control, bidirectional or zero-width character and no
 * backslash, at most 1,024 characters, and no drive letter in front (`C:/x` and `C:x` leave the
 * root on Windows; structured place fields never take an absolute path, A6 3.3). It is already its
 * own normalisation: a caller checks the text as sent with `PATH_FORBIDDEN` first, so the
 * normalisation never drops a control from a path.
 */
export function isRelPath(path: string): boolean {
  if (path === "") return true;
  if (codePoints(path) > WRITE_LIMITS.path || PATH_FORBIDDEN.test(path)) return false;
  if (DRIVE.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const isScope = (scope: unknown): scope is string =>
  typeof scope === "string" &&
  scope !== "" &&
  scope.length <= WRITE_LIMITS.scope &&
  normaliseStored(scope) === scope &&
  !scope.includes("\n") &&
  !scope.includes("\t") &&
  scope !== SYSTEM_SCOPE;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const AS_OF = /^([0-9]{1,10})\.([0-9]{1,15})\.([0-9a-hjkmnp-tv-z]{8})$/;

/** Whether `text` is a calendar date `YYYY-MM-DD`. */
export function isDate(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const match = DATE.exec(text);
  if (match === null) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Whether `name` is an IANA time zone this runtime knows. A bare offset is refused (A1 3.4). */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 64 || !TIME_ZONE.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Parses the wire form of an `as_of`, `<epoch>.<seq>.<tag>` (A1 3.5), or returns undefined. */
export function parseAsOf(text: unknown): Base | undefined {
  if (typeof text !== "string") return undefined;
  const match = AS_OF.exec(text);
  if (match === null) return undefined;
  const epoch = Number(match[1]);
  const seq = Number(match[2]);
  if (!inRange(epoch, "epoch") || !inRange(seq, "seq")) return undefined;
  return { epoch, incarnation: match[3] ?? "", seq };
}

/** The wire form of an `as_of`: the tag is the first 8 characters of the incarnation's body. */
export function formatAsOf(asOf: AsOf): string {
  return `${String(asOf.epoch)}.${String(asOf.seq)}.${incarnationTag(asOf.incarnation)}`;
}

export const incarnationTag = (incarnation: string): string =>
  incarnation.slice(incarnation.indexOf("_") + 1, incarnation.indexOf("_") + 9);

/** Reads the fields of one object, refusing any key it does not know. */
class Fields {
  readonly #value: Record<string, unknown>;
  readonly #path: string;
  readonly #op: number | undefined;
  readonly #seen = new Set<string>();

  constructor(value: unknown, path: string, op?: number) {
    this.#path = path;
    this.#op = op;
    if (!isRecord(value)) {
      fail("VALIDATION_FAILED", "Expected an object", path === "" ? undefined : path, op);
    }
    this.#value = value;
  }

  #at(key: string): string {
    return this.#path === "" ? key : key === "" ? this.#path : `${this.#path}.${key}`;
  }

  fail(code: WriteErrorCode, message: string, key: string): never {
    return fail(code, message, this.#at(key), this.#op);
  }

  /** Whether the key is present: null counts, undefined does not. */
  has(key: string): boolean {
    return Object.hasOwn(this.#value, key) && this.#value[key] !== undefined;
  }

  /** The fields of the object at `key`, refused under its path as this object's are. */
  sub(key: string): Fields {
    return new Fields(this.raw(key), this.#at(key), this.#op);
  }

  raw(key: string): unknown {
    this.#seen.add(key);
    return Object.hasOwn(this.#value, key) ? this.#value[key] : undefined;
  }

  /** Text, normalised, single-line when `line`, within `max` characters or bytes. */
  text(key: string, limits: { chars?: number; bytes?: number; line?: boolean; empty?: boolean }) {
    const value = this.raw(key);
    if (typeof value !== "string") return this.fail("VALIDATION_FAILED", "Expected text", key);
    const text = normaliseStored(value);
    if (limits.line === true && text.includes("\n")) {
      this.fail("VALIDATION_FAILED", "Expected one line of text", key);
    }
    if (limits.empty !== true && text.trim() === "") {
      this.fail("VALIDATION_FAILED", "Expected text that is not empty", key);
    }
    if (limits.chars !== undefined && codePoints(text) > limits.chars) {
      this.fail("TOO_LARGE", "The text is longer than its limit", key);
    }
    if (limits.bytes !== undefined && utf8Bytes(text) > limits.bytes) {
      this.fail("TOO_LARGE", "The text is larger than its limit", key);
    }
    return text;
  }

  optText(key: string, limits: Parameters<Fields["text"]>[1]): string | undefined {
    return this.has(key) ? this.text(key, limits) : undefined;
  }

  /** Text or null. */
  nullableText(key: string, limits: Parameters<Fields["text"]>[1]): string | null | undefined {
    if (!this.has(key)) return undefined;
    return this.raw(key) === null ? null : this.text(key, limits);
  }

  key(key: string): string {
    const value = this.raw(key);
    if (typeof value !== "string" || value.length > WRITE_LIMITS.key || !KEY.test(value)) {
      return this.fail("VALIDATION_FAILED", "Expected a key of letters, digits, _, . and -", key);
    }
    return value;
  }

  id<P extends "t" | "ac" | "m" | "se" | "ru" | "ro" | "sp" | "la" | "op">(
    key: string,
    prefix: P,
  ): Id<P> {
    const value = this.raw(key);
    if (!isId(value, prefix)) return this.fail("VALIDATION_FAILED", "Expected an ID", key);
    return value;
  }

  reference(key: string): string {
    const value = this.raw(key);
    if (typeof value !== "string" || value === "" || value.length > 64) {
      return this.fail("VALIDATION_FAILED", "Expected a reference", key);
    }
    return value;
  }

  /** An area or project: an ID or a slug, or null for none. */
  group(key: string): string | null {
    const value = this.raw(key);
    if (value === null) return null;
    if (typeof value !== "string" || value === "" || value.length > 120) {
      return this.fail("VALIDATION_FAILED", "Expected an ID, a slug or null", key);
    }
    return value;
  }

  boolean(key: string): boolean {
    const value = this.raw(key);
    if (typeof value !== "boolean")
      return this.fail("VALIDATION_FAILED", "Expected true or false", key);
    return value;
  }

  oneOf<const T extends string>(key: string, values: readonly T[]): T {
    const value = this.raw(key);
    if (!values.includes(value as T))
      return this.fail("VALIDATION_FAILED", "Not an allowed value", key);
    return value as T;
  }

  int(key: string, min: number, max: number): number {
    const value = this.raw(key);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      return this.fail("VALIDATION_FAILED", "Expected a whole number in range", key);
    }
    return value;
  }

  instantOrNull(key: string): number | null {
    const value = this.raw(key);
    if (value === null) return null;
    if (!inRange(value, "instant"))
      return this.fail("VALIDATION_FAILED", "Expected an instant", key);
    return value;
  }

  instant(key: string): number {
    const value = this.raw(key);
    if (!inRange(value, "instant"))
      return this.fail("VALIDATION_FAILED", "Expected an instant", key);
    return value;
  }

  dateOrNull(key: string): string | null {
    const value = this.raw(key);
    if (value === null) return null;
    if (!isDate(value)) return this.fail("VALIDATION_FAILED", "Expected a date YYYY-MM-DD", key);
    return value;
  }

  due(key: string): Due | null {
    const value = this.raw(key);
    if (value === null) return null;
    const due = new Fields(value, this.#at(key), this.#op);
    if (due.has("date")) {
      const date = due.raw("date");
      if (!isDate(date)) due.fail("VALIDATION_FAILED", "Expected a date YYYY-MM-DD", "date");
      due.done();
      return { date: date as string };
    }
    const at = due.raw("at");
    if (!inRange(at, "instant")) due.fail("VALIDATION_FAILED", "Expected an instant", "at");
    const tz = due.raw("tz");
    if (!isTimeZone(tz)) due.fail("VALIDATION_FAILED", "Expected an IANA time zone", "tz");
    due.done();
    return { at: at as number, tz: tz as string };
  }

  /**
   * Refuses every key that was not read. A key whose value is undefined counts as missing. The
   * problem names the object, not the key: an unknown key is input, and can hold any text.
   */
  done(): void {
    for (const key of Object.keys(this.#value)) {
      if (!this.#seen.has(key) && this.#value[key] !== undefined) {
        this.fail("VALIDATION_FAILED", "The object has a field it does not take", "");
      }
    }
  }
}

/** Reads the task values present in `f`. */
function taskValues(f: Fields): TaskValues {
  const values: TaskValues = {};
  const line = { chars: WRITE_LIMITS.line, line: true };
  if (f.has("title")) values.title = f.text("title", { chars: WRITE_LIMITS.title, line: true });
  if (f.has("summary")) {
    values.summary = f.text("summary", { chars: WRITE_LIMITS.summary, line: true, empty: true });
  }
  if (f.has("context")) {
    values.context = f.text("context", { bytes: WRITE_LIMITS.context, empty: true });
  }
  if (f.has("status")) values.status = f.key("status");
  if (f.has("inbox")) values.inbox = f.boolean("inbox");
  if (f.has("priority")) values.priority = f.int("priority", 1, 4);
  if (f.has("effort")) values.effort = f.raw("effort") === null ? null : f.key("effort");
  if (f.has("planned_for")) values.planned_for = f.dateOrNull("planned_for");
  if (f.has("focus")) values.focus = f.dateOrNull("focus");
  const owner = f.nullableText("owner", line);
  if (owner !== undefined) values.owner = owner;
  const waiting = f.nullableText("waiting_on", line);
  if (waiting !== undefined) values.waiting_on = waiting;
  if (f.has("source_at")) values.source_at = f.instantOrNull("source_at");
  if (f.has("reviewed_at")) values.reviewed_at = f.instantOrNull("reviewed_at");
  if (f.has("due")) values.due = f.due("due");
  return values;
}

/** A slug of an area or a project: lower-case ASCII letters and digits, `-` between. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function placement(f: Fields): Placement {
  const where: Placement = {};
  if (f.has("area")) where.area = f.group("area");
  if (f.has("project")) where.project = f.group("project");
  if (f.has("after")) where.after = f.reference("after");
  if (f.has("before")) where.before = f.reference("before");
  if (where.after !== undefined && where.before !== undefined) {
    f.fail("VALIDATION_FAILED", "Give after or before, not both", "before");
  }
  return where;
}

const fields = (value: unknown, path: string, op?: number): Fields => new Fields(value, path, op);

function checkOperation(value: unknown, i: number): Operation {
  const f = fields(value, `ops[${String(i)}]`, i);
  const kind = f.oneOf("kind", OPERATION_KINDS);
  let op: Operation;
  switch (kind) {
    case "task.create": {
      if (!f.has("title")) f.fail("VALIDATION_FAILED", "A new task needs a title", "title");
      const values = taskValues(f);
      const create: TaskCreate = { kind, title: values.title ?? "", ...values, ...placement(f) };
      if (f.has("id")) create.id = f.id("id", "t");
      if (f.has("created_at")) create.created_at = f.instant("created_at");
      if (f.has("dedupe")) create.dedupe = f.oneOf("dedupe", DEDUPE_MODES);
      if (f.has("link_sources")) {
        create.link_sources = f.boolean("link_sources");
        if (create.link_sources && (create.dedupe ?? "source_key") !== "source_key") {
          f.fail(
            "VALIDATION_FAILED",
            "Linking on a match needs dedupe by source key",
            "link_sources",
          );
        }
      }
      op = create;
      break;
    }
    case "task.patch": {
      const patch: TaskPatch = { kind, task: f.reference("task") };
      if (f.has("set")) {
        const set = fields(f.raw("set"), `ops[${String(i)}].set`, i);
        patch.set = taskValues(set);
        set.done();
      }
      if (f.has("unset")) {
        const unset = f.raw("unset");
        if (!Array.isArray(unset) || unset.length > PATCHABLE_FIELDS.length) {
          f.fail("VALIDATION_FAILED", "Expected a list of fields", "unset");
        }
        const list = unset as unknown[];
        for (const field of list) {
          if (!PATCHABLE_FIELDS.includes(field as PatchableField) || field === "title") {
            f.fail("VALIDATION_FAILED", "Not a field that can be cleared", "unset");
          }
        }
        if (new Set(list).size !== list.length) {
          f.fail("VALIDATION_FAILED", "A field is listed twice", "unset");
        }
        patch.unset = list as PatchableField[];
      }
      const set = Object.keys(patch.set ?? {});
      if (set.length === 0 && (patch.unset ?? []).length === 0) {
        f.fail("VALIDATION_FAILED", "A patch sets or clears at least one field", "set");
      }
      if (set.some((field) => patch.unset?.includes(field as PatchableField) === true)) {
        f.fail("VALIDATION_FAILED", "A field is both set and cleared", "unset");
      }
      op = patch;
      break;
    }
    case "task.context_append": {
      // The total is checked against A1's 64 KiB in the writer, on the context as it is then.
      op = {
        kind,
        task: f.reference("task"),
        text: f.text("text", { bytes: WRITE_LIMITS.context }),
      };
      break;
    }
    case "task.move": {
      const move: TaskMove = { kind, task: f.reference("task"), ...placement(f) };
      if (Object.keys(move).length === 2) {
        f.fail("VALIDATION_FAILED", "A move names a group or a sibling", "project");
      }
      op = move;
      break;
    }
    case "task.complete": {
      const complete: TaskComplete = { kind, task: f.reference("task") };
      const outcome = f.optText("outcome", { bytes: WRITE_LIMITS.outcome });
      if (outcome !== undefined) complete.outcome = outcome;
      if (f.has("if_active")) complete.if_active = f.boolean("if_active");
      if (f.has("at")) complete.at = f.instant("at");
      op = complete;
      break;
    }
    case "task.archive": {
      const archive: TaskArchive = { kind, task: f.reference("task") };
      const reason = f.optText("reason", { chars: WRITE_LIMITS.reason });
      if (reason !== undefined) archive.reason = reason;
      if (f.has("if_active")) archive.if_active = f.boolean("if_active");
      op = archive;
      break;
    }
    case "task.wrap_up": {
      const wrap: TaskWrapUp = { kind, task: f.reference("task") };
      const outcome = f.optText("outcome", { bytes: WRITE_LIMITS.outcome });
      if (outcome !== undefined) wrap.outcome = outcome;
      if (f.has("learnings")) wrap.learnings = learningChanges(f.raw("learnings"), i);
      if (f.has("clear_planning")) wrap.clear_planning = f.boolean("clear_planning");
      if (f.has("once")) wrap.once = f.boolean("once");
      op = wrap;
      break;
    }
    case "task.delete":
    case "task.restore": {
      op = { kind, task: f.reference("task") };
      break;
    }
    case "task.reopen": {
      const reopen: TaskReopen = { kind, task: f.reference("task") };
      const reason = f.optText("reason", { chars: WRITE_LIMITS.reason });
      if (reason !== undefined) reopen.reason = reason;
      op = reopen;
      break;
    }
    case "note.add": {
      const note: NoteAdd = {
        kind,
        task: f.reference("task"),
        body: f.text("body", { bytes: WRITE_LIMITS.note }),
      };
      if (f.has("addressee")) note.addressee = f.oneOf("addressee", ADDRESSEES);
      op = note;
      break;
    }
    case "log.add": {
      const log: LogAdd = {
        kind,
        task: f.reference("task"),
        body: f.text("body", { bytes: WRITE_LIMITS.log }),
      };
      if (f.has("log_kind")) log.log_kind = f.oneOf("log_kind", LOG_KINDS);
      if (f.has("at")) log.at = f.instant("at");
      op = log;
      break;
    }
    case "source.add": {
      const add: SourceAdd = {
        kind,
        task: f.reference("task"),
        source: sourceFields(fields(f.raw("source"), `ops[${String(i)}].source`, i)),
      };
      if (f.has("role")) add.role = f.oneOf("role", LINK_ROLES);
      if (f.has("link_version")) add.link_version = f.int("link_version", 0, RANGES.seq.max);
      op = add;
      break;
    }
    case "place.set": {
      const owners = (["task", "project", "area"] as const).filter((key) => f.has(key));
      if (owners.length !== 1) {
        f.fail("VALIDATION_FAILED", "A place has one owner: a task, a project or an area", "task");
      }
      const root = f.raw("root");
      if (typeof root !== "string" || !ROOT_ID.test(root)) {
        f.fail("VALIDATION_FAILED", "Expected a root ID of a-z, 0-9, _ and -", "root");
      }
      // The path as sent holds no character a path refuses, before the text normalisation, which
      // would drop a control rather than refuse it (A1 3.15). Then the normalised path is checked.
      const sent = f.raw("path");
      if (typeof sent === "string" && PATH_FORBIDDEN.test(sent)) {
        f.fail("VALIDATION_FAILED", "Expected a relative path inside the root", "path");
      }
      const path = f.text("path", { empty: true });
      if (!isRelPath(path)) {
        f.fail("VALIDATION_FAILED", "Expected a relative path inside the root", "path");
      }
      const place: PlaceSet = { kind, root: root as string, path };
      const owner = owners[0];
      if (owner === "task") place.task = f.reference("task");
      else if (owner !== undefined) {
        const group = f.group(owner);
        if (group === null) return f.fail("VALIDATION_FAILED", "Expected an ID or a slug", owner);
        place[owner] = group;
      }
      if (f.has("place_kind")) place.place_kind = f.oneOf("place_kind", PLACE_KINDS);
      const remote = f.optText("git_remote", { chars: WRITE_LIMITS.url, line: true });
      if (remote !== undefined) place.git_remote = remote;
      op = place;
      break;
    }
    case "place.clear": {
      const owners = (["task", "project", "area"] as const).filter((key) => f.has(key));
      if (owners.length !== 1) {
        f.fail("VALIDATION_FAILED", "A place has one owner: a task, a project or an area", "task");
      }
      const clear: PlaceClear = { kind };
      const owner = owners[0];
      if (owner === "task") clear.task = f.reference("task");
      else if (owner !== undefined) {
        const group = f.group(owner);
        if (group === null) return f.fail("VALIDATION_FAILED", "Expected an ID or a slug", owner);
        clear[owner] = group;
      }
      op = clear;
      break;
    }
    case "launch.create": {
      const instance = f.raw("instance");
      if (typeof instance !== "string" || !INSTANCE_KEY.test(instance)) {
        f.fail("VALIDATION_FAILED", "Expected an instance key", "instance");
      }
      const place = f.raw("place");
      if (place !== null && !isId(place, "pl")) {
        f.fail("VALIDATION_FAILED", "Expected a place ID or null", "place");
      }
      const hash = f.raw("brief_hash");
      if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
        f.fail("VALIDATION_FAILED", "Expected a SHA-256 in lower-case hex", "brief_hash");
      }
      const create: LaunchCreate = {
        kind,
        task: f.id("task", "t"),
        instance: instance as string,
        route: f.oneOf("route", OPEN_SETS["launches.route"]),
        place: place as Id<"pl"> | null,
        task_version: f.int("task_version", RANGES.seq.min, RANGES.seq.max),
        brief_hash: hash as string,
      };
      if (f.has("session")) create.session = f.id("session", "se");
      if (f.has("evidence")) create.evidence = launchEvidence(f, "evidence");
      op = create;
      break;
    }
    case "launch.transition": {
      const transition: LaunchTransition = {
        kind,
        launch: f.id("launch", "la"),
        expect: f.oneOf("expect", LAUNCH_STATES),
        next: f.oneOf("next", LAUNCH_STATES),
      };
      if (f.has("expect_version")) {
        transition.expect_version = f.int("expect_version", RANGES.seq.min, RANGES.seq.max);
      }
      if (f.has("reason")) {
        const reason = f.raw("reason");
        if (typeof reason !== "string" || !CODE.test(reason)) {
          f.fail("VALIDATION_FAILED", "Expected a reason code", "reason");
        }
        transition.reason = reason as string;
      }
      if (f.has("evidence")) transition.evidence = launchEvidence(f, "evidence");
      op = transition;
      break;
    }
    case "run.create": {
      const instance = f.raw("instance");
      if (typeof instance !== "string" || !INSTANCE_KEY.test(instance)) {
        f.fail("VALIDATION_FAILED", "Expected an instance key", "instance");
      }
      const place = f.raw("place");
      if (place !== null && !isId(place, "pl")) {
        f.fail("VALIDATION_FAILED", "Expected a place ID or null", "place");
      }
      const hash = f.raw("brief_hash");
      if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
        f.fail("VALIDATION_FAILED", "Expected a SHA-256 in lower-case hex", "brief_hash");
      }
      if (f.has("task") === f.has("routine")) {
        f.fail("VALIDATION_FAILED", "A run belongs to a task or a routine, exactly one", "task");
      }
      const create: RunCreate = {
        kind,
        instance: instance as string,
        adapter: f.oneOf("adapter", OPEN_SETS["runs.adapter"]),
        place: place as Id<"pl"> | null,
        brief_hash: hash as string,
        permission: f.oneOf("permission", RUN_PERMISSIONS),
        limits: runLimits(f.sub("limits")),
      };
      if (f.has("task")) create.task = f.id("task", "t");
      if (f.has("routine")) create.routine = f.id("routine", "ro");
      if (f.has("session")) create.session = f.id("session", "se");
      // A task's run takes the person's instruction (A4 3.11.7); a routine's takes its template.
      if (create.task !== undefined) {
        create.request = f.text("request", { bytes: RUN_REQUEST_MAX_BYTES });
      } else if (f.has("request")) {
        f.fail("VALIDATION_FAILED", "A routine's run takes no instruction", "request");
      }
      op = create;
      break;
    }
    case "run.transition": {
      // The version is required: a claim moves a run's version and keeps its state, so a decision
      // made on the state alone could cancel a run whose shim may already start its agent.
      const transition: RunTransition = {
        kind,
        run: f.id("run", "ru"),
        expect: f.oneOf("expect", RUN_STATES),
        expect_version: f.int("expect_version", RANGES.seq.min, RANGES.seq.max),
        next: f.oneOf("next", RUN_STATES),
      };
      if (f.has("reason")) {
        const reason = f.raw("reason");
        if (typeof reason !== "string" || !CODE.test(reason)) {
          f.fail("VALIDATION_FAILED", "Expected a reason code", "reason");
        }
        transition.reason = reason as string;
      }
      if (f.has("evidence")) transition.evidence = runEvidence(f, "evidence");
      if (f.has("result")) transition.result = runResult(f.sub("result"));
      op = transition;
      break;
    }
    case "pref.set":
      op = prefSet(f);
      break;
    case "undo": {
      const undo: Undo = { kind };
      if (f.has("commit")) undo.commit = f.id("commit", "op");
      if (f.has("partial")) undo.partial = f.boolean("partial");
      op = undo;
      break;
    }
    case "redo": {
      const redo: Redo = { kind };
      if (f.has("commit")) redo.commit = f.id("commit", "op");
      op = redo;
      break;
    }
    case "area.create":
    case "project.create": {
      const values = groupValues(f);
      const title = f.text("title", { chars: WRITE_LIMITS.title, line: true });
      let slug: string | undefined;
      if (f.has("slug")) {
        const raw = f.raw("slug");
        if (typeof raw !== "string" || raw.length > WRITE_LIMITS.slug || !SLUG.test(raw)) {
          f.fail("VALIDATION_FAILED", "Expected a slug of a-z, 0-9 and -", "slug");
        }
        slug = raw as string;
      }
      if (kind === "area.create") {
        const area: AreaCreate = { kind, ...values, title };
        if (slug !== undefined) area.slug = slug;
        if (f.has("id")) {
          const id = f.raw("id");
          if (!isId(id, "a")) f.fail("VALIDATION_FAILED", "Expected an ID", "id");
          area.id = id as Id<"a">;
        }
        op = area;
      } else {
        const project: ProjectCreate = { kind, ...values, title };
        if (slug !== undefined) project.slug = slug;
        if (f.has("area")) project.area = f.group("area");
        if (f.has("id")) {
          const id = f.raw("id");
          if (!isId(id, "p")) f.fail("VALIDATION_FAILED", "Expected an ID", "id");
          project.id = id as Id<"p">;
        }
        op = project;
      }
      break;
    }
    case "area.patch":
    case "project.patch": {
      const owner = kind === "area.patch" ? "area" : "project";
      const ref = requiredGroup(f, owner);
      const set = f.sub("set");
      const values = groupValues(set);
      if (set.has("title")) {
        values.title = set.text("title", { chars: WRITE_LIMITS.title, line: true });
      }
      set.done();
      if (Object.keys(values).length === 0) {
        f.fail("VALIDATION_FAILED", "A patch sets at least one field", "set");
      }
      op =
        kind === "area.patch"
          ? { kind, area: ref, set: values }
          : { kind, project: ref, set: values };
      break;
    }
    case "project.move": {
      if (!f.has("area")) f.fail("VALIDATION_FAILED", "A move names the area, or null", "area");
      op = { kind, project: requiredGroup(f, "project"), area: f.group("area") };
      break;
    }
    case "area.archive":
    case "area.unarchive":
      op = { kind, area: requiredGroup(f, "area") };
      break;
    case "project.archive":
    case "project.unarchive":
      op = { kind, project: requiredGroup(f, "project") };
      break;
    case "project.delete":
    case "project.restore":
      op = { kind, project: requiredGroup(f, "project") };
      break;
    case "project.folder_set":
    case "task.folder_set": {
      // Stored exactly as sent: a text normalisation could make it name another folder.
      const path = f.raw("path");
      if (!isFolderForm(path)) {
        f.fail(
          "VALIDATION_FAILED",
          "Expected a folder: an absolute path or a path under ~, without control characters",
          "path",
        );
      }
      const set: FolderSet =
        kind === "project.folder_set"
          ? { kind, project: requiredGroup(f, "project"), path: path as string }
          : { kind, task: f.reference("task"), path: path as string };
      if (f.has("carry")) set.carry = f.boolean("carry");
      op = set;
      break;
    }
    case "project.folder_clear":
    case "task.folder_clear":
      op =
        kind === "project.folder_clear"
          ? { kind, project: requiredGroup(f, "project") }
          : { kind, task: f.reference("task") };
      break;
  }
  f.done();
  return op;
}

/** An area or a project an operation acts on: an ID or a slug, never null. */
function requiredGroup(f: Fields, key: "area" | "project"): string {
  const group = f.group(key);
  if (group === null) return f.fail("VALIDATION_FAILED", "Expected an ID or a slug", key);
  return group;
}

/** A colour of an area or a project: `#rrggbb` in lower case. */
const COLOR = /^#[0-9a-f]{6}$/u;

/** The brief and the colour of an area or a project, where `f` has them. */
function groupValues(f: Fields): GroupValues {
  const values: GroupValues = {};
  if (f.has("brief")) {
    values.brief = f.text("brief", { bytes: WRITE_LIMITS.brief, empty: true });
  }
  if (f.has("color")) {
    const color = f.raw("color");
    if (color !== null && (typeof color !== "string" || !COLOR.test(color))) {
      f.fail("VALIDATION_FAILED", "Expected a colour #rrggbb in lower case, or null", "color");
    }
    values.color = color;
  }
  return values;
}

/**
 * A run's evidence (A4 3.16): A4's keys only, each with a value of its kind, refused under the
 * object's name as a launch's is.
 */
function runEvidence(f: Fields, key: string): RunEvidence {
  const value = f.raw(key);
  if (!isRecord(value)) {
    return f.fail("VALIDATION_FAILED", "Expected evidence: A4's keys with their values", key);
  }
  const evidence: RunEvidence = {};
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (!Object.hasOwn(RUN_EVIDENCE_FIELDS, name)) {
      f.fail("VALIDATION_FAILED", "Expected evidence: A4's keys with their values", key);
    }
    const kind = RUN_EVIDENCE_FIELDS[name as keyof typeof RUN_EVIDENCE_FIELDS];
    const fits =
      kind === "id" ? typeof item === "string" && RUN_EVIDENCE_ID.test(item) : inRange(item, kind);
    if (!fits) f.fail("VALIDATION_FAILED", "Expected an ID, an instant or a count", key);
    evidence[name] = item as string | number | boolean;
  }
  return evidence;
}

/** A run's limits (A4 3.11.3, 3.11.7): whole numbers within their bounds, a budget in dollars. */
function runLimits(f: Fields): RunLimitsRow {
  const b = RUN_LIMIT_BOUNDS;
  const limits: RunLimitsRow = {
    max_turns: f.int("max_turns", b.maxTurns.min, b.maxTurns.max),
    wall_ms: f.int("wall_ms", b.wallMs.min, b.wallMs.max),
    idle_ms: f.int("idle_ms", b.idleMs.min, b.idleMs.max),
  };
  if (f.has("budget_usd")) {
    const budget = f.raw("budget_usd");
    if (
      typeof budget !== "number" ||
      !Number.isFinite(budget) ||
      budget < b.budgetUsd.min ||
      budget > b.budgetUsd.max
    ) {
      f.fail("VALIDATION_FAILED", "Expected a budget in dollars", "budget_usd");
    }
    limits.budget_usd = budget;
  }
  f.done();
  return limits;
}

/** A signal's name as Node reports it. */
const SIGNAL = /^SIG[A-Z0-9]{1,12}$/;

/**
 * A run's final outcome (A4 3.11.5): the verdict, codes, counts, the native ID, usage, the agent's
 * answer (at most 1 MiB, with whether it was cut and whether it is final) and its error (at most
 * 8 KiB), normalised like every text the writer stores. Never a folder.
 */
function runResult(f: Fields): RunResultRow {
  const count = (key: string): number => f.int(key, RANGES.count.min, RANGES.count.max);
  const nullable = <T>(key: string, read: () => T): T | null =>
    f.raw(key) === null ? null : read();
  const text = (key: string, bytes: number): string | null =>
    nullable(key, () => f.text(key, { bytes, empty: true }));
  const flags: Pick<RunResultRow, "text_cut" | "text_final" | "cleanup"> = {};
  if (f.has("text_cut")) flags.text_cut = f.boolean("text_cut");
  if (f.has("text_final")) flags.text_final = f.boolean("text_final");
  if (f.has("cleanup")) flags.cleanup = f.oneOf("cleanup", RUN_CLEANUPS);
  const result: RunResultRow = {
    ok: f.boolean("ok"),
    outcome: f.oneOf("outcome", RUN_OUTCOMES),
    exit_code: nullable("exit_code", () => f.int("exit_code", -2_147_483_648, 4_294_967_295)),
    signal: nullable("signal", () => {
      const signal = f.raw("signal");
      if (typeof signal !== "string" || !SIGNAL.test(signal)) {
        f.fail("VALIDATION_FAILED", "Expected a signal's name", "signal");
      }
      return signal;
    }),
    native_id: nullable("native_id", () => {
      const id = f.raw("native_id");
      if (typeof id !== "string" || !RUN_EVIDENCE_ID.test(id)) {
        f.fail("VALIDATION_FAILED", "Expected a native ID", "native_id");
      }
      return id;
    }),
    text: text("text", RUN_RESULT_TEXT_MAX_BYTES),
    ...flags,
    error: text("error", RUN_TEXT_MAX_BYTES),
    usage: nullable("usage", () => {
      const usage = f.sub("usage");
      const out: Record<string, number> = {};
      for (const key of RUN_USAGE_KEYS) {
        if (!usage.has(key)) continue;
        const n = usage.raw(key);
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
          usage.fail("VALIDATION_FAILED", "Expected a count or a cost", key);
        }
        out[key] = n as number;
      }
      usage.done();
      return out;
    }),
    app_tools: nullable("app_tools", () => f.oneOf("app_tools", RUN_APP_TOOLS)),
    declined: count("declined"),
    permission_denials: count("permission_denials"),
    duration_ms: nullable("duration_ms", () => f.int("duration_ms", 0, RANGES.instant.max)),
  };
  f.done();
  return result;
}

/** Every string of plain JSON data, normalised as the writer stores text (A1 3.7). */
function normaliseJson(value: unknown): unknown {
  if (typeof value === "string") return normaliseStored(value);
  if (Array.isArray(value)) return value.map(normaliseJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normaliseJson(v)]));
  }
  return value;
}

/**
 * `pref.set`'s fields (A1 3.16): a key this build declares for the space, and a value of its
 * declared shape, or null to reset it. The problem never quotes the key or the value.
 */
function prefSet(f: Fields): PrefSet {
  const key = f.raw("key");
  if (typeof key !== "string" || key.length > PREFERENCE_KEY_MAX || !PREFERENCE_KEY.test(key)) {
    return f.fail("VALIDATION_FAILED", "Expected a preference name", "key");
  }
  const spec = preferenceSpec(key);
  if (spec === undefined)
    return f.fail("VALIDATION_FAILED", "Not a preference of this build", "key");
  if (spec.scope !== "space") {
    return f.fail("VALIDATION_FAILED", "A machine preference lives in machine.toml", "key");
  }
  if (!f.has("value")) {
    return f.fail("VALIDATION_FAILED", "Give the value, or null to reset it", "value");
  }
  const raw = f.raw("value");
  if (raw === null) return { kind: "pref.set", key, value: null };
  const value = isJsonData(raw) ? normaliseJson(raw) : undefined;
  if (value !== undefined && utf8Bytes(canonicalJson(value)) > PREFERENCE_VALUE_BYTES) {
    return f.fail("TOO_LARGE", "The value is larger than a preference may hold", "value");
  }
  if (value === undefined || !fitsShape(spec.shape, value)) {
    return f.fail("VALIDATION_FAILED", "The value does not fit the preference", "value");
  }
  return { kind: "pref.set", key, value: value as PrefValue };
}

/** An instance's key in machine.toml (A4 3.2). */
const INSTANCE_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A fixed code: a reason. Never a sentence. The writer's stage checks it against A4's lists. */
const CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A launch's evidence (A4 3.16): A4's keys only, each with a value of its kind. A key outside the
 * list or a value of another kind is refused under the object's name, never the key's own: both
 * are input, and a key could carry text.
 */
function launchEvidence(f: Fields, key: string): LaunchEvidence {
  const value = f.raw(key);
  if (!isRecord(value)) {
    return f.fail("VALIDATION_FAILED", "Expected evidence: A4's keys with their values", key);
  }
  const evidence: LaunchEvidence = {};
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (!Object.hasOwn(LAUNCH_EVIDENCE_FIELDS, name)) {
      f.fail("VALIDATION_FAILED", "Expected evidence: A4's keys with their values", key);
    }
    const kind = LAUNCH_EVIDENCE_FIELDS[name as keyof typeof LAUNCH_EVIDENCE_FIELDS];
    const fits =
      kind === "flag"
        ? typeof item === "boolean"
        : kind === "id"
          ? typeof item === "string" && LAUNCH_EVIDENCE_ID.test(item)
          : inRange(item, kind);
    if (!fits) f.fail("VALIDATION_FAILED", "Expected an ID, an instant, a count or a flag", key);
    evidence[name] = item as string | number | boolean;
  }
  return evidence;
}

/**
 * A wrap-up's learnings (A1 3.11.2): texts to add, each at most 1 KiB, and IDs of learnings to
 * remove, at most a task's 20 of each. A problem names the list, never a text.
 */
function learningChanges(value: unknown, i: number): NonNullable<TaskWrapUp["learnings"]> {
  const path = `ops[${String(i)}].learnings`;
  const f = fields(value, path, i);
  const list = (key: string): unknown[] | undefined => {
    if (!f.has(key)) return undefined;
    const items = f.raw(key);
    if (!Array.isArray(items) || items.length > WRITE_LIMITS.learnings) {
      return f.fail("VALIDATION_FAILED", "Expected a list of at most 20", key);
    }
    return items as unknown[];
  };
  const changes: NonNullable<TaskWrapUp["learnings"]> = {};
  const add = list("add");
  if (add !== undefined) {
    changes.add = add.map((item) => {
      if (typeof item !== "string") return f.fail("VALIDATION_FAILED", "Expected text", "add");
      const text = normaliseStored(item);
      if (text.trim() === "") f.fail("VALIDATION_FAILED", "Expected text that is not empty", "add");
      if (utf8Bytes(text) > WRITE_LIMITS.learning) {
        f.fail("TOO_LARGE", "A learning is larger than 1 KiB", "add");
      }
      return text;
    });
  }
  const remove = list("remove");
  if (remove !== undefined) {
    if (!remove.every((id) => isId(id, "lr"))) {
      f.fail("VALIDATION_FAILED", "Expected learning IDs", "remove");
    }
    if (new Set(remove).size !== remove.length) {
      f.fail("VALIDATION_FAILED", "A learning is listed twice", "remove");
    }
    changes.remove = remove as Id<"lr">[];
  }
  f.done();
  return changes;
}

/** A source's fields (A1 3.4, 3.6, 3.7). */
function sourceFields(f: Fields): SourceFields {
  const line = { chars: WRITE_LIMITS.line, line: true };
  const source: SourceFields = {
    kind: f.oneOf("kind", SOURCE_KINDS),
    title: f.text("title", { chars: WRITE_LIMITS.sourceTitle, line: true }),
  };
  if (f.has("key")) {
    const raw = f.raw("key");
    const key = typeof raw === "string" ? normaliseSourceKey(raw) : undefined;
    if (key === undefined) {
      f.fail("VALIDATION_FAILED", "A source key is <namespace>:<id> of at most 512", "key");
    }
    source.key = key;
  }
  const who = f.optText("who", line);
  if (who !== undefined) source.who = who;
  // A key a source is linked without stays as its reference (Dedupe.decide).
  const ref = f.optText("ref", { chars: WRITE_LIMITS.sourceKey, line: true });
  if (ref !== undefined) source.ref = ref;
  const url = f.optText("url", { chars: WRITE_LIMITS.url, line: true });
  if (url !== undefined) source.url = url;
  if (f.has("at")) {
    const at = f.raw("at");
    if (!inRange(at, "instant")) f.fail("VALIDATION_FAILED", "Expected an instant", "at");
    source.at = at;
  }
  f.done();
  return source;
}

function checkCredential(value: unknown): Credential {
  const f = fields(value, "actor");
  // A writer scope is an opaque line (A1 3.8). `system` is the writer's own, whose commits
  // have no receipts, so no request may use it.
  const scope = f.raw("scope_id");
  if (!isScope(scope)) f.fail("VALIDATION_FAILED", "Expected a writer scope", "scope_id");
  const credential: Credential = {
    scope_id: scope as string,
    principal_id: f.id("principal_id", "ac"),
    actor_kind: f.oneOf("actor_kind", ACTOR_KINDS),
    machine_id: f.id("machine_id", "m"),
    origin: f.oneOf("origin", ORIGINS),
  };
  if (f.has("earlier_scope_id")) {
    const earlier = f.raw("earlier_scope_id");
    if (!isScope(earlier) || earlier === scope) {
      f.fail("VALIDATION_FAILED", "Expected another writer scope", "earlier_scope_id");
    }
    credential.earlier_scope_id = earlier as string;
  }
  if (f.has("author_id")) credential.author_id = f.id("author_id", "ac");
  if (f.has("session_id")) credential.session_id = f.id("session_id", "se");
  if (f.has("run_id")) credential.run_id = f.id("run_id", "ru");
  f.done();
  return credential;
}

function checkBase(value: unknown): Base {
  if (typeof value === "string") {
    return parseAsOf(value) ?? fail("VALIDATION_FAILED", "Copy as_of verbatim as the base", "base");
  }
  const f = fields(value, "base");
  const epoch = f.int("epoch", RANGES.epoch.min, RANGES.epoch.max);
  const seq = f.int("seq", RANGES.seq.min, RANGES.seq.max);
  const incarnation = f.raw("incarnation");
  if (!isId(incarnation, "ai"))
    f.fail("VALIDATION_FAILED", "Expected an incarnation ID", "incarnation");
  f.done();
  return { epoch, incarnation: incarnation as string, seq };
}

/**
 * The caller's intent: an entry name and plain JSON data, which the fingerprint hashes as it is.
 * The registry normalised the input before (A3 3.10), so the writer neither reads nor changes it.
 */
function checkIntent(value: unknown): Intent {
  const f = fields(value, "intent");
  const entry = f.raw("entry");
  if (typeof entry !== "string" || entry.length > 64 || !ENTRY_NAME.test(entry)) {
    f.fail("VALIDATION_FAILED", "Expected a registry entry name", "entry");
  }
  const input = f.raw("input");
  if (!isJsonData(input)) {
    f.fail("VALIDATION_FAILED", "Expected plain JSON data, at most 64 levels deep", "input");
  }
  f.done();
  return { entry: entry as string, input };
}

/**
 * Checks a request's shape and limits, before any transaction (A1 3.7). Returns the request with
 * its text normalised, or throws RequestProblem. Nothing is stored for such a request.
 */
export function checkRequest(value: unknown): CheckedRequest {
  let json: string | undefined;
  try {
    // JSON.stringify returns undefined for undefined and functions, which its type leaves out.
    json = (JSON.stringify as (v: unknown) => string | undefined)(value);
  } catch {
    return fail("VALIDATION_FAILED", "The request is not JSON data", "");
  }
  if (utf8Bytes(json ?? "") > WRITE_LIMITS.requestBytes) {
    fail("TOO_LARGE", "The request is larger than 16 MiB", "");
  }
  const f = fields(value, "");
  const requestId = f.raw("request_id");
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
    return fail(
      "REQUEST_ID_INVALID",
      "A request ID is 16 to 64 characters from A-Z, a-z, 0-9, _ and -",
      "request_id",
    );
  }
  const spaceId = f.raw("space_id");
  if (!isId(spaceId, "sp")) return fail("VALIDATION_FAILED", "Expected a space ID", "space_id");
  const actor = checkCredential(f.raw("actor"));
  const ops: unknown = f.raw("ops");
  if (!Array.isArray(ops) || ops.length === 0) {
    return fail("VALIDATION_FAILED", "A request has at least one operation", "ops");
  }
  const list = ops as unknown[];
  if (list.length > WRITE_LIMITS.ops) {
    fail("TOO_LARGE", `A request has at most ${String(WRITE_LIMITS.ops)} operations`, "ops");
  }
  const request: CheckedRequest = {
    space_id: spaceId,
    request_id: requestId,
    actor,
    ops: list.map((op, i) => checkOperation(op, i)),
  };
  if (f.has("base")) request.base = checkBase(f.raw("base"));
  if (f.has("intent")) request.intent = checkIntent(f.raw("intent"));
  const reason = f.optText("reason", { chars: WRITE_LIMITS.reason });
  if (reason !== undefined) request.reason = reason;
  if (f.has("undoable")) {
    request.undoable = f.boolean("undoable");
    if (request.undoable && actor.actor_kind !== "human") {
      f.fail("VALIDATION_FAILED", "Only a human's actions join an undo stack", "undoable");
    }
  }
  if (f.has("active")) request.active = f.boolean("active");
  if (f.has("warnings")) request.warnings = checkWarnings(f.raw("warnings"));
  if (request.ops.some(isExecutionOp)) checkExecutionRequest(f, request);
  if (request.ops.some(isHistoryOperation)) checkHistoryRequest(f, request);
  // A1 3.16: the writer reads the space's preferences (statuses, efforts, dedupe's window) once,
  // as the request starts, so no other operation may share a request with a change of them.
  const prefs = request.ops.filter((op) => op.kind === "pref.set").length;
  if (prefs > 0 && prefs < request.ops.length) {
    f.fail("VALIDATION_FAILED", "A preference request holds pref.set operations only", "ops");
  }
  // Undo never inverts a preference (history.ts), so a change of one never joins the undo stack,
  // where it would block every undo behind it. Setting the earlier value again changes it back.
  if (prefs > 0 && request.undoable === true) {
    f.fail("VALIDATION_FAILED", "A preference change is not undoable: set it again", "undoable");
  }
  checkMatchableDrafts(request.ops);
  f.done();
  return request;
}

/**
 * The operations that may name a draft that dedupes by source key: its entries, sources, place and
 * folder.
 */
const MATCHABLE_DRAFT_OPS: ReadonlySet<Operation["kind"]> = new Set([
  "log.add",
  "note.add",
  "task.context_append",
  "source.add",
  "place.set",
  "task.folder_set",
]);

/**
 * A draft that may match a task by its source keys (A1 3.6: a `task.create` with a client ID, the
 * default `dedupe`, and a keyed `source.add` naming it) is named only by its entries, its sources
 * and its place, and never as a sibling. Anything else would change a task the caller never read
 * as this one, or be dropped unseen, so it is refused from the input alone: whether a request is
 * valid never depends on what the space holds under its keys.
 */
function checkMatchableDrafts(ops: readonly Operation[]): void {
  const keyed = new Set<string>();
  for (const op of ops) {
    if (op.kind === "source.add" && op.source.key !== undefined) keyed.add(op.task);
  }
  const matchable = new Set<string>();
  for (const op of ops) {
    if (
      op.kind === "task.create" &&
      op.id !== undefined &&
      (op.dedupe ?? "source_key") === "source_key" &&
      keyed.has(op.id)
    ) {
      matchable.add(op.id);
    }
  }
  if (matchable.size === 0) return;
  const message =
    "A draft that may match a task by source key takes only entries, sources and a place: " +
    "change it in a later request, or create it with dedupe new or none";
  ops.forEach((op, i) => {
    const at = `ops[${String(i)}]`;
    const named = "task" in op ? op.task : undefined;
    if (named !== undefined && matchable.has(named) && !MATCHABLE_DRAFT_OPS.has(op.kind)) {
      fail("VALIDATION_FAILED", message, `${at}.task`, i);
    }
    if (op.kind === "task.create" || op.kind === "task.move") {
      for (const side of ["after", "before"] as const) {
        const sibling = op[side];
        if (sibling !== undefined && matchable.has(sibling)) {
          fail("VALIDATION_FAILED", message, `${at}.${side}`, i);
        }
      }
    }
  });
}

/**
 * A request that undoes or redoes (A1 3.10.1): that one operation alone, from a human, guarded by
 * provenance rather than a base, never on the undo stack itself (its commit is the stack's own
 * move), and with no `active` mark (it changes back whatever the commit changed).
 */
function checkHistoryRequest(f: Fields, request: CheckedRequest): void {
  if (request.ops.length !== 1) {
    f.fail("VALIDATION_FAILED", "An undo or redo is a request of its own", "ops");
  }
  if (request.actor.actor_kind !== "human") {
    f.fail("VALIDATION_FAILED", "Only a human undoes and redoes", "actor.actor_kind");
  }
  if (request.undoable === true) {
    f.fail("VALIDATION_FAILED", "An undo or redo does not join the undo stack", "undoable");
  }
  if (request.base !== undefined) {
    f.fail("VALIDATION_FAILED", "An undo or redo is guarded by provenance, not a base", "base");
  }
  if (request.active !== undefined) {
    f.fail("VALIDATION_FAILED", "An undo or redo takes no active", "active");
  }
}

/**
 * A request's warnings (WriteRequest.warnings): 1 to 500 characters each, one line, at most one per
 * operation a request may hold (a 25-draft `add_tasks` binds up to 25 places, each may warn).
 */
function checkWarnings(value: unknown): string[] {
  const ok =
    Array.isArray(value) &&
    value.length <= WRITE_LIMITS.ops &&
    value.every(
      (line) =>
        typeof line === "string" &&
        line !== "" &&
        Array.from(line).length <= 500 &&
        !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line),
    );
  if (!ok)
    fail("VALIDATION_FAILED", "Expected at most one warning of one line per operation", "warnings");
  return [...(value as string[])];
}

/** Launch and run operations: A4's execution records (A4 3.16.1). */
const isExecutionOp = (op: Operation): boolean =>
  op.kind.startsWith("launch.") || op.kind.startsWith("run.");

/** A writer scope as a launch request carries it: an ID's characters, never a sentence. */
const LAUNCH_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A request with launch or run operations (A4 3.9, 3.11, 3.16): it stores IDs, states, instants,
 * counts, flags and fixed codes, and a run's request and result texts in their own fields only, so
 * the envelope may hold no text. It carries execution operations alone, no reason (a record's
 * reason is its code), no registry intent (whose input the receipt's fingerprint would cover), no
 * `active` mark (a launch or a run changes no task), and a writer scope of an ID's characters.
 * Each field is refused under its own name.
 */
function checkExecutionRequest(f: Fields, request: CheckedRequest): void {
  const { actor } = request;
  if (!request.ops.every(isExecutionOp)) {
    f.fail("VALIDATION_FAILED", "A launch request holds launch operations only", "ops");
  }
  // R7: launches are the user's. The service writes them for the person who clicked, or as the
  // space's system for what it observes. No agent, routine or import writes one (A3 3.2.3).
  if (actor.actor_kind !== "human" && actor.actor_kind !== "system") {
    f.fail("VALIDATION_FAILED", "Launching is a user action", "actor.actor_kind");
  }
  // A launch record changes no history the undo stack could invert (A1 3.6: not undoable).
  if (request.undoable === true) {
    f.fail("VALIDATION_FAILED", "A launch is not undoable", "undoable");
  }
  if (request.reason !== undefined) {
    f.fail(
      "VALIDATION_FAILED",
      "A launch request takes no reason: its record holds a code",
      "reason",
    );
  }
  if (request.intent !== undefined) {
    f.fail("VALIDATION_FAILED", "A launch request takes no registry intent", "intent");
  }
  // `active` marks the tasks a request changes (A3 3.4.6), and a launch changes no task.
  if (request.active !== undefined) {
    f.fail("VALIDATION_FAILED", "A launch request changes no task: it takes no active", "active");
  }
  if (request.warnings !== undefined) {
    f.fail("VALIDATION_FAILED", "A launch request holds no text: it takes no warnings", "warnings");
  }
  for (const [field, scope] of [
    ["actor.scope_id", actor.scope_id],
    ["actor.earlier_scope_id", actor.earlier_scope_id],
  ] as const) {
    if (scope !== undefined && !LAUNCH_SCOPE.test(scope)) {
      f.fail("VALIDATION_FAILED", "A launch request's writer scope is an ID", field);
    }
  }
}
