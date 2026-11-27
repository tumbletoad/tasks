// The thread's note corrections: take a note back, and put a removed one back. Each goes through
// note.remove as the person, in turn with the page's other edits, from the base the card was read
// at, and its toast's Undo or Ctrl+Z takes it back.
import { useContext, useMemo } from "react";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { Session } from "../context.ts";
import type { Edits, WriteReceipt } from "../edit/edits.ts";
import { useEdits } from "../edit/useEdits.ts";
import type { Msg } from "../row/model.ts";
import type { DetailNote } from "./detail.ts";

type RemoveInput = Omit<Parameters<Client["note"]["remove"]>[0], "request_id" | "base">;
type RemoveResult = Awaited<ReturnType<Client["note"]["remove"]>>;

interface Task {
  readonly ref: string;
}

type NoteWrite = (task: Task, note: DetailNote, base: string) => Promise<unknown>;

export interface NoteWrites {
  readonly remove: NoteWrite;
  readonly putBack: NoteWrite;
}

export function noteWrites(client: Client, edits: Pick<Edits, "write">): NoteWrites {
  const write = (input: RemoveInput, msg: Msg, base: string) =>
    edits.write(
      (request, sent) => client.note.remove({ ...input, base: sent ?? base, request_id: request }),
      (result: RemoveResult | WriteReceipt) => (result.result === "no_change" ? undefined : msg),
      { base, undo: true },
    );
  return {
    remove: (task, note, base) =>
      write(
        { task: task.ref, remove: note.ref },
        { id: "toast.noteRemoved", values: { ref: task.ref } },
        base,
      ),
    putBack: (task, note, base) =>
      write(
        { task: task.ref, put_back: note.ref },
        { id: "toast.notePutBack", values: { ref: task.ref } },
        base,
      ),
  };
}

export function useNoteWrites(): NoteWrites {
  const { api } = useContext(Session);
  const edits = useEdits();
  return useMemo(() => noteWrites(api.client, edits), [api, edits]);
}
