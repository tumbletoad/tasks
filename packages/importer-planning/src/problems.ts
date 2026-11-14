// Typed problems of the prototype importer (A7 3.15.2, 3.15.3). Every parser is total: whatever it
// is given, it returns a result and a list of these, and never throws; the mapping adds its own.
// A problem names a place (a file, a line, a task ID, a field) and a fixed code. It never carries
// text from the input, so a report or a log line built from it holds no task text (AGENTS.md).
//
// The code table and the problem's shape cross the service boundary in the dry-run report, so they
// live in packages/contracts (import-planning.ts). This module builds problems from them.
import {
  IMPORT_PROBLEM_CODES,
  IMPORT_PROBLEM_FIELDS,
  type ImportProblemCode,
  type ImportProblemField,
  type ImportProblemSeverity,
} from "@tasks/contracts";

/** Every problem code, with its severity (contracts: IMPORT_PROBLEM_CODES). */
export const PROBLEM_CODES = IMPORT_PROBLEM_CODES;
export type ProblemCode = ImportProblemCode;
export type Severity = ImportProblemSeverity;

/** The fields a problem may name (contracts: IMPORT_PROBLEM_FIELDS). */
export const PROBLEM_FIELDS = IMPORT_PROBLEM_FIELDS;
export type ProblemField = ImportProblemField;

/** One problem (contracts: ImportProblem). */
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
