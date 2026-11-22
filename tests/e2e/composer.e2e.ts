// The composer's strip and the text a reload keeps (A7 3.12 M5.07), in Chromium and Firefox
// against the real service process with fixture data and the fake terminal behind Open.
//
// Verify line: Note, Open and Copy with and without text; Enter and Ctrl+Enter, never while an
// input method composes; the top field, a task's draft and a field edit that was not saved are
// back after a reload, also with a second tab open, and nothing is left behind once saved.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, type Request } from "@playwright/test";
import { PRODUCT_NAME, PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { test } from "./fixture.ts";
import { openTask, showsSpace, violations, watchViolations } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

interface Added {
  readonly tasks: readonly { readonly ref: string }[];
}

interface Digest {
  readonly as_of: string;
  readonly task: { readonly title: string; readonly priority: number };
}

async function addTask(world: World, draft: Record<string, unknown>): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", { tasks: [draft] })) as Added;
  const ref = added.tasks[0]?.ref;
  if (ref === undefined) throw new Error("the task was not added");
  return ref;
}

const read = async (world: World, ref: string): Promise<Digest> =>
  (await world.op(world.mira.id, "task.get", { task: ref })) as Digest;

const rowOf = (page: Page, ref: string) => page.locator(`main li[data-task="${ref}"]`);
const composerOf = (page: Page, ref: string) => rowOf(page, ref).locator('[data-part="composer"]');
const stripOf = (page: Page, ref: string) =>
  rowOf(page, ref).getByRole("toolbar", { name: "Act on this task" });
/** A session that opened: it runs, it ended, or the service cannot tell which. */
const OPENED = ':is([data-state="opened"], [data-state="running"], [data-state="ended"])';
const toast = (page: Page) => page.locator('[data-part="toast-text"]');
/** What the page says when an Open got no answer. */
const unanswered = `${PRODUCT_NAME} did not answer, so ${FAKE_INSTANCE.label} may be opening. Press Open again to be sure: it does not open twice.`;
const notes = (page: Page, ref: string) =>
  rowOf(page, ref).locator('[data-entry="note"] [data-part="entry-text"]');
/** What the person asked a session's agent, in its entry of the thread. */
const asked = (page: Page, ref: string) =>
  rowOf(page, ref).locator('[data-entry="session"] [data-part="asked"]');

/** The kept text of this product, for the browser and for the tab: what a reload brings back. */
const kept = (page: Page): Promise<Record<string, string>> =>
  page.evaluate((prefix) => {
    const found: Record<string, string> = {};
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i) ?? "";
        if (/\.(draft|note|top|unsaved|unanswered)\./u.test(key) && key.startsWith(prefix)) {
          found[key] = storage.getItem(key) ?? "";
        }
      }
    }
    return found;
  }, `${PRODUCT_ID}.`);

/** The calls to one operation the page makes from now on. */
function calls(page: Page, op: string): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/v1/op/${op}`)) seen.push(request);
  });
  return seen;
}

/** What the page writes to the clipboard, kept in the page: no clipboard permission needed. */
async function catchClipboard(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    navigator.clipboard.writeText = (text: string) => {
      copied.push(text);
      return Promise.resolve();
    };
  });
  return () => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
}

test.describe("[A7.3.12.m5-07.e2e.strip] The composer's strip: Note, Open and Copy, with and without text", () => {
  test("Note saves the text and clears the field; Open passes the text as the request; Copy carries it; without text Note waits and Open and Copy act as before", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Find a new flat (${tag})`, area: "home" });
    await watchViolations(page);
    await openTask(page, world, ref);
    const composer = composerOf(page, ref);
    const strip = stripOf(page, ref);
    const note = strip.locator('[data-part="note"]');
    const added = calls(page, "entry.add");
    const opened = calls(page, "launch.open");

    // Without text, Note waits and says why; Enter in the empty field sends nothing.
    await expect(note).toHaveAttribute("aria-disabled", "true");
    await expect(note).toHaveAccessibleDescription("Type a note first");
    // Playwright waits for a control to be enabled: the click a person can still make is forced.
    await note.click({ force: true });
    await expect(composer).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue("");

    // Enter saves a note; Shift+Enter is a new line.
    await composer.fill(`Ask the landlord about parking (${tag})`);
    await expect(note).toHaveAttribute("aria-disabled", "false");
    await page.keyboard.press("Enter");
    await expect(notes(page, ref)).toHaveText([`Ask the landlord about parking (${tag})`], {
      timeout: SLOW_MS,
    });
    await expect(composer).toHaveValue("");
    await page.keyboard.type("First line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Second line");
    await expect(composer).toHaveValue("First line\nSecond line");
    await note.click();
    await expect(notes(page, ref)).toHaveCount(2, { timeout: SLOW_MS });
    await expect(composer).toHaveValue("");
    expect(added).toHaveLength(2);
    expect(added[1]?.postDataJSON()).toMatchObject({
      kind: "note",
      text: "First line\nSecond line",
    });
    // Saved: nothing of it is left in the browser.
    expect(Object.keys(await kept(page))).toEqual([]);

    // Copy with text: the brief carries it, and the field clears once it is on the clipboard.
    const copied = await catchClipboard(page);
    await composer.fill(`Bring the spare keys (${tag})`);
    // What Shift-click does is said to assistive technology too, not only in the hover label.
    await expect(strip.locator('[data-part="copy"]')).toHaveAccessibleDescription(
      /Shift-click copies the context pack/u,
    );
    await strip.locator('[data-part="copy"]').click();
    await expect.poll(async () => (await copied()).length, { timeout: SLOW_MS }).toBe(1);
    expect((await copied())[0]).toContain(`Bring the spare keys (${tag})`);
    await expect(composer).toHaveValue("");
    // Shift+Copy without text: the context pack, as before.
    await strip.locator('[data-part="copy"]').click({ modifiers: ["Shift"] });
    await expect(toast(page)).toHaveText("Context pack copied", { timeout: SLOW_MS });
    expect(opened.map((r) => (r.postDataJSON() as { text?: string }).text)).toEqual([
      `Bring the spare keys (${tag})`,
      undefined,
    ]);

    // Ctrl+Enter opens the first instance with the text as the request; the field clears once it is
    // on the task, the thread shows it in the session's entry, and the terminal gets the shim's
    // command line only.
    const before = world.terminal().length;
    const open = strip.getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` });
    await expect(open).toHaveAttribute("aria-keyshortcuts", /^(Control|Meta)\+Enter$/u);
    await composer.fill(`Compare the three listings (${tag})`);
    await composer.focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
    expect(opened[2]?.postDataJSON()).toMatchObject({
      instance: FAKE_INSTANCE.key,
      text: `Compare the three listings (${tag})`,
    });
    expect(JSON.stringify(world.terminal().at(-1))).not.toContain("Compare the three listings");
    await expect(composer).toHaveValue("", { timeout: SLOW_MS });
    await expect(asked(page, ref)).toContainText(`Compare the three listings (${tag})`, {
      timeout: SLOW_MS,
    });
    expect(Object.keys(await kept(page))).toEqual([]);
    expect(await violations(page)).toEqual([]);
  });

  test("Open without text opens as the tile does, a launch that is not recorded keeps the text, and while a session runs the strip opens another only when asked @one-browser", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Paint the hallway (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const composer = composerOf(page, ref);
    const open = stripOf(page, ref).getByRole("button", {
      name: `Open in ${FAKE_INSTANCE.label}`,
    });
    // The service cannot be reached: the page cannot tell whether it started, and the text stays.
    await page.route("**/api/v1/op/launch.open", (route) => route.abort());
    await composer.fill(`Pick the colour first (${tag})`);
    await open.click();
    await expect(toast(page)).toHaveText(unanswered, { timeout: SLOW_MS });
    await expect(composer).toHaveValue(`Pick the colour first (${tag})`);
    await page.unroute("**/api/v1/op/launch.open");

    // Without text, Open sends the brief alone and the session runs.
    world.hold(ref);
    await composer.fill("");
    const opened = calls(page, "launch.open");
    const before = world.terminal().length;
    await open.click();
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
    expect(opened[0]?.postDataJSON()).not.toHaveProperty("text");
    await expect(rowOf(page, ref).locator('[data-entry][data-state="running"]')).toBeVisible({
      timeout: SLOW_MS,
    });
    // While it runs, the strip says so and opens a second session, with the words as its
    // request, when the person asks for one.
    const another = stripOf(page, ref).getByRole("button", {
      name: `Open another in ${FAKE_INSTANCE.label}`,
    });
    await expect(another).toHaveAttribute("aria-disabled", "false");
    await expect(another).toHaveAccessibleDescription(/is running on this task/u);
    await composer.fill(`Now the ceiling too (${tag})`);
    await composer.focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 2);
    expect(opened[1]?.postDataJSON()).toMatchObject({
      text: `Now the ceiling too (${tag})`,
      another: true,
    });
    world.release(ref);
  });
});

test.describe("[A7.3.12.request.e2e.thread] What a person types before Open is on the task at the click, in the thread with its session", () => {
  test("an Open whose answer was lost after the service opened it keeps the text, and pressing it again, after a reload, is that Open: one launch, one request", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Sort the post (${tag})`, area: "home" });
    world.hold(ref);
    await openTask(page, world, ref);
    const composer = composerOf(page, ref);
    const open = stripOf(page, ref).getByRole("button", {
      name: `Open in ${FAKE_INSTANCE.label}`,
    });
    const opened = calls(page, "launch.open");
    const before = world.terminal().length;
    // The service saves the words and opens the agent, but its answer never reaches the page.
    await page.route("**/api/v1/op/launch.open", async (route) => {
      await route.fetch();
      await route.abort();
    });
    const words = `The bills first (${tag})`;
    await composer.fill(words);
    await open.click();
    await expect(toast(page)).toHaveText(unanswered, { timeout: SLOW_MS });
    await expect(composer).toHaveValue(words);
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
    await page.unroute("**/api/v1/op/launch.open");
    await expect(rowOf(page, ref).locator('[data-entry][data-state="running"]')).toBeVisible({
      timeout: SLOW_MS,
    });
    // Its agent runs, and the page reloads: the button is still the Open that got no answer.
    await page.reload();
    await expect(composer).toHaveValue(words, { timeout: SLOW_MS });
    await expect(open).toHaveAttribute("aria-disabled", "false");
    for (const theme of ["sumi", "washi"] as const) {
      await world.machine("ui.theme", theme);
      await page.reload();
      await expect(open).toHaveAttribute("aria-disabled", "false", { timeout: SLOW_MS });
      await stripOf(page, ref).scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`open-unanswered-${theme}.png`) });
    }
    await world.machine("ui.theme", null);
    await open.click();
    await expect(composer).toHaveValue("", { timeout: SLOW_MS });
    const ids = opened.map((r) => (r.postDataJSON() as { request_id?: string }).request_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(world.terminal()).toHaveLength(before + 1);
    await expect(asked(page, ref)).toHaveCount(1);
    await expect(asked(page, ref)).toContainText(words);
    await expect(notes(page, ref)).toHaveCount(0);
    expect(Object.keys(await kept(page))).toEqual([]);
    world.release(ref);
  });

  test("Open clears the field at once, here and in a second tab; the thread shows the request in the session's entry, also after a reload; the words go on no command line", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Water the plants (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const second = await page.context().newPage();
    await second.goto(`${world.origin}/s/${world.mira.id}/task/${ref}`);
    await showsSpace(second, world.mira.name);
    const composer = composerOf(page, ref);
    const words = `Only the ferns, not the cactus (${tag})`;
    await composer.fill(words);
    await expect(composerOf(second, ref)).toHaveValue(words, { timeout: SLOW_MS });
    const before = world.terminal().length;
    await stripOf(page, ref)
      .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
      .click();
    // The field clears when the request is on the task, as Note's does: in both tabs.
    await expect(composer).toHaveValue("", { timeout: SLOW_MS });
    await expect(composerOf(second, ref)).toHaveValue("", { timeout: SLOW_MS });
    expect(Object.keys(await kept(page))).toEqual([]);
    for (const tab of [page, second]) {
      await expect(asked(tab, ref)).toContainText(words, { timeout: SLOW_MS });
      await expect(asked(tab, ref)).toContainText("You asked:");
      // Not a second time as a plain note.
      await expect(notes(tab, ref)).toHaveCount(0);
    }
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
    expect(JSON.stringify(world.terminal().at(-1))).not.toContain("Only the ferns");
    await expect(rowOf(page, ref).locator(`[data-entry]${OPENED}`)).toBeVisible({
      timeout: SLOW_MS,
    });
    await page.reload();
    await expect(asked(page, ref)).toContainText(words, { timeout: SLOW_MS });
    await expect(composer).toHaveValue("");
    await second.close();
  });

  test("a launch that did not open keeps the request in the thread with Open again, which opens it with the same note", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Fix the shed door (${tag})`, area: "home" });
    const id = (
      (await world.op(world.mira.id, "task.get", { task: ref })) as { task: { id: string } }
    ).task.id;
    world.refuseNextOpen(id);
    await openTask(page, world, ref);
    const composer = composerOf(page, ref);
    const words = `Oil the hinges first (${tag})`;
    await composer.fill(words);
    await stripOf(page, ref)
      .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
      .click();
    await expect(composer).toHaveValue("", { timeout: SLOW_MS });
    const failed = rowOf(page, ref).locator('[data-entry="session"][data-state="failed"]');
    await expect(failed).toBeVisible({ timeout: SLOW_MS });
    await expect(failed.locator('[data-part="asked"]')).toContainText(words);
    await expect(failed.locator('[data-part="entry-text"]')).toContainText("Did not open");
    await failed.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("request-failed.png") });

    const opened = calls(page, "launch.open");
    const before = world.terminal().length;
    await failed
      .getByRole("button", { name: `Open again with this request in ${FAKE_INSTANCE.label}` })
      .click();
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
    expect(opened[0]?.postDataJSON()).toMatchObject({ instance: FAKE_INSTANCE.key });
    expect(opened[0]?.postDataJSON()).not.toHaveProperty("text");
    const confirmed = rowOf(page, ref).locator(`[data-entry="session"]${OPENED}`);
    await expect(confirmed.locator('[data-part="asked"]')).toContainText(words, {
      timeout: SLOW_MS,
    });
    // One note on the task, the request of both launches; the failed one offers nothing now.
    const read = (await world.op(world.mira.id, "task.get", {
      task: ref,
      sections: ["notes"],
    })) as { sections: { notes: { text: string; request_for?: unknown[] }[] } };
    expect(read.sections.notes).toHaveLength(1);
    expect(read.sections.notes[0]?.request_for).toHaveLength(2);
    await expect(rowOf(page, ref).locator('[data-part="open-again"]')).toHaveCount(0);
  });
});

test.describe("[A7.3.12.request.e2e.screens] The thread's request line in both themes: screenshots and axe", () => {
  test("Sumi and Washi at 1,440 px and 390 px, a session with what was asked, axe clean", async ({
    browser,
    world,
  }) => {
    const tag = `${test.info().project.name}-request`;
    const ref = await addTask(world, { title: `Renew the bike insurance (${tag})`, area: "home" });
    const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    for (const theme of ["sumi", "washi"] as const) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await world.machine("ui.theme", theme);
        await openTask(page, world, ref);
        if (theme === "sumi") {
          await composerOf(page, ref).fill(
            "Compare the three offers first.\nThen renew the cheapest one that covers theft.",
          );
          await stripOf(page, ref)
            .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
            .click();
        }
        const entry = rowOf(page, ref).locator('[data-entry="session"]').first();
        await expect(entry.locator('[data-part="asked"]')).toBeVisible({ timeout: SLOW_MS });
        await entry.scrollIntoViewIfNeeded();
        await entry.screenshot({ path: test.info().outputPath(`request-${theme}-1440.png`) });
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
        await entry.scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await page.screenshot({ path: test.info().outputPath(`request-${theme}-390.png`) });
      } finally {
        await context.close();
      }
    }
    await world.machine("ui.theme", null);
  });
});
test.describe("[A7.3.12.m5-07.e2e.keys] The composer's keys: never while an input method composes, and listed on the sheet", () => {
  test("an Enter or Ctrl+Enter that ends a composition sends nothing, the sheet lists the keys, and a key in the sheet is the sheet's", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Write to the school (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const composer = composerOf(page, ref);
    const added = calls(page, "entry.add");
    const opened = calls(page, "launch.open");
    await composer.fill("にほんご");
    // The keys an input method sends while it composes: the composition takes them.
    await composer.evaluate((field) => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      for (const ctrlKey of [false, true]) {
        field.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    });
    // The composition is over: Enter is the note's.
    await composer.focus();
    await page.keyboard.press("Enter");
    await expect(notes(page, ref)).toHaveText(["にほんご"], { timeout: SLOW_MS });
    expect(added).toHaveLength(1);
    expect(opened).toHaveLength(0);

    // The sheet lists the composer's keys; Enter in the sheet is the sheet's, not the note's.
    await composer.fill("Not sent from the sheet");
    await page.locator("main").focus();
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("group", { name: "In a task's note or request" })).toContainText(
      "Save what you typed as a note",
    );
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(composer).toHaveValue("Not sent from the sheet");
    expect(added).toHaveLength(1);
    expect(opened).toHaveLength(0);
  });
});

test.describe("[A7.3.12.m5-07.e2e.reload] Nothing typed is lost by a reload", () => {
  test("the top field's text comes back per space after a reload of its tab, a second tab keeps its own, and it is gone once the task is added", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const { origin, mira, studio } = world;
    await page.goto(await world.signInUrl(`/s/${mira.id}/today`));
    await showsSpace(page, mira.name);
    const field = page.getByRole("textbox", { name: "New task" });
    // A paste longer than the field takes is cut: the field says so. Only Chromium lets a page
    // make a paste event that carries text.
    if (tag === "chromium") {
      await field.evaluate((input, pasted) => {
        const data = new DataTransfer();
        data.setData("text/plain", pasted);
        input.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, "x".repeat(600));
      await expect(toast(page)).toHaveText(
        "Only the first 500 characters fit here. The rest is still on the clipboard.",
      );
    }
    const text = `Call the plumber about the leak (${tag})`;
    await field.fill(text);
    await page.reload();
    await expect(field).toHaveValue(text, { timeout: SLOW_MS });

    // Another space keeps its own; a second tab keeps its own, also through its own reload.
    await page.goto(`${origin}/s/${studio.id}/today`);
    await showsSpace(page, studio.name);
    await expect(field).toHaveValue("");
    await field.fill(`Studio's own (${tag})`);
    const second = await page.context().newPage();
    await second.goto(`${origin}/s/${mira.id}/today`);
    await showsSpace(second, mira.name);
    const secondField = second.getByRole("textbox", { name: "New task" });
    await expect(secondField).toHaveValue("");
    await secondField.fill(`The second tab's own (${tag})`);
    await second.reload();
    await showsSpace(second, mira.name);
    await expect(secondField).toHaveValue(`The second tab's own (${tag})`);
    await page.goto(`${origin}/s/${mira.id}/today`);
    await showsSpace(page, mira.name);
    await expect(field).toHaveValue(text);

    // Added: the text is gone, here and after a reload; the second tab keeps its own.
    await field.focus();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText("Added to Inbox", { timeout: SLOW_MS });
    await expect(field).toHaveValue("");
    await page.reload();
    await showsSpace(page, mira.name);
    await expect(field).toHaveValue("");
    await expect(secondField).toHaveValue(`The second tab's own (${tag})`);
    const left = Object.keys(await kept(page)).filter((key) => key.includes(".top."));
    expect(left).toEqual([`${PRODUCT_ID}.top.${studio.id}`]);
    await page.goto(`${origin}/s/${studio.id}/today`);
    await expect(field).toHaveValue(`Studio's own (${tag})`, { timeout: SLOW_MS });
    await field.fill("");
    await expect.poll(async () => Object.keys(await kept(page))).toEqual([]);
    await second.close();
  });

  test("a task's draft follows into a second tab, is back after a reload, and leaves nothing behind once saved as a note", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Plan the garden (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const composer = composerOf(page, ref);
    await composer.fill(`Ask Ana about the seeds (${tag})`);

    const second = await page.context().newPage();
    await second.goto(`${world.origin}/s/${world.mira.id}/task/${ref}`);
    await showsSpace(second, world.mira.name);
    const other = composerOf(second, ref);
    await expect(other).toHaveValue(`Ask Ana about the seeds (${tag})`, { timeout: SLOW_MS });
    // Typed on in the first tab: the second, where nobody types, follows.
    await composer.focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" and the bulbs");
    await expect(other).toHaveValue(`Ask Ana about the seeds (${tag}) and the bulbs`);

    await page.reload();
    await expect(composer).toHaveValue(`Ask Ana about the seeds (${tag}) and the bulbs`, {
      timeout: SLOW_MS,
    });
    // Saved as a note from the second tab: both fields clear, and the browser keeps nothing.
    await stripOf(second, ref).locator('[data-part="note"]').click();
    await expect(notes(second, ref)).toHaveCount(1, { timeout: SLOW_MS });
    await expect(other).toHaveValue("");
    await expect(composer).toHaveValue("");
    expect(Object.keys(await kept(page))).toEqual([]);
    await page.reload();
    await expect(composer).toHaveValue("", { timeout: SLOW_MS });
    await second.close();
  });

  test("a note whose answer was lost is saved once when it is sent again after a reload", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Fix the gate (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const composer = composerOf(page, ref);
    const added = calls(page, "entry.add");
    // The service saves the note, but its answer never reaches the page.
    await page.route("**/api/v1/op/entry.add", async (route) => {
      await route.fetch();
      await route.abort();
    });
    await composer.fill(`Buy a new latch (${tag})`);
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await world.op(world.mira.id, "task.get", { task: ref, sections: ["notes"] }),
          ),
        { timeout: SLOW_MS },
      )
      .toContain(`Buy a new latch (${tag})`);
    await expect.poll(() => added.length).toBe(1);
    await expect(composer).toHaveValue(`Buy a new latch (${tag})`);
    await page.unroute("**/api/v1/op/entry.add");

    await page.reload();
    await expect(composer).toHaveValue(`Buy a new latch (${tag})`, { timeout: SLOW_MS });
    await composer.focus();
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue("", { timeout: SLOW_MS });
    await expect(notes(page, ref)).toHaveCount(1);
    expect(added).toHaveLength(2);
    const ids = added.map((r) => (r.postDataJSON() as { request_id: string }).request_id);
    expect(ids[1]).toBe(ids[0]);
    expect(Object.keys(await kept(page))).toEqual([]);
  });

  test("an add sent just before a reload, and pressed again on the words the reload kept, adds the task once", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const title = `Order the padlock (${tag})`;
    await page.goto(await world.signInUrl(`/s/${world.mira.id}/today`));
    await showsSpace(page, world.mira.name);
    const field = page.getByRole("textbox", { name: "New task" });
    // Each add reaches the service late: the first one is still on its way when the page reloads.
    const added = calls(page, "task.add");
    let answered = 0;
    await page.route("**/api/v1/op/task.add", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const response = await route.fetch();
      answered += 1;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await field.fill(title);
    await page.keyboard.press("Enter");
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(field).toHaveValue(title);
    await field.focus();
    await page.keyboard.press("Enter");
    await expect(field).toHaveValue("", { timeout: SLOW_MS });
    await expect.poll(() => answered, { timeout: SLOW_MS }).toBe(2);
    await page.unroute("**/api/v1/op/task.add");
    const ids = added.map((r) => (r.postDataJSON() as { request_id: string }).request_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    const found = (await world.op(world.mira.id, "task.search", {
      q: "padlock",
      scope: "all",
    })) as {
      rows: { title: string }[];
    };
    expect(found.rows.filter((row) => row.title === title)).toHaveLength(1);
  });

  test("an edit still waiting behind another edit of the task when the page reloads is back as not saved, never lost", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Oil the hinges (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const row = rowOf(page, ref);
    // The service answers each edit late: the priority waits behind the rename when the page goes.
    const updates = calls(page, "task.update");
    await page.route("**/api/v1/op/task.update", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const response = await route.fetch();
      await route.fulfill({ response }).catch(() => undefined);
    });
    const title = row.locator('[data-part="title"]');
    await title.focus();
    await page.keyboard.press("F2");
    await page.keyboard.press("End");
    await page.keyboard.type(" and the gate");
    await page.keyboard.press("Enter");
    await row
      .getByRole("radiogroup", { name: "Priority" })
      .getByRole("radio", { name: "P1" })
      .click();
    await page.reload();
    expect(updates).toHaveLength(1);
    await page.unrouteAll({ behavior: "wait" });
    // The rename went out, and the priority is offered again, as any edit that was not saved.
    await expect(title).toHaveText(`Oil the hinges (${tag}) and the gate`, { timeout: SLOW_MS });
    const unsaved = row.locator('[data-part="unsaved"]');
    await expect(unsaved).toHaveAttribute("data-reason", "failed", { timeout: SLOW_MS });
    await unsaved.locator('[data-part="apply-mine"]').click();
    await expect.poll(async () => (await read(world, ref)).task.priority).toBe(1);
    await expect(unsaved).toHaveCount(0);
  });

  test("a field edit that was not saved is back after a reload with its choices: the connection was down, the task changed under it, the task was finished", async ({
    page,
    world,
  }) => {
    const tag = test.info().project.name;
    const ref = await addTask(world, { title: `Fix the bike light (${tag})`, area: "home" });
    await openTask(page, world, ref);
    const row = rowOf(page, ref);

    // The connection is down: the priority waits with Try again; after a reload it still does.
    await page.route("**/api/v1/op/task.update", (route) => route.abort());
    await row
      .getByRole("radiogroup", { name: "Priority" })
      .getByRole("radio", { name: "P1" })
      .click();
    const unsaved = row.locator('[data-part="unsaved"]');
    await expect(unsaved).toHaveAttribute("data-reason", "failed", { timeout: SLOW_MS });
    await page.unroute("**/api/v1/op/task.update");
    await page.reload();
    await expect(unsaved).toHaveAttribute("data-reason", "failed", { timeout: SLOW_MS });
    await expect(unsaved).toContainText("Not saved");
    await unsaved.locator('[data-part="apply-mine"]').click();
    await expect.poll(async () => (await read(world, ref)).task.priority).toBe(1);
    await expect(unsaved).toHaveCount(0);
    expect(Object.keys(await kept(page))).toEqual([]);

    // The task changed under an open editor: Apply mine waits, also after a reload.
    const title = row.locator('[data-part="title"]');
    await title.focus();
    await page.keyboard.press("F2");
    const edit = row.locator('[data-part="title-edit"]');
    await edit.fill(`Fix the front bike light (${tag})`);
    const { as_of } = await read(world, ref);
    await world.op(
      world.mira.id,
      "task.update",
      { task: ref, set: { title: `Fix the bike lights (${tag})` }, base: as_of },
      "agent",
    );
    await page.keyboard.press("Enter");
    await expect(unsaved).toHaveAttribute("data-reason", "conflict", { timeout: SLOW_MS });
    await page.reload();
    await expect(unsaved).toHaveAttribute("data-reason", "conflict", { timeout: SLOW_MS });
    await unsaved.locator('[data-part="apply-mine"]').click();
    await expect
      .poll(async () => (await read(world, ref)).task.title)
      .toBe(`Fix the front bike light (${tag})`);
    await expect(unsaved).toHaveCount(0);

    // Finished meanwhile: the value waits with Copy and Discard, after a reload too.
    await title.focus();
    await page.keyboard.press("F2");
    await edit.fill(`Fix both bike lights (${tag})`);
    await world.op(world.mira.id, "task.finish", {
      task: ref,
      base: (await read(world, ref)).as_of,
    });
    await expect(row.locator('[data-part="lifecycle"]')).toHaveText("Checked off", {
      timeout: SLOW_MS,
    });
    await page.keyboard.press("Enter");
    await expect(unsaved).toHaveAttribute("data-reason", "finished", { timeout: SLOW_MS });
    await page.reload();
    await expect(unsaved).toHaveAttribute("data-reason", "finished", { timeout: SLOW_MS });
    await expect(unsaved.locator('[data-part="unsaved-value"]')).toHaveText(
      `Fix both bike lights (${tag})`,
    );
    await unsaved.locator('[data-part="keep-theirs"]').click();
    await expect(unsaved).toHaveCount(0);
    expect(Object.keys(await kept(page))).toEqual([]);
  });
});

test.describe("[A7.3.12.m5-07.e2e.screens] The composer's strip in both themes: screenshots and axe", () => {
  test("Sumi and Washi at 1,440 px and 390 px, empty and with text, axe clean", async ({
    browser,
    world,
  }) => {
    const tag = `${test.info().project.name}-strip`;
    const ref = await addTask(world, {
      title: `Renew the passport (${tag})`,
      area: "home",
      context: "The appointment needs the old passport and two photos.",
    });
    const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    for (const theme of ["sumi", "washi"] as const) {
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await world.machine("ui.theme", theme);
        await openTask(page, world, ref);
        const row = rowOf(page, ref);
        const composer = composerOf(page, ref);
        await composer.fill("");
        await row.scrollIntoViewIfNeeded();
        await row.screenshot({ path: test.info().outputPath(`strip-${theme}-1440-empty.png`) });
        await composer.fill("Book the earliest slot, and bring the old passport");
        await stripOf(page, ref).locator('[data-part="note"]').focus();
        await row.screenshot({ path: test.info().outputPath(`strip-${theme}-1440-text.png`) });

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
        await stripOf(page, ref).scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, "horizontal scroll at 390 px").toBeLessThanOrEqual(0);
        await page.screenshot({ path: test.info().outputPath(`strip-${theme}-390-text.png`) });
        await composer.fill("");
        await page.screenshot({ path: test.info().outputPath(`strip-${theme}-390-empty.png`) });
      } finally {
        await context.close();
      }
    }
    await world.machine("ui.theme", null);
  });
});
