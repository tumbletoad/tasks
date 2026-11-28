// task.finished: the person's finished tasks, newest first, for the page's Completed view. Every
// completed or dropped task that is not in the Trash, by the time it was finished, a page at a
// time. The cursor is a key (that time and the task's ID), so a task finished while the list is
// open neither repeats nor skips a row of the next page, and nothing caps how far back it reads.
// The rows are the feed's compact rows, so the page draws them as it draws every other list.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { CompactTaskRow } from "../schemas.ts";
import { M3 } from "./fixture.ts";

/** Where the next page starts: the last row's finish time and ID. */
export const FINISHED_CURSOR = /^[0-9]{1,16}\.t_[0-9a-hjkmnp-tv-z]{26}$/u;

export const TaskFinishedInput = z.strictObject({
  checked_off: z
    .boolean()
    .describe("true: only the checked-off list; false: every other finished task")
    .optional(),
  limit: z.int().min(1).max(200).describe("Rows per page; default 50").optional(),
  cursor: z.string().max(60).describe("Next page: the last page's cursor").optional(),
});

/** A finished task's compact row, with the time it was finished and how it ended. */
export const FinishedRow = CompactTaskRow.extend({
  finished_at: z
    .int()
    .min(-8_640_000_000_000_000)
    .max(8_640_000_000_000_000)
    .describe("When it was completed or dropped"),
  ending: z
    .string()
    .max(300)
    .describe("How it ended, one line: why it was dropped, or its outcome once wrapped up")
    .optional(),
});

export const TaskFinishedResult = z.strictObject({
  rows: z.array(FinishedRow).describe("Newest first"),
  cursor: z.string().regex(FINISHED_CURSOR).describe("Pass it for the next page").optional(),
});

const m3 = {
  ...M3,
  title: "Fix DST bug in reports",
  summary: "",
  lifecycle: "completed",
  status: "open",
  inbox: false,
  priority: 2,
  parent: "ar_1b5d9f3h7k0m4p8r2t6w0y4a8c",
  position: "a0",
  wrap_state: "wrapped",
  completed_at: 1_775_210_400_000,
  finished_at: 1_775_210_400_000,
  created_at: 1_774_000_000_000,
  version: 31,
  touched: 31,
} as const;

export const taskFinished = defineEntry({
  name: "task.finished",
  summary: "Finished tasks, newest first, a page at a time: the page's Completed view.",
  kind: "read",
  actors: "user",
  scope: "space:read",
  remote: "read",
  audience: "caller",
  ops: [],
  input: TaskFinishedInput,
  output: TaskFinishedResult,
  defaults: [["limit", 50]],
  faces: { ui: true },
  errors: ["invalid_input", "space_unavailable", "forbidden"],
  examples: [
    {
      title: "The newest finished tasks",
      actor: "user",
      input: {},
      output: { rows: [m3] },
    },
    {
      title: "The checked-off list, whose wrap-up still waits",
      actor: "user",
      input: { checked_off: true },
      output: { rows: [] },
    },
    {
      title: "The page after M-3: what was finished before it",
      actor: "user",
      input: { cursor: `1775210400000.${M3.id}` },
      output: { rows: [] },
    },
  ],
});
