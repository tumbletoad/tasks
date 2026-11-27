// Where the small controls of a row and its card sit (A5 3.6, 3.7), against the real service with
// fixture data, at 1,440 and 390 px: a click anywhere in a row's title column expands it, while its
// star and a selection of its text do not; in the card, a note's Remove is a bin in sight without
// hover, the folder line's icon opens the folder chooser by mouse and by keyboard, the default
// effort levels sit on one line, and Move to Trash is an icon, the last control on the Created line.
// Screenshots go to the results folder for review.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn, violations, watchViolations } from "./page.ts";
import { SLOW_MS } from "./world.ts";

/** How many lines the options of a segmented control take. */
const linesOf = (group: Locator) =>
  group
    .getByRole("radio")
    .evaluateAll(
      (cells) => new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top))).size,
    );

/** Whether nothing from the element up to the page hides it: no opacity 0, hidden or none. */
const shown = (element: Element): boolean => {
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.opacity === "0" || style.visibility === "hidden" || style.display === "none") {
      return false;
    }
  }
  return true;
};

/** Drags the mouse across `target`'s text, as a person selecting it does. */
async function select(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("nothing to select");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 2, 120), y, { steps: 5 });
  await page.mouse.up();
}

test.describe("[A5.3.7.e2e.card-controls] the row's title column expands it; the card's bin, folder icon, one-line effort and Trash icon", () => {
  test("at 1,440 and 390 px, by mouse and by keyboard", async ({ page, world }) => {
    const space = world.mira.id;
    const added = (await world.op(space, "task.add", {
      tasks: [
        {
          // Short, so the column has room beside it also at 390 px.
          title: "Fix the tap",
          summary: "The kitchen tap drips since Sunday.",
          area: "home",
          inbox: true,
        },
      ],
    })) as { tasks: readonly { ref: string }[] };
    const ref = added.tasks[0]?.ref ?? "";
    await world.op(
      space,
      "entry.add",
      { task: ref, kind: "note", text: "Ask about Tuesday." },
      "user",
    );
    await watchViolations(page);
    await signIn(page, world, `/s/${space}/inbox`);
    await showsSpace(page, world.mira.name);
    const row = page.locator(`main li[data-task="${ref}"]`);
    const title = row.locator('[data-part="title"]');
    const tooltip = page.getByRole("tooltip", { includeHidden: true });

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(title).toHaveAttribute("aria-expanded", "false", { timeout: SLOW_MS });

      // The star does only its own thing.
      const star = row.locator('[data-part="star"]');
      await star.click();
      await expect(star).toHaveAttribute("aria-pressed", "true");
      await star.click();
      await expect(star).toHaveAttribute("aria-pressed", "false");
      // Selecting the summary's words selects them.
      await select(page, row.locator('[data-part="summary"]'));
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");
      await expect(title).toHaveAttribute("aria-expanded", "false");
      await page.evaluate(() => window.getSelection()?.removeAllRanges());

      // The empty space right of the short title expands the row, and the row becomes current.
      const column = title.locator("xpath=../..");
      const room = await column.boundingBox();
      const words = await title.boundingBox();
      if (room === null || words === null) throw new Error("the row is not laid out");
      const beyond = words.x + words.width;
      expect(room.x + room.width, "room beside the title").toBeGreaterThan(beyond);
      await page.mouse.move((beyond + room.x + room.width) / 2, words.y + words.height / 2);
      await expect(column).toHaveCSS("cursor", "pointer");
      await picture(page, `row-empty-space-${String(width)}.png`);
      await page.mouse.down();
      await page.mouse.up();
      await expect(title).toHaveAttribute("aria-expanded", "true");
      await expect(title).toBeFocused();
      await page.mouse.move(0, 0);
      const body = row.locator('[data-part="expanded"]');

      // A note's Remove is a bin, in sight without the pointer on it.
      const note = body.locator('[data-entry="note"]');
      const remove = note.getByRole("button", { name: "Remove your note" });
      await expect(remove).toBeVisible({ timeout: SLOW_MS });
      await expect.poll(() => remove.evaluate(shown)).toBe(true);
      await expect(remove).toHaveText("");
      await picture(note, `note-bin-${String(width)}.png`);

      // The folder line's icon chooses the folder; no words for it at the line's end.
      const place = body.locator('[data-part="place"]');
      const choose = place.getByRole("button", { name: "Choose folder" });
      await expect(choose).toHaveCount(1);
      await expect(choose).toHaveText("");
      await choose.hover();
      await expect(tooltip).toHaveText("Choose folder");
      await picture(page, `folder-icon-${String(width)}.png`);
      await choose.click();
      const dialog = page.getByRole("dialog", { name: `Folder for ${ref}` });
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await choose.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.mouse.move(0, 0);

      // The default effort levels on one line.
      const facts = row.locator("dl");
      const effort = facts.getByRole("radiogroup", { name: "Effort" });
      await expect(effort.getByRole("radio")).toHaveCount(5);
      expect(await linesOf(effort), `effort lines at ${String(width)} px`).toBe(1);

      // Move to Trash: an icon, the last control on the Created line.
      const trash = facts.getByRole("button", { name: "Move to Trash" });
      await expect(trash).toHaveText("");
      const line = trash.locator("xpath=ancestor::dd");
      expect(await line.evaluate((dd) => dd.previousElementSibling?.textContent)).toBe("Created");
      expect(
        await line.evaluate((dd) => {
          const last = [...dd.querySelectorAll("button")].at(-1);
          if (last === undefined) return { last: undefined, after: 0 };
          const end = last.getBoundingClientRect().right;
          // What else the line shows: neither inside the button nor holding it.
          const others = [...dd.querySelectorAll("*")].filter(
            (e) => !last.contains(e) && !e.contains(last),
          );
          return {
            last: last.getAttribute("aria-label"),
            after: others.filter((e) => e.getBoundingClientRect().right > end + 1).length,
          };
        }),
      ).toEqual({ last: "Move to Trash", after: 0 });
      await trash.hover();
      await expect(tooltip).toHaveText("Move to Trash");
      await picture(facts, `facts-${String(width)}.png`);
      await picture(page, `card-${String(width)}.png`);

      await title.focus();
      await page.keyboard.press("Escape");
    }
    expect(await violations(page)).toEqual([]);
  });
});
