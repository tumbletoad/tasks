// The page's one stored value: the bearer token under `localStorage["<product>.token"]` (A2 3.8.4).
//
// Values read back from `localStorage` are untrusted (A2 3.8.6, A5 3.26): a page another local user
// served at this origin while the service was stopped could have written anything there. So a read
// is used only when it has the exact shape of a token, and anything else is removed and treated as
// signed out. Every access is wrapped: storage can be missing, blocked or full, and losing the
// token only signs the browser out.
import { PRODUCT_ID } from "@ttasks/brand";

export const TOKEN_KEY = `${PRODUCT_ID}.token`;

/** A UI token: `ttasks_u_` and 43 base64url characters (A2 3.8.4). Nothing else is sent. */
export const TOKEN_SHAPE = /^ttasks_u_[A-Za-z0-9_-]{43}$/;

/** The part of `Storage` the page uses, so tests can pass a hostile one. */
export type TokenStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The browser's localStorage, or undefined when reading the property itself throws. */
export function browserStore(): TokenStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The stored token when it has a token's shape. Anything else is dropped. */
export function readToken(store: TokenStore | undefined): string | null {
  if (store === undefined) return null;
  let value: unknown;
  try {
    value = store.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
  if (value === null) return null;
  if (typeof value === "string" && TOKEN_SHAPE.test(value)) return value;
  // Not ours: remove it, so it is never read again as anything.
  keepToken(store, null);
  return null;
}

/** Stores a token (only one of the token's shape), or removes it with null. */
export function keepToken(store: TokenStore | undefined, token: string | null): void {
  if (store === undefined) return;
  try {
    if (token !== null && TOKEN_SHAPE.test(token)) store.setItem(TOKEN_KEY, token);
    else store.removeItem(TOKEN_KEY);
  } catch {
    // Storage is blocked or full: the page works for this load and signs out on the next.
  }
}
