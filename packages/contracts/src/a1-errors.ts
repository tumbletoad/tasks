// A1's upper-case error codes, and the storage codes that can reach a caller, mapped onto the
// registry's error codes, with the upper-case code kept in data.cause. The write path's codes
// come first, then the storage worker's, with the reason and the
// retry rule of the transport where a caller needs them. This module has no
// dependencies: storage checks from its own tests that every code it can raise is here.
//
// An error never carries task text (AGENTS.md): A1's problems name an operation's index and an
// input path or field, never a value, and `a1ErrorBody` passes on only those.
import type { ErrorBody, ErrorCode } from "./errors.ts";

export interface A1ErrorMapping {
  /** The registry's code. */
  readonly code: ErrorCode;
  /** `data.reason`, for `space_unavailable` and `read_only`. */
  readonly reason?: string;
  /** `data.retryable`: retry the same call with the same request_id after a short wait. */
  readonly retryable?: boolean;
  /** `data.rule`, for `forbidden`: which rule refused the call. */
  readonly rule?: string;
}

const unavailable = (reason: string, retryable: boolean): A1ErrorMapping => ({
  code: "space_unavailable",
  reason,
  retryable,
});
const readOnly = (reason?: string): A1ErrorMapping => ({
  code: "read_only",
  ...(reason === undefined ? {} : { reason }),
  retryable: false,
});

/** Every code, by A1's or storage's name. */
export const A1_ERRORS = {
  // The write path. Decided outcomes: each is in a receipt.
  VALIDATION_FAILED: { code: "invalid_input" },
  TOO_LARGE: { code: "too_large" },
  NOT_FOUND: { code: "not_found" },
  /** A deleted task, area or project takes no change. */
  DELETED: { code: "not_found" },
  /** A reference with another space's prefix is not_found, never a task elsewhere. */
  SPACE_MISMATCH: { code: "not_found" },
  AMBIGUOUS_REFERENCE: { code: "ambiguous" },
  VERSION_CONFLICT: { code: "conflict" },
  /** A missing base where one is required is a conflict. */
  BASE_REQUIRED: { code: "conflict" },
  /** No read returned that as_of: copy it verbatim. */
  BASE_FROM_FUTURE: { code: "invalid_input" },
  /** The space has a new authority since the read: read again. */
  EPOCH_CHANGED: { code: "conflict" },
  /** The task's lifecycle changed since the caller looked: read again. */
  INVALID_TRANSITION: { code: "conflict" },
  /** A request for an active task found it completed or archived: reopen it first. */
  TASK_NOT_ACTIVE: { code: "wrong_tool" },
  REQUEST_ID_REUSED: { code: "request_id_conflict" },
  REQUEST_ID_INVALID: { code: "invalid_input" },
  // Undo, redo and revert.
  UNDO_CONFLICT: { code: "conflict" },
  NOTHING_TO_UNDO: { code: "not_found" },
  NOTHING_TO_REDO: { code: "not_found" },
  UNDO_BEFORE_FLOOR: { code: "conflict" },
  HAS_ACTIVE_TASKS: { code: "conflict" },
  /** A preference whose declaration does not list the actor: policy is the user's. */
  PREFERENCE_FORBIDDEN: { code: "forbidden", rule: "policy" },
  /** The text for agents on a node: only a person writes a standing instruction. */
  USER_ONLY: { code: "forbidden" },
  /** An absolute path under no root of this machine. */
  PLACE_OUTSIDE_ROOTS: { code: "invalid_input" },
  /** Undecided: the writer passes A1's reason on (transfer_pending, held, not the authority). */
  SPACE_READ_ONLY: readOnly(),
  // Undecided outcomes: no receipt, and a retry with the same ID runs the request.
  /** A barrier backup failed, so the change it guards did not start. */
  BACKUP_FAILED: unavailable("backup_failed", true),
  /** Another program holds the database. */
  STORAGE_BUSY: unavailable("busy", true),
  /** The writer's queue is full. */
  STORAGE_OVERLOADED: unavailable("overloaded", true),
  /** The space turns read-only until there is room again. */
  DURABILITY_FAILED: readOnly("durability_failed"),
  // The storage worker.
  /** No answer within 10 s: the writer may still decide it, so retry with the same ID. */
  STORAGE_TIMEOUT: unavailable("timeout", true),
  /** SQLite recovers the space's WAL after a crash. */
  STORAGE_RECOVERING: unavailable("opening", true),
  STORAGE_WORKER_FAILED: unavailable("restarting", true),
  STORAGE_READ_ONLY: readOnly(),
  STORAGE_CORRUPT: unavailable("needs_recovery", false),
  STORAGE_CANT_OPEN: unavailable("not_served", false),
  /** These three are bugs: the write path checks every constraint before SQLite does. */
  STORAGE_CONSTRAINT: { code: "internal" },
  STORAGE_MISUSE: { code: "internal" },
  STORAGE_SQL: { code: "internal" },
  STORAGE_UNSUPPORTED: { code: "internal" },
  // The space folder and one writer per space.
  SPACE_PATH_INVALID: { code: "invalid_input" },
  SPACE_EXISTS: { code: "invalid_input" },
  SPACE_NOT_FOUND: unavailable("not_served", false),
  SPACE_INVALID: unavailable("not_served", false),
  SPACE_TOO_NEW: readOnly("newer_format"),
  SPACE_VERSION_UNKNOWN: unavailable("version_unknown", false),
  SPACE_ID_MISMATCH: readOnly("space_id_mismatch"),
  SPACE_MANIFEST_DAMAGED: readOnly("manifest_damaged"),
  SPACE_CHANGED: unavailable("opening", true),
  /** A rollback journal beside the database: recovery restores the space. */
  SPACE_NEEDS_RECOVERY: unavailable("needs_recovery", false),
  /** Another writer in this process holds the space, mostly its last open or close: it ends. */
  SPACE_WRITER_TAKEN: unavailable("not_served", true),
  /** Another process holds the space's writer.lock. */
  SPACE_LOCKED_ELSEWHERE: unavailable("not_served", false),
  /** The database file has a second name (a hard or symbolic link): never opened for writing. */
  SPACE_DATABASE_LINKED: unavailable("not_served", false),
  // Migrations, backups and restore.
  SPACE_NEEDS_MIGRATION: unavailable("opening", true),
  /** A restored backup that is not claimed yet: readers only. */
  SPACE_READ_ONLY_COPY: readOnly("read_only_copy"),
  MIGRATION_FAILED: readOnly("migration_failed"),
  BACKUP_INVALID: { code: "invalid_input" },
  BUNDLE_LIMIT_EXCEEDED: { code: "too_large" },
  // Export bundles.
  /** A bundle that breaks the archive or layout rules, or does not verify. */
  BUNDLE_INVALID: { code: "invalid_input" },
  /** An export that would carry a secret-shaped string; nothing was written. */
  EXPORT_SECRET_FOUND: { code: "invalid_input" },
  /** A database with objects its revision does not create: an export of it is refused. */
  SPACE_SCHEMA_FOREIGN: { code: "invalid_input" },
} as const satisfies Record<string, A1ErrorMapping>;

export type A1ErrorCode = keyof typeof A1_ERRORS;

/** The mapping of an A1 or storage code. An unknown code is a bug: `internal`. */
export function a1Mapping(cause: string): A1ErrorMapping {
  return Object.hasOwn(A1_ERRORS, cause) ? A1_ERRORS[cause as A1ErrorCode] : { code: "internal" };
}

/** Where in the request a write-path problem lies: an operation's index and an input path. */
export interface A1ErrorPlace {
  op?: number;
  field?: string;
  /** REQUEST_ID_REUSED: when the original was decided, in milliseconds. */
  at?: number;
  /**
   * The problem's own reason, such as SPACE_READ_ONLY's `not_authority`, `held` or
   * `transfer_pending`. It replaces the mapping's reason for a code that
   * carries one and is dropped for any other code, or when it is not a reason word.
   */
  reason?: string;
}

/** A reason word: what `data.reason` holds, never a value. */
const REASON = /^[a-z][a-z_]{0,39}$/;

/**
 * The registry's error body for an A1 or storage code: the mapped code, the problem's
 * own fixed sentence, and `data` with A1's code as `cause`, the reason and retry rule, and where
 * in the request the problem lies. Nothing else reaches it, so no value does.
 */
export function a1ErrorBody(cause: string, message: string, place: A1ErrorPlace = {}): ErrorBody {
  const mapping = a1Mapping(cause);
  const carries = mapping.code === "read_only" || mapping.code === "space_unavailable";
  const reason =
    carries && place.reason !== undefined && REASON.test(place.reason)
      ? place.reason
      : mapping.reason;
  return {
    code: mapping.code,
    message,
    data: {
      cause,
      ...(reason === undefined ? {} : { reason }),
      ...(mapping.retryable === undefined ? {} : { retryable: mapping.retryable }),
      ...(mapping.rule === undefined ? {} : { rule: mapping.rule }),
      ...(place.op === undefined ? {} : { op: place.op }),
      ...(place.field === undefined ? {} : { field: place.field }),
      ...(place.at === undefined ? {} : { original_at: new Date(place.at).toISOString() }),
    },
  };
}
