// Which areas of a space the person folded in the sidebar, kept for this browser on this computer:
// a reload and a new tab show them as they were left. Another tab's fold does not move this tab's
// entries: only the person's own click here folds or unfolds.
import { useCallback, useState } from "react";
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

/** The space's folded areas, and a fold or unfold of one. */
export function useFolds(space: string): {
  readonly folded: ReadonlySet<string>;
  readonly toggle: (area: string) => void;
} {
  const [state, setState] = useState(() => ({ space, folded: readFolds(space) }));
  // Another space in this tab: its own folds.
  const current = state.space === space ? state : { space, folded: readFolds(space) };
  if (current !== state) setState(current);
  const toggle = useCallback(
    (area: string) => {
      setState((before) => {
        const base = before.space === space ? before.folded : readFolds(space);
        const next = new Set(base);
        if (next.has(area)) next.delete(area);
        else next.add(area);
        keepFolds(space, next);
        return { space, folded: next };
      });
    },
    [space],
  );
  return { folded: current.folded, toggle };
}
