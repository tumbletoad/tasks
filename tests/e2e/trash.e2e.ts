// A task taken away and brought back in the page (A5's Trash), against the real service process
// with fixture data: Move to Trash in the card and the toast's Undo; the Trash in the sidebar,
// grouped by the change that moved tasks there, with Restore these, a Restore on each row that the
// keyboard reaches, and Find; a link to a task in the Trash opens it there, read-only, with
// Restore; a run working on a removed task stays on Agents after a cold reload, with Stop; the
// words typed for a task the space does not have now stay at the foot of the Trash; an agent's
// removal under its name, counted in the side menu until the Trash is opened; Delete on a focused
// row. Screenshots at 1,440 and 390 px for review.
import { expect, type Page } from "@playwright/test";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
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
import { FAKE_INSTANCE } from "./fake-terminal.ts";
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
    // The toast goes by itself after a few seconds; the pointer resting on it keeps it until its
    // Undo is pressed below, however long the service takes to answer.
    await toast(page).hover();
    await expect(card.locator('[data-part="in-trash"]')).toBeVisible({ timeout: SLOW_MS });
    // Focus goes to the Restore that takes the button's place, not to the page.
    await expect(card.locator('dd [data-part="restore"]')).toBeFocused();
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
    const change = groups.filter({ hasText: "2 tasks here from your change" });
    await expect(change).toBeVisible({ timeout: SLOW_MS });
    await expect(change.locator("li[data-task]")).toHaveCount(2);
    await expect(groups.filter({ has: page.locator(`li[data-task="${one}"]`) })).toContainText(
      "1 task here from your change",
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
    await watchViolations(page);
    await signIn(page, world, `/s/${space}/trash`);
    await showsSpace(page, world.mira.name);
    const words = `Ask whether the deposit came back (${tag})`;
    // Words typed for a task of a newer copy of the space than the one open, such as before an
    // older backup was claimed: this copy does not have the task.
    const gone = `t_${"0".repeat(25)}${tag === "firefox" ? "1" : "2"}`;
    await page.evaluate(
      ([name, value]) => {
        localStorage.setItem(name, value);
      },
      [`${PRODUCT_ID}.draft.${space}.${gone}`, words] as const,
    );
    await page.reload();
    await showsSpace(page, world.mira.name);
    const unsent = page.locator('[data-part="unsent-words"]');
    await expect(unsent).toContainText(words, { timeout: SLOW_MS });
    await both(page, "trash-unsent");
    await unsent.getByRole("button", { name: "Discard" }).click();
    await expect(unsent).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A5.trash.e2e.unsent] Every unsent word of a removed task stays, and Discard takes one", () => {
  test("a note on its way and a newer draft, the task removed from another tab while the note waits: after a reload the Trash lists both, and Discard of one keeps the other", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const ref = await addTask(world, { title: `Answer the landlord (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const composer = rowOf(page, ref).locator('[data-part="composer"]');
    // The note's request waits until the task is gone from another tab.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    await page.route("**/api/v1/op/entry.add", async (route) => {
      reached = true;
      await released;
      await route.continue();
    });
    const note = `Ask about the deposit (${tag})`;
    const draft = `And the key handover (${tag})`;
    await composer.fill(note);
    await page.keyboard.press("Enter");
    await expect.poll(() => reached).toBe(true);
    await composer.fill(draft);
    const other = await page.context().newPage();
    await openTask(other, world, ref);
    await rowOf(other, ref).locator('[data-part="move-to-trash"]').click();
    await expect(rowOf(other, ref).locator('[data-part="in-trash"]')).toBeVisible({
      timeout: SLOW_MS,
    });
    await other.close();
    // The note reaches the service, which refuses it: the task is in the Trash.
    const answered = page.waitForResponse("**/api/v1/op/entry.add");
    release();
    expect((await answered).status()).toBeGreaterThanOrEqual(400);
    await page.unroute("**/api/v1/op/entry.add");

    await page.goto(`${world.origin}/s/${space}/trash`);
    await showsSpace(page, world.mira.name);
    const unsent = page.locator('[data-part="unsent-words"]');
    await expect(unsent.filter({ hasText: note })).toHaveAttribute("data-kind", "note", {
      timeout: SLOW_MS,
    });
    await expect(unsent.filter({ hasText: draft })).toHaveAttribute("data-kind", "draft");
    await expect(unsent.filter({ hasText: note })).toContainText(ref);
    await unsent.filter({ hasText: note }).getByRole("button", { name: "Discard" }).click();
    await expect(unsent.filter({ hasText: note })).toHaveCount(0);
    await page.reload();
    await expect(unsent.filter({ hasText: draft })).toBeVisible({ timeout: SLOW_MS });
  });

  test("the foot follows every tab: an edit another tab could not save appears in it while it is open, Discard takes only the value shown, and a finished task restored with all four kinds listed leaves it at once, its words on its card", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const title = `Return the rental van (${tag})`;
    const ref = await addTask(world, { title, area: "home" });
    const id = ((await world.op(space, "task.get", { task: ref })) as { task: { id: string } }).task
      .id;

    // Another tab: a priority and a note on their way, and a draft.
    const other = await page.context().newPage();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: string[] = [];
    await other.route(/\/api\/v1\/op\/(task\.update|entry\.add)$/u, async (route) => {
      held.push(route.request().url());
      await released;
      await route.continue();
    });
    await openTask(other, world, ref);
    const card = rowOf(other, ref);
    await card
      .getByRole("radiogroup", { name: "Priority" })
      .getByRole("radio", { name: "P1" })
      .click();
    const note = `Ask for the deposit back (${tag})`;
    const draft = `And the parking ticket (${tag})`;
    await card.locator('[data-part="composer"]').fill(note);
    await other.keyboard.press("Enter");
    await expect.poll(() => held.length).toBe(2);
    await card.locator('[data-part="composer"]').fill(draft);
    // A third tab types a title and goes away before saving it.
    const third = await page.context().newPage();
    await openTask(third, world, ref);
    await rowOf(third, ref).locator('[data-part="title"]').focus();
    await third.keyboard.press("F2");
    await third.keyboard.press("End");
    await third.keyboard.type(" on Monday");
    const typed = `${title} on Monday`;
    await third.goto("about:blank");
    await third.close();

    // Finished and then removed from elsewhere; this tab's foot is open before the edit is refused.
    const finished = (await world.op(space, "space.status", {})) as { as_of: string };
    await world.op(space, "task.finish", { task: ref, base: finished.as_of });
    await removeTasks(world, [ref]);
    await signIn(page, world, `/s/${space}/trash`);
    await showsSpace(page, world.mira.name);
    const unsent = page.locator('[data-part="unsent-words"]');
    await expect(unsent.filter({ hasText: typed })).toHaveAttribute("data-kind", "title", {
      timeout: SLOW_MS,
    });
    const refused = other.waitForResponse(/\/api\/v1\/op\/task\.update$/u);
    release();
    expect((await refused).status()).toBeGreaterThanOrEqual(400);
    await expect(unsent.filter({ hasText: "P1" })).toHaveAttribute("data-kind", "edit", {
      timeout: SLOW_MS,
    });
    await expect(unsent.filter({ hasText: note })).toHaveAttribute("data-kind", "note");
    await expect(unsent.filter({ hasText: draft })).toHaveAttribute("data-kind", "draft");
    await other.close();
    await both(page, "trash-unsent-all");

    // A newer draft is kept before this tab hears of it: Discard of the one shown leaves it.
    const newer = `${draft}, and the keys`;
    await page.evaluate(
      ([name, value]) => {
        localStorage.setItem(name, value);
      },
      [`${PRODUCT_ID}.draft.${space}.${id}`, newer] as const,
    );
    await unsent.filter({ hasText: draft }).getByRole("button", { name: "Discard" }).click();
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(unsent.filter({ hasText: newer })).toHaveAttribute("data-kind", "draft", {
      timeout: SLOW_MS,
    });
    await expect(unsent).toHaveCount(4);

    // Restored into Completed: the foot lets them go at once, and the card shows each.
    await rowOf(page, ref).locator('[data-part="restore"]').click();
    await expect(toast(page)).toContainText(`${ref} is back`, { timeout: SLOW_MS });
    await expect(unsent).toHaveCount(0);
    await page.goto(`${world.origin}/s/${space}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const back = rowOf(page, ref);
    await expect(back.locator('[data-part="composer"]')).toHaveValue(newer, { timeout: SLOW_MS });
    await expect(back.locator('[data-part="kept-note"]')).toContainText(note);
    await expect(back.locator('[data-part="kept-title"]')).toContainText(typed);
    await expect(back.locator('[data-part="unsaved"] [data-part="unsaved-value"]')).toHaveText(
      "P1",
    );
    await expect(back.locator('[data-part="unsaved"] [data-part="copy-mine"]')).toBeVisible();
    await back.locator('[data-part="kept-note"]').scrollIntoViewIfNeeded();
    await both(page, "kept-note");
  });
});

test.describe("[A5.trash.e2e.title] A title being typed stays through a removal, whichever comes first", () => {
  /** Opens the task's card and types after its title, unsent: the words the steps follow. */
  async function typeTitle(page: Page, world: World, ref: string, title: string): Promise<string> {
    await openTask(page, world, ref);
    await rowOf(page, ref).locator('[data-part="title"]').focus();
    await page.keyboard.press("F2");
    await expect(rowOf(page, ref).getByRole("textbox", { name: "Title" })).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" in May");
    return `${title} in May`;
  }

  test("the page leaves before the removal arrives, stays while it arrives, or leaves while its save is on its way: each time the words are at the foot of the Trash, also after one more reload, and back in the editor after Restore", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const add = (what: string) => addTask(world, { title: `${what} (${tag})`, area: "home" });
    const saves: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/op/task.update")) saves.push(request.url());
    });

    // The page leaves before the removal reaches it.
    const left = await add("Plan the move");
    const leftWords = await typeTitle(page, world, left, `Plan the move (${tag})`);
    await page.goto(`${world.origin}/s/${space}/trash`);
    await showsSpace(page, world.mira.name);
    await removeTasks(world, [left]);

    // The page stays while the removal reaches it: the editor goes, and nothing is sent.
    const stayed = await add("Paint the hall");
    const stayedWords = await typeTitle(page, world, stayed, `Paint the hall (${tag})`);
    await removeTasks(world, [stayed]);
    await expect(rowOf(page, stayed).getByRole("textbox", { name: "Title" })).toHaveCount(0, {
      timeout: SLOW_MS,
    });
    expect(saves).toEqual([]);

    // The page leaves while its save is on its way: no answer ever reaches it.
    const sending = await add("Sell the piano");
    const sendingWords = await typeTitle(page, world, sending, `Sell the piano (${tag})`);
    let reached = false;
    await page.route("**/api/v1/op/task.update", () => {
      reached = true;
    });
    await page.keyboard.press("Enter");
    await expect.poll(() => reached).toBe(true);
    await removeTasks(world, [sending]);
    await page.goto(`${world.origin}/s/${space}/trash`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await showsSpace(page, world.mira.name);

    const kept = page.locator('[data-part="unsent-words"][data-kind="title"]');
    const listed = async () => {
      for (const [ref, words] of [
        [left, leftWords],
        [stayed, stayedWords],
        [sending, sendingWords],
      ] as const) {
        await expect(kept.filter({ hasText: words })).toContainText(ref, { timeout: SLOW_MS });
      }
    };
    await listed();
    await page.reload();
    await showsSpace(page, world.mira.name);
    await listed();

    // Restored: the words come back in the title's editor, unsent, and leave the foot at once.
    await page.locator(`main li[data-task="${stayed}"] [data-part="restore"]`).click();
    await expect(kept.filter({ hasText: stayedWords })).toHaveCount(0, { timeout: SLOW_MS });
    // The card opens in its title's editor, so it is opened by its link, not by its title button.
    await page.goto(`${world.origin}/s/${space}/task/${stayed}`);
    await showsSpace(page, world.mira.name);
    await expect(rowOf(page, stayed).getByRole("textbox", { name: "Title" })).toHaveValue(
      stayedWords,
      { timeout: SLOW_MS },
    );
  });

  test("a save the service refuses because the task was removed meanwhile: the words are a kept edit then, listed once, never in no store", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const ref = await addTask(world, { title: `Fix the gate (${tag})`, area: "home" });
    const words = await typeTitle(page, world, ref, `Fix the gate (${tag})`);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    await page.route("**/api/v1/op/task.update", async (route) => {
      reached = true;
      await released;
      await route.continue();
    });
    await page.keyboard.press("Enter");
    await expect.poll(() => reached).toBe(true);
    await removeTasks(world, [ref]);
    const answered = page.waitForResponse("**/api/v1/op/task.update");
    release();
    expect((await answered).status()).toBeGreaterThanOrEqual(400);
    await page.unroute("**/api/v1/op/task.update");
    await page.goto(`${world.origin}/s/${space}/trash`);
    await showsSpace(page, world.mira.name);
    const unsent = page.locator('[data-part="unsent-words"]').filter({ hasText: words });
    await expect(unsent).toHaveAttribute("data-kind", "edit", { timeout: SLOW_MS });
    await expect(unsent).toHaveCount(1);
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
        // The worker's other tests leave tasks of their own in the Trash: these three are counted.
        await expect(
          shot.locator("main li[data-task]").filter({ hasText: "Screens: " }),
        ).toHaveCount(3, { timeout: SLOW_MS });
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
        // The theme is the machine's, shared by the worker's other tests: back to the default.
        await world.machine("ui.theme", null);
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
      .getByRole("button", { name: /^Stop .*'s run$/u });
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
    // Its question shows beneath its row as a live task's does; Restore, not Dismiss, is its way on.
    const asked = rowOf(page, removed).locator('[data-part="question"]');
    await expect(asked).toContainText(FAKE_QUESTION);
    await expect(asked.locator('[data-part="dismiss-question"]')).toHaveCount(0);
    await expect(
      rowOf(page, live).locator('[data-part="question"] [data-part="dismiss-question"]'),
    ).toBeVisible();
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
    await expect(rowOf(page, removed).locator('[data-part="dismiss-question"]')).toBeVisible();
  });
});

test.describe("[A5.trash.e2e.terminal] An agent in a terminal on a removed task stays in sight without the monitor", () => {
  test("an agent in a terminal on a task moved to the Trash, with no monitor: a cold Agents page lists the task once, saying the agent goes on until it is stopped in its terminal; it leaves once the agent ends @one-browser", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const ref = await addTask(world, { title: `Draft the newsletter (${tag})`, area: "home" });
    world.hold(ref);
    await openTask(page, world, ref);
    const row = rowOf(page, ref);
    await row
      .getByRole("toolbar", { name: "Act on this task" })
      .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
      .click();
    await expect(row.locator('[data-entry][data-state="running"]')).toBeVisible({
      timeout: SLOW_MS,
    });
    await removeTasks(world, [ref]);

    // A cold page: the launch's record is all that shows the agent.
    await page.goto(`${world.origin}/s/${space}/agents`);
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(rowOf(page, ref).locator('[data-part="agents-in-trash"]')).toHaveText(
      /^In the Trash\. Its agent in a terminal goes on until you stop it there/u,
      { timeout: SLOW_MS },
    );
    await expect(rowOf(page, ref)).toHaveCount(1);
    await both(page, "trash-agents-terminal");
    // The person quits the agent: its end is recorded, and the task leaves the page.
    world.release(ref);
    await expect(rowOf(page, ref)).toHaveCount(0, { timeout: SLOW_MS });
  });
});

/** The Trash's mark in the side menu: how many tasks agents moved there since it was open. */
const trashMark = (page: Page) => page.locator('nav [data-view="trash"] [data-mark]');

test.describe("[A5.trash.e2e.agents] What an agent moved to the Trash", () => {
  test("the side menu counts what agents moved to the Trash that it has not shown, also before it was ever opened; a restore takes tasks out of the count; an agent's removal is one change under its name with Restore these; in both themes at 1,440 and 390 px", async ({
    page,
    world,
  }) => {
    test.setTimeout(300_000);
    const tag = test.info().project.name;
    const space = world.mira.id;
    const agentRemoves = async (tasks: readonly string[]): Promise<string> => {
      const status = (await world.op(space, "space.status", {}, "agent")) as { as_of: string };
      const moved = (await world.op(
        space,
        "task.delete",
        { tasks, base: status.as_of },
        "agent",
      )) as {
        commit: string;
      };
      return moved.commit;
    };
    // The narrow menu is pictured at rest, not on its way in.
    await page.emulateMedia({ reducedMotion: "reduce" });

    // Asked to tidy before the person ever opened the page: the count shows it.
    const tidied = [
      await addTask(world, { title: `Agent tidy one (${tag})`, area: "home" }),
      await addTask(world, { title: `Agent tidy two (${tag})`, area: "home" }),
    ];
    const tidy = await agentRemoves(tidied);
    await signIn(page, world, `/s/${space}/open`);
    await showsSpace(page, world.mira.name);
    await expect(trashMark(page)).toHaveText("2", { timeout: SLOW_MS });
    // Restored elsewhere, here by the agent, the tasks leave the count.
    await world.op(space, "task.delete", { restore: true, change: tidy }, "agent");
    await expect(trashMark(page)).toHaveCount(0, { timeout: SLOW_MS });

    try {
      for (const theme of themes()) {
        await world.machine("ui.theme", theme);
        await agentRemoves([
          await addTask(world, { title: `Agent duplicate (${tag}, ${theme})`, area: "home" }),
          await addTask(world, { title: `Agent duplicate again (${tag}, ${theme})`, area: "home" }),
        ]);

        await page.goto(`${world.origin}/s/${space}/open`);
        await showsSpace(page, world.mira.name);
        await expect(trashMark(page)).toHaveText("2", { timeout: SLOW_MS });
        await expect(page.locator('nav [data-view="trash"]')).toHaveAttribute(
          "aria-label",
          "Trash, 2 tasks moved here by agents since you last looked",
        );
        await picture(page, `trash-mark-${theme}-1440.png`);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Menu" }).click();
        await expect(page.locator('[data-view="trash"] [data-mark]').last()).toHaveText("2");
        await picture(page, `trash-mark-${theme}-390.png`);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1440, height: 900 });

        await page.locator('nav [data-view="trash"]').click();
        const change = page
          .locator('main [role="group"]')
          .filter({ hasText: "2 tasks here from Agent's change" });
        await expect(change).toBeVisible({ timeout: SLOW_MS });
        await expect(trashMark(page)).toHaveCount(0);
        await both(page, `trash-agent-${theme}`);
        await page.locator('nav [data-view="open"]').click();
        await expect(trashMark(page)).toHaveCount(0);
        await page.locator('nav [data-view="trash"]').click();
        await change.getByRole("button", { name: "Restore these" }).click();
        await expect(toast(page)).toHaveText("2 tasks are back", { timeout: SLOW_MS });
        const open = page.locator('nav [data-view="open"]');
        await open.click();
        await expect(open).toHaveAttribute("aria-current", "page");
      }
    } finally {
      // The theme is the machine's, shared by the worker's other tests: back to the default.
      await world.machine("ui.theme", null);
    }

    // A removal that arrives while another tab shows the Trash is seen: this tab does not count
    // it, also after a reload. One made once no tab shows it is the only one counted.
    const other = await page.context().newPage();
    const late = await addTask(world, { title: `Agent late removal (${tag})`, area: "home" });
    const later = await addTask(world, { title: `Agent later removal (${tag})`, area: "home" });
    try {
      await other.goto(`${world.origin}/s/${space}/trash`);
      await showsSpace(other, world.mira.name);
      await agentRemoves([late]);
      await expect(rowOf(other, late)).toBeVisible({ timeout: SLOW_MS });
    } finally {
      await other.close();
    }
    await page.reload();
    await showsSpace(page, world.mira.name);
    await agentRemoves([later]);
    await expect(trashMark(page)).toHaveText("1", { timeout: SLOW_MS });
    const seen = (await world.op(space, "space.status", {}, "agent")) as { as_of: string };
    await world.op(
      space,
      "task.delete",
      { tasks: [late, later], restore: true, base: seen.as_of },
      "agent",
    );
    await expect(trashMark(page)).toHaveCount(0, { timeout: SLOW_MS });
  });
});

test.describe("[A5.trash.e2e.key] Delete on a focused row", () => {
  test("Delete moves the focused row's task to the Trash with Undo and focus goes to the next row; a held key moves one task; the key does nothing in the top field, the composer or the shortcut sheet", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const [first, second, third] = [
      await addTask(world, { title: `Key first (${tag})`, area: "home" }),
      await addTask(world, { title: `Key second (${tag})`, area: "home" }),
      await addTask(world, { title: `Key third (${tag})`, area: "home" }),
    ];
    await signIn(page, world, `/s/${space}/open`);
    await showsSpace(page, world.mira.name);
    const rows = page.locator("main li[data-task]");
    await expect(rowOf(page, first)).toBeVisible({ timeout: SLOW_MS });
    const titleOf = (ref: string) => rowOf(page, ref).locator('[data-part="title"]');
    const after = async (ref: string): Promise<string> => {
      const order = await rows.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-task") ?? ""),
      );
      return order[order.indexOf(ref) + 1] ?? "";
    };

    // The key on a row: the toast's Undo, and focus on the row below.
    const below = await after(second);
    await titleOf(second).focus();
    await page.keyboard.press("Delete");
    await expect(toast(page)).toHaveText(`Moved ${second} to the Trash`);
    await expect(titleOf(below)).toBeFocused();
    await expect(rowOf(page, second)).toHaveCount(0, { timeout: SLOW_MS });
    await toast(page).hover();
    await toastAction(page).click();
    await expect(rowOf(page, second)).toBeVisible({ timeout: SLOW_MS });

    // A held key moves one task: its repeats reach the next row and do nothing there.
    const next = await after(first);
    await titleOf(first).focus();
    await page.keyboard.down("Delete");
    await page.keyboard.down("Delete");
    await page.keyboard.down("Delete");
    await page.keyboard.up("Delete");
    await expect(toast(page)).toHaveText(`Moved ${first} to the Trash`);
    await expect(rowOf(page, first)).toHaveCount(0, { timeout: SLOW_MS });
    await expect(titleOf(next)).toBeFocused();
    await expect(rowOf(page, next)).toBeVisible();

    // In the top field, the composer and the sheet the key is theirs.
    await page.getByRole("textbox", { name: "New task" }).fill("Typed words");
    await page.keyboard.press("Delete");
    await titleOf(third).click();
    const composer = rowOf(page, third).locator('[data-part="composer"]');
    await composer.fill("A note");
    await composer.press("Home");
    await composer.press("Delete");
    await expect(composer).toHaveValue(" note");
    await titleOf(third).click();
    await titleOf(third).focus();
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet.getByRole("group", { name: "On a task" })).toContainText(
      "Move the task to the Trash",
    );
    await page.keyboard.press("Delete");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    // A last press on a row is the one change: the presses before it moved nothing, and the held
    // key's repeats did not move the row below the first.
    const last = next === third ? second : third;
    const kept = last === third ? second : third;
    await titleOf(last).focus();
    await page.keyboard.press("Delete");
    await expect(toast(page)).toHaveText(`Moved ${last} to the Trash`);
    await expect(rowOf(page, last)).toHaveCount(0, { timeout: SLOW_MS });
    await expect(rowOf(page, kept)).toBeVisible();
    await expect(rowOf(page, next)).toBeVisible();
  });
});
