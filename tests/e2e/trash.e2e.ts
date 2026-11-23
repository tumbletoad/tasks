// A task taken away and brought back in the page (A5's Trash), against the real service process
// with fixture data: Move to Trash in the card and the toast's Undo; the Trash in the sidebar,
// grouped by the change that moved tasks there, with Restore these, a Restore on each row that the
// keyboard reaches, and Find; a link to a task in the Trash opens it there, read-only, with
// Restore; a run working on a removed task stays on Agents after a cold reload, with Stop; the
// words typed for a task the space does not have now stay at the foot of the Trash. Screenshots at
// 1,440 and 390 px for review.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import {
  axeFound,
  openTask,
  picture,
  pictures,
  showsSpace,
  signIn,
  themes,
  violations,
  watchViolations,
} from "./page.ts";
import { FAKE_QUESTION } from "./codex-cases.ts";
import { CODEX_INSTANCE, SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

async function addTask(world: World, draft: Record<string, unknown>): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: [draft] })) as Added;
  const ref = added.tasks[0]?.ref;
  if (ref === undefined) throw new Error("the task was not added");
  return ref;
}

/** Moves tasks to the Trash in one change, as `ttasks delete` does: with a base just read. */
async function removeTasks(world: World, tasks: readonly string[]): Promise<void> {
  const space = world.mira.id;
  const status = (await world.op(space, "space.status", {})) as { as_of: string };
  await world.op(space, "task.delete", { tasks, base: status.as_of });
}

const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');
const rowOf = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);

async function both(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await picture(page, `${name}-1440.png`);
  await page.setViewportSize({ width: 390, height: 844 });
  await picture(page, `${name}-390.png`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe("[A5.trash.e2e] A task taken away and brought back in the page", () => {
  test("Move to Trash and its Undo; the Trash by change with Restore these, Find and a Restore the keyboard reaches; a link opens a removed task there", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const one = await addTask(world, { title: `Renew the passport (${tag})`, area: "home" });
    await watchViolations(page);
    await openTask(page, world, one);

    // Move to Trash at the foot of the card's facts; the toast's Undo brings it back.
    const card = rowOf(page, one);
    await card.locator('[data-part="move-to-trash"]').click();
    await expect(toast(page)).toHaveText(`Moved ${one} to the Trash`);
    await expect(card.locator('[data-part="in-trash"]')).toBeVisible({ timeout: SLOW_MS });
    await toastAction(page).click();
    await expect(card.locator('[data-part="in-trash"]')).toHaveCount(0, { timeout: SLOW_MS });
    await card.locator('[data-part="move-to-trash"]').click();
    await expect(card.locator('[data-part="in-trash"]')).toBeVisible({ timeout: SLOW_MS });

    // Two duplicates moved in one change, from the command line's entry.
    const twins = [
      await addTask(world, { title: `Book the dentist (${tag})`, area: "home" }),
      await addTask(world, { title: `Book the dentist again (${tag})`, area: "home" }),
    ];
    await removeTasks(world, twins);

    await page.goto(`${world.origin}/s/${space}/trash`);
    await showsSpace(page, world.mira.name);
    const groups = page.locator('main [role="group"]');
    const change = groups.filter({ hasText: "You moved 2 tasks here" });
    await expect(change).toBeVisible({ timeout: SLOW_MS });
    await expect(change.locator("li[data-task]")).toHaveCount(2);
    await expect(groups.filter({ has: page.locator(`li[data-task="${one}"]`) })).toContainText(
      "You moved 1 task here",
    );
    await expect(rowOf(page, one).locator('[data-part="trash-where"]')).toContainText("Home");
    await both(page, "trash");

    // Find by words of a title, then by reference.
    const find = page.locator('[data-part="trash-find"]');
    await find.fill("again");
    await expect(page.locator("main li[data-task]")).toHaveCount(1, { timeout: SLOW_MS });
    await expect(rowOf(page, twins[1] ?? "")).toBeVisible();
    await find.fill(one);
    await expect(page.locator("main li[data-task]")).toHaveCount(1, { timeout: SLOW_MS });
    await find.fill("");
    await expect(change.locator("li[data-task]")).toHaveCount(2, { timeout: SLOW_MS });

    // A row's Restore is a button in the tab order: Enter on it restores, and focus moves on.
    const restore = rowOf(page, one).locator('[data-part="restore"]');
    await restore.focus();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`${one} is back in Open, in Home`, { timeout: SLOW_MS });
    await expect(rowOf(page, one)).toHaveCount(0, { timeout: SLOW_MS });

    // Restore these brings back the change's tasks, with one Undo for them.
    await change.getByRole("button", { name: "Restore these" }).click();
    await expect(toast(page)).toHaveText("2 tasks are back", { timeout: SLOW_MS });
    await expect(page.locator("main li[data-task]")).toHaveCount(0, { timeout: SLOW_MS });
    await expect(page.locator("main")).toContainText("The Trash is empty.");

    // A link to a task in the Trash opens it there, expanded and read-only, with Restore.
    await removeTasks(world, [one]);
    await page.goto(`${world.origin}/s/${space}/task/${one}`);
    await expect(page).toHaveURL(new RegExp(`/s/${space}/trash\\?task=${one}$`, "u"), {
      timeout: SLOW_MS,
    });
    const shown = rowOf(page, one);
    await expect(shown.locator('[data-part="in-trash"]')).toBeVisible({ timeout: SLOW_MS });
    await expect(shown.locator('[data-part="move-to-trash"]')).toHaveCount(0);
    await expect(shown.locator('[data-part="tile"]')).toHaveCount(0);
    await both(page, "trash-card");
    await shown
      .locator('[data-part="facts"] [data-part="restore"], dd [data-part="restore"]')
      .first()
      .click();
    await expect(toast(page)).toHaveText(`${one} is back in Open, in Home`, { timeout: SLOW_MS });
    await expect(shown.locator('[data-part="in-trash"]')).toHaveCount(0, { timeout: SLOW_MS });
    expect(await violations(page)).toEqual([]);
  });

  test("the words typed for a task the space does not have now stay at the foot of the Trash, with Copy and Discard", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const ref = await addTask(world, { title: `Write to the landlord (${tag})`, area: "home" });
    await watchViolations(page);
    await openTask(page, world, ref);
    const words = `Ask whether the deposit came back (${tag})`;
    await rowOf(page, ref).locator('[data-part="composer"]').fill(words);
    // The task's creation is undone: the space does not have it now.
    await world.op(space, "history.undo", {});
    await page.goto(`${world.origin}/s/${space}/trash`);
    await showsSpace(page, world.mira.name);
    const unsent = page.locator('[data-part="unsent-words"]');
    await expect(unsent).toContainText(words, { timeout: SLOW_MS });
    await both(page, "trash-unsent");
    await unsent.getByRole("button", { name: "Discard" }).click();
    await expect(unsent).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A5.trash.e2e.screens] The Trash in both themes", () => {
  test("the Trash by change at 1,440 px and 390 px in Sumi and Washi, axe clean, nothing wider than the screen", async ({
    browser,
    world,
  }) => {
    test.setTimeout(300_000);
    const tag = test.info().project.name;
    const space = world.mira.id;
    const tasks = [
      await addTask(world, { title: `Screens: renew the passport (${tag})`, area: "home" }),
      await addTask(world, { title: `Screens: book the dentist (${tag})`, area: "home" }),
      await addTask(world, { title: `Screens: answer the clinic (${tag})`, area: "lumen" }),
    ];
    await removeTasks(world, tasks.slice(0, 2));
    await removeTasks(world, tasks.slice(2));
    for (const theme of themes()) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const shot = await context.newPage();
        await world.machine("ui.theme", theme);
        await signIn(shot, world, `/s/${space}/trash`);
        await showsSpace(shot, world.mira.name);
        await expect(shot.locator("main li[data-task]")).toHaveCount(3, { timeout: SLOW_MS });
        await picture(shot, `trash-${theme}-1440.png`);
        if (pictures()) expect(await axeFound(shot, ["main"]), `axe in ${theme}`).toEqual([]);
        await shot.setViewportSize({ width: 390, height: 900 });
        const scroll = await shot.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await picture(shot, `trash-${theme}-390.png`);
        if (pictures()) expect(await axeFound(shot, ["main"]), `axe in ${theme}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});

test.describe("[A5.trash.e2e.runs] Work on a removed task stays in sight", () => {
  test("a run working on a task moved to the Trash stays on Agents after a cold reload, marked, with Stop in its card; the run queued behind it says it did not start @one-browser", async ({
    page,
    runs: world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const ref = await addTask(world, { title: `Watch the nightly export (${tag})`, area: "home" });
    world.codex(ref, ["hold", "answer"]);
    await openTask(page, world, ref);
    const row = rowOf(page, ref);
    const run = row.getByRole("button", { name: `Run with ${CODEX_INSTANCE.label}` });
    await run.click();
    const entry = row.locator('[data-entry="run"]').first();
    await expect(entry.locator('[data-part="run-state"]')).toContainText("is working on it", {
      timeout: SLOW_MS,
    });
    // A second run waits behind the first.
    await row.locator('[data-part="composer"]').fill("Then check the results");
    await run.click();
    await expect(
      row.locator('[data-entry="run"]').nth(1).locator('[data-part="run-state"]'),
    ).toContainText("Waiting to start", { timeout: SLOW_MS });
    await row.locator('[data-part="move-to-trash"]').click();
    await expect(toast(page)).toHaveText(`Moved ${ref} to the Trash. Its run is still working`);

    // A cold page: the Agents view reads the removed task with its run.
    await page.goto(`${world.origin}/s/${space}/agents`);
    await page.reload();
    await showsSpace(page, world.mira.name);
    const listed = rowOf(page, ref);
    await expect(listed.locator('[data-part="agents-in-trash"]')).toBeVisible({ timeout: SLOW_MS });
    await both(page, "trash-agents");
    await listed.locator('[data-part="title"]').click();
    const stop = listed
      .locator('[data-entry="run"]')
      .first()
      .getByRole("button", { name: /^Stop/u });
    await stop.click({ timeout: SLOW_MS });
    const runs = listed.locator('[data-entry="run"] [data-part="run-state"]');
    await expect(runs.first()).toContainText(/^Stopped\./u, { timeout: SLOW_MS });
    // The queued run's check before it starts finds the task in the Trash: it says so.
    await expect(runs.nth(1)).toContainText(
      "Did not start: the task was finished or moved to the Trash first.",
      { timeout: SLOW_MS },
    );
  });
});

test.describe("[A5.trash.e2e.answer] A run on a removed task that answers afterwards is where a live task's is", () => {
  test("removed while its run works, the run then asks: on a cold page the task is under Needs you beside a live one, marked; Restore changes nothing but the mark @one-browser", async ({
    page,
    runs: world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const live = await addTask(world, { title: `Check the export (${tag})`, area: "home" });
    const removed = await addTask(world, { title: `Check the backup (${tag})`, area: "home" });
    for (const ref of [live, removed]) {
      world.codex(ref, ["gate"]);
      await openTask(page, world, ref);
      const row = rowOf(page, ref);
      await row.getByRole("button", { name: `Run with ${CODEX_INSTANCE.label}` }).click();
      await expect(
        row.locator('[data-entry="run"]').first().locator('[data-part="run-state"]'),
      ).toContainText("is working on it", { timeout: SLOW_MS });
    }
    await removeTasks(world, [removed]);

    // A cold page: both work, the removed one marked.
    await page.goto(`${world.origin}/s/${space}/agents`);
    await page.reload();
    await showsSpace(page, world.mira.name);
    const groupOf = (ref: string) =>
      page.locator('main [role="group"]').filter({ has: page.locator(`li[data-task="${ref}"]`) });
    await expect(groupOf(removed)).toContainText("Working", { timeout: SLOW_MS });
    await expect(groupOf(live)).toContainText("Working");
    await expect(rowOf(page, removed).locator('[data-part="agents-in-trash"]')).toBeVisible();

    // Both runs go on and ask: the removed task is where the live one is, with the question.
    world.openGate(live);
    world.openGate(removed);
    await expect(groupOf(removed)).toContainText("Needs you", { timeout: SLOW_MS });
    await expect(groupOf(live)).toContainText("Needs you", { timeout: SLOW_MS });
    await expect(rowOf(page, removed).locator('[data-part="agents-in-trash"]')).toBeVisible();
    await rowOf(page, removed).locator('[data-part="title"]').click();
    await expect(rowOf(page, removed).locator('[data-entry="run"]').first()).toContainText(
      FAKE_QUESTION,
      { timeout: SLOW_MS },
    );

    // Restore: the same group and the same answer, without the mark.
    await rowOf(page, removed)
      .locator('[data-part="agents-in-trash"] [data-part="restore"]')
      .click();
    await expect(toast(page)).toContainText(`${removed} is back`, { timeout: SLOW_MS });
    await expect(rowOf(page, removed).locator('[data-part="agents-in-trash"]')).toHaveCount(0, {
      timeout: SLOW_MS,
    });
    await expect(groupOf(removed)).toContainText("Needs you");
    await expect(rowOf(page, removed).locator('[data-entry="run"]').first()).toContainText(
      FAKE_QUESTION,
    );
  });
});
