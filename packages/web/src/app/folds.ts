// Which areas of a space the person folded in the sidebar, kept for this browser on this computer:
// a reload and a new tab show them as they were left. Another tab's fold does not move this tab's
// entries: only the person's own click here folds or unfolds. The menus of one tab (the side menu
// and the narrow drawer) show the same folds.
import { useCallback, useSyncExternalStore } from "react";
import { browserKept, type Kept } from "../kept.ts";

const AREA_ID = /^[A-Za-z0-9_-]{1,64}$/;

const nameOf = (space: string) => `folded.${space}`;

/** The folded areas kept for `space`: area IDs only, anything else read back is dropped. */
export function readFolds(space: string, kept: Kept = browserKept): ReadonlySet<string> {
  const value = kept.json(nameOf(space));
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((id): id is string => typeof id === "string" && AREA_ID.test(id)));
}

/** Keeps the folded areas of `space`; none removes the entry. */
export function keepFolds(space: string, folded: ReadonlySet<string>, kept: Kept = browserKept) {
  kept.keep(nameOf(space), folded.size === 0 ? undefined : JSON.stringify([...folded].sort()));
}

/** What this tab shows, per store and space: read once, then moved by this tab's clicks only. */
const shown = new WeakMap<Kept, Map<string, ReadonlySet<string>>>();
const listeners = new Set<() => void>();

/** The folded areas this tab shows for `space`. */
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
 * Folds or unfolds `area` as the person's click asks. What is kept takes only this change, so a
 * fold made in another tab since this one loaded stays kept.
 */
export function toggleFold(space: string, area: string, kept: Kept = browserKept): void {
  const before = shownFolds(space, kept);
  const fold = !before.has(area);
  const apply = (set: ReadonlySet<string>) => {
    const next = new Set(set);
    if (fold) next.add(area);
    else next.delete(area);
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

/** The space's folded areas, and a fold or unfold of one. */
export function useFolds(space: string): {
  readonly folded: ReadonlySet<string>;
  readonly toggle: (area: string) => void;
} {
  const folded = useSyncExternalStore(subscribe, () => shownFolds(space));
  const toggle = useCallback(
    (area: string) => {
      toggleFold(space, area);
    },
    [space],
  );
  return { folded, toggle };
}
