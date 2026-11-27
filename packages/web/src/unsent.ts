// What a person typed for a task and has not sent: a composer's draft, a note on its way, a title
// or a text being typed (each tab its own) and a field edit the service did not take. Each is kept in the
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
/** The summary's editor's own limit. */
export const SUMMARY_MAX = 400;
/** A text editor's own limit: a note's or a context's, the longest text a person corrects. */
export const TEXT_MAX = 65_536;

const draftName = (space: string, task: string) => `draft.${space}.${task}`;
/** Each note on its way is kept under its own request ID; a name without one is an earlier build's. */
const notePrefix = (space: string, task: string) => `note.${space}.${task}`;
const titlePrefix = (space: string, task: string) => `title.${space}.${task}.`;
const textPrefix = (space: string, task: string) => `text.${space}.${task}.`;
/**
 * Each refused edit under its own ID. An empty ID is an earlier build's, one per field, under a
 * prefix that build reads and clears of every name it cannot parse: the others stay out of it.
 */
const editPrefix = (space: string) => `edit.${space}.`;
const legacyPrefix = (space: string) => `unsaved.${space}.`;
const editName = (space: string, task: string, field: string, id: string) =>
  id === ""
    ? `${legacyPrefix(space)}${task}.${field}`
    : `${editPrefix(space)}${task}.${field}.${id}`;
const editNames = (space: string): string[] => [
  ...browserKept.names(editPrefix(space)),
  ...browserKept.names(legacyPrefix(space)),
];
const KINDS = ["draft.", "note.", "title.", "text.", "edit.", "unsaved."] as const;

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

/**
 * This tab's name for its titles and its refused edits: its reload finds them again. A browser
 * copies a tab's storage into a duplicate of it, so the name is out of that storage while the page
 * lives and goes back only as the page leaves: a copy finds none and is a tab of its own, which
 * never takes the original's words for its own.
 */
const TAB = ((): string => {
  const known = tabKept.read("tab");
  const name =
    known !== undefined && TAB_NAME.test(known)
      ? known
      : Math.random().toString(36).slice(2, 12) || "tab";
  tabKept.keep("tab", undefined);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      tabKept.keep("tab", name);
    });
    // Back from the back-forward cache, the page lives on.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) tabKept.keep("tab", undefined);
    });
  }
  return name;
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

// A text being typed in place of a task's own: its summary, its context, or the words of a note or
// a log entry. Each tab keeps its own, as for a title, under the text's part and the tab's name.
// Words the service refused are kept apart, not saved, until the person copies or discards them:
// the editor opens again on the text as it is now, and a new draft never takes their place.

/** What a text editor corrects: the summary, the context, or an entry by reference (n3, l4). */
export type TextPart = "summary" | "context" | `${"n" | "l"}${number}`;

const PART = /^(?:summary|context|[nl][1-9][0-9]{0,5})$/u;

export const isTextPart = (value: string): value is TextPart => PART.test(value);

export interface TextDraft {
  /** What the person typed. */
  readonly typed: string;
  /** The words when the editor opened. */
  readonly before: string;
  /** Where the page was when the editor opened: the save's base. */
  readonly base?: string;
}

function textOf(value: unknown): TextDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { typed, before, base } = value as Partial<Record<keyof TextDraft, unknown>>;
  if (typeof typed !== "string" || typed.length > TEXT_MAX || typeof before !== "string") {
    return undefined;
  }
  return { typed, before, ...(typeof base === "string" ? { base } : {}) };
}

const REFUSED = "refused";

const textName = (space: string, task: string, part: TextPart, tab = TAB, refused = false) =>
  `${textPrefix(space, task)}${part}.${tab}${refused ? `.${REFUSED}` : ""}`;

/** What this tab typed in place of the task's text `part`, if it kept any. */
export function readTextDraft(space: string, task: string, part: TextPart): TextDraft | undefined {
  return textOf(browserKept.json(textName(space, task, part)));
}

/** Keeps what this tab's editor of `part` holds; undefined when it holds nothing unsent. */
export function keepTextDraft(
  space: string,
  task: string,
  part: TextPart,
  draft: TextDraft | undefined,
): void {
  keep(textName(space, task, part), draft === undefined ? undefined : JSON.stringify(draft));
}

/** Keeps words of this tab's that the service refused for `part`: not saved, until let go. */
export function keepRefusedText(
  space: string,
  task: string,
  part: TextPart,
  draft: TextDraft,
): void {
  keep(textName(space, task, part, TAB, true), JSON.stringify(draft));
}

interface KeptText {
  readonly part: TextPart;
  readonly tab: string;
  readonly draft: TextDraft;
  /** The service refused these words: they wait as not saved. */
  readonly refused: boolean;
}

/** Every text kept for the task, of every tab, with its part. */
function keptTexts(space: string, task: string): KeptText[] {
  const prefix = textPrefix(space, task);
  return browserKept
    .names(prefix)
    .sort()
    .flatMap((name) => {
      const [part = "", tab = "", flag, ...rest] = name.slice(prefix.length).split(".");
      if (rest.length > 0 || !isTextPart(part) || !TAB_NAME.test(tab)) return [];
      if (flag !== undefined && flag !== REFUSED) return [];
      const draft = textOf(browserKept.json(name));
      return draft === undefined ? [] : [{ part, tab, draft, refused: flag === REFUSED }];
    });
}

/** The refused words kept for the task's `part`, of every tab, as they come and go. */
export function useRefusedTexts(
  space: string,
  task: string,
  part: TextPart,
): readonly { readonly tab: string; readonly typed: string }[] {
  const kept = useSyncExternalStore(onUnsent, () =>
    JSON.stringify(
      keptTexts(space, task)
        .filter((text) => text.refused && text.part === part)
        .map(({ tab, draft }) => ({ tab, typed: draft.typed })),
    ),
  );
  return useMemo(() => JSON.parse(kept) as { tab: string; typed: string }[], [kept]);
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

// A field edit the service did not take, each under its own ID: two tabs whose edits of one field
// are both refused keep both. The tab's edits (edit/edits.ts) hold their own and hand them to the
// keeper; what is kept is the edit's source, never its request: the change is built again the one
// way a control builds it (`changeOf`), so a value read back is only ever one a control could have
// made.

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
    ...(unsaved.id === "" ? {} : { id: unsaved.id }),
    tab: TAB,
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
  const { id, task, ref, field, reason, base, by, at, source } = value as Record<string, unknown>;
  if (id !== undefined && (typeof id !== "string" || !NOTE_ID.test(id))) return undefined;
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
    id: id ?? "",
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

/** A kept edit as the browser holds it: the edit and its exact value. */
export interface KeptEdit {
  readonly unsaved: Unsaved;
  readonly value: string;
}

/** The edit kept under `name`, if it is one of ours, with the tab that kept it. */
function editAt(space: string, name: string): (KeptEdit & { readonly tab?: string }) | undefined {
  const value = browserKept.read(name);
  const json = browserKept.json(name);
  const unsaved = unsavedOf(json);
  if (value === undefined || unsaved === undefined) return undefined;
  if (editName(space, unsaved.task, unsaved.field, unsaved.id) !== name) return undefined;
  const { tab } = json as { tab?: unknown };
  return { unsaved, value, ...(typeof tab === "string" && TAB_NAME.test(tab) ? { tab } : {}) };
}

/** Every edit kept for `space`, of every tab, in a fixed order. */
function keptEditsOf(space: string): KeptEdit[] {
  return editNames(space)
    .sort()
    .flatMap((name) => {
      const kept = editAt(space, name);
      return kept === undefined ? [] : [{ unsaved: kept.unsaved, value: kept.value }];
    });
}

/**
 * The tab's edits that wait, kept for the browser per space. A tab writes only the edits it made,
 * and changes or removes one only while the browser still holds what the tab kept there. An edit
 * another tab kept, or an earlier build, is never this tab's: it is listed (`useKeptEdits`), and
 * the person copies or discards it.
 */
export function unsavedKeeper(space: string): UnsavedKeeper {
  /** What this tab kept or took on, by name, with the value it kept or read. */
  let known = new Map<string, { readonly unsaved: Unsaved; readonly value: string | undefined }>();
  return {
    load() {
      const found: Unsaved[] = [];
      const fields = new Set<string>();
      for (const name of editNames(space).sort()) {
        const kept = editAt(space, name);
        // Not one of ours: it is removed, so it is never read again as anything.
        if (kept === undefined) {
          browserKept.keep(name, undefined);
          continue;
        }
        // This tab's own from before a reload, one per field. A copy of this tab keeps the others.
        const { unsaved, value, tab } = kept;
        const field = `${unsaved.task}.${unsaved.field}`;
        if (tab !== TAB || unsaved.id === "" || fields.has(field)) continue;
        fields.add(field);
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
      for (const each of new Set(unsaved.values())) {
        const name = editName(space, each.task, each.field, each.id);
        const before = known.get(name)?.value;
        const value = keptOf(each);
        // New, or the same edit refused again: written only over what this tab kept there.
        if (value !== before && browserKept.read(name) === before) {
          browserKept.keep(name, value);
          next.set(name, { unsaved: each, value });
        } else next.set(name, { unsaved: each, value: before });
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
      readonly kind: "text";
      readonly key: string;
      readonly task: string;
      readonly part: TextPart;
      readonly text: string;
      /** The tab that typed it. */
      readonly tab: string;
      /** The service refused it. */
      readonly refused: boolean;
    }
  | {
      readonly kind: "edit";
      readonly key: string;
      readonly task: string;
      /** The person's value as words: their own text, or a message. */
      readonly shown: Words;
      readonly field: Field;
      readonly ref: string;
      /** The edit's own ID; empty for an earlier build's. */
      readonly id: string;
      /** The edit as kept: its value. */
      readonly value: string;
    };

const after = (prefix: string): string[] =>
  browserKept.names(prefix).map((name) => name.slice(prefix.length));
/** The task of a title's name, which ends in its tab. */
const taskOf = (rest: string): string => rest.slice(0, Math.max(0, rest.lastIndexOf(".")));
/** The task of an edit's name, which its field and ID follow. */
const editTask = (rest: string): string => rest.split(".")[0] ?? "";
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
  for (const task of new Set(after(`text.${space}.`).map(editTask))) {
    if (task === "") continue;
    for (const { part, tab, draft, refused } of keptTexts(space, task)) {
      if (draft.typed.trim() === "") continue;
      const key = `${task}:${part}:${tab}${refused ? ":refused" : ""}`;
      out.push({ kind: "text", key, task, part, text: draft.typed, tab, refused });
    }
  }
  for (const { unsaved, value } of keptEditsOf(space)) {
    out.push({
      kind: "edit",
      key: `${unsaved.task}:${unsaved.field}:${unsaved.id}`,
      task: unsaved.task,
      shown: unsaved.change.shown,
      field: unsaved.field,
      ref: unsaved.ref,
      id: unsaved.id,
      value,
    });
  }
  return out;
}

/** The edits kept for a task's field, of every tab, kept current as they come and go. */
export function useKeptEdits(space: string, task: string, field: Field): readonly KeptEdit[] {
  const values = useSyncExternalStore(onUnsent, () =>
    JSON.stringify(
      keptEditsOf(space)
        .filter(({ unsaved }) => unsaved.task === task && unsaved.field === field)
        .map(({ value }) => value),
    ),
  );
  return useMemo(
    () =>
      (JSON.parse(values) as string[]).flatMap((value) => {
        const unsaved = unsavedOf(JSON.parse(value));
        return unsaved === undefined ? [] : [{ unsaved, value }];
      }),
    [values],
  );
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
  | {
      readonly kind: "text";
      readonly task: string;
      readonly part: TextPart;
      readonly text: string;
      readonly tab?: string;
      readonly refused?: boolean;
    }
  | {
      readonly kind: "edit";
      readonly task: string;
      readonly field: Field;
      readonly id: string;
      readonly value: string;
    };

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
    case "text": {
      const name = textName(space, held.task, held.part, held.tab, held.refused);
      if (textOf(browserKept.json(name))?.typed === held.text) keep(name, undefined);
      return;
    }
    case "edit": {
      const name = editName(space, held.task, held.field, held.id);
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
    ...after(`text.${space}.`).map(editTask),
    ...after(editPrefix(space)).map(editTask),
    ...after(legacyPrefix(space)).map(editTask),
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
  for (const name of [
    ...browserKept.names(titlePrefix(space, task)),
    ...browserKept.names(textPrefix(space, task)),
  ]) {
    browserKept.keep(name, undefined);
  }
  for (const name of [
    ...browserKept.names(`${editPrefix(space)}${task}.`),
    ...browserKept.names(`${legacyPrefix(space)}${task}.`),
  ]) {
    browserKept.keep(name, undefined);
  }
  tell();
}
