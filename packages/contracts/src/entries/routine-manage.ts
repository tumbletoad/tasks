// routine.manage: the person's routines, one task each that comes back on a schedule. `make` makes
// one, or turns an open task with no task above or below it into one; `change` sets its words,
// priority or schedule; `pause` and `resume`; `done` and `skip` log its open time, and `extra` an
// entry with no due time; `finish` ends it for good and `reopen` brings it back. Only on a space on
// the new storage. Agents set a routine you do with `repeat` on add_tasks and update_task.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import {
  Base,
  ContextInput,
  Priority,
  Replayed,
  RequestId,
  SummaryInput,
  TaskId,
  TaskRef,
  TaskRefInput,
  TitleInput,
  WriteAsOf,
  patterns,
} from "../schemas.ts";
import { requestId } from "./fixture.ts";

export const ROUTINE_ACTIONS = [
  "make",
  "change",
  "pause",
  "resume",
  "done",
  "skip",
  "extra",
  "finish",
  "reopen",
] as const;

const IsoDate = z.string().max(10).regex(patterns.isoDate);
const Instant = z.string().regex(patterns.instant);

/** A time of a routine: its local date, and its instant in UTC when it has a time of day. */
export const RoutineTime = z.strictObject({
  date: IsoDate.describe("Its date, on the routine's calendar"),
  at: Instant.describe("Its time, in UTC, when it has a time of day").optional(),
});

/** A time of a routine done or skipped. */
export const RoutineEntry = z.strictObject({
  due: RoutineTime.describe("The time it was for; absent for an extra time").optional(),
  state: z.enum(["done", "skipped"]).describe("Done, or skipped"),
  at: Instant.describe("When it was logged"),
  by: z.string().describe("Who logged it: user, or agent:<label>"),
  why: z.enum(["you", "run_failed"]).describe("A skip's: by you, or its run failed").optional(),
  note: z.string().describe("What was done").optional(),
});

/** At most this many of a routine's entries come with it, newest first. */
export const ROUTINE_ENTRIES = 10;

/** A routine as an answer shows it. */
export const Routine = z
  .strictObject({
    id: TaskId,
    ref: TaskRef,
    title: z.string().describe("Title"),
    repeat: z.string().describe('Its schedule in words: "Every Saturday"'),
    rule: z.string().max(200).describe("Its schedule as stored: RRULE text"),
    tz: z.string().describe("The IANA time zone its days are counted in"),
    by: z.literal("you").describe("Who does it: you"),
    state: z.enum(["active", "paused", "finished"]).describe("Coming back, paused, or finished"),
    next: RoutineTime.describe("Its open time: the next, or the one still to do"),
    entries: z.int().min(0).max(1_000_000).describe("How many times it was done or skipped"),
    last: RoutineEntry.describe("Its newest entry").optional(),
  })
  .describe("The routine");

export const RoutineManageInput = z.strictObject({
  action: z.enum(ROUTINE_ACTIONS).describe("What to do"),
  routine: TaskRefInput.describe("Every action but make: the routine, such as M-21").optional(),
  from_task: TaskRefInput.describe("make: the open task that becomes the routine").optional(),
  title: TitleInput.describe("make, change: its title").optional(),
  summary: SummaryInput.describe("make, change: one line").optional(),
  context: ContextInput.describe("make, change: Markdown").optional(),
  under: z
    .string()
    .max(250)
    .describe("make: the project's ID or path; default the space")
    .optional(),
  priority: Priority.describe("make, change: 1 highest, 4 none").optional(),
  rule: z.string().max(200).describe("make, change: the schedule, RRULE text").optional(),
  start: IsoDate.describe("make, change: the first date it may fall on").optional(),
  tz: z.string().max(64).describe("make, change: the IANA time zone").optional(),
  base: Base.optional(),
  request_id: RequestId,
});

export const RoutineManageResult = z.strictObject({
  action: z.enum(ROUTINE_ACTIONS).describe("The action"),
  result: z.enum(["applied", "no_change"]).describe("Applied, or nothing changed"),
  routine: Routine,
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
});

export const routineManage = defineEntry({
  name: "routine.manage",
  summary: "Make, change, pause, check off, skip or finish a routine: a task that comes back.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "never",
  audience: "none",
  ops: [
    "routine.set",
    "routine.pause",
    "routine.resume",
    "routine.done",
    "routine.skip",
    "routine.finish",
    "routine.reopen",
  ],
  input: RoutineManageInput,
  output: RoutineManageResult,
  faces: { ui: true },
  errors: [
    "invalid_input",
    "not_found",
    "conflict",
    "forbidden",
    "space_unavailable",
    "read_only",
    "request_id_conflict",
    "applied_earlier",
    "op_unknown",
  ],
  examples: [
    {
      title: "Water the plants every Saturday",
      actor: "user",
      input: {
        action: "make",
        title: "Water the plants",
        rule: "FREQ=WEEKLY;BYDAY=SA",
        tz: "Europe/Amsterdam",
        request_id: requestId(97),
      },
      output: {
        action: "make",
        result: "applied",
        routine: {
          id: "t_9q2w4e6r8t0y1v3j5k7p9a1s3d",
          ref: "M-41",
          title: "Water the plants",
          repeat: "Every Saturday",
          rule: "FREQ=WEEKLY;BYDAY=SA",
          tz: "Europe/Amsterdam",
          by: "you",
          state: "active",
          next: { date: "2026-11-14" },
          entries: 0,
        },
        as_of: "1.1048.5n0w8k3q",
      },
    },
  ],
});
