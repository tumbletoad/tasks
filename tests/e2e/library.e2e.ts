// The library in the page, against the real service: a project's Library and its pages, a page
// read, corrected with the pen, its versions shown and restored, a Restore that meets an agent's
// newer words, a page made from a title alone, the Trash and back, the space's Library with the
// person's text for agents, and the screens at 1,440 and 390 px in both themes. Agents write
// through their own requests outside the page. Fixture text only.
import { expect, type Page } from "@playwright/test";
import { built, test as base } from "./fixture.ts";
import { axeFound, picture, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, startWorld, type World } from "./world.ts";

/** A world of its own: its agents make, change and trash pages no other file may meet. */
const test = base.extend<object, { library: World }>({
  library: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built());
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
});

interface Groups {
  readonly areas: readonly {
    readonly id: string;
    readonly name: string;
    readonly projects: readonly { readonly id: string; readonly name: string }[];
  }[];
}

/** The fixture's first area with a project, and that project. */
async function place(world: World) {
  const { areas } = (await world.op(world.mira.id, "group.manage", { action: "list" })) as Groups;
  const area = areas.find((a) => a.projects.length > 0);
  const project = area?.projects[0];
  if (area === undefined || project === undefined) throw new Error("the fixture has no project");
  return { area, project };
}

let made = 0;

/** A page an agent makes; returns its reference. Each title is the test's own. */
async function makePage(
  world: World,
  on: string,
  title: string,
  body: string,
  as: "agent" | "user" = "agent",
): Promise<string> {
  made += 1;
  const written = (await world.op(
    world.mira.id,
    "page.write",
    {
      action: "create",
      on,
      title: `${title} ${String(made)}`,
      brief: "Fixture brief of a page",
      body,
      why: "fixture page",
    },
    as,
  )) as { target: string };
  return written.target;
}

/** An agent's edit: these old words become those new words. */
async function agentEdit(world: World, ref: string, old: string, words: string): Promise<void> {
  await world.op(
    world.mira.id,
    "page.write",
    { action: "edit", target: ref, old, new: words, why: "fixture edit" },
    "agent",
  );
}

const libraryOf = (world: World, area: string, project: string) =>
  `/s/${world.mira.id}/area/${area}/project/${project}/library`;

async function open(page: Page, world: World, path: string): Promise<void> {
  await signIn(page, world, path);
  if ((page.viewportSize()?.width ?? 1440) >= 1024) await showsSpace(page, world.mira.name);
}

const row = (page: Page, ref: string) =>
  page.locator(`[data-part="page-row"][data-ref="${ref}"]`).first();
const body = (page: Page) => page.locator('[data-part="page-body"]');
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("[A5.pages.e2e.library] the library in the page", () => {
  test("a project's Library lists an agent's page as it comes, opens it, and Back returns focus to its row", async ({
    page,
    library: world,
  }) => {
    const { area, project } = await place(world);
    await open(page, world, libraryOf(world, area.id, project.id));
    await expect(page.locator('[data-part="node-path"]')).toContainText(project.name);
    const ref = await makePage(
      world,
      project.id,
      "Fixture rules",
      "# Rules\n\nFixture first rule.",
    );
    await expect(row(page, ref)).toBeVisible({ timeout: SLOW_MS });
    await row(page, ref).click();
    await expect(body(page)).toContainText("Fixture first rule.");
    await expect(page.locator('[data-part="page-changed"]')).toContainText("fixture page");
    await page.locator('[data-part="page-back"]').click();
    await expect(row(page, ref)).toBeFocused();
  });

  test("the feed never moves the words being read: an agent's edit is offered, and shown on request", async ({
    page,
    library: world,
  }) => {
    const { project } = await place(world);
    const ref = await makePage(world, project.id, "Fixture zones", "Fixture convert once.");
    await open(page, world, `/s/${world.mira.id}/page/${ref}`);
    await expect(body(page)).toContainText("Fixture convert once.");
    await agentEdit(world, ref, "Fixture convert once.", "Fixture convert at noon.");
    await expect(page.locator('[data-part="page-newer"]')).toBeVisible({ timeout: SLOW_MS });
    await expect(body(page)).toContainText("Fixture convert once.");
    await page.locator('[data-part="page-newer"] button').click();
    await expect(body(page)).toContainText("Fixture convert at noon.");
  });

  test("the pen corrects the body, a version is shown and restored with an Undo, and the words keep across a reload", async ({
    page,
    library: world,
  }) => {
    const { project } = await place(world);
    const ref = await makePage(world, project.id, "Fixture export", "Fixture first words.");
    await open(page, world, `/s/${world.mira.id}/page/${ref}`);
    await body(page).locator('[data-part="pen"]').click();
    const box = page.locator('[data-part="text-edit"]');
    await box.fill("Fixture second words.\n\nA second paragraph.");
    await box.press("Control+Enter");
    await expect(body(page)).toContainText("A second paragraph.", { timeout: SLOW_MS });
    await page.reload();
    await expect(body(page)).toContainText("A second paragraph.");

    await page.locator('[data-part="versions-toggle"]').click();
    await expect(page.locator('[data-part="version"]')).toHaveCount(2, { timeout: SLOW_MS });
    await page.locator('[data-part="version-show"]').first().click();
    await expect(page.locator('[data-part="page-version"]')).toContainText("Fixture first words.");
    await page.locator('[data-part="restore-shown"]').click();
    await expect(body(page)).toContainText("Fixture first words.", { timeout: SLOW_MS });
    await expect(page.locator('[data-part="page-words"]')).toBeFocused();
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  });

  test("a Restore that meets an agent's newer words writes nothing and shows those words first", async ({
    page,
    library: world,
  }) => {
    const { project } = await place(world);
    const ref = await makePage(world, project.id, "Fixture steps", "Fixture step one.");
    await agentEdit(world, ref, "Fixture step one.", "Fixture step one, then two.");
    await open(page, world, `/s/${world.mira.id}/page/${ref}`);
    await page.locator('[data-part="versions-toggle"]').click();
    await page.locator('[data-part="version-show"]').first().click();
    await expect(page.locator('[data-part="page-version"]')).toContainText("Fixture step one.");
    await agentEdit(world, ref, "then two.", "then three.");
    await page.locator('[data-part="restore-shown"]').click();
    await expect(page.locator('[data-part="page-version"]')).toHaveCount(0, { timeout: SLOW_MS });
    await expect(body(page)).toContainText("Fixture step one, then three.");
  });

  test("New page asks for a title alone and opens the page with its pen; its row has no brief line", async ({
    page,
    library: world,
  }) => {
    const { area, project } = await place(world);
    await open(page, world, libraryOf(world, area.id, project.id));
    await page.locator('[data-part="own-pages"] [data-part="new-page"]').click();
    await page.locator('[data-part="new-page-title"]').fill("Fixture visit notes");
    await page.locator('[data-part="new-page-title"]').press("Enter");
    const box = page.locator('[data-part="text-edit"]');
    await expect(box).toBeFocused({ timeout: SLOW_MS });
    await box.fill("Fixture notes of the visit.");
    await box.press("Control+Enter");
    await expect(body(page)).toContainText("Fixture notes of the visit.", { timeout: SLOW_MS });
    await expect(page.locator('[data-part="page-brief"]')).toContainText("No brief yet.");
    await page.goBack();
    const fresh = page.locator('[data-part="page-row"]', { hasText: "Fixture visit notes" });
    await expect(fresh).toBeVisible();
    await expect(fresh.locator('[class*="brief"]')).toHaveCount(0);
  });

  test("Move to Trash, the page's address says it is in the Trash with Restore, the Trash lists it with where it was, and Restore brings it back to its Library", async ({
    page,
    library: world,
  }) => {
    const { area, project } = await place(world);
    const ref = await makePage(world, project.id, "Fixture old notes", "Fixture words.");
    await open(page, world, `/s/${world.mira.id}/page/${ref}`);
    await page.locator('[data-part="page-trash"]').click();
    await expect(page.locator('[data-part="page-trashed"]')).toBeVisible({ timeout: SLOW_MS });
    // Its address, opened again, says it is in the Trash and brings it back.
    await page.reload();
    const inTrash = page.locator('[data-part="page-in-trash"]');
    await expect(inTrash).toContainText("is in the Trash", { timeout: SLOW_MS });
    await picture(page, "page-in-trash.png");
    await inTrash.getByRole("button", { name: "Restore" }).click();
    await expect(body(page)).toContainText("Fixture words.", { timeout: SLOW_MS });
    await page.locator('[data-part="page-trash"]').click();
    await expect(page.locator('[data-part="page-trashed"]')).toBeVisible({ timeout: SLOW_MS });
    await page.goto(`${world.origin}/s/${world.mira.id}/trash`);
    const trashed = page.locator('[data-part="trashed-page"]', { hasText: ref });
    await expect(trashed).toContainText(project.name);
    await trashed.locator('[data-part="restore-page"]').click();
    await expect(trashed).toHaveCount(0, { timeout: SLOW_MS });
    await page.goto(`${world.origin}${libraryOf(world, area.id, project.id)}`);
    await expect(row(page, ref)).toBeVisible();
  });

  test("the space's Library: the person's text for agents written with the pen keeps across a reload", async ({
    page,
    library: world,
  }) => {
    await open(page, world, `/s/${world.mira.id}/library`);
    await page.getByRole("button", { name: "Edit the text for agents" }).click();
    const box = page.locator('[data-part="text-edit"]');
    await box.fill("Fixture: cite the task for every fact.");
    await box.press("Enter");
    await expect(page.locator('[data-part="for-agents"]')).toContainText("cite the task", {
      timeout: SLOW_MS,
    });
    await page.reload();
    await expect(page.locator('[data-part="for-agents"]')).toContainText("cite the task");
  });

  test("the Library and a page at 1,440 and 390 px in both themes: no violation, nothing sideways", async ({
    browser,
    library: world,
  }) => {
    test.setTimeout(300_000);
    const { area, project } = await place(world);
    const ref = await makePage(
      world,
      project.id,
      "Fixture zones for pictures",
      "# Zones\n\nStore UTC and the zone. See https://example.org/a/long/address/without/any/space/to/break/it/at/all",
    );
    for (const theme of themes()) {
      await world.machine("ui.theme", theme);
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          bypassCSP: true,
          viewport: { width: 1440, height: 1000 },
          reducedMotion: "reduce",
        });
        try {
          const page = await context.newPage();
          await open(page, world, libraryOf(world, area.id, project.id));
          if (width !== 1440) await page.setViewportSize({ width, height: 844 });
          await expect(row(page, ref)).toBeVisible({ timeout: SLOW_MS });
          await picture(page, `library-${theme}-${String(width)}.png`, { fullPage: true });
          expect(await sideways(page)).toBe(0);
          expect(await axeFound(page, ["main"])).toEqual([]);
          await row(page, ref).click();
          await expect(body(page)).toContainText("Store UTC");
          await picture(page, `page-${theme}-${String(width)}.png`, { fullPage: true });
          expect(await sideways(page)).toBe(0);
          expect(await axeFound(page, ["main"])).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
    await world.machine("ui.theme", null);
  });
});
