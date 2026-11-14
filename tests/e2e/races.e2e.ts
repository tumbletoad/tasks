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
  test("a late receipt list keeps Confirmed, and a Connected tile expands its row and starts nothing", async ({
    page,
    world,
  }) => {
    await page.goto(await world.signInUrl(`/s/${world.mira.id}`));
    // Its own task: the open test launches `world.task`, and a worker's tests share the world.
    const row = page.locator(`li[data-task="${world.spare.ref}"]`);
    const main = row.locator('[data-part="title"]');
    const tile = row.locator('[data-part="tile"]');
    // The row's one tile is the effective instance's (A5 3.6). An expanded row hides it (A5 3.7):
    // the expanded row's strip has a button per instance, which opens like a Ready tile.
    await expect(tile).toHaveAccessibleName(`Open in ${FAKE_INSTANCE.label}`);
    await Promise.all([page.waitForResponse("**/api/v1/launch/list"), main.click()]);
    await expect(main).toHaveAttribute("aria-expanded", "true");

    // The first receipt list after the click answers only after the launch is Confirmed.
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
    // This launch's entry, not a seeded Confirmed one of another instance.
    const confirmed = row.locator('[data-entry][data-state="confirmed"]', {
      hasText: `Open in ${FAKE_INSTANCE.label}`,
    });
    await expect(confirmed).toBeVisible({ timeout: SLOW_MS });
    await expect(tile).toHaveAttribute("data-state", "connected");
    list.release();
    await list.given;
    // Give the page time to apply the late answer; it must not.
    await page.waitForTimeout(1_000);
    await expect(confirmed).toBeVisible();
    await expect(tile).toHaveAttribute("data-state", "connected");
    await page.unroute("**/api/v1/launch/list");

    // Connected: a click on the tile expands the row (A5 3.6) and never starts another launch;
    // neither does the strip's button of the connected instance.
    await main.click();
    await expect(main).toHaveAttribute("aria-expanded", "false");
    await tile.click();
    await expect(main).toHaveAttribute("aria-expanded", "true");
    await expect(strip).toHaveAttribute("data-state", "connected");
    await strip.click();
    await expect(main).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(1_000);
    expect(world.terminal()).toHaveLength(before + 1);
  });

  test("a task that is added keeps the draft typed while it was added", async ({ page, world }) => {
    await page.goto(await world.signInUrl(`/s/${world.mira.id}`));
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
