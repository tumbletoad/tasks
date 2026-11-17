// The composer's drafts and the seam for "click-to-ask". A draft is kept per space and task in
// the browser (kept.ts) until it is saved as a note, reaches an agent, or is cleared, so a reload
// brings it back. A draft read back is untrusted text, shown only as the text area's value.
//
// An agent-only field asks through `askFor`: the request's stub ("Change the summary: ") goes into
// the task's draft after what the person had written there, and the field takes focus. Nothing is
// sent until the person acts.
import type { Receipt } from "../api.ts";
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

/**
 * Where a launch's words are, now that Tasks holds them for its agent: `reached` once the agent
 * read them, `failed` when the launch failed or the service lost track of it with them unread,
 * `unread` when the launch went on without its agent ever reading them (it ended, or a restart
 * of the service lost them), undefined while they wait. Only `reached` clears the field.
 */
export type Delivery = "reached" | "failed" | "unread" | undefined;

export function delivered(receipt: Receipt): Delivery {
  if (receipt.request === "read") return "reached";
  if (receipt.state === "failed") return "failed";
  if (receipt.request === "waiting") return undefined;
  if (receipt.state === "prepared" || receipt.state === "dispatching") return undefined;
  return receipt.state === "unknown" ? "failed" : "unread";
}

/**
 * The launches that carry a composer's words, by draft, until they settle. Kept for the tab, so a
 * task collapsed and expanded again still clears what its launch delivered.
 */
const carrying = new Map<string, Map<string, string>>();

export function carry(space: string, task: string, receipt: string, words: string): void {
  const name = nameOf(space, task);
  const launches = carrying.get(name) ?? new Map<string, string>();
  launches.set(receipt, words);
  carrying.set(name, launches);
}

/** A launch that settled with the words it carried. */
export interface Settled {
  readonly words: string;
  readonly receipt: Receipt;
  readonly delivery: Exclude<Delivery, undefined>;
}

/** The task's launches that settled, with their words; each one is let go. */
export function settled(space: string, task: string, receipts: readonly Receipt[]): Settled[] {
  const name = nameOf(space, task);
  const launches = carrying.get(name);
  if (launches === undefined) return [];
  const done: Settled[] = [];
  for (const receipt of receipts) {
    const words = launches.get(receipt.id);
    if (words === undefined) continue;
    const delivery = delivered(receipt);
    if (delivery === undefined) continue;
    launches.delete(receipt.id);
    done.push({ words, receipt, delivery });
  }
  if (launches.size === 0) carrying.delete(name);
  return done;
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
