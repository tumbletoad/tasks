// The skeleton page when answers arrive late (A7 3.9 M2.13; A5 3.6, 3.9, 3.13), in Chromium and
// Firefox against the real service process. Each held answer is the service's real answer, given to
// the page only later, the way a slow connection would.
import { expect, type Route } from "@playwright/test";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { test } from "./fixture.ts";
import { SLOW_MS } from "./world.ts";

/** Holds the service's answer to the first request a route sees, until `release`. */
function holdFirst() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let caught!: (body: string) => void;
  const held = new Promise<string>((resolve) => {
    caught = resolve;
  });
  let delivered!: () => void;
  const given = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let first = true;
  const handler = async (route: Route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    const response = await route.fetch();
    caught(await response.text());
    await gate;
    await route.fulfill({ response });
    delivered();
  };
  return { handler, held, release, given };
}

test.describe("[A7.3.9.m2-13.e2e.races] Late answers and repeated clicks", () => {
  test("a late receipt list keeps Running; a Running tile expands its row, and the strip opens another only on purpose @one-browser", async ({
    page,
    world,
  }) => {
    await page.goto(await world.signInUrl(`/s/${world.mira.id}/area/${world.spare.area}`));
    // Its own task: the open test launches `world.task`, and a worker's tests share the world.
    world.hold(world.spare.ref);
    const row = page.locator(`li[data-task="${world.spare.ref}"]`);
    const main = row.locator('[data-part="title"]');
    const tile = row.locator('[data-part="tile"]');
    // The row's one tile is the effective instance's (A5 3.6). An expanded row hides it (A5 3.7):
    // the expanded row's strip has a button per instance, which opens like a Ready tile.
    await expect(tile).toHaveAccessibleName(`Open in ${FAKE_INSTANCE.label}`);
    await Promise.all([page.waitForResponse("**/api/v1/launch/list"), main.click()]);
    await expect(main).toHaveAttribute("aria-expanded", "true");

    // The first receipt list after the click answers only after the session runs.
    const list = holdFirst();
    await page.route("**/api/v1/launch/list", list.handler);
    const before = world.terminal().length;
    const strip = row
      .getByRole("toolbar")
      .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` });
    await strip.click();
    // The held answer was read before the fake shim confirmed: it shows this launch in an earlier
    // state. The seeded space may hold older receipts of the task, Confirmed ones included, from
    // other instances (testkit's seedMira), so only the fake instance's receipts count.
    const held = JSON.parse(await list.held) as {
      result: { receipts: { instance: string; state: string }[] };
    };
    const ours = held.result.receipts.filter((r) => r.instance === FAKE_INSTANCE.key);
    expect(ours.map((r) => r.state)).not.toContain("confirmed");
    // This launch's entry: the seeded space holds no running session.
    const running = row.locator('[data-entry][data-state="running"]');
    await expect(running).toBeVisible({ timeout: SLOW_MS });
    await expect(running).toContainText(`Opened in ${FAKE_INSTANCE.label} · running`);
    await expect(tile).toHaveAttribute("data-state", "running");
    list.release();
    await list.given;
    // Give the page time to apply the late answer; it must not.
    await page.waitForTimeout(1_000);
    await expect(running).toBeVisible();
    await expect(tile).toHaveAttribute("data-state", "running");
    await page.unroute("**/api/v1/launch/list");

    // Running: a click on the tile expands the row and starts nothing.
    await main.click();
    await expect(main).toHaveAttribute("aria-expanded", "false");
    await tile.click();
    await expect(main).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(1_000);
    expect(world.terminal()).toHaveLength(before + 1);
    // The strip says the session runs, and opens a second one when the person asks for it.
    const another = row
      .getByRole("toolbar")
      .getByRole("button", { name: `Open another in ${FAKE_INSTANCE.label}` });
    await expect(another).toHaveAttribute("data-state", "running");
    await expect(another).toHaveAttribute("aria-disabled", "false");
    await expect(another).toHaveAccessibleDescription(/is running on this task/u);
    await another.click();
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 2);
    await expect(row.locator('[data-entry][data-state="running"]')).toHaveCount(2, {
      timeout: SLOW_MS,
    });
    // Both end: nothing runs, and the strip and the tile open again.
    world.release(world.spare.ref);
    await expect(row.locator('[data-entry][data-state="ended"]')).toHaveCount(2, {
      timeout: SLOW_MS,
    });
    await expect(strip).toHaveAttribute("data-state", "ready");
    await expect(tile).toHaveAttribute("data-state", "ready");
  });

  test("a task that is added keeps the draft typed while it was added @one-browser", async ({
    page,
    world,
  }) => {
    await page.goto(await world.signInUrl(`/s/${world.mira.id}/inbox`));
    const field = page.getByRole("textbox", { name: "New task" });
    const add = holdFirst();
    await page.route("**/api/v1/op/task.add", add.handler);
    const project = test.info().project.name;
    const first = `Call the plumber (${project})`;
    const second = `Water the plants (${project})`;
    await field.fill(first);
    await field.press("Enter");
    await add.held;
    // The person goes on typing the next one while the first is on its way.
    await field.fill(second);
    add.release();
    await add.given;
    await expect(page.locator('[data-part="title"]', { hasText: first })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(field).toHaveValue(second);
  });
});
