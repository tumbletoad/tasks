// The library around a task, against the real service: a task's card shows its own pages, a new
// page on it and what is known above it, and Back from a page returns to the card with the focus
// on its link; Today names the pages agents changed; Activity reads an agent's page edit; and
// Build this project's library adds its task with the person's note for agents. Agents write
// through their own requests outside the page. Fixture text only.
import { expect, type Page } from "@playwright/test";
import { built, test as base } from "./fixture.ts";
import { axeFound, picture, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, startWorld, type World } from "./world.ts";

/** A world of its own: its agents add tasks and make and change pages no other file may meet. */
const test = base.extend<object, { knowledge: World }>({
  knowledge: [
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

/** The fixture's first area with two projects: the first gets pages, the second none. */
async function place(world: World) {
  const { areas } = (await world.op(world.mira.id, "group.manage", { action: "list" })) as Groups;
  const area = areas.find((a) => a.projects.length > 1);
  const [project, bare] = area?.projects ?? [];
  if (area === undefined || project === undefined || bare === undefined) {
    throw new Error("the fixture has no area with two projects");
  }
  return { area, project, bare };
}

let made = 0;

/** A task the person adds in the project; returns its reference. */
async function addTask(world: World, area: string, project: string): Promise<string> {
  made += 1;
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [{ title: `Fixture task ${String(made)}`, area, project }],
  })) as { tasks: { ref: string }[] };
  return added.tasks[0]?.ref ?? "";
}

/** A page an agent makes on `on` (a task's reference or a project's ID); returns its reference. */
async function makePage(world: World, on: string, title: string): Promise<string> {
  made += 1;
  const written = (await world.op(
    world.mira.id,
    "page.write",
    {
      action: "create",
      on,
      title: `${title} ${String(made)}`,
      brief: "Fixture brief of a page",
      body: "Fixture words of a page.",
      why: "fixture page",
    },
    "agent",
  )) as { target: string };
  return written.target;
}

async function agentEdit(world: World, ref: string): Promise<void> {
  await world.op(
    world.mira.id,
    "page.write",
    {
      action: "edit",
      target: ref,
      old: "Fixture words",
      new: "Fixture changed words",
      why: "fixture edit",
    },
    "agent",
  );
}

async function open(page: Page, world: World, path: string): Promise<void> {
  await signIn(page, world, path);
  if ((page.viewportSize()?.width ?? 1440) >= 1024) await showsSpace(page, world.mira.name);
}

const knowledgeOf = (page: Page, task: string) =>
  page.locator(`main li[data-task="${task}"] [data-part="knowledge"]`);
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("[A5.pages.e2e.knowledge] the library around a task", () => {
  test("a card shows its pages and what is known above; Back from a page returns to the card with the focus on its link", async ({
    page,
    knowledge: world,
  }) => {
    const { area, project } = await place(world);
    const task = await addTask(world, area.name, project.name);
    const own = await makePage(world, task, "Fixture measurements");
    const above = await makePage(world, project.id, "Fixture rules");
    await open(page, world, `/s/${world.mira.id}/task/${task}`);
    const knowledge = knowledgeOf(page, task);
    await expect(knowledge.locator(`[data-ref="${own}"]`)).toBeVisible({ timeout: SLOW_MS });
    const fold = knowledge.locator('[data-part="knowledge-above"]');
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await fold.click();
    await expect(knowledge.locator(`[data-ref="${above}"]`)).toBeVisible();

    await knowledge.locator(`[data-ref="${own}"]`).click();
    await expect(page.locator('[data-part="page-body"]')).toContainText("Fixture words of a page.");
    await page.locator('[data-part="page-back"]').click();
    await expect(knowledgeOf(page, task).locator(`[data-ref="${own}"]`)).toBeFocused({
      timeout: SLOW_MS,
    });
  });

  test("+ Page on a card makes a page on the task from a title and opens it with its pen", async ({
    page,
    knowledge: world,
  }) => {
    const { area, project } = await place(world);
    const task = await addTask(world, area.name, project.name);
    await open(page, world, `/s/${world.mira.id}/task/${task}`);
    const knowledge = knowledgeOf(page, task);
    await knowledge.locator('[data-part="new-page"]').click();
    await knowledge.locator('[data-part="new-page-title"]').fill("Fixture offsets");
    await knowledge.locator('[data-part="new-page-title"]').press("Enter");
    await expect(page.locator('[data-part="text-edit"]')).toBeFocused({ timeout: SLOW_MS });
    await page.goBack();
    await expect(knowledgeOf(page, task)).toContainText("Fixture offsets", { timeout: SLOW_MS });
  });

  test("Today names a page an agent changed, and Activity reads the edit with the page as a link", async ({
    page,
    knowledge: world,
  }) => {
    const { project } = await place(world);
    const ref = await makePage(world, project.id, "Fixture export");
    await open(page, world, `/s/${world.mira.id}/today`);
    await agentEdit(world, ref);
    const changes = page.locator('[data-part="page-changes"]');
    await expect(changes.locator(`[data-ref="${ref}"]`)).toBeVisible({ timeout: SLOW_MS });

    await page.goto(`${world.origin}/s/${world.mira.id}/activity`);
    const line = page.locator("main li", { hasText: "text changed" }).first();
    await expect(line).toBeVisible({ timeout: SLOW_MS });
    await line.getByRole("link").first().click();
    await expect(page.locator('[data-part="page-body"]')).toContainText("Fixture changed words");
  });

  test("Build this project's library adds the task with the person's note for agents and opens it in the list", async ({
    page,
    knowledge: world,
  }) => {
    const { area, bare } = await place(world);
    await open(page, world, `/s/${world.mira.id}/project/${bare.id}/library`);
    await page.locator('[data-part="build-library"]').click();
    await expect(page).toHaveURL(/[?&]task=/, { timeout: SLOW_MS });
    const card = page.locator("main li[data-task]", { hasText: "Build this project's library" });
    await expect(card.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
    await expect(card).toContainText("keeping-the-library", { timeout: SLOW_MS });
  });

  test("a card's Knowledge at 1,440 and 390 px in both themes: no violation, nothing sideways", async ({
    browser,
    knowledge: world,
  }) => {
    test.setTimeout(300_000);
    const { area, project } = await place(world);
    const task = await addTask(world, area.name, project.name);
    await makePage(world, task, "Fixture measurements for pictures");
    await makePage(world, project.id, "Fixture rules for pictures");
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
          await open(page, world, `/s/${world.mira.id}/task/${task}`);
          if (width !== 1440) await page.setViewportSize({ width, height: 844 });
          const knowledge = knowledgeOf(page, task);
          await expect(knowledge).toBeVisible({ timeout: SLOW_MS });
          await knowledge.locator('[data-part="knowledge-above"]').click();
          await picture(page, `knowledge-${theme}-${String(width)}.png`, { fullPage: true });
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
