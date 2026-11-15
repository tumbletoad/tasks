// The Planning prototype importer's shapes that cross the service boundary (A7 3.15.4): the problem
// table and one problem as the dry-run report and the preview carry it. The importer
// (packages/importer-planning) builds problems from this table. The preview's own shapes are the
// entry `import.planning.preview` (entries/import-planning-preview.ts).
//
// A problem names a place (a file, a line, a task ID, a field, a position) and a fixed code. It
// never carries text from the input, so a report or a log line built from it holds no task text.
import { z } from "zod";

/**
 * Every problem code with its severity (A7 3.15.2, 3.15.3, 3.15.4). An error means the input is not
 * what the prototype itself would accept, or the parser had to leave something out; a warning is
 * reported and the import can go on. Every error blocks a preview (A7 3.15.4): the dry run returns
 * no token until the input is fixed. A warning never does, and is listed under needs attention.
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
  /** The event files together over their bound: the later ones are not copied or read. */
  "events-too-large": "error",
  // Ledgers.
  /** Two lines of one ledger with one ID: the later one is left out. */
  "duplicate-id": "error",
  /** An ID in both ledgers: the DONE.md line wins, as on the page, and the TODO.md line is left
   * out. */
  "open-copy-hidden": "warning",
  "date-invalid": "warning",
  /** A `due` with more after its day: the day is kept, as the page reads it. */
  "date-trimmed": "warning",
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
  /** A later event with an ID an earlier one has: it is left out, so an ID counts once. */
  "event-duplicate-id": "warning",
  "event-unknown-task": "warning",
  // The page's actions export (`--actions`).
  /** Not the page's export, or an event in it the prototype's import command refuses: the whole
   * file is refused, as that command refuses it. */
  "actions-invalid": "error",
  /** An event of the export whose ID an event of events/ has with another task, action or time. */
  "actions-conflict": "error",
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
  /** A task a folded check event checks: completed, or kept in Review (`--checked-as`). */
  "checked-item": "warning",
  /** A `[x]` box in TODO.md that no event checks or unchecks. The page does not show it checked;
   * the import completes it (or keeps it in Review) as the person's own statement. */
  "ticked-in-file": "warning",
  /** A `[x]` box in TODO.md whose last check event is an uncheck: active, as on the page. */
  "ticked-unchecked": "warning",
  /** A metadata key `checked`, `focus` or `ticked`, which the page applies to a task without
   * events: kept in `ext.planning`, and neither checks nor stars the task. */
  "metadata-state-key": "warning",
  /** A completion without a calendar date: completed at the import time. */
  "done-date-unknown": "warning",
  /** A date or time outside the space's range (1970 to 9999), or a day the import's time zone
   * skips: dropped. */
  "date-out-of-range": "warning",
  /** The first absolute path under no root, or not a folder a place can name (a climb, a hidden
   * character, a spelling SafeText would change): no place. */
  "path-outside-roots": "warning",
  /** Every path that is not the place's, kept in `ext.planning.paths`. */
  "paths-extra": "warning",
  /** A source label that only names the kind: the title is a short form of the URL. */
  "source-title-generic": "warning",
  /** A source key that another imported task names too: one source row, linked to both. */
  "source-key-shared": "warning",
  /** A source URL that gives no key (not a URL, or a key over 512 characters): a keyless row. */
  "source-key-unavailable": "warning",
  /** A source the space cannot hold (a URL over 2,048 characters): left out. */
  "source-dropped": "warning",
  /** A `file:` link: a path on the machine that wrote it, kept in `ext.planning.paths`. */
  "source-file-link": "warning",
  /** A link the page does not show (a scheme other than http, https, file and t3-thread):
   * imported all the same. */
  "source-not-shown": "warning",
  /** An unknown metadata key that names one of the importer's own `ext.planning` keys. */
  "extra-key-reserved": "warning",
  /** An unknown metadata key whose value nests deeper than 32 levels, or holds a number JSON.parse
   * could not keep as written (`1e400`, `9007199254740993`): left out. */
  "extra-dropped": "warning",
  /** A metadata entry without a task line whose ID no task line could carry (not of the marker
   * grammar): not created, even with `--include-orphans`. */
  "orphan-id-invalid": "warning",
  // What only the space and this machine can tell (the dry run, A7 3.15.4).
  /** A source key the space already holds: the apply links that row. */
  "source-key-exists": "warning",
  /** A place whose folder is not on this machine. */
  "place-missing": "warning",
  /** A legacy ID the space already holds as an alias: an earlier import created it. */
  "legacy-id-imported": "warning",
  /** No actions export (`--actions`): check-offs and stars held only in the page's browser storage
   * are not imported. */
  "actions-not-given": "warning",
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

/** A count or a position in an import's report: far above any bound of A7 3.15.2. */
const Count = z.int().min(0).max(1_000_000_000);

/** One problem as the dry-run report and the preview carry it (A7 3.15.4). */
export const ImportProblem = z.strictObject({
  code: z.enum(codes).describe("A code of the fixed table"),
  severity: z.enum(["error", "warning"]).describe("An error blocks the preview"),
  file: z.string().max(120).describe("The file in the prototype folder, with forward slashes"),
  line: z.int().min(1).max(1_000_000_000).describe("1-based line of a ledger").optional(),
  task: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_-]{1,100}$/u)
    .describe("The task ID, only of the event grammar")
    .optional(),
  field: z.enum(IMPORT_PROBLEM_FIELDS).describe("The field it is about").optional(),
  index: Count.describe("0-based position in a list").optional(),
});
export type ImportProblem = z.infer<typeof ImportProblem>;
