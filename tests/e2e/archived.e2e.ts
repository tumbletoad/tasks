// An archived area or project on the page, in Chromium and Firefox against the real service: it
// leaves the sidebar's areas for Archived the moment it is archived and after a reload, keeps its
// open tasks in sight, takes no new work, says so on its own page, and Unarchive there brings it
// back with an Undo. Pictures of the sidebar before and after, and of Archived open, at 1,440 and
// 390 px in both themes. The worker's other tests share Mira, so the groups here are this test's.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { axeFound, picture, pictures, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Views and areas" });
const areasList = (page: Page) => sidebar(page).locator('[data-group="areas"]');
const shelf = (scope: Page | Locator) => scope.getByRole("button", { name: "Archived" });
const linkTo = (scope: Locator, name: string) =>
  scope.getByRole("link", { name: new RegExp(`^${name}, `) });
const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');
const adding = (page: Page) => page.getByRole("textbox", { name: "New task" });
const capture = (page: Page) => page.locator("#top-capture");

/** Colours and the drawer move in transitions: a picture and axe take them once they are there. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );

/** Each theme of this browser at both widths, the drawer open at 390 px; axe clean in the menu. */
async function shots(page: Page, world: World, name: string, openShelf = false): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme, { timeout: SLOW_MS });
    await settled(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await picture(page, `archived-${name}-${theme}-1440.png`);
    if (pictures()) expect(await axeFound(page, ["nav"]), `axe in ${theme}`).toEqual([]);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole("button", { name: "Menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Views and areas" });
    if (openShelf) {
      await shelf(drawer).click();
      await expect(shelf(drawer)).toHaveAttribute("aria-expanded", "true");
    }
    await settled(page);
    await picture(page, `archived-${name}-${theme}-390.png`);
    if (pictures())
      expect(await axeFound(page, ['[role="dialog"]']), `axe in ${theme}`).toEqual([]);
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(scroll, "sideways scroll at 390 px").toBe(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  }
  await world.machine("ui.theme", null);
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function archive(world: World, path: string): Promise<void> {
  const { as_of: base } = (await world.op(world.mira.id, "group.manage", { action: "list" })) as {
    as_of: string;
  };
  await world.op(world.mira.id, "group.manage", { action: "archive", path, base });
}

test.describe("[A5.archived.e2e.sidebar] an archived area or project is out of the way on the page, findable, and comes back", () => {
  test("archived while the page is open and after a reload: Archived holds it with its count, its page says so and takes no new work, Unarchive brings it back and Undo puts it away again", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const attic = `Attic ${tag}`;
    const garage = `Garage ${tag}`;
    await world.op(world.mira.id, "group.manage", { action: "create", path: `${attic}/Boxes` });
    await world.op(world.mira.id, "group.manage", { action: "create", path: `${garage}/Bikes` });
    const sort = `Sort the boxes (${tag})`;
    await world.op(world.mira.id, "task.add", {
      tasks: [
        { title: sort, area: attic },
        { title: `Label the boxes (${tag})`, area: attic, project: "Boxes" },
        { title: `Oil the chain (${tag})`, area: garage, project: "Bikes" },
      ],
    });
    await signIn(page, world, `/s/${world.mira.id}/today`);
    await showsSpace(page, world.mira.name);
    const areas = areasList(page);
    await expect(linkTo(areas, attic)).toBeVisible({ timeout: SLOW_MS });
    await expect(linkTo(areas, "Bikes")).toBeVisible();
    await shots(page, world, "before");

    // Archived while the page is open: both leave the areas at once, a live area stays.
    await archive(world, attic);
    await archive(world, `${garage}/Bikes`);
    await expect(linkTo(areas, attic)).toHaveCount(0);
    await expect(linkTo(areas, "Bikes")).toHaveCount(0);
    await expect(
      sidebar(page).getByRole("button", { name: `New project in ${attic}` }),
    ).toHaveCount(0);
    await expect(linkTo(areas, garage)).toBeVisible();
    await expect(shelf(sidebar(page))).toHaveAttribute("aria-expanded", "false");
    await shots(page, world, "after");

    // After a reload too, and Archived opens on them with their open tasks counted.
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(linkTo(areas, garage)).toBeVisible({ timeout: SLOW_MS });
    await expect(linkTo(areas, attic)).toHaveCount(0);
    await shelf(sidebar(page)).click();
    await expect(shelf(sidebar(page))).toHaveAttribute("aria-expanded", "true");
    const archived = sidebar(page).locator(
      `#${(await shelf(sidebar(page)).getAttribute("aria-controls")) ?? ""}`,
    );
    await expect(archived.getByRole("link", { name: `${attic}, 2 tasks` })).toBeVisible();
    await expect(archived.getByRole("link", { name: "Boxes, 1 task" })).toBeVisible();
    await expect(archived.getByRole("link", { name: `${garage} › Bikes, 1 task` })).toBeVisible();
    await shots(page, world, "shelf", true);

    // Its open tasks are still in Open.
    await sidebar(page)
      .getByRole("link", { name: /^Open, / })
      .click();
    await expect(page.locator("main").getByText(sort)).toBeVisible();

    // Its page says so and takes no new work: the top field adds to no area there, and New project
    // does not offer it.
    await archived.getByRole("link", { name: `${attic}, 2 tasks` }).click();
    const line = page.locator('[data-part="archived-line"]');
    await expect(line).toContainText("Archived. Its open tasks stay in your views.");
    await adding(page).fill(`Fold the blankets #garage-${tag}`);
    await expect(capture(page).getByRole("listitem")).toHaveText([garage]);
    await adding(page).fill(`Fold the blankets #attic-${tag}`);
    await expect(capture(page).getByRole("listitem")).toHaveCount(0);
    await adding(page).fill("");
    await sidebar(page).getByRole("button", { name: "New project", exact: true }).click();
    const areaChoice = page.getByRole("dialog").getByLabel("Area", { exact: true });
    expect(await areaChoice.inputValue()).not.toBe(await areaIdOf(world, attic));
    expect(await areaChoice.locator("option").allTextContents()).not.toContain(attic);
    await page.keyboard.press("Escape");

    // The task's card says its area is archived.
    const row = page.locator("main li[data-task]").filter({ hasText: sort });
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="area"]')).toHaveAccessibleName(
      `Area, ${attic}, archived`,
    );

    // Unarchive brings it back into the areas, in its place; Undo puts it away again.
    await line.getByRole("button", { name: "Unarchive" }).click();
    await expect(toast(page)).toHaveText(`${attic} is back in the sidebar`);
    await expect(linkTo(areas, attic)).toBeVisible();
    await expect(line).toHaveCount(0);
    await toastAction(page).click();
    await expect(linkTo(areas, attic)).toHaveCount(0);
    await expect(line).toBeVisible();

    // An old link to the archived project's page shows it, archived, and Archived folded shows the
    // way to it.
    const bikes = `${await areaIdOf(world, garage)}/project/${await projectIdOf(world, garage, "Bikes")}`;
    await signIn(page, world, `/s/${world.mira.id}/area/${bikes}`);
    await showsSpace(page, world.mira.name);
    await expect(line).toContainText("Archived.");
    await expect(shelf(sidebar(page))).toHaveAttribute("data-within", "true");
  });
});

interface Listed {
  areas: { id: string; name: string; projects: { id: string; name: string }[] }[];
}

async function listed(world: World): Promise<Listed> {
  return (await world.op(world.mira.id, "group.manage", {
    action: "list",
    archived: true,
  })) as Listed;
}

async function areaIdOf(world: World, name: string): Promise<string> {
  const area = (await listed(world)).areas.find((a) => a.name === name);
  if (area === undefined) throw new Error(`no area ${name}`);
  return area.id;
}

async function projectIdOf(world: World, area: string, name: string): Promise<string> {
  const found = (await listed(world)).areas
    .find((a) => a.name === area)
    ?.projects.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no project ${name}`);
  return found.id;
}
