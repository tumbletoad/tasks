// The theme a page shows: `sumi` (the default), `washi`, or `system`, which follows the browser's
// colour scheme live through the stylesheet alone. The choice is this machine's: the service keeps
// it in machine.toml, the shell arrives with it on the root element, so the first paint is already
// in it, and the feed brings each change to every tab.

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
