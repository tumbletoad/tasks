// A title the person is typing, kept for the browser as the composer keeps its words (composer.ts),
// so a reload or a crash of the tab brings it back in the title's editor, unsent. Each tab keeps
// its own under its own name: a tab writes and lets go only of what it typed, so a second tab on
// the same task never takes or erases the first one's words. Another tab's words, and words kept
// on a task that was finished meanwhile, show beneath the title with Copy and Discard
// (KeptTitles.tsx). A draft goes when its editor saves it or Escape lets it go, when the person
// discards it, and with its task once the task is gone (leftovers.ts). A kept title read back is
// untrusted text, shown only as text.
import { useEffect, useState } from "react";
import { browserKept, onKeptUnder, tabKept } from "../kept.ts";

/** The title editor's own limit. */
export const TITLE_MAX = 500;

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

/** This tab's name for its drafts: kept for the tab, so its reload finds them again. */
const TAB = ((): string => {
  const known = tabKept.read("tab");
  if (known !== undefined && TAB_NAME.test(known)) return known;
  const made = Math.random().toString(36).slice(2, 12) || "tab";
  tabKept.keep("tab", made);
  return made;
})();

const prefixOf = (space: string, task: string) => `title.${space}.${task}.`;
const nameOf = (space: string, task: string, tab: string) => `${prefixOf(space, task)}${tab}`;

/** What this tab changed: the lines of the task follow (another tab's changes come as events). */
const changed = new Set<() => void>();
const tell = () => {
  for (const listener of changed) listener();
};

function draftOf(value: unknown): TitleDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { typed, title, base } = value as Partial<Record<keyof TitleDraft, unknown>>;
  if (typeof typed !== "string" || typed.length > TITLE_MAX || typeof title !== "string") {
    return undefined;
  }
  return { typed, title, ...(typeof base === "string" ? { base } : {}) };
}

/** What this tab typed in the task's title, if it kept any. */
export function readTitleDraft(space: string, task: string): TitleDraft | undefined {
  return draftOf(browserKept.json(nameOf(space, task, TAB)));
}

/** Keeps what this tab typed in the task's title; undefined lets it go. */
export function keepTitleDraft(space: string, task: string, draft: TitleDraft | undefined): void {
  browserKept.keep(
    nameOf(space, task, TAB),
    draft === undefined ? undefined : JSON.stringify(draft),
  );
  tell();
}

/** Every title kept for the task, this tab's first. */
export function keptTitles(space: string, task: string): KeptTitle[] {
  const prefix = prefixOf(space, task);
  return browserKept
    .names(prefix)
    .map((name) => name.slice(prefix.length))
    .filter((tab) => TAB_NAME.test(tab))
    .flatMap((tab) => {
      const draft = draftOf(browserKept.json(nameOf(space, task, tab)));
      return draft === undefined ? [] : [{ tab, draft, mine: tab === TAB }];
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine) || (a.tab < b.tab ? -1 : 1));
}

/**
 * The person lets a kept title go, whichever tab typed it. With `typed`, only while it is still
 * that: a newer one the tab typed since stays.
 */
export function discardTitleDraft(space: string, task: string, tab: string, typed?: string): void {
  if (typed !== undefined && draftOf(browserKept.json(nameOf(space, task, tab)))?.typed !== typed) {
    return;
  }
  browserKept.keep(nameOf(space, task, tab), undefined);
  tell();
}

/** Lets every title kept for the task go: the task is gone. */
export function forgetTitleDrafts(space: string, task: string): void {
  for (const { tab } of keptTitles(space, task))
    browserKept.keep(nameOf(space, task, tab), undefined);
  tell();
}

/** The tasks of `space` with a title kept. */
export function titleDraftTasks(space: string): string[] {
  const prefix = `title.${space}.`;
  const tasks = browserKept.names(prefix).map((name) => name.slice(prefix.length).split(".")[0]);
  return [...new Set(tasks.filter((task) => task !== undefined && task !== ""))] as string[];
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
    changed.add(read);
    const stop = onKeptUnder(prefixOf(space, task), read);
    return () => {
      changed.delete(read);
      stop();
    };
  }, [space, task]);
  return kept;
}

/**
 * The page is going away (a reload, a close): a browser may take focus from the field then, and
 * that is no leaving of it. A navigation that did not happen ends with the person's next key or
 * pointer.
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
