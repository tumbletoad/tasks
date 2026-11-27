// The person's corrections of a task's text: its summary and its context through task.update, a
// note's or a log entry's words through entry.edit. Each goes as the person, in turn with the
// page's other edits, from the base the editor opened at, and its toast's Undo or Ctrl+Z puts the
// words before back: words are a nuisance to type again.
import { useContext, useMemo } from "react";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { Session } from "../context.ts";
import type { Edits } from "../edit/edits.ts";
import { useEdits } from "../edit/useEdits.ts";
import type { Msg } from "../row/model.ts";

interface Task {
  readonly ref: string;
}

type TextWrite = (task: Task, words: string, base: string | undefined) => Promise<unknown>;

export interface TextWrites {
  readonly summary: TextWrite;
  readonly context: TextWrite;
  /** A note's or a log entry's words, by its reference (n3, l4). */
  readonly entry: (task: Task, entry: string, words: string, base: string) => Promise<unknown>;
}

export function textWrites(client: Client, edits: Pick<Edits, "write">): TextWrites {
  const write = <T extends { as_of?: string; result?: unknown }>(
    send: (request: string, base: string | undefined) => Promise<T>,
    msg: Msg,
    base: string | undefined,
  ) => edits.write(send, () => msg, { base, undo: true });
  return {
    summary: (task, words, base) =>
      write(
        (request, sent) =>
          client.task.update({
            task: task.ref,
            set: { summary: words },
            ...(sent === undefined ? {} : { base: sent }),
            request_id: request,
          }),
        { id: "toast.summary", values: { ref: task.ref } },
        base,
      ),
    context: (task, words, base) =>
      write(
        (request, sent) =>
          client.task.update({
            task: task.ref,
            context: { mode: "replace", text: words },
            ...(sent === undefined ? {} : { base: sent }),
            request_id: request,
          }),
        { id: "toast.context", values: { ref: task.ref } },
        base,
      ),
    entry: (task, entry, words, base) =>
      write(
        (request, sent) =>
          client.entry.edit({
            task: task.ref,
            entry,
            text: words,
            base: sent ?? base,
            request_id: request,
          }),
        {
          id: entry.startsWith("n") ? "toast.noteEdited" : "toast.entryEdited",
          values: { ref: task.ref },
        },
        base,
      ),
  };
}

export function useTextWrites(): TextWrites {
  const { api } = useContext(Session);
  const edits = useEdits();
  return useMemo(() => textWrites(api.client, edits), [api, edits]);
}
