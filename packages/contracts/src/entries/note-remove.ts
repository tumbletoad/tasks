// note.remove: the person takes back a note on a task, or puts a removed note back. Nothing is
// deleted for good: the note keeps its number, author and audience, every read of notes skips it,
// and it is listed with the task's removed items until it is put back. For the person only: an
// agent never takes back what the person wrote.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import {
  AsOf,
  Base,
  Compared,
  Replayed,
  RequestId,
  TaskRef,
  TaskRefInput,
  patterns,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

/** A note's number as the person reads it in the thread: `3`, or its reference `n3`. */
export const NoteNumber = z
  .string()
  .max(7)
  .regex(/^n?[1-9][0-9]{0,5}$/u);

export const NoteRemoveInput = z.strictObject({
  task: TaskRefInput.describe("Task ref (M-14) or ID"),
  remove: NoteNumber.describe("Take back this note: its number, such as 3 or n3").optional(),
  put_back: NoteNumber.describe("Put back this removed note").optional(),
  base: Base,
  request_id: RequestId,
});

export const NoteRemoveResult = z.strictObject({
  result: z
    .enum(["removed", "put_back", "no_change"])
    .describe("removed, put back, or the note was that way already"),
  task: TaskRef,
  note: z.string().regex(patterns.entryRef).describe("The note, such as n3"),
  as_of: AsOf,
  replayed: Replayed.optional(),
  compared: Compared.optional(),
});

export const noteRemove = defineEntry({
  name: "note.remove",
  summary: "Take back a note on a task, or put a removed one back. Nothing is deleted for good.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "write",
  audience: "none",
  ops: ["note.delete", "note.restore"],
  input: NoteRemoveInput,
  output: NoteRemoveResult,
  faces: {
    ui: true,
    // `ttasks note M-14 --remove 3`: never on `delete`, so a note number left out or mistyped can
    // never remove the task.
    cli: { verb: "note", positional: ["task"], when: ["remove", "put_back"] },
  },
  errors: ["invalid_input", "not_found", "conflict", "forbidden", "request_id_conflict"],
  examples: [
    {
      title: "Take back note n2 on M-14",
      actor: "user",
      input: { task: "M-14", remove: "2", base: AS_OF, request_id: requestId(80) },
      output: { result: "removed", task: "M-14", note: "n2", as_of: AS_OF_NEXT },
    },
    {
      title: "Put it back",
      actor: "user",
      input: { task: "M-14", put_back: "n2", base: AS_OF, request_id: requestId(81) },
      output: { result: "put_back", task: "M-14", note: "n2", as_of: AS_OF_NEXT },
    },
  ],
});
