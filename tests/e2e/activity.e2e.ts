// The Activity screen in the page, against the real service: an agent's changes, made through its
// requests outside the page, come in as lines without a reload, the person's own do not, a line
// opens its task, a reader's place holds while lines come, and older lines load as the end comes
// near. Fixture text only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import {
  axeFound,
  picture,
  showsSpace,
  signIn,
  themes,
  violations,
  watchViolations,
} from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

const lines = (page: Page) => page.getByRole("list", { name: "What agents did" }).locator("> li");

async function add(world: World, title: string, extra: Record<string, unknown> = {}) {
  const added = (await world.op(
    world.mira.id,
    "task.add",
    { tasks: [{ title, ...extra }] },
    "agent",
  )) as Added;
  return added.tasks[0]?.ref ?? "";
}

const asOf = async (world: World, ref: string) =>
  ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string }).as_of;

async function update(
  world: World,
  ref: string,
  set: Record<string, unknown>,
  as: "user" | "agent",
) {
  await world.op(
    world.mira.id,
    "task.update",
    { task: ref, set, base: await asOf(world, ref) },
    as,
  );
}

async function open(page: Page, world: World): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}/activity`);
  await showsSpace(page, world.mira.name);
  await expect(lines(page).first()).toBeVisible({ timeout: SLOW_MS });
}

test.describe("[A5.activity.e2e] the Activity screen", () => {
  test("an agent's changes come in as lines without a reload, the person's own do not, and a line opens its task", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    await open(page, world);
    await expect(page.locator('a[data-view="activity"]')).toHaveAttribute("aria-current", "page");
    const project = test.info().project.name;

    const title = `Fixture activity task (${project})`;
    const ref = await add(world, title, { priority: 2 });
    const first = lines(page).first();
    await expect(first).toContainText(title, { timeout: SLOW_MS });
    await expect(first).toContainText("added");

    // Two fields in one request: one line, with both values.
    await update(world, ref, { priority: 1, due: "2026-12-03" }, "agent");
    const day = new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(Date.UTC(2026, 11, 3));
    await expect(first).toContainText(`priority P2 to P1, due ${day}`, { timeout: SLOW_MS });

    // The person's own change makes no line: the agent's next one lands right on top of the last.
    await update(world, ref, { title: `${title}, renamed` }, "user");
    await update(world, ref, { summary: "Fixture words of a summary" }, "agent");
    await expect(first).toContainText("brief changed", { timeout: SLOW_MS });
    await expect(lines(page).nth(1)).toContainText("priority P2 to P1");
    await expect(page.locator("main")).not.toContainText("Fixture words of a summary");

    // Two tasks added by one request into two places: a count that opens to each, with its place.
    const pair = [`Fixture pair one (${project})`, `Fixture pair two (${project})`] as const;
    await world.op(
      world.mira.id,
      "task.add",
      {
        tasks: [
          { title: pair[0], project: "garden" },
          { title: pair[1], project: "lumen-portal" },
        ],
      },
      "agent",
    );
    const count = first.getByRole("button", { name: "2 tasks" });
    await expect(count).toHaveAttribute("aria-expanded", "false", { timeout: SLOW_MS });
    await count.click();
    await expect(count).toHaveAttribute("aria-expanded", "true");
    await expect(first.getByRole("link", { name: pair[0] })).toBeVisible();
    await expect(first.getByRole("listitem").filter({ hasText: pair[0] })).toContainText(
      "added to Garden",
    );
    await expect(first.getByRole("listitem").filter({ hasText: pair[1] })).toContainText(
      "added to Lumen portal",
    );

    // Finished with a follow-up: both named, each with what happened to it.
    const follow = `Fixture follow-up (${project})`;
    await world.op(
      world.mira.id,
      "task.finish",
      {
        task: ref,
        outcome: "Fixture outcome",
        follow_ups: [{ title: follow }],
        base: await asOf(world, ref),
      },
      "agent",
    );
    await expect(first).toContainText(`completed, follow-up added: ${follow}`, {
      timeout: SLOW_MS,
    });
    await expect(first.getByRole("link", { name: follow })).toBeVisible();

    // The line is a way to its task, by the keyboard too.
    await first.getByRole("link").first().focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`[?&]task=${ref}`, "u"), { timeout: SLOW_MS });
    expect(await violations(page)).toEqual([]);
  });

  test("lines that come keep a reader's place, come into sight at the top, and older ones load on", async ({
    page,
    world,
  }) => {
    const project = test.info().project.name;
    // More than one read's worth of lines.
    for (let i = 0; i < 6; i += 1) {
      await Promise.all(
        Array.from({ length: 10 }, (_, j) =>
          add(world, `Fixture burst ${String(i * 10 + j)} (${project})`),
        ),
      );
    }
    await open(page, world);

    // Scrolled down to read: a line that comes moves nothing on screen.
    await page.evaluate(() => {
      window.scrollTo(0, 600);
    });
    const before = await page.evaluate(() => {
      const item = [...document.querySelectorAll<HTMLElement>("main li[data-seq]")].find(
        (li) => li.getBoundingClientRect().top > 100,
      );
      return { seq: item?.dataset["seq"], top: item?.getBoundingClientRect().top };
    });
    const read = `Fixture read on (${project})`;
    await add(world, read);
    await expect(lines(page).first()).toContainText(read, { timeout: SLOW_MS });
    const after = await page.evaluate(
      (seq) => document.querySelector(`main li[data-seq="${seq}"]`)?.getBoundingClientRect().top,
      before.seq ?? "",
    );
    expect(Math.abs((after ?? 0) - (before.top ?? 0))).toBeLessThan(1);

    // At the top, with nothing held, it comes into sight.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.mouse.move(1, 1);
    const seen = `Fixture in sight (${project})`;
    await add(world, seen);
    await expect(lines(page).first()).toContainText(seen, { timeout: SLOW_MS });
    await expect(lines(page).first()).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // Read on to the end: every line the service holds, each once.
    const all = (
      (await world.op(world.mira.id, "activity.list", { limit: 200 })) as { lines: unknown[] }
    ).lines.length;
    expect(all).toBeGreaterThan(50);
    await expect
      .poll(
        async () => {
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          return lines(page).count();
        },
        { timeout: SLOW_MS },
      )
      .toBe(all);
    await expect(page.getByRole("button", { name: "Older" })).toHaveCount(0);
  });

  test("screenshots of Activity with lines, empty and as a line comes, in Sumi and Washi, and axe finds nothing", async ({
    browser,
    world,
  }) => {
    const project = test.info().project.name;
    // A mix of what agents do.
    const space = world.mira.id;
    const plumber = await add(world, `Call the plumber about the boiler (${project})`);
    await update(world, plumber, { project: "garden" }, "agent");
    await world.op(space, "entry.add", { task: plumber, text: "Fixture progress" }, "agent");
    await update(world, plumber, { status: "waiting", waiting_on: "Ana Reyes" }, "agent");
    const permit = await add(world, `Renew the parking permit (${project})`);
    await world.op(
      space,
      "task.finish",
      {
        task: permit,
        outcome: "Fixture outcome",
        follow_ups: [{ title: `Pick up the new permit (${project})` }],
        base: await asOf(world, permit),
      },
      "agent",
    );
    const twin = await add(world, `Plan the offsite, a duplicate (${project})`);
    await world.op(space, "task.delete", { tasks: [twin], base: await asOf(world, twin) }, "agent");
    await world.op(
      space,
      "task.add",
      {
        tasks: [
          { title: `Water the tomatoes (${project})`, project: "garden" },
          { title: `Answer the clinic (${project})`, project: "clinic-sync" },
          { title: `Prune the hedge (${project})`, project: "garden" },
        ],
      },
      "agent",
    );
    for (const theme of themes()) {
      await world.machine("ui.theme", theme);
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          bypassCSP: true,
          viewport: { width: 1440, height: 1000 },
          reducedMotion: "reduce",
        });
        try {
          const page = await context.newPage();
          await open(page, world);
          if (width !== 1440) await page.setViewportSize({ width, height: 844 });
          await page.getByRole("button", { name: "3 tasks" }).first().click();
          await picture(page, `activity-${theme}-${String(width)}.png`);
          expect(await axeFound(page, ["main"])).toEqual([]);

          const ref = await add(
            world,
            `Fixture line that comes (${project}, ${theme}, ${String(width)})`,
          );
          await update(world, ref, { priority: 1, due: "2026-12-03" }, "agent");
          await expect(lines(page).first()).toContainText("priority", { timeout: SLOW_MS });
          await picture(page, `activity-arriving-${theme}-${String(width)}.png`);

          // A space where no agent has changed anything yet: the read answers no line.
          await page.route("**/api/v1/op/activity.list", async (route) => {
            const response = await route.fetch();
            const body = (await response.json()) as Record<string, unknown>;
            const answer = ("lines" in body ? body : body["result"]) as Record<string, unknown>;
            answer["lines"] = [];
            answer["more"] = false;
            await route.fulfill({ response, json: body });
          });
          await signIn(page, world, `/s/${world.mira.id}/activity`);
          if (width !== 1440) await page.setViewportSize({ width, height: 844 });
          await expect(page.locator("main")).toContainText("Nothing yet.", { timeout: SLOW_MS });
          await picture(page, `activity-empty-${theme}-${String(width)}.png`);
        } finally {
          await context.close();
        }
      }
    }
    await world.machine("ui.theme", null);
  });
});
