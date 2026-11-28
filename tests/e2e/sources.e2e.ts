// A wrong source removed from a task in the page, and put back, against the real service
// process with fixture data: Remove on the source's line, with no Undo, the Removed line after a
// reload, Put back refused while another task holds the key, naming it, and Put back once that
// task lets the key go; with more holders than it names, how many more. Screenshots at 1,440 and
// 390 px for review.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string; readonly result: string }[];
}

/** A task added as `as`, with a fresh request ID: its reference and whether it is new. */
async function addTask(
  world: World,
  draft: Record<string, unknown>,
  as: "user" | "agent" = "user",
): Promise<{ ref: string; result: string }> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: [draft] }, as)) as Added;
  const [task] = added.tasks;
  if (task === undefined) throw new Error("the task was not added");
  return task;
}

const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');

test.describe("[A5.source.detach] A wrong source is removed from a task and put back", () => {
  test("Remove with no Undo, the Removed line after a reload, and Put back refused while another task holds the key", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const key = `jira:WRONG-${tag}`;
    const ticket = { kind: "ticket", key, title: "Printer jam on floor 2" };
    const { ref } = await addTask(world, {
      title: `Answer the clinic about opening hours (${tag})`,
      area: "lumen",
      sources: [
        { kind: "email", title: "Opening hours over the holidays", who: "Ana Reyes" },
        ticket,
      ],
    });
    await watchViolations(page);
    await signIn(page, world, `/s/${space}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const row = page.locator(`li[data-task="${ref}"]`);
    const body = row.locator('[data-part="expanded"]');
    const live = body.locator('[data-part="source"]:not([data-removed])');
    const wrong = live.and(body.locator('[data-kind="ticket"]'));
    await expect(live).toHaveCount(2, { timeout: SLOW_MS });

    // Remove takes the ticket off this task, with no Undo: Put back is the way back. Removed, the
    // ticket no longer catches its captures: an agent's capture is new work.
    await wrong.hover();
    await wrong.getByRole("button", { name: "Remove" }).click();
    await expect(toast(page)).toHaveText(`Source removed from ${ref}`);
    await expect(toastAction(page)).toHaveCount(0);
    await expect(live).toHaveCount(1);
    await expect(body.locator('[data-part="removed"]')).toContainText("1 source removed");
    const other = await addTask(
      world,
      { title: `Fix the printer on floor 2 (${tag})`, area: "lumen", sources: [ticket] },
      "agent",
    );
    expect(other.result).toBe("created");
    expect(other.ref).not.toBe(ref);

    // After a reload the Removed line is still there, with who removed it and Put back.
    await page.reload();
    await showsSpace(page, world.mira.name);
    const removedLine = body.locator('[data-part="removed"]');
    await expect(removedLine).toContainText("1 source removed", { timeout: SLOW_MS });
    await removedLine.getByRole("button", { name: "Show" }).click();
    const removed = body.locator('[data-part="source"][data-removed]');
    await expect(removed).toContainText("Printer jam on floor 2");
    await expect(removed).toContainText("removed by you");
    await expect(removed.locator('[data-part="captures-to"]')).toContainText(other.ref);
    await page.setViewportSize({ width: 1440, height: 900 });
    await picture(page, "sources-removed-1440.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await picture(page, "sources-removed-390.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Put back while the other task holds the key is refused, naming it; nothing changes.
    await removed.getByRole("button", { name: "Put back" }).click();
    await expect(toast(page)).toHaveText(
      `${key} is on ${other.ref} now: captures go there. Nothing was put back.`,
    );
    await expect(live).toHaveCount(1);
    await expect(removed).toHaveCount(1);
    await picture(page, "sources-refused-1440.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await picture(page, "sources-refused-390.png");
    await page.setViewportSize({ width: 1440, height: 900 });

    // The agent detaches the ticket from the other task: the card reads again and drops the
    // holder, and Put back brings the ticket back here.
    await world.op(space, "task.update", { task: other.ref, remove_sources: [key] }, "agent");
    await expect(removed.locator('[data-part="captures-to"]')).toHaveCount(0, {
      timeout: SLOW_MS,
    });
    await removed.getByRole("button", { name: "Put back" }).click();
    await expect(toast(page)).toHaveText(`Source put back on ${ref}`);
    await expect(live).toHaveCount(2, { timeout: SLOW_MS });
    await expect(removedLine).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  test("the Removed line names five tasks that hold the key and counts the rest", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const key = `jira:SHARED-${tag}`;
    const ticket = { kind: "ticket", key, title: "Badge reader offline" };
    const { ref } = await addTask(world, {
      title: `Answer the front desk (${tag})`,
      area: "lumen",
      sources: [ticket],
    });
    await world.op(space, "task.update", { task: ref, remove_sources: [key] }, "agent");
    const holders: string[] = [];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const holder = await addTask(world, {
        title: `Check the badge reader, door ${String(n)} (${tag})`,
        area: "lumen",
        sources: [{ kind: "chat", title: `Door ${String(n)}` }],
      });
      await world.op(space, "task.update", { task: holder.ref, add_sources: [ticket] });
      holders.push(holder.ref);
    }
    await watchViolations(page);
    await signIn(page, world, `/s/${space}/task/${ref}`);
    await showsSpace(page, world.mira.name);
    const body = page.locator(`li[data-task="${ref}"]`).locator('[data-part="expanded"]');
    const removedLine = body.locator('[data-part="removed"]');
    await removedLine.getByRole("button", { name: "Show" }).click({ timeout: SLOW_MS });
    const captures = body.locator('[data-part="source"][data-removed] [data-part="captures-to"]');
    await expect(captures.getByRole("link")).toHaveText(holders.slice(0, 5));
    await expect(captures).toContainText("a capture asks which of");
    await expect(captures).toContainText("and 1 more");
    await page.setViewportSize({ width: 1440, height: 900 });
    await picture(page, "sources-more-1440.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await picture(page, "sources-more-390.png");
    expect(await violations(page)).toEqual([]);
  });
});
