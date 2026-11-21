// The composer's drafts and the seam for "click-to-ask". A draft is kept per space and task in
// the browser (kept.ts) until it is saved as a note, reaches an agent, or is cleared, so a reload
// brings it back. A draft read back is untrusted text, shown only as the text area's value.
//
// An agent-only field asks through `askFor`: the request's stub ("Change the summary: ") goes into
// the task's draft after what the person had written there, and the field takes focus. Nothing is
// sent until the person acts.
import type { Receipt } from "../api.ts";
import type { AskField } from "../row/actions.ts";
import { useSyncExternalStore } from "react";
import { browserKept, onKept, onKeptUnder } from "../kept.ts";

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
  const had = hasDraft(space, task);
  browserKept.keep(nameOf(space, task), text === "" || text.length > DRAFT_MAX ? undefined : text);
  if (text === "") browserKept.keep(noteOf(space, task), undefined);
  if (hasDraft(space, task) !== had) for (const watcher of draftWatchers) watcher();
}

/** Whether the task's composer holds words the person has not sent. */
export function hasDraft(space: string, task: string): boolean {
  return wordsOf(readDraft(space, task)) !== "";
}

const draftWatchers = new Set<() => void>();
let stopHearing: (() => void) | undefined;

/** A task's draft came or went, in this tab or another: one listener for every row. */
function watchDrafts(watcher: () => void): () => void {
  draftWatchers.add(watcher);
  stopHearing ??= onKeptUnder("draft.", () => {
    for (const each of draftWatchers) each();
  });
  return () => {
    draftWatchers.delete(watcher);
    if (draftWatchers.size === 0) {
      stopHearing?.();
      stopHearing = undefined;
    }
  };
}

/** Whether the task holds a draft, kept current as one comes or goes. */
export function useHasDraft(space: string, task: string): boolean {
  return useSyncExternalStore(watchDrafts, () => hasDraft(space, task));
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
 * Where a launch's words are, now that TTasks holds them for its agent: `reached` once the agent
 * read them, `unread` when they went with a launch whose agent never read them, `kept` when the
 * launch failed or nothing is known of them any more (the service restarted since), undefined
 * while they wait. Only `reached` clears the field, and only `unread` says so.
 */
export type Delivery = "reached" | "unread" | "kept" | undefined;

export function delivered(receipt: Receipt): Delivery {
  if (receipt.request === "read") return "reached";
  if (receipt.state === "failed") return "kept";
  if (receipt.request === "unread") return "unread";
  if (receipt.request === "waiting") return undefined;
  if (receipt.state === "prepared" || receipt.state === "dispatching") return undefined;
  return "kept";
}

/**
 * The launches that carry a task's words, by receipt, until they settle. Kept with the draft, since
 * an agent may read them long after the click: a reload still clears what it read.
 */
const carryOf = (space: string, task: string) => `carry.${space}.${task}`;

/** The most launches kept for one task: one that never settles is let go after these. */
const CARRIED_MAX = 16;

function readCarrying(space: string, task: string): Map<string, string> {
  const value = browserKept.json(carryOf(space, task));
  const launches = new Map<string, string>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return launches;
  for (const [receipt, words] of Object.entries(value as Record<string, unknown>)) {
    if (typeof words === "string" && words !== "" && words.length <= DRAFT_MAX) {
      launches.set(receipt, words);
    }
  }
  return launches;
}

function keepCarrying(space: string, task: string, launches: Map<string, string>): void {
  const kept = [...launches].slice(-CARRIED_MAX);
  browserKept.keep(
    carryOf(space, task),
    kept.length === 0 ? undefined : JSON.stringify(Object.fromEntries(kept)),
  );
}

export function carry(space: string, task: string, receipt: string, words: string): void {
  const launches = readCarrying(space, task);
  launches.set(receipt, words);
  keepCarrying(space, task, launches);
}

/** A launch that settled with the words it carried. */
export interface Settled {
  readonly words: string;
  readonly receipt: Receipt;
  readonly delivery: Exclude<Delivery, undefined>;
}

/** The task's launches that settled, with their words; each one is let go. */
export function settled(space: string, task: string, receipts: readonly Receipt[]): Settled[] {
  const launches = readCarrying(space, task);
  if (launches.size === 0) return [];
  const done: Settled[] = [];
  for (const receipt of receipts) {
    const words = launches.get(receipt.id);
    if (words === undefined) continue;
    const delivery = delivered(receipt);
    if (delivery === undefined) continue;
    launches.delete(receipt.id);
    done.push({ words, receipt, delivery });
  }
  if (done.length > 0) keepCarrying(space, task, launches);
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
