// The card's source corrections: detach a source from the task, and put a detached one back. Each
// goes through task.update as the person, in turn with the page's other edits, from the base the
// card was read at, and its toast's Undo or Ctrl+Z takes it back.
import { useContext, useMemo } from "react";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { Session } from "../context.ts";
import type { Edits, WriteReceipt } from "../edit/edits.ts";
import { useEdits } from "../edit/useEdits.ts";
import type { Msg } from "../row/model.ts";
import type { SourceOutput } from "./detail.ts";

type UpdateInput = Omit<Parameters<Client["task"]["update"]>[0], "request_id">;
type UpdateResult = Awaited<ReturnType<Client["task"]["update"]>>;

interface Task {
  readonly ref: string;
}

type SourceWrite = (task: Task, source: SourceOutput, base?: string) => Promise<unknown>;

export interface SourceWrites {
  readonly detach: SourceWrite;
  readonly putBack: SourceWrite;
}

export function sourceWrites(client: Client, edits: Pick<Edits, "write">): SourceWrites {
  const update = (input: UpdateInput, msg: Msg, base: string | undefined) =>
    edits.write(
      (request, sent) =>
        client.task.update({
          ...input,
          ...(sent === undefined ? {} : { base: sent }),
          request_id: request,
        }),
      (result: UpdateResult | WriteReceipt) => (result.result === "no_change" ? undefined : msg),
      { base },
    );
  return {
    detach: (task, source, base) =>
      update(
        { task: task.ref, remove_sources: [source.id] },
        { id: "toast.sourceRemoved", values: { ref: task.ref } },
        base,
      ),
    // While another active task holds the key the service refuses it, naming that task.
    putBack: (task, source, base) =>
      update(
        { task: task.ref, put_back_sources: [source.id] },
        { id: "toast.sourcePutBack", values: { ref: task.ref } },
        base,
      ),
  };
}

export function useSourceWrites(): SourceWrites {
  const { api } = useContext(Session);
  const edits = useEdits();
  return useMemo(() => sourceWrites(api.client, edits), [api, edits]);
}
