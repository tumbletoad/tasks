// The Planning prototype importer's shapes that cross the service boundary (A7 3.15.4): the problem
// table and one problem as the dry-run report and the preview carry it. The importer
// (packages/importer-planning) builds problems from this table. M7.04 adds the preview's own shapes.
//
// A problem names a place (a file, a line, a task ID, a field, a position) and a fixed code. It
// never carries text from the input, so a report or a log line built from it holds no task text.
import { z } from "zod";

/**
 * Every problem code with its severity (A7 3.15.2, 3.15.3). An error means the input is not what
 * the prototype itself would accept, or the parser had to leave something out; a warning is
 * reported and the import can go on. M7.04 decides which errors block a preview.
 */
export const IMPORT_PROBLEM_CODES = {
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
  // The mapping to the space model (A7 3.15.3). Each is listed under needs attention (3.15.4).
  /** A task line without a marker: its ID changes if its title changes. */
  "fallback-id": "warning",
  /** A title over 300 characters, cut at a word boundary; the full text heads the context. */
  "title-cut": "warning",
  /** A title that SafeText leaves empty: the legacy ID is the title. */
  "title-empty": "warning",
  /** Another text over its limit in the space, cut at a word boundary (the field says which). */
  "text-cut": "warning",
  /** SafeText changed the text of a field (A3 3.10): the report counts these. */
  "text-sanitised": "warning",
  /** A checked task line or a folded check, completed or kept in Review (`--checked-as`). */
  "checked-item": "warning",
  /** A completion without a calendar date: completed at the import time. */
  "done-date-unknown": "warning",
  /** A date or time outside the space's range (1970 to 9999): dropped. */
  "date-out-of-range": "warning",
  /** `paths[0]` under no root, or not a folder a place can name: no place. */
  "path-outside-roots": "warning",
  /** `paths[1…]`, kept in `ext.planning.paths`. */
  "paths-extra": "warning",
  /** A source label that only names the kind: the title is a short form of the URL. */
  "source-title-generic": "warning",
  /** A source key that another imported task names too: one source row, linked to both. */
  "source-key-shared": "warning",
  /** A source URL that gives no key (not a URL, or a key over 512 characters): a keyless row. */
  "source-key-unavailable": "warning",
  /** A source the space cannot hold (a URL over 2,048 characters): left out. */
  "source-dropped": "warning",
  /** An unknown metadata key that names one of the importer's own `ext.planning` keys. */
  "extra-key-reserved": "warning",
  /** An unknown metadata key whose value nests deeper than 32 levels: left out. */
  "extra-dropped": "warning",
} as const satisfies Record<string, "error" | "warning">;

export type ImportProblemCode = keyof typeof IMPORT_PROBLEM_CODES;
export type ImportProblemSeverity = (typeof IMPORT_PROBLEM_CODES)[ImportProblemCode];

/**
 * The fields a problem may name: the known metadata keys, the ledger's parts and clauses, audit's
 * time, the folded events and the unknown metadata keys (`extra`).
 */
export const IMPORT_PROBLEM_FIELDS = [
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
  "title",
  "body",
  "group",
  "check",
  "focus",
  "extra",
] as const;
export type ImportProblemField = (typeof IMPORT_PROBLEM_FIELDS)[number];

const codes = Object.keys(IMPORT_PROBLEM_CODES) as [ImportProblemCode, ...ImportProblemCode[]];

/** One problem as the dry-run report and the preview carry it (A7 3.15.4). */
export const ImportProblem = z.strictObject({
  code: z.enum(codes),
  severity: z.enum(["error", "warning"]),
  /** The file, relative to the prototype folder, with forward slashes. */
  file: z.string().max(120),
  /** 1-based, in the str.splitlines() split of a ledger. */
  line: z.int().min(1).optional(),
  /** Only an ID of the event grammar is ever named. */
  task: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_-]{1,100}$/u)
    .optional(),
  field: z.enum(IMPORT_PROBLEM_FIELDS).optional(),
  /** 0-based position in a list. */
  index: z.int().min(0).optional(),
});
export type ImportProblem = z.infer<typeof ImportProblem>;
