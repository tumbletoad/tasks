// task.delete: move tasks to the Trash, or bring them back. Nothing is deleted for good: every row
// and its history stay, and nothing empties the Trash. A restore brings a task back as it was,
// except a link whose key another active task took meanwhile, which stays there, and a project or
// area that is gone, for which it lands in the area or the Inbox. For the person only: agents
// remove nothing yet.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeText } from "../safe-text.ts";
import {
  WriteAsOf,
  Base,
  Replayed,
  RequestId,
  SourceId,
  TaskRef,
  TaskRefInput,
  TaskRow,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";
import { CommitId, CommitInput } from "./history-undo.ts";

/** The most tasks one request moves: one change, which one Restore takes back. */
export const DELETE_MAX = 100;

export const TaskDeleteInput = z.strictObject({
  tasks: z
    .array(TaskRefInput.describe("Task ref (M-14) or ID"))
    .max(DELETE_MAX)
    .describe("The tasks")
    .optional(),
  restore: z.boolean().describe("Bring the tasks back from the Trash").optional(),
  change: CommitInput.describe(
    "With restore: bring back what this change moved to the Trash and is still there",
  ).optional(),
  reason: safeText(200).describe("Why, for the history").optional(),
  base: Base.optional(),
  request_id: RequestId,
});

/**
 * A task back from the Trash: where it is back, as its change left it (a retry says the same,
 * whatever happened since), and what of it stayed removed.
 */
export const RestoredTask = TaskRow.pick({
  id: true,
  ref: true,
  lifecycle: true,
  status: true,
  inbox: true,
  area: true,
  project: true,
}).extend({
  regrouped: z
    .enum(["area", "inbox"])
    .describe("Its project or area was gone: it went to the area, or to the Inbox")
    .optional(),
  held: z
    .array(
      z.strictObject({
        source: SourceId,
        by: TaskRef.describe("The task that took its key meanwhile: captures go there"),
      }),
    )
    .max(50)
    .describe("Its links that stayed removed")
    .optional(),
});

export const TaskDeleteResult = z.strictObject({
  result: z
    .enum(["moved", "restored", "no_change"])
    .describe("moved to the Trash, restored from it, or every task was there already"),
  moved: z.array(TaskRef).max(DELETE_MAX).describe("The tasks this moved"),
  already: z
    .array(TaskRef)
    .max(DELETE_MAX)
    .describe("Tasks that were where you asked already: in the Trash, or back")
    .optional(),
  later: z
    .array(TaskRef)
    .max(DELETE_MAX)
    .describe("Tasks of the change in the Trash from a later change, which restores them")
    .optional(),
  restored: z.array(RestoredTask).max(DELETE_MAX).describe("Where each is back").optional(),
  commit: CommitId.describe("The change, which Undo names").optional(),
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
});

export const taskDelete = defineEntry({
  name: "task.delete",
  summary: "Move tasks to the Trash, or restore them. Nothing is deleted for good.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: ["task.delete", "task.restore"],
  input: TaskDeleteInput,
  output: TaskDeleteResult,
  faces: {
    ui: true,
    cli: [
      { verb: "delete", positional: ["tasks"], exclude: ["restore", "change"] },
      { verb: "restore", positional: ["tasks"], fixed: { restore: true } },
    ],
  },
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
      title: "Move two duplicates to the Trash",
      actor: "user",
      input: { tasks: ["M-12", "M-13"], base: AS_OF, request_id: requestId(70) },
      output: {
        result: "moved",
        moved: ["M-12", "M-13"],
        commit: "op_4k8m2p6r0t4w8y2b6d0f4h8k2m",
        as_of: AS_OF_NEXT,
      },
    },
    {
      title: "Bring M-12 back",
      actor: "user",
      input: { tasks: ["M-12"], restore: true, base: AS_OF, request_id: requestId(71) },
      output: {
        result: "restored",
        moved: ["M-12"],
        restored: [
          {
            id: "t_9b3d7f1h5k9m3p7r1t5w9y3a7c",
            ref: "M-12",
            lifecycle: "active",
            status: "open",
            inbox: false,
          },
        ],
        commit: "op_6m0p4r8t2w6y0b4d8f2h6k0m4p",
        as_of: AS_OF_NEXT,
      },
    },
  ],
});
