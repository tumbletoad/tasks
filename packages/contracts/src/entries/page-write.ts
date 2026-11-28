// page.write: the library's one write, for agents and the person. A page is created, edited (these
// old words become those new words), appended to, set whole (title, brief or body; Restore is a
// set from an earlier version), moved, moved to the Trash and brought back. On the space, an area
// or a project it sets the brief and the description whole. Every write carries one line of what
// changed and why: agents must give it. A person may make a page with a title only; an agent
// gives a brief on every page it makes.
//
// An edit applies while its old words stand in the body exactly once, whatever else changed, so two
// agents editing different passages both succeed. Words that are gone or stand more than once
// write nothing: the answer says which, with the start of the page and a cursor to read it all.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeLine, safeText } from "../safe-text.ts";
import { EXCERPT_CHARS, PAGE_LIMITS, ReadCursor } from "../pages.ts";
import { Base, Replayed, RequestId, SessionTask, WriteAsOf } from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, M14, requestId } from "./fixture.ts";
import { LUMEN, M180, TIME_ZONES } from "./page-read.ts";

export const PAGE_ACTIONS = [
  "create",
  "edit",
  "append",
  "set",
  "move",
  "trash",
  "restore",
] as const;

const { user, agent } = PAGE_LIMITS;

export const PageWriteInput = z.strictObject({
  action: z.enum(PAGE_ACTIONS).describe("restore: back from the Trash; set from_seq: a version"),
  target: z
    .string()
    .max(250)
    .describe('The page (M-180); set: or a project, area or "space" for its texts')
    .optional(),
  on: z
    .string()
    .max(250)
    .describe('create: "task", a task, a project, an area or "space"; default: its project')
    .optional(),
  to: z.string().max(250).describe('move: a task, a project, an area or "space"').optional(),
  title: safeLine(user.title).describe("create, set: one line").optional(),
  brief: safeLine(user.brief)
    .describe("create, set: what a reader finds in it; agents must give one on create")
    .optional(),
  body: safeText(user.body).describe("create, set: Markdown").optional(),
  description: safeText(user.body).describe("set on a node: its description, whole").optional(),
  old: safeText(agent.words)
    .describe("edit: the exact words in the page now, standing once")
    .optional(),
  new: safeText(agent.words).describe("edit: what they become").optional(),
  text: safeText(agent.words).describe("append: Markdown added at the end").optional(),
  from_seq: z
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .describe("set: write back the version this change made")
    .optional(),
  why: safeLine(user.why).describe("One line: what changed and why").optional(),
  base: Base.optional(),
  task: SessionTask,
  request_id: RequestId,
});

export const PAGE_RESULTS = [
  "created",
  "edited",
  "appended",
  "set",
  "moved",
  "trashed",
  "restored",
  "no_change",
  "stale",
  "ambiguous",
] as const;

export const PageWriteResult = z.strictObject({
  result: z.enum(PAGE_RESULTS).describe("stale, ambiguous: nothing written"),
  target: z.string().max(40).describe("The page's reference, or the node's ID"),
  on: z.string().describe("What holds the page now, by name").optional(),
  found: z
    .int()
    .min(0)
    .max(1_000_000)
    .describe("stale: 0, ambiguous: how often the old words stand")
    .optional(),
  excerpt: z
    .string()
    .max(EXCERPT_CHARS + 40)
    .describe("stale, ambiguous: the page's start as it is now")
    .optional(),
  cursor: ReadCursor.describe("stale, ambiguous: pass it to read for the whole page").optional(),
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
});

const ref = M180.ref;

export const pageWrite = defineEntry({
  name: "page.write",
  summary: "Create, edit, append to, set, move, trash or restore a page, or set a node's texts.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: [
    "page.create",
    "page.edit",
    "page.append",
    "page.set",
    "page.move",
    "page.trash",
    "page.restore",
    "node.set",
    // An area's and a project's brief stay in their rows, with their own writes.
    "area.patch",
    "project.patch",
  ],
  input: PageWriteInput,
  agent: {
    required: ["why"],
    hidden: ["from_seq"],
    max: [
      ["title", agent.title],
      ["brief", agent.brief],
      ["body", agent.body],
      ["description", agent.body],
      ["why", agent.why],
    ],
  },
  output: PageWriteResult,
  faces: {
    ui: true,
    cli: { verb: "page", positional: ["action", "target"], exclude: ["task", "base"] },
    mcp: {
      tool: "write_page",
      title: "Write a page",
      description:
        "Use to keep the library: create a page (on the task's project unless you name the " +
        "task), edit it (old words become new), append, set title or brief, move, trash or " +
        "restore it; or set a project's, an area's or the space's brief and description. why: " +
        "one line.",
    },
  },
  budget: { typical: 150, max: 1_500 },
  errors: [
    "invalid_input",
    "not_found",
    "ambiguous",
    "unbound",
    "conflict",
    "forbidden",
    "too_large",
    "request_id_conflict",
    "applied_earlier",
  ],
  examples: [
    {
      title: "The person makes a page on the space with a title only",
      actor: "user",
      input: {
        action: "create",
        on: "space",
        title: "Clinic visit, 2 Dec",
        request_id: requestId(89),
      },
      output: { result: "created", target: "M-231", on: "Mira", as_of: AS_OF_NEXT },
    },
    {
      title: "Create a page on M-14's project",
      input: {
        action: "create",
        task: M14.ref,
        title: "Time zone rules",
        brief: "Store UTC plus the clinic's zone ID; convert once",
        body: TIME_ZONES,
        why: "what M-14 found about the clinic's times",
        request_id: requestId(90),
      },
      output: { result: "created", target: ref, on: "Lumen Health", as_of: AS_OF_NEXT },
    },
    {
      title: "Correct one sentence of M-180",
      input: {
        action: "edit",
        target: ref,
        old: "Convert once, when shown.",
        new: "Convert once, when shown, with the clinic's zone ID of that day.",
        why: "a clinic changed its zone on 1 Nov (M-14)",
        request_id: requestId(91),
      },
      output: { result: "edited", target: ref, on: "Lumen Health", as_of: AS_OF_NEXT },
    },
    {
      title: "An edit whose old words are gone writes nothing",
      input: {
        action: "edit",
        target: ref,
        old: "Convert twice.",
        new: "Convert once.",
        why: "fix the conversion rule",
        request_id: requestId(92),
      },
      output: {
        result: "stale",
        target: ref,
        found: 0,
        excerpt: TIME_ZONES,
        as_of: AS_OF,
      },
    },
    {
      title: "Give project Lumen Health a description",
      input: {
        action: "set",
        target: LUMEN.project,
        description: "The portal of the clinic group: booking, reminders and the weekly report.",
        base: AS_OF,
        why: "the harvest of its finished tasks",
        request_id: requestId(93),
      },
      output: { result: "set", target: LUMEN.project, as_of: AS_OF_NEXT },
    },
    {
      title: "The person restores an earlier version of M-180",
      actor: "user",
      input: { action: "set", target: ref, from_seq: 1012, base: AS_OF, request_id: requestId(94) },
      output: { result: "set", target: ref, on: "Lumen Health", as_of: AS_OF_NEXT },
    },
    {
      title: "Move M-180 up to the area, where a second project needs it",
      input: {
        action: "move",
        target: ref,
        to: "Client work",
        why: "the reports project converts times too",
        request_id: requestId(95),
      },
      output: { result: "moved", target: ref, on: "Client work", as_of: AS_OF_NEXT },
    },
  ],
});
