// A row's mark for unsent words, in Chromium and Firefox against the real service process with
// fixture data, at 1,440 and 390 px.
import { expect, type Browser, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

async function addTask(world: World, draft: Record<string, unknown>): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: [draft] })) as Added;
  const ref = added.tasks[0]?.ref;
  if (ref === undefined) throw new Error("the task was not added");
  return ref;
}

/** A page of its own in `theme`, at 1,440 px, signed in on `path` of the fixture space. */
async function themed(
  browser: Browser,
  world: World,
  theme: ReturnType<typeof themes>[number],
  path: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await world.machine("ui.theme", theme);
  await signIn(page, world, `/s/${world.mira.id}${path}`);
  await showsSpace(page, world.mira.name);
  return { page, close: () => context.close() };
}

test.describe("[A5.3.6.e2e.draft-mark] A row says when its composer holds unsent words", () => {
  test("the mark comes with the words and goes once they are sent, and the row's title does not move", async ({
    browser,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Draft the clinic letter (${tag})`, inbox: true });
    for (const theme of themes()) {
      const { page, close } = await themed(browser, world, theme, "/inbox");
      try {
        const row = page.locator(`main li[data-task="${ref}"]`);
        const title = row.locator('[data-part="title"]');
        const mark = row.locator('[data-kind="draft"]');
        await row.scrollIntoViewIfNeeded();
        await expect(mark).toHaveCount(0);
        const before = await title.boundingBox();

        // Words typed and left: collapsed, the row shows its mark where nothing else moves.
        await title.click();
        const composer = row.locator('[data-part="composer"]');
        await composer.fill("Ask about the new opening hours");
        await title.click();
        await expect(title).toHaveAttribute("aria-expanded", "false");
        await expect(mark).toBeVisible();
        await expect(mark.getByRole("img")).toHaveAccessibleName("Unsent words in its composer");
        expect(await title.boundingBox()).toEqual(before);
        await picture(row, `draft-${theme}-1440.png`);
        await page.setViewportSize({ width: 390, height: 900 });
        await row.scrollIntoViewIfNeeded();
        await picture(page, `draft-${theme}-390.png`);
        await page.setViewportSize({ width: 1440, height: 900 });

        // Saved as a note: the words went somewhere, and the mark goes.
        await title.click();
        await row.locator('[data-part="note"]').click();
        await expect(composer).toHaveValue("", { timeout: SLOW_MS });
        await title.click();
        await expect(mark).toHaveCount(0);
      } finally {
        await close();
      }
    }
    await world.machine("ui.theme", null);
  });
});
