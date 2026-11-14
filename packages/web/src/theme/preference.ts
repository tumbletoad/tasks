// The theme a browser shows (A5 3.19): `sumi` (the default, D17), `washi`, or `system`, which
// follows the browser's colour scheme live through the stylesheet alone.
//
// A1's `ui.theme` space preference is the planned home of this choice, written by `pref.set`.
// Neither the registry entry nor the snapshot's preferences exist yet, so the choice is kept per
// browser under `localStorage["<product>.theme"]` until they do (A5 3.19).
// A stored value is untrusted (A5 3.26): only one of the three words is used, anything else is
// removed and the default applies. Every access is wrapped: storage can be missing or blocked.
import { PRODUCT_ID } from "@tasks/brand";
import type { TokenStore } from "../stored.ts";

export const THEME_CHOICES = ["sumi", "washi", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const DEFAULT_THEME: ThemeChoice = "sumi";
export const THEME_KEY = `${PRODUCT_ID}.theme`;

const isChoice = (value: unknown): value is ThemeChoice =>
  typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);

/** The stored choice when it is one of the three words; the default otherwise. */
export function readTheme(store: TokenStore | undefined): ThemeChoice {
  if (store === undefined) return DEFAULT_THEME;
  let value: unknown;
  try {
    value = store.getItem(THEME_KEY);
  } catch {
    return DEFAULT_THEME;
  }
  if (value === null) return DEFAULT_THEME;
  if (isChoice(value)) return value;
  try {
    store.removeItem(THEME_KEY);
  } catch {
    // Blocked storage: the default applies for this load.
  }
  return DEFAULT_THEME;
}

export function keepTheme(store: TokenStore | undefined, choice: ThemeChoice): void {
  if (store === undefined || !isChoice(choice)) return;
  try {
    store.setItem(THEME_KEY, choice);
  } catch {
    // Storage is blocked or full: the choice holds for this load.
  }
}

/** Shows `choice` at once: an attribute on the root element, which the stylesheet reads. */
export function applyTheme(root: HTMLElement, choice: ThemeChoice): void {
  if (choice === DEFAULT_THEME) delete root.dataset["theme"];
  else root.dataset["theme"] = choice;
}
