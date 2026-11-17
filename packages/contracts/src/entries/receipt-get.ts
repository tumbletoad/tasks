// receipt.get: a write's stored result by its request ID, in the caller's own writer scope (A3
// 3.2.3, 3.7.9; A1 3.8; A7 3.8 M1.05). The CLI calls it first when it is given --request-id, so a
// command repeated after a lost reply prints the stored result instead of reading a fresh base
// (A3 3.4.1, DA-18), and the page asks it for a request that got no answer (A5 3.11). Another
// scope's receipts are never found. Not an MCP tool. From L1 it also looks up a remote command's
// receipt by command ID (A6 3.8.4), which adds an optional input.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { AsOf, idPattern, Lifecycle, patterns, TaskId, TaskRef, Warnings } from "../schemas.ts";
import { AS_OF, M14, requestId } from "./fixture.ts";

const Seq = z.int().min(0).max(999_999_999_999_999);
const Instant = z.string().regex(patterns.instant);
/** At most 400 operations a request, and up to a million in an import's. */
const OpIndex = z.int().min(0).max(999_999).describe("Index of the operation in the request");
/** Any A1 ID: a task, note, log entry, source, place, area or project. */
const RowId = z.string().regex(/^[a-z]{1,2}_[0-9a-hjkmnp-tv-z]{26}$/u);
/**
 * A preference's key, such as `tasks.statuses` (A1 3.16): a preference has no ID, and its key is its
 * `changes.entity_id` (A1 3.4), so `pref.set`'s result names it.
 */
const PreferenceKey = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u);

export const ReceiptGetInput = z.strictObject({
  request: z
    .string()
    .max(64)
    .regex(patterns.requestId)
    .describe("The request_id of the write to look up"),
});

const ReceiptOpResult = z.strictObject({
  i: OpIndex,
  status: z
    .enum(["created", "updated", "unchanged", "existing", "proposed"])
    .describe("What the operation did"),
  id: z.union([RowId, PreferenceKey]).describe("The row it acted on, or a preference's key"),
  task: TaskId.optional(),
  ref: TaskRef.optional(),
  entry: z.string().regex(patterns.entryRef).describe("Note or log entry reference").optional(),
  version: Seq.describe("The row's version after it; for a source, the link's"),
  differs: z
    .array(z.enum(["kind", "title", "who", "ref", "url", "at"]))
    .describe("Fields of an existing source the input gave otherwise")
    .optional(),
  matched_by: z
    .enum(["source_key"])
    .describe("A task draft that matched an existing task: how")
    .optional(),
  lifecycle: Lifecycle.describe("The matched task's lifecycle").optional(),
  ambiguous: z
    .array(TaskRef)
    .describe("Several active tasks matched, the named one first")
    .optional(),
});

const ReceiptConflict = z.strictObject({
  op: OpIndex,
  // Every table a request can conflict on: storage's ConflictEntity (write/request.ts). An undo
  // or redo also names a child row that keeps a create from being undone (A1 3.10).
  entity: z
    .enum([
      "tasks",
      "task_sources",
      "places",
      "notes",
      "log_entries",
      "sources",
      "learnings",
      "attachments",
      "task_labels",
      "preferences",
      "runs",
      "areas",
      "projects",
      "folders",
    ])
    .describe("Table of the row"),
  id: z
    .union([
      z
        .string()
        .max(60)
        .regex(/^[a-z]{1,2}_[0-9a-hjkmnp-tv-z]{26}(?:\|(?:s|lb)_[0-9a-hjkmnp-tv-z]{26})?$/u),
      PreferenceKey,
    ])
    .describe("The row, task_id|source_id (task_id|label_id) for a link, or a preference's key"),
  task: TaskId.optional(),
  ref: TaskRef.optional(),
  field: z.string().max(40).describe("Logical field"),
  version: Seq.describe("The commit that last wrote it"),
  by: z
    .strictObject({
      actor: z.string().regex(idPattern("ac")).describe("Actor ID"),
      kind: z.string().max(20).describe("Actor kind"),
      label: z.string().describe("Actor label"),
      origin: z
        .enum(["ui", "cli", "mcp", "http", "import", "system", "migration"])
        .describe("Where the commit came from; import: the user applied an import")
        .optional(),
    })
    .describe("Who wrote that version"),
  at: Instant.describe("When"),
});

export const ReceiptGetResult = z.union([
  z.strictObject({
    found: z.literal(false).describe("No receipt for that request ID in this writer scope"),
  }),
  z.strictObject({
    found: z.literal(true).describe("The write was decided: its stored result follows"),
    request: z.string().regex(patterns.requestId).describe("The request ID"),
    status: z
      .enum(["applied", "proposed", "unchanged", "conflict", "rejected"])
      .describe("The overall outcome"),
    decided_at: Instant.describe("When it was decided"),
    as_of: AsOf,
    incarnation: z
      .string()
      .regex(idPattern("ai"))
      .describe("The authority incarnation it was decided under"),
    commit: z.string().regex(idPattern("op")).describe("The commit it wrote").optional(),
    target: z
      .string()
      .regex(idPattern("op"))
      .describe("An undo or redo's UNDO_CONFLICT: the commit it met, to name in the next undo")
      .optional(),
    results: z
      .array(ReceiptOpResult)
      .max(50)
      .describe("One result per operation, the first 50 of an import's"),
    results_more: z
      .int()
      .min(1)
      .max(1_000_000)
      .describe("An import's results beyond those 50")
      .optional(),
    conflicts: z
      .array(ReceiptConflict)
      .describe("Every conflicting field, without its value: read again")
      .optional(),
    error: z
      .strictObject({
        cause: z.string().max(40).describe("A1's error code"),
        message: z.string().describe("What was refused, in one sentence"),
        op: OpIndex.optional(),
        field: z.string().max(80).describe("The input path or field").optional(),
      })
      .describe("Why it was refused")
      .optional(),
    warnings: Warnings,
  }),
]);

/** A stored receipt as storage returns it (receipts.ts), as plain data. */
export interface StoredReceiptLike {
  request_id: string;
  at: number;
  incarnation: string;
  result: {
    status: string;
    as_of: string;
    commit?: string;
    target?: string;
    results: readonly object[];
    conflicts: readonly { at: number }[];
    error?: { code: string; message: string; op?: number; field?: string };
    warnings: readonly string[];
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * receipt.get's result for a stored receipt, or for none: instants as ISO text, the error as A1's
 * code in `cause` (A3 3.5). The handler passes what storage's receipt lookup returned.
 */
export function receiptResult(
  stored: StoredReceiptLike | undefined,
): z.input<typeof ReceiptGetResult> {
  if (stored === undefined) return { found: false };
  const { result } = stored;
  const { error } = result;
  return {
    found: true,
    request: stored.request_id,
    status: result.status as "applied",
    decided_at: iso(stored.at),
    as_of: result.as_of,
    incarnation: stored.incarnation,
    ...(result.commit === undefined ? {} : { commit: result.commit }),
    ...(result.target === undefined ? {} : { target: result.target }),
    // A request or an import holds more operations than a reply shows: the first 50.
    results: result.results.slice(0, 50) as z.input<typeof ReceiptOpResult>[],
    ...(result.results.length > 50 ? { results_more: result.results.length - 50 } : {}),
    ...(result.conflicts.length === 0
      ? {}
      : {
          conflicts: result.conflicts.map(
            (c) => ({ ...c, at: iso(c.at) }) as z.input<typeof ReceiptConflict>,
          ),
        }),
    ...(error === undefined
      ? {}
      : {
          error: {
            cause: error.code,
            message: error.message,
            ...(error.op === undefined ? {} : { op: error.op }),
            ...(error.field === undefined ? {} : { field: error.field }),
          },
        }),
    warnings: [...result.warnings],
  };
}

export const receiptGet = defineEntry({
  name: "receipt.get",
  summary: "The stored result of a write, by its request_id, in the caller's own writer scope.",
  kind: "read",
  actors: "agent",
  scope: "space:read",
  remote: "never",
  audience: "caller",
  ops: [],
  input: ReceiptGetInput,
  output: ReceiptGetResult,
  faces: { ui: true, cli: { verb: "receipt", positional: ["request"] } },
  budget: { typical: 120, max: 4000 },
  errors: ["invalid_input", "space_unavailable"],
  examples: [
    {
      title: "A summary update whose reply was lost: its receipt",
      input: { request: requestId(11) },
      output: {
        found: true,
        request: requestId(11),
        status: "applied",
        decided_at: "2026-11-12T10:04:00.000Z",
        as_of: AS_OF,
        incarnation: "ai_5n0w8k3q7d1m9x4r2t6v0b8c3h",
        commit: "op_0r4t8w2y6a0c4e8g2j6m0p4s8v",
        results: [{ i: 0, status: "updated", id: M14.id, ref: M14.ref, version: 1046 }],
        warnings: [],
      },
    },
    {
      title: "A request ID this scope never sent",
      input: { request: requestId(12) },
      output: { found: false },
    },
    {
      title: "A stale summary update: its conflict, without the value it saw",
      input: { request: requestId(13) },
      output: {
        found: true,
        request: requestId(13),
        status: "conflict",
        decided_at: "2026-11-12T10:06:00.000Z",
        as_of: AS_OF,
        incarnation: "ai_5n0w8k3q7d1m9x4r2t6v0b8c3h",
        results: [],
        conflicts: [
          {
            op: 0,
            entity: "tasks",
            id: M14.id,
            task: M14.id,
            ref: M14.ref,
            field: "summary",
            version: 1045,
            by: { actor: "ac_3k7m1q5t9w3z7c1f5h9k3n7r1v", kind: "agent", label: "Codex · work" },
            at: "2026-11-12T09:58:00.000Z",
          },
        ],
        error: { cause: "VERSION_CONFLICT", message: "A field changed after the base: read again" },
        warnings: [],
      },
    },
  ],
});
