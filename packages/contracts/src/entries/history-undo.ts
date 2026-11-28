// history.undo: undo the user's newest step in the space (A1 3.10.1, A5 3.12). The user's only
// (A3 3.2.3): one undo stack per human, shared by every tab and the user's CLI. A step is what Undo
// is for: a check-off or a reopen, the Trash and out of it, a removed note, words, out of the
// Inbox, a first filing, questions set aside, a new area or project, an unarchive. A change since to
// what it wrote, or another actor's work on what it would take out of sight, keeps the step as it
// is: `kept`, and the next undo reaches the step before it.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { WriteAsOf, idPattern, patterns, Replayed, RequestId, TaskRef } from "../schemas.ts";
import { AS_OF_NEXT, requestId } from "./fixture.ts";

/** A commit (`op_` ID): what the feed's events and a write's receipt name. */
export const CommitId = z.string().regex(idPattern("op")).describe("A change's commit ID");

/** A commit the caller names: its format is the writer's to check. */
export const CommitInput = z.string().max(40);

/** One author who changed one task since the change (A1 3.10.1): who, and when last. */
export const NewerWork = z.strictObject({
  task: TaskRef.describe("The task; absent for an area, a project or a source").optional(),
  by: z.string().describe("Who: user, import, run (a run's own progress) or the actor's label"),
  at: z.string().regex(patterns.instant).describe("When that author last changed it"),
});

/** Who changed what a kept undo or redo would have changed: one entry per task and author. */
export const NewerWorkFields = {
  newer_work: z
    .array(NewerWork)
    .describe("Who changed which task since, one entry per task and author")
    .optional(),
};

/** What an undo and a redo return besides their outcome. */
export const HistoryResultFields = {
  commit: CommitId.describe("The change undone or redone"),
  tasks: z.array(TaskRef).max(50).describe("The tasks it changed, the first 50"),
  // A space never holds more tasks than its references number.
  task_count: z.int().min(0).max(9_999_999_999).describe("How many tasks it changed"),
  lifecycles: z
    .array(TaskRef)
    .max(50)
    .describe("The tasks it checked off or reopened, the first 50")
    .optional(),
  why: z
    .string()
    .max(200)
    .describe("kept: why it cannot be applied now, such as a task in the Trash")
    .optional(),
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
};

export const HistoryUndoInput = z.strictObject({
  commit: CommitInput.describe(
    "The change you mean: refused when a newer one of yours stands before it",
  ).optional(),
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
    .enum(["undone", "kept"])
    .describe("undone: back as before; kept: someone changed it since, and it stays theirs"),
  ...HistoryResultFields,
  ...NewerWorkFields,
  script_change: ScriptChange.describe(
    "A newer change by a script, which is not on the undo stack",
  ).optional(),
});

export const historyUndo = defineEntry({
  name: "history.undo",
  summary:
    "Undo your newest check-off, Trash, removed note, text edit or filing, unless someone changed it since.",
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
  errors: [
    "invalid_input",
    "not_found",
    "conflict",
    "forbidden",
    "request_id_conflict",
    "applied_earlier",
  ],
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
