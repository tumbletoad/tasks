// The seams between a task's composer and the rest of the page: "click-to-ask", and words an Open
// saved on the task. The composer's draft and its note on their way are kept in the browser with
// the other unsent words (unsent.ts).
//
// An agent-only field asks through `askFor`: the request's stub ("Change the summary: ") goes into
// the task's draft after what the person had written there, and the field takes focus. Nothing is
// sent until the person acts.
import type { AskField } from "../row/actions.ts";
import { letGo } from "../unsent.ts";

/** An Open saved the words of a task's draft on the task: its request, or a note of the person's. */
export interface Saved {
  readonly space: string;
  readonly task: string;
  /** The draft as it was when the Open was pressed. */
  readonly draft: string;
}

const savedListeners = new Set<(saved: Saved) => void>();

/** A task's composer clears its field when an Open saved what it holds. */
export function onSaved(listener: (saved: Saved) => void): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}

/**
 * An Open saved the words of `draft` on the task, as Note does: the kept draft goes while it is
 * still that draft, so what the person typed since, here or in another tab, stays, and so does
 * the field that shows it.
 */
export function savedWords(space: string, task: string, draft: string): void {
  letGo(space, { kind: "draft", task, text: draft });
  for (const listener of savedListeners) listener({ space, task, draft });
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
