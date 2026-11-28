// Which projects of a space the person folded or opened in the side menu, kept for this browser on
// this computer: a reload and a new tab show them as they were left. The first two levels start
// open and the deeper ones folded, so what is kept is each project the person turned the other way.
// Another tab's fold does not move this tab's entries: only the person's own click here folds or
// unfolds. The menus of one tab (the side menu and the narrow drawer) show the same folds.
import { useCallback, useSyncExternalStore } from "react";
import { browserKept, type Kept } from "../kept.ts";

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const nameOf = (space: string) => `folded.${space}`;

/** The projects turned for `space`: IDs only, anything else read back is dropped. */
export function readFolds(space: string, kept: Kept = browserKept): ReadonlySet<string> {
  const value = kept.json(nameOf(space));
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((id): id is string => typeof id === "string" && NODE_ID.test(id)));
}

/** Keeps the turned projects of `space`; none removes the entry. */
export function keepFolds(space: string, folded: ReadonlySet<string>, kept: Kept = browserKept) {
  kept.keep(nameOf(space), folded.size === 0 ? undefined : JSON.stringify([...folded].sort()));
}

/** What this tab shows, per store and space: read once, then moved by this tab's clicks only. */
const shown = new WeakMap<Kept, Map<string, ReadonlySet<string>>>();
const listeners = new Set<() => void>();

/** The turned projects this tab shows for `space`. */
export function shownFolds(space: string, kept: Kept = browserKept): ReadonlySet<string> {
  let spaces = shown.get(kept);
  if (spaces === undefined) {
    spaces = new Map();
    shown.set(kept, spaces);
  }
  let folded = spaces.get(space);
  if (folded === undefined) {
    folded = readFolds(space, kept);
    spaces.set(space, folded);
  }
  return folded;
}

/**
 * Folds or unfolds `node` as the person's click asks. What is kept takes only this change, so a
 * fold made in another tab since this one loaded stays kept.
 */
export function toggleFold(space: string, node: string, kept: Kept = browserKept): void {
  const before = shownFolds(space, kept);
  const turn = !before.has(node);
  const apply = (set: ReadonlySet<string>) => {
    const next = new Set(set);
    if (turn) next.add(node);
    else next.delete(node);
    return next;
  };
  shown.get(kept)?.set(space, apply(before));
  keepFolds(space, apply(readFolds(space, kept)), kept);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A project this deep or deeper starts folded: three levels are laid out. */
const FOLDED_FROM = 3;

/** Whether the side menu shows `node`, at `depth` (1 at the top), folded. */
export const isFolded = (turned: ReadonlySet<string>, node: string, depth: number): boolean =>
  turned.has(node) !== depth >= FOLDED_FROM;

/** Whether a project of the space is folded, and a fold or unfold of one. */
export function useFolds(space: string): {
  readonly folded: (node: string, depth: number) => boolean;
  readonly toggle: (node: string) => void;
} {
  const turned = useSyncExternalStore(subscribe, () => shownFolds(space));
  const folded = useCallback(
    (node: string, depth: number) => isFolded(turned, node, depth),
    [turned],
  );
  const toggle = useCallback(
    (node: string) => {
      toggleFold(space, node);
    },
    [space],
  );
  return { folded, toggle };
}
