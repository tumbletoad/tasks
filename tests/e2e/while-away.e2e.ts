// What a person finds when they come back, end to end in Chromium and Firefox against the real
// service process: the agents' changes of the last seven days on Agents and Today, also after a
// reload; an agent's questions under "Needs you" until the person answers or dismisses them,
// which Undo takes back, also once the task is finished; a long thread read back to its first
// entry; and a title or who a task waits on, still being typed, back after a reload, unsent, in the
// tab that typed it alone. At 1,440 and 390 px in both themes. Fixture data only.
import { expect, type Locator, type Page } from "@playwright/test";
import { onOneDay } from "./days.ts";
import { test } from "./fixture.ts";
import { axeFound, openTask, picture, pictures, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const group = (page: Page, name: string) =>
  page.getByRole("main").getByRole("group", { name, exact: true });
const rowIn = (page: Page, name: string, ref: string) =>
  group(page, name).locator(`li[data-task="${ref}"]`);

/** A new task of Mira's in the Inbox, for this test alone. */
async function newTask(world: World, title: string): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [{ title: `${title} (${test.info().project.name})`, inbox: true }],
  })) as { tasks: readonly { ref: string }[] };
  const ref = added.tasks[0]?.ref;
  if (ref === undefined) throw new Error("the task was not added");
  return ref;
}

const read = async (world: World, ref: string) =>
  (await world.op(world.mira.id, "task.get", { task: ref })) as {
    task: { title: string };
    as_of: string;
  };
const titleOf = async (world: World, ref: string): Promise<string> =>
  (await read(world, ref)).task.title;

async function openAgents(page: Page, world: World): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}/agents`);
  await showsSpace(page, world.mira.name);
}

/**
 * The state in every theme of this browser, at both widths, axe clean in `part`, no sideways
 * scroll; `show` in view when given.
 */
async function shots(
  page: Page,
  world: World,
  name: string,
  part = "main",
  show?: Locator,
): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme, { timeout: SLOW_MS });
    // Colours move to the theme's in a transition: the picture and axe take them once they are
    // there. A spinner never ends and is not waited for.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    for (const [width, height] of [
      [1440, 1000],
      [390, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await show?.scrollIntoViewIfNeeded();
      await picture(page, `while-away-${name}-${theme}-${String(width)}.png`);
      if (pictures()) expect(await axeFound(page, [part]), `axe in ${theme}`).toEqual([]);
      const scroll = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(scroll, `sideways scroll at ${String(width)} px`).toBe(0);
    }
  }
  await world.machine("ui.theme", null);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test.describe("[A5.while-away.e2e.recent] agents' changes are read from the service when the page opens", () => {
  test("an agent's change is on Agents and Today before and after a reload; an empty space says what it looked at", async ({
    page,
    world,
  }) => {
    // The change is made in the step, so its own date is the step's day: Today.
    await onOneDay(async () => {
      const ref = await newTask(world, "Collect the clinic exports");
      await world.op(
        world.mira.id,
        "entry.add",
        { task: ref, text: "Pulled the three exports." },
        "agent",
      );
      // A page opened after the change has it: the service gives the recent changes with the rows.
      await openAgents(page, world);
      await expect(rowIn(page, "Today", ref)).toBeVisible({ timeout: SLOW_MS });
      await page.reload();
      await expect(rowIn(page, "Today", ref)).toBeVisible({ timeout: SLOW_MS });
      await shots(page, world, "recent");

      await signIn(page, world, `/s/${world.mira.id}/today`);
      await expect(
        page.locator('main section[aria-label="Changes"]').locator(`li[data-task="${ref}"]`),
      ).toBeVisible({ timeout: SLOW_MS });
    });

    await signIn(page, world, `/s/${world.quiet.id}/agents`);
    await expect(page.getByRole("main")).toContainText("No agent changes in the last 7 days.", {
      timeout: SLOW_MS,
    });
  });
});

test.describe("[A5.while-away.e2e.question] an agent's questions wait under Needs you", () => {
  test("they show with their words until the person dismisses them, Undo brings them back, a note answers them, and they wait on a finished task too", async ({
    page,
    world,
  }) => {
    const ask = (ref: string, text: string) =>
      world.op(world.mira.id, "entry.add", { task: ref, kind: "question", text }, "agent");
    // Once dismissed, the task is under the day of its change: the step's, Today.
    await onOneDay(async () => {
      const ref = await newTask(world, "Choose the export format");
      const question = "Should the export keep the old column order?";
      await ask(ref, question);
      await openAgents(page, world);
      const waiting = rowIn(page, "Needs you", ref);
      await expect(waiting).toBeVisible({ timeout: SLOW_MS });
      await expect(waiting.locator('[data-part="question"]')).toContainText(question);
      await shots(page, world, "question");

      // Dismissed: it leaves Needs you, and Undo puts it back.
      await waiting.getByRole("button", { name: "Dismiss" }).click();
      await expect(waiting).toHaveCount(0, { timeout: SLOW_MS });
      await expect(rowIn(page, "Today", ref)).toBeVisible();
      await page.locator('[data-part="toast-action"]').click();
      await expect(waiting).toBeVisible({ timeout: SLOW_MS });

      // The person's note after the question answers it.
      await world.op(world.mira.id, "entry.add", {
        task: ref,
        kind: "note",
        text: "Keep the old order until the clinic confirms.",
      });
      await expect(waiting).toHaveCount(0, { timeout: SLOW_MS });
      await page.reload();
      await expect(rowIn(page, "Today", ref)).toBeVisible({ timeout: SLOW_MS });
      await expect(waiting).toHaveCount(0);
    });

    // Two questions on a task that is then finished: both wait, newest first, after a reload too.
    const ref = await newTask(world, "Send the export to the clinic");
    await ask(ref, "Which address should it go to?");
    await ask(ref, "Should it be encrypted?");
    await world.op(world.mira.id, "task.finish", {
      task: ref,
      base: (await read(world, ref)).as_of,
    });
    await page.reload();
    const waiting = rowIn(page, "Needs you", ref);
    await expect(waiting).toBeVisible({ timeout: SLOW_MS });
    const asked = waiting.locator('[data-part="question"]');
    await expect(asked).toContainText("2 questions wait");
    await expect(asked.locator("li")).toHaveText([
      /Should it be encrypted\?/u,
      /Which address should it go to\?/u,
    ]);
    await shots(page, world, "questions", "main", waiting);
    await waiting.getByRole("button", { name: "Dismiss the 2 questions" }).click();
    await expect(waiting).toHaveCount(0, { timeout: SLOW_MS });
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(waiting).toHaveCount(0, { timeout: SLOW_MS });
  });
});

/** Notes long enough that each fills about a page of a thread's read. */
const NOTES = 30;

test.describe("[A5.while-away.e2e.older] a long thread reads back to its first entry", () => {
  test("Earlier shows what is loaded, Older entries loads the rest and keeps the place, and the first note is reached", async ({
    page,
    world,
  }) => {
    test.setTimeout(240_000);
    const ref = await newTask(world, "Read the whole thread");
    for (let i = 1; i <= NOTES; i += 1) {
      await world.op(world.mira.id, "entry.add", {
        task: ref,
        kind: "note",
        text: `Note ${String(i)}: ${"Notes from the planning call. ".repeat(110)}`,
      });
    }
    const row = await openTask(page, world, ref);
    const thread = row.getByRole("list", { name: "Notes, log, sessions and runs" });
    await expect(thread).toContainText(`Note ${String(NOTES)}:`, { timeout: SLOW_MS });
    await row.locator('[data-part="earlier"]').click();
    const older = row.getByRole("button", { name: "Older entries" });
    await expect(older).toBeEnabled({ timeout: SLOW_MS });
    await shots(page, world, "older", "main", older);
    // The entry that was the oldest shown stays where it was on the screen.
    await older.scrollIntoViewIfNeeded();
    const first = thread.locator("li").first();
    const was = await first.getAttribute("data-entry-key");
    const at = (await first.boundingBox())?.y;
    await older.click();
    await expect(thread).toContainText("Note 1:", { timeout: SLOW_MS });
    await expect(row.locator('[data-part="earlier"]')).toHaveCount(0);
    const kept = thread.locator(`li[data-entry-key="${String(was)}"]`);
    expect(Math.abs(((await kept.boundingBox())?.y ?? 0) - (at ?? 0))).toBeLessThanOrEqual(2);
    await expect(kept.locator("..").locator("li").first()).toContainText("Note 1:");
  });
});

test.describe("[A5.while-away.e2e.waiting-draft] who a task waits on, still being typed, survives a reload", () => {
  test("the typed words come back in Waiting on, unsent, also when the card closes and opens; Escape lets them go", async ({
    page,
    world,
  }) => {
    const added = (await world.op(world.mira.id, "task.add", {
      tasks: [
        {
          title: `Get the roof quote (${test.info().project.name})`,
          inbox: true,
          status: "waiting",
          waiting_on: "Ana",
        },
      ],
    })) as { tasks: readonly { ref: string }[] };
    const ref = added.tasks[0]?.ref ?? "";
    const waitingOf = async () =>
      (
        (await world.op(world.mira.id, "task.get", { task: ref })) as {
          task: { waiting_on?: string };
        }
      ).task.waiting_on;
    const row = await openTask(page, world, ref);
    const field = row.getByRole("combobox", { name: "Waiting on" });
    await field.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Reyes");
    await page.reload();
    await expect(field).toHaveValue("Ana Reyes", { timeout: SLOW_MS });
    // Never saved by itself, also when the card closes before the person is in the field again.
    let updates = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/op/task.update")) updates += 1;
    });
    const title = row.locator('[data-part="title"]');
    await title.click();
    await expect(title).toHaveAttribute("aria-expanded", "false");
    await title.click();
    await expect(field).toHaveValue("Ana Reyes", { timeout: SLOW_MS });
    expect(updates).toBe(0);
    expect(await waitingOf()).toBe("Ana");
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(field).toHaveValue("Ana");
    await page.reload();
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
      timeout: SLOW_MS,
    });
    await expect(field).toHaveValue("Ana");
    expect(await waitingOf()).toBe("Ana");
  });
});

test.describe("[A5.while-away.e2e.title-draft] a title still being typed survives a reload", () => {
  test("the typed title comes back in its editor, unsent; Escape lets it go", async ({
    page,
    world,
  }) => {
    const ref = await newTask(world, "Book the venue");
    const before = await titleOf(world, ref);
    const row = await openTask(page, world, ref);
    await row.locator('[data-part="title"]').focus();
    await page.keyboard.press("F2");
    const field = row.getByRole("textbox", { name: "Title" });
    await expect(field).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" for March");
    await page.reload();
    await expect(field).toHaveValue(`${before} for March`, { timeout: SLOW_MS });
    await shots(page, world, "title-draft", `li[data-task="${ref}"]`);
    // Never saved by itself.
    expect(await titleOf(world, ref)).toBe(before);
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(row.locator('[data-part="title"]')).toHaveText(before);
    await page.reload();
    await expect(row.locator('[data-part="title"]')).toHaveText(before, { timeout: SLOW_MS });
    await expect(field).toHaveCount(0);
    expect(await titleOf(world, ref)).toBe(before);
  });

  test("a second tab shows what the first types as typed there and cannot erase it; on a task finished meanwhile the words stay with Copy and Discard", async ({
    page,
    world,
  }) => {
    const ref = await newTask(world, "Book the hall");
    const before = await titleOf(world, ref);
    const other = await page.context().newPage();
    const first = await openTask(page, world, ref);
    const second = await openTask(other, world, ref);
    const editor = (row: Locator) => row.getByRole("textbox", { name: "Title" });
    const open = async (tab: Page, row: Locator) => {
      await tab.bringToFront();
      await row.locator('[data-part="title"]').focus();
      await tab.keyboard.press("F2");
      await expect(editor(row)).toBeFocused();
    };
    // Both editors open before anyone types; the first tab types, the second lets its own go.
    await open(page, first);
    await open(other, second);
    await page.bringToFront();
    await editor(first).focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" in April");
    const typed = `${before} in April`;
    await other.bringToFront();
    await editor(second).focus();
    await other.keyboard.press("Escape");
    const elsewhere = second.locator('[data-part="kept-title"]');
    await expect(elsewhere).toHaveAttribute("data-reason", "other-tab", { timeout: SLOW_MS });
    await expect(elsewhere.locator('[data-part="kept-title-value"]')).toHaveText(typed);
    await expect(elsewhere).toContainText("Typed in another tab");
    await shots(other, world, "title-other-tab", `li[data-task="${ref}"]`);
    // The first tab's words are still its own after a reload.
    await page.bringToFront();
    await page.reload();
    await expect(editor(first)).toHaveValue(typed, { timeout: SLOW_MS });
    await expect(first.locator('[data-part="kept-title"]')).toHaveCount(0);

    // Finished meanwhile: no editor that cannot save, but the words with Copy and Discard.
    await world.op(world.mira.id, "task.finish", {
      task: ref,
      base: (await read(world, ref)).as_of,
    });
    await page.reload();
    const kept = first.locator('[data-part="kept-title"]');
    await expect(kept).toHaveAttribute("data-reason", "finished", { timeout: SLOW_MS });
    await expect(kept.locator('[data-part="kept-title-value"]')).toHaveText(typed);
    await expect(editor(first)).toHaveCount(0);
    await expect(kept.getByRole("button", { name: `Copy: ${typed}` })).toBeVisible();
    await shots(page, world, "title-finished", `li[data-task="${ref}"]`);
    await kept.getByRole("button", { name: "Discard" }).click();
    await expect(kept).toHaveCount(0);
    await expect(second.locator('[data-part="kept-title"]')).toHaveCount(0, { timeout: SLOW_MS });
    await other.close();
    expect(await titleOf(world, ref)).toBe(before);
  });
});
