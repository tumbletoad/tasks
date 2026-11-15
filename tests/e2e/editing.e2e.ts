// Field editing, check-off, the toast, undo and redo end to end (A7 3.12 M5.08; A5 3.11, 3.12,
// 3.15 item 9), in Chromium and Firefox against the real service process with fixture data.
//
// Verify line: by keyboard alone, edit due, priority and effort, check off, undo, redo; an
// agent-only field starts a composer request. Also: "Restore mine" when an agent changed the field
// since the person's edit, "Apply mine" when it changed while the person's editor was open, axe in
// both themes with the date popover and a toast open, and the screenshots at 1,440 and 390 px.
// Dates are relative to the day the test runs, as the service's are.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Locator, type Page } from "@playwright/test";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const THEME_KEY = `${PRODUCT_ID}.theme`;

/** The local calendar day `days` from today, YYYY-MM-DD. */
function day(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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
  await page.goto(await world.signInUrl(`/s/${world.mira.id}/today`));
  await showsSpace(page, world.mira.name);
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
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

    // The service has all three.
    await expect
      .poll(async () => {
        const { task } = await read(world, ref);
        return [task.priority, task.effort, task.due];
      })
      .toEqual([2, "L", day(3)]);
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
    const first = day(5);
    const [ref] = await addTasks(world, [
      { title: `Renew the parking permit (${tag})`, area: "home", due: first },
    ]);
    if (ref === undefined) throw new Error("the task was not added");
    await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
    await showsSpace(page, world.mira.name);
    const row = rowOf(page, ref);
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
      timeout: SLOW_MS,
    });
    const body = row.locator('[data-part="expanded"]');
    const due = body.locator('[data-part="due"]');

    // The person sets tomorrow; then an agent sets another day.
    await due.click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect.poll(async () => (await read(world, ref)).task.due).toBe(day(1));
    await agentSets(world, ref, { due: day(10) });
    await expect.poll(async () => (await read(world, ref)).task.due).toBe(day(10));

    // Undo: the field is the agent's now, so nothing is overwritten unseen. The toast says who.
    await page.locator("main").focus();
    await page.keyboard.press("Control+z");
    await expect(toast(page)).toContainText("changed the due date at");
    await expect(toastAction(page)).toHaveText("Restore mine");
    expect((await read(world, ref)).task.due).toBe(day(10));
    // Restore mine puts back what the undo would have: the date before the person's edit.
    await toastAction(page).click();
    await expect.poll(async () => (await read(world, ref)).task.due).toBe(first);

    // The popover takes its base when it opens: an agent's change while it is open is shown there,
    // and the person's pick is a conflict that keeps their value one click away.
    await due.click();
    await expect(page.locator('[data-part="due-field"]')).toBeFocused();
    await agentSets(world, ref, { due: day(12) });
    await expect(page.locator('[data-part="remote"]')).toContainText("Changed by", {
      timeout: SLOW_MS,
    });
    await page.getByRole("button", { name: "In a week" }).click();
    const unsaved = body.locator('[data-part="unsaved"]');
    await expect(unsaved).toContainText("just now", { timeout: SLOW_MS });
    expect((await read(world, ref)).task.due).toBe(day(12));
    await unsaved.locator('[data-part="apply-mine"]').click();
    await expect.poll(async () => (await read(world, ref)).task.due).toBe(day(7));
    await expect(unsaved).toHaveCount(0);
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
    await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
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
        due: day(4),
        status: "waiting",
        waiting_on: "Ana Reyes",
        inbox: false,
      },
    ]);
    if (ref === undefined) throw new Error("the task was not added");
    const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    for (const theme of ["sumi", "washi"] as const) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.addInitScript(
          (value) => {
            localStorage.setItem(value.key, value.theme);
          },
          { key: THEME_KEY, theme },
        );
        await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
        await showsSpace(page, world.mira.name);
        const row = rowOf(page, ref);
        await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
          timeout: SLOW_MS,
        });
        // A toast with its action, then the date popover open over the card.
        await row
          .getByRole("radiogroup", { name: "Effort" })
          .getByRole("radio", { name: "L" })
          .click();
        await expect(toastAction(page)).toHaveText("Undo");
        await row.locator('[data-part="due"]').click();
        await expect(page.locator('[data-part="due-field"]')).toBeFocused();
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath(`editing-${theme}-1440.png`) });

        await page.evaluate(axe);
        const found = await page.evaluate(async () => {
          const run = (
            window as unknown as {
              axe: {
                run: (
                  context: unknown,
                  options: unknown,
                ) => Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }>;
              };
            }
          ).axe.run;
          // The popover is portalled to the body, outside the landmarks, as a dialog of its own:
          // axe's region rule (content inside landmarks) does not apply to it.
          const result = await run(document, {
            resultTypes: ["violations"],
            rules: { region: { enabled: false } },
          });
          return result.violations.map(
            (v) => `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`,
          );
        });
        expect(found, `axe in ${theme}`).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-part="due-field"]')).toHaveCount(0);

        await page.setViewportSize({ width: 390, height: 900 });
        await row.scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await page.screenshot({
          path: test.info().outputPath(`editing-${theme}-390.png`),
          fullPage: true,
        });
        await row.locator('[data-part="due"]').click();
        await expect(page.locator('[data-part="due-field"]')).toBeFocused();
        await page.screenshot({ path: test.info().outputPath(`editing-${theme}-390-popover.png`) });
      } finally {
        await context.close();
      }
    }
  });
});
