// task.finish: finish or abandon a task with an outcome and learnings, create follow-ups in the
// same request, or wrap up a task the user checked off (A3 3.4.8). The user checks a task off
// without an outcome. Agents must give one (A3 3.2.3).
import { z } from "zod";
import { defineEntry, under } from "../define.ts";
import { safeText } from "../safe-text.ts";
import {
  AGENT_LIMITS,
  AsOf,
  Base,
  Cwd,
  DRAFT_AGENT_MAX,
  HeldSources,
  Lifecycle,
  Mode,
  PastInput,
  ProposalId,
  Replayed,
  RequestId,
  TaskDraft,
  TaskRef,
  TaskRefInput,
  USER_LIMITS,
  Warnings,
  WrapState,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

export const TaskFinishInput = z.strictObject({
  task: TaskRefInput.describe("Task ref (M-14) or ID; default: the bound task").optional(),
  status: z.enum(["done", "dropped"]).describe("dropped: abandoned").optional(),
  outcome: safeText(USER_LIMITS.outcome)
    .describe("What changed and the evidence; agents must give it")
    .optional(),
  learnings: z
    .array(safeText(USER_LIMITS.learning))
    .max(USER_LIMITS.learnings)
    .describe("Lessons reusable beyond this task")
    .optional(),
  follow_ups: z.array(TaskDraft).max(10).describe("Tasks to create, as for task.add").optional(),
  finished: PastInput.describe(
    "When it was done, only for work done before it was recorded: ISO date or instant",
  ).optional(),
  base: Base,
  request_id: RequestId,
  mode: Mode,
  cwd: Cwd.optional(),
});

export const TaskFinishResult = z.strictObject({
  result: z
    .enum(["completed", "no_change", "review", "proposed"])
    .describe("completed, already so, waiting for the user's check-off, or proposed"),
  task: TaskRef,
  lifecycle: Lifecycle,
  wrap_state: WrapState.optional(),
  learnings: z.int().min(0).max(USER_LIMITS.learnings).describe("Learnings recorded"),
  follow_ups: z
    .array(
      z.strictObject({
        result: z.enum(["created", "exists", "proposed"]).describe("What happened to the draft"),
        ref: TaskRef.optional(),
        title: z.string().describe("Title"),
        held: HeldSources.optional(),
      }),
    )
    .describe("One row per follow-up draft"),
  warnings: Warnings.optional(),
  proposal: ProposalId.optional(),
  as_of: AsOf,
  replayed: Replayed.optional(),
});

export const taskFinish = defineEntry({
  name: "task.finish",
  summary: "Finish or abandon a task with an outcome and learnings, and create its follow-ups.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  // A follow-up is a task draft, as for task.add: its log entry, sources and folder too.
  ops: [
    "task.complete",
    "task.archive",
    "task.wrap_up",
    "task.create",
    "log.add",
    "source.add",
    "task.folder_set",
    // A follow-up's new area or project name creates it, in the same commit.
    "area.create",
    "project.create",
  ],
  input: TaskFinishInput,
  agent: {
    required: ["outcome"],
    max: [
      ["outcome", AGENT_LIMITS.outcome],
      ["learnings", AGENT_LIMITS.learnings],
      ["learnings[]", AGENT_LIMITS.learning],
      ...under("follow_ups[]", DRAFT_AGENT_MAX),
    ],
  },
  defaults: [
    ["status", "done"],
    ["mode", "apply"],
  ],
  output: TaskFinishResult,
  faces: {
    ui: true,
    cli: { verb: "done", positional: ["task"], flags: { learnings: "learning" } },
    mcp: {
      tool: "complete_task",
      title: "Complete a task",
      description:
        "Use when a task is done or dropped: records the outcome and learnings and creates " +
        "follow-ups in one call. Also wraps up a task the user checked off. Pass base. A " +
        "review or proposed result is normal: the user decides.",
    },
  },
  budget: { typical: 100, max: 1500 },
  errors: ["invalid_input", "not_found", "unbound", "conflict", "forbidden", "request_id_conflict"],
  examples: [
    {
      title: "Complete M-14 with a learning and a follow-up",
      input: {
        task: "M-14",
        outcome:
          "Times are stored as UTC plus the clinic's zone ID and converted once. The 11-12 export matches the clinic's calendar.",
        learnings: ["Always store UTC plus the clinic's zone ID, never local times."],
        follow_ups: [
          {
            title: "Check the mobile app for the same time zone bug",
            project: "Lumen Health",
          },
        ],
        base: AS_OF,
        request_id: requestId(5),
      },
      output: {
        result: "completed",
        task: "M-14",
        lifecycle: "completed",
        wrap_state: "wrapped",
        learnings: 1,
        follow_ups: [
          {
            result: "created",
            ref: "M-31",
            title: "Check the mobile app for the same time zone bug",
          },
        ],
        as_of: AS_OF_NEXT,
      },
    },
    {
      title: "The user checks M-15 off without an outcome",
      actor: "user",
      input: { task: "M-15", base: AS_OF, request_id: requestId(6) },
      output: {
        result: "completed",
        task: "M-15",
        lifecycle: "completed",
        wrap_state: "pending",
        learnings: 0,
        follow_ups: [],
        as_of: AS_OF_NEXT,
      },
    },
  ],
});
