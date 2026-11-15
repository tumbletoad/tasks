// The task list at the design scale and its rows (A7 3.12 M5.03; A5 3.6, 3.22, 3.25), in Chromium
// and Firefox against the real service process, with the built page and 5,000 open fixture tasks
// written into the space before the service opens it (bulk.ts).
//
// What the scroll test measures: in the page, once per animation frame while it scrolls the window
// from the top of the list to the bottom and back, how many items are mounted, whether any part of
// the viewport below the top bar is left uncovered by an item (a blank frame), whether the focused
// row still holds focus, and how long each frame took. What it cannot say: a CI runner or a
// development machine is not the real Ubuntu 24.04 machine A5's targets name, so the frame times
// are recorded, not judged; A5's 60 fps target there is M5.13's measurement. Programmatic scrolling also skips the
// compositor's own smooth scrolling, so it is a stricter test of coverage than a wheel, and no test
// of smoothness.
import { expect, type Page } from "@playwright/test";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { BULK_TASKS, test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS } from "./world.ts";

const THEME_KEY = `${PRODUCT_ID}.theme`;
/**
 * At least this many rows in the scroll test's area view, whichever area it is: three of every six
 * bulk tasks are in Lumen's projects and two in Home's (bulk.ts `PLACES`).
 */
const AREA_ROWS = BULK_TASKS / 3;

interface Sweep {
  readonly frames: number;
  readonly blank: number;
  readonly worstGap: number;
  readonly maxMounted: number;
  readonly lostFocus: number;
  readonly p95: number;
  readonly worst: number;
}

/** Scrolls the window by `step` px a frame until it stops, one way, and checks every frame. */
function sweep(page: Page, step: number): Promise<Sweep> {
  return page.evaluate(async (by) => {
    const list = document.querySelector("[data-list]");
    if (list === null) throw new Error("no list");
    const focused = document.activeElement;
    const frame = () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(resolve);
      });
    let frames = 0;
    let blank = 0;
    let worstGap = 0;
    let maxMounted = 0;
    let lostFocus = 0;
    const durations: number[] = [];
    let last = await frame();
    for (;;) {
      const before = window.scrollY;
      window.scrollBy(0, by);
      const now = await frame();
      durations.push(now - last);
      last = now;
      frames += 1;
      // What is drawn this frame: every mounted item's box, top to bottom.
      const items = [...list.querySelectorAll("[data-index]")];
      maxMounted = Math.max(maxMounted, items.length);
      const boxes = items
        .map((item) => item.getBoundingClientRect())
        .filter((box) => box.height > 0)
        .sort((a, b) => a.top - b.top);
      const bounds = list.getBoundingClientRect();
      const top = Math.max(64, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      let y = top;
      let gap = 0;
      for (const box of boxes) {
        if (box.bottom <= y) continue;
        if (box.top > y + 1) gap = Math.max(gap, box.top - y);
        y = Math.max(y, box.bottom);
        if (y >= bottom) break;
      }
      if (y < bottom - 1) gap = Math.max(gap, bottom - y);
      if (gap > 1) blank += 1;
      worstGap = Math.max(worstGap, gap);
      if (focused !== null && document.activeElement !== focused) lostFocus += 1;
      if (window.scrollY === before) break;
    }
    durations.sort((a, b) => a - b);
    return {
      frames,
      blank,
      worstGap,
      maxMounted,
      lostFocus,
      p95: durations[Math.floor(durations.length * 0.95)] ?? 0,
      worst: durations.at(-1) ?? 0,
    };
  }, step);
}

/** The window's top edge under the top bar, and the item there. */
const firstVisible = (page: Page) =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>("[data-list] li[data-key]")];
    let best: { key: string; top: number } | undefined;
    for (const item of items) {
      const box = item.getBoundingClientRect();
      if (box.bottom <= 64 || box.top >= window.innerHeight) continue;
      if (best === undefined || box.top < best.top) {
        best = { key: item.dataset["key"] ?? "", top: box.top };
      }
    }
    return best;
  });

const topOf = (page: Page, key: string) =>
  page.evaluate(
    (k) =>
      document.querySelector(`[data-list] li[data-key="${k}"]`)?.getBoundingClientRect().top ??
      null,
    key,
  );

const focusedKey = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest<HTMLElement>("li[data-key]")?.dataset["key"] ?? null,
  );

test.describe("[A7.3.12.m5-03.e2e.scroll-5000] 5,000 rows in the real store", () => {
  // Building the bulk world writes 5,000 tasks; the sweeps scroll about 260,000 px each way.
  test.setTimeout(600_000);

  test("the list stays bounded and covered top to bottom and back; focus and place are kept", async ({
    page,
    bulk,
  }) => {
    await watchViolations(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    // An area view lists every status of its area: about half of the 5,000 are in this one.
    await page.goto(await bulk.signInUrl(`/s/${bulk.mira.id}/area/${bulk.task.area}`));
    await showsSpace(page, bulk.mira.name);
    const list = page.locator("[data-list]");
    await expect(list).toHaveAttribute("data-virtual", "true", { timeout: SLOW_MS });
    // Rows say their place in their list and its true size, mounted or not.
    const rows = page.locator("[data-list] li[data-key]");
    const largest = await page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll("[data-list] li[aria-setsize]")].map((li) =>
          Number(li.getAttribute("aria-setsize")),
        ),
      ),
    );
    expect(largest).toBeGreaterThan(500);
    const mountedAtStart = await rows.count();
    expect(mountedAtStart).toBeLessThan(60);

    // Focus the first row's title, then sweep down and back up.
    const first = rows.first();
    const firstKey = (await first.getAttribute("data-key")) ?? "";
    await first.locator('[data-part="title"]').focus();
    const down = await sweep(page, 500);
    const atBottom = await page.evaluate(() => window.scrollY);
    const up = await sweep(page, -500);
    test.info().annotations.push({
      type: "measure",
      description: JSON.stringify({ project: test.info().project.name, down, up, atBottom }),
    });
    for (const run of [down, up]) {
      expect(run.frames).toBeGreaterThan(100);
      // Bounded: the visible items plus 10 each way, the pinned rows and their headings.
      expect(run.maxMounted).toBeLessThan(70);
      expect(run.blank, `frames with an uncovered gap (worst ${String(run.worstGap)} px)`).toBe(0);
      expect(run.lostFocus).toBe(0);
    }
    expect(atBottom).toBeGreaterThan(AREA_ROWS * 50);
    // The focused row left the window and came back: it still holds focus, at the top again.
    expect(await focusedKey(page)).toBe(firstKey);

    // End and Home move focus across the whole list, and bring the row into view.
    await page.keyboard.press("End");
    const lastKey = await focusedKey(page);
    expect(lastKey).not.toBe(firstKey);
    await expect(page.locator(`[data-list] li[data-key="${lastKey ?? ""}"]`)).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(AREA_ROWS * 50);
    await page.keyboard.press("Home");
    expect(await focusedKey(page)).toBe(firstKey);
    await expect(first).toBeInViewport();
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    const third = await focusedKey(page);
    expect(third).not.toBe(firstKey);

    // Focus is sacred (A5 3.15 item 6): an agent moves the focused row to the end of its group,
    // and it keeps its place on screen and its focus.
    await page.evaluate(() => {
      window.scrollTo(0, 120_000);
    });
    await expect.poll(() => firstVisible(page)).toBeDefined();
    const middle = await firstVisible(page);
    await page
      .locator(`[data-list] li[data-key="${middle?.key ?? ""}"] [data-part="title"]`)
      .focus();
    const before = (await topOf(page, middle?.key ?? "")) ?? Number.NaN;
    // The person at a terminal: Mira's autonomy would turn an agent's edit into a proposal.
    const read = (await bulk.op(bulk.mira.id, "task.get", { task: middle?.key })) as {
      as_of: string;
    };
    await bulk.op(bulk.mira.id, "task.update", {
      task: middle?.key,
      set: { status: "backlog" },
      base: read.as_of,
    });
    await expect(
      page.locator(`[data-list] li[data-key="${middle?.key ?? ""}"] span[data-kind="backlog"]`),
    ).toBeAttached({ timeout: SLOW_MS });
    expect(await focusedKey(page)).toBe(middle?.key);
    const after = (await topOf(page, middle?.key ?? "")) ?? Number.NaN;
    expect(Math.abs(after - before)).toBeLessThan(2);

    // Rows above the viewport keep the scroll anchored: a task is added at the top (the area's
    // tasks without a project come before its projects), and the first visible row stays where
    // it was.
    await page.getByRole("textbox", { name: "New task" }).focus();
    const anchor = await firstVisible(page);
    const height = () => list.evaluate((element) => element.style.getPropertyValue("--k-h"));
    const tall = await height();
    await bulk.op(bulk.mira.id, "task.add", {
      tasks: [
        { title: `Captured while scrolled (${test.info().project.name})`, area: bulk.task.area },
      ],
    });
    await expect.poll(height, { timeout: SLOW_MS }).not.toBe(tall);
    await page.waitForTimeout(300);
    expect(
      Math.abs(((await topOf(page, anchor?.key ?? "")) ?? 0) - (anchor?.top ?? 0)),
    ).toBeLessThan(2);

    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A7.3.12.m5-03.e2e.rows] The rows as a person sees them", () => {
  test.setTimeout(600_000);

  test("columns, chips, the star, expansion and narrow widths, in Sumi and Washi", async ({
    page,
    bulk,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // The Inbox, newest first, so every status chip is on the first screens.
    await page.goto(await bulk.signInUrl(`/s/${bulk.mira.id}/inbox`));
    await showsSpace(page, bulk.mira.name);
    const rows = page.locator("[data-list] li[data-key]");
    await expect(rows.first()).toBeVisible({ timeout: SLOW_MS });

    // A row the fixture launches, so a Connected tile is on screen.
    const launchedKey = (await rows.nth(1).getAttribute("data-key")) ?? "";
    const launched = page.locator(`[data-list] li[data-key="${launchedKey}"]`);
    await launched.locator('[data-part="title"]').click();
    await launched
      .getByRole("toolbar")
      .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
      .click();
    const tile = launched.locator('[data-part="tile"]');
    await expect(tile).toHaveAttribute("data-state", "connected", { timeout: SLOW_MS });
    await launched.locator('[data-part="title"]').click();
    await expect(launched.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "false");

    // The star shows at once and holds after a reload: the feed confirmed it.
    const row = rows.nth(2);
    const key = (await row.getAttribute("data-key")) ?? "";
    const star = row.locator('[data-part="star"]');
    const was = await star.getAttribute("aria-pressed");
    await star.click();
    const now = was === "true" ? "false" : "true";
    await expect(star).toHaveAttribute("aria-pressed", now);
    // A control is its own target: the row did not expand.
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(
      page.locator(`[data-list] li[data-key="${key}"] [data-part="star"]`),
    ).toHaveAttribute("aria-pressed", now, { timeout: SLOW_MS });
    // A click on the summary expands like the title.
    const summary = page.locator("[data-list] li[data-key] [data-part='summary']").first();
    await summary.click();
    await expect(
      page.locator("[data-list] li[data-expanded='true'] [data-part='title']"),
    ).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-list] li[data-expanded='true']")).toHaveCount(0);

    // Every chip the fixture has, and the columns, are on the first screens.
    for (const kind of ["waiting", "review", "backlog"]) {
      await expect(page.locator(`[data-list] span[data-kind="${kind}"]`).first()).toBeAttached();
    }

    for (const theme of ["sumi", "washi"] as const) {
      await page.evaluate(
        (value) => {
          localStorage.setItem(value.key, value.theme);
        },
        { key: THEME_KEY, theme },
      );
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.reload();
        await expect(rows.first()).toBeVisible({ timeout: SLOW_MS });
        // After a reload the page knows a task's launches once it reads them: expanding does.
        await launched.locator('[data-part="title"]').click();
        await launched.locator('[data-part="title"]').click();
        await expect(tile).toHaveAttribute("data-state", "connected", { timeout: SLOW_MS });
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, `horizontal scroll at ${String(width)} px`).toBeLessThanOrEqual(0);
        // Due, star and launch never drop; sources, folder, age and priority do when narrow.
        await expect(rows.first().locator('[data-part="star"]')).toBeVisible();
        await expect(rows.first().locator('[data-part="tile"]')).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath(`rows-${theme}-${String(width)}.png`),
        });
        // Further down: the long titles, the waiting chips with their people, the late dues.
        await page.evaluate(() => {
          window.scrollBy(0, 2_400);
        });
        await page.waitForTimeout(200);
        await page.screenshot({
          path: test.info().outputPath(`rows-${theme}-${String(width)}-down.png`),
        });
        if (width === 390) {
          // A long unbroken area or project name is cut, and never widens the page. The fixture's
          // names are short and no operation renames an area yet, so the names are lengthened in
          // place; the reload that follows restores them.
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
          await expect(page.locator("[data-list] h2").first()).toBeAttached();
          const widened = await page.evaluate(() => {
            const names = document.querySelectorAll(
              "[data-list] h2 > span[dir], [data-list] h3 > span[dir]",
            );
            for (const name of names) name.textContent = "W".repeat(160);
            return {
              names: names.length,
              scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          expect(widened.names).toBeGreaterThan(0);
          expect(widened.scroll, "horizontal scroll with long headings").toBeLessThanOrEqual(0);
        }
      }
    }
  });
});
