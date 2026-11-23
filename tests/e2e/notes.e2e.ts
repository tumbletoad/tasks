// A note taken back in the page and put back (A5 3.7), against the real service process with
// fixture data: Remove on the note's line in the thread and the toast's Undo, then the card's
// removed line after a reload with who took it back, Show and Put back by keyboard, the note back in
// its place. Screenshots at 1,440 and 390 px in both themes, axe clean.
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

/** A task with a note of an agent's between two of the person's. */
async function noted(world: World, title: string, wrong: string): Promise<string> {
  const space = world.mira.id;
  const added = (await world.op(space, "task.add", { tasks: [{ title, area: "lumen" }] })) as Added;
  const ref = added.tasks[0]?.ref ?? "";
  const note = (text: string, as: "user" | "agent") =>
    world.op(space, "entry.add", { task: ref, kind: "note", text }, as);
  await note("Ask Ana whether the new hours start in January.", "user");
  await note("The clinic's site still lists the summer hours.", "agent");
  await note(wrong, "user");
  return ref;
}

const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');

test.describe("[A5.note.retract.e2e] A note is taken back from the thread and put back", () => {
  test("Remove on the note's line and the toast's Undo; after a reload the removed line shows it with Put back, by keyboard", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const wrong = `Printer on floor 2 is jammed again (${tag}).`;
    const ref = await noted(world, `Answer the clinic about opening hours (${tag})`, wrong);
    await watchViolations(page);
    await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const body = page.locator(`li[data-task="${ref}"]`).locator('[data-part="expanded"]');
    const notes = body.locator('[data-entry="note"]');
    const line = notes.filter({ hasText: wrong });
    await expect(notes).toHaveCount(3, { timeout: SLOW_MS });

    // Remove takes the note back; the toast's Undo puts it back.
    await line.hover();
    await line.getByRole("button", { name: "Remove your note" }).click();
    await expect(toast(page)).toHaveText(`Note removed from ${ref}`);
    await expect(line).toHaveCount(0);
    await expect(body.locator('[data-part="removed"]')).toContainText("1 note removed");
    await toastAction(page).click();
    await expect(line).toHaveCount(1, { timeout: SLOW_MS });
    await expect(body.locator('[data-part="removed"]')).toHaveCount(0);

    // By keyboard this time, and an agent's note offers Remove too.
    await expect(
      notes
        .filter({ hasText: "summer hours" })
        .getByRole("button", { name: /^Remove the note by / }),
    ).toHaveCount(1);
    await line.getByRole("button", { name: "Remove your note" }).focus();
    await page.keyboard.press("Enter");
    await expect(line).toHaveCount(0, { timeout: SLOW_MS });

    // After a reload the removed line lists it, with who took it back, and puts it back.
    await page.reload();
    await showsSpace(page, world.mira.name);
    const removedLine = body.locator('[data-part="removed"]');
    await expect(removedLine).toContainText("1 note removed", { timeout: SLOW_MS });
    await expect(notes).toHaveCount(2);
    await removedLine.getByRole("button", { name: "Show" }).click();
    const removed = body.locator('[data-part="removed-note"]');
    await expect(removed).toContainText(wrong);
    await expect(removed).toContainText("You · removed by you");
    await removed.getByRole("button", { name: "Put back" }).focus();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Note put back on ${ref}`);
    await expect(removedLine).toHaveCount(0, { timeout: SLOW_MS });
    // Back in its place: after the agent's note, as it was written.
    await expect(notes).toHaveCount(3);
    await expect(notes.last()).toContainText(wrong);
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A5.note.retract.e2e.screens] A note taken back, in both themes", () => {
  test("the thread's Remove and the removed line at 1,440 px and 390 px in Sumi and Washi, axe clean, nothing wider than the screen", async ({
    browser,
    world,
  }) => {
    test.setTimeout(300_000);
    const tag = test.info().project.name;
    const space = world.mira.id;
    const wrong = `Book the dentist for Tuesday (${tag}).`;
    const ref = await noted(world, `Screens: answer the clinic (${tag})`, wrong);
    const removing = `Ask about the parking permit (${tag}).`;
    await world.op(space, "entry.add", { task: ref, kind: "note", text: removing });
    const status = (await world.op(space, "space.status", {})) as { as_of: string };
    await world.op(space, "note.remove", { task: ref, remove: "3", base: status.as_of });
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
        const body = shot.locator(`li[data-task="${ref}"]`).locator('[data-part="expanded"]');
        const removedLine = body.locator('[data-part="removed"]');
        await removedLine.getByRole("button", { name: "Show" }).click({ timeout: SLOW_MS });
        await expect(body.locator('[data-part="removed-note"]')).toContainText(wrong);
        await body.locator('[data-entry="note"]').filter({ hasText: removing }).hover();
        await picture(shot, `notes-${theme}-1440.png`);
        if (pictures()) expect(await axeFound(shot, ["main"]), `axe in ${theme}`).toEqual([]);
        await shot.setViewportSize({ width: 390, height: 900 });
        const scroll = await shot.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await picture(shot, `notes-${theme}-390.png`);
        if (pictures()) expect(await axeFound(shot, ["main"]), `axe in ${theme}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});
