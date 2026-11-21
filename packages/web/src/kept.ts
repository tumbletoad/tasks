// What a person typed and has not saved yet, kept in the browser so that a reload (the page asks
// for one after every upgrade) brings it back: the top field's text, a task's composer, a field
// edit the service did not take. Text that belongs to a task is kept for the browser
// (`localStorage`): every tab of the task shows it. The top field's text belongs to the tab where
// it was typed (`sessionStorage`): it survives that tab's reload, and two tabs keep two drafts.
//
// Every access is wrapped: when storage is missing, blocked or full, the text lives as long as the
// tab. What is read back is untrusted (another page served at this origin could have written it),
// so each reader checks its shape before it uses it.
import { PRODUCT_ID } from "@ttasks/brand";

const PREFIX = `${PRODUCT_ID}.`;

export interface Kept {
  /** The kept value of `name`, or undefined. */
  read(name: string): string | undefined;
  /** Keeps `value` under `name`; undefined removes it. */
  keep(name: string, value: string | undefined): void;
  /** The names kept under `prefix`, in storage and in this tab. */
  names(prefix: string): string[];
  /** A kept JSON value, parsed; undefined when it is missing or not JSON. */
  json(name: string): unknown;
}

function keptIn(storage: () => Storage | undefined): Kept {
  /** The keys whose last write did not reach storage: this tab's value is the one to read. */
  const local = new Map<string, string | undefined>();
  const store = (): Storage | undefined => {
    try {
      return storage();
    } catch {
      return undefined;
    }
  };
  const read = (name: string): string | undefined => {
    const key = PREFIX + name;
    if (local.has(key)) return local.get(key);
    try {
      const value: unknown = store()?.getItem(key);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    read,
    keep(name, value) {
      const key = PREFIX + name;
      try {
        const held = store();
        if (held === undefined) throw new Error("No storage");
        if (value === undefined) held.removeItem(key);
        else held.setItem(key, value);
        local.delete(key);
      } catch {
        local.set(key, value);
      }
    },
    names(prefix) {
      const found = new Set<string>();
      const wanted = PREFIX + prefix;
      try {
        const held = store();
        for (let i = 0; held !== undefined && i < held.length; i += 1) {
          const key = held.key(i);
          if (key?.startsWith(wanted) === true) found.add(key.slice(PREFIX.length));
        }
      } catch {
        // Storage cannot be listed: this tab's own values still are.
      }
      for (const [key, value] of local) {
        if (!key.startsWith(wanted)) continue;
        const name = key.slice(PREFIX.length);
        if (value === undefined) found.delete(name);
        else found.add(name);
      }
      return [...found];
    },
    json(name) {
      const text = read(name);
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}

/** Kept for every tab of this browser: text that belongs to a task. */
export const browserKept = keptIn(() => globalThis.localStorage);

/** Kept for this tab, across its reloads: text that belongs to where it was typed. */
export const tabKept = keptIn(() => globalThis.sessionStorage);

/**
 * Another tab of this browser kept or removed `name` for the browser: the listener gets the new
 * value. Each tab keeps its own copy on screen, so two tabs on one task do not overwrite each
 * other unseen.
 */
export function onKept(name: string, listener: (value: string | undefined) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const key = PREFIX + name;
  const heard = (event: StorageEvent) => {
    if (event.storageArea !== null && event.storageArea !== globalThis.localStorage) return;
    if (event.key === key) listener(event.newValue ?? undefined);
    else if (event.key === null) listener(browserKept.read(name));
  };
  window.addEventListener("storage", heard);
  return () => {
    window.removeEventListener("storage", heard);
  };
}

/** Another tab of this browser kept or removed something under `prefix`. */
export function onKeptUnder(prefix: string, listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wanted = PREFIX + prefix;
  const heard = (event: StorageEvent) => {
    if (event.storageArea !== null && event.storageArea !== globalThis.localStorage) return;
    if (event.key === null || event.key.startsWith(wanted)) listener();
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
