// Looking inside a backup, as a person does it on the page: one copy of the space is open at a
// time. Open folder with a restored copy while the space is open is refused with what to do; once
// the space is closed, the copy opens and says it is a restored copy, read-only, with its folder,
// its backup and the ways out; an edit there keeps the words with the reason and no Try again; a
// claim of the copy tells the open tab that it was claimed, and the tab writes nothing more, Undo
// included. Pictures at 1,440 and 390 px. Fixture data only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn, spaceSwitcher } from "./page.ts";
import { SLOW_MS } from "./world.ts";

/** No sideways scroll at this width. */
const sideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Pictures of the page at 1,440 and 390 px, with no sideways scroll at either. */
async function pictures(page: Page, name: string, at?: () => Promise<void>): Promise<void> {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await sideScroll(page), `sideways scroll at ${String(width)} px`).toBe(0);
    await at?.();
    await picture(page, `${name}-${String(width)}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Open folder from the space switcher, whichever space the tab shows, or none. */
const openFolder = async (page: Page, folder: string) => {
  await page.getByRole("button", { name: /Switch space$/u }).click();
  await page
    .getByRole("dialog", { name: "Spaces on this machine" })
    .getByRole("button", { name: "Open folder" })
    .click();
  const form = page.getByRole("dialog", { name: "Open a space folder" });
  await form.getByRole("combobox", { name: "Folder" }).fill(folder);
  await form.getByRole("button", { name: "Open", exact: true }).click();
  return form;
};

test.describe("[A2.3.10.5.copies.e2e] a person looks inside a backup on the page", () => {
  test("a second copy is refused while the space is open; the copy opened alone says it is a restored copy; an edit there keeps the words; a claim tells the tab, which writes nothing more", async ({
    page,
    copies: world,
  }) => {
    const { name, id } = world.mira;
    const listed = (await world.space("list", {})) as {
      spaces: { id?: string; folder: string }[];
    };
    const spaceFolder = listed.spaces.find((s) => s.id === id)?.folder ?? "";
    const copyFolder = await world.restoreCopy(id);
    // Pictures of what stands, not of what fades in.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, world, `/s/${id}/today`);
    await showsSpace(page, name);

    // Open folder with the restored copy while the space is open: refused, with what is open, what
    // the folder is and what to do. Nothing changes.
    const form = await openFolder(page, copyFolder);
    const refusal = form.getByRole("alert");
    await expect(refusal).toContainText(`${name} is open from `, { timeout: SLOW_MS });
    await expect(refusal).toContainText("This folder holds a copy of it restored on");
    await expect(refusal).toContainText(`close ${name} first`);
    await expect(refusal).toContainText("space close");
    await pictures(page, "copy-refused");
    // Escape closes the dialog it is pressed in; the pictures may have taken focus out of it.
    await form.getByRole("button", { name: "Open", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expect(page.locator('[data-part="read-only"]')).toHaveCount(0);

    // The person closes the space: the tab says so and keeps what it shows.
    await world.space("close", { space: spaceFolder });
    const gone = page.locator('[data-part="gone"]');
    await expect(gone).toContainText(`${name} was closed since this page loaded it.`, {
      timeout: SLOW_MS,
    });
    await expect(gone).toContainText("To open it again, use Open folder in the space list");
    await pictures(page, "copy-closed");

    // Then opens the copy: the tab goes to it, and it says it is a restored copy before anything.
    await page.reload();
    const opened = await openFolder(page, copyFolder);
    await expect(opened).toHaveCount(0, { timeout: SLOW_MS });
    await showsSpace(page, name);
    const note = page.locator('[data-part="read-only"]');
    await expect(note).toContainText(`This is a copy of ${name} restored `);
    await expect(note).toContainText("from the backup manual-");
    await expect(note).toContainText("copy-1");
    await expect(note).toContainText(`space close ${name}`);
    await expect(note).toContainText(`space claim ${name}`);
    await pictures(page, "copy-restored", async () => {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
    });
    // The switcher says it too, with the copy's folder.
    await spaceSwitcher(page, name).click();
    const list = page.getByRole("dialog", { name: "Spaces on this machine" });
    await expect(list.locator('a[aria-current="page"]')).toContainText("Restored copy, read-only");
    await expect(list).toContainText("copy-1");
    await picture(page, "copy-switcher-1440.png");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);

    // An edit there: refused, the words kept with the reason, Copy and Discard, no Try again.
    const ref = world.task.ref;
    await signIn(page, world, `/s/${id}/task/${ref}`);
    await showsSpace(page, name);
    const row = page.locator(`main li[data-task="${ref}"]`);
    const title = row.locator('[data-part="title"]');
    await expect(title).toHaveAttribute("aria-expanded", "true", { timeout: SLOW_MS });
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
    await pictures(page, "copy-read-only-edit", () => row.scrollIntoViewIfNeeded());
    // A reload keeps the words.
    await page.reload();
    await showsSpace(page, name);
    await expect(line.locator('[data-part="unsaved-value"]')).toHaveText(words, {
      timeout: SLOW_MS,
    });

    // Words typed in the top field and not added yet.
    const top = page.getByRole("textbox", { name: "New task" });
    await top.fill("Fixture words not added yet");

    // The copy is claimed: the tab says so, offers to load it as it is now, and writes nothing
    // more. Its words stay, to copy.
    await world.space("claim", { space: copyFolder });
    await expect(gone).toContainText(`This copy of ${name} was claimed since this page loaded it`, {
      timeout: SLOW_MS,
    });
    await expect(gone.getByRole("button", { name: `Load ${name} as it is now` })).toBeVisible();
    await expect(line).toHaveAttribute("data-reason", "gone");
    await expect(line.locator('[data-part="unsaved-value"]')).toHaveText(words);
    await expect(line.locator('[data-part="apply-mine"]')).toHaveCount(0);
    // The top field keeps its words to copy, and adds nothing.
    await expect(top).toHaveValue("Fixture words not added yet");
    await expect(top).toHaveAttribute("readonly", "");
    await expect(page.locator('[data-part="top-copy"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Add the task" })).toHaveCount(0);
    await pictures(page, "copy-claimed-tab", async () => {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
    });
    // Undo from that tab reaches nothing.
    const before = (await world.op(id, "task.get", { task: ref })) as { task: { title: string } };
    await page.locator("main").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+z");
    await expect(gone).toBeVisible();
    const after = (await world.op(id, "task.get", { task: ref })) as { task: { title: string } };
    expect(after.task.title).toBe(before.task.title);
    expect(after.task.title).toBe(world.task.title);

    // Loaded again, the tab shows the space as it is now, which takes changes.
    await gone.getByRole("button", { name: `Load ${name} as it is now` }).click();
    await showsSpace(page, name);
    await expect(gone).toHaveCount(0);
    await expect(page.locator('[data-part="read-only"]')).toHaveCount(0);
  });
});

test.describe("[A2.3.10.5.copies.e2e-first-load] a tab sent to the folder the person opened loads it or nothing", () => {
  test("the first load after Open folder shows the folder the person opened, or nothing of another copy", async ({
    page,
    copies: world,
  }) => {
    const { name, id } = world.mira;
    const listed = (await world.space("list", {})) as {
      spaces: { id?: string; folder: string }[];
    };
    const spaceFolder = listed.spaces.find((s) => s.id === id)?.folder ?? "";
    const copyFolder = await world.restoreCopy(id);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, world, `/s/${id}/today`);
    await showsSpace(page, name);
    await world.space("close", { space: spaceFolder });
    const gone = page.locator('[data-part="gone"]');
    await expect(gone).toContainText(`${name} was closed since this page loaded it.`, {
      timeout: SLOW_MS,
    });

    // The person opens the copy's folder; before this tab loads it, another window closes the copy
    // and opens the space's own folder again.
    await page.route("**/api/v1/space/open", async (route) => {
      const response = await route.fetch();
      await world.space("close", { space: copyFolder });
      await world.space("open", { path: spaceFolder });
      await route.fulfill({ response });
    });
    const opened = await openFolder(page, copyFolder);
    await expect(opened).toHaveCount(0, { timeout: SLOW_MS });
    await expect(gone).toContainText(
      "Another copy of this space was opened before this page could load the folder you opened. Nothing of it was loaded here.",
      { timeout: SLOW_MS },
    );
    await expect(page.locator("main li[data-task]")).toHaveCount(0);
    await expect(page.locator('[data-part="read-only"]')).toHaveCount(0);
    await pictures(page, "copy-not-loaded");
    await page.unroute("**/api/v1/space/open");

    // Loaded again, the tab shows the space as it is now.
    await gone.getByRole("button", { name: "Load the space as it is now" }).click();
    await showsSpace(page, name);
    await expect(gone).toHaveCount(0);
    await expect(page.locator('[data-part="read-only"]')).toHaveCount(0);
  });
});
