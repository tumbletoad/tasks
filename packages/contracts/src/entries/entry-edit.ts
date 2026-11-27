// entry.edit: the person corrects the words of a note or a log entry on a task, whoever wrote it.
// The entry keeps its number, author and time; the words before stay in the history, and Undo
// puts them back. For the person only: an agent never rewrites what someone else wrote.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeText } from "../safe-text.ts";
import {
  WriteAsOf,
  Base,
  Replayed,
  RequestId,
  TaskRef,
  TaskRefInput,
  USER_LIMITS,
  patterns,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

export const EntryEditInput = z.strictObject({
  task: TaskRefInput.describe("Task ref (M-14) or ID"),
  entry: z
    .string()
    .max(7)
    .regex(patterns.entryRef)
    .describe("The entry: n2 for a note, l3 for a log entry"),
  text: safeText(USER_LIMITS.note).describe("Its new words, in Markdown"),
  base: Base,
  request_id: RequestId,
});

export const EntryEditResult = z.strictObject({
  result: z.enum(["edited", "no_change"]).describe("edited, or the words were these already"),
  task: TaskRef,
  entry: z.string().regex(patterns.entryRef).describe("The entry, such as n2"),
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
});

export const entryEdit = defineEntry({
  name: "entry.edit",
  summary: "Correct the words of a note or a log entry. The words before stay in the history.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "write",
  audience: "none",
  ops: ["note.patch", "log.patch"],
  input: EntryEditInput,
  output: EntryEditResult,
  faces: { ui: true },
  errors: [
    "invalid_input",
    "not_found",
    "conflict",
    "forbidden",
    "too_large",
    "request_id_conflict",
    "applied_earlier",
  ],
  examples: [
    {
      title: "Correct note n2 on M-14",
      actor: "user",
      input: {
        task: "M-14",
        entry: "n2",
        text: "Keep the old export format until the clinic confirms the change.",
        base: AS_OF,
        request_id: requestId(82),
      },
      output: { result: "edited", task: "M-14", entry: "n2", as_of: AS_OF_NEXT },
    },
  ],
});
