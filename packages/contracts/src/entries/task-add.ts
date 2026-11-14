// task.add: create 1 to 25 tasks in one transaction, upserting by source key (A3 3.4.5). Its MCP
// tool, add_tasks, arrives with the upsert in M4.01. Until then the CLI and the UI use the entry.
import { z } from "zod";
import { defineEntry, under } from "../define.ts";
import {
  AsOf,
  Cwd,
  DRAFT_AGENT_MAX,
  Lifecycle,
  Mode,
  ProposalId,
  Replayed,
  RequestId,
  TaskDraft,
  TaskId,
  TaskRef,
  Warnings,
} from "../schemas.ts";
import { AS_OF_NEXT, M14, M31, PORTAL, requestId } from "./fixture.ts";

export const TaskAddInput = z.strictObject({
  tasks: z.array(TaskDraft).min(1).max(25).describe("The tasks to create, 1 to 25"),
  request_id: RequestId,
  mode: Mode,
  cwd: Cwd.optional(),
});

export const TaskAddResult = z.strictObject({
  as_of: AsOf,
  tasks: z
    .array(
      z.strictObject({
        result: z
          .enum(["created", "exists", "proposed", "inbox"])
          .describe("created, matched an existing task, proposed, or created in the Inbox"),
        id: TaskId.optional(),
        ref: TaskRef.optional(),
        title: z.string().describe("Title"),
        lifecycle: Lifecycle.optional(),
        matched_by: z.enum(["source_key"]).describe("How an existing task matched").optional(),
        ambiguous: z.array(TaskRef).describe("Several active matches: pick one").optional(),
        log_added: z.boolean().describe("The draft's log entry was added"),
      }),
    )
    .describe("One row per draft, in order"),
  warnings: Warnings,
  proposal: ProposalId.optional(),
  replayed: Replayed.optional(),
});

export const taskAdd = defineEntry({
  name: "task.add",
  summary: "Create 1 to 25 tasks in one transaction. A draft whose source key matches returns it.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: ["task.create", "log.add", "source.add", "place.set"],
  input: TaskAddInput,
  agent: { max: under("tasks[]", DRAFT_AGENT_MAX) },
  defaults: [["mode", "apply"]],
  output: TaskAddResult,
  faces: {
    ui: true,
    cli: { verb: "add", positional: ["title"], item: "tasks", short: { priority: "p" } },
  },
  budget: { typical: 80, max: 1500 },
  errors: ["invalid_input", "too_large", "forbidden", "request_id_conflict"],
  examples: [
    {
      title: "A follow-up found during work, and a ticket that already has a task",
      input: {
        tasks: [
          {
            title: "Check the mobile app for the same time zone bug",
            area: "Client work",
            project: "Lumen Health",
            priority: 2,
          },
          {
            title: "Fix appointment time zones",
            sources: [
              {
                key: "jira:LUM-212",
                kind: "ticket",
                title: "Appointment times shift by an hour",
              },
            ],
            log: "Seen again in the 11-12 clinic export.",
          },
        ],
        request_id: requestId(1),
        cwd: PORTAL,
      },
      output: {
        as_of: AS_OF_NEXT,
        tasks: [
          {
            result: "created",
            ...M31,
            title: "Check the mobile app for the same time zone bug",
            lifecycle: "active",
            log_added: false,
          },
          {
            result: "exists",
            ...M14,
            title: "Fix appointment time zones",
            lifecycle: "active",
            matched_by: "source_key",
            log_added: true,
          },
        ],
        warnings: ["M-31: possible duplicate of M-14 (same project, similar title)"],
      },
    },
  ],
});
