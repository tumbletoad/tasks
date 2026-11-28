// The person's writes to the library: a page's title, brief or body, a version written back, the
// Trash and back, and a node's brief, description and text for agents. Each goes in turn with the
// page's other edits, from the base the screen read, and its toast's Undo puts the change back.
import { useContext, useMemo } from "react";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import type { Msg } from "../row/model.ts";

export interface LibraryWrites {
  /** A page's title, brief or body, whole. */
  readonly page: (
    ref: string,
    set: { readonly title?: string; readonly brief?: string; readonly body?: string },
    base: string | undefined,
  ) => Promise<unknown>;
  /** Writes the version change `seq` made back, as a new edit over the body read at `base`. */
  readonly restore: (ref: string, seq: number, when: string, base: string) => Promise<unknown>;
  readonly trash: (ref: string) => Promise<unknown>;
  readonly untrash: (ref: string) => Promise<unknown>;
  /** The space's, an area's or a project's brief or description, whole. */
  readonly node: (
    target: string,
    set: { readonly brief?: string; readonly description?: string },
    base: string | undefined,
  ) => Promise<unknown>;
  /** The person's text for agents on the space, an area or a project, whole; empty takes it away. */
  readonly instruct: (target: string, text: string, base: string | undefined) => Promise<unknown>;
}

export function useLibraryWrites(): LibraryWrites {
  const { api } = useContext(Session);
  const edits = useEdits();
  return useMemo(() => {
    const calls = api.library;
    const write = <T extends { as_of?: string; result?: unknown }>(
      send: (request: string, base: string | undefined) => Promise<T>,
      msg: Msg,
      base?: string,
    ) => edits.write(send, () => msg, { base, undo: true });
    return {
      page: (ref, set, base) =>
        write(
          (request, sent) =>
            calls.page.write({
              action: "set",
              target: ref,
              ...set,
              ...(sent === undefined ? {} : { base: sent }),
              request_id: request,
            }),
          { id: "toast.pageChanged", values: { ref } },
          base,
        ),
      restore: (ref, seq, when, base) =>
        write(
          (request, sent) =>
            calls.page.write({
              action: "set",
              target: ref,
              from_seq: seq,
              base: sent ?? base,
              request_id: request,
            }),
          { id: "toast.pageRestored", values: { ref, when } },
          base,
        ),
      trash: (ref) =>
        write(
          (request) => calls.page.write({ action: "trash", target: ref, request_id: request }),
          { id: "toast.trashed", values: { ref } },
        ),
      untrash: (ref) =>
        write(
          (request) => calls.page.write({ action: "restore", target: ref, request_id: request }),
          { id: "toast.restoredTask", values: { ref } },
        ),
      node: (target, set, base) =>
        write(
          (request, sent) =>
            calls.page.write({
              action: "set",
              target,
              ...set,
              ...(sent === undefined ? {} : { base: sent }),
              request_id: request,
            }),
          { id: set.brief === undefined ? "toast.description" : "toast.brief" },
          base,
        ),
      instruct: (target, text, base) =>
        write(
          (request, sent) =>
            calls.node.instruct({ target, text, base: sent ?? base ?? "", request_id: request }),
          { id: "toast.forAgents" },
          base,
        ),
    } satisfies LibraryWrites;
  }, [api, edits]);
}
