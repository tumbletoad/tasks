// The composer's drafts and the seam for "click-to-ask". A draft is kept per space and task in
// the browser (kept.ts) until it is saved on the task (as a note, or as an Open's request), goes
// on the clipboard, or is cleared, so a reload brings it back. A draft read back is untrusted text, shown only as the text area's value.
//
// An agent-only field asks through `askFor`: the request's stub ("Change the summary: ") goes into
// the task's draft after what the person had written there, and the field takes focus. Nothing is
// sent until the person acts.
import type { AskField } from "../row/actions.ts";
import { browserKept, onKept } from "../kept.ts";

/** The composer's own limit: a longer draft is not kept. */
export const DRAFT_MAX = 20_000;

const nameOf = (space: string, task: string) => `draft.${space}.${task}`;
const noteOf = (space: string, task: string) => `note.${space}.${task}`;

/**
 * What a draft sends: as typed, without the blank lines around it. The first line keeps its
 * indent, so pasted code arrives as it was. Empty when nothing was typed.
 */
export const wordsOf = (text: string): string =>
  text.trim() === "" ? "" : text.replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();

export function readDraft(space: string, task: string): string {
  const value = browserKept.read(nameOf(space, task));
  return value !== undefined && value.length <= DRAFT_MAX ? value : "";
}

export function keepDraft(space: string, task: string, text: string): void {
  browserKept.keep(nameOf(space, task), text === "" || text.length > DRAFT_MAX ? undefined : text);
  if (text === "") browserKept.keep(noteOf(space, task), undefined);
}

/** A note on its way: its words and the request ID that saves them once, also after a reload. */
export interface NoteRequest {
  readonly words: string;
  readonly id: string;
}

export function readNote(space: string, task: string): NoteRequest | undefined {
  const value = browserKept.json(noteOf(space, task));
  if (typeof value !== "object" || value === null) return undefined;
  const { words, id } = value as { words?: unknown; id?: unknown };
  if (typeof words !== "string" || words === "" || words.length > DRAFT_MAX) return undefined;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/u.test(id)) return undefined;
  return { words, id };
}

export function keepNote(space: string, task: string, note: NoteRequest | undefined): void {
  browserKept.keep(noteOf(space, task), note === undefined ? undefined : JSON.stringify(note));
}

/** Words an Open saved on a task: its request, or a note of the person's. */
export interface Saved {
  readonly space: string;
  readonly task: string;
  readonly words: string;
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
 * An Open saved `words` on the task, as Note does: the kept draft clears unless the person has
 * typed on since, here or in another tab, and so does the field that shows them.
 */
export function savedWords(space: string, task: string, words: string): void {
  if (wordsOf(readDraft(space, task)) === words) keepDraft(space, task, "");
  for (const listener of savedListeners) listener({ space, task, words });
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
  return browserKept.names(prefix).map((name) => name.slice(prefix.length));
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
