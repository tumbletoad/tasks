// task.add: create 1 to 25 tasks in one transaction, upserting by source key (A3 3.4.5). Its MCP
// tool is add_tasks. Areas and projects match by name or slug, ignoring case, and an agent's task
// without either goes to the Inbox.
import { z } from "zod";
import { defineEntry, under } from "../define.ts";
import {
  AsOf,
  Cwd,
  DRAFT_AGENT_MAX,
  HeldSources,
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
          .describe("created, matched an existing task, or created in the Inbox"),
        id: TaskId.optional(),
        ref: TaskRef.optional(),
        title: z.string().describe("Title"),
        lifecycle: Lifecycle.optional(),
        matched_by: z.enum(["source_key"]).describe("How an existing task matched").optional(),
        ambiguous: z.array(TaskRef).describe("Several active matches: pick one").optional(),
        log_added: z.boolean().describe("The draft's log entry was added"),
        held: HeldSources.optional(),
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
  // A new area or project name creates it, in the same commit as the drafts that name it.
  ops: ["task.create", "log.add", "source.add", "task.folder_set", "area.create", "project.create"],
  input: TaskAddInput,
  agent: { max: under("tasks[]", DRAFT_AGENT_MAX) },
  defaults: [["mode", "apply"]],
  output: TaskAddResult,
  faces: {
    ui: true,
    cli: { verb: "add", positional: ["title"], item: "tasks", short: { priority: "p" } },
    mcp: {
      tool: "add_tasks",
      title: "Add tasks",
      description:
        'Work left for later and items from email, chat or tickets: 1 to 25 a call, not TODOs in files. Read skill sizing-effort first. Key only the source a task is (jira:KEY): a match answers exists. folder "cwd" files a task in your folder\'s project; no area or project: the Inbox.',
    },
  },
  // A3 3.2.5: 25 drafts' lines at their longest fit whole, with the counts.
  budget: { typical: 80, max: 2000 },
  errors: ["invalid_input", "too_large", "forbidden", "request_id_conflict"],
  examples: [
    {
      title: "A follow-up found during work, and a ticket that already has a task",
      input: {
        tasks: [
          {
            title: "Fix appointment time zones in the mobile app",
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
            title: "Fix appointment time zones in the mobile app",
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
        warnings: ["tasks.0: possible duplicate of M-14 (same project, similar title)"],
      },
    },
  ],
});
