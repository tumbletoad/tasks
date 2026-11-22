// An agent session that ended blocks nothing, in Chromium and Firefox against the real service
// process: Open, then the agent's end in each way it comes (it quits, its window closes, its shim
// is killed, the service restarts while it runs or while it ends), and what the thread, the strip
// and the row's tile show after it. The fake agent runs until the test releases it.
import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { test } from "./fixture.ts";
import { showsSpace } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

/** A new task of Mira's in the Inbox, for one test alone. */
async function newTask(world: World, title: string): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [{ title: `${title} (${test.info().project.name})`, inbox: true }],
  })) as { tasks: readonly { ref: string }[] };
  return added.tasks[0]?.ref ?? "";
}

/** The task expanded through its link, signed in: its row and the parts the tests read. */
async function expanded(page: Page, world: World, ref: string) {
  await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
  await showsSpace(page, world.mira.name);
  return parts(page.locator(`li[data-task="${ref}"]`));
}

function parts(row: Locator) {
  const strip = row.getByRole("toolbar");
  return {
    row,
    title: row.locator('[data-part="title"]'),
    tile: row.locator('[data-part="tile"]'),
    open: strip.getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` }),
    another: strip.getByRole("button", { name: `Open another in ${FAKE_INSTANCE.label}` }),
    entries: (state: string) => row.locator(`[data-entry="session"][data-state="${state}"]`),
    /** The words of the session entries in this state. */
    words: (state: string) =>
      row.locator(`[data-entry="session"][data-state="${state}"] [data-part="entry-text"]`),
  };
}

/** Whether the process is gone. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Ends a process outright, as a kill does: no handler of its own runs. */
function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone already.
  }
}

/** The shim of the task's latest launch: its process, from the fake terminal's record. */
function shimOf(world: World, before: number): number {
  const pid = world.terminal()[before]?.pid;
  if (pid === undefined) throw new Error("the fake terminal recorded no shim");
  return pid;
}

/** Opens the task's agent in the strip and waits until its session runs. */
async function openRunning(world: World, p: ReturnType<typeof parts>): Promise<number> {
  const before = world.terminal().length;
  const running = await p.entries("running").count();
  await p.open.click();
  await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
  await expect(p.entries("running")).toHaveCount(running + 1, { timeout: SLOW_MS });
  return shimOf(world, before);
}

test.describe("[A5.3.9.e2e.session-end] A session that ended blocks nothing", () => {
  test("the agent quits: the thread says it ended and how long it ran, and Open works again in the strip and on the tile, in a second tab too", async ({
    page,
    world,
  }) => {
    const ref = await newTask(world, "Answer the clinic's question");
    world.hold(ref);
    const p = await expanded(page, world, ref);
    // A second tab shows the same task's row, not expanded.
    const other = await page.context().newPage();
    await other.goto(await world.signInUrl(`/s/${world.mira.id}/inbox`));
    await showsSpace(other, world.mira.name);
    const q = parts(other.locator(`li[data-task="${ref}"]`));
    await expect(q.tile).toHaveAttribute("data-state", "ready");

    await openRunning(world, p);
    await expect(p.words("running")).toHaveText(`Opened in ${FAKE_INSTANCE.label} · running`);
    await expect(p.another).toHaveAttribute("data-state", "running");
    await expect(q.tile).toHaveAttribute("data-state", "running", { timeout: SLOW_MS });

    // The agent quits: no tab shows it as running any more.
    world.release(ref);
    await expect(p.entries("ended")).toHaveCount(1, { timeout: SLOW_MS });
    await expect(p.words("ended")).toHaveText(
      new RegExp(`^Opened in ${FAKE_INSTANCE.label} · ended after \\d+ s$`, "u"),
    );
    await expect(p.entries("running")).toHaveCount(0);
    await expect(q.tile).toHaveAttribute("data-state", "ready", { timeout: SLOW_MS });
    await expect(p.open).toHaveAttribute("data-state", "ready");
    await expect(p.open).toHaveAttribute("aria-disabled", "false");

    // Open works again at once, from the second tab's tile.
    const before = world.terminal().length;
    await q.tile.click();
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
    await expect(p.entries("ended").or(p.entries("running"))).toHaveCount(2, { timeout: SLOW_MS });
    await other.close();
  });

  test("a tab opened while a session runs shows it running at once, and its tile starts no second one", async ({
    page,
    world,
  }) => {
    const ref = await newTask(world, "Plan the reminder rollout");
    world.hold(ref);
    const p = await expanded(page, world, ref);
    await openRunning(world, p);
    // A new tab, its row collapsed: it never read this task's receipts.
    const other = await page.context().newPage();
    await other.goto(await world.signInUrl(`/s/${world.mira.id}/inbox`));
    await showsSpace(other, world.mira.name);
    const q = parts(other.locator(`li[data-task="${ref}"]`));
    await expect(q.tile).toHaveAttribute("data-state", "running", { timeout: SLOW_MS });
    const before = world.terminal().length;
    await q.tile.click();
    await expect(q.another).toHaveAttribute("data-state", "running");
    await other.waitForTimeout(1_000);
    expect(world.terminal()).toHaveLength(before);
    world.release(ref);
    await expect(q.tile).toHaveAttribute("data-state", "ready", { timeout: SLOW_MS });
    await other.close();
  });

  test("a double click on Open starts one session", async ({ page, world }) => {
    const ref = await newTask(world, "Check the reminder texts");
    world.hold(ref);
    const p = await expanded(page, world, ref);
    const before = world.terminal().length;
    await p.open.dblclick();
    await expect(p.entries("running")).toHaveCount(1, { timeout: SLOW_MS });
    expect(world.terminal()).toHaveLength(before + 1);
    await expect(p.row.locator('[data-entry="session"]')).toHaveCount(1);
    world.release(ref);
    await expect(p.entries("ended")).toHaveCount(1, { timeout: SLOW_MS });
  });

  test("its window closes: the session is no longer shown as running, and Open works again", async ({
    page,
    world,
  }) => {
    const ref = await newTask(world, "Close the window on the export");
    world.hold(ref);
    const p = await expanded(page, world, ref);
    const shim = await openRunning(world, p);
    if (process.platform === "win32") {
      // A console window that closes takes its processes with it.
      kill(shim);
      for (const agent of world.heldAgents(ref)) kill(agent);
    } else {
      // The window's hang-up reaches its process group: the shim and the agent.
      process.kill(-shim, "SIGHUP");
    }
    await expect(p.entries("running")).toHaveCount(0, { timeout: SLOW_MS });
    await expect(p.entries("ended").or(p.entries("opened"))).toHaveCount(1);
    await expect(p.open).toHaveAttribute("aria-disabled", "false");
    world.release(ref);
    await p.title.click();
    await expect(p.tile).toHaveAttribute("data-state", "ready");
  });

  test("its shim is killed: the session is shown as opened, never as running, and Open works again", async ({
    page,
    world,
  }) => {
    const ref = await newTask(world, "Kill the shim of the import");
    world.hold(ref);
    const p = await expanded(page, world, ref);
    const shim = await openRunning(world, p);
    // Killed outright: no report reaches the service. The agent it started runs on unseen.
    kill(shim);
    await expect(p.entries("opened")).toHaveCount(1, { timeout: SLOW_MS });
    await expect(p.words("opened")).toHaveText(`Opened in ${FAKE_INSTANCE.label}`);
    await expect(p.entries("running")).toHaveCount(0);
    await expect(p.open).toHaveAttribute("aria-disabled", "false");
    world.release(ref);
  });

  test("a launch an earlier build recorded as Confirmed without an end is shown as opened, never as running", async ({
    page,
    world,
  }) => {
    const p = await expanded(page, world, world.launched);
    await expect(p.entries("opened")).toHaveCount(1, { timeout: SLOW_MS });
    await expect(p.words("opened")).toHaveText("Opened in codex-work");
    await expect(p.entries("running")).toHaveCount(0);
    await expect(p.open).toHaveAttribute("aria-disabled", "false");
  });

  test("the service restarts while the session runs, then while it ends: it runs on, then shows as ended", async ({
    page,
    restartable,
  }) => {
    const world = restartable;
    const ref = await newTask(world, "Restart during the migration");
    world.hold(ref);
    let p = await expanded(page, world, ref);
    const shim = await openRunning(world, p);

    // A restart while it runs: the shim is still there, so the session still runs.
    await world.restart();
    p = await expanded(page, world, ref);
    await expect(p.entries("running")).toHaveCount(1, { timeout: SLOW_MS });
    await expect(p.another).toHaveAttribute("aria-disabled", "false");

    // The agent quits while the service is stopped: its shim keeps the end in exit.json and goes.
    await world.restart(async () => {
      world.release(ref);
      await expect.poll(() => gone(shim), { timeout: SLOW_MS }).toBe(true);
    });
    p = await expanded(page, world, ref);
    await expect(p.entries("ended")).toHaveCount(1, { timeout: SLOW_MS });
    await expect(p.words("ended")).toHaveText(/ · ended after \d+ (s|min)$/u);
    await expect(p.entries("running")).toHaveCount(0);
    await expect(p.open).toHaveAttribute("aria-disabled", "false");
    await p.title.click();
    await expect(p.tile).toHaveAttribute("data-state", "ready");
  });

  test("screens: running, ended, did not start and opened, at 1,440 and 390 px in Sumi and Washi", async ({
    page,
    world,
  }) => {
    test.setTimeout(SLOW_MS * 4);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ref = await newTask(world, "Review the appointment export");
    // An agent that cannot start: it ends at once.
    world.hold(ref, 1);
    let p = await expanded(page, world, ref);
    await p.open.click();
    await expect(p.entries("failed")).toHaveCount(1, { timeout: SLOW_MS });
    await expect(p.words("failed")).toHaveText(
      "Did not open: the agent ended right after it started",
    );
    // One whose shim is killed: opened, its state unknown.
    world.hold(ref);
    kill(await openRunning(world, p));
    await expect(p.entries("opened")).toHaveCount(1, { timeout: SLOW_MS });
    // One that ended, and one that runs.
    await openRunning(world, p);
    world.release(ref);
    await expect(p.entries("ended")).toHaveCount(1, { timeout: SLOW_MS });
    world.hold(ref);
    await openRunning(world, p);

    for (const theme of ["sumi", "washi"] as const) {
      await world.machine("ui.theme", theme);
      // Signed in where the sidebar names the space, then narrowed.
      await page.setViewportSize({ width: 1440, height: 900 });
      p = await expanded(page, world, ref);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const state of ["failed", "opened", "ended", "running"]) {
          await expect(p.entries(state)).toHaveCount(1, { timeout: SLOW_MS });
        }
        await expect(p.another).toBeVisible();
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, `horizontal scroll at ${String(width)} px`).toBeLessThanOrEqual(0);
        await p.row.scrollIntoViewIfNeeded();
        await p.row.screenshot({
          path: test.info().outputPath(`sessions-${theme}-${String(width)}.png`),
        });
      }
    }
    await world.machine("ui.theme", null);
    world.release(ref);
    await expect(p.entries("ended")).toHaveCount(2, { timeout: SLOW_MS });
  });
});
