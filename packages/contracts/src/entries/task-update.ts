// task.update: change an active task's fields, summary, context, group and sources (A3 3.4.6).
import { z } from "zod";
import { defineEntry, under } from "../define.ts";
import { safeLine, safeText } from "../safe-text.ts";
import {
  AGENT_LIMITS,
  AsOf,
  Base,
  ContextInput,
  Cwd,
  FolderInput,
  Mode,
  Priority,
  ProposalId,
  Replayed,
  RequestId,
  SOURCE_AGENT_MAX,
  SourceInput,
  SummaryInput,
  TaskRef,
  TaskRefInput,
  TitleInput,
  USER_LIMITS,
  Warnings,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

const CLEARABLE = ["summary", "priority", "effort", "due", "waiting_on", "folder", "focus"] as const;

export const TaskUpdateInput = z.strictObject({
  task: TaskRefInput.describe("Task ref (M-14) or ID; default: the bound task").optional(),
  set: z
    .strictObject({
      title: TitleInput.describe("Title").optional(),
      summary: SummaryInput.describe("One line: the next step").optional(),
      status: safeLine(40).describe("A status of the space").optional(),
      inbox: z.boolean().describe("In the Inbox").optional(),
      priority: Priority.describe("1 highest, 4 none").optional(),
      effort: safeLine(20).describe("Effort").optional(),
      due: safeLine(40).describe("ISO date or phrase: fri, +3d").optional(),
      waiting_on: safeLine(80).describe("Who or what it waits on").optional(),
      area: safeLine(120).describe("Area name or slug").optional(),
      project: safeLine(120).describe("Project name or slug").optional(),
      folder: FolderInput.describe('"cwd", an absolute folder or one under ~').optional(),
      focus: z.boolean().describe("Star it for today, only when the user asks").optional(),
    })
    .describe("Fields to change")
    .optional(),
  clear: z.array(z.enum(CLEARABLE)).max(7).describe("Fields to clear").optional(),
  context: z
    .strictObject({
      mode: z.enum(["append", "replace"]).describe("append needs no base"),
      text: ContextInput.describe("Markdown"),
    })
    .describe("Change the context")
    .optional(),
  add_sources: z.array(SourceInput).max(10).describe("Sources to link").optional(),
  remove_sources: z
    .array(z.string().max(USER_LIMITS.url))
    .max(10)
    .describe("Source keys or URLs to unlink")
    .optional(),
  base: Base.optional(),
  reason: safeText(200).describe("Why, shown in history and proposals").optional(),
  request_id: RequestId,
  mode: Mode,
  cwd: Cwd.optional(),
});

export const TaskUpdateResult = z.strictObject({
  result: z
    .enum(["updated", "no_change", "review", "proposed"])
    .describe("updated, nothing changed, applied with a review mark, or proposed"),
  task: TaskRef,
  fields: z.array(z.string()).describe("The fields the call changed"),
  as_of: AsOf,
  proposal: ProposalId.optional(),
  warnings: Warnings,
  replayed: Replayed.optional(),
});

export const taskUpdate = defineEntry({
  name: "task.update",
  summary: "Change an active task's fields, summary, context, group or sources.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: [
    "task.patch",
    "task.context_append",
    "task.move",
    "source.add",
    "source.unlink",
    "task.folder_set",
    "task.folder_clear",
    // A new area or project name creates it, in the same commit as the move into it.
    "area.create",
    "project.create",
  ],
  input: TaskUpdateInput,
  agent: {
    max: [
      ["set.title", AGENT_LIMITS.title],
      ["set.summary", AGENT_LIMITS.summary],
      ["context.text", AGENT_LIMITS.context],
      ...under("add_sources[]", SOURCE_AGENT_MAX),
    ],
  },
  defaults: [["mode", "apply"]],
  output: TaskUpdateResult,
  faces: {
    ui: true,
    cli: {
      verb: "set",
      positional: ["task"],
      keyValue: "set",
      flags: { remove_sources: "remove-source" },
    },
    mcp: {
      tool: "update_task",
      title: "Update a task",
      description:
        "Use to change a task's fields, summary, context, group or sources. Pass base: the " +
        "as_of of your last read; a context append needs none. Set focus or priority only " +
        "when the user asks. Use complete_task to finish. proposed and review results are " +
        "normal: do not retry.",
    },
  },
  budget: { typical: 80, max: 400 },
  errors: [
    "invalid_input",
    "not_found",
    "unbound",
    "conflict",
    "forbidden",
    "wrong_tool",
    "request_id_conflict",
  ],
  examples: [
    {
      title: "Update the summary and append to the context of M-14",
      input: {
        task: "M-14",
        set: { summary: "Store UTC plus the clinic's zone ID, then convert once" },
        context: {
          mode: "append",
          text: "The export converts twice: once in the API and once in the report.",
        },
        base: AS_OF,
        request_id: requestId(2),
      },
      output: {
        result: "updated",
        task: "M-14",
        fields: ["summary", "context"],
        as_of: AS_OF_NEXT,
        warnings: [],
      },
    },
  ],
});
