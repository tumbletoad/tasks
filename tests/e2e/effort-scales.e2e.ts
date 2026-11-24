// A space's own effort levels in the page, end to end in Chromium and Firefox against the real
// service: one level, ten (four of them of the longest name a person sets, five with a time and a
// line), and a longer name an earlier build let be set, in the expanded task's control and the row
// at 1,440 and 390 px; the largest level chosen in the card still there after a reload; and
// resting on a level, by mouse or by keyboard, says its time and what belongs on it. Screenshots
// go to the results folder for review. Fixture data only.
import { expect, type Locator, type Page } from "@playwright/test";
import {
  EFFORT_KEY_MAX,
  EFFORT_LEVELS,
  EFFORT_NAME_MAX,
} from "../../packages/contracts/src/preferences.ts";
import { levelsOf, levelTip, type Scales } from "./bulk.ts";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn } from "./page.ts";
import { SLOW_MS, startWorld } from "./world.ts";

const STATUSES = ["open", "waiting", "review", "backlog"];
const LONG = ["Half a day", "Deep-work", "two_days"].map((n) => n.padEnd(EFFORT_NAME_MAX, "x"));
const LONGEST = "W".repeat(EFFORT_NAME_MAX);
/** A name of the length an earlier build allowed: shown cut, whole in its tip. */
const EARLIER = "Deep-work_2.0".padEnd(EFFORT_KEY_MAX, "x");
const SCALES: readonly Scales[] = [
  { statuses: STATUSES, efforts: ["M"] },
  { statuses: STATUSES, efforts: ["a", ...EFFORT_LEVELS, ...LONG, LONGEST] },
  {
    statuses: STATUSES,
    efforts: [...EFFORT_LEVELS.slice(0, 3), { key: EARLIER, about: "Deep work over several days" }],
  },
];

const tipOf = (key: string, scale: Scales): string => levelTip(key, levelsOf(scale));

/** Presses Tab until `target` has focus, at most 30 times. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if (await target.evaluate((e) => e === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** How far the page scrolls sideways: none is wanted. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * The options whose name does not show whole: past its button, or cut short inside it. By more
 * than a pixel: both sizes are whole numbers, and a wrapped name's height is not.
 */
const cut = (effort: Locator) =>
  effort.getByRole("radio").evaluateAll((cells) =>
    cells
      .filter((c) => {
        const text = c.firstElementChild;
        const shortened =
          text instanceof HTMLElement &&
          getComputedStyle(text).overflow === "hidden" &&
          text.scrollWidth > text.clientWidth + 1;
        return (
          shortened || c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1
        );
      })
      .map((c) => c.textContent),
  );

test.describe("[A5.3.7.e2e.effort-scales] one level, ten levels and the longest name in the card and the row", () => {
  test("each level is offered, the largest is chosen and holds after a reload, at 1,440 and 390 px; a level's tip says its time and line", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const ui = process.env["E2E_UI_BUILD"];
    if (ui === undefined) throw new Error("global-setup.ts did not build the page");
    const world = await startWorld(ui, { scales: SCALES });
    const tooltip = page.getByRole("tooltip", { includeHidden: true });
    try {
      for (const [at, scale] of SCALES.entries()) {
        const sizes = levelsOf(scale).map((level) => level.key);
        const earlier = sizes.filter((name) => name.length > EFFORT_NAME_MAX);
        await test.step(`${String(sizes.length)} levels${earlier.length > 0 ? ", one of an earlier build" : ""}`, async () => {
          const space = world.scaled[at];
          if (space === undefined) throw new Error("the world has no space for this scale");
          const added = (await world.op(space.id, "task.add", {
            tasks: [{ title: "Book the hall for the spring fair", inbox: true }],
          })) as { tasks: { ref: string }[] };
          const ref = added.tasks[0]?.ref;
          if (ref === undefined) throw new Error("the task was not added");
          await page.setViewportSize({ width: 1440, height: 1000 });
          const to = `/s/${space.id}/task/${ref}`;
          if (at === 0) await signIn(page, world, to);
          else await page.goto(`${world.origin}${to}`);
          await showsSpace(page, space.name);
          const row = page.locator(`main li[data-task="${ref}"]`);
          await expect(row.locator('[data-part="title"]')).toHaveAttribute(
            "aria-expanded",
            "true",
            { timeout: SLOW_MS },
          );
          const facts = row.locator("dl");
          const effort = facts.getByRole("radiogroup", { name: "Effort" });
          await expect(effort.getByRole("radio")).toHaveCount(sizes.length, { timeout: SLOW_MS });
          expect(await effort.getByRole("radio").allInnerTexts()).toEqual(sizes);
          // A name a person sets shows whole; only a longer one an earlier build let be set is cut.
          expect(await cut(effort)).toEqual(earlier);
          await picture(facts, `effort-card-${String(at)}.png`);

          // Resting on a level, by mouse, says its time and what belongs on it; so does focus.
          const said = sizes.find((name) => tipOf(name, scale) !== name) ?? sizes[0] ?? "";
          const option = effort.getByRole("radio", { name: said, exact: true });
          await option.hover();
          await expect(tooltip).toHaveText(tipOf(said, scale));
          await expect(option).toHaveAccessibleDescription(tipOf(said, scale));
          await picture(page, `effort-card-tip-${String(at)}-1440.png`);
          await page.mouse.move(0, 0);
          await expect(tooltip).toHaveCount(0);
          for (const name of earlier) {
            await effort.getByRole("radio", { name, exact: true }).hover();
            await expect(tooltip).toHaveText(tipOf(name, scale));
            await picture(page, `effort-card-cut-${String(at)}-1440.png`);
            await page.mouse.move(0, 0);
          }

          // The largest level chosen in the card.
          const largest = sizes.at(-1) ?? "";
          await effort.getByRole("radio", { name: largest, exact: true }).click();
          await expect
            .poll(async () => {
              const got = (await world.op(space.id, "task.get", { task: ref })) as {
                task: { effort?: string };
              };
              return got.task.effort;
            })
            .toBe(largest);
          await page.mouse.move(0, 0);

          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.reload();
            const chosen = effort.getByRole("radio", { name: largest, exact: true });
            await expect(chosen).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });
            expect(await sideways(page), `sideways at ${String(width)} px`).toBeLessThanOrEqual(0);
            // Where the options take the room they need (390 px), a long name may show whole.
            const shortened = await cut(effort);
            expect(
              shortened.filter((name) => !earlier.includes(name)),
              `cut at ${String(width)} px`,
            ).toEqual([]);
            await picture(page, `effort-card-${String(at)}-${String(width)}.png`);
            // By keyboard: the chosen level holds the group's tab stop, and its tip shows on focus.
            const first = effort.getByRole("radio").first();
            await first.focus();
            await page.keyboard.press("ArrowRight");
            await page.keyboard.press("ArrowLeft");
            await expect(first).toBeFocused();
            await expect(tooltip).toHaveText(tipOf(sizes[0] ?? "", scale));
            await picture(page, `effort-card-tip-${String(at)}-${String(width)}-focus.png`);
            // Collapsed, the row marks the level, whole and with its time and line in the tip;
            // none where narrow.
            const title = row.locator('[data-part="title"]');
            await title.focus();
            await page.keyboard.press("Escape");
            await expect(title).toHaveAttribute("aria-expanded", "false");
            const mark = row.locator('[data-part="row-effort"]');
            if (width === 390) await expect(mark).toBeHidden();
            else {
              await expect(mark).toBeVisible();
              await expect(mark).toHaveText(largest);
              await expect(mark).toHaveAttribute("data-tip", `Effort ${tipOf(largest, scale)}`);
              await mark.hover();
              await expect(tooltip).toHaveText(`Effort ${tipOf(largest, scale)}`);
              await picture(page, `effort-row-tip-${String(at)}-${String(width)}.png`);
              await page.mouse.move(0, 0);
            }
            expect(await sideways(page), `sideways at ${String(width)} px`).toBeLessThanOrEqual(0);
            await picture(page, `effort-row-${String(at)}-${String(width)}.png`);
            await title.focus();
            await page.keyboard.press("Enter");
            await expect(title).toHaveAttribute("aria-expanded", "true");
          }

          // A level with a time and a line, chosen and collapsed: the row's tip says them.
          const timed = sizes.find((name) => levelsOf(scale).find((l) => l.key === name)?.time);
          if (timed !== undefined) {
            await page.setViewportSize({ width: 1440, height: 1000 });
            await effort.getByRole("radio", { name: timed, exact: true }).click();
            const title = row.locator('[data-part="title"]');
            await title.focus();
            await page.keyboard.press("Escape");
            const mark = row.locator('[data-part="row-effort"]');
            await expect(mark).toHaveText(timed);
            await mark.hover();
            await expect(tooltip).toHaveText(`Effort ${tipOf(timed, scale)}`);
            await picture(page, `effort-row-tip-${String(at)}-timed-1440.png`);
            await page.mouse.move(0, 0);
            // By keyboard: Tab from the title reaches the mark, whose tip shows on focus, and the
            // row's description says the level's time and line as the tip does.
            await title.focus();
            await tabTo(page, mark);
            await expect(tooltip).toHaveText(`Effort ${tipOf(timed, scale)}`);
            await expect(title).toHaveAccessibleDescription(
              new RegExp(escaped(`effort ${tipOf(timed, scale)}`), "u"),
            );
            await picture(page, `effort-row-tip-${String(at)}-timed-focus.png`);
            // Finished, the card's mark says the same on focus.
            const read = (await world.op(space.id, "task.get", { task: ref })) as { as_of: string };
            await world.op(space.id, "task.finish", { task: ref, base: read.as_of });
            await page.goto(`${world.origin}${to}`);
            const done = facts.locator('[data-part="effort"]');
            await expect(done).toHaveText(timed, { timeout: SLOW_MS });
            await title.focus();
            await tabTo(page, done);
            await expect(tooltip).toHaveText(tipOf(timed, scale));
            await expect(done).toHaveAccessibleDescription(tipOf(timed, scale));
            await picture(page, `effort-card-finished-tip-${String(at)}-1440-focus.png`);
            await page.setViewportSize({ width: 390, height: 1000 });
            await title.focus();
            await tabTo(page, done);
            await expect(tooltip).toHaveText(tipOf(timed, scale));
            await picture(page, `effort-card-finished-tip-${String(at)}-390-focus.png`);
          }
        });
      }
    } finally {
      await world.close();
    }
  });
});

test.describe("[A5.3.12.e2e.undo-levels] a change of the effort levels made at a terminal, undone from the page", () => {
  test("Ctrl+Z puts back the levels and the task's size and says so, Ctrl+Shift+Z changes them again, and a size kept unsent waits once the levels change, at 1,440 and 390 px", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const ui = process.env["E2E_UI_BUILD"];
    if (ui === undefined) throw new Error("global-setup.ts did not build the page");
    const world = await startWorld(ui, {
      scales: [{ statuses: STATUSES, efforts: ["S", "M", "L"] }],
    });
    const toast = page.locator('[data-part="toast-text"]');
    const levels = async (space: string, value: string, moves: { from: string; to: string }[]) => {
      const read = (await world.op(space, "prefs.manage", { action: "get" })) as { as_of: string };
      await world.op(space, "prefs.manage", {
        action: "set",
        set: [{ key: "tasks.effort_scale", value, moves }],
        base: read.as_of,
      });
    };
    const bothWidths = async (name: string) => {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await picture(page, `${name}-${String(width)}.png`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    };
    try {
      const space = world.scaled[0];
      if (space === undefined) throw new Error("the world has no space of its own levels");
      const added = (await world.op(space.id, "task.add", {
        tasks: [{ title: "Plan the stalls for the spring fair", inbox: true, effort: "M" }],
      })) as { tasks: { ref: string }[] };
      const ref = added.tasks[0]?.ref ?? "";
      await page.setViewportSize({ width: 1440, height: 1000 });
      await signIn(page, world, `/s/${space.id}/task/${ref}`);
      await showsSpace(page, space.name);
      const effort = page
        .locator(`main li[data-task="${ref}"] dl`)
        .getByRole("radiogroup", { name: "Effort" });
      const chosen = (name: string) => effort.getByRole("radio", { name, exact: true });
      await expect(chosen("M")).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });

      await levels(space.id, "S,Medium,L", [{ from: "M", to: "Medium" }]);
      await expect(chosen("Medium")).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });
      await page.locator("main").focus();
      await page.keyboard.press("Control+z");
      await expect(toast).toHaveText("Effort levels put back");
      await expect(chosen("M")).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });
      await bothWidths("levels-undone");
      await page.locator("main").focus();
      await page.keyboard.press("Control+Shift+z");
      await expect(toast).toHaveText("Effort levels changed again");
      await expect(chosen("Medium")).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });

      // A size the service did not take, then a change of the levels: it is not sent again.
      await page.route("**/api/v1/op/task.update", (route) => route.abort());
      await chosen("L").click();
      const line = page.locator(`main li[data-task="${ref}"] [data-part="unsaved"]`);
      await expect(line.locator('[data-part="apply-mine"]')).toHaveCount(1, { timeout: SLOW_MS });
      await page.unroute("**/api/v1/op/task.update");
      await levels(space.id, "S,Medium,Large", [{ from: "L", to: "Large" }]);
      await expect(line).toHaveAttribute("data-reason", "levels", { timeout: SLOW_MS });
      await expect(line.locator('[data-part="unsaved-value"]')).toHaveText("L");
      await expect(line.locator('[data-part="apply-mine"]')).toHaveCount(0);
      await bothWidths("levels-kept-size");
    } finally {
      await world.close();
    }
  });
});

test.describe("[A5.3.12.e2e.undo-levels-rest] the rest of a change of the effort levels an agent built on", () => {
  test("the refused Undo offers the rest, and its toast says what was put back and what kept a newer size, at 1,440 and 390 px", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const ui = process.env["E2E_UI_BUILD"];
    if (ui === undefined) throw new Error("global-setup.ts did not build the page");
    const world = await startWorld(ui, {
      scales: [{ statuses: STATUSES, efforts: ["S", "M", "L"] }],
    });
    const toast = page.locator('[data-part="toast-text"]');
    const action = page.locator('[data-part="toast-action"]');
    try {
      const space = world.scaled[0];
      if (space === undefined) throw new Error("the world has no space of its own levels");
      const added = (await world.op(space.id, "task.add", {
        tasks: [{ title: "Order the banners for the spring fair", inbox: true, effort: "M" }],
      })) as { tasks: { ref: string }[] };
      const ref = added.tasks[0]?.ref ?? "";
      await page.setViewportSize({ width: 1440, height: 1000 });
      await signIn(page, world, `/s/${space.id}/task/${ref}`);
      await showsSpace(page, space.name);
      const effort = page
        .locator(`main li[data-task="${ref}"] dl`)
        .getByRole("radiogroup", { name: "Effort" });
      const chosen = (name: string) => effort.getByRole("radio", { name, exact: true });
      await expect(chosen("M")).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });
      const read = (await world.op(space.id, "prefs.manage", { action: "get" })) as {
        as_of: string;
      };
      await world.op(space.id, "prefs.manage", {
        action: "set",
        set: [
          { key: "tasks.effort_scale", value: "S,Medium,L", moves: [{ from: "M", to: "Medium" }] },
        ],
        base: read.as_of,
      });
      await expect(chosen("Medium")).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });
      const got = (await world.op(space.id, "task.get", { task: ref })) as { as_of: string };
      await world.op(
        space.id,
        "task.update",
        { task: ref, set: { effort: "S" }, base: got.as_of },
        "agent",
      );
      await expect(chosen("S")).toHaveAttribute("aria-checked", "true", { timeout: SLOW_MS });
      await page.locator("main").focus();
      await page.keyboard.press("Control+z");
      await expect(toast).toContainText("Not undone");
      await expect(action).toHaveText("Undo the rest");
      await action.click();
      await expect(toast).toHaveText("Effort levels put back. 1 task kept a newer size");
      await expect(chosen("S")).toHaveAttribute("aria-checked", "true");
      await expect(effort.getByRole("radio", { name: "M", exact: true })).toBeVisible();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await picture(page, `levels-rest-${String(width)}.png`);
      }
    } finally {
      await world.close();
    }
  });
});
