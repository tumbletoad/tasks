// A restored copy opened beside its open original: the tab shows that copy, by an address of its
// own, through navigation, a task link, a reload and a reconnect; the page says it is a read-only
// copy and why before the person acts; an edit, Run and Stop there keep the person's words and
// never reach the original. A tab on the original stops when the original closes, and its drafts
// outlive that. Fixture data only.
import { resolve } from "node:path";
import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { test } from "./fixture.ts";
import { openTask, picture, showsSpace, signIn, spaceSwitcher } from "./page.ts";
import { CODEX_INSTANCE, SLOW_MS, type World } from "./world.ts";

const COPY = "Restored copy, read-only";

/** No sideways scroll at this width. */
const sideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("[A2.3.10.5.copies.e2e] a restored copy on the page is the copy the person opened", () => {
  test("Open folder with the copy goes to the copy and stays there; it says why it is read-only, and an edit keeps the words without Try again", async ({
    page,
    copies: world,
  }) => {
    const folder = await world.restoreCopy(world.mira.id);
    const copyName = `${world.mira.name}, ${COPY}`;
    await signIn(page, world, `/s/${world.mira.id}/today`);
    await showsSpace(page, world.mira.name);
    await expect(page.locator('[data-part="read-only"]')).toHaveCount(0);

    // Open folder with the restored copy: the tab goes to the copy, never to the original.
    await spaceSwitcher(page, world.mira.name).click();
    await page
      .getByRole("dialog", { name: "Spaces on this machine" })
      .getByRole("button", { name: "Open folder" })
      .click();
    const open = page.getByRole("dialog", { name: "Open a space folder" });
    await open.getByRole("combobox", { name: "Folder" }).fill(folder);
    await open.getByRole("button", { name: "Open", exact: true }).click();
    await showsSpace(page, copyName);
    const address = new RegExp(`/s/(${world.mira.id}-copy-[0-9a-f]{12})/`, "u");
    await expect(page).toHaveURL(address);
    const copy = address.exec(page.url())?.[1] ?? "";
    const notice = page.locator('[data-part="read-only"]');
    await expect(notice).toContainText("This is a restored copy");
    await expect(notice).toContainText("space claim");

    // The switcher lists both copies; the copy is the current one and is no default to make.
    await spaceSwitcher(page, copyName).click();
    const list = page.getByRole("dialog", { name: "Spaces on this machine" });
    const current = list.locator('a[aria-current="page"]');
    await expect(current).toHaveText(new RegExp(`${world.mira.name}.*${COPY}`, "u"));
    await expect(list.getByRole("link", { name: world.mira.name, exact: true })).toBeVisible();
    const copyRow = list.locator('li:has(a[aria-current="page"])');
    await expect(copyRow).toHaveCount(1);
    await expect(copyRow.getByRole("button")).toHaveCount(0);
    await expect(copyRow).not.toContainText("Default");
    await picture(page, "copy-switcher-1440.png");
    await page.keyboard.press("Escape");

    // A task link in the copy's tab opens the task there.
    const ref = world.task.ref;
    await signIn(page, world, `/s/${copy}/task/${ref}`);
    await showsSpace(page, copyName);
    await expect(page).toHaveURL(address);
    const row = page.locator(`main li[data-task="${ref}"]`);
    const title = row.locator('[data-part="title"]');
    await expect(title).toHaveAttribute("aria-expanded", "true", { timeout: SLOW_MS });

    // An edit there: refused, the words kept with the reason, Copy and Discard, no Try again.
    const words = `${world.task.title} (typed in the copy)`;
    await title.focus();
    await page.keyboard.press("F2");
    const field = row.locator('[data-part="title-edit"]');
    await expect(field).toBeFocused();
    await field.fill(words);
    await page.keyboard.press("Enter");
    const line = row.locator('[data-part="unsaved"]');
    await expect(line).toHaveAttribute("data-reason", "read_only", { timeout: SLOW_MS });
    await expect(line.locator('[data-part="unsaved-value"]')).toHaveText(words);
    await expect(line).toContainText("Not saved: this is a restored copy");
    await expect(line.locator('[data-part="copy-mine"]')).toBeVisible();
    await expect(line.locator('[data-part="keep-theirs"]')).toBeVisible();
    await expect(line.locator('[data-part="apply-mine"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await sideScroll(page), `sideways scroll at ${String(width)} px`).toBe(0);
      await row.scrollIntoViewIfNeeded();
      await picture(page, `copy-read-only-${String(width)}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // A reload: the same copy, still read-only, and the words still there.
    await page.reload();
    await showsSpace(page, copyName);
    await expect(page).toHaveURL(address);
    await expect(notice).toBeVisible();
    await expect(line.locator('[data-part="unsaved-value"]')).toHaveText(words, {
      timeout: SLOW_MS,
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    expect(await sideScroll(page), "sideways scroll at 390 px").toBe(0);
    await picture(page, "copy-notice-390.png");

    // The original was never written.
    const original = (await world.op(world.mira.id, "task.get", { task: ref })) as {
      task: { title: string };
    };
    expect(original.task.title).toBe(world.task.title);
  });

  test("in a restored copy's tab Run and Stop never reach the original; a tab on the original that reconnects after it closed stops there, never shows the copy, and its draft outlives the closing and a reload", async ({
    page,
    copies: world,
  }) => {
    const tag = test.info().project.name;
    const added = async (title: string) =>
      (
        (await world.op(world.mira.id, "task.add", {
          tasks: [{ title: `${title} (${tag})`, area: "home" }],
        })) as { tasks: { ref: string }[] }
      ).tasks[0]?.ref ?? "";
    const row = (ref: string) => page.locator(`main li[data-task="${ref}"]`);
    const runs = (ref: string) => row(ref).locator('[data-entry="run"]');
    const runState = (ref: string) => runs(ref).first().locator('[data-part="run-state"]');
    const toast = page.locator('[data-part="toast-text"]');
    const run = (ref: string) =>
      row(ref)
        .getByRole("toolbar", { name: "Act on this task" })
        .getByRole("button", { name: `Run with ${CODEX_INSTANCE.label}` });

    // A run of the original that works until it is stopped, recorded in the backup as working.
    const copies = async () =>
      (
        (await world.space("list", {})) as {
          spaces: { id?: string; folder: string; state: string }[];
        }
      ).spaces.filter((s) => s.id === world.mira.id);
    const own = (await copies()).find((s) => s.state === "open")?.folder;
    if (own === undefined) throw new Error("no original folder");
    const ref = await added("Check the restored runs");
    world.codex(ref, ["hold"]);
    await openTask(page, world, ref);
    await run(ref).click();
    await expect(runState(ref)).toContainText("is working on it", { timeout: SLOW_MS });
    const folder = await world.restoreCopy(world.mira.id);
    await world.space("open", { path: await world.restoreCopy(world.mira.id) });
    const copy = await openFolder(page, world, folder);

    // Two restored copies of the space read the same but for their folders, which tell them apart.
    await spaceSwitcher(page, `${world.mira.name}, ${COPY}`).click();
    const restored = page
      .getByRole("dialog", { name: "Spaces on this machine" })
      .locator("li")
      .filter({ hasText: COPY });
    const count = await restored.count();
    expect(count).toBeGreaterThanOrEqual(2);
    const where = await restored.locator('[data-part="folder"]').allTextContents();
    expect(where).toHaveLength(count);
    expect(new Set(where).size).toBe(count);
    await shots(page, "copies-told-apart");
    await page.keyboard.press("Escape");
    // From here on one restored copy is open beside the original: once the original closes, the
    // space's ID means that copy and no other.
    for (const other of await copies()) {
      if (!same(other.folder, own) && !same(other.folder, folder) && other.state !== "closed") {
        await world.space("close", { space: other.folder });
      }
    }

    // The copy's tab shows the copy's record of that run: its Stop and a new Run are refused with
    // the copy's reason, and nothing reaches the original.
    await signIn(page, world, `/s/${copy}/task/${ref}`);
    await showsSpace(page, `${world.mira.name}, ${COPY}`);
    await expect(runState(ref)).toContainText("is working on it", { timeout: SLOW_MS });
    await runs(ref).first().getByRole("button", { name: /^Stop/u }).click();
    await expect(toast).toHaveText("Not stopped: this is a restored copy.");
    await shots(page, "copy-stop-refused");
    await run(ref).click();
    await expect(toast).toHaveText("Nothing was started: this is a restored copy.");
    // Open and Copy say the same, with no Try again.
    const strip = row(ref).getByRole("toolbar", { name: "Act on this task" });
    await strip
      .getByRole("button", { name: /^Open in / })
      .first()
      .click();
    await expect(toast).toHaveText("Nothing was opened: this is a restored copy.");
    await strip.getByRole("button", { name: /^Copy / }).click();
    await expect(toast).toHaveText("No brief was made: this is a restored copy.");
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(runs(ref)).toHaveCount(1);
    await openTask(page, world, ref);
    await expect(runs(ref)).toHaveCount(1);
    await expect(runState(ref)).toContainText("is working on it");
    await runs(ref).first().getByRole("button", { name: /^Stop/u }).click();
    await expect(runState(ref)).toContainText(/^Stopped\./u, { timeout: SLOW_MS });

    // A draft on a task only the original has, in a tab on the space's ID. Its feed drops, and
    // while it is away the original closes, so the ID means the restored copy now: the tab comes
    // back to the original it showed, which is not open, and never shows the copy in its place.
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/v1\/ws/u, (ws) => {
      ws.connectToServer();
      sockets.push(ws);
    });
    const only = await added("Only in the original");
    await openTask(page, world, only);
    const words = `Ask about the March totals (${tag})`;
    await row(only).locator('[data-part="composer"]').fill(words);
    const frame = page.locator("[data-phase]");
    await page.route("**/api/v1/ws-ticket", (route) => route.fulfill({ status: 503, body: "{}" }));
    await sockets.at(-1)?.close();
    await expect(frame).toHaveAttribute("data-phase", "offline", { timeout: SLOW_MS });
    await world.space("close", { space: own });
    try {
      await page.unroute("**/api/v1/ws-ticket");
      await expect(frame).toHaveAttribute("data-phase", "no_space", { timeout: SLOW_MS });
      await expect(page.locator("main")).toContainText("This space is not open on this machine");
      await expect(page.locator('[data-part="read-only"]')).toHaveCount(0);
      // A reload lands on the ID, which means no copy the person would take for the original: they
      // choose, and nothing they typed is forgotten.
      await page.reload();
      await expect(page.getByText("This space is not open on this machine")).toBeVisible({
        timeout: SLOW_MS,
      });
      await expect(page.locator(`main a[href="/s/${copy}/today"]`)).toBeVisible();
      await shots(page, "copy-original-not-open");
    } finally {
      await world.space("open", { path: own });
    }
    await openTask(page, world, only);
    await expect(row(only).locator('[data-part="composer"]')).toHaveValue(words, {
      timeout: SLOW_MS,
    });

    // The original closes again, and the copy is claimed: the copy's tab says it is the space now
    // and goes no further, and its link opens it as the space, where it takes changes.
    await signIn(page, world, `/s/${copy}/today`);
    await showsSpace(page, `${world.mira.name}, ${COPY}`);
    await world.space("close", { space: own });
    await world.space("claim", { space: folder });
    const claimed = page.locator('[data-part="claimed"]');
    await expect(claimed).toContainText("This restored copy was claimed", { timeout: SLOW_MS });
    await shots(page, "copy-claimed");
    await claimed.getByRole("link", { name: "Open it" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${world.mira.id}/`, "u"));
    await showsSpace(page, world.mira.name);
    await expect(page.locator('[data-part="read-only"]')).toHaveCount(0);
  });
});

/** Pictures of the page as it is, at 1,440 and 390 px wide, with no sideways scroll at either. */
async function shots(page: Page, name: string): Promise<void> {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await sideScroll(page), `sideways scroll at ${String(width)} px`).toBe(0);
    await picture(page, `${name}-${String(width)}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Open folder in the switcher with a restored copy's folder: the tab goes there; its key. */
async function openFolder(page: Page, world: World, folder: string): Promise<string> {
  await signIn(page, world, `/s/${world.mira.id}/today`);
  await showsSpace(page, world.mira.name);
  await spaceSwitcher(page, world.mira.name).click();
  await page
    .getByRole("dialog", { name: "Spaces on this machine" })
    .getByRole("button", { name: "Open folder" })
    .click();
  const open = page.getByRole("dialog", { name: "Open a space folder" });
  await open.getByRole("combobox", { name: "Folder" }).fill(folder);
  await open.getByRole("button", { name: "Open", exact: true }).click();
  const address = new RegExp(`/s/(${world.mira.id}-copy-[0-9a-f]{12})/`, "u");
  await expect(page).toHaveURL(address);
  return address.exec(page.url())?.[1] ?? "";
}

/** Whether two folders are one, as this OS compares names. */
const same = (a: string, b: string): boolean =>
  process.platform === "win32" || process.platform === "darwin"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
