// Today end to end (A7 3.12 M5.04; A5 3.3, 3.4, 3.15, 3.22), in Chromium and Firefox against the
// real service process with fixture data.
//
// Verify line: no task in two sections (also a property test, `A5.3.4.web.today-disjoint`), and
// the date appears once. Also: the day's numbers follow a task finished while the page is open,
// keep their places and link to what they count, the expanded task that an update would move
// stays where it is with `?task=` kept, Changes shows an agent's change off Today, axe finds
// nothing on Today in either theme, nothing scrolls horizontally at 390 px, and the screenshots in
// Sumi and Washi at 1,440 and 390 px for review. The seeded space and the world's other tests add
// tasks of their own, so the assertions name this test's tasks and the rules, never a whole list.
// Dates are relative to the day the test runs, as the service's star is (it stars for its today).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

/** The local calendar day `days` from today: its date and the names the page shows. */
function day(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString("en", options);
  return {
    iso: `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    /** Today's date as the page shows it: "Thursday 12 November". */
    full: `${name({ weekday: "long" })} ${String(date.getDate())} ${name({ month: "long" })}`,
    /** A date in a row or a fact: "12 Nov". */
    short: `${String(date.getDate())} ${name({ month: "short" })}`,
  };
}

interface Added {
  readonly tasks: readonly { readonly id: string; readonly ref: string }[];
}

interface TodayTasks {
  readonly star: string;
  readonly lease: string;
  readonly dentist: string;
  readonly review: { readonly id: string; readonly ref: string };
  /** Due yesterday: late. */
  readonly renew: string;
}

const asOf = async (world: World, ref: string): Promise<string> =>
  ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string }).as_of;

/** This test's tasks, added as the person at a terminal does: one for each section's rule. */
async function seed(world: World, tag: string): Promise<TodayTasks> {
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [
      {
        title: `Fix appointment time zones (${tag})`,
        summary: "Times shift by one hour after the DST change",
        area: "lumen",
        project: "lumen-portal",
        priority: 1,
      },
      { title: `Sign the lease (${tag})`, area: "home", due: day(2).iso, priority: 3 },
      { title: `Dentist check-up (${tag})`, area: "home", due: day(5).iso, priority: 2 },
      { title: `Docs migration (${tag})`, area: "lumen", status: "review" },
      { title: `Renew the domain (${tag})`, area: "home", due: day(-1).iso },
    ],
  })) as Added;
  const [star, lease, dentist, review, renew] = added.tasks;
  if (
    star === undefined ||
    lease === undefined ||
    dentist === undefined ||
    review === undefined ||
    renew === undefined
  ) {
    throw new Error("the tasks were not added");
  }
  // Starred today: the star is the person's (A5 3.4).
  await world.op(world.mira.id, "task.update", {
    task: star.ref,
    set: { focus: true },
    base: await asOf(world, star.ref),
  });
  return { star: star.ref, lease: lease.ref, dentist: dentist.ref, review, renew: renew.ref };
}

const section = (page: Page, name: string) => page.locator(`main section[aria-label="${name}"]`);
const row = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);

/** The text a person sees in the page: hidden elements (`hidden`, descriptions) left out. */
const shownText = (page: Page) => page.locator("body").innerText();

async function openToday(page: Page, world: World): Promise<void> {
  await page.goto(await world.signInUrl(`/s/${world.mira.id}/today`));
  await showsSpace(page, world.mira.name);
}

/** The number in a link's name ("Late: 2"), or NaN while it is a dash. */
const countIn = async (link: Locator): Promise<number> =>
  Number(/: ([\d,]+)/.exec((await link.getAttribute("aria-label")) ?? "")?.[1]?.replace(",", ""));

test.describe("[A7.3.12.m5-04.e2e.today] Today: its date, its numbers and its sections", () => {
  test("no task in two sections, the date once, the numbers live and linked, the expanded task held, Changes", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const tasks = await seed(world, tag);
    await watchViolations(page);
    await openToday(page, world);

    // Today's date, once on the screen.
    const today = day(0);
    await expect(page.locator('[data-part="date"]')).toHaveText(today.full);
    await expect(row(page, tasks.star)).toBeVisible({ timeout: SLOW_MS });
    expect((await shownText(page)).split(today.full)).toHaveLength(2);
    // No heading above the sections: the sidebar and the tab's title name the view.
    await expect(page.locator("main h1")).toHaveCount(0);

    // The day's numbers, in their places; Done this week reads the service once it answers.
    const numbers = page.getByRole("list", { name: "Your day" });
    const late = numbers.getByRole("link", { name: /^Late: / });
    const done = numbers.getByRole("link", { name: /^Done this week: / });
    await expect(numbers.getByRole("link")).toHaveCount(4);
    await expect(done).toHaveAttribute("aria-label", /^Done this week: \d/, { timeout: SLOW_MS });
    expect(await countIn(late)).toBeGreaterThanOrEqual(1);
    const places = await numbers
      .getByRole("link")
      .evaluateAll((links) => links.map((l) => Math.round(l.getBoundingClientRect().left)));
    const before = await countIn(done);
    // A task is finished while the page is open: the count follows, and nothing moves.
    await world.op(world.mira.id, "task.finish", {
      task: tasks.renew,
      base: await asOf(world, tasks.renew),
    });
    await expect(done).toHaveAttribute(
      "aria-label",
      new RegExp(`^Done this week: ${String(before + 1)}, \\d+ today$`),
      { timeout: SLOW_MS },
    );
    expect(
      await numbers
        .getByRole("link")
        .evaluateAll((links) => links.map((l) => Math.round(l.getBoundingClientRect().left))),
    ).toEqual(places);
    // Each task in the first section that selects it, and in no other.
    await expect(section(page, "Focus").locator(`li[data-task="${tasks.star}"]`)).toHaveCount(1);
    await expect(section(page, "This week").locator(`li[data-task="${tasks.lease}"]`)).toHaveCount(
      1,
    );
    await expect(
      section(page, "This week").locator(`li[data-task="${tasks.dentist}"]`),
    ).toHaveCount(1);
    await expect(row(page, tasks.review.ref)).toHaveCount(0);
    const keys = await page
      .locator("main li[data-key]")
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-key")));
    expect(new Set(keys).size).toBe(keys.length);
    // The expanded task stays in its section while an update would move it, `?task=` kept.
    const dentist = row(page, tasks.dentist);
    await dentist.locator('[data-part="title"]').click();
    await expect(page).toHaveURL(new RegExp(`/today\\?task=${tasks.dentist}$`));
    const later = day(20);
    await world.op(world.mira.id, "task.update", {
      task: tasks.dentist,
      set: { due: later.iso },
      base: await asOf(world, tasks.dentist),
    });
    // The update reached the page: the card shows the new date, and the task has not moved.
    await expect(dentist).toContainText(later.short, { timeout: SLOW_MS });
    await expect(
      section(page, "This week").locator(`li[data-task="${tasks.dentist}"]`),
    ).toHaveCount(1);
    await expect(dentist.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
    await expect(page).toHaveURL(new RegExp(`/today\\?task=${tasks.dentist}$`));
    // Collapsed, and once focus leaves it, it goes where Today puts it now: not This week.
    await dentist.locator('[data-part="collapse"]').click();
    await expect(page).toHaveURL(/\/today$/);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await expect(
      section(page, "This week").locator(`li[data-task="${tasks.dentist}"]`),
    ).toHaveCount(0, { timeout: SLOW_MS });

    // Changes: an agent logs on the review task, which no section above shows.
    await world.agentLog(world.mira.id, tasks.review.id, `Checked the docs build (${tag}).`);
    await expect(
      section(page, "Changes").locator(`li[data-task="${tasks.review.ref}"]`),
    ).toBeVisible({ timeout: SLOW_MS });

    await page.screenshot({ path: test.info().outputPath("today-flow.png"), fullPage: true });
    expect(await violations(page)).toEqual([]);

    // A number leads to what it counts: Late to the search for what is overdue.
    const overdue = await countIn(late);
    await late.click();
    await expect(page).toHaveURL(/\/search\?q=is%3Aoverdue$/);
    await expect(page.locator("main li[data-key]")).toHaveCount(overdue, { timeout: SLOW_MS });
    await page.goBack();
    // Due today to what is open and due today: a task finished today is not counted, nor listed.
    const paid = (await world.op(world.mira.id, "task.add", {
      tasks: [{ title: `Pay the deposit (${tag})`, area: "home", due: today.iso }],
    })) as Added;
    const deposit = paid.tasks[0]?.ref ?? "";
    await world.op(world.mira.id, "task.finish", {
      task: deposit,
      base: await asOf(world, deposit),
    });
    const due = numbers.getByRole("link", { name: /^Due today: / });
    const dueToday = await countIn(due);
    await due.click();
    await expect(page).toHaveURL(/\/search\?q=due%3Atoday/);
    await expect(page.locator("main li[data-key]")).toHaveCount(dueToday, { timeout: SLOW_MS });
    await expect(row(page, deposit)).toHaveCount(0);
    await page.goBack();
    await numbers.getByRole("link", { name: /^Waiting on others: / }).click();
    await expect(page).toHaveURL(/\/waiting$/);
  });

  test("screenshots in Sumi and Washi at 1,440 and 390 px, axe clean, no horizontal scroll", async ({
    browser,
    world,
  }) => {
    const tag = `${test.info().project.name}-screens`;
    const tasks = await seed(world, tag);
    const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    for (const theme of ["sumi", "washi"] as const) {
      // axe runs its own script in the page: a context of its own without the page's CSP.
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await world.machine("ui.theme", theme);
        await openToday(page, world);
        await expect(row(page, tasks.star)).toBeVisible({ timeout: SLOW_MS });
        await page.screenshot({
          path: test.info().outputPath(`today-${theme}-1440.png`),
          fullPage: true,
        });
        // The mockup's moment: a Focus task expanded in place.
        await row(page, tasks.star).locator('[data-part="title"]').click();
        await expect(row(page, tasks.star).locator('[data-part="collapse"]')).toBeVisible({
          timeout: SLOW_MS,
        });
        await expect(row(page, tasks.star).locator("dl")).toBeVisible({ timeout: SLOW_MS });
        await page.screenshot({
          path: test.info().outputPath(`today-${theme}-1440-expanded.png`),
          fullPage: true,
        });

        await page.evaluate(axe);
        const found = await page.evaluate(async () => {
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
          const result = await run({ include: ["main"] }, { resultTypes: ["violations"] });
          return result.violations.map(
            (v) => `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`,
          );
        });
        expect(found, `axe in ${theme}`).toEqual([]);

        await page.setViewportSize({ width: 390, height: 900 });
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await page.screenshot({
          path: test.info().outputPath(`today-${theme}-390.png`),
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    }
    // The tests of a worker share its service: the theme goes back to its default.
    await world.machine("ui.theme", null);
  });
});
