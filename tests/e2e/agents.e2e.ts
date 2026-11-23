// The Agents page with the Agent Monitor end to end, in Chromium and Firefox, against the real
// service process: without TTAM the page is as it was plus one quiet line; with the test kit's
// fake `ttam`, steered through the world, every state of the monitor in words, at 1,440 and
// 390 px and in both themes, axe clean, with nothing to reach by pointer only and nothing of the
// monitor in the browser's storage or in a URL. The fake holds each passing state (before its
// hello, or before an answer) until the test has checked it: no state waits on a real answer's
// time. Fixture data only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { axeFound, picture, pictures, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

/** Text of the recorded conversations that must stay on the page and in the service. */
const PRIVATE = [
  "synthetic-project",
  "Release checklist",
  "API documentation",
  "Survey the fixtures",
  "/home/mira",
  "11111111-2222-4333-8444-555555555555",
];

const status = (page: Page) => page.locator('[data-part="monitor-status"]');
const usageStatus = (page: Page) => page.locator('[data-part="usage-status"]');
const note = (page: Page) => page.locator('[data-part="monitor-note"]');
const sessions = (page: Page) => page.locator('[data-part="session"]');
const computer = (page: Page) => page.locator('[data-part="computer"]');
const usage = (page: Page) => page.locator('[data-part="usage"]');

async function openAgents(page: Page, world: World): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}/agents`);
  await showsSpace(page, world.mira.name);
}

/** The parts of the monitor on the page now, for axe. */
async function parts(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const part of ["computer", "usage", "monitor-note"]) {
    if ((await page.locator(`[data-part="${part}"]`).count()) > 0)
      found.push(`[data-part="${part}"]`);
  }
  return found;
}

/** The state in this theme at 1,440 and 390 px: pictures, axe and no sideways scroll. */
async function widths(page: Page, name: string, theme: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await picture(page, `agents-${name}-${theme}-1440.png`, { fullPage: true });
  if (pictures()) expect(await axeFound(page, await parts(page)), `axe in ${theme}`).toEqual([]);
  await page.setViewportSize({ width: 390, height: 900 });
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
  await picture(page, `agents-${name}-${theme}-390.png`, { fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

/** The state in every theme of this browser, at both widths. */
async function shots(page: Page, world: World, name: string): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme, { timeout: SLOW_MS });
    await widths(page, name, theme);
  }
}

/** Both of the monitor's parts show a picture that is not current, with its age. */
async function notCurrent(page: Page): Promise<void> {
  await expect(computer(page)).toHaveAttribute("data-stale", "true", { timeout: SLOW_MS });
  await expect(usage(page)).toHaveAttribute("data-stale", "true");
  await expect(status(page)).toContainText("Not updating: this is what TTAM saw");
  await expect(usageStatus(page)).toContainText("Not updating: this is what TTAM saw");
  // Nothing in either part speaks of now.
  await expect(usage(page)).not.toContainText("Checking now");
}

test.describe("[A5.agents.e2e.none] without TTAM the Agents page is as it was, plus one quiet line", () => {
  test("TTasks' own part, one line about TTAM, and no part of the monitor", async ({
    page,
    world,
  }) => {
    await openAgents(page, world);
    await expect(note(page)).toHaveText(
      "With TTAM installed, this page also shows every agent on this computer.",
      { timeout: SLOW_MS },
    );
    await expect(computer(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Plan usage" })).toHaveCount(0);
  });
});

test.describe("[A5.agents.e2e.screens] every state of the monitor on the Agents page, in both themes and at both widths", () => {
  test("looking, settling, agents and plan usage, none running, a lost service, not updating, failed, not installed and either side to update", async ({
    browser,
    monitored: world,
  }) => {
    // Ten states, two themes, two widths, and a restart of the service.
    test.setTimeout(600_000);
    const context = await browser.newContext({
      bypassCSP: true,
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const urls: string[] = [];
    try {
      const page = await context.newPage();
      page.on("request", (request) => {
        urls.push(request.url());
      });

      // Looking: TTAM is held before its hello.
      world.monitor("hold");
      await openAgents(page, world);
      await expect(status(page)).toHaveText("Looking for agents on this computer.", {
        timeout: SLOW_MS,
      });
      // TTasks' own rows are there at once, above the monitor's part.
      await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
      await shots(page, world, "looking");

      world.monitor("settling");
      await expect(status(page)).toHaveText(
        "Still looking: an agent may be missing for a moment.",
        { timeout: SLOW_MS },
      );
      await shots(page, world, "settling");

      world.monitor("");
      await expect(sessions(page)).toHaveCount(5, { timeout: SLOW_MS });
      await expect(status(page)).toHaveText("");
      await expect(sessions(page).first()).toContainText("Working");
      await expect(page.locator('[data-part="account"]')).toHaveCount(5);
      // Nothing in the monitor's parts asks for a pointer: they hold no control at all.
      await expect(
        page
          .locator('[data-part="computer"], [data-part="usage"]')
          .locator("a, button, input, [tabindex]"),
      ).toHaveCount(0);
      await shots(page, world, "sessions");

      // A row of TTasks' own keeps its focus and its place while the monitor's parts change.
      await world.agentLog(world.mira.id, world.task.id, "Checked the fixtures");
      const row = page.locator(`main li[data-task="${world.task.ref}"]`);
      await expect(row).toBeVisible({ timeout: SLOW_MS });
      const title = row.locator('[data-part="title"]');
      await title.focus();
      const place = (await row.boundingBox())?.y;
      expect(place).toBeDefined();
      world.monitor("no_agents");
      await expect(status(page)).toHaveText("TTAM sees no agent on this computer.", {
        timeout: SLOW_MS,
      });
      await expect(title).toBeFocused();
      expect((await row.boundingBox())?.y).toBe(place);
      world.monitor("");
      await expect(sessions(page)).toHaveCount(5, { timeout: SLOW_MS });
      await expect(title).toBeFocused();
      expect((await row.boundingBox())?.y).toBe(place);
      world.monitor("no_agents");
      await expect(status(page)).toHaveText("TTAM sees no agent on this computer.", {
        timeout: SLOW_MS,
      });
      await shots(page, world, "empty");

      // The service goes away (an update, a restart): what the page shows is as it was.
      world.monitor("");
      await expect(sessions(page)).toHaveCount(5, { timeout: SLOW_MS });
      await world.restart(async () => {
        await notCurrent(page);
        await expect(
          page.getByText("TTasks's service is not running. Trying again."),
        ).toBeVisible();
        const theme = (await page.locator("html").getAttribute("data-theme")) ?? "sumi";
        await widths(page, "offline", theme);
      });
      await openAgents(page, world);
      await expect(sessions(page)).toHaveCount(5, { timeout: SLOW_MS });

      // Not updating: an answer is held, and is soon overdue.
      world.monitor("hold");
      await expect(status(page)).toContainText("TTAM has not answered for a while.", {
        timeout: SLOW_MS,
      });
      await notCurrent(page);
      await shots(page, world, "not-updating");
      world.monitor("");
      await expect(status(page)).toHaveText("", { timeout: SLOW_MS });
      await expect(computer(page)).not.toHaveAttribute("data-stale");

      // Failed: the child ends mid-answer, again each time it is started.
      world.monitor("die");
      await expect(status(page)).toContainText(
        "TTAM stopped answering. If this lasts, run ttam doctor.",
        { timeout: SLOW_MS },
      );
      await notCurrent(page);
      await expect(sessions(page)).toHaveCount(5);
      await shots(page, world, "failed");

      // Not installed: the next start finds no TTAM. Only the quiet line is left.
      world.monitor("none");
      await expect(note(page)).toHaveText(
        "With TTAM installed, this page also shows every agent on this computer.",
        { timeout: SLOW_MS },
      );
      await expect(computer(page)).toHaveCount(0);
      await shots(page, world, "not-installed");

      // Does not fit, either way: opening the page looks again.
      world.monitor("version=9,1");
      await openAgents(page, world);
      await expect(note(page)).toContainText("newer than TTasks can read. Update TTasks", {
        timeout: SLOW_MS,
      });
      await shots(page, world, "newer");
      world.monitor("version=3,1");
      await openAgents(page, world);
      await expect(note(page)).toContainText("older than TTasks can read. Update TTAM", {
        timeout: SLOW_MS,
      });
      await shots(page, world, "older");

      // Nothing of the monitor in the browser's storage, or in any address the page asked for.
      const kept = await page.evaluate(async () => {
        const all: string[] = [];
        for (const store of [localStorage, sessionStorage]) {
          for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i) ?? "";
            all.push(key, store.getItem(key) ?? "");
          }
        }
        for (const db of await indexedDB.databases()) all.push(db.name ?? "");
        all.push(document.cookie);
        return all.join("\n");
      });
      for (const text of PRIVATE) {
        expect(kept, "the browser's storage").not.toContain(text);
        expect(
          urls.filter((url) => url.includes(encodeURIComponent(text)) || url.includes(text)),
        ).toEqual([]);
      }
    } finally {
      world.monitor("");
      await world.machine("ui.theme", null);
      await context.close();
    }
  });
});
