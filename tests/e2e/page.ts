// What the e2e tests read off the page: the space a tab shows, a task's card, and CSP violations.
// Tests only.
import { expect, type Locator, type Page } from "@playwright/test";
import { SLOW_MS, type World } from "./world.ts";

/** The space switcher of the sidebar that is on screen, which names the tab's space. */
export function spaceSwitcher(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Space ${name}. Switch space` });
}

/** Waits until the tab shows `name`'s space, live. */
export async function showsSpace(page: Page, name: string): Promise<void> {
  await expect(spaceSwitcher(page, name)).toBeVisible();
}

/**
 * Opens a task's card through its link, signed in, and waits for its thread: the thread arrives
 * after the card and pushes the composer and the strip down, so a click before it can land where
 * a button no longer is. Runs come on a read of their own: a test that expects some waits for
 * them as well. Returns the task's row.
 */
export async function openTask(page: Page, world: World, ref: string): Promise<Locator> {
  await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
  await showsSpace(page, world.mira.name);
  const row = page.locator(`main li[data-task="${ref}"]`);
  await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
    timeout: SLOW_MS,
  });
  await expect(
    row
      .getByRole("list", { name: "Notes, log, sessions and runs" })
      .or(row.getByText("Nothing logged yet.")),
  ).toBeVisible({ timeout: SLOW_MS });
  return row;
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
