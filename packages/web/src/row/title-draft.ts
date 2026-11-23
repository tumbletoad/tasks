// A title the person is typing, kept for the browser as the composer keeps its words (composer.ts),
// so a reload or a crash of the tab brings it back in the title's editor, unsent. It goes when the
// editor saves it or Escape lets it go, and with its task once the task is gone (leftovers.ts). A
// kept title read back is untrusted text, shown only as the field's value.
import { browserKept } from "../kept.ts";

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

const nameOf = (space: string, task: string) => `title.${space}.${task}`;

export function readTitleDraft(space: string, task: string): TitleDraft | undefined {
  const value = browserKept.json(nameOf(space, task));
  if (typeof value !== "object" || value === null) return undefined;
  const { typed, title, base } = value as Partial<Record<keyof TitleDraft, unknown>>;
  if (typeof typed !== "string" || typed.length > TITLE_MAX || typeof title !== "string") {
    return undefined;
  }
  return { typed, title, ...(typeof base === "string" ? { base } : {}) };
}

/** Keeps what the person typed in the task's title; undefined lets it go. */
export function keepTitleDraft(space: string, task: string, draft: TitleDraft | undefined): void {
  browserKept.keep(nameOf(space, task), draft === undefined ? undefined : JSON.stringify(draft));
}

/** The tasks of `space` with a title kept. */
export function titleDraftTasks(space: string): string[] {
  const prefix = `title.${space}.`;
  return browserKept.names(prefix).map((name) => name.slice(prefix.length));
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
