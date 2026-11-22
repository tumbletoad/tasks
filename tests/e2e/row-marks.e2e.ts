// A row's mark for unsent words, and Open's question before a folder that may be another one, in
// Chromium and Firefox against the real service process with fixture data and the fake terminal
// behind Open. Each in Sumi and Washi at 1,440 and 390 px.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { test } from "./fixture.ts";
import { showsSpace, signIn } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

const THEMES = ["sumi", "washi"] as const;

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
  theme: (typeof THEMES)[number],
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
    for (const theme of THEMES) {
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
        await row.screenshot({ path: test.info().outputPath(`draft-${theme}-1440.png`) });
        await page.setViewportSize({ width: 390, height: 900 });
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath(`draft-${theme}-390.png`) });
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

test.describe("[A4.5.e2e.open-marker-screens] Open's question about a folder that may be another one", () => {
  test("the toast names the folder in its sentence, in both themes at 1,440 and 390 px", async ({
    browser,
    world,
  }) => {
    const temp = mkdtempSync(join(tmpdir(), "ttasks-e2e-marker-screens-"));
    try {
      const folder = join(temp, "portal");
      mkdirSync(join(folder, ".git"), { recursive: true });
      writeFileSync(
        join(folder, ".git", "config"),
        '[remote "origin"]\n\turl = https://git.example.com/mira/portal-web.git\n',
      );
      const ref = await addTask(world, {
        title: `Tag the portal hotfix (${test.info().project.name})`,
        inbox: true,
      });
      const base = ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string })
        .as_of;
      const set = (await world.op(world.mira.id, "folder.manage", {
        action: "set",
        task: ref,
        folder,
        base,
      })) as { folder: string };
      // The checkout is moved aside and an unrelated folder made at its path.
      renameSync(folder, join(temp, "portal-aside"));
      mkdirSync(folder);
      const before = world.terminal().length;
      for (const theme of THEMES) {
        const { page, close } = await themed(browser, world, theme, `/task/${ref}`);
        try {
          const row = page.locator(`main li[data-task="${ref}"]`);
          await row
            .getByRole("toolbar")
            .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
            .click();
          const said = page.getByRole("status").filter({
            hasText: `The folder ${set.folder} has no TTasks marker, so it may not be the folder set for this task. Nothing was started.`,
          });
          await expect(said).toBeVisible({ timeout: SLOW_MS });
          await page.screenshot({ path: test.info().outputPath(`marker-${theme}-1440.png`) });
          await page.setViewportSize({ width: 390, height: 900 });
          await expect(said).toBeVisible();
          await page.screenshot({ path: test.info().outputPath(`marker-${theme}-390.png`) });
        } finally {
          await close();
        }
      }
      expect(world.terminal()).toHaveLength(before);
    } finally {
      await world.machine("ui.theme", null);
      rmSync(temp, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
  });
});
