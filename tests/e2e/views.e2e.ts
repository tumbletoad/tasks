// The status views, the area view, Completed and the sidebar end to end (A7 3.12 M5.05; A5 3.3,
// 3.5, 3.15, 3.16), in Chromium and Firefox against the real service process with fixture data.
//
// Verify line: counts add up across disjoint views (also a property test,
// `A5.3.5.web.counts-add-up`), no view has a heading element that names it, and a task that starts
// to match Completed appears there. Also: every sidebar view in its fixed place when it is empty,
// Waiting by person, Inbox's and Review's visible moves, the area view by project, and screenshots
// with axe in Sumi and Washi at 1,440 and 390 px. The world's other tests add tasks of their own,
// so the assertions name this test's tasks, never a whole list.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page } from "@playwright/test";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const THEME_KEY = `${PRODUCT_ID}.theme`;
const VIEWS = ["Today", "Inbox", "Open", "Waiting", "Review", "Backlog", "Completed", "Agents"];

interface Added {
  readonly tasks: readonly { readonly id: string; readonly ref: string }[];
}

const asOf = async (world: World, ref: string): Promise<string> =>
  ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string }).as_of;

async function add(world: World, drafts: readonly Record<string, unknown>[]): Promise<string[]> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: drafts })) as Added;
  return added.tasks.map((t) => t.ref);
}

const row = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Views and areas" });

async function open(page: Page, world: World, path: string, space = world.mira): Promise<void> {
  await page.goto(await world.signInUrl(`/s/${space.id}/${path}`));
  await showsSpace(page, space.name);
}

/** No heading in the view names it (U3): the sidebar's item and the tab's title do. */
async function noViewHeading(page: Page, name: string): Promise<void> {
  await expect(page.locator("main h1")).toHaveCount(0);
  const headings = await page.locator("main h1, main h2, main h3, main h4").allTextContents();
  expect(headings.map((text) => text.trim())).not.toContain(name);
}

test.describe("[A7.3.12.m5-05.e2e.views] the status views, the area view, Completed and the sidebar", () => {
  test("every view in its place, counts that add up, grouping, the moves, and Completed live", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const person = `Tom Haas (${tag})`;
    const [photos, invoice, other, capture, docs, lease] = await add(world, [
      { title: `New product photos (${tag})`, area: "home", status: "waiting", waiting_on: person },
      {
        title: `Invoice for the van (${tag})`,
        area: "lumen",
        status: "waiting",
        waiting_on: person,
      },
      { title: `Signed contract (${tag})`, status: "waiting", waiting_on: `Ana Reyes (${tag})` },
      { title: `Call the plumber (${tag})`, inbox: true },
      {
        title: `Docs migration (${tag})`,
        area: "lumen",
        project: "lumen-portal",
        status: "review",
      },
      { title: `Sign the lease (${tag})`, area: "home", priority: 2 },
    ]);
    if (
      photos === undefined ||
      invoice === undefined ||
      other === undefined ||
      capture === undefined ||
      docs === undefined ||
      lease === undefined
    ) {
      throw new Error("the tasks were not added");
    }
    await watchViolations(page);

    // The sidebar of a space whose Waiting, Review and Backlog are empty: every view is there, in
    // its fixed order, an empty one without a count and named so.
    await open(page, world, "today", world.studio);
    const links = sidebar(page).locator("a[data-view]");
    await expect(links).toHaveCount(VIEWS.length);
    expect(
      await links.evaluateAll((items) =>
        items.map((item) => item.querySelector("span")?.textContent ?? ""),
      ),
    ).toEqual(VIEWS);
    const backlog = sidebar(page).locator('a[data-view="backlog"]');
    await expect(backlog).toHaveAttribute("aria-label", "Backlog, no tasks");
    await expect(backlog).toHaveAttribute("data-empty", "true");
    await expect(backlog).toHaveText("Backlog");
    // An empty view opens on its empty line, with no heading.
    await backlog.click();
    await expect(page.locator("main")).toContainText("Backlog is empty.", { timeout: SLOW_MS });
    await noViewHeading(page, "Backlog");

    // Waiting: grouped by the person, who names the group; the row repeats no chip.
    await open(page, world, "waiting");
    const tom = page.getByRole("group", { name: person, exact: true });
    await expect(tom.locator(`li[data-task="${photos}"]`)).toBeVisible({ timeout: SLOW_MS });
    await expect(tom.locator(`li[data-task="${invoice}"]`)).toBeVisible();
    await expect(tom.locator(`li[data-task="${other}"]`)).toHaveCount(0);
    await expect(
      page
        .getByRole("group", { name: `Ana Reyes (${tag})`, exact: true })
        .locator(`li[data-task="${other}"]`),
    ).toBeVisible();
    await noViewHeading(page, "Waiting");

    // The counts add up: each view lists exactly its sidebar count, each task in one view.
    const seen = new Map<string, string>();
    for (const [view, name] of [
      ["inbox", "Inbox"],
      ["open", "Open"],
      ["waiting", "Waiting"],
      ["review", "Review"],
      ["backlog", "Backlog"],
    ] as const) {
      await sidebar(page).locator(`a[data-view="${view}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/${view}$`));
      const link = sidebar(page).locator(`a[data-view="${view}"]`);
      const label = (await link.getAttribute("aria-label")) ?? "";
      const count = /, no tasks$/.test(label) ? 0 : Number(/, (\d+) tasks?$/.exec(label)?.[1]);
      const keys = page.locator("main li[data-key]");
      await expect(keys).toHaveCount(count, { timeout: SLOW_MS });
      for (const key of await keys.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-key") ?? ""),
      )) {
        expect(seen.get(key), `${key} in ${view}`).toBeUndefined();
        seen.set(key, view);
      }
      await noViewHeading(page, name);
    }

    // Inbox: "Move to Open" on the row moves the task out, with an undo toast; the row stays
    // under focus until focus leaves it.
    await sidebar(page).locator('a[data-view="inbox"]').click();
    const captured = row(page, capture);
    await captured.locator('[data-part="move"]').click();
    await expect(page.getByRole("status").filter({ hasText: "Moved to Open" })).toBeVisible({
      timeout: SLOW_MS,
    });
    await expect(captured.locator('[data-part="title"]')).toBeFocused();
    await expect(captured.locator('[data-part="move"]')).toHaveCount(0, { timeout: SLOW_MS });
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await expect(captured).toHaveCount(0, { timeout: SLOW_MS });
    // Review: "Back to open".
    await sidebar(page).locator('a[data-view="review"]').click();
    await row(page, docs).locator('[data-part="move"]').click();
    await expect(page.getByRole("status").filter({ hasText: "Moved to Open" })).toBeVisible({
      timeout: SLOW_MS,
    });
    await sidebar(page).locator('a[data-view="open"]').click();
    await expect(row(page, capture)).toBeVisible({ timeout: SLOW_MS });
    await expect(row(page, docs)).toBeVisible();

    // The area view: by project under project labels, no heading that names the area.
    await sidebar(page).getByRole("link", { name: "Lumen", exact: true }).click();
    await expect(
      page
        .getByRole("group", { name: "Lumen portal", exact: true })
        .locator(`li[data-task="${docs}"]`),
    ).toBeVisible({ timeout: SLOW_MS });
    await noViewHeading(page, "Lumen");

    // Completed: a task completed while the view is open appears in "Checked off".
    await sidebar(page).locator('a[data-view="completed"]').click();
    await expect(page).toHaveURL(/\/completed$/);
    await noViewHeading(page, "Completed");
    await expect(row(page, lease)).toHaveCount(0);
    await world.op(world.mira.id, "task.finish", { task: lease, base: await asOf(world, lease) });
    const checked = page.getByRole("group", { name: "Checked off", exact: true });
    await expect(checked.locator(`li[data-task="${lease}"]`)).toBeVisible({ timeout: SLOW_MS });
    // Its row: checked, the completion day in the due column.
    await expect(row(page, lease).locator('[data-part="check"]')).toBeChecked();
    await expect(row(page, lease)).toContainText("Today");
    await page.screenshot({ path: test.info().outputPath("views-flow.png"), fullPage: true });

    // Reopen from the expanded finished task: an undo toast, and the task is open again.
    await row(page, lease).locator('[data-part="title"]').click();
    await page.locator('[data-part="reopen"]').click();
    await expect(page.getByRole("status").filter({ hasText: "Reopened" })).toBeVisible({
      timeout: SLOW_MS,
    });
    await sidebar(page).locator('a[data-view="open"]').click();
    await expect(row(page, lease)).toBeVisible({ timeout: SLOW_MS });
    await expect(row(page, lease).locator('[data-part="check"]')).not.toBeChecked();
    expect(await violations(page)).toEqual([]);
  });
});

/** axe-core's violations on the whole page. */
async function axeOn(page: Page, axe: string): Promise<string[]> {
  await page.evaluate(axe);
  return page.evaluate(async () => {
    const run = (
      window as unknown as {
        axe: {
          run: (
            context: unknown,
            options: unknown,
          ) => Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }>;
        };
      }
    ).axe.run;
    const result = await run({ include: ["body"] }, { resultTypes: ["violations"] });
    return result.violations.map((v) => `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`);
  });
}

test.describe("[A7.3.12.m5-05.e2e.screens] the views in both themes at 1,440 and 390 px", () => {
  test("screenshots of Waiting, Completed, an area view and the sidebar with empty views, axe clean, no horizontal scroll", async ({
    browser,
    world,
  }) => {
    const tag = `${test.info().project.name}-screens`;
    const [waiting, done] = await add(world, [
      {
        title: `New product photos (${tag})`,
        area: "home",
        status: "waiting",
        waiting_on: `Tom Haas (${tag})`,
      },
      { title: `File the VAT return (${tag})`, area: "home", priority: 2 },
    ]);
    if (waiting === undefined || done === undefined) throw new Error("the tasks were not added");
    await world.op(world.mira.id, "task.finish", {
      task: done,
      outcome: `Filed on time (${tag}).`,
      base: await asOf(world, done),
    });
    const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    const areaId = world.task.area;
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
        for (const [name, path, ref] of [
          ["waiting", "waiting", waiting],
          ["completed", "completed", done],
          ["area", `area/${areaId}`, undefined],
        ] as const) {
          await page.setViewportSize({ width: 1440, height: 1000 });
          await open(page, world, path);
          if (ref === undefined) {
            await expect(page.locator("main li[data-key]").first()).toBeVisible({
              timeout: SLOW_MS,
            });
          } else {
            await expect(row(page, ref)).toBeVisible({ timeout: SLOW_MS });
          }
          await page.screenshot({
            path: test.info().outputPath(`views-${name}-${theme}-1440.png`),
            fullPage: true,
          });
          expect(await axeOn(page, axe), `axe on ${name} in ${theme}`).toEqual([]);

          await page.setViewportSize({ width: 390, height: 900 });
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
          const scroll = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(scroll, `horizontal scroll on ${name} at 390 px`).toBeLessThanOrEqual(0);
          await page.screenshot({
            path: test.info().outputPath(`views-${name}-${theme}-390.png`),
            fullPage: true,
          });
        }

        // The sidebar of a space whose Open, Waiting, Review and Backlog are empty: every entry in
        // its place, the empty ones quieter; at 390 px the same entries in the drawer.
        await page.setViewportSize({ width: 1440, height: 1000 });
        await open(page, world, "today", world.studio);
        await expect(sidebar(page).locator('a[data-view="open"]')).toHaveAttribute(
          "data-empty",
          "true",
        );
        await page.screenshot({
          path: test.info().outputPath(`views-sidebar-empty-${theme}-1440.png`),
        });
        expect(await axeOn(page, axe), `axe on the empty views in ${theme}`).toEqual([]);
        await page.setViewportSize({ width: 390, height: 900 });
        await page.getByRole("button", { name: "Menu" }).click();
        const drawer = page.getByRole("dialog", { name: "Views and areas" });
        const entries = drawer.locator("a[data-view]");
        await expect(entries).toHaveCount(VIEWS.length);
        expect(
          await entries.evaluateAll((items) =>
            items.map((item) => item.querySelector("span")?.textContent ?? ""),
          ),
        ).toEqual(VIEWS);
        await page.screenshot({
          path: test.info().outputPath(`views-sidebar-empty-${theme}-390.png`),
        });
        await page.keyboard.press("Escape");
      } finally {
        await context.close();
      }
    }
  });
});
