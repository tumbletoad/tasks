// The theme a page shows: `sumi` (the default), `washi`, or `system`, which follows the browser's
// colour scheme live through the stylesheet alone. The choice is this machine's: the service keeps
// it in machine.toml, the shell arrives with it on the root element, so the first paint is already
// in it, and the feed brings each change to every tab.
import { PRODUCT_ID } from "@tasks/brand";
import type { TokenStore } from "../stored.ts";

export const THEME_CHOICES = ["sumi", "washi", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const DEFAULT_THEME: ThemeChoice = "sumi";

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);

/** The theme the shell was served in, or the default (a page not served by the service). */
export function servedTheme(root: HTMLElement): ThemeChoice {
  const value = root.dataset["theme"];
  return isThemeChoice(value) ? value : DEFAULT_THEME;
}

/** Shows `choice` at once: an attribute on the root element, which the stylesheet reads. */
export function applyTheme(root: HTMLElement, choice: ThemeChoice): void {
  root.dataset["theme"] = choice;
}

/** Where older builds kept the choice, one per browser. */
export const LEGACY_THEME_KEY = `${PRODUCT_ID}.theme`;

/**
 * A choice an older build kept in this browser, other than the default: the page hands it to this
 * machine once, so nobody loses their theme to the update. Anything else stored is no choice.
 */
export function legacyTheme(store: TokenStore | undefined): ThemeChoice | undefined {
  let value: unknown;
  try {
    value = store?.getItem(LEGACY_THEME_KEY);
  } catch {
    return undefined;
  }
  return isThemeChoice(value) && value !== DEFAULT_THEME ? value : undefined;
}

export function forgetLegacyTheme(store: TokenStore | undefined): void {
  try {
    store?.removeItem(LEGACY_THEME_KEY);
  } catch {
    // Blocked storage: nothing was kept there to forget.
  }
}
