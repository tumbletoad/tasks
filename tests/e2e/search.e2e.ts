// The top field's two modes end to end (A7 3.12 M5.10; A5 3.13), in Chromium and Firefox against
// the real service process with fixture data: a capture's shortcuts shown before it is saved and
// applied after, text that only looks like a shortcut kept as text, search results as one list
// with check-off and undo, a result that changes while the list is open, the keyboard through
// both modes, a space without the word index, and the screenshots in both themes at 1,440 and
// 390 px. Each test makes tasks with words of its own: the tests of one worker share its world.
import { expect, type Page } from "@playwright/test";
import { day, onOneDay } from "./days.ts";
import { test } from "./fixture.ts";
import { axeFound, picture, pictures, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const adding = (page: Page) => page.getByRole("textbox", { name: "New task" });
const searching = (page: Page) => page.getByRole("textbox", { name: "Search" });
const panel = (page: Page) => page.locator("#top-capture");
const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');
const group = (page: Page, name: string) => page.locator(`main section[aria-label="${name}"]`);
const titles = (page: Page, name: string) => group(page, name).locator('[data-part="title"]');

/** A word no other test uses, so each test's search finds only its own tasks. */
const wordOf = (stem: string) =>
  `${stem}${test.info().project.name}${String(test.info().workerIndex)}`.toLowerCase();

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

interface Digest {
  readonly as_of: string;
  readonly task: {
    readonly title: string;
    readonly priority: number;
    readonly due?: string;
    readonly area?: string;
    readonly project?: string;
    readonly focus: boolean;
    readonly status: string;
    readonly waiting_on?: string;
    readonly inbox: boolean;
  };
}

async function addTasks(
  world: World,
  drafts: Record<string, unknown>[],
  as: "user" | "agent" = "user",
): Promise<string[]> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: drafts }, as)) as Added;
  return added.tasks.map((task) => task.ref);
}

const read = async (world: World, ref: string): Promise<Digest> =>
  (await world.op(world.mira.id, "task.get", { task: ref })) as Digest;

/** The one task whose title is exactly `title`, found through the service's search. */
async function taskTitled(world: World, word: string, title: string): Promise<Digest["task"]> {
  const found = (await world.op(world.mira.id, "task.search", { q: word, scope: "all" })) as {
    rows: { ref: string; title: string }[];
  };
  const row = found.rows.find((r) => r.title === title);
  if (row === undefined) throw new Error(`no task is titled ${title}`);
  return (await read(world, row.ref)).task;
}

async function open(page: Page, world: World, path: string): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}${path}`);
  await showsSpace(page, world.mira.name);
}

/** A search's own URL, as a reload or a link opens it: the sign-in's route holds no query. */
async function openSearch(page: Page, world: World, q: string): Promise<void> {
  await open(page, world, "/today");
  await page.goto(`${world.origin}/s/${world.mira.id}/search?q=${encodeURIComponent(q)}`);
  await showsSpace(page, world.mira.name);
}

test.describe("[A7.3.12.m5-10.e2e.capture] A capture shows its shortcuts before it is saved, and lands where they say", () => {
  test("date, priority, area/project and star show as chips; a kept one stays text; Enter adds and never searches", async ({
    page,
    world,
  }) => {
    await onOneDay(async (today, attempt) => {
      // Tomorrow is the page's tomorrow when Enter adds it: one day, so the step runs on one.
      // Each attempt adds a task of its own.
      const word = `${wordOf("larkspur")}${String(attempt)}`;
      await open(page, world, "/inbox");
      const field = adding(page);
      await expect(field).toBeEnabled();
      await field.fill(`Order the ${word} paint tomorrow p2 #home/garden *`);
      const chips = panel(page).getByRole("listitem");
      await expect(chips).toHaveText([/^Due /, "P2", "Home › Garden", "Starred"]);
      await expect(panel(page)).toContainText(`Title: Order the ${word} paint`);

      // The person keeps "p2" as text: it goes back into the title, and the field keeps focus.
      await panel(page).getByRole("button", { name: "Keep p2 as text" }).click();
      await expect(chips).toHaveText([/^Due /, "Home › Garden", "Starred"]);
      await expect(panel(page)).toContainText(`Title: Order the ${word} paint p2`);
      await expect(field).toBeFocused();

      await field.press("Enter");
      await expect(toast(page)).toHaveText("Added to Home › Garden");
      await expect(field).toHaveValue("");
      // Enter in the add mode never searched.
      await expect(page).toHaveURL(new RegExp(`/s/${world.mira.id}/inbox$`));
      const task = await taskTitled(world, word, `Order the ${word} paint p2`);
      expect(task).toMatchObject({
        priority: 4,
        due: day(1, today.start).iso,
        area: "Home",
        project: "Garden",
        focus: true,
      });
    });
  });

  test("text that only looks like a shortcut, and markup, stay text; @person waits on them", async ({
    page,
    world,
  }) => {
    const word = wordOf("tansy");
    await open(page, world, "/inbox");
    const field = adding(page);
    const title = `Close #3 by 10:30 for mail@ana.example <b>${word}</b> p10`;
    await field.fill(title);
    // Nothing became a shortcut: no panel, the title is the text.
    await expect(panel(page)).toHaveCount(0);
    await field.press("Enter");
    await expect(page.locator('main [data-part="title"]', { hasText: title })).toHaveCount(1, {
      timeout: SLOW_MS,
    });
    await expect(page.locator("main b")).toHaveCount(0);

    await field.fill(`Signed lease ${word} @Ana`);
    await expect(panel(page).getByRole("listitem")).toHaveText(["Waiting on Ana"]);
    await field.press("Enter");
    await expect(toast(page)).toHaveText("Added to Waiting");
    expect(await taskTitled(world, word, `Signed lease ${word}`)).toMatchObject({
      status: "waiting",
      waiting_on: "Ana",
      inbox: false,
    });
  });

  test("in an area's view a capture lands there, unless the person turns that off", async ({
    page,
    world,
  }) => {
    const word = wordOf("yarrow");
    await open(page, world, "/today");
    await page
      .getByRole("navigation")
      .getByRole("link", { name: /^Home, / })
      .click();
    const field = adding(page);
    await field.fill(`Rake the ${word} leaves`);
    await expect(panel(page).getByRole("listitem")).toHaveText(["Home"]);
    await field.press("Enter");
    await expect(toast(page)).toHaveText("Added to Home");
    expect(await taskTitled(world, word, `Rake the ${word} leaves`)).toMatchObject({
      area: "Home",
    });

    await field.fill(`Sweep the ${word} path`);
    await panel(page).getByRole("button", { name: "Do not put it in Home" }).click();
    await expect(panel(page).getByRole("listitem")).toHaveText(["Inbox"]);
    await field.press("Enter");
    await expect(toast(page)).toHaveText("Added to Inbox");
    expect(await taskTitled(world, word, `Sweep the ${word} path`)).toMatchObject({ inbox: true });
  });
});

test.describe("[A7.3.12.m5-10.e2e.search] Search results are a list like any other, and leaving keeps the draft", () => {
  test("/ searches, results expand and check off with undo and stay put, Escape returns with the draft", async ({
    page,
    world,
  }) => {
    const word = wordOf("quince");
    const [first] = await addTasks(world, [
      { title: `Prune the ${word} tree`, area: "home", priority: 1 },
      { title: `Pick ${word} jam jars`, area: "home", priority: 2 },
    ]);
    await open(page, world, "/today");
    await adding(page).fill("A draft kept while searching");
    await adding(page).blur();
    await page.keyboard.press("/");
    await expect(searching(page)).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/s/${world.mira.id}/search$`));
    await expect(page.locator("main")).toContainText("Type words or filters");

    await searching(page).fill(word);
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${word}$`));
    await expect(titles(page, "To do")).toHaveCount(2);

    // Expanding a result puts it in the URL, as in any view.
    const row = page.locator(`main li[data-task="${first ?? ""}"]`);
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
    await expect(page).toHaveURL(new RegExp(`q=${word}&task=${first ?? ""}$`));
    await row.locator('[data-part="title"]').click();

    // Check-off through the one edit path: the toast's Undo; the row stays, checked, after its hold.
    await row.locator('[data-part="check"]').click();
    await expect(toast(page)).toHaveText("Done");
    await expect(toastAction(page)).toHaveText("Undo");
    await expect(page.getByRole("status").filter({ hasText: "Results changed." })).toBeVisible();
    await expect(row).toHaveAttribute("data-leaving", "hold");
    await expect(row).not.toHaveAttribute("data-leaving", /./, { timeout: SLOW_MS });
    await expect(row.locator('[data-part="check"]')).toBeChecked();
    await expect(titles(page, "To do")).toHaveCount(2);
    await page.keyboard.press("Control+z");
    await expect(row.locator('[data-part="check"]')).not.toBeChecked({ timeout: SLOW_MS });

    // Escape leaves the search for where the person was, with the draft as it was.
    await searching(page).click();
    await searching(page).press("Escape");
    await expect(page).toHaveURL(new RegExp(`/s/${world.mira.id}/today$`));
    await expect(adding(page)).toHaveValue("A draft kept while searching");
    await expect(adding(page)).toBeFocused();
  });

  test("finished tasks are their own group; a search with words offers to add it as a task instead", async ({
    page,
    world,
  }) => {
    const word = wordOf("sorrel");
    const [done, , dropped] = await addTasks(world, [
      { title: `Sow ${word} seeds`, area: "home", summary: "In trays first." },
      { title: `Cut ${word} for soup`, area: "home" },
      { title: `Dry ${word} leaves`, area: "home", summary: "On the rack." },
    ]);
    await world.op(world.mira.id, "task.finish", {
      task: done,
      outcome: "Sown in the cold frame.\nThe rest of the outcome.",
      base: (await read(world, done ?? "")).as_of,
    });
    await world.op(world.mira.id, "task.finish", {
      task: dropped,
      status: "dropped",
      outcome: "Too damp to dry this year.",
      base: (await read(world, dropped ?? "")).as_of,
    });
    await openSearch(page, world, word);
    await expect(searching(page)).toHaveValue(word);
    await expect(titles(page, "To do")).toHaveText([`Cut ${word} for soup`]);
    await expect(titles(page, "Completed")).toHaveCount(2);
    // A finished task says how it ended where the summary goes, as in Completed.
    const ending = (id: string | undefined) =>
      page.locator(`main li[data-task="${id ?? ""}"] [data-part="ending"] > [dir]`);
    await expect(ending(done)).toHaveText("Sown in the cold frame.");
    await expect(ending(dropped)).toHaveText("Too damp to dry this year.");
    // Their date column says when and how each ended, as in Completed.
    const endedOn = (id: string | undefined) =>
      page.locator(`main li[data-task="${id ?? ""}"] [data-part="row-due"]`);
    await expect(endedOn(done)).toHaveAttribute("data-tip", /^Completed /u);
    await expect(endedOn(dropped)).toHaveAttribute("data-tip", /^Dropped /u);
    // Their summaries do not show beside it.
    await expect(page.locator(`main li[data-task="${done ?? ""}"]`)).not.toContainText("In trays");
    await expect(page.locator(`main li[data-task="${dropped ?? ""}"]`)).not.toContainText("rack");

    // The offer shows before the search answers, and the answer does not move it from under the
    // pointer.
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await page.route("**/api/v1/op/task.search", async (route) => {
      await answered;
      await route.continue().catch(() => undefined);
    });
    await searching(page).fill(`${word} pesto p1 status:open sort:effort`);
    const add = page.getByRole("button", { name: `Add “${word} pesto p1” as a task` });
    await expect(add).toBeVisible();
    const offered = await add.boundingBox();
    answer();
    await expect(page.locator("main")).toContainText("Nothing matches.");
    expect(await add.boundingBox()).toEqual(offered);
    // Only the words go into the new task: the search's filters and its sort stay behind.
    await add.click();
    await expect(adding(page)).toHaveValue(`${word} pesto p1`);
    await expect(adding(page)).toBeFocused();
    await expect(panel(page).getByRole("listitem")).toHaveText(["P1"]);
  });
});

test.describe("[A7.3.12.e2e.effort-sort] A search sorted by effort shows quick work first, one group per effort", () => {
  test("sort:effort groups To do by the scale's order, tasks without an effort last; sort:-effort turns it round", async ({
    page,
    world,
  }) => {
    const word = wordOf("bramble");
    await addTasks(world, [
      { title: `Rebuild the ${word} shed`, area: "home", effort: "L" },
      { title: `Oil the ${word} gate`, area: "home", effort: "S" },
      { title: `Think about ${word} paths`, area: "home" },
      { title: `Paint the ${word} fence`, area: "home", effort: "M" },
    ]);
    await openSearch(page, world, `${word} sort:effort`);
    const headings = page.locator("main section[aria-label]");
    await expect(headings).toHaveCount(4);
    expect(
      await headings.evaluateAll((all) => all.map((s) => s.getAttribute("aria-label"))),
    ).toEqual(["Effort S", "Effort M", "Effort L", "No effort set"]);
    await expect(titles(page, "Effort S")).toHaveText([`Oil the ${word} gate`]);
    await expect(titles(page, "No effort set")).toHaveText([`Think about ${word} paths`]);
    await picture(page, "search-effort-1440.png");

    await searching(page).fill(`${word} sort:-effort`);
    await expect(headings.first()).toHaveAttribute("aria-label", "Effort L");
    await expect(headings.last()).toHaveAttribute("aria-label", "No effort set");
  });
});

test.describe("[A7.3.12.m5-10.e2e.changes] A result that changes while the list is open stays put and offers a refresh", () => {
  test("a new match and a task that stops matching show only after Refresh; an edit shows in place", async ({
    page,
    world,
  }) => {
    const word = wordOf("medlar");
    const [kept, leaving] = await addTasks(world, [
      { title: `Prune the ${word} hedge`, area: "home" },
      { title: `Net the ${word} fruit`, area: "home" },
    ]);
    await openSearch(page, world, word);
    await expect(titles(page, "To do")).toHaveCount(2);
    const changed = page.getByRole("status").filter({ hasText: "Results changed." });
    await expect(changed).toHaveCount(0);
    const shownBefore = await titles(page, "To do").allTextContents();
    const keptRow = page.locator(`main li[data-task="${kept ?? ""}"]`);
    const keptAt = (await keptRow.boundingBox())?.y;

    // An agent adds a match and retitles another so it no longer matches.
    await addTasks(world, [{ title: `Order ${word} saplings`, area: "home" }], "agent");
    const { as_of } = await read(world, leaving ?? "");
    await world.op(
      world.mira.id,
      "task.update",
      { task: leaving, set: { title: "Net the plum fruit" }, base: as_of },
      "agent",
    );
    await expect(changed).toBeVisible();
    // Nothing jumped in or out or moved: the retitled row shows its new title where it was.
    await expect(titles(page, "To do")).toHaveText(
      shownBefore.map((title) =>
        title === `Net the ${word} fruit` ? "Net the plum fruit" : title,
      ),
    );
    expect((await keptRow.boundingBox())?.y).toBe(keptAt);

    await changed.getByRole("button", { name: "Refresh" }).click();
    // The service's ranking decides the order; which tasks show is what the refresh changes.
    await expect
      .poll(async () => (await titles(page, "To do").allTextContents()).sort(), {
        timeout: SLOW_MS,
      })
      .toEqual([`Order ${word} saplings`, `Prune the ${word} hedge`].sort());
    await expect(changed).toHaveCount(0);
  });
});

test.describe("[A7.3.12.e2e.equals-filter] A filter written with = is read as the service reads it", () => {
  test("p=3 is a filter: a change of priority offers a refresh, and Add takes only the words", async ({
    page,
    world,
  }) => {
    const word = wordOf("quince");
    const [moved] = await addTasks(world, [
      { title: `Water the ${word} pots`, area: "home", priority: 3 },
      { title: `Feed the ${word} pots`, area: "home", priority: 3 },
    ]);
    await openSearch(page, world, `${word} p=3`);
    await expect(titles(page, "To do")).toHaveCount(2);
    await expect(page.getByRole("button", { name: `Add “${word}” as a task` })).toBeVisible();
    const changed = page.getByRole("status").filter({ hasText: "Results changed." });
    await expect(changed).toHaveCount(0);
    const { as_of } = await read(world, moved ?? "");
    await world.op(
      world.mira.id,
      "task.update",
      { task: moved, set: { priority: 2 }, base: as_of },
      "agent",
    );
    await expect(changed).toBeVisible({ timeout: SLOW_MS });
  });
});

test.describe("[A5.3.13.e2e.search-now] A search result changes the task as it shows it", () => {
  test("a checked-off result someone dropped while the page heard nothing: its card says it is read again and offers nothing, then shows Dropped", async ({
    page,
    world,
  }) => {
    const word = wordOf("ledger");
    const [ref] = await addTasks(world, [{ title: `Close the ${word} ledger`, inbox: true }]);
    if (ref === undefined) throw new Error("the task was not added");
    await world.op(world.mira.id, "task.finish", {
      task: ref,
      base: (await read(world, ref)).as_of,
    });
    // The page's feed through the test: while it is deaf, the page hears no change.
    let deaf = false;
    await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        const type = (JSON.parse(String(message)) as { type?: unknown }).type;
        if (!(deaf && type === "batch")) ws.send(message);
      });
    });
    /** A change the page hears after what it missed: it asks for a fresh snapshot. */
    const heardAgain = async (n: number) => {
      deaf = false;
      await addTasks(world, [{ title: `Sweep the porch ${String(n)}`, inbox: true }]);
    };
    await openSearch(page, world, word);
    const row = page.locator(`main li[data-task="${ref}"]`);
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="lifecycle"]')).toHaveText("Checked off");

    deaf = true;
    const reopened = (await world.op(
      world.mira.id,
      "task.reopen",
      { task: ref, base: (await read(world, ref)).as_of },
      "agent",
    )) as { as_of: string };
    await world.op(
      world.mira.id,
      "task.finish",
      { task: ref, status: "dropped", outcome: "Not needed.", base: reopened.as_of },
      "agent",
    );
    // The page's read of the task waits, then fails once.
    let answer: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let failing = true;
    await page.route("**/api/v1/op/task.get", async (route) => {
      await waiting;
      if (failing) await route.abort();
      else await route.continue();
    });
    await heardAgain(1);
    const unresolved = row.locator('[data-part="unresolved"]');
    await expect(unresolved).toHaveText(
      "This task changed while the page was away. Reading it again.",
      { timeout: SLOW_MS },
    );
    await expect(row.locator('[data-part="reopen"]')).toBeHidden();
    await expect(row.locator('[data-part="check"]')).toBeDisabled();
    await picture(page, "search-reading-again-1440.png");
    await page.setViewportSize({ width: 390, height: 900 });
    await picture(page, "search-reading-again-390.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    answer();
    await expect(unresolved).toContainText("could not be read again", { timeout: SLOW_MS });
    await expect(row.locator('[data-part="reopen"]')).toBeHidden();
    await picture(page, "search-read-failed-1440.png");
    await page.setViewportSize({ width: 390, height: 900 });
    await picture(page, "search-read-failed-390.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // The next fresh snapshot reads it again: the result shows it dropped, in its place.
    failing = false;
    deaf = true;
    await addTasks(world, [{ title: "Sweep the porch 2", inbox: true }]);
    await heardAgain(3);
    await expect(unresolved).toHaveCount(0, { timeout: SLOW_MS });
    await expect(row.locator('[data-part="lifecycle"]')).toHaveText("Dropped");
    await expect(row.locator('[data-part="reopen"]')).toBeVisible();
    // Nothing the stale card offered went out: the task is as the other person left it.
    expect((await read(world, ref)).task).toMatchObject({ lifecycle: "archived" });
    await picture(page, "search-dropped-1440.png");
    await page.setViewportSize({ width: 390, height: 900 });
    await picture(page, "search-dropped-390.png");
  });
});

test.describe("[A7.3.12.m5-10.e2e.keyboard] Both modes by keyboard alone", () => {
  test("/ and typing, Enter to the first result, arrows and Enter in the list, / back, Escape out; the lens carries the draft", async ({
    page,
    world,
  }) => {
    const word = wordOf("loquat");
    await addTasks(world, [
      { title: `Wrap the ${word} crates`, area: "home", priority: 1 },
      { title: `Label ${word} preserves`, area: "home", priority: 2 },
    ]);
    await open(page, world, "/today");
    await page.keyboard.press("/");
    await expect(searching(page)).toBeFocused();
    await page.keyboard.type(word);
    const shown = titles(page, "To do");
    await expect(shown).toHaveCount(2);
    await page.keyboard.press("Enter");
    await expect(shown.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(shown.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(shown.nth(1)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(shown.nth(1)).toHaveAttribute("aria-expanded", "false");
    await expect(shown.nth(1)).toBeFocused();
    await page.keyboard.press("/");
    await expect(searching(page)).toBeFocused();
    await expect(searching(page)).toHaveValue(word);
    // Enter straight after typing a new search reaches that search's first result, not the
    // previous one's.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`${word} preserves`);
    await page.keyboard.press("Enter");
    await expect(shown).toHaveText([`Label ${word} preserves`]);
    await expect(shown.first()).toBeFocused();
    await page.keyboard.press("/");
    await expect(searching(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/s/${world.mira.id}/today$`));
    await expect(adding(page)).toBeFocused();

    // The lens switches with the draft as the search; the plus switches back with the draft kept.
    await page.keyboard.type(`Wrap the ${word}`);
    await page.getByRole("button", { name: "Search instead" }).click();
    await expect(searching(page)).toHaveValue(`Wrap the ${word}`);
    await expect(shown).toHaveText([`Wrap the ${word} crates`]);
    await page.getByRole("button", { name: "Add a task instead" }).first().click();
    await expect(adding(page)).toHaveValue(`Wrap the ${word}`);
    await expect(adding(page)).toBeFocused();

    // The area type-ahead: Tab takes the first suggestion.
    await adding(page).fill(`Stack ${word} #ho`);
    await expect(panel(page).getByRole("group", { name: "Areas and projects" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(adding(page)).toHaveValue(`Stack ${word} #home `);
    await expect(panel(page).getByRole("listitem")).toHaveText(["Home"]);
  });
});

test.describe("[A7.3.12.m5-10.e2e.unindexed] A space without the word index says so and still filters", () => {
  test("words are left out with a plain line, and the filters' matches show", async ({
    page,
    world,
  }) => {
    const word = wordOf("rowan");
    await addTasks(world, [{ title: `Mulch the ${word} bed`, area: "home", priority: 1 }]);
    // The service answers as it does for a space at a schema before the word index.
    await page.route("**/api/v1/op/task.search", async (route) => {
      const body = route.request().postDataJSON() as { q?: string };
      if (body.q !== undefined && body.q.includes(word)) {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: "space_unavailable",
              message: "This space has no word index.",
              data: { reason: "not_indexed", retryable: false },
            },
          },
        });
        return;
      }
      await route.continue();
    });
    await openSearch(page, world, `${word} p<=1 area:home`);
    await expect(page.getByRole("status").filter({ hasText: "no word index yet" })).toHaveText(
      "This space has no word index yet, so the words were left out: these are the tasks that match p<=1 area:home.",
    );
    await expect(titles(page, "To do").filter({ hasText: `Mulch the ${word} bed` })).toHaveCount(1);

    await searching(page).fill(word);
    await expect(page.getByRole("status").filter({ hasText: "no word index yet" })).toHaveText(
      "This space has no word index yet, so words cannot be searched here. Filters such as status:open or p<=2 still work.",
    );
  });
});

test.describe("[A7.3.12.m5-10.e2e.screens] The capture and the search in both themes: screenshots and axe", () => {
  test("Sumi and Washi at 1,440 px and 390 px, the capture's chips and the results with a refresh, axe clean", async ({
    browser,
    world,
  }) => {
    const word = wordOf("damson");
    await addTasks(world, [
      {
        title: `Bottle the ${word} gin`,
        area: "home",
        project: "garden",
        priority: 1,
        due: day(2).iso,
      },
      {
        title: `Ask about ${word} rootstock`,
        area: "lumen",
        status: "waiting",
        waiting_on: "Ana Reyes",
        inbox: false,
      },
      { title: `Plant ${word} whips`, area: "home", priority: 3 },
    ]);
    // A finished match, so the results show the Completed group and how its task ended.
    const [picked] = await addTasks(world, [
      { title: `Pick the ${word} crop`, area: "home", summary: "Before the first frost." },
    ]);
    await world.op(world.mira.id, "task.finish", {
      task: picked,
      outcome: "Eleven kilos, most of it for jam.",
      base: (await read(world, picked ?? "")).as_of,
    });
    for (const theme of themes()) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await world.machine("ui.theme", theme);
        await open(page, world, "/today");
        await adding(page).fill(`Order ${word} netting by fri p1 #home/garden * @Jonas`);
        await expect(panel(page).getByRole("listitem")).toHaveCount(5);
        await picture(page, `capture-${theme}-1440.png`);
        // The bar with the capture's panel, and the results: the page has no heading by design.
        if (pictures()) {
          expect(
            await axeFound(page, ["header", "main"]),
            `axe on the capture in ${theme}`,
          ).toEqual([]);
        }
        await page.setViewportSize({ width: 390, height: 900 });
        await picture(page, `capture-${theme}-390.png`);
        await expectNoSideScroll(page);

        await page.setViewportSize({ width: 1440, height: 900 });
        await adding(page).fill("");
        await adding(page).blur();
        await page.keyboard.press("/");
        await page.keyboard.type(word);
        // Three tasks, and the one the first theme's run added.
        await expect(titles(page, "To do")).toHaveCount(theme === "sumi" ? 3 : 4);
        // An agent's new match: the line that offers a refresh.
        await addTasks(
          world,
          [{ title: `Net the ${word} tree (${theme})`, area: "home" }],
          "agent",
        );
        await expect(
          page.getByRole("status").filter({ hasText: "Results changed." }),
        ).toBeVisible();
        await picture(page, `search-${theme}-1440.png`);
        if (pictures()) {
          expect(
            await axeFound(page, ["header", "main"]),
            `axe on the results in ${theme}`,
          ).toEqual([]);
        }
        await page.setViewportSize({ width: 390, height: 900 });
        await picture(page, `search-${theme}-390.png`, { fullPage: true });
        await expectNoSideScroll(page);
      } finally {
        await context.close();
      }
    }
    // The tests of a worker share its service: the theme goes back to its default.
    await world.machine("ui.theme", null);
  });
});

async function expectNoSideScroll(page: Page): Promise<void> {
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scroll, "horizontal scroll").toBeLessThanOrEqual(0);
}
