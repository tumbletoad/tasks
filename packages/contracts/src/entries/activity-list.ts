// activity.list: what agents and routines did in the space, one line per change they made, newest
// first, for the page's Activity screen. A line is a commit: who, when, the tasks it touched and
// what it did to them, as the operations and the fields they set. The page words each line; a field
// of text says that it changed, never what it says now. Read by commit number, a page at a time:
// `before` reads further back, `after` the lines that came since.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { TaskId } from "../schemas.ts";
import { M14 } from "./fixture.ts";

const Seq = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ActivityListInput = z.strictObject({
  before: Seq.describe("Lines of changes before this commit number").optional(),
  after: Seq.describe("Lines of changes after this commit number").optional(),
  limit: z.int().min(1).max(200).describe("Lines per page; default 50").optional(),
});

/** A value a line shows: a field's value that is no text, or the name of an area or project. */
export const ActivityValue = z.union([
  z.string().max(300),
  z.number().min(-8_640_000_000_000_000).max(8_640_000_000_000_000),
  z.boolean(),
  z.null(),
]);

/** One thing a change did: an operation, and for a task's field the value before and after. */
export const ActivityAct = z.strictObject({
  op: z.string().max(60).describe("The operation, such as task.patch or note.add"),
  field: z.string().max(60).describe("The task's field it set").optional(),
  from: ActivityValue.describe("The value before, when it is no text").optional(),
  to: ActivityValue.describe(
    "The value after, when it is no text; for a move or a create, its project or area",
  ).optional(),
});

/** A task a line touched, as it is now. */
export const ActivityTask = z.strictObject({
  id: TaskId,
  ref: z.string().max(20).describe("Its reference, such as M-14"),
  title: z.string().max(1000).describe("Its title now"),
  trash: z.literal(true).describe("It is in the Trash now").optional(),
});

export const ActivityLine = z.strictObject({
  seq: Seq.describe("The change's commit number"),
  at: z.int().min(0).max(8_640_000_000_000_000).describe("When, milliseconds since 1970"),
  actor: z.enum(["agent", "routine"]).describe("Who made it: an agent or a routine"),
  by: z.string().max(200).describe("The actor's label, such as agent:codex"),
  kind: z
    .string()
    .max(40)
    .describe("The change's kind when it is no plain change: undo, redo")
    .optional(),
  tasks: z.array(ActivityTask).max(3).describe("The first tasks it touched"),
  count: z.int().min(0).max(1_000_000).describe("How many tasks it touched"),
  acts: z.array(ActivityAct).max(40).describe("What it did, in order"),
});

export const ActivityListResult = z.strictObject({
  lines: z.array(ActivityLine).describe("Newest first"),
  more: z
    .boolean()
    .describe("More lines lie past this page: older ones, or with `after`, newer ones"),
});

export const activityList = defineEntry({
  name: "activity.list",
  summary: "What agents and routines did in the space, one line per change, newest first.",
  kind: "read",
  actors: "user",
  scope: "space:read",
  remote: "read",
  audience: "caller",
  ops: [],
  input: ActivityListInput,
  output: ActivityListResult,
  defaults: [["limit", 50]],
  faces: { ui: true },
  errors: ["invalid_input", "space_unavailable", "forbidden"],
  examples: [
    {
      title: "What agents did lately",
      actor: "user",
      input: { limit: 1 },
      output: {
        lines: [
          {
            seq: 1047,
            at: 1_778_580_000_000,
            actor: "agent",
            by: "agent:codex",
            tasks: [{ ...M14, title: "Fix appointment time zones" }],
            count: 1,
            acts: [
              { op: "task.patch", field: "priority", from: 2, to: 1 },
              { op: "task.patch", field: "due", from: null, to: "2026-12-03" },
            ],
          },
        ],
        more: true,
      },
    },
  ],
});
