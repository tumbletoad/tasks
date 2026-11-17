// What the page asks of the top field (TopBar.tsx) from elsewhere, and the field of the results:
// the search results' "Add … as a task" hands its text to the field's add mode, where the
// shortcuts show before anything is saved; the page's keys ask for a new task or a search; Enter
// in the search field asks the results of that search for focus. One listener per mounted top bar
// and result list; a tab has one of each.
type Request =
  | { readonly kind: "add"; readonly text: string }
  | { readonly kind: "new" }
  | { readonly kind: "search" };

const listeners = new Set<(request: Request) => void>();

export function askField(request: Request): void {
  for (const listener of listeners) listener(request);
}

export function onFieldRequest(listener: (request: Request) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The search whose first result should take focus once it is on screen. Enter right after typing
 * reaches the list before that search's results do, and the list it would reach is the previous
 * search's, which is about to go.
 */
let wanted: string | undefined;
const wantListeners = new Set<() => void>();

/** Asks the results of `q` (trimmed) for focus, now or when they arrive; undefined withdraws. */
export function wantResults(q: string | undefined): void {
  wanted = q;
  if (q !== undefined) for (const listener of wantListeners) listener();
}

/** Whether focus is asked of the results of `q`. */
export function isWanted(q: string): boolean {
  return wanted === q;
}

export function onWantResults(listener: () => void): () => void {
  wantListeners.add(listener);
  return () => {
    wantListeners.delete(listener);
  };
}
