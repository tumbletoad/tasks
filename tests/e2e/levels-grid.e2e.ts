// A space's effort levels changed in Settings, end to end in Chromium and Firefox against the real
// service: at 1,440 px by keyboard and at 390 px by mouse, a person adds a level, renames one that
// tasks hold (the tasks follow), changes a time, moves a level, removes one with a move, and takes
// the removal back from the toast; each holds after a reload. A space whose levels a newer build
// wrote shows them read-only. axe finds nothing and nothing scrolls sideways. Screenshots of each
// state go to the results folder for review. Fixture data only.
import { expect, type Locator, type Page } from "@playwright/test";
import { EFFORT_LEVELS } from "../../packages/contracts/src/preferences.ts";
import type { Scales } from "./bulk.ts";
import { test } from "./fixture.ts";
import { axeFound, picture, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, startWorld, type SpaceInfo, type World } from "./world.ts";

const STATUSES = ["open", "waiting", "review", "backlog"];
const SCALES: readonly Scales[] = [
  { statuses: STATUSES, efforts: EFFORT_LEVELS },
  { statuses: STATUSES, efforts: EFFORT_LEVELS },
  { statuses: STATUSES, efforts: EFFORT_LEVELS, newer: true },
];

const section = (page: Page) =>
  page.locator("section", { has: page.getByRole("heading", { name: "Effort levels" }) });
const names = (page: Page) => section(page).locator('[data-part="level-name"]');
const nameAt = (page: Page, at: number) => names(page).nth(at);
/** The levels' names as the grid shows them, smallest first. */
const values = (page: Page) =>
  names(page).evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
const level = (page: Page, key: string) => section(page).locator(`li[data-level="${key}"]`);
const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');
const count = (page: Page) => section(page).locator('[data-part="level-count"]');

/** How far the page scrolls sideways: none is wanted. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** How many tasks hold each size, as the service counts them in every state. */
async function held(world: World, space: SpaceInfo): Promise<Record<string, number>> {
  const read = (await world.op(space.id, "prefs.manage", {
    action: "get",
    keys: ["tasks.effort_scale"],
  })) as {
    prefs: { held?: { effort: string; active: number; finished: number; trash: number }[] }[];
  };
  return Object.fromEntries(
    (read.prefs[0]?.held ?? []).map((h) => [h.effort, h.active + h.finished + h.trash]),
  );
}

/** The section in each theme this browser takes pictures in, as `name`. */
async function shots(page: Page, world: World, name: string, target?: Locator): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await picture(target ?? section(page), `${name}-${theme}.png`);
  }
  await world.machine("ui.theme", null);
}

/** Settings of `space` at `width`: opened wide, where the page names its space, then narrowed. */
async function opened(page: Page, world: World, space: SpaceInfo, width: number): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${world.origin}/s/${space.id}/settings`);
  await showsSpace(page, space.name);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
}

/** The page is whole at this width: axe finds nothing in it, and nothing scrolls sideways. */
async function whole(page: Page): Promise<void> {
  expect(await axeFound(page, ["main"])).toEqual([]);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
}

const AFTER_UNDO = ["S", "XS", "Medium", "L", "XL", "XXL"];

test.describe("[A5.3.7.e2e.levels-grid] a space's effort levels changed in Settings", () => {
  test("add, rename with tasks, a time, a move and a removal with Undo, by keyboard at 1,440 px and by mouse at 390 px, held after a reload; levels a newer build wrote are read-only", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const ui = process.env["E2E_UI_BUILD"];
    if (ui === undefined) throw new Error("global-setup.ts did not build the page");
    const world = await startWorld(ui, { scales: SCALES });
    try {
      const [keyboard, mouse, newer] = world.scaled;
      if (keyboard === undefined || mouse === undefined || newer === undefined) {
        throw new Error("the world has no spaces for the scales");
      }
      // The sample holds sized tasks of its own: what each size holds is counted, not assumed.
      const before = new Map<string, Record<string, number>>();
      for (const space of [keyboard, mouse]) {
        await world.op(space.id, "task.add", {
          tasks: [
            { title: "Plan the spring fair", effort: "M", inbox: true },
            { title: "Draft the newsletter", effort: "M", inbox: true },
          ],
        });
        before.set(space.id, await held(world, space));
      }
      const onM = (space: SpaceInfo) => String(before.get(space.id)?.["M"] ?? 0);
      /** The sizes after M became `to`, the tasks of a level already called `to` included. */
      const movedTo = (space: SpaceInfo, to: string) => {
        const { M = 0, ...rest } = before.get(space.id) ?? {};
        return { ...rest, [to]: (rest[to] ?? 0) + M };
      };

      await test.step("by keyboard at 1,440 px", async () => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await signIn(page, world, `/s/${keyboard.id}/settings`);
        await showsSpace(page, keyboard.name);
        await expect(names(page)).toHaveCount(5, { timeout: SLOW_MS });
        await expect(section(page)).toContainText(
          `They belong to the space ${keyboard.name} and travel with its backups.`,
        );
        await whole(page);
        await shots(page, world, "levels-1440");

        // Add: the new level's name has the focus; Enter saves it.
        await section(page).locator('[data-part="level-add"]').focus();
        await page.keyboard.press("Enter");
        await expect(nameAt(page, 5)).toBeFocused();
        await page.keyboard.type("XXL");
        await page.keyboard.press("Enter");
        await expect(toast(page)).toHaveText("XXL added");
        await expect(count(page)).toHaveText("6 of 10");

        // Rename a level tasks hold: the line says they move with it, and they do.
        await nameAt(page, 2).focus();
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type("Medium");
        await expect(level(page, "M")).toContainText(`${onM(keyboard)} tasks move with it`);
        await page.keyboard.press("Enter");
        await expect(toast(page)).toHaveText(
          `M renamed to Medium. ${onM(keyboard)} tasks moved with it`,
        );
        expect(await held(world, keyboard)).toEqual(movedTo(keyboard, "Medium"));

        // A time, saved by leaving the field.
        await level(page, "L").locator('[data-part="level-amount"]').focus();
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type("3");
        await page.keyboard.press("Tab");
        await expect(toast(page)).toHaveText("Typical time of L changed");

        // A move: Alt+Down on its name, and the focus stays on it.
        await nameAt(page, 0).focus();
        await page.keyboard.press("Alt+ArrowDown");
        await expect.poll(() => values(page)).toEqual(["S", "XS", "Medium", "L", "XL", "XXL"]);
        await expect(nameAt(page, 1)).toBeFocused();
        await expect(toast(page)).toHaveText("XS moved down");

        // A name used twice says so under the field and is not saved; Escape takes it back.
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type("s");
        await expect(level(page, "XS")).toContainText("Another level is called s");
        await shots(page, world, "levels-problem-1440");
        await page.keyboard.press("Escape");
        await expect(nameAt(page, 1)).toHaveValue("XS");

        // Remove a level tasks hold: one question, the next bigger level chosen.
        await level(page, "Medium").locator('[data-part="level-remove"]').focus();
        await page.keyboard.press("Enter");
        const to = section(page).locator('[data-part="level-ask-to"]');
        await expect(to).toBeFocused();
        await expect(to).toHaveValue("L");
        await expect(section(page).locator('[data-part="level-ask"]')).toContainText(
          `${onM(keyboard)} tasks are Medium`,
        );
        await whole(page);
        await shots(page, world, "levels-ask-1440");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await expect(toast(page)).toHaveText(`Medium removed. ${onM(keyboard)} tasks moved to L`);
        await expect.poll(() => values(page)).toEqual(["S", "XS", "L", "XL", "XXL"]);
        expect(await held(world, keyboard)).toEqual(movedTo(keyboard, "L"));

        // Undo from the toast puts the level and its tasks back.
        await toastAction(page).focus();
        await page.keyboard.press("Enter");
        await expect(toast(page)).toHaveText("Effort levels put back");
        await expect.poll(() => values(page)).toEqual(AFTER_UNDO);
        expect(await held(world, keyboard)).toEqual(movedTo(keyboard, "Medium"));

        await page.reload();
        await showsSpace(page, keyboard.name);
        await expect.poll(() => values(page), { timeout: SLOW_MS }).toEqual(AFTER_UNDO);
        await expect(level(page, "L").locator('[data-part="level-amount"]')).toHaveValue("3");
        await expect(level(page, "L").locator('[data-part="level-unit"]')).toHaveValue("days");
      });

      await test.step("by mouse at 390 px", async () => {
        await opened(page, world, mouse, 390);
        await expect(names(page)).toHaveCount(5, { timeout: SLOW_MS });
        await whole(page);
        await shots(page, world, "levels-390");
        const heading = section(page).getByRole("heading", { name: "Effort levels" });

        await section(page).locator('[data-part="level-add"]').click();
        await nameAt(page, 5).fill("XXL");
        await heading.click();
        await expect(toast(page)).toHaveText("XXL added");

        await nameAt(page, 2).fill("Medium");
        await heading.click();
        await expect(toast(page)).toHaveText(
          `M renamed to Medium. ${onM(mouse)} tasks moved with it`,
        );
        expect(await held(world, mouse)).toEqual(movedTo(mouse, "Medium"));

        await level(page, "L").locator('[data-part="level-amount"]').fill("3");
        await heading.click();
        await expect(toast(page)).toHaveText("Typical time of L changed");
        await level(page, "L").locator('[data-part="level-unit"]').selectOption("weeks");
        await expect(level(page, "L").locator('[data-part="level-unit"]')).toHaveValue("weeks");

        // Move and Remove are behind More at this width.
        await level(page, "XS").locator('[data-part="level-more"]').click();
        await picture(page, "levels-more-390.png");
        await page.getByRole("menuitem", { name: "Move XS down" }).click();
        await expect.poll(() => values(page)).toEqual(["S", "XS", "Medium", "L", "XL", "XXL"]);

        await level(page, "Medium").locator('[data-part="level-more"]').click();
        await page.getByRole("menuitem", { name: "Remove Medium" }).click();
        await expect(section(page).locator('[data-part="level-ask-to"]')).toHaveValue("L");
        await whole(page);
        await shots(page, world, "levels-ask-390");
        await section(page).locator('[data-part="level-ask-remove"]').click();
        await expect(toast(page)).toHaveText(`Medium removed. ${onM(mouse)} tasks moved to L`);
        expect(await held(world, mouse)).toEqual(movedTo(mouse, "L"));

        await toastAction(page).click();
        await expect(toast(page)).toHaveText("Effort levels put back");
        await expect.poll(() => values(page)).toEqual(AFTER_UNDO);
        expect(await held(world, mouse)).toEqual(movedTo(mouse, "Medium"));

        await page.reload();
        await expect.poll(() => values(page), { timeout: SLOW_MS }).toEqual(AFTER_UNDO);
        await expect(level(page, "L").locator('[data-part="level-unit"]')).toHaveValue("weeks");
        expect(await sideways(page)).toBeLessThanOrEqual(0);
      });

      await test.step("levels a newer build wrote are read-only, at both widths", async () => {
        for (const width of [1440, 390]) {
          await opened(page, world, newer, width);
          await expect(section(page).locator('[data-part="levels-fixed"]')).toHaveText(
            "A newer build of TTasks changed these levels, so this one only shows them. Update TTasks here to change them.",
            { timeout: SLOW_MS },
          );
          await expect(nameAt(page, 0)).not.toBeEditable();
          await expect(section(page).locator('[data-part="level-add"]')).toHaveCount(0);
          await whole(page);
          await shots(page, world, `levels-read-only-${String(width)}`);
        }
      });
    } finally {
      await world.close();
    }
  });
});
