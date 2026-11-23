// A space's own list of sizes in the page, end to end in Chromium and Firefox against the real
// service: one size and ten (four of them of the longest name) in the expanded task's control and
// the row at 1,440 and 390 px, and the longest size chosen in the card still there after a reload.
// Screenshots go to the results folder for review. Fixture data only.
import { expect, type Page } from "@playwright/test";
import { EFFORT_KEY_MAX } from "../../packages/contracts/src/preferences.ts";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn } from "./page.ts";
import { SLOW_MS, startWorld } from "./world.ts";

const STATUSES = ["open", "waiting", "review", "backlog"];
const LONG = ["Deep-work", "1.5d", "two_days"].map((n) => n.padEnd(EFFORT_KEY_MAX, "x"));
const LONGEST = "W".repeat(EFFORT_KEY_MAX);
const SCALES = [
  { statuses: STATUSES, efforts: ["M"] },
  { statuses: STATUSES, efforts: ["a", "XS", "S", "M", "L", "XL", ...LONG, LONGEST] },
];

/** How far the page scrolls sideways: none is wanted. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("[A5.3.7.e2e.effort-scales] one size, ten sizes and the longest name in the card and the row", () => {
  test("each size is offered whole, the largest is chosen and holds after a reload, at 1,440 and 390 px", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const ui = process.env["E2E_UI_BUILD"];
    if (ui === undefined) throw new Error("global-setup.ts did not build the page");
    const world = await startWorld(ui, { scales: SCALES });
    try {
      for (const [at, scale] of SCALES.entries()) {
        const sizes = scale.efforts;
        await test.step(`${String(sizes.length)} sizes`, async () => {
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
          /** The sizes whose name does not fit its button. */
          const cut = () =>
            effort
              .getByRole("radio")
              .evaluateAll((cells) =>
                cells
                  .filter((c) => c.scrollWidth > c.clientWidth || c.scrollHeight > c.clientHeight)
                  .map((c) => c.textContent),
              );
          expect(await cut()).toEqual([]);
          await picture(facts, `effort-card-${String(sizes.length)}.png`);

          // The largest size, the longest name of the ten, chosen in the card.
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

          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.reload();
            await expect(effort.getByRole("radio", { name: largest, exact: true })).toHaveAttribute(
              "aria-checked",
              "true",
              { timeout: SLOW_MS },
            );
            expect(await sideways(page), `sideways at ${String(width)} px`).toBeLessThanOrEqual(0);
            expect(await cut(), `cut at ${String(width)} px`).toEqual([]);
            await picture(page, `effort-card-${String(sizes.length)}-${String(width)}.png`);
            // Collapsed, the row marks the size: its name, whole in the tip; none where narrow.
            const title = row.locator('[data-part="title"]');
            await title.focus();
            await page.keyboard.press("Escape");
            await expect(title).toHaveAttribute("aria-expanded", "false");
            const mark = row.locator('[data-part="row-effort"]');
            if (width === 390) await expect(mark).toBeHidden();
            else {
              await expect(mark).toBeVisible();
              await expect(mark).toHaveText(largest);
              await expect(mark).toHaveAttribute("data-tip", `Effort ${largest}`);
            }
            expect(await sideways(page), `sideways at ${String(width)} px`).toBeLessThanOrEqual(0);
            await picture(page, `effort-row-${String(sizes.length)}-${String(width)}.png`);
            await title.focus();
            await page.keyboard.press("Enter");
            await expect(title).toHaveAttribute("aria-expanded", "true");
          }
        });
      }
    } finally {
      await world.close();
    }
  });
});
