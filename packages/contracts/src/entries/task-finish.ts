// task.finish: finish or abandon a task with an outcome and the pages it updated, create
// follow-ups in the same request, or wrap up a task the user checked off (A3 3.4.8). The user checks
// a task off without an outcome or pages. Agents give both (A3 3.2.3), but for a session that began
// before the library, which still gives its lessons.
import { z } from "zod";
import { defineEntry, under } from "../define.ts";
import { safeText } from "../safe-text.ts";
import { FinishLibrary } from "../pages.ts";
import {
  AGENT_LIMITS,
  WriteAsOf,
  Base,
  Cwd,
  DRAFT_AGENT_MAX,
  HeldSources,
  Lifecycle,
  LogAdded,
  LogLeftOut,
  Mode,
  PastInput,
  ProposalId,
  Replayed,
  RequestId,
  SeveralMatch,
  TaskDraft,
  TaskRef,
  SessionTask,
  USER_LIMITS,
  Warnings,
  WrapState,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

export const TaskFinishInput = z.strictObject({
  task: SessionTask,
  status: z.enum(["done", "dropped"]).describe("dropped: abandoned").optional(),
  outcome: safeText(USER_LIMITS.outcome)
    .describe(
      `What changed and the evidence; agents must give it, in at most ${String(AGENT_LIMITS.outcome)} characters`,
    )
    .optional(),
  library: FinishLibrary.optional(),
  // A session that began before the library still finishes with its lessons.
  learnings: z
    .array(safeText(USER_LIMITS.learning))
    .max(USER_LIMITS.learnings)
    .describe("Before library: lessons beyond this task; give library instead")
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
    .describe("completed, or already so"),
  task: TaskRef,
  lifecycle: Lifecycle,
  wrap_state: WrapState.optional(),
  learnings: z.int().min(0).max(USER_LIMITS.learnings).describe("Learnings recorded"),
  library: FinishLibrary.describe(
    "The pages it says it updated, as kept below the outcome",
  ).optional(),
  follow_ups: z
    .array(
      z.strictObject({
        result: z.enum(["created", "exists", "proposed"]).describe("What happened to the draft"),
        ref: TaskRef.optional(),
        title: z.string().describe("Its title now; absent when it could not be read").optional(),
        project: z.string().describe("Its project now; absent when in none").optional(),
        folder_of: z
          .array(z.string())
          .max(1000)
          .describe("The projects that share its folder, when it joined none of them")
          .optional(),
        lifecycle: Lifecycle.describe("The matched task's lifecycle").optional(),
        ambiguous: SeveralMatch.optional(),
        log_added: LogAdded,
        log_left_out: LogLeftOut.optional(),
        held: HeldSources.optional(),
      }),
    )
    .describe("One row per follow-up draft"),
  warnings: Warnings.optional(),
  proposal: ProposalId.optional(),
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
});

export const taskFinish = defineEntry({
  name: "task.finish",
  summary: "Finish or abandon a task with an outcome and the pages it updated, and its follow-ups.",
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
    cli: { verb: "done", positional: ["task"], exclude: ["learnings", "library"] },
    mcp: {
      tool: "complete_task",
      title: "Complete a task",
      description:
        "Use when a task is done or dropped: records the outcome and the pages you updated (or " +
        '"nothing reusable") and creates follow-ups. Also wraps up a task the user checked off. ' +
        "Pass base: the as_of of your last get_task, add_tasks, complete_task or reopen_task of it.",
    },
  },
  budget: { typical: 100, max: 1500 },
  errors: [
    "invalid_input",
    "not_found",
    "unbound",
    "conflict",
    "forbidden",
    "request_id_conflict",
    "applied_earlier",
  ],
  examples: [
    {
      title: "Complete M-14 with a follow-up: nothing of it is for the library",
      input: {
        task: "M-14",
        outcome:
          "Times are stored as UTC plus the clinic's zone ID and converted once. The 11-12 export matches the clinic's calendar.",
        library: "nothing reusable",
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
        learnings: 0,
        library: "nothing reusable",
        follow_ups: [
          {
            result: "created",
            ref: "M-31",
            title: "Check the mobile app for the same time zone bug",
            log_added: false,
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
