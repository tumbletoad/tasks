// The Agents page with the Agent Monitor end to end, in Chromium and Firefox, against the real
// service process: without TTAM the page is as it was plus one quiet line; with the test kit's
// fake `ttam`, steered through the world, every state of the monitor in words, at 1,440 and
// 390 px and in both themes, axe clean, with nothing to reach by pointer only and nothing of the
// monitor in the browser's storage or in a URL. Fixture data only.
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
const note = (page: Page) => page.locator('[data-part="monitor-note"]');
const sessions = (page: Page) => page.locator('[data-part="session"]');
const computer = (page: Page) => page.locator('[data-part="computer"]');

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

/** The state in every theme of this browser, at 1,440 and 390 px: pictures, axe and no sideways scroll. */
async function shots(page: Page, world: World, name: string): Promise<void> {
  for (const theme of themes()) {
    await world.machine("ui.theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme, { timeout: SLOW_MS });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await picture(page, `agents-${name}-${theme}-1440.png`, { fullPage: true });
    if (pictures()) expect(await axeFound(page, await parts(page)), `axe in ${theme}`).toEqual([]);
    await page.setViewportSize({ width: 390, height: 900 });
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
    await picture(page, `agents-${name}-${theme}-390.png`, { fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  test("looking, settling, agents and plan usage, none running, not updating, failed, not installed and either side to update", async ({
    browser,
    monitored: world,
  }) => {
    // Nine states, two themes, two widths, and the waits a stalled monitor takes: slow, never stuck.
    test.setTimeout(900_000);
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

      // Looking: TTAM answers its first request slowly.
      world.monitor("slow=20000");
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

      world.monitor("no_agents");
      await expect(status(page)).toHaveText("No agent is running on this computer.", {
        timeout: SLOW_MS,
      });
      await shots(page, world, "empty");

      // Not updating: an answer is overdue, and the last picture stays with its age.
      world.monitor("");
      await expect(sessions(page)).toHaveCount(5, { timeout: SLOW_MS });
      world.monitor("slow=40000");
      await expect(status(page)).toContainText("TTAM has not answered for a while.", {
        timeout: SLOW_MS,
      });
      await shots(page, world, "not-updating");
      world.monitor("");
      await expect(status(page)).toHaveText("", { timeout: SLOW_MS });

      // Failed: the child ends mid-answer, again each time it is started.
      world.monitor("die");
      await expect(status(page)).toContainText(
        "TTAM stopped answering. If this lasts, run ttam doctor.",
        { timeout: SLOW_MS },
      );
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
      await expect(note(page)).toContainText("Update TTasks", { timeout: SLOW_MS });
      await shots(page, world, "newer");
      world.monitor("version=3,1");
      await openAgents(page, world);
      await expect(note(page)).toContainText("Update TTAM", { timeout: SLOW_MS });
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
