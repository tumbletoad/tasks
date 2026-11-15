// The composer's drafts and the seam for "click-to-ask" (A5 3.8, 3.11). M5.08 builds the field and
// its draft; M5.07 builds what acts on it (Note, Open with the text, Run, Copy). An agent-only
// field asks through `askFor`: the request's stub ("Change the summary: ") goes into the task's
// draft after what the person had written there, and the field takes focus. Nothing is sent.
//
// Drafts are kept per space and task in `localStorage` as a per-viewer convenience (A5 3.8): every
// access is wrapped, losing a draft is harmless, and a draft read back is untrusted text, shown
// only as the text area's value.
import { PRODUCT_ID } from "@tasks/brand";
import type { AskField } from "../row/actions.ts";
import { browserStore } from "../stored.ts";

const PREFIX = `${PRODUCT_ID}.draft.`;
/** A draft longer than this is not kept: the composer's text has A4's budget, far below it. */
const MAX = 20_000;

const keyOf = (space: string, task: string) => `${PREFIX}${space}.${task}`;

/** This tab's drafts, so a blocked storage still keeps them for the tab's life. */
const memory = new Map<string, string>();

export function readDraft(space: string, task: string): string {
  const key = keyOf(space, task);
  const kept = memory.get(key);
  if (kept !== undefined) return kept;
  const store = browserStore();
  try {
    const value: unknown = store?.getItem(key);
    return typeof value === "string" && value.length <= MAX ? value : "";
  } catch {
    return "";
  }
}

export function keepDraft(space: string, task: string, text: string): void {
  const key = keyOf(space, task);
  if (text === "") memory.delete(key);
  else memory.set(key, text);
  const store = browserStore();
  try {
    if (text === "" || text.length > MAX) store?.removeItem(key);
    else store?.setItem(key, text);
  } catch {
    // Storage is blocked or full: the draft lives as long as the tab.
  }
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
