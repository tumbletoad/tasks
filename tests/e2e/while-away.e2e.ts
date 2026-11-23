// What a person finds when they come back, end to end in Chromium and Firefox against the real
// service process: the agents' changes of the last seven days on Agents and Today, also after a
// reload; an agent's question under "Needs you" until the person answers or dismisses it, which
// Undo takes back; a long thread read back to its first entry; and a title still being typed back
// in its editor after a reload, unsent. At 1,440 and 390 px in both themes. Fixture data only.
import { expect, type Page } from "@playwright/test";
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

const titleOf = async (world: World, ref: string): Promise<string> =>
  ((await world.op(world.mira.id, "task.get", { task: ref })) as { task: { title: string } }).task
    .title;

async function openAgents(page: Page, world: World): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}/agents`);
  await showsSpace(page, world.mira.name);
}

/** The state in every theme of this browser, at both widths, axe clean in `part`, no sideways scroll. */
async function shots(page: Page, world: World, name: string, part = "main"): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme, { timeout: SLOW_MS });
    for (const [width, height] of [
      [1440, 1000],
      [390, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
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

    await signIn(page, world, `/s/${world.quiet.id}/agents`);
    await expect(page.getByRole("main")).toContainText("No agent changes in the last 7 days.", {
      timeout: SLOW_MS,
    });
  });
});

test.describe("[A5.while-away.e2e.question] an agent's question waits under Needs you", () => {
  test("it shows with its words until the person dismisses it, Undo brings it back, and a note answers it", async ({
    page,
    world,
  }) => {
    const ref = await newTask(world, "Choose the export format");
    const question = "Should the export keep the old column order?";
    await world.op(
      world.mira.id,
      "entry.add",
      { task: ref, kind: "question", text: question },
      "agent",
    );
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
    await shots(page, world, "older");
    // The entry that was the oldest shown stays where it was on the screen.
    const first = thread.locator("li").first();
    const was = await first.getAttribute("data-entry-key");
    const at = (await first.boundingBox())?.y;
    await older.click();
    await expect(thread).toContainText("Note 1:", { timeout: SLOW_MS });
    await expect(row.locator('[data-part="earlier"]')).toHaveCount(0);
    const kept = thread.locator(`li[data-entry-key="${String(was)}"]`);
    expect((await kept.boundingBox())?.y).toBeCloseTo(at ?? 0, 0);
    await expect(kept.locator("..").locator("li").first()).toContainText("Note 1:");
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
});
