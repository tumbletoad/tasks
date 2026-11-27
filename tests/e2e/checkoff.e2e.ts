// A check-off and a move to the Trash, against the real service in Chromium and Firefox: in a list
// of a few hundred tasks the row shows checked and leaves while the write is still on its way, an
// expanded card and a search result stay checked, and none shows open again, however late the
// answer comes. The page's answer is held with a route;
// each frame's state of the row is recorded in the page. Fixture data only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { showsSpace, signIn } from "./page.ts";
import { SLOW_MS, startWorld, type World } from "./world.ts";

const rowOf = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);

/** Adds `count` fixture tasks to Home, in requests the service takes. */
async function addMany(world: World, count: number, tag: string): Promise<string[]> {
  const refs: string[] = [];
  for (let start = 0; start < count; start += 20) {
    const tasks = Array.from({ length: Math.min(20, count - start) }, (_, i) => ({
      title: `Fixture task ${String(start + i)} (${tag})`,
      area: "home",
    }));
    const added = (await world.op(world.mira.id, "task.add", { tasks })) as {
      tasks: { ref: string }[];
    };
    refs.push(...added.tasks.map((task) => task.ref));
  }
  return refs;
}

/** Records the row's state in every frame from now on: "open", "checked" or "gone". */
async function watchRow(page: Page, ref: string): Promise<() => Promise<string[]>> {
  await page.evaluate((ref) => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    const tick = () => {
      const row = document.querySelector(`main li[data-task="${ref}"]`);
      const box = row?.querySelector<HTMLInputElement>('[data-part="check"]');
      const state = row === null ? "gone" : box?.checked === true ? "checked" : "open";
      if (seen.at(-1) !== state) seen.push(state);
      requestAnimationFrame(tick);
    };
    tick();
  }, ref);
  return () => page.evaluate(() => (window as unknown as { seen: string[] }).seen);
}

/** Holds every request to `path` until the returned function lets them go. */
async function hold(page: Page, path: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/op/${path}`, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

test.describe("[A5.3.12.e2e.checkoff-leaves] A checked-off task leaves at once and never shows open again", () => {
  test("in a list of a few hundred tasks, a check-off and a move to the Trash take the row away while the answer is held, and it stays away once the answer and the feed come", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const ui = process.env["E2E_UI_BUILD"];
    if (ui === undefined) throw new Error("global-setup.ts did not build the page");
    // A world of its own: the worker's shared one keeps the size the other tests count on.
    const world = await startWorld(ui);
    try {
      await checkOffAndTrash(page, world);
    } finally {
      await world.close();
    }
  });
});

test.describe("[A5.3.12.e2e.checkoff-pending] A task checked off in its card or in Search stays checked while its write is on its way", () => {
  test("with the answer held past the hold, an expanded card and a search result stay checked, and never show open", async ({
    page,
    world,
  }) => {
    const word = `marigold${test.info().project.name}${String(test.info().workerIndex)}`;
    const added = (await world.op(world.mira.id, "task.add", {
      tasks: [
        { title: `Water the ${word} bed`, area: "home" },
        { title: `Feed the ${word} pots`, area: "home" },
      ],
    })) as { tasks: { ref: string }[] };
    const [card, found] = added.tasks.map((task) => task.ref);
    if (card === undefined || found === undefined) throw new Error("the tasks were not added");
    const lifecycleOf = async (task: string) =>
      ((await world.op(world.mira.id, "task.get", { task })) as { task: { lifecycle: string } })
        .task.lifecycle;
    // The page's own clock: the hold ends when the test moves it, whatever the machine's speed.
    await page.clock.install();

    // The card, expanded from its link.
    await signIn(page, world, `/s/${world.mira.id}/task/${card}`);
    await showsSpace(page, world.mira.name);
    const cardRow = rowOf(page, card);
    await expect(cardRow.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
      timeout: SLOW_MS,
    });
    let release = await hold(page, "task.finish");
    let seen = await watchRow(page, card);
    await cardRow.locator('[data-part="check"]').first().click();
    await page.clock.runFor(2_000);
    await expect(cardRow.locator('[data-part="check"]').first()).toBeChecked();
    release();
    await expect.poll(() => lifecycleOf(card)).toBe("completed");
    await expect(cardRow.locator('[data-part="check"]').first()).toBeChecked();
    expect(await seen()).toEqual(["open", "checked"]);
    await page.unroute("**/api/v1/op/task.finish");

    // A search result, collapsed.
    await page.goto(`${world.origin}/s/${world.mira.id}/search?q=${word}`);
    const foundRow = rowOf(page, found);
    await expect(foundRow).toBeVisible({ timeout: SLOW_MS });
    release = await hold(page, "task.finish");
    seen = await watchRow(page, found);
    await foundRow.locator('[data-part="check"]').click();
    await page.clock.runFor(2_000);
    await expect(foundRow.locator('[data-part="check"]')).toBeChecked();
    release();
    await expect.poll(() => lifecycleOf(found)).toBe("completed");
    await expect(foundRow.locator('[data-part="check"]')).toBeChecked();
    expect(await seen()).toEqual(["open", "checked"]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

async function checkOffAndTrash(page: Page, world: World): Promise<void> {
  const tag = test.info().project.name;
  const [done, trashed] = await addMany(world, 240, tag);
  if (done === undefined || trashed === undefined) throw new Error("the tasks were not added");
  await signIn(page, world, `/s/${world.mira.id}/today`);
  await showsSpace(page, world.mira.name);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /^Home, / })
    .click();
  await expect(page.locator("[data-list]")).toHaveAttribute("data-virtual", "true", {
    timeout: SLOW_MS,
  });

  // The check-off: checked at once, gone while its answer is held.
  await expect(rowOf(page, done)).toBeVisible({ timeout: SLOW_MS });
  const finish = await hold(page, "task.finish");
  const doneSeen = await watchRow(page, done);
  await rowOf(page, done).locator('[data-part="check"]').click();
  await expect(rowOf(page, done)).toHaveCount(0);
  finish();
  await expect
    .poll(async () => {
      const got = (await world.op(world.mira.id, "task.get", { task: done })) as {
        task: { lifecycle: string };
      };
      return got.task.lifecycle;
    })
    .toBe("completed");
  await expect(rowOf(page, done)).toHaveCount(0);
  expect(await doneSeen()).toEqual(["open", "checked", "gone"]);

  // Move to Trash by its key: gone while its answer is held, and gone after.
  const moved = await hold(page, "task.delete");
  const trashSeen = await watchRow(page, trashed);
  await rowOf(page, trashed).locator('[data-part="title"]').focus();
  await page.keyboard.press("Delete");
  await expect(rowOf(page, trashed)).toHaveCount(0);
  moved();
  await expect
    .poll(async () => {
      const got = (await world.op(world.mira.id, "task.get", { task: trashed })) as {
        task: { deleted?: unknown };
      };
      return got.task.deleted !== undefined;
    })
    .toBe(true);
  await expect(rowOf(page, trashed)).toHaveCount(0);
  expect(await trashSeen()).toEqual(["open", "gone"]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
}
