// task.reopen: reopen a completed or archived task (A3 3.4.9). Its MCP tool is reopen_task. The
// previous outcome and learnings stay as the earlier result.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeText } from "../safe-text.ts";
import {
  WriteAsOf,
  Base,
  Lifecycle,
  Mode,
  ProposalId,
  Replayed,
  RequestId,
  TaskRef,
  SessionTask,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

export const TaskReopenInput = z.strictObject({
  task: SessionTask,
  reason: safeText(200).describe("Why it is open again").optional(),
  base: Base,
  request_id: RequestId,
  mode: Mode,
});

export const TaskReopenResult = z.strictObject({
  result: z.enum(["reopened", "no_change", "proposed"]).describe("reopened, or already active"),
  task: TaskRef,
  lifecycle: Lifecycle,
  status: z.string().describe("Status key"),
  proposal: ProposalId.optional(),
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
});

export const taskReopen = defineEntry({
  name: "task.reopen",
  summary: "Reopen a completed or archived task. Its earlier outcome and learnings stay.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: ["task.reopen"],
  input: TaskReopenInput,
  // A person's click has no words to give; an agent says why, for the person who reads the history.
  agent: { required: ["reason"] },
  defaults: [["mode", "apply"]],
  output: TaskReopenResult,
  faces: {
    ui: true,
    cli: { verb: "reopen", positional: ["task"] },
    mcp: {
      tool: "reopen_task",
      title: "Reopen a finished task",
      description:
        "Use when a completed or archived task needs work again, instead of adding a new one. Its earlier outcome and learnings stay. Pass a reason, and base: the as_of of your last get_task, or of your complete_task or reopen_task of it. update_task changes only active tasks.",
    },
  },
  budget: { typical: 40, max: 150 },
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
      title: "Reopen M-3 when its bug comes back",
      input: {
        task: "M-3",
        reason: "The DST bug is back in the April reports.",
        base: AS_OF,
        request_id: requestId(7),
      },
      output: {
        result: "reopened",
        task: "M-3",
        lifecycle: "active",
        status: "open",
        as_of: AS_OF_NEXT,
      },
    },
  ],
});
