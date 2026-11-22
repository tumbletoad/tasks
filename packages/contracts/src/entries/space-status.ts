// space.status: orientation and session status (A3 3.4.2).
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { AsOf, Cwd, TaskRef, TaskRow, idPattern, patterns } from "../schemas.ts";
import { AS_OF, M14, M15, PORTAL, SPACE_ID } from "./fixture.ts";

const INCLUDE = ["today", "week", "review", "waiting", "inbox", "changes"] as const;
/** `24h`, `7d` or an ISO date and time with an offset, with seconds and fractions optional. */
const SINCE =
  /^(?:24h|7d|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:[0-9]{2}))$/u;
const Count = z.int().min(0).max(1_000_000_000);

/** The example space's counts per status, in the space's order. */
export const STATUS_COUNTS = [
  { status: "open", count: 11 },
  { status: "waiting", count: 2 },
  { status: "review", count: 2 },
  { status: "backlog", count: 1 },
];

export const SpaceStatusInput = z.strictObject({
  cwd: Cwd.optional(),
  include: z.array(z.enum(INCLUDE)).max(6).describe("Extra sections, up to 8 rows each").optional(),
  since: z
    .string()
    .max(40)
    .regex(SINCE)
    .describe("For changes: 24h, 7d or an ISO time; default 24h")
    .optional(),
  guide: z
    .enum(["work", "refresh", "triage", "organize"])
    .describe("Return this workflow guide instead")
    .optional(),
});

const HereRow = TaskRow.extend({
  match: z
    .enum(["exact", "inside", "below"])
    .describe("Its folder is cwd, contains it or is in it"),
  live_sessions: Count.describe("Live agent sessions on it"),
});

export const SpaceStatusResult = z.strictObject({
  as_of: AsOf,
  date: z.string().regex(patterns.isoDate).describe("Today in the space's time zone"),
  time_zone: z.string().describe("IANA time zone of the space"),
  autonomy: z.enum(["full", "review", "suggest"]).describe("Autonomy level for this session"),
  space: z
    .strictObject({
      id: z.string().regex(idPattern("sp")).describe("Space ID"),
      name: z.string().describe("Space name"),
      ref_prefix: z.string().describe("Task reference prefix"),
    })
    .describe("The space this session uses"),
  session: z
    .strictObject({
      state: z
        .enum(["bound", "unbound", "routine"])
        .describe("bound: this connection is a task's session"),
      task: TaskRef.optional(),
      instance: z.string().describe("Agent instance").optional(),
      app: z.string().describe("Agent app").optional(),
      notes_for_agents: Count.describe("Notes from the user to agents on the task").optional(),
      proposals_rejected: Count.describe("Proposals rejected since the last call").optional(),
    })
    .describe("This session"),
  here: z
    .array(HereRow)
    .max(8)
    .describe("Active tasks for cwd: exact, inside, below; up to 8")
    .optional(),
  here_total: Count.describe("Active tasks for cwd in all").optional(),
  counts: z
    .strictObject({
      // A list, not a map: Zod skips a map key named __proto__ without checking its value.
      statuses: z
        .array(
          z.strictObject({
            status: z.string().describe("Status key"),
            count: Count.describe("Active tasks with it"),
          }),
        )
        .describe("Active tasks per status, in the space's order"),
      inbox: Count.describe("Tasks in the Inbox"),
      proposals: Count.describe("Pending proposals"),
    })
    .describe("Counts of active tasks"),
  sections: z
    .array(
      z.strictObject({
        name: z.enum(INCLUDE).describe("Section"),
        tasks: z.array(TaskRow).describe("Up to 8 tasks"),
        total: Count.describe("Its tasks not listed in an earlier section"),
        more: z.literal(true).describe("It has more tasks than total says").optional(),
        above: z
          .int()
          .min(1)
          .max(1000)
          .describe("Its tasks listed in an earlier section")
          .optional(),
      }),
    )
    .describe("The sections asked for with include")
    .optional(),
  guide: z.string().describe("The workflow guide asked for").optional(),
  hint: z.string().describe("What to do next").optional(),
});

const row = { lifecycle: "active", status: "open", inbox: false, area: "Client work" } as const;

export const spaceStatus = defineEntry({
  name: "space.status",
  summary: "Orientation: date, autonomy, whether this is a task's session, a folder's tasks, counts.",
  kind: "read",
  actors: "agent",
  scope: "space:read",
  remote: "read",
  audience: "caller",
  ops: [],
  input: SpaceStatusInput,
  output: SpaceStatusResult,
  faces: {
    ui: true,
    cli: { verb: "status" },
    mcp: {
      tool: "status",
      title: "Orientation and session status",
      description:
        "Call first when a session did not start from a task, and to refresh. Returns the date, " +
        "autonomy, whether this is a task's session, the tasks matching cwd and counts. " +
        "include adds " +
        "sections. guide returns a workflow guide instead. You cannot open or run agents: ask " +
        "the user.",
      alwaysLoad: true,
    },
  },
  budget: { typical: 400, max: 1500 },
  errors: ["invalid_input", "space_unavailable"],
  examples: [
    {
      title: "An unbound Claude Code session in Mira's portal folder",
      input: { cwd: PORTAL },
      output: {
        as_of: AS_OF,
        date: "2026-11-12",
        time_zone: "Europe/Lisbon",
        autonomy: "full",
        space: { id: SPACE_ID, name: "Mira", ref_prefix: "M" },
        session: { state: "unbound", instance: "claude-code", app: "Claude Code CLI" },
        here: [
          {
            ...M14,
            ...row,
            title: "Fix appointment time zones",
            priority: 1,
            effort: "M",
            due: "2026-11-13",
            project: "Lumen Health",
            match: "exact",
            live_sessions: 1,
          },
          {
            ...M15,
            ...row,
            title: "Review Jonas's pull request for the billing export",
            priority: 2,
            effort: "S",
            due: "2026-11-14",
            project: "Lumen Health",
            match: "exact",
            live_sessions: 0,
          },
        ],
        here_total: 2,
        counts: {
          statuses: STATUS_COUNTS,
          inbox: 0,
          proposals: 0,
        },
        hint: "Two tasks match this folder. Ask the user which one, then pass its task on each call.",
      },
    },
    {
      title: "A refresh asks what changed since a time from Date.toISOString()",
      input: { include: ["changes"], since: "2026-11-11T09:00:00.000Z" },
      output: {
        as_of: AS_OF,
        date: "2026-11-12",
        time_zone: "Europe/Lisbon",
        autonomy: "full",
        space: { id: SPACE_ID, name: "Mira", ref_prefix: "M" },
        session: { state: "routine", instance: "codex-work", app: "Codex CLI" },
        counts: {
          statuses: STATUS_COUNTS,
          inbox: 0,
          proposals: 0,
        },
        sections: [
          {
            name: "changes",
            tasks: [
              {
                ...M14,
                ...row,
                title: "Fix appointment time zones",
                priority: 1,
                effort: "M",
                due: "2026-11-13",
                project: "Lumen Health",
              },
            ],
            total: 1,
          },
        ],
      },
    },
  ],
});
