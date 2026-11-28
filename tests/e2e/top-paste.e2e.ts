// A paste into the top field that is more than a title, against the real service: its first line
// is the title, the rest is said under the field and kept across a reload, and the task added has
// it as its context. Only Chromium lets a page make a paste event that carries text. Fixture text
// only.
import { expect, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { axeFound, picture, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS } from "./world.ts";

const field = (page: Page) => page.getByRole("textbox", { name: "New task" });

async function paste(page: Page, words: string): Promise<void> {
  await field(page).evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, words);
}

const MAIL = [
  "Fixture: the clinic's export shifts by an hour",
  "The times in the weekly export are an hour late since the change of clocks.",
  "Fixture second paragraph that must not be lost.",
].join("\n");

test.describe("[A5.top.e2e.paste] a paste that is more than a title loses no word", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "only Chromium makes a paste event that carries text",
  );

  test("the first line is the title, the rest is said under the field, kept across a reload, and becomes the task's context", async ({
    page,
    world,
  }) => {
    await signIn(page, world, `/s/${world.mira.id}/inbox`);
    await showsSpace(page, world.mira.name);
    await field(page).focus();
    await paste(page, MAIL);
    await expect(field(page)).toHaveValue("Fixture: the clinic's export shifts by an hour");
    const rest = page.locator('[data-part="top-rest"]');
    await expect(rest).toContainText("The rest goes in the task's description:");
    await expect(rest).toContainText("The times in the weekly export");

    await page.reload();
    await expect(field(page)).toBeEnabled({ timeout: SLOW_MS });
    await field(page).focus();
    await expect(field(page)).toHaveValue("Fixture: the clinic's export shifts by an hour", {
      timeout: SLOW_MS,
    });
    await expect(rest).toBeVisible();

    await field(page).press("Enter");
    await expect(field(page)).toHaveValue("", { timeout: SLOW_MS });
    await expect(rest).toHaveCount(0);
    const row = page.locator("main li[data-task]", { hasText: "clinic's export shifts" });
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="context"]')).toContainText(
      "Fixture second paragraph that must not be lost.",
      { timeout: SLOW_MS },
    );
  });

  test("the rest can be left out, and a paste that fits is the field's as it is", async ({
    page,
    world,
  }) => {
    await signIn(page, world, `/s/${world.mira.id}/inbox`);
    await showsSpace(page, world.mira.name);
    await field(page).focus();
    await paste(page, MAIL);
    await page.getByRole("button", { name: "Leave the rest of the paste out" }).click();
    await expect(page.locator('[data-part="top-rest"]')).toHaveCount(0);
    await expect(field(page)).toBeFocused();
    await field(page).fill("");
    await paste(page, "Fixture one short line");
    await expect(page.locator('[data-part="top-rest"]')).toHaveCount(0);
  });

  test("the field with the rest of a paste at 1,440 and 390 px in both themes", async ({
    browser,
    world,
  }) => {
    for (const theme of themes()) {
      await world.machine("ui.theme", theme);
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          bypassCSP: true,
          viewport: { width, height: 844 },
          reducedMotion: "reduce",
        });
        try {
          const page = await context.newPage();
          await signIn(page, world, `/s/${world.mira.id}/inbox`);
          await expect(field(page)).toBeEnabled({ timeout: SLOW_MS });
          await field(page).focus();
          await paste(page, MAIL);
          await expect(page.locator('[data-part="top-rest"]')).toBeVisible();
          await picture(page, `top-paste-${theme}-${String(width)}.png`);
          expect(await axeFound(page, ["header"])).toEqual([]);
          await page.getByRole("button", { name: "Leave the rest of the paste out" }).click();
        } finally {
          await context.close();
        }
      }
    }
    await world.machine("ui.theme", null);
  });
});
