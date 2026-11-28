// A space's own effort levels in the page, end to end in Chromium and Firefox against the real
// service: one level, ten (four of them of the longest name a person sets, five with a time and a
// line), and a longer name an earlier build let be set, in the expanded task's control and the row
// at 1,440 and 390 px; the control on one line where the names fit and wrapping where they do not;
// the largest level chosen in the card still there after a reload; and
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
/** A name of the length an earlier build allowed: whole where it fits, as in its tip. */
const EARLIER = "Deep-work_2.0".padEnd(EFFORT_KEY_MAX, "x");
const SCALES: readonly Scales[] = [
  { statuses: STATUSES, efforts: ["M"] },
  { statuses: STATUSES, efforts: ["a", ...EFFORT_LEVELS, ...LONG, LONGEST] },
  {
    statuses: STATUSES,
    efforts: [...EFFORT_LEVELS.slice(0, 3), { key: EARLIER, about: "Deep work over several days" }],
  },
];

/** Whether each scale's names fit on one line of the card's control, at both widths. */
const ONE_LINE = [true, false, true];

const tipOf = (key: string, scale: Scales): string => levelTip(key, levelsOf(scale));

/** How many lines the options of a segmented control take. */
const linesOf = (group: Locator) =>
  group
    .getByRole("radio")
    .evaluateAll(
      (cells) => new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top))).size,
    );

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
          // Every name shows whole, also a longer one an earlier build let be set.
          expect(await cut(effort)).toEqual([]);
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
            await picture(page, `effort-card-earlier-${String(at)}-1440.png`);
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
            expect(await cut(effort), `cut at ${String(width)} px`).toEqual([]);
            // One line while the names fit; more only when they do not.
            const lines = await linesOf(effort);
            if (ONE_LINE[at] === true) expect(lines, `lines at ${String(width)} px`).toBe(1);
            else expect(lines, `lines at ${String(width)} px`).toBeGreaterThan(1);
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
