// The live store in the page (A7 3.12 M5.02; A5 3.15), in Chromium and Firefox against the real
// service process with fixture data. Every change is made outside the page, by an agent or at the
// terminal, and reaches the page only through the feed.
//
// Verify line, second sentence, in the Inbox: a task that starts to match the open view (added, or
// reopened) appears without a reload, and one that leaves it (completed) goes.
import { expect } from "@playwright/test";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn } from "./page.ts";
import { SLOW_MS } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref?: string }[];
}

test.describe("[A7.3.12.m5-02.e2e.live] The live store in the page", () => {
  test("a task that starts to match the open view appears, one that leaves goes, a burst lands whole", async ({
    page,
    world,
  }) => {
    const space = world.mira.id;
    // The Inbox: the agent's tasks land there.
    await signIn(page, world, `/s/${space}/inbox`);
    await showsSpace(page, world.mira.name);
    const project = test.info().project.name;

    // An agent adds a task: the page shows it without a reload.
    const title = `Renew the parking permit (${project})`;
    const added = (await world.op(
      space,
      "task.add",
      { tasks: [{ title, inbox: true }] },
      "agent",
    )) as Added;
    const ref = added.tasks[0]?.ref ?? "";
    const row = page.locator(`li[data-task="${ref}"]`);
    await expect(row.locator('[data-part="title"]')).toHaveText(title, { timeout: SLOW_MS });

    // Completed at the terminal, it leaves the open view; reopened, it is back.
    const base = async () =>
      ((await world.op(space, "task.get", { task: ref })) as { as_of: string }).as_of;
    await world.op(space, "task.finish", { task: ref, base: await base() });
    await expect(row).toHaveCount(0, { timeout: SLOW_MS });
    await world.op(space, "task.reopen", { task: ref, reason: "Not yet", base: await base() });
    await expect(row.locator('[data-part="title"]')).toHaveText(title, { timeout: SLOW_MS });

    // A burst of agent writes, side by side: every task lands, once.
    const burst = Array.from({ length: 12 }, (_, i) => `Label box ${String(i + 1)} (${project})`);
    await Promise.all(
      burst.map((t) =>
        world.op(space, "task.add", { tasks: [{ title: t, inbox: true }] }, "agent"),
      ),
    );
    for (const t of burst) {
      await expect(page.locator('[data-part="title"]', { hasText: t })).toHaveCount(1, {
        timeout: SLOW_MS,
      });
    }

    // An edit to a shown row changes it in place.
    await world.op(space, "task.update", {
      task: ref,
      set: { title: `${title}, online` },
      base: await base(),
    });
    await expect(row.locator('[data-part="title"]')).toHaveText(`${title}, online`, {
      timeout: SLOW_MS,
    });
    await picture(page, "live-store.png");
  });

  test("a task added in the page empties its field at Enter, and its row comes with the feed before the add's answer", async ({
    page,
    world,
  }) => {
    await signIn(page, world, `/s/${world.mira.id}/inbox`);
    const field = page.getByRole("textbox", { name: "New task" });
    const title = `Order printer paper (${test.info().project.name})`;
    // The add's answer is held back: the feed's event confirms the add before the answer arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered!: () => void;
    const given = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    await page.route("**/api/v1/op/task.add", async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
      delivered();
    });
    await field.fill(title);
    await field.press("Enter");
    await expect(field).toHaveValue("");
    await expect(page.locator('[data-part="title"]', { hasText: title })).toHaveCount(1, {
      timeout: SLOW_MS,
    });
    release();
    await given;
    await page.unroute("**/api/v1/op/task.add");
  });
});
