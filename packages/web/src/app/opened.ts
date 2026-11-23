// The copy of a space the person's Open folder answered with: the tab that loads that space next
// asks for this copy, so another copy a second window opened in between is never shown in place
// of the folder they chose. Kept for this tab across the navigation (also a full reload) until the
// tab has loaded the space, or learned that it cannot.
import { tabKept } from "../kept.ts";

const COPY = /^[0-9a-f]{24}$/u;
const name = (space: string) => `opened.${space}`;

/** The tab goes to `space` for the copy `copy` (none: whatever copy is served). */
export function openedFor(space: string, copy: string | undefined): void {
  tabKept.keep(name(space), copy);
}

/** The copy the tab was sent to `space` for, if any. */
export function openedCopy(space: string): string | undefined {
  const copy = tabKept.read(name(space));
  return copy !== undefined && COPY.test(copy) ? copy : undefined;
}

/** The tab loaded `space`, or learned it cannot: the next load takes the copy served then. */
export function forgetOpened(space: string): void {
  tabKept.keep(name(space), undefined);
}
