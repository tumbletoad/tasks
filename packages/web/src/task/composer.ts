// The composer's drafts and the seam for "click-to-ask". A draft is kept per space and task
// (kept.ts) until it is saved as a note, goes with a launch, or is cleared, so a reload brings it
// back. A draft read back is untrusted text, shown only as the text area's value.
//
// An agent-only field asks through `askFor`: the request's stub ("Change the summary: ") goes into
// the task's draft after what the person had written there, and the field takes focus. Nothing is
// sent until the person acts.
import type { AskField } from "../row/actions.ts";
import { keep, keptNames, onKept, readKept } from "../kept.ts";

/** The composer's own limit: a longer draft is not kept. */
export const DRAFT_MAX = 20_000;

const nameOf = (space: string, task: string) => `draft.${space}.${task}`;

export function readDraft(space: string, task: string): string {
  const value = readKept(nameOf(space, task));
  return value !== undefined && value.length <= DRAFT_MAX ? value : "";
}

export function keepDraft(space: string, task: string, text: string): void {
  keep(nameOf(space, task), text === "" || text.length > DRAFT_MAX ? undefined : text);
}

/** Another tab changed this task's draft. */
export function onDraft(space: string, task: string, listener: (text: string) => void): () => void {
  return onKept(nameOf(space, task), (value) => {
    listener(value !== undefined && value.length <= DRAFT_MAX ? value : "");
  });
}

/** The tasks of `space` that hold a draft. */
export function draftTasks(space: string): string[] {
  const prefix = `draft.${space}.`;
  return keptNames(prefix).map((name) => name.slice(prefix.length));
}

export interface Ask {
  readonly space: string;
  readonly task: string;
  readonly field: AskField;
}

const listeners = new Set<(ask: Ask) => void>();

/** The composer of a task listens for requests to ask an agent. */
export function onAsk(listener: (ask: Ask) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** An agent-only field was clicked: the task's composer starts a request for an agent. */
export function askFor(space: string, task: string, field: AskField): void {
  for (const listener of listeners) listener({ space, task, field });
}
