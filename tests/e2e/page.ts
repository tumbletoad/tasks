// What the e2e tests read off the page: the space a tab shows, and CSP violations. Tests only.
import { expect, type Locator, type Page } from "@playwright/test";

/** The space switcher of the sidebar that is on screen, which names the tab's space. */
export function spaceSwitcher(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Space ${name}. Switch space` });
}

/** Waits until the tab shows `name`'s space, live. */
export async function showsSpace(page: Page, name: string): Promise<void> {
  await expect(spaceSwitcher(page, name)).toBeVisible();
}

/** Records every CSP violation the page reports, from before its first script runs. */
export async function watchViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { violations: string[] }).violations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

export const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { violations?: string[] }).violations ?? []);
