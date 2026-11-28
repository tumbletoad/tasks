// A routine a person does, on a space on the new storage, against the real service, through three
// weeks: the service's writer and the page each move their clock on together (WorldOptions.clock).
// Made from the Routines page, checked off early, a missed week that stays one late time, Skip and
// its Undo, a Done, Pause and Resume from its card, and Finish for good behind its dialog with its
// Undo. Then the screens at 1,440 and 390 px in both themes. Made-up text only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { day } from "./days.ts";
import { axeFound, picture, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const DAY_MS = 86_400_000;
const TITLE = "Water the plants";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const main = (page: Page) => page.getByRole("main");
const section = (page: Page, key: "due" | "coming" | "paused") =>
  main(page).locator(`[data-part="routines-${key}"]`);
const item = (page: Page) => main(page).locator('[data-part="routine"]').filter({ hasText: TITLE });
const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

function treeOf(world: World) {
  if (world.tree === undefined) throw new Error("the world has no tree space");
  return world.tree;
}

/** Moves both clocks on to `days` after this machine's time: the service's and the page's. */
async function moveTo(page: Page, world: World, days: number): Promise<void> {
  world.clock(days * DAY_MS);
  await page.clock.setSystemTime(Date.now() + days * DAY_MS);
  await page.reload();
}

/** The Routines page, with the page's clock `days` on, signed in as the person. */
async function openRoutines(page: Page, world: World, days: number): Promise<void> {
  await page.clock.install({ time: Date.now() + days * DAY_MS });
  await signIn(page, world, `/s/${treeOf(world).id}/routines`);
  await expect(main(page).locator('[data-part="routine-new"]')).toBeVisible({ timeout: SLOW_MS });
}

/** The routine's card, opened from its title unless it is open. */
async function card(page: Page) {
  const opened = main(page).locator('[data-part="routine-card"]');
  if (!(await opened.isVisible())) await item(page).locator('[data-part="routine-open"]').click();
  await expect(opened).toBeVisible();
  return opened;
}

test.describe("[A5.routines.e2e] a routine a person does, through three weeks on a tree space", () => {
  test.describe.configure({ mode: "serial" });

  test("made, Done early, a missed week, Skip and Undo, Done, Pause, Resume, Finish and its Undo", async ({
    page,
    routines: world,
  }) => {
    test.setTimeout(240_000);
    await openRoutines(page, world, 0);
    // The side menu lists Routines on a tree space, after Backlog and before Completed.
    const views = page
      .getByRole("navigation", { name: "Views and projects" })
      .locator("a[data-view]");
    await expect(views.filter({ hasText: "Routines" })).toBeVisible();
    const order = await views.evaluateAll((links) => links.map((l) => l.getAttribute("data-view")));
    expect(order.slice(order.indexOf("backlog"), order.indexOf("backlog") + 3)).toEqual([
      "backlog",
      "routines",
      "completed",
    ]);
    // Its day is two days from today: the first time is still to come.
    const first = day(2);
    const weekday = WEEKDAYS[new Date(first.start).getDay()] ?? "saturday";
    await main(page).locator('[data-part="routine-new"]').click();
    await main(page).locator('[data-part="routine-new-title"]').fill(TITLE);
    await main(page).locator('[data-part="routine-new-schedule"]').fill(`every ${weekday}`);
    await expect(main(page).locator('[data-part="routine-new-preview"]')).toHaveText(
      `Every ${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}`,
    );
    await main(page).locator('[data-part="routine-new-save"]').click();
    await expect(section(page, "coming").locator('[data-part="routine"]')).toContainText(TITLE, {
      timeout: SLOW_MS,
    });
    await expect(item(page)).toContainText("next ");

    // Watered early: that time is done, and the next one shows, a week on.
    await item(page).locator('[data-part="routine-check"]').click();
    await expect(toast(page)).toHaveText(`${TITLE}: this time is done`);
    await expect(item(page)).toContainText("last done ");
    await expect(section(page, "coming")).toContainText(TITLE);

    // Away for over a week: the next time passed unchecked, and stays one late time.
    await moveTo(page, world, 15);
    await expect(section(page, "due").locator('[data-part="routine"]')).toHaveCount(1, {
      timeout: SLOW_MS,
    });
    await expect(item(page)).toContainText("late since ");

    // Skipped, and that Skip undone: the late time is back.
    await item(page).locator('[data-part="routine-skip"]').click();
    await expect(toast(page)).toHaveText(`${TITLE}: this time is skipped`);
    await expect(section(page, "coming")).toContainText(TITLE);
    await toastAction(page).click();
    await expect(section(page, "due")).toContainText(TITLE, { timeout: SLOW_MS });

    // Done now: the third week's time comes next.
    await item(page).locator('[data-part="routine-check"]').click();
    await expect(section(page, "coming")).toContainText(TITLE, { timeout: SLOW_MS });
    await expect(section(page, "due")).toHaveCount(0);

    // Paused from its card, it waits under Paused; resumed, it comes back.
    await (await card(page)).locator('[data-part="routine-pause"]').click();
    await expect(section(page, "paused").getByRole("heading", { level: 2 })).toHaveText(
      "Paused (1)",
      {
        timeout: SLOW_MS,
      },
    );
    await (await card(page)).locator('[data-part="routine-pause"]').click();
    await expect(section(page, "coming")).toContainText(TITLE, { timeout: SLOW_MS });

    // Finishing for good asks first, and Undo brings it back.
    await (await card(page)).locator('[data-part="routine-finish"]').click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`Finish ${TITLE} for good?`);
    await expect(dialog).toContainText("Its 2 entries stay with it in Completed.");
    await dialog.locator('[data-part="routine-finish-confirm"]').click();
    await expect(item(page)).toHaveCount(0, { timeout: SLOW_MS });
    await expect(toast(page)).toHaveText(`${TITLE} is finished for good`);
    await toastAction(page).click();
    await expect(section(page, "coming")).toContainText(TITLE, { timeout: SLOW_MS });
  });

  test("the Routines page, its card, its dialog and Today at 1,440 and 390 px: nothing sideways, no violation", async ({
    browser,
    routines: world,
  }) => {
    test.setTimeout(300_000);
    const tree = treeOf(world);
    // A month on: the routine is late, on the Routines page and on Today.
    const days = 40;
    world.clock(days * DAY_MS);
    for (const theme of themes()) {
      await world.machine("ui.theme", theme);
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          bypassCSP: true,
          viewport: { width, height: width === 1440 ? 1000 : 844 },
          reducedMotion: "reduce",
        });
        try {
          const page = await context.newPage();
          const name = (what: string) => `routines-${what}-${theme}-${String(width)}.png`;
          await openRoutines(page, world, days);
          await expect(section(page, "due")).toContainText(TITLE, { timeout: SLOW_MS });
          await picture(page, name("page"), { fullPage: true });
          expect(await sideways(page)).toBe(0);
          expect(await axeFound(page, ["main"])).toEqual([]);
          const opened = await card(page);
          await expect(opened.locator('[data-part="routine-entry"]')).toHaveCount(2);
          await picture(page, name("card"), { fullPage: true });
          await opened.locator('[data-part="routine-finish"]').click();
          await expect(page.getByRole("alertdialog")).toBeVisible();
          await picture(page, name("finish"));
          await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
          await page.goto(`${world.origin}/s/${tree.id}/today`);
          await expect(main(page).locator('[data-part="today-routines"]')).toContainText(TITLE, {
            timeout: SLOW_MS,
          });
          await picture(page, name("today"), { fullPage: true });
          expect(await sideways(page)).toBe(0);
        } finally {
          await context.close();
        }
      }
    }
    await world.machine("ui.theme", null);
  });
});
