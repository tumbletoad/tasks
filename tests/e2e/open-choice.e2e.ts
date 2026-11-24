// Which agent Open uses (M6), in Chromium and Firefox against the real service process with
// fixture data: one Open button names its agent, the others are in a menu beside it grouped by
// app, and the button names the one the person last used, also after a reload. Every agent is the
// fake agent under its own name; the fake terminal records each launch.
//
// Verify line: open with the button's agent, open with another from the keyboard, reload and the
// button names that one; one, five and fifteen agents at 1,440 and 390 px in both themes.
import { expect, type Page } from "@playwright/test";
import type { FakeAgent } from "./fake-terminal.ts";
import { built, test } from "./fixture.ts";
import {
  axeFound,
  openTask,
  picture,
  pictures,
  themes,
  violations,
  watchViolations,
} from "./page.ts";
import { SLOW_MS, startWorld, type World } from "./world.ts";

/** Four agents beside the fake agent: two more Claude Code accounts and two Codex homes. */
const FIVE: readonly FakeAgent[] = [
  { key: "claude-work", target: "claude-cli", label: "Claude Code · work" },
  { key: "codex-home", target: "codex-cli", label: "Codex · home" },
  { key: "claude-lab", target: "claude-cli", label: "Claude Code · lab" },
  { key: "codex-studio", target: "codex-cli", label: "Codex · studio" },
];

/** Fourteen beside the fake agent: the most a person sets up, in two apps. */
const FIFTEEN: readonly FakeAgent[] = Array.from({ length: 14 }, (_, i) => ({
  key: `agent-${String(i + 1)}`,
  target: i % 2 === 0 ? "claude-cli" : "codex-cli",
  label: `${i % 2 === 0 ? "Claude Code" : "Codex"} · account ${String(i + 1)}`,
}));

async function addTask(world: World, title: string): Promise<string> {
  const tag = test.info().project.name;
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [{ title: `${title} (${tag})`, area: "home" }],
  })) as { tasks: { ref: string }[] };
  const ref = added.tasks[0]?.ref;
  if (ref === undefined) throw new Error("the task was not added");
  return ref;
}

const rowOf = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);
const stripOf = (page: Page, ref: string) =>
  rowOf(page, ref).getByRole("toolbar", { name: "Act on this task" });
const openOf = (page: Page, ref: string) => stripOf(page, ref).locator('[data-part="open"]');
const menuButton = (page: Page, ref: string) =>
  stripOf(page, ref).getByRole("button", { name: "Open with another agent" });
const menu = (page: Page) => page.getByRole("menu", { name: "Open with another agent" });

/** The agent the next Open asks for, as the page sends it. */
async function opensWith(page: Page, act: () => Promise<void>): Promise<string> {
  const sent = page.waitForRequest("**/api/v1/op/launch.open");
  await act();
  return ((await sent).postDataJSON() as { instance: string }).instance;
}

/** Nothing on the page scrolls sideways. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("[M6.e2e.open-choice] One Open button names its agent; the others are one step away", () => {
  test("Open opens with its agent, the menu opens with another from the keyboard, and after a reload the button names that one, at 1,440 and 390 px", async ({
    page,
  }) => {
    const world = await startWorld(built(), { agents: FIVE });
    try {
      await watchViolations(page);
      const ref = await addTask(world, "Sort the receipts");
      await openTask(page, world, ref);

      // The first in Settings' order: the fake agent, the only one named without its account.
      await expect(openOf(page, ref)).toHaveAccessibleName("Open in Claude Code");
      const first = await opensWith(page, () => openOf(page, ref).click());
      expect(first).toBe("fake-agent");
      await expect
        .poll(() => world.terminal().length, { timeout: SLOW_MS })
        .toBeGreaterThanOrEqual(1);

      // Another one from the keyboard: Down opens the menu, the arrows move, Enter opens.
      await menuButton(page, ref).focus();
      await page.keyboard.press("ArrowDown");
      await expect(menu(page)).toBeVisible();
      await expect(menu(page).getByRole("group")).toHaveCount(2);
      await expect(menu(page).getByRole("menuitemradio")).toHaveText([
        /Claude Code$/u,
        /Claude Code · work$/u,
        /Claude Code · lab$/u,
        /Codex · home$/u,
        /Codex · studio$/u,
      ]);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const picked = await opensWith(page, () => page.keyboard.press("Enter"));
      expect(picked).toBe("claude-lab");
      await expect(menu(page)).toBeHidden();
      await expect(openOf(page, ref)).toHaveAccessibleName(/Claude Code · lab$/u);

      // After a reload the button names the one just used, on this task and on a new one.
      await page.reload();
      await expect(openOf(page, ref)).toHaveAccessibleName(/Claude Code · lab$/u, {
        timeout: SLOW_MS,
      });
      const other = await addTask(world, "Book the dentist");
      await openTask(page, world, other);
      await expect(openOf(page, other)).toHaveAccessibleName("Open in Claude Code · lab");

      // Escape closes the menu and gives the focus back to its button.
      await menuButton(page, other).focus();
      await page.keyboard.press("ArrowDown");
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await expect(menuButton(page, other)).toBeFocused();

      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(stripOf(page, other)).toBeVisible();
        const strip = await stripOf(page, other).boundingBox();
        const open = await openOf(page, other).boundingBox();
        const copy = await stripOf(page, other).locator('[data-part="copy"]').boundingBox();
        // One row: Open and Copy, the strip's two ends, on the same line.
        expect(
          Math.abs((open?.y ?? 0) - (copy?.y ?? 1)),
          `one row at ${String(width)}`,
        ).toBeLessThan(8);
        expect(strip?.height ?? 99).toBeLessThan(48);
        expect(await sideways(page), `sideways at ${String(width)}`).toBeLessThanOrEqual(0);
        expect(await axeFound(page, [`li[data-task="${other}"]`])).toEqual([]);
        await menuButton(page, other).click();
        await expect(menu(page)).toBeVisible();
        expect(await axeFound(page, ['[role="menu"]'])).toEqual([]);
        await page.keyboard.press("Escape");
      }
      expect(await violations(page)).toEqual([]);
    } finally {
      await world.close();
    }
  });

  test("the strip with one, five and fifteen agents, and the open menu, in both themes at both widths", async ({
    page,
  }) => {
    test.skip(!pictures(), "pictures only");
    for (const [name, agents] of [
      ["one", []],
      ["five", FIVE],
      ["fifteen", FIFTEEN],
    ] as const) {
      const world = await startWorld(built(), { agents });
      try {
        const ref = await addTask(world, "Plan the move");
        for (const theme of themes()) {
          await world.machine("ui.theme", theme);
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await openTask(page, world, ref);
            const row = rowOf(page, ref);
            await stripOf(page, ref).scrollIntoViewIfNeeded();
            await picture(row, `open-${name}-${theme}-${String(width)}.png`);
            if (agents.length > 0) {
              await menuButton(page, ref).click();
              await expect(menu(page)).toBeVisible();
              await picture(page, `open-${name}-menu-${theme}-${String(width)}.png`);
              await page.keyboard.press("Escape");
            }
          }
        }
      } finally {
        await world.close();
      }
    }
  });
});
