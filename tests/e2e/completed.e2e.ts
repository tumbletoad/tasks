// Completed holds every finished task (A5 3.5), in Chromium and Firefox against the real service
// process: a space with thousands of tasks finished in one month, some checked off, some dropped.
// Each row says how its task ended, scrolling reads on to the last row without a click and without
// a row moving under the pointer, "Show more" still reads on from the keyboard, a dropped task
// shows in its month with its own mark, and a task finished while the list is open joins it with
// every row it showed still there. Screenshots in Sumi and Washi at 1440 and 390 px. Fixture data.
import { expect, type Page, type Route } from "@playwright/test";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { FINISHED_TASKS, test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const THEME_KEY = `${PRODUCT_ID}.theme`;
const SUMMARY = "Check the beds after the frost";

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

/** Each mounted row's title and the line under it (its ending, else its summary). */
const linesOf = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("main li[data-task]")].map((row) => ({
      title: row.querySelector('[data-part="title"]')?.textContent ?? "",
      part: row
        .querySelector("[data-part='ending'], [data-part='summary']")
        ?.getAttribute("data-part"),
      line: row.querySelector("[data-part='ending'] > [dir], [data-part='summary'] > [dir]")
        ?.textContent,
    })),
  );

/** The line a fixture task's row shows: bulk.ts gives the outcomes and reasons in turn. */
function expectedLine(title: string): { part: string; line: string } | undefined {
  const n = Number(/(\d+)$/u.exec(title)?.[1]);
  const turn = (n - 1) % 3;
  if (title.startsWith("Checked off fixture task")) return { part: "summary", line: SUMMARY };
  if (title.startsWith("Dropped fixture task")) {
    const reasons = ["The neighbours share theirs now.", "Too late in the season."];
    const reason = reasons[turn];
    return reason === undefined
      ? { part: "summary", line: SUMMARY }
      : { part: "ending", line: reason };
  }
  if (title.startsWith("Finished fixture task")) {
    const lines = [
      "Done as planned.",
      "Repotted the herbs into the larger planters.",
      "Moved the compost bins to the shady corner by the shed, turned both piles, added two bags " +
        "of leaves and a layer of grass cuttings, and checked the moisture again after the rain.",
    ];
    return { part: "ending", line: lines[turn] ?? "" };
  }
  return undefined;
}

/** Holds the next page's reads until `release`, so a test can look at the list while one waits. */
function pageGate(page: Page) {
  let closed = false;
  const held: Route[] = [];
  return {
    async install() {
      await page.route("**/api/v1/op/task.finished", async (route) => {
        const body = route.request().postDataJSON() as { cursor?: string };
        if (closed && body.cursor !== undefined) held.push(route);
        else await route.continue();
      });
    },
    close() {
      closed = true;
    },
    held: () => held.length,
    async release() {
      closed = false;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

/** Waits until the page's scroll has stood still for a few frames (a wheel may scroll smoothly). */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = window.scrollY;
        let still = 0;
        const look = () => {
          still = window.scrollY === last ? still + 1 : 0;
          last = window.scrollY;
          if (still >= 3) resolve();
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );

/** Where the row under the pointer is, and the page's scroll. */
const underPointer = (page: Page, y: number) =>
  page.evaluate((py) => {
    const row = [...document.querySelectorAll("main li[data-task]")].find((li) => {
      const { top, bottom } = li.getBoundingClientRect();
      return top <= py && py < bottom;
    });
    return {
      task: row?.getAttribute("data-task") ?? undefined,
      top: row?.getBoundingClientRect().top,
    };
  }, y);

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

  test("thousands in one month read on by scrolling, each row saying how its task ended", async ({
    page,
    finished,
  }) => {
    await watchViolations(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const gate = pageGate(page);
    await gate.install();
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

    // Each row says how its task ended where the summary goes: the outcome's first line, why a
    // task was dropped; the summary when there is neither (checked off, or dropped without a word).
    const lines = await linesOf(page);
    const kinds = new Set<string>();
    for (const { title, part, line } of lines) {
      const want = expectedLine(title);
      if (want === undefined) continue;
      expect({ title, part, line }).toEqual({ title, ...want });
      kinds.add(`${title.split(" ")[0] ?? ""} ${want.part}`);
    }
    expect([...kinds].sort()).toEqual([
      "Checked summary",
      "Dropped ending",
      "Dropped summary",
      "Finished ending",
    ]);
    await page.screenshot({ path: test.info().outputPath("completed-first-page.png") });

    // From the keyboard: reaching "Show more" brings it on screen, which reads on; out of sight
    // again, with focus kept on it, Enter reads the next page.
    const more = page.getByRole("button", { name: "Show more", exact: true });
    const busy = page.locator('main button[aria-disabled="true"]', { hasText: "Show more" });
    const before = await largestSetSize(page);
    await more.focus();
    await expect.poll(() => largestSetSize(page), { timeout: SLOW_MS }).toBeGreaterThan(before);
    await expect(busy).toHaveCount(0, { timeout: SLOW_MS });
    const reached = await largestSetSize(page);
    await expect(more).not.toBeInViewport();
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => largestSetSize(page), { timeout: SLOW_MS }).toBeGreaterThan(reached);
    await expect(more).toBeFocused();
    await expect(busy).toHaveCount(0, { timeout: SLOW_MS });

    // Scrolling reads on to the end with no click. While a page is on its way, the row under the
    // pointer stays where it is, and stays there when the page arrives.
    const box = page.viewportSize() ?? { width: 1280, height: 720 };
    const [x, y] = [Math.round(box.width * 0.55), Math.round(box.height * 0.5)];
    await page.mouse.move(x, y);
    let pages = 0;
    for (let wheels = 0; (await more.count()) > 0; wheels += 1) {
      expect(wheels).toBeLessThan(2_000);
      gate.close();
      await page.mouse.wheel(0, 1_500);
      await settled(page);
      // The list's end within a screen below: the next page is asked for.
      const near = await more.evaluate(
        (button) => button.getBoundingClientRect().top < 2 * window.innerHeight - 24,
      );
      if (!near) continue;
      await expect.poll(() => gate.held(), { timeout: SLOW_MS }).toBeGreaterThan(0);
      await settled(page);
      const waiting = await underPointer(page, y);
      const size = await largestSetSize(page);
      await gate.release();
      await expect.poll(() => largestSetSize(page), { timeout: SLOW_MS }).toBeGreaterThan(size);
      await expect(busy).toHaveCount(0, { timeout: SLOW_MS });
      await settled(page);
      const arrived = await underPointer(page, y);
      expect(arrived.task).toBeDefined();
      expect(arrived.task).toBe(waiting.task);
      // The row is where it was on screen. The page's scroll offset itself may move a few pixels:
      // the list corrects a measured height above the row that way, to keep the row still.
      expect(Math.abs((arrived.top ?? 0) - (waiting.top ?? 0))).toBeLessThan(1);
      pages += 1;
    }
    await gate.release();
    expect(pages).toBeGreaterThan(50);
    const monthSize = await largestSetSize(page);
    expect(monthSize).toBeGreaterThanOrEqual(FINISHED_TASKS.done + FINISHED_TASKS.dropped);

    // End reaches the month's last row.
    await page.locator('main li[data-task] [data-part="title"]').last().focus();
    await page.keyboard.press("End");
    const focused = page.locator("main li[data-task]:focus-within");
    await expect(focused).toBeInViewport();
    expect(Number(await focused.getAttribute("aria-posinset"))).toBe(monthSize);
    await page.screenshot({ path: test.info().outputPath("completed-end.png") });

    // A task finished while the list is open joins its month at the top, saying how it ended. The
    // list read again holds every row it showed: the month is one larger at once.
    const task = finished.task;
    const read = (await finished.op(finished.mira.id, "task.get", { task: task.ref })) as {
      as_of: string;
    };
    await finished.op(finished.mira.id, "task.finish", {
      task: task.ref,
      outcome: "Finished while Completed was open.\nThe rest of the outcome.",
      base: read.as_of,
    });
    await expect.poll(() => largestSetSize(page), { timeout: SLOW_MS }).toBe(monthSize + 1);
    await expect(more).toHaveCount(0);
    // The month's first row is the task just finished: Home, then the next group.
    await expect(async () => {
      await page.keyboard.press("Home");
      await page.keyboard.press("]");
      await expect(focused).toHaveAttribute("data-task", task.ref, { timeout: 1_000 });
    }).toPass({ timeout: SLOW_MS });
    await expect(focused).toHaveAttribute("aria-posinset", "1");
    await expect(focused.locator("[data-part='ending']")).toHaveText(
      "Finished while Completed was open.",
    );
    await page.screenshot({ path: test.info().outputPath("completed-joined.png") });
    expect(await violations(page)).toEqual([]);
  });

  test("screenshots of Completed with endings, checked-off and dropped tasks in Sumi and Washi", async ({
    browser,
    finished,
  }) => {
    for (const theme of ["sumi", "washi"] as const) {
      for (const width of [1440, 390]) {
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
          // Opened wide, where the sidebar names the space, then narrowed.
          await openCompleted(page, finished);
          if (width !== 1440) await page.setViewportSize({ width, height: 844 });
          // The month's head, with the dropped tasks and the done ones' endings.
          const dropped = page.locator('main li[data-task] [data-part="check"][data-dropped]');
          await dropped.first().scrollIntoViewIfNeeded();
          await page.evaluate(() => {
            const row = document.querySelector("main li[data-task]:has([data-dropped])");
            if (row !== null) window.scrollBy(0, row.getBoundingClientRect().top - 120);
          });
          await expect(page.locator("main [data-part='ending']").first()).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(`completed-${theme}-${String(width)}.png`),
          });
        } finally {
          await context.close();
        }
      }
    }
  });
});
