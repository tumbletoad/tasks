// A restored copy opened beside its open original: the tab shows that copy, by an address of its
// own, through navigation, a task link and a reload; the page says it is a read-only copy and why
// before the person acts; and an edit there keeps the person's words, with no Try again. Fixture
// data only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn, spaceSwitcher } from "./page.ts";
import { SLOW_MS } from "./world.ts";

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
});
