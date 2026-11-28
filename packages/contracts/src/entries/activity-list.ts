// activity.list: what agents and routines did in the space, one line per change they made, newest
// first, for the page's Activity screen. A line is a commit: who, when, and each thing it touched
// (a task, a project or an area) with what it did to that thing, as the operations and the fields
// they set. The page words each line; a field of free text says that it changed, never what it
// says. Read by commit number, a page at a time: `before` reads further back, `after` the lines
// that came since.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { M14 } from "./fixture.ts";

const Seq = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ActivityListInput = z.strictObject({
  before: Seq.describe("Lines of changes before this commit number").optional(),
  after: Seq.describe("Lines of changes after this commit number").optional(),
  limit: z.int().min(1).max(200).describe("Lines per page; default 50").optional(),
});

/** A value a line shows: a field's value that is no free text, or the name of an area or project. */
export const ActivityValue = z.union([
  z.string().max(300),
  z.number().min(-8_640_000_000_000_000).max(8_640_000_000_000_000),
  z.boolean(),
  z.null(),
]);

/** One thing a change did to its target: an operation, and for a field the value before and after. */
export const ActivityAct = z.strictObject({
  op: z.string().max(60).describe("The operation, such as task.patch or note.add"),
  field: z.string().max(60).describe("The field of the target it set").optional(),
  from: ActivityValue.describe("The value before, when it is no free text").optional(),
  to: ActivityValue.describe(
    "The value after, when it is no free text; for a create, where it was made",
  ).optional(),
});

/** A thing a change touched, as it is now, with what the change did to it. */
export const ActivityTarget = z.strictObject({
  kind: z.enum(["task", "project", "area", "page"]).describe("What it is"),
  id: z.string().max(40).describe("Its ID"),
  name: z.string().max(1000).describe("Its title or name now"),
  ref: z.string().max(20).describe("A task's or a page's reference, such as M-14").optional(),
  trash: z.literal(true).describe("It is in the Trash now").optional(),
  created: z.literal(true).describe("The change made it").optional(),
  acts: z.array(ActivityAct).max(40).describe("What the change did to it, in order"),
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
  targets: z.array(ActivityTarget).max(50).describe("What it touched, in order"),
  count: z.int().min(0).max(1_000_000).describe("How many things it touched"),
  acts: z
    .array(ActivityAct)
    .max(40)
    .describe("What it did that touched no task, project or area, such as a setting"),
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
            targets: [
              {
                kind: "task",
                id: M14.id,
                ref: M14.ref,
                name: "Fix appointment time zones",
                acts: [
                  { op: "task.patch", field: "priority", from: 2, to: 1 },
                  { op: "task.patch", field: "due", from: null, to: "2026-12-03" },
                ],
              },
            ],
            count: 1,
            acts: [],
          },
        ],
        more: true,
      },
    },
  ],
});
