// task.reopen: reopen a completed or archived task (A3 3.4.9). Its MCP tool, reopen_task, arrives
// in M4.01. The previous outcome and learnings stay as the earlier result.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeText } from "../safe-text.ts";
import {
  AsOf,
  Base,
  Lifecycle,
  Mode,
  ProposalId,
  Replayed,
  RequestId,
  TaskRef,
  TaskRefInput,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

export const TaskReopenInput = z.strictObject({
  task: TaskRefInput.describe("Task ref (M-14) or ID"),
  reason: safeText(200).describe("Why it is open again"),
  base: Base,
  request_id: RequestId,
  mode: Mode,
});

export const TaskReopenResult = z.strictObject({
  result: z
    .enum(["reopened", "no_change", "proposed"])
    .describe("reopened, already active, or proposed"),
  task: TaskRef,
  lifecycle: Lifecycle,
  status: z.string().describe("Status key"),
  proposal: ProposalId.optional(),
  as_of: AsOf,
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
  defaults: [["mode", "apply"]],
  output: TaskReopenResult,
  faces: { ui: true, cli: { verb: "reopen", positional: ["task"] } },
  budget: { typical: 40, max: 150 },
  errors: ["invalid_input", "not_found", "conflict", "forbidden", "request_id_conflict"],
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
