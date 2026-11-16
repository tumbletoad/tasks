// Completed holds every finished task (A5 3.5), in Chromium and Firefox against the real service
// process: a space with thousands of tasks finished in one month, some checked off, some dropped.
// Every one is reachable through "Show more", a dropped task shows in its month with its own mark,
// and a task finished while the list is open joins it without a repeat or a gap. Screenshots of
// the view in Sumi and Washi. Fixture data only.
import { expect, type Page } from "@playwright/test";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { FINISHED_TASKS, test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const THEME_KEY = `${PRODUCT_ID}.theme`;

/** The size of the list a row is in, as the row says it, for the row of the task titled so. */
const setSizeOf = (page: Page, title: string) =>
  page.evaluate((t) => {
    for (const row of document.querySelectorAll<HTMLElement>("main li[aria-setsize]")) {
      if (row.querySelector('[data-part="title"]')?.textContent === t) {
        return Number(row.getAttribute("aria-setsize"));
      }
    }
    return undefined;
  }, title);

/** The largest list size the mounted rows say they are in. */
const largestSetSize = (page: Page) =>
  page.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll("main li[aria-setsize]")].map((li) =>
        Number(li.getAttribute("aria-setsize")),
      ),
    ),
  );

/** Reads every page: "Show more" until the list has no more. */
async function readAll(page: Page): Promise<number> {
  const more = page.getByRole("button", { name: "Show more", exact: true });
  const busy = page.locator('main button[aria-disabled="true"]', { hasText: "Show more" });
  let clicks = 0;
  for (;;) {
    await expect(busy).toHaveCount(0, { timeout: SLOW_MS });
    if ((await more.count()) === 0) return clicks;
    await more.click();
    clicks += 1;
  }
}

async function openCompleted(page: Page, world: World): Promise<void> {
  await page.goto(await world.signInUrl(`/s/${world.mira.id}/completed`));
  await showsSpace(page, world.mira.name);
  await expect(page.getByRole("group", { name: "Checked off", exact: true })).toBeVisible({
    timeout: SLOW_MS,
  });
}

test.describe("[A7.3.12.m5-05.e2e.finished] Completed holds every finished task", () => {
  // Building the world writes 3,035 finished tasks; reading them takes about sixty pages.
  test.setTimeout(600_000);

  test("thousands in one month all reachable, a dropped task marked, one finished while open", async ({
    page,
    finished,
  }) => {
    await watchViolations(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openCompleted(page, finished);

    // The checked-off list is whole before any month: all of it is on the first page.
    const checkedSize = await setSizeOf(page, "Checked off fixture task 1");
    expect(checkedSize).toBeGreaterThanOrEqual(FINISHED_TASKS.pending);

    // The dropped tasks were finished last: they head the month, each marked as dropped.
    const dropped = page.locator('main li[data-task] [data-part="check"][data-dropped]');
    await expect(dropped.first()).toBeVisible({ timeout: SLOW_MS });
    await expect(dropped.first()).toBeChecked();
    expect(await dropped.first().getAttribute("aria-label")).toMatch(
      /^Dropped: Dropped fixture task \d+$/,
    );
    const droppedRow = page
      .locator('main li[data-task]:has([data-part="check"][data-dropped])')
      .first();
    await expect(droppedRow.locator("[data-tip^='Dropped ']").first()).toBeAttached();
    await page.screenshot({ path: test.info().outputPath("completed-first-page.png") });

    // Every page, then the month's size as its rows say it: past the 1,000 a search holds. The
    // list is at its end now, where every mounted row is the month's.
    const clicks = await readAll(page);
    expect(clicks).toBeGreaterThan(50);
    const monthSize = await largestSetSize(page);
    expect(monthSize).toBeGreaterThanOrEqual(FINISHED_TASKS.done + FINISHED_TASKS.dropped);

    // End reaches the month's last row.
    await page.locator('main li[data-task] [data-part="title"]').last().focus();
    await page.keyboard.press("End");
    const focused = page.locator("main li[data-task]:focus-within");
    await expect(focused).toBeInViewport();
    expect(Number(await focused.getAttribute("aria-posinset"))).toBe(monthSize);
    await page.screenshot({ path: test.info().outputPath("completed-end.png") });

    // A task finished while the list is open joins its month at the top; the list read again
    // holds every row it showed, none twice.
    const task = finished.task;
    const read = (await finished.op(finished.mira.id, "task.get", { task: task.ref })) as {
      as_of: string;
    };
    await finished.op(finished.mira.id, "task.finish", {
      task: task.ref,
      outcome: "Finished while Completed was open.",
      base: read.as_of,
    });
    // The month's first row is the task just finished: Home, then the next group.
    await expect(async () => {
      await page.keyboard.press("Home");
      await page.keyboard.press("]");
      await expect(focused).toHaveAttribute("data-task", task.ref, { timeout: 1_000 });
    }).toPass({ timeout: SLOW_MS });
    await expect(focused).toHaveAttribute("aria-posinset", "1");
    await page.screenshot({ path: test.info().outputPath("completed-joined.png") });
    // The list read again holds as many rows as it showed, so its oldest row moved to the next
    // page: read to the end again, and the month is one larger, none twice and none missing.
    await readAll(page);
    expect(await largestSetSize(page)).toBe(monthSize + 1);
    expect(await violations(page)).toEqual([]);
  });

  test("screenshots of Completed with checked-off, done and dropped tasks in Sumi and Washi", async ({
    browser,
    finished,
  }) => {
    for (const theme of ["sumi", "washi"] as const) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.addInitScript(
          (value) => {
            localStorage.setItem(value.key, value.theme);
          },
          { key: THEME_KEY, theme },
        );
        await openCompleted(page, finished);
        // The month's head, with the dropped tasks, under the checked-off list.
        const dropped = page.locator('main li[data-task] [data-part="check"][data-dropped]');
        await dropped.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath(`completed-${theme}-1440.png`) });
      } finally {
        await context.close();
      }
    }
  });
});
