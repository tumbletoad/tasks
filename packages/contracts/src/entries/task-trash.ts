// task.trash: what is in the Trash, a page at a time. The Trash holds the tasks someone moved
// there on purpose: an undone creation is not in it, and Redo brings that back with its notes and
// links. Rows come newest change first, then by task, each with the change that moved it, so the
// page groups them by change and "Restore these" takes back exactly that change's tasks still
// there. The cursor is a key (the change's seq and the task's reference), so a task moved or restored
// while the list is open neither repeats nor skips a row of the next page. Words or a reference
// find an old one across every page.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeLine } from "../safe-text.ts";
import { CompactTaskRow, patterns, TaskId } from "../schemas.ts";
import { CommitId } from "./history-undo.ts";

/** Where the next page starts: the last row's change seq and its reference's number. */
export const TRASH_CURSOR = /^[0-9]{1,16}\.[0-9]{1,10}$/u;

export const TaskTrashInput = z.strictObject({
  q: safeLine(200).describe("Words of a title, or a reference such as M-14").optional(),
  working: z
    .boolean()
    .describe("Only tasks an agent works on: a run, or a terminal agent here not ended")
    .optional(),
  tasks: z
    .array(TaskId.max(40))
    .max(200)
    .describe("Only these tasks, such as those the Agent Monitor links an agent to")
    .optional(),
  limit: z.int().min(1).max(200).describe("Rows per page; default 50").optional(),
  cursor: z.string().max(60).describe("Next page: the last page's cursor").optional(),
});

/** The change that moved a task to the Trash. */
export const TrashChange = z.strictObject({
  id: CommitId,
  at: z.string().regex(patterns.instant).describe("When"),
  by: z.string().describe("Who: user, import or the actor's label"),
  reason: z.string().describe("Why, when it was given").optional(),
  count: z.int().min(1).max(1_000_000).describe("How many of its tasks are in the Trash now"),
});

/** A task in the Trash: its row, where it was, and the change that moved it there. */
export const TrashRow = CompactTaskRow.extend({
  area: z.string().describe("Its area's name, a deleted one too").optional(),
  project: z.string().describe("Its project's name, a deleted one too").optional(),
  terminals: z
    .int()
    .min(1)
    .max(1_000_000)
    .describe("Its terminal agents on this computer not ended: stop them there")
    .optional(),
  removed: TrashChange.describe("The change that moved it to the Trash"),
});

export const TaskTrashResult = z.strictObject({
  rows: z.array(TrashRow).describe("Newest change first, then by task"),
  cursor: z.string().regex(TRASH_CURSOR).describe("Pass it for the next page").optional(),
});

export const taskTrash = defineEntry({
  name: "task.trash",
  summary: "What is in the Trash, newest change first, a page at a time.",
  kind: "read",
  actors: "user",
  scope: "space:read",
  remote: "read",
  audience: "caller",
  ops: [],
  input: TaskTrashInput,
  output: TaskTrashResult,
  defaults: [["limit", 50]],
  // `working` and `tasks` are the Agents page's: a person reads the Trash by words or reference.
  faces: { ui: true, cli: { verb: "trash", positional: ["q"], exclude: ["working", "tasks"] } },
  errors: ["invalid_input", "space_unavailable", "forbidden"],
  examples: [
    {
      title: "What is in the Trash",
      actor: "user",
      input: {},
      output: {
        rows: [
          {
            id: "t_8c2e6g0j4m8p2s6v0x4z8b2d6f",
            ref: "M-13",
            title: "Call the clinic about the invoice",
            lifecycle: "active",
            status: "open",
            inbox: false,
            position: "a1",
            deleted_at: 1_778_580_000_000,
            created_at: 1_778_000_000_000,
            version: 1047,
            removed: {
              id: "op_4k8m2p6r0t4w8y2b6d0f4h8k2m",
              at: "2026-11-12T10:00:00.000Z",
              by: "user",
              count: 1,
            },
          },
        ],
      },
    },
  ],
});
