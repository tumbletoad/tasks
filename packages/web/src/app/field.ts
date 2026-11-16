// What the page asks of the top field (TopBar.tsx) from elsewhere: the search results' "Add … as
// a task" hands its text to the field's add mode, where the shortcuts show before anything is
// saved. One listener per mounted top bar; a tab has one.
type Request = { readonly kind: "add"; readonly text: string };

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
