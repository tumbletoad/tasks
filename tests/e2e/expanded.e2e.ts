// The expanded task end to end (A7 3.12 M5.06; A5 3.3, 3.7, 3.22, 3.26), in Chromium and Firefox
// against the real service process with fixture data.
//
// Verify line: no fact string twice in one expanded task; a link to a task in each lifecycle
// opens it; the keyboard path passes. Also: untrusted text in every part of a task stays text,
// only allowed schemes become links, no CSP report, axe finds nothing in the expanded task in
// either theme, and the screenshots in Sumi and Washi at 1,440 px (and 390 px) for review.
//
// Two lifecycles are not linked here, because no operation makes them before M3.04: an archived
// (dropped) task (`task.finish` refuses `status: dropped` until then) and a restorable deleted
// one (no tombstone, and `task.get` reads none). Their host views are a unit test
// (`A5.3.3.web.task-host`).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

/** A task added as the person at a terminal does, with a fresh request ID. Its reference. */
async function addTask(world: World, draft: Record<string, unknown>): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: [draft] })) as Added;
  const ref = added.tasks[0]?.ref;
  if (ref === undefined) throw new Error("the task was not added");
  return ref;
}

const asOf = async (world: World, ref: string): Promise<string> =>
  ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string }).as_of;

/** A task with something in every part of the expanded task, untrusted text included. */
async function richTask(world: World, tag: string): Promise<{ ref: string; title: string }> {
  const title = `Fix appointment time zones (${tag})`;
  const ref = await addTask(world, {
    title,
    summary: `Store UTC plus the clinic's zone ID, then convert once (${tag})`,
    area: "lumen",
    project: "lumen-portal",
    priority: 1,
    effort: "M",
    due: "+3d",
    context:
      "Appointment times shift by **one hour** after the DST change.\n\n" +
      "- Only bookings made before the change\n- New bookings look right\n\n" +
      '<script>window.__xss = 1</script> <img src=x onerror="window.__xss = 2">\n\n' +
      "See [the runbook](https://docs.example/runbook) and [this](javascript:window.__xss=3).",
    sources: [
      {
        kind: "email",
        title: "Wrong appointment times since Sunday",
        who: "Ana Reyes",
        url: "https://mail.example/m/1",
      },
      {
        kind: "ticket",
        key: `jira:LUM-${tag}`,
        title: "Appointments off by one hour",
        url: "https://tickets.example/LUM",
      },
      { kind: "chat", title: "#lumen-dev", who: "Jonas Berg", url: "javascript:window.__xss=4" },
      // A source whose own text is the task's title: its line names its kind instead.
      { kind: "doc", title, url: "https://docs.example/brief" },
    ],
  });
  const space = world.mira.id;
  await world.op(space, "entry.add", {
    task: ref,
    kind: "note",
    for_agents: true,
    text: "Keep the old export format until the clinic confirms the change.",
  });
  await world.op(
    space,
    "entry.add",
    { task: ref, kind: "evidence", text: "Reproduced with the clinic export: **one hour** off." },
    "agent",
  );
  for (let i = 1; i <= 6; i += 1) {
    await world.op(
      space,
      "entry.add",
      { task: ref, kind: "progress", text: `Checked clinic ${String(i)} of 6.` },
      "agent",
    );
  }
  return { ref, title };
}

/**
 * Every fact string the expanded task shows, as the person sees it: the header's title and
 * summary, the facts, the content's lines, and the thread's entry texts. An entry's actor and
 * time are its label, not a fact, and repeat by design.
 */
const shownFacts = (page: Page, ref: string) =>
  page.evaluate((r) => {
    const row = document.querySelector(`li[data-task="${r}"]`);
    if (row === null) return [];
    const visible = (e: Element) =>
      (e as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const parts = [
      ...row.querySelectorAll('[data-part="title"], [data-part="summary"] [dir]'),
      ...row.querySelectorAll('[data-part="expanded"] [data-fact]'),
      ...row.querySelectorAll('[data-part="expanded"] [data-part="entry-text"]'),
    ];
    // Every other visible text of the header (the row's columns) counts too: none may repeat a fact.
    const line = row.querySelector("[data-row-line]");
    const slots = line === null ? [] : [...line.querySelectorAll("span, button")];
    const chosen = [...new Set([...parts, ...slots])];
    // Each text once: an element inside another chosen one is that one's text already.
    return chosen
      .filter((e) => !chosen.some((other) => other !== e && other.contains(e)))
      .filter(visible)
      .map((e) => e.textContent.trim())
      .filter((text) => text !== "");
  }, ref);

test.describe("[A7.3.12.m5-06.e2e.expanded] The expanded task: each fact once, untrusted text as text", () => {
  test("content, sources with their own text, the project's folder, the thread and the facts, each fact once", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const { ref, title } = await richTask(world, tag);
    await watchViolations(page);
    await page.addInitScript(() => {
      (window as unknown as { __xss: number }).__xss = 0;
    });
    await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
    await showsSpace(page, world.mira.name);

    // The link lands on the host view, the area view, with the task expanded in its URL.
    await expect(page).toHaveURL(new RegExp(`/s/${world.mira.id}/area/[a-z0-9_]+\\?task=${ref}$`), {
      timeout: SLOW_MS,
    });
    await expect(page.getByRole("link", { name: /^Lumen, / })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const row = page.locator(`li[data-task="${ref}"]`);
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByRole("region", { name: title })).toBeVisible();
    const body = row.locator('[data-part="expanded"]');

    // Sources show their own text: no kind label, a ticket's key first, the person after.
    const sources = body.locator('[data-part="source"]');
    await expect(sources).toHaveCount(4, { timeout: SLOW_MS });
    const mail = body.locator('[data-part="source"][data-kind="email"]');
    await expect(mail).toContainText("Wrong appointment times since Sunday");
    await expect(mail).toContainText("· Ana Reyes");
    await expect(mail).not.toContainText("Email");
    await expect(mail.locator("a")).toHaveAttribute("href", "https://mail.example/m/1");
    await expect(mail.locator("a")).toHaveAttribute("rel", "noopener noreferrer");
    const ticket = body.locator('[data-part="source"][data-kind="ticket"]');
    await expect(ticket).toContainText(`LUM-${tag}`);
    await expect(ticket).toContainText("Appointments off by one hour");
    // A source whose link has a blocked scheme is text.
    await expect(body.locator('[data-part="source"][data-kind="chat"] a')).toHaveCount(0);
    // A source whose text repeats the title shows its kind's name, still a link.
    const doc = body.locator('[data-part="source"][data-kind="doc"]');
    await expect(doc).toHaveText("Document");
    await expect(doc.locator("a")).toHaveAttribute("href", "https://docs.example/brief");
    // No folder of its own: it opens in its project's.
    await expect(body.locator('[data-part="place"]')).toHaveAttribute("data-state", "here");
    await expect(body.locator('[data-part="place"]')).toContainText(world.portal);

    // The context is Markdown, never HTML: the markup shows as text and nothing of it runs.
    const context = body.locator('[data-part="context"]');
    await expect(context.locator("strong", { hasText: /^one hour$/ })).toHaveCount(1);
    await expect(context).toContainText("<script>window.__xss = 1</script>");
    await expect(context.locator("li")).toHaveCount(2);
    await expect(context.locator('a[href="https://docs.example/runbook"]')).toBeVisible();
    await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
    await expect(
      page.locator("[data-part='expanded'] img, [data-part='expanded'] script"),
    ).toHaveCount(0);

    // The thread: the last six entries, then Earlier shows the rest. A note to agents says so.
    const entries = body.locator("[data-entry]");
    await expect(entries).toHaveCount(6);
    await body.locator('[data-part="earlier"]').click();
    await expect(entries).toHaveCount(8);
    await expect(body.locator('[data-entry="note"]')).toContainText("to agents");
    await expect(body.locator('[data-entry="log"]').first()).toContainText("evidence");

    // The facts, with short labels, each in its control (M5.08 edits them).
    const facts = body.getByRole("definition");
    const fact = (label: string) =>
      body
        .locator("dt", { hasText: new RegExp(`^${label}$`) })
        .locator("xpath=following-sibling::dd[1]");
    const chosen = (label: string) =>
      body.getByRole("radiogroup", { name: label }).getByRole("radio", { checked: true });
    await expect(chosen("Status")).toHaveText("Open");
    await expect(chosen("Priority")).toHaveText("P1");
    await expect(chosen("Effort")).toHaveText("M");
    await expect(fact("Area")).toHaveText("Lumen › Lumen portal");
    // Created today: "today" alone, so today's date stays the strip's (A5 U1).
    await expect(fact("Created")).toHaveText("today");
    await expect(fact("Due")).not.toHaveText("");
    expect(await facts.count()).toBe(6);

    // The header: the slots, the chip and the area prefix give way to the body; star and collapse stay.
    await expect(row.locator('[data-part="star"]')).toBeVisible();
    await expect(row.locator('[data-part="collapse"]')).toBeVisible();
    await expect(row.locator('[data-part="tile"]')).toBeHidden();

    // No fact string twice.
    const shown = await shownFacts(page, ref);
    expect(shown.length).toBeGreaterThan(15);
    const twice = shown.filter((text, i) => shown.indexOf(text) !== i);
    expect(twice).toEqual([]);

    // A new entry lands in the open thread without a reload.
    const text = `Fixed in the export path (${tag}).`;
    await world.agentLog(world.mira.id, ref, text);
    await expect(body.locator('[data-part="entry-text"]', { hasText: text })).toBeVisible({
      timeout: SLOW_MS,
    });

    // Collapsed, the row's own button opens the project's folder.
    await row.locator('[data-part="collapse"]').click();
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "false");
    await expect(row.locator('[data-part="folder"]')).toHaveAccessibleName("Open folder");

    expect(await page.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A7.3.12.m5-06.e2e.task-links] A link to a task in each lifecycle opens it", () => {
  test("Inbox, a status view, the area view, Completed for a done task, and an unknown task", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const inbox = await addTask(world, { title: `Call the landlord (${tag})`, inbox: true });
    const waiting = await addTask(world, {
      title: `New product photos (${tag})`,
      status: "waiting",
      waiting_on: "Tom",
      inbox: false,
    });
    const area = await addTask(world, {
      title: `Renew the clinic certificate (${tag})`,
      area: "home",
    });
    const done = await addTask(world, { title: `Fix DST bug in reports (${tag})`, area: "lumen" });
    await world.op(space, "task.finish", {
      task: done,
      outcome: `Reports convert from UTC with the clinic's zone ID (${tag}).`,
      base: await asOf(world, done),
    });
    await watchViolations(page);
    await page.goto(await world.signInUrl(`/s/${space}/today`));
    await showsSpace(page, world.mira.name);

    const opens = async (ref: string, path: RegExp, current: string) => {
      await page.goto(`${world.origin}/s/${space}/task/${ref}`);
      await expect(page).toHaveURL(path, { timeout: SLOW_MS });
      const title = page.locator(`li[data-task="${ref}"] [data-part="title"]`);
      await expect(title).toHaveAttribute("aria-expanded", "true", { timeout: SLOW_MS });
      await expect(page.locator('nav a[aria-current="page"]').first()).toContainText(current);
    };
    await opens(inbox, new RegExp(`/s/${space}/inbox\\?task=${inbox}$`), "Inbox");
    await opens(waiting, new RegExp(`/s/${space}/waiting\\?task=${waiting}$`), "Waiting");
    await opens(area, new RegExp(`/s/${space}/area/[a-z0-9_]+\\?task=${area}$`), "Home");

    // A completed task: Completed, its outcome, checked off.
    await opens(done, new RegExp(`/s/${space}/completed\\?task=${done}$`), "Completed");
    const doneRow = page.locator(`li[data-task="${done}"]`);
    await expect(doneRow.locator('[data-part="outcome"]')).toContainText(
      `Reports convert from UTC with the clinic's zone ID (${tag}).`,
    );
    await expect(doneRow.locator('[data-part="lifecycle"]')).toHaveText("Checked off");
    // A reload keeps the host view and the expansion.
    await page.reload();
    await expect(doneRow.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
      timeout: SLOW_MS,
    });
    // Collapsing pushes the view's own route: Back returns to the task.
    await doneRow.locator('[data-part="collapse"]').click();
    await expect(page).toHaveURL(new RegExp(`/s/${space}/completed$`));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/s/${space}/completed\\?task=${done}$`));
    await expect(doneRow.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
      timeout: SLOW_MS,
    });

    // A task that is not in the space: the landing view, and the toast says so.
    await page.goto(`${world.origin}/s/${space}/task/M-999999`);
    await expect(page).toHaveURL(new RegExp(`/s/${space}/today$`), { timeout: SLOW_MS });
    await expect(
      page.getByRole("status").filter({ hasText: "This task no longer exists." }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A7.3.12.m5-06.e2e.keyboard] The expanded task by keyboard alone", () => {
  test("Enter expands, Tab reaches the card's controls, Escape collapses to the title, Back reopens, F2 renames, the list keys move on", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const space = world.mira.id;
    const ref = await addTask(world, {
      title: `Book the moving van (${tag})`,
      area: "home",
      sources: [{ kind: "web", title: "Van rental", url: "https://vans.example/booking" }],
    });
    // Another task in the same group, so the list's keys have a row to move to.
    await addTask(world, { title: `Return the van keys (${tag})`, area: "home" });
    await page.goto(await world.signInUrl(`/s/${space}/today`));
    await showsSpace(page, world.mira.name);
    // The Home area lists the task (Today lists only what it selects, A5 3.4).
    await page
      .getByRole("navigation")
      .getByRole("link", { name: /^Home, / })
      .click();
    await expect(page).toHaveURL(new RegExp(`/s/${space}/area/[a-z0-9_]+$`));
    const view = page.url().replace(world.origin, "");
    const row = page.locator(`li[data-task="${ref}"]`);
    const title = row.locator('[data-part="title"]');
    await title.focus();
    await page.keyboard.press("Enter");
    await expect(title).toHaveAttribute("aria-expanded", "true");
    await expect(page).toHaveURL(`${world.origin}${view}?task=${ref}`);
    // The card's controls show once its thread is read.
    await expect(row.locator('[data-part="composer"]')).toBeVisible({ timeout: SLOW_MS });

    // Tab walks the header's controls, then the card: its facts, its source link, the composer,
    // then the strip, which is one stop: the arrows walk it from Note to Copy.
    const active = () =>
      page.evaluate(() => {
        const e = document.activeElement;
        if (e === null) return "";
        return `${e.tagName.toLowerCase()}:${e.getAttribute("data-part") ?? e.textContent.trim()}`;
      });
    const reached: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      reached.push(await active());
      if (reached.at(-1) === "button:note") break;
    }
    expect(reached).toContain("button:star");
    expect(reached).toContain("button:collapse");
    expect(reached.some((r) => r.startsWith("a:"))).toBe(true);
    expect(reached.slice(-2)).toEqual(["textarea:composer", "button:note"]);
    for (let i = 0; i < 6 && (await active()) !== "button:copy"; i += 1) {
      await page.keyboard.press("ArrowRight");
    }
    expect(await active()).toBe("button:copy");

    // Escape from inside the card collapses it and puts focus on its title.
    await page.keyboard.press("Escape");
    await expect(title).toHaveAttribute("aria-expanded", "false");
    await expect(title).toBeFocused();
    await expect(page).toHaveURL(`${world.origin}${view}`);
    await page.goBack();
    await expect(title).toHaveAttribute("aria-expanded", "true", { timeout: SLOW_MS });

    // F2 edits the title in place; Enter saves it, and focus returns to the title.
    await title.focus();
    await page.keyboard.press("F2");
    const field = row.getByRole("textbox", { name: "Title" });
    await expect(field).toBeFocused();
    // Keys typed into the field stay there: j is a letter here, not a move.
    await page.keyboard.press("End");
    await page.keyboard.type(", just the jump seats");
    // The save is still on its way when the page reloads: it arrives all the same.
    await page.route("**/api/v1/op/task.update", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Handed back to the browser, which would have cancelled it at the reload.
      await route.continue().catch(() => undefined);
    });
    await page.keyboard.press("Enter");
    await expect(title).toHaveText(`Book the moving van (${tag}), just the jump seats`);
    await expect(title).toBeFocused();
    await page.reload();
    await page.unrouteAll({ behavior: "wait" });
    await expect(title).toHaveText(`Book the moving van (${tag}), just the jump seats`, {
      timeout: SLOW_MS,
    });
    // Escape in the editor keeps the old title and the card.
    await title.focus();
    await page.keyboard.press("F2");
    await page.keyboard.type("Not this");
    await page.keyboard.press("Escape");
    await expect(title).toHaveText(`Book the moving van (${tag}), just the jump seats`);
    await expect(title).toHaveAttribute("aria-expanded", "true");
    // The list's keys move on from the card's title: Home goes to the list's first row, End to
    // its last. The group holds another task, so one of them is another row.
    await title.focus();
    await page.keyboard.press("Home");
    if (await title.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press("End");
    }
    await expect(title).not.toBeFocused();
    await expect(page.locator("[data-list] [data-part='title']:focus")).toHaveCount(1);
  });
});

test.describe("[A7.3.12.m5-06.e2e.screens] The expanded task in both themes: screenshots and axe", () => {
  test("Sumi and Washi at 1,440 px and 390 px, axe clean in the expanded task", async ({
    browser,
    world,
  }) => {
    const tag = `${test.info().project.name}-screens`;
    const { ref } = await richTask(world, tag);
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
        // A task link: the sign-in's route is a path, and the route lands on the host view.
        await page.goto(await world.signInUrl(`/s/${world.mira.id}/task/${ref}`));
        await showsSpace(page, world.mira.name);
        const row = page.locator(`li[data-task="${ref}"]`);
        await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
          timeout: SLOW_MS,
        });
        await expect(row.locator("[data-entry]").first()).toBeVisible({ timeout: SLOW_MS });
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath(`expanded-${theme}-1440.png`) });
        await row.screenshot({ path: test.info().outputPath(`expanded-${theme}-1440-card.png`) });

        await page.evaluate(axe);
        const found = await page.evaluate(async (selector) => {
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

        await page.setViewportSize({ width: 390, height: 900 });
        await row.scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await page.screenshot({
          path: test.info().outputPath(`expanded-${theme}-390.png`),
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
