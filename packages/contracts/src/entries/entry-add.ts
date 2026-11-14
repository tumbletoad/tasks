// entry.add: append to a task's log, or record a note for the user (A3 3.4.7). Only the user can
// address a note to agents (for_agents, A3 3.2.3).
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeLine, safeText } from "../safe-text.ts";
import {
  AGENT_LIMITS,
  AsOf,
  ENTRY_KINDS_IN,
  BoundTask,
  Replayed,
  RequestId,
  TaskRef,
  TaskRefInput,
  USER_LIMITS,
  patterns,
} from "../schemas.ts";
import { AS_OF_NEXT, requestId } from "./fixture.ts";

export const EntryAddInput = z.strictObject({
  task: TaskRefInput.describe("Task ref (M-14) or ID; default: the bound task").optional(),
  kind: z
    .enum(ENTRY_KINDS_IN)
    .describe("question flags it for the user; note: a note for the user")
    .optional(),
  // The user may write a note as long as A1 allows a note. The handler applies A1's log-entry
  // limit to the log kinds (A1 3.7).
  text: safeText(USER_LIMITS.note).describe("The entry, in Markdown"),
  links: z
    .array(
      z.strictObject({
        title: safeLine(200).describe("Link title"),
        url: z.string().max(USER_LIMITS.url).describe("URL"),
      }),
    )
    .max(5)
    .describe("Links that back the entry")
    .optional(),
  for_agents: z.boolean().describe("Address the note to agents").optional(),
  request_id: RequestId,
});

export const EntryAddResult = z.strictObject({
  result: z.enum(["logged"]).describe("The entry was added"),
  task: TaskRef,
  entry: z
    .string()
    .regex(patterns.entryRef)
    .describe("Its ordinal: l3 for a log entry, n2 for a note"),
  kind: z.enum(ENTRY_KINDS_IN).describe("Entry kind"),
  as_of: AsOf,
  replayed: Replayed.optional(),
  bound_task: BoundTask.optional(),
});

export const entryAdd = defineEntry({
  name: "entry.add",
  summary: "Append to a task's log, or record a note for the user.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: ["log.add", "note.add"],
  input: EntryAddInput,
  agent: { hidden: ["for_agents"], max: [["text", AGENT_LIMITS.entry]] },
  defaults: [["kind", "progress"]],
  output: EntryAddResult,
  faces: {
    ui: true,
    cli: [
      { verb: "log", positional: ["task", "text"], exclude: ["for_agents"] },
      { verb: "note", positional: ["task", "text"], fixed: { kind: "note" } },
    ],
    mcp: {
      tool: "add_entry",
      title: "Log on a task",
      description:
        "Use often while working: log progress, evidence, decisions, blockers or questions on " +
        "a task. kind note records a note for the user, only when the user asks for one.",
    },
  },
  budget: { typical: 40, max: 80 },
  // forbidden: an agent that sends for_agents (A3 3.2.1, 3.2.3).
  errors: [
    "invalid_input",
    "unbound",
    "not_found",
    "too_large",
    "forbidden",
    "request_id_conflict",
  ],
  examples: [
    {
      title: "Log evidence on M-14",
      input: {
        task: "M-14",
        kind: "evidence",
        text: "Reproduced with the 11-12 clinic export: times shift by one hour.",
        request_id: requestId(3),
      },
      output: { result: "logged", task: "M-14", entry: "l3", kind: "evidence", as_of: AS_OF_NEXT },
    },
    {
      title: "The user addresses a note to agents",
      actor: "user",
      input: {
        task: "M-14",
        kind: "note",
        text: "Keep the old export format until Lumen confirms the change.",
        for_agents: true,
        request_id: requestId(4),
      },
      output: { result: "logged", task: "M-14", entry: "n2", kind: "note", as_of: AS_OF_NEXT },
    },
  ],
});
