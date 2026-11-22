// The side menu's areas end to end, in Chromium and Firefox against the real service process: an
// area folds and unfolds by a click and by the keyboard, stays folded after a reload, counts what
// its view lists as tasks come and go, and nothing but the person's own fold moves an entry. The
// world's other tests add tasks of their own, so the counts are read before and after.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { showsSpace, signIn, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Views and areas" });

async function open(page: Page, world: World, path: string): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}/${path}`);
  await showsSpace(page, world.mira.name);
}

/** The count in a link's name ("Lumen, 4 tasks"), 0 for "no tasks". */
async function countOf(page: Page, name: string): Promise<number> {
  const link = sidebar(page).getByRole("link", { name: new RegExp(`^${name}, `) });
  const label = (await link.getAttribute("aria-label")) ?? "";
  return /, no tasks$/.test(label) ? 0 : Number(/, (\d+) tasks?$/.exec(label)?.[1]);
}

/** Where each entry of the sidebar is, by its label. */
async function places(page: Page): Promise<Record<string, number>> {
  return sidebar(page)
    .locator("a")
    .evaluateAll((links) =>
      Object.fromEntries(
        links.map((link) => [
          link.querySelector("[data-label]")?.textContent ??
            link.querySelector("span:not([aria-hidden])")?.textContent ??
            link.textContent,
          Math.round(link.getBoundingClientRect().top),
        ]),
      ),
    );
}

test.describe("[A5.3.3.e2e.sidebar-folds] an area folds in the side menu and counts its tasks", () => {
  test("an area folds by a click and by the keyboard, stays folded after a reload, and keeps its count", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    await open(page, world, "today");
    const portal = sidebar(page).getByRole("link", { name: /^Lumen portal, / });
    await expect(portal).toBeVisible({ timeout: SLOW_MS });
    const fold = sidebar(page).getByRole("button", { name: "Fold Lumen" });
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    const lumen = await countOf(page, "Lumen");
    expect(lumen).toBeGreaterThan(0);

    await fold.click();
    const unfold = sidebar(page).getByRole("button", { name: "Unfold Lumen" });
    await expect(unfold).toHaveAttribute("aria-expanded", "false");
    await expect(portal).toHaveCount(0);
    // Folded, the area still says how many tasks it holds.
    expect(await countOf(page, "Lumen")).toBe(lumen);
    await page.screenshot({ path: test.info().outputPath("sidebar-folded.png") });

    // This browser remembers it.
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(unfold).toBeVisible({ timeout: SLOW_MS });
    await expect(portal).toHaveCount(0);

    // The keyboard: Enter unfolds, Space folds, focus stays on the button.
    await unfold.focus();
    await page.keyboard.press("Enter");
    await expect(portal).toBeVisible();
    await expect(fold).toBeFocused();
    await page.keyboard.press(" ");
    await expect(portal).toHaveCount(0);
    await expect(unfold).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(portal).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test("the counts follow a task that is added and one that is finished; opening a view or a project moves no entry", async ({
    page,
    world,
  }) => {
    await open(page, world, "today");
    await expect(sidebar(page).getByRole("link", { name: /^Lumen portal, / })).toBeVisible({
      timeout: SLOW_MS,
    });
    const area = await countOf(page, "Lumen");
    const project = await countOf(page, "Lumen portal");
    const before = await places(page);

    const added = (await world.op(world.mira.id, "task.add", {
      tasks: [
        {
          title: `Count me in the portal (${test.info().project.name})`,
          area: "lumen",
          project: "lumen-portal",
        },
      ],
    })) as { tasks: { ref: string }[] };
    const ref = added.tasks[0]?.ref ?? "";
    const named = (name: string, n: number) =>
      sidebar(page).getByRole("link", {
        name: `${name}, ${String(n)} ${n === 1 ? "task" : "tasks"}`,
        exact: true,
      });
    await expect(named("Lumen", area + 1)).toBeVisible({ timeout: SLOW_MS });
    await expect(named("Lumen portal", project + 1)).toBeVisible();
    expect(await places(page)).toEqual(before);

    const base = ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string })
      .as_of;
    await world.op(world.mira.id, "task.finish", { task: ref, base });
    await expect(named("Lumen", area)).toBeVisible({ timeout: SLOW_MS });
    await expect(named("Lumen portal", project)).toBeVisible();

    // Opening an area, a project and a view moves nothing in the menu.
    await sidebar(page)
      .getByRole("link", { name: /^Home, / })
      .click();
    await expect(page).toHaveURL(/\/area\//);
    expect(await places(page)).toEqual(before);
    await sidebar(page)
      .getByRole("link", { name: /^Lumen portal, / })
      .click();
    await expect(page).toHaveURL(/\/project\//);
    expect(await places(page)).toEqual(before);
    await sidebar(page).locator('a[data-view="backlog"]').click();
    await expect(page).toHaveURL(/\/backlog$/);
    expect(await places(page)).toEqual(before);
  });

  test("an area's count is never under its New project button, with a mouse or on a touch screen", async ({
    browser,
    browserName,
    page,
    world,
  }) => {
    /** The area's count and its New project button, where they are and whether the count shows. */
    const line = async (menu: Locator) => {
      const area = menu.locator('li[data-area] > div:has(a[aria-label^="Lumen, "])');
      const count = area.locator('a span[aria-hidden="true"]').last();
      const add = area.getByRole("button", { name: "New project in Lumen" });
      return {
        area,
        count: await count.boundingBox(),
        countShown: await count.evaluate((el) => getComputedStyle(el).visibility === "visible"),
        add: await add.boundingBox(),
      };
    };
    const overlap = (
      a: { x: number; width: number } | null,
      b: { x: number; width: number } | null,
    ) => a !== null && b !== null && a.x < b.x + b.width && b.x < a.x + a.width;

    // A mouse: the button shows while the line has the pointer, and the count steps aside.
    await open(page, world, "today");
    await expect(sidebar(page).getByRole("link", { name: /^Lumen, \d/ })).toBeVisible({
      timeout: SLOW_MS,
    });
    const rest = await line(sidebar(page));
    expect(rest.countShown).toBe(true);
    await rest.area.hover();
    const hovered = await line(sidebar(page));
    expect(hovered.countShown && overlap(hovered.count, hovered.add)).toBe(false);

    // A touch screen has no hover: both always show, side by side.
    // Only Chromium emulates a touch screen's media.
    if (browserName !== "chromium") return;
    const touch = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const phone = await touch.newPage();
      await signIn(phone, world, `/s/${world.mira.id}/today`);
      await phone.getByRole("button", { name: "Menu" }).click();
      const drawer = phone.getByRole("dialog", { name: "Views and areas" });
      await expect(drawer.getByRole("link", { name: /^Lumen, \d/ })).toBeVisible({
        timeout: SLOW_MS,
      });
      const shown = await line(drawer);
      expect(shown.countShown).toBe(true);
      expect(overlap(shown.count, shown.add)).toBe(false);
      await phone.screenshot({ path: test.info().outputPath("sidebar-touch-390.png") });
    } finally {
      await touch.close();
    }
  });

  test("a folded area that holds the project on screen shows the way to it; a cut name shows whole in a tip", async ({
    page,
    world,
  }) => {
    await open(page, world, "today");
    const portal = sidebar(page).getByRole("link", { name: /^Lumen portal, / });
    await portal.click();
    await expect(portal).toHaveAttribute("aria-current", "page");
    await sidebar(page).getByRole("button", { name: "Fold Lumen" }).click();
    await expect(sidebar(page).getByRole("link", { name: /^Lumen, / })).toHaveAttribute(
      "data-within",
      "true",
    );
    await sidebar(page).getByRole("button", { name: "Unfold Lumen" }).click();

    // A long project name is cut in the menu, and its tip shows all of it.
    const long = `A project whose name is far too long for the menu (${test.info().project.name})`;
    const base = (
      (await world.op(world.mira.id, "task.get", { task: world.task.ref })) as { as_of: string }
    ).as_of;
    await world.op(world.mira.id, "group.manage", { action: "create", path: `Home/${long}`, base });
    const item = sidebar(page).getByRole("link", {
      name: new RegExp(`^${long.replace(/[()]/g, "\\$&")}`),
    });
    await expect(item).toBeVisible({ timeout: SLOW_MS });
    await item.hover();
    await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveText(long, {
      timeout: SLOW_MS,
    });
  });
});
