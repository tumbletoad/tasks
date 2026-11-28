// A space on the new storage, one tree four levels of projects deep (tree.ts), walked as a person
// against the real service: the side menu with its folds and counts, a project's screen at each
// depth with its crumbs, brief, status line and groups, Today and the lists, a task's card with its
// notes and Knowledge, a capture on a screen at the first and the third level, a move to the fourth,
// a check-off and its Undo, search, the Library and a page. What the space cannot do yet stays out
// of the way: no Open, Run or Copy, no folder line, and a quiet word on Activity and the Trash.
// Its effort levels are its own to change. Then the screens at 1,440 and 390 px. Made-up text only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { axeFound, picture, signIn, themes } from "./page.ts";
import type { TreeProject, TreeSpace } from "./tree.ts";
import { SLOW_MS, type SpaceInfo, type World } from "./world.ts";

type Tree = TreeSpace & SpaceInfo;

const menu = (page: Page) => page.getByRole("navigation", { name: "Views and projects" });
const entry = (page: Page, name: string) =>
  menu(page).getByRole("link", { name: new RegExp(`^${name}, `) });
const crumbs = (page: Page) => page.locator('[data-part="crumbs"]');
const brief = (page: Page) => page.locator('[data-part="project-brief"]');
const status = (page: Page) => page.locator('[data-part="project-status"]');
const main = (page: Page) => page.getByRole("main");
const row = (page: Page, title: string) =>
  main(page).locator("li[data-task]").filter({ hasText: title });
const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');
const adding = (page: Page) => page.getByRole("textbox", { name: "New task" });
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

function treeOf(world: World): Tree {
  if (world.tree === undefined) throw new Error("the world has no tree space");
  return world.tree;
}

/**
 * The tab shows the tree space, live, with its faces loaded. Its switcher may say its backups need
 * attention: a tree space's daily backup is not made yet.
 */
async function showsTree(page: Page, tree: Tree): Promise<void> {
  await expect(
    menu(page).getByRole("button", { name: new RegExp(`^Space ${tree.name}[.] `) }),
  ).toBeVisible({ timeout: SLOW_MS });
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load()));
  });
}

async function open(page: Page, world: World, path: string): Promise<void> {
  const tree = treeOf(world);
  await signIn(page, world, `/s/${tree.id}${path}`);
  await showsTree(page, tree);
}

const at = (tree: Tree, project: TreeProject) => `/s/${tree.id}/project/${project.id}`;

/** The project's screen, opened from the side menu as a person does. */
async function goTo(page: Page, project: TreeProject): Promise<void> {
  await entry(page, project.title).click();
  await expect(crumbs(page).getByRole("listitem").last()).toHaveText(project.title);
}

test.describe("[S2.tree.e2e] a space on the new storage, four levels deep, as a person uses it", () => {
  test("the side menu, a project's screen at each depth, Today, the lists and a task's card", async ({
    page,
    tree: world,
  }) => {
    const tree = treeOf(world);
    await open(page, world, "/today");

    // The side menu: each project with what it holds open, the third level folded.
    await expect(entry(page, "Home")).toHaveAccessibleName("Home, 5 tasks");
    await expect(entry(page, "Renovation")).toHaveAccessibleName("Renovation, 4 tasks");
    await expect(entry(page, "Kitchen")).toHaveAccessibleName("Kitchen, 3 tasks");
    await expect(entry(page, "Worktop")).toHaveCount(0);
    await menu(page).getByRole("button", { name: "Unfold Kitchen" }).click();
    await expect(entry(page, "Worktop")).toHaveAccessibleName("Worktop, 2 tasks");

    // Today: the focused task, named by its own project at the fourth level.
    await menu(page).getByRole("link", { name: "Today" }).click();
    await expect(row(page, tree.measure.title)).toContainText("Worktop");
    // No Open or Copy tile on a row: the space cannot open tasks yet.
    await expect(main(page).locator('[data-part="tile"]')).toHaveCount(0);

    // A project's screen at each depth: its crumbs, its brief, its status and the groups below.
    await goTo(page, tree.home);
    await expect(brief(page)).toHaveText(tree.home.brief);
    await expect(status(page)).toContainText("5 open");
    await expect(
      main(page).getByRole("group", { name: tree.renovation.title, exact: true }),
    ).toBeVisible();
    await goTo(page, tree.renovation);
    await expect(crumbs(page).getByRole("listitem")).toHaveText(["Home", "Renovation"]);
    await goTo(page, tree.kitchen);
    await expect(crumbs(page).getByRole("listitem")).toHaveText(["Home", "Renovation", "Kitchen"]);
    await expect(brief(page)).toHaveText(tree.kitchen.brief);
    await expect(
      main(page).getByRole("group", { name: tree.worktop.title, exact: true }),
    ).toBeVisible();
    await goTo(page, tree.worktop);
    await expect(crumbs(page).getByRole("listitem")).toHaveText([
      "Home",
      "Renovation",
      "Kitchen",
      "Worktop",
    ]);
    await expect(brief(page)).toHaveText(tree.worktop.brief);
    await expect(status(page)).toContainText("2 open");
    await expect(status(page)).toContainText("1 waiting");
    // A crumb opens the level above.
    await crumbs(page).getByRole("link", { name: "Renovation" }).click();
    await expect(page).toHaveURL((url) => url.pathname === at(tree, tree.renovation));

    // The lists, each with its task.
    for (const [view, title] of [
      ["Open", tree.handles.title],
      ["Waiting", tree.quote.title],
      ["Review", tree.electrician.title],
      ["Backlog", tree.rivers.title],
      ["Completed", tree.tiles.title],
    ] as const) {
      await menu(page)
        .getByRole("link", { name: new RegExp(`^${view}`) })
        .click();
      await expect(row(page, title)).toBeVisible();
    }

    // A task's card at the fourth level: its notes and its Knowledge, its place by its own
    // project; what the space cannot do yet is not offered.
    await page.goto(`${world.origin}/s/${tree.id}/task/${tree.measure.ref}`);
    const card = row(page, tree.measure.title);
    await expect(card.getByText("The corner is not square")).toBeVisible({ timeout: SLOW_MS });
    await expect(card.getByText("Measured twice, both walls.")).toBeVisible();
    await expect(card.getByText("Corner measurements")).toBeVisible();
    await expect(card.getByRole("button", { name: "Area, Home › Worktop" })).toBeVisible();
    await expect(card.locator('[data-part="copy"]')).toHaveCount(0);
    await expect(card.getByRole("button", { name: /^Open in / })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /^Run with / })).toHaveCount(0);
    await expect(card.locator('[data-part="place"]')).toHaveCount(0);
    await expect(main(page).locator('[data-part="project-folder"]')).toHaveCount(0);
    await expect(card).not.toContainText("could not be read");
  });

  test("a capture lands in the screen's own project, at the top and at the third level; a move to the fourth; a check-off and its Undo", async ({
    page,
    tree: world,
  }) => {
    const tree = treeOf(world);
    await open(page, world, at(tree, tree.kitchen).slice(`/s/${tree.id}`.length));
    await menu(page).getByRole("button", { name: "Unfold Kitchen" }).click();

    // At the third level: the task lands in Kitchen itself.
    await adding(page).fill("Order oak samples");
    await adding(page).press("Enter");
    await expect(toast(page)).toHaveText("Added to Home › Kitchen");
    await expect(row(page, "Order oak samples")).toBeVisible();
    await expect(entry(page, "Kitchen")).toHaveAccessibleName("Kitchen, 4 tasks");

    // At the top: the task lands in Home, and no second Home is made.
    await goTo(page, tree.home);
    await adding(page).fill("Check the boiler pressure");
    await adding(page).press("Enter");
    await expect(toast(page)).toHaveText("Added to Home");
    await expect(entry(page, "Home")).toHaveAccessibleName("Home, 7 tasks");
    await expect(menu(page).getByRole("link", { name: /^Home\b/ })).toHaveCount(1);

    // A move to the fourth level, from the card's place.
    await page.goto(`${world.origin}/s/${tree.id}/task/${tree.handles.ref}`);
    const card = row(page, tree.handles.title);
    const pill = card.getByRole("button", { name: "Area, Home › Kitchen" });
    await pill.click();
    await page.keyboard.type("Worktop");
    await expect(page.getByRole("option").first()).toHaveText(
      "Home › Renovation › Kitchen › Worktop",
    );
    await page.keyboard.press("Enter");
    await expect(card.getByRole("button", { name: "Area, Home › Worktop" })).toBeVisible();
    await expect(entry(page, "Worktop")).toHaveAccessibleName("Worktop, 3 tasks", {
      timeout: SLOW_MS,
    });

    // A check-off on the fourth level's screen, and its Undo.
    await goTo(page, tree.worktop);
    const measured = row(page, tree.measure.title);
    await measured.locator('[data-part="check"]').click();
    await expect(toast(page)).toHaveText("Done");
    await expect(measured).toHaveCount(0);
    await expect(entry(page, "Worktop")).toHaveAccessibleName("Worktop, 2 tasks");
    await toastAction(page).click();
    await expect(measured).toBeVisible();
    await expect(entry(page, "Worktop")).toHaveAccessibleName("Worktop, 3 tasks");
  });

  test("search, the Library and a page; a project's brief in its head; what the space cannot do yet is quiet", async ({
    page,
    tree: world,
  }) => {
    const tree = treeOf(world);
    await open(page, world, "/today");

    // Search finds a task at the fourth level.
    await page.goto(`${world.origin}/s/${tree.id}/search?q=${encodeURIComponent("corner")}`);
    await expect(row(page, tree.measure.title)).toBeVisible({ timeout: SLOW_MS });

    // The Library of the third level, and its page.
    await page.goto(`${world.origin}${at(tree, tree.kitchen)}/library`);
    // Its texts are read after its lists are drawn and move them down: a person clicks once the
    // screen has settled.
    await expect(page.locator('[data-part="description"]')).toBeVisible({ timeout: SLOW_MS });
    await page.getByRole("link", { name: new RegExp(tree.page) }).click();
    await expect(page.getByRole("heading", { name: tree.page })).toBeVisible();
    await expect(page.locator('[data-part="page-brief"]')).toContainText(
      "What oak and stone each ask",
    );

    // The brief in the head. The service does not set a project's brief on a tree space yet: the
    // pen says so in plain words once, keeps the words typed, and then steps aside.
    await page.goto(`${world.origin}${at(tree, tree.worktop)}`);
    await expect(brief(page)).toHaveText(tree.worktop.brief, { timeout: SLOW_MS });
    await brief(page).getByRole("button", { name: "Edit the brief" }).click();
    const box = page.getByRole("textbox", { name: "Brief" });
    await box.fill("Oak, oiled, fitted by March");
    await box.press("Enter");
    await expect(toast(page)).toHaveText("This space cannot do this yet.");
    await expect(brief(page).getByRole("button", { name: "Edit the brief" })).toHaveCount(0);
    await expect(brief(page)).toHaveText(tree.worktop.brief);
    // The words typed wait under it, with Copy and Discard, until the person lets them go.
    const kept = page.locator('[data-part="not-saved"]');
    await expect(kept.locator('[data-part="not-saved-value"]')).toHaveText(
      "Oak, oiled, fitted by March",
    );
    await kept.locator('[data-part="discard-not-saved"]').click();
    await expect(kept).toHaveCount(0);

    // What the space cannot do yet: a quiet word, nothing to try again.
    await menu(page).getByRole("link", { name: "Activity" }).click();
    await expect(main(page)).toContainText("This space does not show its activity yet.");
    await expect(main(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
    await menu(page).getByRole("link", { name: "Trash" }).click();
    await expect(main(page)).toContainText("This space does not show its Trash yet.");
    await expect(main(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
    // Its effort levels are its own to change: one more is offered, with how many it has.
    await page.goto(`${world.origin}/s/${tree.id}/settings`);
    await expect(page.locator('[data-part="level-add"]')).toBeEnabled({ timeout: SLOW_MS });
    await expect(page.locator('[data-part="level-count"]')).toContainText("5");
    await expect(page.locator('[data-part="levels-fixed"]')).toHaveCount(0);
  });

  test("the side menu, the fourth level's screen and Today at 1,440 and 390 px: nothing sideways, no violation", async ({
    browser,
    tree: world,
  }) => {
    test.setTimeout(300_000);
    const tree = treeOf(world);
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
          const name = (what: string) => `tree-${what}-${theme}-${String(width)}.png`;
          await signIn(page, world, at(tree, tree.worktop));
          await expect(brief(page)).toBeVisible({ timeout: SLOW_MS });
          await expect(status(page)).toBeVisible();
          await picture(page, name("worktop"), { fullPage: true });
          expect(await sideways(page)).toBe(0);
          expect(await axeFound(page, ["main"])).toEqual([]);
          await page.goto(`${world.origin}${at(tree, tree.home)}`);
          await expect(main(page).locator('[data-part="group-status"]').first()).toBeVisible();
          await picture(page, name("home"), { fullPage: true });
          expect(await sideways(page)).toBe(0);
          await page.goto(`${world.origin}/s/${tree.id}/today`);
          await expect(row(page, tree.measure.title)).toBeVisible();
          await picture(page, name("today"), { fullPage: true });
          expect(await sideways(page)).toBe(0);
          if (width === 1440) {
            await picture(menu(page), name("menu"));
          } else {
            await page.getByRole("button", { name: "Menu" }).click();
            const drawer = page.getByRole("dialog", { name: "Views and projects" });
            await expect(drawer.getByRole("link", { name: /^Home, / })).toBeVisible();
            await picture(page, name("menu"));
          }
        } finally {
          await context.close();
        }
      }
    }
    await world.machine("ui.theme", null);
  });
});
