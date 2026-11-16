// history.undo: undo the user's newest change in the space (A1 3.10.1, A5 3.12). The user's only
// (A3 3.2.3): one undo stack per human, shared by every tab and the user's CLI. It is guarded by
// each field's provenance, never by a base or a value (R2): a field another actor changed since
// makes it a conflict that names the field, unless `partial` asks to undo the rest. M3.03's
// revert and the page's toast (M5.08) build on it.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { AsOf, idPattern, patterns, Replayed, RequestId, TaskRef } from "../schemas.ts";
import { AS_OF_NEXT, requestId } from "./fixture.ts";

/** A commit (`op_` ID): what the feed's events and a write's receipt name. */
export const CommitId = z.string().regex(idPattern("op")).describe("A change's commit ID");

/** A commit the caller names: its format is the writer's to check. */
export const CommitInput = z.string().max(40);

/** One field an undo left as another actor set it (A1 3.10.1). */
export const Unresolved = z.strictObject({
  entity: z
    .string()
    .max(20)
    .describe("Table of the row: tasks, or a child such as notes or log_entries"),
  id: z
    .string()
    .max(60)
    .regex(/^[a-z]{1,2}_[0-9a-hjkmnp-tv-z]{26}(?:\|(?:s|lb)_[0-9a-hjkmnp-tv-z]{26})?$/u)
    .describe("A row other than the task: its ID, or task_id|source_id for a link")
    .optional(),
  task: TaskRef.optional(),
  field: z
    .string()
    .max(40)
    .describe("Logical field; deleted or removed for a child row, state for a run"),
  by: z.string().describe("Who changed it since: user, import or the actor's label"),
  at: z.string().regex(patterns.instant).describe("When"),
});

/** What an undo and a redo return besides their outcome. */
export const HistoryResultFields = {
  commit: CommitId.describe("The change undone or redone"),
  tasks: z.array(TaskRef).max(50).describe("The tasks it changed, the first 50"),
  // A space never holds more tasks than its references number (A1 3.3).
  task_count: z.int().min(0).max(9_999_999_999).describe("How many tasks it changed"),
  as_of: AsOf,
  replayed: Replayed.optional(),
};

export const HistoryUndoInput = z.strictObject({
  commit: CommitInput.describe(
    "The change you mean: refused when a newer one of yours stands before it",
  ).optional(),
  partial: z
    .boolean()
    .describe("Undo the fields nobody changed since, and keep the others' changes")
    .optional(),
  check_script: z
    .boolean()
    // Without commit: a conflict naming both changes instead of undoing one older than a script's.
    .describe("Undo nothing when a script changed the space after the change undone")
    .optional(),
  request_id: RequestId,
});

/**
 * The newest change a script of the same person made in the space after the change undone
 * (A3 3.7.4): it is not on the undo stack, so the person learns that this undo did not reach it.
 */
export const ScriptChange = z.strictObject({
  task: TaskRef,
  change: z
    .string()
    .regex(/^[a-z_]{1,20}\.[a-z_]{1,20}$/u)
    .describe("Its first operation's kind on the task, such as task.complete"),
  at: z.string().regex(patterns.instant).describe("When"),
});

export const HistoryUndoResult = z.strictObject({
  result: z
    .enum(["undone", "partial"])
    .describe("undone: all of it; partial: the unresolved fields stay as others set them"),
  ...HistoryResultFields,
  unresolved: z.array(Unresolved).describe("Fields left as others set them").optional(),
  script_change: ScriptChange.describe(
    "A newer change by a script, which is not on the undo stack",
  ).optional(),
});

export const historyUndo = defineEntry({
  name: "history.undo",
  summary: "Undo your newest change in the space, field by field as long as nobody changed it.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "write",
  audience: "none",
  ops: ["undo"],
  input: HistoryUndoInput,
  output: HistoryUndoResult,
  // The CLI sets check_script itself, and leaves it out for --yes.
  faces: { ui: true, cli: { verb: "undo", exclude: ["check_script"] } },
  errors: ["invalid_input", "not_found", "conflict", "forbidden", "request_id_conflict"],
  examples: [
    {
      title: "Undo the check-off of M-15",
      actor: "user",
      input: { request_id: requestId(40) },
      output: {
        result: "undone",
        commit: "op_6h2k8m4p0r6t2v8x4z0b6d2f8j",
        tasks: ["M-15"],
        task_count: 1,
        as_of: AS_OF_NEXT,
      },
    },
  ],
});
