// Field editing, check-off, the toast, undo and redo end to end (A7 3.12 M5.08; A5 3.11, 3.12,
// 3.15 item 9), in Chromium and Firefox against the real service process with fixture data.
//
// Verify line: by keyboard alone, edit due, priority and effort, check off, undo, redo; an
// agent-only field starts a composer request. Also: "Restore mine" when an agent changed the field
// since the person's edit, "Apply mine" when it changed while the person's editor was open, axe in
// both themes with the date popover and a toast open, and the screenshots at 1,440 and 390 px.
// Dates are relative to the day the test runs, as the service's are.
import { expect, type Locator, type Page } from "@playwright/test";
import { day, onOneDay } from "./days.ts";
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

interface Digest {
  readonly as_of: string;
  readonly task: {
    readonly lifecycle: string;
    readonly priority: number;
    readonly effort?: string;
    readonly due?: string;
  };
}

async function addTasks(world: World, drafts: Record<string, unknown>[]): Promise<string[]> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: drafts })) as Added;
  return added.tasks.map((task) => task.ref);
}

const read = async (world: World, ref: string): Promise<Digest> =>
  (await world.op(world.mira.id, "task.get", { task: ref })) as Digest;

/** An agent's edit, with the base of a fresh read: it changes what the person sees. */
async function agentSets(world: World, ref: string, set: Record<string, unknown>): Promise<void> {
  const { as_of } = await read(world, ref);
  await world.op(world.mira.id, "task.update", { task: ref, set, base: as_of }, "agent");
}

/** Stops the page's clock, installed before, where it is now: its timers wait for `resume`. */
async function stopClock(page: Page): Promise<void> {
  for (;;) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 1);
      return;
    } catch (error) {
      // The clock moved on between the read and the pause: read it again.
      if (!String(error).includes("past")) throw error;
    }
  }
}

const rowOf = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);
const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');

/** Presses Tab until focus is in `target`, at most `max` times. */
async function tabInto(page: Page, target: Locator, max = 30): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((e) => e.contains(document.activeElement))) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached the control");
}

async function openArea(page: Page, world: World, name: string): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}/today`);
  await showsSpace(page, world.mira.name);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: new RegExp(`^${name}, `) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/s/${world.mira.id}/area/[a-z0-9_]+$`));
}

test.describe("[A7.3.12.m5-08.e2e.flow] Edit due, priority and effort, check off, undo and redo, by keyboard alone", () => {
  test("the facts change at once and hold, the check-off holds then leaves, Ctrl+Z, F6 and Ctrl+Shift+Z", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const [ref, next] = await addTasks(world, [
      { title: `Order the bookshelf (${tag})`, area: "home" },
      { title: `Return the drill (${tag})`, area: "home" },
    ]);
    if (ref === undefined || next === undefined) throw new Error("the tasks were not added");
    await watchViolations(page);
    await openArea(page, world, "Home");
    const row = rowOf(page, ref);
    const title = row.locator('[data-part="title"]');
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(title).toHaveAttribute("aria-expanded", "true");
    const body = row.locator('[data-part="expanded"]');

    // Empty facts are empty controls: no priority, no effort, no date.
    const priority = body.getByRole("radiogroup", { name: "Priority" });
    const effort = body.getByRole("radiogroup", { name: "Effort" });
    await expect(priority.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(effort.getByRole("radio", { checked: true })).toHaveCount(0);
    const due = body.locator('[data-part="due"]');
    await expect(due).toHaveText("No date");

    // Priority: Tab into the group, the arrows move, Space chooses. It shows at once.
    await tabInto(page, priority);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(priority.getByRole("radio", { name: "P2" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(toast(page)).toHaveText("Priority set to P2");

    // Effort: L.
    await tabInto(page, effort);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(effort.getByRole("radio", { name: "L" })).toHaveAttribute("aria-checked", "true");

    // Due: the pill opens the popover with its field focused; "+3d" previews, Enter applies, and
    // focus comes back to the pill.
    await onOneDay(async (today) => {
      await tabInto(page, due);
      await page.keyboard.press("Enter");
      const field = page.locator('[data-part="due-field"]');
      await expect(field).toBeFocused();
      await page.keyboard.type("nonsense");
      await expect(page.locator('[data-part="due-preview"]')).toHaveText("Not a date");
      await page.keyboard.press("Enter");
      await expect(field).toBeVisible();
      await field.fill("+3d");
      await expect(page.locator('[data-part="due-preview"]')).not.toHaveText("Not a date");
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
      await expect(due).toBeFocused();
      await expect(due).not.toHaveText("No date");
      // The service has all three, the date three days from today.
      await expect
        .poll(async () => {
          const { task } = await read(world, ref);
          return [task.priority, task.effort, task.due];
        })
        .toEqual([2, "L", day(3, today.start).iso]);
    });
    // And a reload shows them.
    await page.reload();
    await expect(priority.getByRole("radio", { name: "P2" })).toHaveAttribute(
      "aria-checked",
      "true",
      { timeout: SLOW_MS },
    );
    await expect(effort.getByRole("radio", { name: "L" })).toHaveAttribute("aria-checked", "true");
    // Collapsed again: an expanded card stays where it is until it is collapsed (A5 3.15).
    await title.focus();
    await page.keyboard.press("Escape");
    await expect(title).toHaveAttribute("aria-expanded", "false");

    // Check off by keyboard: the box fills, the title strikes through, the row stays for the hold,
    // focus moves on to the next row, and the toast offers Undo.
    await title.focus();
    await page.keyboard.press("Shift+Tab");
    const check = row.locator('[data-part="check"]');
    await expect(check).toBeFocused();
    await page.keyboard.press("Space");
    await expect(check).toBeChecked();
    await expect(row).toHaveAttribute("data-done", "true");
    await expect(toast(page)).toHaveText("Done");
    await expect(toastAction(page)).toHaveText("Undo");
    await expect(row.locator('[data-part="title"]')).not.toBeFocused();
    await expect(page.locator("[data-list] [data-part='title']:focus")).toHaveCount(1);
    await expect.poll(async () => (await read(world, ref)).task.lifecycle).toBe("completed");
    await expect(row).toBeVisible();

    // F6 reaches the toast's Undo at once: the row is open again where it was, and leaves no trace.
    await page.keyboard.press("F6");
    await expect(toastAction(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText("Undone");
    await expect(toastAction(page)).toHaveText("Redo");
    await expect(check).not.toBeChecked();
    await expect.poll(async () => (await read(world, ref)).task.lifecycle).toBe("active");
    await expect(row).not.toHaveAttribute("data-done", "true");
    // Focus went back to where F6 took it from.
    await expect(page.locator("[data-list] [data-part='title']:focus")).toHaveCount(1);

    // Ctrl+Shift+Z redoes it; after the hold the row leaves the view.
    await page.keyboard.press("Control+Shift+z");
    await expect(toast(page)).toHaveText("Redone");
    await expect.poll(async () => (await read(world, ref)).task.lifecycle).toBe("completed");
    await expect(rowOf(page, ref)).toHaveCount(0, { timeout: SLOW_MS });

    // Ctrl+Z undoes it again: the row comes back.
    await page.keyboard.press("Control+z");
    await expect(rowOf(page, ref)).toBeVisible({ timeout: SLOW_MS });
    await expect.poll(async () => (await read(world, ref)).task.lifecycle).toBe("active");
    // Checking off the next row and clicking its box again during the hold undoes it too.
    const other = rowOf(page, next);
    await other.locator('[data-part="check"]').click();
    await expect(other).toHaveAttribute("data-done", "true");
    await other.locator('[data-part="check"]').click();
    await expect(other.locator('[data-part="check"]')).not.toBeChecked();
    await expect.poll(async () => (await read(world, next)).task.lifecycle).toBe("active");
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A7.3.12.m5-08.e2e.conflict] Restore mine and Apply mine: an agent changed the same field", () => {
  test("undo after an agent's change offers Restore mine; an edit over a change made while the popover was open offers Apply mine", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const first = day(5).iso;
    const [ref] = await addTasks(world, [
      { title: `Renew the parking permit (${tag})`, area: "home", due: first },
    ]);
    if (ref === undefined) throw new Error("the task was not added");
    await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const row = rowOf(page, ref);
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
      timeout: SLOW_MS,
    });
    const body = row.locator('[data-part="expanded"]');
    const due = body.locator('[data-part="due"]');

    // The person sets tomorrow; then an agent sets another day.
    await onOneDay(async (today) => {
      await due.click();
      await page.getByRole("button", { name: "Tomorrow" }).click();
      await expect
        .poll(async () => (await read(world, ref)).task.due)
        .toBe(day(1, today.start).iso);
    });
    const agents = day(10).iso;
    await agentSets(world, ref, { due: agents });
    await expect.poll(async () => (await read(world, ref)).task.due).toBe(agents);

    // Undo: the field is the agent's now, so nothing is overwritten unseen. The toast says who.
    await page.locator("main").focus();
    await page.keyboard.press("Control+z");
    await expect(toast(page)).toContainText("changed the due date at");
    await expect(toastAction(page)).toHaveText("Restore mine");
    expect((await read(world, ref)).task.due).toBe(agents);
    // Restore mine puts back what the undo would have: the date before the person's edit.
    await toastAction(page).click();
    await expect.poll(async () => (await read(world, ref)).task.due).toBe(first);

    // The popover takes its base when it opens: an agent's change while it is open is shown there,
    // and the person's pick is a conflict that keeps their value one click away.
    await onOneDay(async (today, attempt) => {
      await due.click();
      await expect(page.locator('[data-part="due-field"]')).toBeFocused();
      // Another day on each attempt: the same one again would change nothing.
      const later = day(11 + attempt).iso;
      await agentSets(world, ref, { due: later });
      await expect(page.locator('[data-part="remote"]')).toContainText("Changed by", {
        timeout: SLOW_MS,
      });
      await page.getByRole("button", { name: "In a week" }).click();
      const unsaved = body.locator('[data-part="unsaved"]');
      await expect(unsaved).toContainText("just now", { timeout: SLOW_MS });
      expect((await read(world, ref)).task.due).toBe(later);
      await unsaved.locator('[data-part="apply-mine"]').click();
      await expect
        .poll(async () => (await read(world, ref)).task.due)
        .toBe(day(7, today.start).iso);
      await expect(unsaved).toHaveCount(0);
    });
  });
});

test.describe("[A7.3.12.m5-08.e2e.ask] An agent-only field starts a request in the composer", () => {
  test("a click on the context or the summary puts its request in the composer, after what was there, and the draft stays", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const [ref] = await addTasks(world, [
      {
        title: `Write the clinic newsletter (${tag})`,
        summary: "Draft the December issue",
        area: "lumen",
        context: "The clinic wants **two** pages, with the new opening hours.",
      },
    ]);
    if (ref === undefined) throw new Error("the task was not added");
    await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const row = rowOf(page, ref);
    const composer = row.locator('[data-part="composer"]');
    await expect(composer).toBeVisible({ timeout: SLOW_MS });
    await row.locator('[data-part="context"]').click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Change the context: ");
    await page.keyboard.type("add the holiday hours");
    await row.locator('[data-part="summary"]').click();
    await expect(composer).toHaveValue(
      "Change the context: add the holiday hours\nChange the summary: ",
    );
    // Nothing was sent, and the draft survives a reload.
    await page.reload();
    await expect(composer).toHaveValue(
      "Change the context: add the holiday hours\nChange the summary: ",
      { timeout: SLOW_MS },
    );
  });
});

test.describe("[A5.3.11.e2e.unanswered] An undo that gets no answer does not hold later edits", () => {
  test("Ctrl+Z whose request is lost: the star clicked after it goes out once the page has learned the undo's outcome, and the undo takes back the priority, not the star", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const [ref, other] = await addTasks(world, [
      { title: `Book the boiler service (${tag})`, area: "home" },
      { title: `Sort the tax papers (${tag})`, area: "home" },
    ]);
    if (ref === undefined || other === undefined) throw new Error("the tasks were not added");
    await openArea(page, world, "Home");
    const row = rowOf(page, ref);
    await row.locator('[data-part="title"]').click();
    const priority = row.getByRole("radiogroup", { name: "Priority" });
    await priority.getByRole("radio", { name: "P1" }).click();
    await expect.poll(async () => (await read(world, ref)).task.priority).toBe(1);

    // The first undo request never reaches the service (a connection that went away); a request
    // sent again goes through.
    let held = 0;
    await page.route("**/api/v1/op/history.undo", async (route) => {
      held += 1;
      if (held === 1) return;
      await route.continue();
    });
    await page.locator("main").focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => held).toBe(1);
    // The person stars another task: it shows at once, and waits for the undo.
    const star = rowOf(page, other).locator('[data-part="star"]');
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    // The page asks for the undo's outcome by its ID, sends it again, and then the star.
    await expect(toast(page)).toHaveText("Undone", { timeout: SLOW_MS });
    await expect
      .poll(async () => (await read(world, other)).task as unknown as { focus: unknown })
      .toMatchObject({ focus: true });
    expect((await read(world, ref)).task.priority).toBe(4);
    expect(held).toBe(2);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

test.describe("[A5.3.11.e2e.finished-title] A title typed while the task is finished elsewhere stays with the person", () => {
  test("the typed title shows with Copy and Discard, no Try again, and reopened the task takes it", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const [ref] = await addTasks(world, [
      { title: `Renew the library card (${tag})`, area: "home" },
    ]);
    if (ref === undefined) throw new Error("the task was not added");
    await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const row = rowOf(page, ref);
    const title = row.locator('[data-part="title"]');
    await expect(title).toHaveAttribute("aria-expanded", "true", { timeout: SLOW_MS });
    await title.focus();
    await page.keyboard.press("F2");
    const field = row.locator('[data-part="title-edit"]');
    await expect(field).toBeFocused();
    await field.fill(`Renew the library card online (${tag})`);
    // Finished in another window while the person types.
    await world.op(world.mira.id, "task.finish", {
      task: ref,
      base: (await read(world, ref)).as_of,
    });
    await expect(row.locator('[data-part="lifecycle"]')).toHaveText("Checked off", {
      timeout: SLOW_MS,
    });
    await page.keyboard.press("Enter");
    const line = row.locator('[data-part="unsaved"]');
    await expect(line).toHaveAttribute("data-reason", "finished");
    await expect(line.locator('[data-part="unsaved-value"]')).toHaveText(
      `Renew the library card online (${tag})`,
    );
    await expect(line.locator('[data-part="copy-mine"]')).toBeVisible();
    await expect(line.locator('[data-part="keep-theirs"]')).toBeVisible();
    await expect(line.locator('[data-part="apply-mine"]')).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await picture(page, "finished-title.png");

    // Reopened, the line offers Try again, which saves it.
    await world.op(world.mira.id, "task.reopen", {
      task: ref,
      reason: "Not done yet",
      base: (await read(world, ref)).as_of,
    });
    await expect(line).toHaveAttribute("data-reason", "failed", { timeout: SLOW_MS });
    await line.locator('[data-part="apply-mine"]').click();
    await expect
      .poll(async () => (await read(world, ref)).task as unknown as { title: string })
      .toMatchObject({ title: `Renew the library card online (${tag})` });
    await expect(line).toHaveCount(0);
  });
});

test.describe("[A5.3.11.e2e.new-area] The area picker makes a new area for a task, and Undo takes it back", () => {
  test("a typo takes the live area it is close to, never an archived one; a new name close to an area is one Down away; Enter makes it and moves the task there; Ctrl+Z moves it back, and again takes the area away", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const seedlings = `Seedlings ${tag}`;
    // A new name close to an existing one, meant as a new area.
    const garden = `Seedling ${tag}`;
    await world.op(world.mira.id, "group.manage", { action: "create", path: seedlings });
    const [ref] = await addTasks(world, [{ title: `Plant the tulips (${tag})`, area: "home" }]);
    if (ref === undefined) throw new Error("the task was not added");
    const areaOf = async () =>
      ((await world.op(world.mira.id, "task.get", { task: ref })) as { task: { area?: string } })
        .task.area;
    const sidebarLink = page
      .getByRole("navigation")
      .getByRole("link", { name: new RegExp(`^${garden}, `) });
    await watchViolations(page);
    await openArea(page, world, "Home");
    const title = rowOf(page, ref).locator('[data-part="title"]');
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(title).toHaveAttribute("aria-expanded", "true");
    const pill = rowOf(page, ref).locator('[data-part="area"]');
    const field = page.getByRole("searchbox", { name: "Find an area or project" });
    const offer = page.locator('[data-part="new-area"]');

    // A name an area has, in any case, is that area: nothing new is offered.
    await tabInto(page, pill);
    await page.keyboard.press("Enter");
    await expect(field).toBeFocused();
    await page.keyboard.type("HOME");
    await expect(page.getByRole("option", { name: "Home", exact: true })).toBeVisible();
    await expect(offer).toHaveCount(0);
    // Escape empties the field, then closes the list.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(pill).toBeFocused();

    // A typo: the area it is close to comes first and Enter takes it; a new area is only offered.
    await page.keyboard.press("Enter");
    const typo = seedlings.replace("ee", "e");
    await page.keyboard.type(typo);
    await expect(page.getByRole("option").first()).toHaveText(seedlings);
    await expect(offer).toHaveText(`New area “${typo}”`);
    await expect(page.getByRole("option").first()).toHaveAttribute("data-focused", "true");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Moved to ${seedlings}`);
    await expect.poll(areaOf).toBe(seedlings);
    await page.keyboard.press("Control+z");
    await expect(toast(page)).toHaveText("Undone");
    await expect.poll(areaOf).toBe("Home");
    // The page has the undo too: its row is drawn again then, which would close a list opened before.
    await expect(pill).toHaveAccessibleName("Area, Home");

    // A new name close to an area: the area comes first, the new one is the next choice down.
    await pill.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type(garden);
    await expect(page.getByRole("option").first()).toHaveText(seedlings);
    await expect(page.getByRole("option").nth(1)).toHaveText(`New area “${garden}”`);
    // The keys act on the highlighted choice, as a person sees it: the area first, then one down.
    await expect(page.getByRole("option").first()).toHaveAttribute("data-focused", "true");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option").nth(1)).toHaveAttribute("data-focused", "true");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Moved to ${garden}`);
    await expect(toastAction(page)).toHaveText("Undo");
    await expect.poll(areaOf).toBe(garden);
    await expect(sidebarLink).toBeVisible();

    // Ctrl+Z takes back the move, and once more the area.
    await page.keyboard.press("Control+z");
    await expect(toast(page)).toHaveText("Undone");
    await expect.poll(areaOf).toBe("Home");
    await page.keyboard.press("Control+z");
    await expect(sidebarLink).toHaveCount(0, { timeout: SLOW_MS });

    // The same typo once the area is archived: the archived area comes last, marked, and Enter
    // makes the area typed.
    const { as_of: base } = (await world.op(world.mira.id, "group.manage", {
      action: "list",
    })) as { as_of: string };
    await world.op(world.mira.id, "group.manage", { action: "archive", path: seedlings, base });
    // The archive has reached the page once its area leaves the sidebar's areas.
    await expect(
      page
        .getByRole("navigation")
        .locator('[data-group="areas"]')
        .getByRole("link", { name: new RegExp(`^${seedlings}, `) }),
    ).toHaveCount(0);
    await pill.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type(typo);
    const shelved = page.getByRole("option", { name: seedlings, exact: true });
    await expect(shelved).toHaveAccessibleDescription("archived");
    await expect(page.getByRole("option").first()).toHaveText(`New area “${typo}”`);
    await expect(page.getByRole("option").last()).toHaveAccessibleName(seedlings);
    await expect(page.getByRole("option").first()).toHaveAttribute("data-focused", "true");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(`Moved to ${typo}`);
    await expect.poll(areaOf).toBe(typo);
    expect(await violations(page)).toEqual([]);
  });

  test("a filing made elsewhere while the area is being made stays: the area is added, the task is not moved, and the toast says both", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const orchard = `Orchard ${tag}`;
    const shed = `Shed ${tag}`;
    await world.op(world.mira.id, "group.manage", { action: "create", path: shed });
    const [ref] = await addTasks(world, [{ title: `Prune the pear tree (${tag})`, area: "home" }]);
    if (ref === undefined) throw new Error("the task was not added");
    const areaOf = async () =>
      ((await world.op(world.mira.id, "task.get", { task: ref })) as { task: { area?: string } })
        .task.area;
    // The area's creation waits until an agent has filed the task elsewhere. The page's clock
    // stands still meanwhile: the page gives up on a request held for a few seconds, and the
    // agent's calls may take longer than that.
    await page.clock.install();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked!: () => void;
    const sent = new Promise<void>((resolve) => {
      asked = resolve;
    });
    await page.route("**/api/v1/op/group.manage", async (route) => {
      asked();
      await gate;
      await route.continue();
    });
    await openArea(page, world, "Home");
    const title = rowOf(page, ref).locator('[data-part="title"]');
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(title).toHaveAttribute("aria-expanded", "true");
    const pill = rowOf(page, ref).locator('[data-part="area"]');
    await pill.click();
    await expect(page.getByRole("searchbox", { name: "Find an area or project" })).toBeFocused();
    await page.keyboard.type(orchard);
    await stopClock(page);
    await page.keyboard.press("Enter");
    await sent;
    await agentSets(world, ref, { area: shed });
    release();
    await page.clock.resume();
    await expect(toast(page)).toHaveText(
      new RegExp(`^Area ${orchard} added, and the task stayed where it was\\. .+ changed the area`),
    );
    await expect(
      page.getByRole("navigation").getByRole("link", { name: new RegExp(`^${orchard}, `) }),
    ).toBeVisible();
    expect(await areaOf()).toBe(shed);
  });
});

test.describe("[A7.3.12.m5-08.e2e.screens] Editing in both themes: screenshots and axe", () => {
  test("Sumi and Washi at 1,440 px and 390 px, with the date popover and a toast, axe clean", async ({
    browser,
    world,
  }) => {
    const tag = `${test.info().project.name}-edit-screens`;
    const [ref] = await addTasks(world, [
      {
        title: `Plan the team offsite (${tag})`,
        summary: "Pick a venue and two dates",
        area: "lumen",
        project: "lumen-portal",
        priority: 2,
        effort: "M",
        due: day(4).iso,
        status: "waiting",
        waiting_on: "Ana Reyes",
        inbox: false,
      },
    ]);
    if (ref === undefined) throw new Error("the task was not added");
    for (const theme of themes()) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await world.machine("ui.theme", theme);
        await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
        await showsSpace(page, world.mira.name);
        const row = rowOf(page, ref);
        await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
          timeout: SLOW_MS,
        });
        // A toast with its action, then the date popover open over the card.
        await row
          .getByRole("radiogroup", { name: "Effort" })
          // Another effort in each theme, so each toast sets one (the second would clear it).
          .getByRole("radio", { name: theme === "sumi" ? "L" : "S" })
          .click();
        await expect(toastAction(page)).toHaveText("Undo");
        await row.locator('[data-part="due"]').click();
        await expect(page.locator('[data-part="due-field"]')).toBeFocused();
        await row.scrollIntoViewIfNeeded();
        await picture(page, `editing-${theme}-1440.png`);

        // The popover is portalled to the body, outside the landmarks, as a dialog of its own:
        // axe's region rule (content inside landmarks) does not apply to it.
        if (pictures()) {
          const found = await axeFound(page, undefined, { region: { enabled: false } });
          expect(found, `axe in ${theme}`).toEqual([]);
        }
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-part="due-field"]')).toHaveCount(0);

        await page.setViewportSize({ width: 390, height: 900 });
        await row.scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await picture(page, `editing-${theme}-390.png`, { fullPage: true });
        await row.locator('[data-part="due"]').click();
        const field = page.locator('[data-part="due-field"]');
        await expect(field).toBeFocused();
        // The popover fits the narrow window: inside it, nothing to scroll sideways.
        const popover = page.locator('[role="dialog"]', { has: field });
        await expect(popover).toBeInViewport();
        const box = await popover.boundingBox();
        expect(box === null ? -1 : box.x + box.width).toBeLessThanOrEqual(390);
        await picture(page, `editing-${theme}-390-popover.png`);
      } finally {
        await context.close();
      }
    }
    // The tests of a worker share its service: the theme goes back to its default.
    await world.machine("ui.theme", null);
  });
});

test.describe("[A5.3.11.e2e.row-base] A row's button changes the task as its row shows it", () => {
  test("an Inbox row held under focus after an agent moved the task to Waiting: Move to Open overwrites nothing and says who changed it", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const [ref] = await addTasks(world, [
      { title: `Sort the scanned receipts (${tag})`, inbox: true },
    ]);
    if (ref === undefined) throw new Error("the task was not added");
    await signIn(page, world, `/s/${world.mira.id}/inbox`);
    await showsSpace(page, world.mira.name);
    const row = rowOf(page, ref);
    const title = row.locator('[data-part="title"]');
    await title.focus();
    await agentSets(world, ref, { status: "waiting", inbox: false });
    // Held under focus, the row stays as the person saw it, with its Move to Open, whether or not
    // the feed brought the agent's change yet: either way the click is a change of what it shows.
    await row.locator('[data-part="move"]').click();
    await expect(toast(page)).toContainText(" changed ", { timeout: SLOW_MS });
    const now = (await read(world, ref)) as unknown as { task: { status: string; inbox: boolean } };
    expect(now.task).toMatchObject({ status: "waiting", inbox: false });
    await picture(page, "row-held-conflict-1440.png");
    await page.setViewportSize({ width: 390, height: 900 });
    await picture(page, "row-held-conflict-390.png");
  });
});
