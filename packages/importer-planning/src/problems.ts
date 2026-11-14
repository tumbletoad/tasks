// Typed problems of the prototype importer's parsers (A7 3.15.2). Every parser is total: whatever
// it is given, it returns a result and a list of these, and never throws. A problem names a place
// (a file, a line, a task ID, a field) and a fixed code. It never carries text from the input, so
// a report or a log line built from it holds no task text (AGENTS.md).

/** Every problem code, with its severity. An error means the input is not what the prototype
 * itself would accept, or the parser had to leave something out; a warning is reported and the
 * import can go on. */
export const PROBLEM_CODES = {
  // Files and bounds.
  "file-missing": "error",
  "file-too-large": "error",
  "invalid-utf8": "error",
  "byte-order-mark": "warning",
  "line-too-long": "error",
  "too-many-task-lines": "error",
  "too-many-entries": "error",
  "too-many-items": "warning",
  "too-many-event-files": "error",
  // Ledgers.
  "duplicate-id": "error",
  "date-invalid": "warning",
  // JSON files.
  "json-invalid": "error",
  "json-wrong-shape": "error",
  "entry-not-object": "warning",
  "field-type": "warning",
  "status-unknown": "warning",
  "priority-invalid": "warning",
  "source-invalid": "warning",
  "path-not-absolute": "warning",
  "metadata-orphan": "warning",
  "jira-row-without-key": "warning",
  // Events.
  "event-invalid": "error",
  "event-too-large": "error",
  "event-not-ready": "warning",
  "event-duplicate-id": "warning",
  "event-unknown-task": "warning",
  // The input copy.
  "not-a-regular-file": "error",
  "destination-exists": "error",
  "destination-inside-source": "error",
  "read-failed": "error",
  "write-failed": "error",
  "source-changed": "error",
} as const satisfies Record<string, "error" | "warning">;

export type ProblemCode = keyof typeof PROBLEM_CODES;
export type Severity = (typeof PROBLEM_CODES)[ProblemCode];

/** The fields a problem may name: the known metadata keys, the ledger clauses and audit's time. */
export const PROBLEM_FIELDS = [
  "category",
  "project",
  "status",
  "owner",
  "priority",
  "rank",
  "next",
  "evidence",
  "source_date",
  "reviewed",
  "confidence",
  "due",
  "sources",
  "paths",
  "added",
  "done",
] as const;
export type ProblemField = (typeof PROBLEM_FIELDS)[number];

export interface Problem {
  readonly code: ProblemCode;
  readonly severity: Severity;
  /** The file, relative to the prototype folder, with forward slashes (`events/<name>`). An event
   * file whose name is not of the event grammar is named `events` only (see SAFE_FILE). */
  readonly file: string;
  /** 1-based line, in the str.splitlines() split of a ledger. */
  readonly line?: number;
  /** The task ID the problem is about. Only an ID of the event grammar is ever named here. */
  readonly task?: string;
  readonly field?: ProblemField;
  /** 0-based position in a list: a jira.json row, a source or path of a metadata entry, or an
   * events/*.json file in sorted order when its name cannot be named. */
  readonly index?: number;
}

/** A task ID safe to name in a problem: the event grammar's ID, which covers every marker and
 * fallback ID. Anything else (a metadata key could be any text) is left out. */
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** A file a problem may name: a fixed input path, the folder itself, or an event file whose name
 * follows the event grammar (`<id>.json`, `<id>.ready`). Any other name read from disk could hold
 * task text, so a problem names its folder `events` instead, and its place goes in `index`. */
const SAFE_FILE =
  /^(?:\.|TODO\.md|DONE\.md|tasks-export\.json|data|events|data\/(?:metadata|jira|audit)\.json|events\/[a-zA-Z0-9_-]{1,100}\.(?:json|ready))$/;

export function isSafeFile(file: string): boolean {
  return SAFE_FILE.test(file);
}

export interface ProblemPlace {
  readonly file: string;
  readonly line?: number | undefined;
  readonly task?: string | undefined;
  readonly field?: ProblemField | undefined;
  readonly index?: number | undefined;
}

export function problem(code: ProblemCode, place: ProblemPlace): Problem {
  const out: {
    code: ProblemCode;
    severity: Severity;
    file: string;
    line?: number;
    task?: string;
    field?: ProblemField;
    index?: number;
  } = { code, severity: PROBLEM_CODES[code], file: isSafeFile(place.file) ? place.file : "events" };
  if (place.line !== undefined) out.line = place.line;
  if (place.task !== undefined && SAFE_ID.test(place.task)) out.task = place.task;
  if (place.field !== undefined) out.field = place.field;
  if (place.index !== undefined) out.index = place.index;
  return out;
}
