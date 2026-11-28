// A project's screen end to end, in Chromium and Firefox against the real service process, which
// holds two levels today: one address for a project at the top and one under it, its breadcrumbs,
// its status line, its Tasks and Library tabs, a crumb to the project above, and a project below
// as a headed group that folds; at 1,440 and 390 px in both themes, with nothing sideways. Fixture
// text only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { axeFound, picture, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Groups {
  readonly areas: readonly {
    readonly id: string;
    readonly name: string;
    readonly projects: readonly { readonly id: string; readonly name: string }[];
  }[];
}

/** The fixture's Lumen and its portal project. */
async function lumen(world: World) {
  const { areas } = (await world.op(world.mira.id, "group.manage", { action: "list" })) as Groups;
  const area = areas.find((a) => a.name === "Lumen");
  const project = area?.projects.find((p) => p.name === "Lumen portal");
  if (area === undefined || project === undefined) throw new Error("the fixture has no portal");
  return { area, project };
}

const crumbs = (page: Page) => page.locator('[data-part="crumbs"]');
const status = (page: Page) => page.locator('[data-part="project-status"]');
const tab = (page: Page, name: string) =>
  page.locator('[data-part="node-tabs"]').getByRole("link", { name: new RegExp(`^${name}`) });
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("[S2.nav.e2e] a project's one screen at any depth", () => {
  test("a project's address, its crumbs, status line and tabs; a crumb opens the project above; a project below folds", async ({
    page,
    world,
  }) => {
    const { area, project } = await lumen(world);
    const at = (id: string, rest = "") => `/s/${world.mira.id}/project/${id}${rest}`;
    await signIn(page, world, at(project.id));
    await showsSpace(page, world.mira.name);

    await expect(crumbs(page).getByRole("listitem")).toHaveText([area.name, project.name], {
      timeout: SLOW_MS,
    });
    await expect(status(page)).toContainText(/\d+ open/);
    await expect(tab(page, "Tasks")).toHaveAttribute("aria-current", "page");

    // The Library is a tab of the same screen, at the project's address.
    await tab(page, "Library").click();
    await expect(page).toHaveURL((url) => url.pathname === at(project.id, "/library"));
    await expect(page.locator('[data-part="library"]')).toBeVisible();
    await expect(crumbs(page).getByRole("listitem")).toHaveText([area.name, project.name]);

    // A crumb opens the project above, on the same tab.
    await crumbs(page).getByRole("link", { name: area.name }).click();
    await expect(page).toHaveURL((url) => url.pathname === at(area.id, "/library"));
    await tab(page, "Tasks").click();
    await expect(page).toHaveURL((url) => url.pathname === at(area.id));

    // The project below is a group with its own line; folded, its tasks step aside.
    const group = page.getByRole("main").getByRole("group", { name: project.name, exact: true });
    await expect(group.locator('[data-part="group-status"]')).toContainText(/\d+ open/, {
      timeout: SLOW_MS,
    });
    await expect(group.locator("li[data-task]").first()).toBeVisible();
    await group.getByRole("button", { name: `Fold ${project.name}` }).click();
    await expect(group.locator("li[data-task]")).toHaveCount(0);
    await group.getByRole("button", { name: `Unfold ${project.name}` }).click();
    await expect(group.locator("li[data-task]").first()).toBeVisible();

    // Its heading opens it.
    await group.getByRole("link", { name: project.name }).click();
    await expect(page).toHaveURL((url) => url.pathname === at(project.id));
  });

  test("the side menu and a project's screen at 1,440 and 390 px in both themes: no violation, nothing sideways", async ({
    browser,
    world,
  }) => {
    test.setTimeout(300_000);
    const { area, project } = await lumen(world);
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
          await signIn(page, world, `/s/${world.mira.id}/project/${project.id}`);
          await expect(crumbs(page)).toContainText(project.name, { timeout: SLOW_MS });
          await expect(status(page)).toBeVisible();
          await picture(page, `project-${theme}-${String(width)}.png`, { fullPage: true });
          expect(await sideways(page)).toBe(0);
          expect(await axeFound(page, ["main"])).toEqual([]);
          // The project above: its own line, and the projects below it as groups.
          await crumbs(page).getByRole("link", { name: area.name }).click();
          await expect(page.locator('[data-part="group-status"]').first()).toBeVisible();
          await picture(page, `above-${theme}-${String(width)}.png`, { fullPage: true });
          expect(await sideways(page)).toBe(0);
          expect(await axeFound(page, ["main"])).toEqual([]);
          if (width === 1440) {
            await showsSpace(page, world.mira.name);
            await picture(
              page.getByRole("navigation", { name: "Views and projects" }),
              `menu-${theme}-1440.png`,
            );
          } else {
            await page.getByRole("button", { name: "Menu" }).click();
            const drawer = page.getByRole("dialog", { name: "Views and projects" });
            await expect(
              drawer.getByRole("link", { name: new RegExp(`^${area.name}, `) }),
            ).toBeVisible();
            await picture(page, `menu-${theme}-390.png`);
          }
        } finally {
          await context.close();
        }
      }
    }
    await world.machine("ui.theme", null);
  });
});
