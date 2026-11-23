// The Agents page with agents linked to their tasks, end to end in Chromium and Firefox against the
// real service process: the person opens four tasks in the fake agent from the page, and the test
// kit's fake `ttam` reports three of those sessions by the IDs the launches preset, and one agent
// of no task. Each task shows once, as its row, in the group its agent's state puts it in; the
// fourth, which the monitor does not report, is not seen; a picture that is not current mutes
// those rows and moves none; and the second space lists the agents with a link that opens their
// task in its own space. At 1,440 and 390 px in both themes. Fixture data only.
import { expect, type Page } from "@playwright/test";
import { ttamAgent, ttamHome } from "../../packages/testkit/src/index.ts";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { test } from "./fixture.ts";
import { axeFound, openTask, picture, pictures, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const HOME = "claude-e2e";
/** An agent's session that no launch of TTasks preset. */
const NO_TASK = "aaaaaaaa-1111-4111-8111-00000000e2e0";

const group = (page: Page, name: string) =>
  page.getByRole("main").getByRole("group", { name, exact: true });
const rowIn = (page: Page, name: string, ref: string) =>
  group(page, name).locator(`li[data-task="${ref}"]`);

/** A new task of Mira's in the Inbox, for this test alone. */
async function newTask(world: World, title: string): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [{ title: `${title} (${test.info().project.name})`, inbox: true }],
  })) as { tasks: readonly { ref: string }[] };
  return added.tasks[0]?.ref ?? "";
}

/** Opens the task in the fake agent from its strip, held until released; its preset session. */
async function opened(page: Page, world: World, ref: string): Promise<string> {
  world.hold(ref);
  const row = await openTask(page, world, ref);
  await row
    .getByRole("toolbar")
    .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
    .click();
  await expect(row.locator('[data-part="tile"]')).toHaveAttribute("data-state", "running", {
    timeout: SLOW_MS,
  });
  await expect.poll(() => world.agentSessions(ref).length, { timeout: SLOW_MS }).toBe(1);
  return world.agentSessions(ref)[0] ?? "";
}

/** The state in every theme of this browser, at both widths, axe clean, no sideways scroll. */
async function shots(page: Page, world: World, name: string): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme, { timeout: SLOW_MS });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await picture(page, `agents-${name}-${theme}-1440.png`, { fullPage: true });
    if (pictures()) expect(await axeFound(page, ["main"]), `axe in ${theme}`).toEqual([]);
    await page.setViewportSize({ width: 390, height: 900 });
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
    await picture(page, `agents-${name}-${theme}-390.png`, { fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}

test.describe("[A5.agents.e2e.links] each agent shows once, with its task and its state", () => {
  test("needs you, working, idle and not seen as the tasks' rows; muted when not current; the other space links to them", async ({
    browser,
    monitored: world,
  }) => {
    // Four launches, three states, two themes, two widths.
    test.setTimeout(600_000);
    const context = await browser.newContext({
      bypassCSP: true,
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const refs = {
      asks: await newTask(world, "Fixture agent asks"),
      works: await newTask(world, "Fixture agent works"),
      rests: await newTask(world, "Fixture agent rests"),
      gone: await newTask(world, "Fixture agent unseen"),
    };
    try {
      const page = await context.newPage();
      const session = {
        asks: await opened(page, world, refs.asks),
        works: await opened(page, world, refs.works),
        rests: await opened(page, world, refs.rests),
        gone: await opened(page, world, refs.gone),
      };
      const agent = (row: string, id: string, name: string, activity: string) =>
        ttamAgent({ row, provider: "claude", home: HOME, session: id, name, activity });
      world.monitorAgents({
        homes: [ttamHome({ id: HOME, provider: "claude", path: world.agentHome })],
        agents: [
          agent("e2e-asks", session.asks, "Fixture session asks", "waiting"),
          agent("e2e-works", session.works, "Fixture session works", "working"),
          agent("e2e-rests", session.rests, "Fixture session rests", "idle"),
          agent("e2e-none", NO_TASK, "Fixture session of no task", "working"),
        ],
      });

      await signIn(page, world, `/s/${world.mira.id}/agents`);
      await showsSpace(page, world.mira.name);
      await expect(rowIn(page, "Needs you", refs.asks)).toBeVisible({ timeout: SLOW_MS });
      await expect(rowIn(page, "Working", refs.works)).toBeVisible();
      await expect(
        group(page, "With an agent")
          .getByRole("group", { name: "Idle" })
          .locator(`li[data-task="${refs.rests}"]`),
      ).toBeVisible();
      // The agent the monitor does not report is not seen after two of its answers.
      await expect(
        group(page, "With an agent")
          .getByRole("group", { name: "Not seen by TTAM" })
          .locator(`li[data-task="${refs.gone}"]`),
      ).toBeVisible({ timeout: SLOW_MS });
      // Each once: "On this computer" lists the agent of no task, and none of the three.
      const computer = page.locator('[data-part="computer"]');
      await expect(computer).toContainText("Fixture session of no task");
      for (const name of [
        "Fixture session asks",
        "Fixture session works",
        "Fixture session rests",
      ]) {
        await expect(computer).not.toContainText(name);
      }
      for (const ref of Object.values(refs)) {
        await expect(page.locator(`main li[data-task="${ref}"]`)).toHaveCount(1);
      }
      await shots(page, world, "linked");

      // Not current: the rows the monitor placed are muted where they are.
      const place = await rowIn(page, "Needs you", refs.asks).boundingBox();
      world.monitor("hold");
      await expect(rowIn(page, "Needs you", refs.asks)).toHaveAttribute("data-muted", "true", {
        timeout: SLOW_MS,
      });
      expect(await rowIn(page, "Needs you", refs.asks).boundingBox()).toEqual(place);
      await shots(page, world, "linked-not-updating");
      world.monitor("");
      await expect(rowIn(page, "Needs you", refs.asks)).not.toHaveAttribute("data-muted", {
        timeout: SLOW_MS,
      });

      // The other space lists them with a link that opens the task in its own space.
      await signIn(page, world, `/s/${world.studio.id}/agents`);
      await showsSpace(page, world.studio.name);
      const link = page.getByRole("link", { name: `Task ${refs.asks} in ${world.mira.name}` });
      await expect(link).toBeVisible({ timeout: SLOW_MS });
      await shots(page, world, "other-space");
      await link.click();
      await showsSpace(page, world.mira.name);
      await expect(
        page.locator(`main li[data-task="${refs.asks}"] [data-part="title"]`),
      ).toHaveAttribute("aria-expanded", "true", { timeout: SLOW_MS });
    } finally {
      for (const ref of Object.values(refs)) world.release(ref);
      world.monitorAgents(null);
      world.monitor("");
      await world.machine("ui.theme", null);
      await context.close();
    }
  });
});
