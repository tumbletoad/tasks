// What a person typed and has not saved yet, kept in this browser so that a reload (the page asks
// for one after every upgrade) brings it back: the top field's text, a task's composer, a field
// edit the service did not take. Kept per space in `localStorage` under the product's prefix, as a
// per-viewer convenience. Every access is wrapped: when storage is missing, blocked or full, the
// text lives as long as the tab. What is read back is untrusted (another page served at this
// origin could have written it), so each reader checks its shape before it uses it.
import { PRODUCT_ID } from "@tasks/brand";

const PREFIX = `${PRODUCT_ID}.`;

/** The keys whose last write did not reach storage: this tab's value is the one to read. */
const local = new Map<string, string | undefined>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The kept value of `name`, or undefined. */
export function readKept(name: string): string | undefined {
  const key = PREFIX + name;
  if (local.has(key)) return local.get(key);
  try {
    const value: unknown = storage()?.getItem(key);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps `value` under `name`; undefined removes it. */
export function keep(name: string, value: string | undefined): void {
  const key = PREFIX + name;
  try {
    const store = storage();
    if (store === undefined) throw new Error("No storage");
    if (value === undefined) store.removeItem(key);
    else store.setItem(key, value);
    local.delete(key);
  } catch {
    local.set(key, value);
  }
}

/** The names kept under `prefix`, in storage and in this tab. */
export function keptNames(prefix: string): string[] {
  const found = new Set<string>();
  const wanted = PREFIX + prefix;
  try {
    const store = storage();
    for (let i = 0; store !== undefined && i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(wanted) === true) found.add(key.slice(PREFIX.length));
    }
  } catch {
    // Storage cannot be listed: this tab's own values still are.
  }
  for (const [key, value] of local) {
    const name = key.slice(PREFIX.length);
    if (!key.startsWith(wanted)) continue;
    if (value === undefined) found.delete(name);
    else found.add(name);
  }
  return [...found];
}

/**
 * Another tab of this browser kept or removed `name`: the listener gets the new value. Each tab
 * keeps its own copy on screen, so two tabs on one task do not overwrite each other unseen.
 */
export function onKept(name: string, listener: (value: string | undefined) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const key = PREFIX + name;
  const heard = (event: StorageEvent) => {
    if (event.key === key) listener(event.newValue ?? undefined);
    else if (event.key === null) listener(readKept(name));
  };
  window.addEventListener("storage", heard);
  return () => {
    window.removeEventListener("storage", heard);
  };
}

/**
 * Whether the person is typing in `element`: it has focus, in the window that has focus. Only
 * then does a field keep its own text when another tab changes what is kept.
 */
export const typingIn = (element: Element | null): boolean =>
  element !== null && document.hasFocus() && document.activeElement === element;

/** A kept JSON value, parsed; undefined when it is missing or not JSON. */
export function readKeptJson(name: string): unknown {
  const text = readKept(name);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
