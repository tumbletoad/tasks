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

/**
 * Each theme of this browser at both widths, axe clean in the menu, no sideways scroll. `menu`: at
 * 390 px the drawer opens, with Archived opened in it for `shelf`; `page`: the page itself.
 */
async function shots(
  page: Page,
  world: World,
  name: string,
  menu: "drawer" | "shelf" | "page" = "drawer",
): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme, { timeout: SLOW_MS });
    await settled(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await picture(page, `archived-${name}-${theme}-1440.png`);
    const part = menu === "page" ? "main" : "nav";
    if (pictures()) expect(await axeFound(page, [part]), `axe in ${theme}`).toEqual([]);
    await page.setViewportSize({ width: 390, height: 900 });
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(scroll, "sideways scroll at 390 px").toBe(0);
    if (menu === "page") {
      await settled(page);
      await picture(page, `archived-${name}-${theme}-390.png`);
      if (pictures()) expect(await axeFound(page, [part]), `axe in ${theme}`).toEqual([]);
      continue;
    }
    await page.getByRole("button", { name: "Menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Views and areas" });
    // Archived is the page's: opened in the side menu, it is open in the drawer, every time.
    if (menu === "shelf") await expect(shelf(drawer)).toHaveAttribute("aria-expanded", "true");
    await settled(page);
    await picture(page, `archived-${name}-${theme}-390.png`);
    if (pictures())
      expect(await axeFound(page, ['[role="dialog"]']), `axe in ${theme}`).toEqual([]);
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
    await shots(page, world, "shelf", "shelf");

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
    await expect(capture(page).getByRole("listitem")).toHaveText([`${attic} is archived`]);
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
    await shots(page, world, "page", "page");

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

  test("a project without an area is listed, archived and brought back like any other; a project brought back inside an archived area says it stays there and offers the area's Unarchive; at 390 px the drawer keeps Archived open or folded", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const kiln = `Kiln ${tag}`;
    const fire = `Fire the pots (${tag})`;
    await world.op(world.mira.id, "task.add", { tasks: [{ title: fire, project: kiln }] });
    const kilnId = (await listed(world)).projects.find((p) => p.name === kiln)?.id ?? "";
    expect(kilnId).not.toBe("");
    const loft = `Loft ${tag}`;
    const trays = `Trays ${tag}`;
    await world.op(world.mira.id, "group.manage", { action: "create", path: `${loft}/${trays}` });
    await world.op(world.mira.id, "task.add", {
      tasks: [{ title: `Stack the trays (${tag})`, area: loft, project: trays }],
    });
    await signIn(page, world, `/s/${world.mira.id}/today`);
    await showsSpace(page, world.mira.name);
    const areas = areasList(page);
    await expect(linkTo(areas, kiln)).toBeVisible({ timeout: SLOW_MS });
    await shots(page, world, "loose");

    // Archived, it leaves the areas for Archived, and its page and its task's card say so.
    await archive(world, kilnId);
    await expect(linkTo(areas, kiln)).toHaveCount(0);
    await shelf(sidebar(page)).click();
    const archived = sidebar(page).locator(
      `#${(await shelf(sidebar(page)).getAttribute("aria-controls")) ?? ""}`,
    );
    await archived.getByRole("link", { name: `${kiln}, 1 task` }).click();
    const line = page.locator('[data-part="archived-line"]');
    await expect(line).toContainText("Archived. Its open tasks stay in your views.");
    const row = page.locator("main li[data-task]").filter({ hasText: fire });
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="area"]')).toHaveAccessibleName(`Area, ${kiln}, archived`);
    await line.getByRole("button", { name: "Unarchive" }).click();
    await expect(toast(page)).toHaveText(`${kiln} is back in the sidebar`);
    await expect(linkTo(areas, kiln)).toBeVisible();
    await expect(line).toHaveCount(0);

    // A project brought back while its area stays archived stays under Archived, and says so.
    await archive(world, `${loft}/${trays}`);
    await archive(world, loft);
    await archived.getByRole("link", { name: `${trays}, 1 task` }).click();
    await expect(line).toContainText("Archived. Its open tasks stay in your views.");
    await line.getByRole("button", { name: "Unarchive", exact: true }).click();
    await expect(toast(page)).toHaveText(
      `${trays} is unarchived. It stays under Archived with its area, ${loft}.`,
    );
    await expect(toastAction(page)).toHaveText("Undo");
    await expect(line).toContainText(`Archived with its area, ${loft}.`);
    await expect(linkTo(areas, trays)).toHaveCount(0);
    await shots(page, world, "in-area", "page");
    await line.getByRole("button", { name: `Unarchive ${loft}` }).click();
    await expect(toast(page)).toHaveText(`${loft} is back in the sidebar`);
    await expect(linkTo(areas, trays)).toBeVisible();
    await expect(line).toHaveCount(0);

    // At 390 px, Archived open or folded is the page's: closing the drawer keeps it.
    await archive(world, kilnId);
    await page.setViewportSize({ width: 390, height: 900 });
    const menu = page.getByRole("button", { name: "Menu" });
    const drawer = page.getByRole("dialog", { name: "Views and areas" });
    for (const open of ["false", "true"]) {
      await menu.click();
      await shelf(drawer).click();
      await expect(shelf(drawer)).toHaveAttribute("aria-expanded", open);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await menu.click();
      await expect(shelf(drawer)).toHaveAttribute("aria-expanded", open);
      await page.keyboard.press("Escape");
    }
  });
});

test.describe("[A5.archived.e2e.new-work] new work never lands in an archived group unless the screen says so", () => {
  test("New project sends the area it shows, also after that area is archived meanwhile; a new area's name that an archived area has offers its Unarchive and adds nothing before; a submitted #name of an archived area files to the Inbox, not to a live project of that name", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const loft = `Loft room ${tag}`;
    await world.op(world.mira.id, "group.manage", { action: "create", path: loft });
    await world.op(world.mira.id, "group.manage", { action: "create", path: `Workshop ${tag}` });
    const loftId = await areaIdOf(world, loft);
    await signIn(page, world, `/s/${world.mira.id}/area/${loftId}`);
    await showsSpace(page, world.mira.name);

    // Archived while the dialog is open: the list moves on, and the project goes where it shows.
    const newProject = sidebar(page).getByRole("button", { name: "New project", exact: true });
    await newProject.click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    const areaChoice = dialog.getByLabel("Area", { exact: true });
    await expect(areaChoice).toHaveValue(loftId, { timeout: SLOW_MS });
    await archive(world, loft);
    await expect(areaChoice).not.toHaveValue(loftId);
    const shown = (await areaChoice.locator("option:checked").textContent()) ?? "";
    const racks = `Racks ${tag}`;
    await dialog.getByLabel("Name", { exact: true }).fill(racks);
    await dialog.getByRole("button", { name: "Without a folder" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await areaOfProject(world, racks)).toBe(shown);

    // A new area named as the archived one: the dialog says so and adds nothing until it is back.
    await newProject.click();
    await areaChoice.selectOption({ label: "New area" });
    await dialog.getByLabel("New area's name").fill(loft.toUpperCase());
    const note = dialog.locator('[data-part="area-archived"]');
    await expect(note).toContainText(`An archived area is named ${loft}.`);
    await expect(dialog.getByRole("button", { name: "Without a folder" })).toBeDisabled();
    await shots(page, world, "new-area", "page");
    const crates = `Crates ${tag}`;
    await dialog.getByLabel("Name", { exact: true }).fill(crates);
    await note.getByRole("button", { name: `Unarchive ${loft}` }).click();
    await expect(areaChoice).toHaveValue(loftId);
    await expect(note).toHaveCount(0);
    await expect(linkTo(areasList(page), loft)).toBeVisible();
    await dialog.getByRole("button", { name: "Without a folder" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await areaOfProject(world, crates)).toBe(loft);
    expect((await listed(world)).areas.filter((a) => a.name === loft)).toHaveLength(1);

    // An archived area's name in the top field files nothing there, nor in a live project of the
    // same name: the field says why, and Enter adds to the Inbox with the words in the title.
    const garden = `Garden ${tag}`;
    await world.op(world.mira.id, "group.manage", { action: "create", path: garden });
    await world.op(world.mira.id, "group.manage", {
      action: "create",
      path: `House ${tag}/${garden}`,
    });
    await archive(world, garden);
    await sidebar(page)
      .getByRole("link", { name: /^Today/ })
      .click();
    const title = `Weed the beds #garden-${tag}`;
    await adding(page).fill(title);
    await expect(capture(page).getByRole("listitem")).toHaveText([`${garden} is archived`]);
    await shots(page, world, "capture", "page");
    await adding(page).press("Enter");
    await expect(toast(page)).toHaveText("Added to Inbox");
    const found = (await world.op(world.mira.id, "task.search", { q: "Weed", scope: "all" })) as {
      rows: { ref: string; title: string }[];
    };
    const ref = found.rows.find((r) => r.title === title)?.ref ?? "";
    const { task } = (await world.op(world.mira.id, "task.get", { task: ref })) as {
      task: { inbox: boolean; area?: string; project?: string };
    };
    expect(task).toMatchObject({ inbox: true });
    expect(task.area).toBeUndefined();
    expect(task.project).toBeUndefined();
  });
});

interface Listed {
  areas: { id: string; name: string; projects: { id: string; name: string }[] }[];
  /** The projects without an area. */
  projects: { id: string; name: string }[];
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

/** The name of the area that holds the project named `name`. */
async function areaOfProject(world: World, name: string): Promise<string | undefined> {
  return (await listed(world)).areas.find((a) => a.projects.some((p) => p.name === name))?.name;
}

async function projectIdOf(world: World, area: string, name: string): Promise<string> {
  const found = (await listed(world)).areas
    .find((a) => a.name === area)
    ?.projects.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no project ${name}`);
  return found.id;
}
