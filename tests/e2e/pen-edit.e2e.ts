// The person corrects what an agent wrote, against the real service process with fixture
// data: the pen on the brief, the description, an agent's note and log entry, and the person's own
// note; Enter saves (Ctrl+Enter in the description), the toast's Undo puts the words before back,
// Escape lets go, and words typed and not sent come back after a reload. A task without a brief or
// a description is given one in its card. Screenshots at 1,440 and 390 px in both themes, axe
// clean.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import {
  axeFound,
  picture,
  pictures,
  showsSpace,
  signIn,
  themes,
  violations,
  watchViolations,
} from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

/**
 * A task an agent added, with its brief and description, its note and progress, and a note of the
 * person's.
 */
async function written(world: World, tag: string): Promise<string> {
  const space = world.mira.id;
  const added = (await world.op(
    space,
    "task.add",
    {
      tasks: [
        {
          title: `Answer the clinic about opening hours (${tag})`,
          summary: "Confirm the new hours with Ana",
          context: "The clinic opens at 8 from Janury, and closes at 6 on Fridays.",
          area: "lumen",
        },
      ],
    },
    "agent",
  )) as Added;
  const ref = added.tasks[0]?.ref ?? "";
  const entry = (kind: string, text: string, as: "user" | "agent") =>
    world.op(space, "entry.add", { task: ref, kind, text }, as);
  await entry("note", "Drafted teh reply to Ana.", "agent");
  await entry("progress", "Checked the site: it still lists the sumer hours.", "agent");
  await entry("note", "Ask whether Saturdays change too.", "user");
  return ref;
}

const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');

test.describe("[A5.entry.correct.e2e] The person corrects an agent's words behind their pens", () => {
  test("a note by Enter and back by the toast's Undo; the log entry by keyboard; the description after a reload; the brief let go with Escape", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await written(world, tag);
    await watchViolations(page);
    await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const row = page.locator(`li[data-task="${ref}"]`);
    const body = row.locator('[data-part="expanded"]');
    const box = row.locator('[data-part="text-edit"]');
    const note = body.locator('[data-entry="note"]').filter({ hasText: "Ana." });
    await expect(note).toHaveCount(1, { timeout: SLOW_MS });

    // Every note and log entry has its pen in sight, the person's own too.
    const pen = note.getByRole("button", { name: /^Edit the note by / });
    await expect(pen).toHaveCSS("opacity", "1");
    await expect(
      body.locator('[data-entry="note"]').getByRole("button", { name: "Edit your note" }),
    ).toHaveCount(1);

    // The agent's note: the pen opens its words in place, Enter saves them, Undo puts them back.
    await pen.click();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("Drafted teh reply to Ana.");
    await box.fill("Drafted the reply to Ana.");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Note on ${ref} changed`);
    await expect(box).toHaveCount(0);
    await expect(note).toContainText("Drafted the reply to Ana.");
    await expect(note.locator('[data-part="edited"]')).toHaveText("edited by you", {
      timeout: SLOW_MS,
    });
    await toastAction(page).click();
    await expect(note).toContainText("Drafted teh reply to Ana.", { timeout: SLOW_MS });
    await expect(note.locator('[data-part="edited"]')).toHaveCount(0);

    // The agent's progress entry, by keyboard.
    const entry = body.locator('[data-entry="log"]');
    await entry.getByRole("button", { name: /^Edit the entry by / }).focus();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await page.keyboard.press("End");
    await box.fill("Checked the site: it still lists the summer hours.");
    await page.keyboard.press("Enter");
    await expect(entry).toContainText("lists the summer hours.");
    await expect(entry.locator('[data-part="edited"]')).toHaveText("edited by you", {
      timeout: SLOW_MS,
    });

    // The description: words typed and not sent come back in the box after a reload, then save.
    const context = body.locator('[data-part="context"]');
    await context.getByRole("button", { name: "Edit the description" }).click();
    await box.fill("The clinic opens at 8 from January, and closes at 6 on Fridays.");
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(box).toHaveValue(
      "The clinic opens at 8 from January, and closes at 6 on Fridays.",
      { timeout: SLOW_MS },
    );
    await box.focus();
    await page.keyboard.press("Control+Enter");
    await expect(toast(page)).toHaveText(`Description of ${ref} changed`);
    await expect(context).toContainText("from January");

    // The brief: Escape lets the words go and keeps the card open.
    const summary = row.locator('[data-part="summary"]');
    await summary.getByRole("button", { name: "Edit the brief" }).click();
    await expect(box).toHaveValue("Confirm the new hours with Ana");
    await box.fill("Confirm the hours");
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
    await expect(summary).toHaveText("Confirm the new hours with Ana");
    await expect(body).toBeVisible();

    // What an agent reads now is the person's words.
    const read = (await world.op(
      world.mira.id,
      "task.get",
      { task: ref, sections: ["context", "log"] },
      "agent",
    )) as { sections: { context?: string; log?: { text: string }[] } };
    expect(read.sections.context).toContain("from January");
    expect(read.sections.log?.[0]?.text).toContain("summer hours");
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A5.text.add.e2e] A task without a brief or a description is given one in its card", () => {
  test("the brief by keyboard alone, there after a reload; the description with its Preview, saved by Ctrl+Enter from the Preview", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const added = (await world.op(world.mira.id, "task.add", {
      tasks: [{ title: `Renew the library card (${tag})`, area: "lumen" }],
    })) as Added;
    const ref = added.tasks[0]?.ref ?? "";
    await watchViolations(page);
    await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const row = page.locator(`li[data-task="${ref}"]`);
    const box = row.locator('[data-part="text-edit"]');
    const addBrief = row.getByRole("button", { name: "Add a brief" });
    const addDescription = row.getByRole("button", { name: "Add a description" });
    await expect(addDescription).toBeVisible({ timeout: SLOW_MS });

    // From the title, the next stop is Add a brief; Enter opens the box, Enter saves.
    await row.locator('[data-part="title"]').focus();
    await page.keyboard.press("Tab");
    await expect(addBrief).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await page.keyboard.type("Bring the old card and a photo");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Brief of ${ref} changed`);
    await page.reload();
    await showsSpace(page, world.mira.name);
    const summary = row.locator('[data-part="summary"]');
    await expect(summary).toContainText("Bring the old card and a photo", { timeout: SLOW_MS });
    await expect(addBrief).toHaveCount(0);

    // The description: Enter is a new line; the Preview shows the Markdown, and Ctrl+Enter there
    // saves.
    await addDescription.click();
    await expect(box).toBeFocused();
    await page.keyboard.type("The branch on **Main Street**");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- open until 6");
    const preview = row.getByRole("button", { name: "Preview" });
    await preview.click();
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    const shown = row.locator('[data-part="text-preview"]');
    await expect(shown.locator("strong")).toHaveText("Main Street");
    await expect(shown.locator("li")).toHaveText("open until 6");
    // A click in the Preview's words, to select them, neither saves nor closes the box: back to
    // the words, a line more, and Ctrl+Enter from the Preview saves them all.
    await shown.locator("strong").click();
    await preview.click();
    await expect(box).toBeFocused();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- closed on Sundays");
    await preview.click();
    await expect(preview).toBeFocused();
    await page.keyboard.press("Control+Enter");
    await expect(toast(page)).toHaveText(`Description of ${ref} changed`);
    const context = row.locator('[data-part="context"]');
    await expect(context.locator("strong")).toHaveText("Main Street");
    await expect(addDescription).toHaveCount(0);
    const read = (await world.op(world.mira.id, "task.get", {
      task: ref,
      sections: ["context"],
    })) as { sections: { context?: string } };
    expect(read.sections.context).toBe(
      "The branch on **Main Street**\n- open until 6\n- closed on Sundays",
    );
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A5.entry.correct.e2e.screens] The pens and the box, in both themes", () => {
  test("the brief, the description and the thread with their pens, a corrected note, the box open, the description's Preview, and a task with neither text, at 1,440 px and 390 px in Sumi and Washi, axe clean, nothing wider than the screen", async ({
    browser,
    world,
  }) => {
    test.setTimeout(300_000);
    const tag = test.info().project.name;
    const space = world.mira.id;
    const ref = await written(world, `screens ${tag}`);
    const bare = (
      (await world.op(space, "task.add", {
        tasks: [{ title: `Renew the library card (screens ${tag})`, area: "lumen" }],
      })) as Added
    ).tasks[0]?.ref;
    // The agent's log entry and the person's own note, corrected.
    for (const [entry, text] of [
      ["l1", "Checked the site: it still lists the summer hours."],
      ["n2", "Ask whether Saturdays and holidays change too."],
    ]) {
      const status = (await world.op(space, "space.status", {})) as { as_of: string };
      await world.op(space, "entry.edit", { task: ref, entry, text, base: status.as_of });
    }
    for (const theme of themes()) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const shot = await context.newPage();
        await world.machine("ui.theme", theme);
        await signIn(shot, world, `/s/${space}/task/${ref}`);
        await showsSpace(shot, world.mira.name);
        const row = shot.locator(`li[data-task="${ref}"]`);
        const entry = row.locator('[data-entry="log"]');
        await expect(entry.locator('[data-part="edited"]')).toHaveText("edited by you", {
          timeout: SLOW_MS,
        });
        const shoot = async (name: string) => {
          await picture(shot, `${name}-${theme}-1440.png`);
          if (pictures()) expect(await axeFound(shot, ["main"]), `axe in ${theme}`).toEqual([]);
          await shot.setViewportSize({ width: 390, height: 900 });
          const scroll = await shot.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
          await picture(shot, `${name}-${theme}-390.png`);
          if (pictures()) expect(await axeFound(shot, ["main"]), `axe in ${theme}`).toEqual([]);
          await shot.setViewportSize({ width: 1440, height: 1000 });
        };
        await shoot("pens");
        await row
          .locator('[data-entry="note"]')
          .filter({ hasText: "Ana." })
          .getByRole("button", { name: /^Edit the note by / })
          .click();
        await expect(row.locator('[data-part="text-edit"]')).toBeFocused();
        await shoot("pen-box");
        await shot.keyboard.press("Escape");
        await row.getByRole("button", { name: "Edit the description" }).click();
        await shot.keyboard.press("Control+End");
        await shot.keyboard.press("Enter");
        await shot.keyboard.press("Enter");
        await shot.keyboard.type("- **Fridays**: closes at 6");
        await row.getByRole("button", { name: "Preview" }).click();
        await expect(row.locator('[data-part="text-preview"] strong')).toHaveText("Fridays");
        await shoot("preview");
        await shot.keyboard.press("Escape");
        await signIn(shot, world, `/s/${space}/task/${bare ?? ""}`);
        await showsSpace(shot, world.mira.name);
        await expect(
          shot.locator(`li[data-task="${bare ?? ""}"]`).getByRole("button", {
            name: "Add a description",
          }),
        ).toBeVisible({ timeout: SLOW_MS });
        await shoot("adds");
      } finally {
        await context.close();
        // The theme is the machine's, shared by the file's other tests: back to the default.
        await world.machine("ui.theme", null);
      }
    }
  });
});
