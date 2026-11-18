// Run from the page (M6), in Chromium and Firefox against the real service process with fixture
// data: the fake Codex (fake-codex.ts) replays a real `codex app-server` recording as the
// instance's program, in the case each test picks. No real agent program is started.
//
// Verify line: Run with and without words, from the strip and with Ctrl+Shift+Enter; the run in
// the task's thread while it works, its answer (a long one folded), a question that needs the
// person, a failure in the agent's own words; Stop while it works; a queued run and why it waits;
// a refusal at the start that keeps the words; a reload and a second tab show the same run; the
// row's marker and the Agents view.
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_QUESTION, FAKE_SIGNED_OUT } from "./codex-cases.ts";
import { test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { CODEX_INSTANCE, CODEX_OTHER, SLOW_MS, type World } from "./world.ts";

const OTHER_LABEL = CODEX_OTHER.label;

/** What a run asks for when the person typed nothing (the service's runs/agent.ts). */
const WORK_ON_IT = "Work on this task until it is done, then reply with what you did.";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

async function addTask(world: World, title: string): Promise<string> {
  const tag = test.info().project.name;
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [{ title: `${title} (${tag})`, area: "home" }],
  })) as Added;
  const ref = added.tasks[0]?.ref;
  if (ref === undefined) throw new Error("the task was not added");
  return ref;
}

const rowOf = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);
const composerOf = (page: Page, ref: string) => rowOf(page, ref).locator('[data-part="composer"]');
const stripOf = (page: Page, ref: string) =>
  rowOf(page, ref).getByRole("toolbar", { name: "Act on this task" });
const runButton = (page: Page, ref: string) =>
  stripOf(page, ref).getByRole("button", { name: `Run with ${CODEX_INSTANCE.label}` });
const runsOf = (page: Page, ref: string) => rowOf(page, ref).locator('[data-entry="run"]');
const stateOf = (entry: Locator) => entry.locator('[data-part="run-state"]');
const markerOf = (page: Page, ref: string) =>
  rowOf(page, ref).locator("[data-row-line] > span").first();
const toast = (page: Page) => page.locator('[data-part="toast-text"]');

async function openTask(page: Page, world: World, ref: string): Promise<void> {
  await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
  await showsSpace(page, world.mira.name);
  await expect(rowOf(page, ref).locator('[data-part="title"]')).toHaveAttribute(
    "aria-expanded",
    "true",
    { timeout: SLOW_MS },
  );
}

test.describe("[M6.page.e2e.run] Run from the page, with and without words, and read the answer", () => {
  test("Run without words works on the task; Ctrl+Shift+Enter runs with the words, which clear once queued; the answer is the agent's text, a long one folded", async ({
    page,
    runs: world,
  }) => {
    await watchViolations(page);
    const ref = await addTask(world, "Check the portal's appointment times");
    world.codex(ref, ["answer", "answer", "long"]);
    await openTask(page, world, ref);

    // The task has no folder: Run says it works in the space's work folder, as Open does.
    const run = runButton(page, ref);
    await expect(run).toHaveAttribute("aria-description", /work folder/u);
    await expect(run).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Enter");
    await run.click();
    const first = runsOf(page, ref).nth(0);
    await expect(first.locator('[data-part="run-asked"]')).toHaveText(
      "You asked it to work on the task.",
    );
    await expect(stateOf(first)).toContainText("Done.", { timeout: SLOW_MS });
    await expect(first.locator('[data-part="run-said"]')).toContainText(
      "Checked the portal's appointment times.",
    );
    await expect(first.locator('[data-part="run-said"]')).toContainText(`Asked: ${WORK_ON_IT}`);
    // The agent's list is Markdown, rendered as the thread renders text.
    await expect(first.locator('[data-part="run-said"] li')).toHaveText("They match since Sunday.");

    // With words, from the keyboard: the field clears once the service queued the run.
    const composer = composerOf(page, ref);
    await composer.fill("Compare them with last week's");
    await composer.press("Control+Shift+Enter");
    await expect(composer).toHaveValue("", { timeout: SLOW_MS });
    const second = runsOf(page, ref).nth(1);
    await expect(second.locator('[data-part="run-asked"]')).toHaveText(
      "You asked: Compare them with last week's",
    );
    await expect(stateOf(second)).toContainText("Done.", { timeout: SLOW_MS });
    await expect(second.locator('[data-part="run-said"]')).toContainText(
      "Asked: Compare them with last week's",
    );

    // A long answer is folded at ten lines until More.
    await run.click();
    const third = runsOf(page, ref).nth(2);
    await expect(stateOf(third)).toContainText("Done.", { timeout: SLOW_MS });
    const said = third.locator('[data-part="run-said"]');
    await expect(said).toHaveAttribute("data-clamped", "true");
    await expect(said.locator("li").first()).toHaveText("Checked part 1.");
    const more = third.getByRole("button", { name: "More" });
    await more.click();
    await expect(said).toHaveAttribute("data-clamped", "false");
    await expect(said.locator("li")).toHaveCount(80);
    await said.locator("li").last().scrollIntoViewIfNeeded();
    await expect(said.locator("li").last()).toBeInViewport();

    // The person's other agent is one click away, in the menu beside Run.
    await stripOf(page, ref).getByRole("button", { name: "Run with another agent" }).click();
    await page
      .getByRole("dialog", { name: "Run with another agent" })
      .getByRole("button", { name: `Run with ${OTHER_LABEL}` })
      .click();
    const fourth = runsOf(page, ref).nth(3);
    await expect(fourth).toContainText(OTHER_LABEL);
    await expect(stateOf(fourth)).toContainText("Done.", { timeout: SLOW_MS });
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[M6.page.e2e.stop] A run while it works: the row, a reload, a second tab and Stop", () => {
  test("a working run shows calmly in the thread and on the row, the same after a reload and in a second tab; Stop answers at once and then says what was ended", async ({
    page,
    runs: world,
  }) => {
    const ref = await addTask(world, "Watch the nightly export");
    world.codex(ref, ["hold"]);
    await openTask(page, world, ref);
    await runButton(page, ref).click();
    const entry = runsOf(page, ref).first();
    await expect(stateOf(entry)).toContainText(
      `${CODEX_INSTANCE.label} is working on it in the background.`,
      { timeout: SLOW_MS },
    );
    await expect(markerOf(page, ref)).toHaveAttribute("data-kind", "working", { timeout: SLOW_MS });

    // A reload shows the run as the service has it, not as the tab remembered it.
    await page.reload();
    await expect(stateOf(runsOf(page, ref).first())).toContainText("is working on it", {
      timeout: SLOW_MS,
    });
    // So does a second tab.
    const other = await page.context().newPage();
    await openTask(other, world, ref);
    await expect(stateOf(runsOf(other, ref).first())).toContainText("is working on it");

    await runsOf(page, ref).first().getByRole("button", { name: /^Stop/u }).click();
    await expect(stateOf(runsOf(page, ref).first())).toContainText(/Stopping|Stopped/u, {
      timeout: 5_000,
    });
    for (const tab of [page, other]) {
      await expect(stateOf(runsOf(tab, ref).first())).toContainText(/^Stopped\./u, {
        timeout: SLOW_MS,
      });
      await expect(stateOf(runsOf(tab, ref).first())).toContainText(
        /Nothing it started was left\.|What it left running was ended\.|ended what it could find of it\./u,
      );
      await expect(runsOf(tab, ref).first().getByRole("button", { name: /^Stop/u })).toHaveCount(0);
      await expect(markerOf(tab, ref)).not.toHaveAttribute("data-kind", "working");
    }
    await other.close();
  });

  test("a run queued behind the task's other run says why it waits, and starts once that one stopped", async ({
    page,
    runs: world,
  }) => {
    const ref = await addTask(world, "Rebuild the search index");
    world.codex(ref, ["hold", "answer"]);
    await openTask(page, world, ref);
    await runButton(page, ref).click();
    await expect(stateOf(runsOf(page, ref).first())).toContainText("is working on it", {
      timeout: SLOW_MS,
    });
    await composerOf(page, ref).fill("Then check the results");
    await runButton(page, ref).click();
    const queued = runsOf(page, ref).nth(1);
    await expect(stateOf(queued)).toContainText(
      "Waiting to start: this task's other run ends first.",
      { timeout: SLOW_MS },
    );
    // The first run's Codex has taken its case: the next is the queued run's.
    await expect.poll(() => world.codexLeft(ref), { timeout: SLOW_MS }).toEqual(["answer"]);
    await runsOf(page, ref).first().getByRole("button", { name: /^Stop/u }).click();
    await expect(stateOf(queued)).toContainText("Done.", { timeout: SLOW_MS });
    await expect(queued.locator('[data-part="run-said"]')).toContainText(
      "Asked: Then check the results",
    );
  });
});

test.describe("[M6.page.e2e.needs] A run that needs the person, and one that failed", () => {
  test("the agent's question is shown and findable from the row and Agents; a signed-out agent's failure is said in its own words", async ({
    page,
    runs: world,
  }) => {
    const ref = await addTask(world, "Prepare the monthly export");
    world.codex(ref, ["ask", "fail"]);
    await openTask(page, world, ref);
    await runButton(page, ref).click();
    const asked = runsOf(page, ref).first();
    await expect(stateOf(asked)).toContainText(
      `Needs you: ${CODEX_INSTANCE.label} asked a question and stopped.`,
      { timeout: SLOW_MS },
    );
    await expect(asked.locator('[data-part="run-said"]')).toContainText(FAKE_QUESTION);
    await expect(markerOf(page, ref)).toHaveAttribute("data-kind", "needs_input");

    // Agents lists it under Needs you, without opening the task.
    await page.goto(await world.signInUrl(`/s/${world.mira.id}/agents`));
    await showsSpace(page, world.mira.name);
    const needs = page.locator("main").getByText("Needs you", { exact: true });
    await expect(needs).toBeVisible({ timeout: SLOW_MS });
    await expect(rowOf(page, ref)).toBeVisible();
    await expect(markerOf(page, ref)).toHaveAttribute("data-kind", "needs_input");

    await openTask(page, world, ref);
    await runButton(page, ref).click();
    const failed = runsOf(page, ref).nth(1);
    await expect(stateOf(failed)).toContainText(`${CODEX_INSTANCE.label} ended with an error.`, {
      timeout: SLOW_MS,
    });
    await expect(failed.locator('[data-part="run-error"]')).toHaveText(
      `${FAKE_SIGNED_OUT} Sign in with: codex login`,
    );
    // The newest run no longer needs the person: the row's marker goes.
    await expect(markerOf(page, ref)).not.toHaveAttribute("data-kind", "needs_input");
  });
});

test.describe("[M6.page.e2e.refused] A run that cannot start says why and keeps the words", () => {
  test("a folder that is gone, and one whose marker is missing, start nothing and keep what was typed", async ({
    page,
    runs: world,
  }) => {
    const temp = mkdtempSync(join(tmpdir(), "tasks-e2e-run-"));
    try {
      const folder = join(temp, "portal");
      mkdirSync(folder);
      const ref = await addTask(world, "Tag the portal release");
      const base = ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string })
        .as_of;
      const set = (await world.op(world.mira.id, "folder.manage", {
        action: "set",
        task: ref,
        folder,
        base,
      })) as { folder: string };
      await openTask(page, world, ref);
      const composer = composerOf(page, ref);

      // The checkout is replaced at its path: its marker is missing.
      renameSync(folder, join(temp, "portal-aside"));
      mkdirSync(folder);
      await composer.fill("Tag it as 2.4");
      await runButton(page, ref).click();
      await expect(
        toast(page).filter({
          hasText: `This may not be the folder set for this task: its Tasks marker is missing. ${set.folder}.`,
        }),
      ).toBeVisible({ timeout: SLOW_MS });
      await expect(composer).toHaveValue("Tag it as 2.4");
      await expect(runsOf(page, ref)).toHaveCount(0);

      // The folder goes: the page says so, on the folder's line too.
      rmSync(folder, { recursive: true });
      await runButton(page, ref).click();
      await expect(
        toast(page).filter({
          hasText: `Folder not found on this computer: ${set.folder}. Nothing was started.`,
        }),
      ).toBeVisible({ timeout: SLOW_MS });
      await expect(rowOf(page, ref).locator('[data-part="place"]')).toHaveAttribute(
        "data-state",
        "missing",
      );
      await expect(composer).toHaveValue("Tag it as 2.4");
      await expect(runsOf(page, ref)).toHaveCount(0);
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
  });
});

test.describe("[M6.page.e2e.screens] A run's states in both themes: screenshots and axe", () => {
  test("working, queued, done, needs you and failed, at 1,440 px and 390 px in Sumi and Washi, axe clean", async ({
    browser,
    runs: world,
  }) => {
    // Two themes, two widths, two tasks and a check of each: slow, never stuck.
    test.setTimeout(420_000);
    const working = await addTask(world, "Screens: a run that works");
    const ended = await addTask(world, "Screens: runs that ended");
    world.codex(working, ["hold", "answer"]);
    world.codex(ended, ["answer", "fail", "ask"]);
    const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    ).newPage();
    await openTask(page, world, ended);
    for (const n of [0, 1, 2]) {
      await runButton(page, ended).click();
      await expect(stateOf(runsOf(page, ended).nth(n))).not.toContainText(/working|Waiting/u, {
        timeout: SLOW_MS,
      });
    }
    await openTask(page, world, working);
    await runButton(page, working).click();
    await expect(stateOf(runsOf(page, working).first())).toContainText("is working on it", {
      timeout: SLOW_MS,
    });
    await expect.poll(() => world.codexLeft(working), { timeout: SLOW_MS }).toEqual(["answer"]);
    await composerOf(page, working).fill("Then summarise what changed");
    await runButton(page, working).click();
    await expect(stateOf(runsOf(page, working).nth(1))).toContainText("Waiting to start");
    await page.context().close();

    for (const theme of ["sumi", "washi"] as const) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const shot = await context.newPage();
        await world.machine("ui.theme", theme);
        for (const ref of [working, ended]) {
          await openTask(shot, world, ref);
          const row = rowOf(shot, ref);
          await expect(runsOf(shot, ref).last()).toBeVisible();
          await row.scrollIntoViewIfNeeded();
          const name = ref === working ? "working" : "ended";
          await row.screenshot({ path: test.info().outputPath(`run-${name}-${theme}-1440.png`) });
          await shot.evaluate(axe);
          const found = await shot.evaluate(async (selector) => {
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
            const result = await run({ include: [selector] }, { resultTypes: ["violations"] });
            return result.violations.map(
              (v) => `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`,
            );
          }, `li[data-task="${ref}"]`);
          expect(found, `axe in ${theme}`).toEqual([]);
          await shot.setViewportSize({ width: 390, height: 900 });
          await runsOf(shot, ref).last().scrollIntoViewIfNeeded();
          const scroll = await shot.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
          await shot.screenshot({ path: test.info().outputPath(`run-${name}-${theme}-390.png`) });
          await shot.setViewportSize({ width: 1440, height: 1000 });
        }
        // The other agent that can run is one click away, in the menu beside Run.
        await openTask(shot, world, ended);
        await stripOf(shot, ended).getByRole("button", { name: "Run with another agent" }).click();
        await expect(
          shot
            .getByRole("dialog", { name: "Run with another agent" })
            .getByRole("button", { name: `Run with ${OTHER_LABEL}` }),
        ).toBeVisible();
        await rowOf(shot, ended).locator('[data-part="strip"]').scrollIntoViewIfNeeded();
        await shot.screenshot({ path: test.info().outputPath(`run-menu-${theme}-1440.png`) });
        await shot.keyboard.press("Escape");

        await shot.goto(await world.signInUrl(`/s/${world.mira.id}/agents`));
        await showsSpace(shot, world.mira.name);
        await expect(rowOf(shot, ended)).toBeVisible({ timeout: SLOW_MS });
        await expect(markerOf(shot, ended)).toHaveAttribute("data-kind", "needs_input");
        await expect(markerOf(shot, working)).toHaveAttribute("data-kind", "working");
        await shot.screenshot({ path: test.info().outputPath(`run-agents-${theme}-1440.png`) });
        await shot.setViewportSize({ width: 390, height: 900 });
        await shot.screenshot({ path: test.info().outputPath(`run-agents-${theme}-390.png`) });
      } finally {
        await context.close();
      }
    }
    await world.machine("ui.theme", null);
    // The run that works is stopped, so the world ends with no run of this test left.
    const last = await (await browser.newContext()).newPage();
    await openTask(last, world, working);
    await runsOf(last, working).first().getByRole("button", { name: /^Stop/u }).click();
    await expect(stateOf(runsOf(last, working).nth(1))).toContainText("Done.", {
      timeout: SLOW_MS,
    });
    await last.context().close();
  });
});
