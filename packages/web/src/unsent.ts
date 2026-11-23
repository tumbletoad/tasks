// What a person typed for a task and has not sent: a composer's draft, a note on its way, a title
// being typed (each tab its own) and a field edit the service did not take. Each is kept in the
// browser (kept.ts), so a reload or a crash of the tab brings it back, and this module is the only
// way to them: it lists every kept value of a space, lets go of exactly the value a caller holds,
// and tells of every change, made in this tab or in another.
//
// A value is let go when the service has answered that it holds the words, or when the person lets
// them go, and only while it is still the value the caller holds: a newer one typed meanwhile, here
// or in another tab, stays. A task that is finished, in the Trash or not found keeps its words: the
// foot of the Trash lists them (views/Trash.tsx). What is read back is untrusted (another page served
// at this origin could have written it), so each kind is read by its shape and shown only as text.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { changeOf, type Field, type Words } from "./edit/change.ts";
import type { Unsaved, UnsavedKeeper } from "./edit/edits.ts";
import { browserKept, onKept, onKeptUnder, tabKept } from "./kept.ts";

/** The composer's own limit: a longer draft is not kept. */
export const DRAFT_MAX = 20_000;
/** The title editor's own limit. */
export const TITLE_MAX = 500;

const draftName = (space: string, task: string) => `draft.${space}.${task}`;
/** Each note on its way is kept under its own request ID; a name without one is an earlier build's. */
const notePrefix = (space: string, task: string) => `note.${space}.${task}`;
const titlePrefix = (space: string, task: string) => `title.${space}.${task}.`;
const editName = (space: string, task: string, field: string) =>
  `unsaved.${space}.${task}.${field}`;
const KINDS = ["draft.", "note.", "title.", "unsaved."] as const;

const listeners = new Set<() => void>();
let hearing: (() => void) | undefined;

function tell(): void {
  for (const listener of [...listeners]) listener();
}

function keep(name: string, value: string | undefined): void {
  browserKept.keep(name, value);
  tell();
}

/** Something kept changed, in this tab or another: a draft, a note, a title or a field edit. */
export function onUnsent(listener: () => void): () => void {
  listeners.add(listener);
  if (hearing === undefined) {
    const stops = KINDS.map((prefix) => onKeptUnder(prefix, tell));
    hearing = () => {
      for (const stop of stops) stop();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      hearing?.();
      hearing = undefined;
    }
  };
}

/**
 * What a draft sends: as typed, without the blank lines around it. The first line keeps its
 * indent, so pasted code arrives as it was. Empty when nothing was typed.
 */
export const wordsOf = (text: string): string =>
  text.trim() === "" ? "" : text.replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();

// The composer's draft, one per task for the browser.

const draftOf = (value: string | undefined): string =>
  value !== undefined && value.length <= DRAFT_MAX ? value : "";

export function readDraft(space: string, task: string): string {
  return draftOf(browserKept.read(draftName(space, task)));
}

/** Keeps what the task's composer holds; "" lets it go. A note on its way stays. */
export function keepDraft(space: string, task: string, text: string): void {
  keep(draftName(space, task), text === "" || text.length > DRAFT_MAX ? undefined : text);
}

/** Whether the task's composer holds words the person has not sent. */
export function hasDraft(space: string, task: string): boolean {
  return wordsOf(readDraft(space, task)) !== "";
}

/** Whether the task holds a draft, kept current as one comes or goes. */
export function useHasDraft(space: string, task: string): boolean {
  return useSyncExternalStore(onUnsent, () => hasDraft(space, task));
}

/** Another tab changed this task's draft. */
export function onDraft(space: string, task: string, listener: (text: string) => void): () => void {
  return onKept(draftName(space, task), (value) => {
    listener(draftOf(value));
  });
}

// A note on its way: kept from the moment it is sent until the service answered that it holds it,
// each under its own request ID, so a second note sent before the first one's answer takes nothing
// of it.

/** A note on its way: its words and the request ID that saves them once, also after a reload. */
export interface NoteRequest {
  readonly words: string;
  readonly id: string;
}

const NOTE_ID = /^[0-9a-f-]{36}$/u;

function noteOf(value: unknown): NoteRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { words, id } = value as { words?: unknown; id?: unknown };
  if (typeof words !== "string" || words === "" || words.length > DRAFT_MAX) return undefined;
  if (typeof id !== "string" || !NOTE_ID.test(id)) return undefined;
  return { words, id };
}

/** The task's notes on their way, each with the name it is kept under. */
function notesAt(
  space: string,
  task: string,
): { readonly name: string; readonly note: NoteRequest }[] {
  const prefix = notePrefix(space, task);
  return [prefix, ...browserKept.names(`${prefix}.`).sort()].flatMap((name) => {
    const note = noteOf(browserKept.json(name));
    // Under its own ID, or under the task's name alone as an earlier build kept it.
    return note !== undefined && (name === prefix || name === `${prefix}.${note.id}`)
      ? [{ name, note }]
      : [];
  });
}

/** The task's notes on their way, in a fixed order. */
export function readNotes(space: string, task: string): NoteRequest[] {
  return notesAt(space, task).map(({ note }) => note);
}

/** Keeps a note as it is sent: its answer, or the person, lets it go (`letGo`). */
export function keepNote(space: string, task: string, note: NoteRequest): void {
  keep(`${notePrefix(space, task)}.${note.id}`, JSON.stringify(note));
}

/** The task's notes on their way, as this tab and the others change them. */
export function useNotes(space: string, task: string): readonly NoteRequest[] {
  const kept = useSyncExternalStore(onUnsent, () => JSON.stringify(readNotes(space, task)));
  return useMemo(() => JSON.parse(kept) as NoteRequest[], [kept]);
}

// A title being typed. Each tab keeps its own under its own name: a tab writes only what it
// typed, so a second tab on the same task never takes or erases the first one's words.

export interface TitleDraft {
  /** What the person typed. */
  readonly typed: string;
  /** The title when the editor opened: one changed since is someone else's, shown as such. */
  readonly title: string;
  /** Where the page was when the editor opened: the save's base. */
  readonly base?: string;
}

/** A kept title of the task, this tab's or another's. */
export interface KeptTitle {
  readonly tab: string;
  readonly draft: TitleDraft;
  /** This tab typed it. */
  readonly mine: boolean;
}

const TAB_NAME = /^[a-z0-9]{1,16}$/u;

/** This tab's name for its titles: kept for the tab, so its reload finds them again. */
const TAB = ((): string => {
  const known = tabKept.read("tab");
  if (known !== undefined && TAB_NAME.test(known)) return known;
  const made = Math.random().toString(36).slice(2, 12) || "tab";
  tabKept.keep("tab", made);
  return made;
})();

function titleOf(value: unknown): TitleDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { typed, title, base } = value as Partial<Record<keyof TitleDraft, unknown>>;
  if (typeof typed !== "string" || typed.length > TITLE_MAX || typeof title !== "string") {
    return undefined;
  }
  return { typed, title, ...(typeof base === "string" ? { base } : {}) };
}

/** What this tab typed in the task's title, if it kept any. */
export function readTitleDraft(space: string, task: string): TitleDraft | undefined {
  return titleOf(browserKept.json(titlePrefix(space, task) + TAB));
}

/** Keeps what this tab's title editor holds; undefined when it holds nothing unsent. */
export function keepTitleDraft(space: string, task: string, draft: TitleDraft | undefined): void {
  keep(titlePrefix(space, task) + TAB, draft === undefined ? undefined : JSON.stringify(draft));
}

/** Every title kept for the task, this tab's first. */
export function keptTitles(space: string, task: string): KeptTitle[] {
  const prefix = titlePrefix(space, task);
  return browserKept
    .names(prefix)
    .map((name) => name.slice(prefix.length))
    .filter((tab) => TAB_NAME.test(tab))
    .flatMap((tab) => {
      const draft = titleOf(browserKept.json(prefix + tab));
      return draft === undefined ? [] : [{ tab, draft, mine: tab === TAB }];
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine) || (a.tab < b.tab ? -1 : 1));
}

/** The task's kept titles, as this tab and the others change them. */
export function useKeptTitles(space: string, task: string): readonly KeptTitle[] {
  const [kept, setKept] = useState(() => keptTitles(space, task));
  useEffect(() => {
    const read = () => {
      const next = keptTitles(space, task);
      setKept((known) => (JSON.stringify(known) === JSON.stringify(next) ? known : next));
    };
    read();
    return onUnsent(read);
  }, [space, task]);
  return kept;
}

/**
 * The page is going away (a reload, a close): a browser may take focus from a field then, and that
 * is no leaving of it. A navigation that did not happen ends with the person's next key or pointer.
 */
let unloading = false;
if (typeof window !== "undefined") {
  const going = () => {
    unloading = true;
  };
  const staying = () => {
    unloading = false;
  };
  window.addEventListener("beforeunload", going);
  window.addEventListener("pagehide", going);
  window.addEventListener("pageshow", staying);
  window.addEventListener("pointerdown", staying, { capture: true });
  window.addEventListener("keydown", staying, { capture: true });
}

export const pageLeaving = (): boolean => unloading;

// A field edit the service did not take. The tab's edits (edit/edits.ts) hold their own and hand
// them to the keeper; what is kept is the edit's source, never its request: the change is built
// again the one way a control builds it (`changeOf`), so a value read back is only ever one a
// control could have made.

const FIELDS: ReadonlySet<string> = new Set<Field>([
  "title",
  "summary",
  "status",
  "inbox",
  "priority",
  "effort",
  "due",
  "waiting_on",
  "grouping",
  "focus",
]);

const TASK_ID = /^[a-z]{1,4}_[0-9a-z]{1,64}$/u;
const REF = /^[A-Za-z0-9_-]{1,64}$/u;
const AS_OF = /^\d{1,16}\.\d{1,16}\.[0-9a-z]{1,64}$/u;

/** An edit as it is kept: undefined for one that cannot be built again. */
function keptOf(unsaved: Unsaved): string | undefined {
  const source = unsaved.change.source;
  if (source === undefined) return undefined;
  return JSON.stringify({
    task: unsaved.task,
    ref: unsaved.ref,
    field: unsaved.field,
    reason: unsaved.reason,
    ...(unsaved.base === undefined ? {} : { base: unsaved.base }),
    ...(unsaved.by === undefined ? {} : { by: unsaved.by }),
    ...(unsaved.at === undefined ? {} : { at: unsaved.at }),
    source,
  });
}

/** A kept edit, read by its shape. */
export function unsavedOf(value: unknown): Unsaved | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { task, ref, field, reason, base, by, at, source } = value as Record<string, unknown>;
  if (typeof task !== "string" || !TASK_ID.test(task)) return undefined;
  if (typeof ref !== "string" || !REF.test(ref)) return undefined;
  if (typeof field !== "string" || !FIELDS.has(field)) return undefined;
  if (reason !== "conflict" && reason !== "failed") return undefined;
  if (base !== undefined && (typeof base !== "string" || !AS_OF.test(base))) return undefined;
  if (by !== undefined && (typeof by !== "string" || by.length > 200)) return undefined;
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at))) return undefined;
  const change = changeOf(source);
  if (change === undefined || !change.fields.includes(field as Field)) return undefined;
  return {
    task,
    ref,
    field: field as Field,
    change,
    reason,
    ...(base === undefined ? {} : { base }),
    ...(by === undefined ? {} : { by }),
    ...(at === undefined ? {} : { at }),
  };
}

/** The edit kept under `name`, if it is one of ours. */
function editAt(space: string, name: string): Unsaved | undefined {
  const unsaved = unsavedOf(browserKept.json(name));
  return unsaved !== undefined && editName(space, unsaved.task, unsaved.field) === name
    ? unsaved
    : undefined;
}

/**
 * The tab's edits that wait, kept for the browser per space. A tab removes only what it kept or
 * read itself, and only while that value is still there, so a newer edit another tab kept under the
 * same name stays.
 */
export function unsavedKeeper(space: string): UnsavedKeeper {
  /** What this tab kept or read, by name, with the value it kept or read. */
  let known = new Map<string, { readonly unsaved: Unsaved; readonly value: string | undefined }>();
  return {
    load() {
      const found: Unsaved[] = [];
      for (const name of browserKept.names(`unsaved.${space}.`)) {
        const value = browserKept.read(name);
        const unsaved = editAt(space, name);
        // Not one of ours: it is removed, so it is never read again as anything.
        if (unsaved === undefined) {
          browserKept.keep(name, undefined);
          continue;
        }
        found.push(unsaved);
        known.set(name, { unsaved, value });
      }
      return found;
    },
    save(unsaved) {
      const next = new Map<
        string,
        { readonly unsaved: Unsaved; readonly value: string | undefined }
      >();
      for (const each of unsaved.values()) {
        const name = editName(space, each.task, each.field);
        const before = known.get(name);
        if (before?.unsaved === each) {
          next.set(name, before);
          continue;
        }
        // A new line where this tab kept or read one (a Try again refused) is written only while
        // the browser still holds that one, or nothing: another tab's newer value stays.
        const stored = browserKept.read(name);
        if (before !== undefined && stored !== undefined && stored !== before.value) {
          next.set(name, { unsaved: each, value: before.value });
          continue;
        }
        const value = keptOf(each);
        if (value !== undefined) browserKept.keep(name, value);
        next.set(name, { unsaved: each, value });
      }
      for (const [name, { value }] of known) {
        if (!next.has(name) && browserKept.read(name) === value) browserKept.keep(name, undefined);
      }
      known = next;
      tell();
    },
    onGone(listener) {
      return onUnsent(() => {
        for (const [name, { unsaved, value }] of known) {
          if (value === undefined || browserKept.read(name) !== undefined) continue;
          known.delete(name);
          listener(unsaved);
        }
      });
    },
  };
}

// Every kind together: what the foot of the Trash lists, and the one way to let a value go.

/** One kept value: its task, its kind and the exact value. */
export type Unsent =
  | { readonly kind: "draft"; readonly key: string; readonly task: string; readonly text: string }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly task: string;
      readonly text: string;
      /** The note's request ID: its value. */
      readonly id: string;
    }
  | {
      readonly kind: "title";
      readonly key: string;
      readonly task: string;
      readonly text: string;
      /** The tab that typed it. */
      readonly tab: string;
    }
  | {
      readonly kind: "edit";
      readonly key: string;
      readonly task: string;
      /** The person's value as words: their own text, or a message. */
      readonly shown: Words;
      readonly field: Field;
      readonly ref: string;
      /** The edit as kept: its value. */
      readonly value: string;
    };

const after = (prefix: string): string[] =>
  browserKept.names(prefix).map((name) => name.slice(prefix.length));
/** The task of a title's name, which ends in its tab, or of an edit's, which ends in its field. */
const taskOf = (rest: string): string => rest.slice(0, Math.max(0, rest.lastIndexOf(".")));
/** The task of a note's name, which ends in its request ID, or in the task as an earlier build's. */
const noteTask = (rest: string): string =>
  NOTE_ID.test(rest.split(".").pop() ?? "") ? taskOf(rest) : rest;

/** Every kept value of `space`, of every task and kind. */
export function unsentOf(space: string): Unsent[] {
  const out: Unsent[] = [];
  for (const task of after(`draft.${space}.`)) {
    const text = readDraft(space, task);
    if (wordsOf(text) !== "") out.push({ kind: "draft", key: `${task}:draft`, task, text });
  }
  for (const task of new Set(after(`note.${space}.`).map(noteTask))) {
    for (const note of readNotes(space, task)) {
      out.push({
        kind: "note",
        key: `${task}:note:${note.id}`,
        task,
        text: note.words,
        id: note.id,
      });
    }
  }
  for (const task of new Set(after(`title.${space}.`).map(taskOf))) {
    if (task === "") continue;
    for (const { tab, draft } of keptTitles(space, task)) {
      if (draft.typed.trim() === "") continue;
      out.push({ kind: "title", key: `${task}:title:${tab}`, task, text: draft.typed, tab });
    }
  }
  for (const name of browserKept.names(`unsaved.${space}.`)) {
    const unsaved = editAt(space, name);
    const value = browserKept.read(name);
    if (unsaved === undefined || value === undefined) continue;
    out.push({
      kind: "edit",
      key: `${unsaved.task}:${unsaved.field}`,
      task: unsaved.task,
      shown: unsaved.change.shown,
      field: unsaved.field,
      ref: unsaved.ref,
      value,
    });
  }
  return out;
}

/** Every kept value of `space`, kept current as this tab and the others change them. */
export function useUnsent(space: string): readonly Unsent[] {
  const [words, setWords] = useState(() => unsentOf(space));
  useEffect(() => {
    const read = () => {
      const next = unsentOf(space);
      setWords((known) => (JSON.stringify(known) === JSON.stringify(next) ? known : next));
    };
    read();
    return onUnsent(read);
  }, [space]);
  return words;
}

/** A value a caller holds: what it shows, or what it sent and the service now holds. */
export type Held =
  | { readonly kind: "draft"; readonly task: string; readonly text: string }
  | { readonly kind: "note"; readonly task: string; readonly id: string }
  /** Without `tab`, this tab's. */
  | { readonly kind: "title"; readonly task: string; readonly text: string; readonly tab?: string }
  | { readonly kind: "edit"; readonly task: string; readonly field: Field; readonly value: string };

/** Lets go of `held`, while it is still the value kept: a newer one, from anywhere, stays. */
export function letGo(space: string, held: Held): void {
  switch (held.kind) {
    case "draft":
      if (readDraft(space, held.task) === held.text) keep(draftName(space, held.task), undefined);
      return;
    case "note":
      for (const { name, note } of notesAt(space, held.task)) {
        if (note.id === held.id) keep(name, undefined);
      }
      return;
    case "title": {
      const name = titlePrefix(space, held.task) + (held.tab ?? TAB);
      if (titleOf(browserKept.json(name))?.typed === held.text) keep(name, undefined);
      return;
    }
    case "edit": {
      const name = editName(space, held.task, held.field);
      if (browserKept.read(name) === held.value) keep(name, undefined);
      return;
    }
  }
}

/** The tasks of `space` with anything kept, under whatever name. */
export function unsentTasks(space: string): string[] {
  const tasks = [
    ...after(`draft.${space}.`),
    ...after(`note.${space}.`).map(noteTask),
    ...after(`title.${space}.`).map(taskOf),
    ...after(`unsaved.${space}.`).map(taskOf),
  ];
  return [...new Set(tasks.filter((task) => task !== ""))];
}

/** Lets go of everything kept under `task`: a name that is no task's at all (leftovers.ts). */
export function forgetTask(space: string, task: string): void {
  browserKept.keep(draftName(space, task), undefined);
  browserKept.keep(notePrefix(space, task), undefined);
  for (const name of browserKept.names(`${notePrefix(space, task)}.`)) {
    browserKept.keep(name, undefined);
  }
  for (const name of browserKept.names(titlePrefix(space, task))) {
    browserKept.keep(name, undefined);
  }
  for (const name of browserKept.names(`unsaved.${space}.${task}.`)) {
    browserKept.keep(name, undefined);
  }
  tell();
}
