// Projects and folders in the page: New project from a folder, a folder that is another project's
// too, a project's folder changed with the folders inside it following, a task's own folder
// set and cleared, and Open refused on its folder with the way on in place. Every change is undone
// from its toast or with Ctrl+Z. Scratch folders of this run only.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { test } from "./fixture.ts";
import {
  axeFound,
  picture,
  pictures,
  showsSpace,
  signIn,
  themes,
  violations,
  watchViolations,
} from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const toast = (page: Page) => page.locator('[data-part="toast-text"]');
const toastAction = (page: Page) => page.locator('[data-part="toast-action"]');
const newProject = (page: Page) => page.getByRole("button", { name: "New project", exact: true });
const folderField = (scope: Page | Locator) => scope.getByRole("combobox", { name: "Folder" });

/** A scratch folder of this test, removed by its full name at the end. */
function scratch(): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ttasks-e2e-projects-"));
  return {
    root,
    // A fake agent may still work in a folder for a moment, and Windows keeps a folder in use.
    done: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    },
  };
}

/** A Git checkout's folder, with the remote whose name the page shows. */
function checkout(folder: string, repo: string): void {
  mkdirSync(join(folder, ".git"), { recursive: true });
  writeFileSync(
    join(folder, ".git", "config"),
    `[remote "origin"]\n\turl = https://git.example.com/mira/${repo}.git\n`,
  );
}

async function signedIn(page: Page, world: World, to: string): Promise<void> {
  await watchViolations(page);
  await signIn(page, world, to);
  await showsSpace(page, world.mira.name);
}

test.describe("[A7.3.12.m5-14.e2e.add-project] New project from a folder, and its undo", () => {
  test("the folder's name and repository are shown, the project opens with its folder, and Undo and Redo take it out and back @one-browser", async ({
    page,
    world,
  }) => {
    const temp = scratch();
    try {
      const browser = test.info().project.name;
      const folder = join(temp.root, `atlas-${browser}`);
      checkout(folder, "atlas-web");
      await signedIn(page, world, `/s/${world.mira.id}/today`);
      await newProject(page).click();
      const dialog = page.getByRole("dialog", { name: "New project" });
      await expect(folderField(dialog)).toBeFocused();
      // Before anything is typed: the home and where the space's projects are.
      await expect(dialog.getByRole("option", { name: "Home (~)" })).toBeVisible();
      await folderField(dialog).fill(folder);
      await expect(dialog.locator('[data-part="folder-facts"]')).toHaveText(
        `The folder atlas-${browser}, a checkout of atlas-web.`,
      );
      const name = dialog.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toHaveValue(`atlas-${browser}`);
      await name.fill(`Atlas ${browser}`);
      await expect(dialog.getByLabel("Area")).toHaveValue(/^a_/u);
      await dialog.getByRole("button", { name: "Add project" }).click();

      await expect(page).toHaveURL(/\/project\/p_/u, { timeout: SLOW_MS });
      const line = page.locator('[data-part="project-folder"]');
      await expect(line).toHaveAttribute("data-state", "here");
      await expect(line).toContainText(`atlas-${browser} [atlas-web]`);
      const link = page.getByRole("link", { name: `Atlas ${browser}` });
      await expect(link).toBeVisible();
      await expect(toast(page)).toHaveText(`Project Atlas ${browser} added`);

      await toastAction(page).click();
      await expect(toast(page)).toHaveText("Undone");
      await expect(link).toHaveCount(0, { timeout: SLOW_MS });
      await toastAction(page).click();
      await expect(toast(page)).toHaveText("Redone");
      await expect(link).toBeVisible({ timeout: SLOW_MS });
      expect(await violations(page)).toEqual([]);
    } finally {
      temp.done();
    }
  });

  test("by keyboard alone: a folder found by its parent, opened with the arrow keys, and added with Enter", async ({
    page,
    world,
  }) => {
    const temp = scratch();
    try {
      const browser = test.info().project.name;
      mkdirSync(join(temp.root, `keys-${browser}`));
      await signedIn(page, world, `/s/${world.mira.id}/today`);
      await newProject(page).focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "New project" });
      const field = folderField(dialog);
      await expect(field).toBeFocused();
      const sep = process.platform === "win32" ? "\\" : "/";
      await page.keyboard.type(`${temp.root}${sep}`);
      const option = dialog.getByRole("option", { name: `keys-${browser}` });
      await expect(option).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(option).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(field).toHaveValue(new RegExp(`keys-${browser}[\\\\/]$`, "u"));
      await expect(dialog.locator('[data-part="folder-facts"]')).toHaveText(
        `The folder keys-${browser}.`,
      );
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/project\/p_/u, { timeout: SLOW_MS });
      await expect(page.getByRole("link", { name: `keys-${browser}` })).toBeVisible();
      // Ctrl+Z takes the new project back.
      await page.locator("body").press("Control+z");
      await expect(page.getByRole("link", { name: `keys-${browser}` })).toHaveCount(0, {
        timeout: SLOW_MS,
      });
      expect(await violations(page)).toEqual([]);
    } finally {
      temp.done();
    }
  });

  test("a folder that is a project's already: the same name opens that project, and a project can have no folder @one-browser", async ({
    page,
    world,
  }) => {
    const browser = test.info().project.name;
    await signedIn(page, world, `/s/${world.mira.id}/today`);
    await newProject(page).click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await folderField(dialog).fill(world.portal);
    await expect(dialog.locator('[data-part="folder-also"]')).toHaveText(
      "Also the folder of Lumen portal.",
    );
    // The project's own name in its own area is that project: it opens, and the toast says so.
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Lumen portal");
    await dialog.getByLabel("Area").selectOption({ label: "Lumen" });
    await dialog.getByRole("button", { name: "Add project" }).click();
    await expect(toast(page)).toHaveText("Lumen portal has this folder already: here it is.");
    await expect(page.locator('[data-part="project-folder"]')).toContainText(world.portal);
    await expect(page.getByRole("link", { name: "Lumen portal" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // No folder: a name and an area, one click.
    await page.getByRole("button", { name: "New project in Home" }).click();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(`Bird box ${browser}`);
    await expect(dialog.getByLabel("Area").locator("option:checked")).toHaveText("Home");
    await dialog.getByRole("button", { name: "Without a folder" }).click();
    await expect(page).toHaveURL(/\/project\/p_/u, { timeout: SLOW_MS });
    const line = page.locator('[data-part="project-folder"]');
    await expect(line).toHaveAttribute("data-state", "none");
    await expect(line).toContainText("No folder on this machine");
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A7.3.12.m5-14.e2e.project-folder] A project's folder changed after a move takes its tasks' folders along", () => {
  test("the line shows the folder, Change after a move says what followed, the task's folder follows, and Undo, Clear and Ctrl+Z put each back @one-browser", async ({
    page,
    world,
  }) => {
    const temp = scratch();
    try {
      const browser = test.info().project.name;
      const old = join(temp.root, "one", `billing-${browser}`);
      mkdirSync(join(old, "invoices"), { recursive: true });
      const project = `Billing ${browser}`;
      await world.op(world.mira.id, "folder.manage", {
        action: "add_project",
        folder: old,
        area: "Lumen",
        project,
      });
      const added = (await world.op(world.mira.id, "task.add", {
        tasks: [{ title: `Send the invoices (${browser})`, folder: join(old, "invoices") }],
      })) as { tasks: readonly { ref: string }[] };
      const ref = added.tasks[0]?.ref ?? "";

      await signedIn(page, world, `/s/${world.mira.id}/today`);
      await page.getByRole("link", { name: project }).click();
      const line = page.locator('[data-part="project-folder"]');
      await expect(line).toHaveAttribute("data-state", "here");
      await expect(line).toContainText(`billing-${browser}`);

      // The folder is moved in the file manager, then given to the project here.
      const moved = join(temp.root, "two", `billing-${browser}`);
      mkdirSync(join(temp.root, "two"));
      renameSync(old, moved);
      await line.getByRole("button", { name: "Change" }).click();
      const dialog = page.getByRole("dialog", { name: `Folder for ${project}` });
      await folderField(dialog).fill(moved);
      await expect(dialog.locator('[data-part="folder-facts"]')).toHaveText(
        `The folder billing-${browser}.`,
      );
      await dialog.getByRole("button", { name: "Use this folder" }).click();
      await expect(toast(page)).toContainText("1 folder inside the old one moved along");
      await expect(line).toContainText(join("two", `billing-${browser}`));
      const row = page.locator(`li[data-task="${ref}"]`);
      await row.locator('[data-part="title"]').click();
      const place = row.locator('[data-part="place"]');
      await expect(place).toContainText(join("two", `billing-${browser}`, "invoices"));

      // Undo puts both back where they were: the old folder, not there now.
      await toastAction(page).click();
      await expect(toast(page)).toHaveText("Undone");
      await expect(line).toHaveAttribute("data-state", "missing", { timeout: SLOW_MS });
      await expect(line).toContainText(join("one", `billing-${browser}`));
      await expect(place).toContainText(join("one", `billing-${browser}`, "invoices"));

      // Clear, then Ctrl+Z.
      await line.getByRole("button", { name: "Clear" }).click();
      await expect(toast(page)).toHaveText("Folder cleared");
      await expect(line).toHaveAttribute("data-state", "none");
      await page.locator("body").press("Control+z");
      await expect(line).toHaveAttribute("data-state", "missing", { timeout: SLOW_MS });
      expect(await violations(page)).toEqual([]);
    } finally {
      temp.done();
    }
  });
});

test.describe("[A7.3.12.m5-14.e2e.task-folder] A task's own folder set and cleared from its folder line", () => {
  test("Choose folder sets it, Clear takes it away, and Ctrl+Z gives it back", async ({
    page,
    world,
  }) => {
    const temp = scratch();
    try {
      const browser = test.info().project.name;
      const folder = join(temp.root, `notes-${browser}`);
      mkdirSync(folder);
      const added = (await world.op(world.mira.id, "task.add", {
        tasks: [{ title: `Write up the notes (${browser})`, inbox: true }],
      })) as { tasks: readonly { ref: string }[] };
      const ref = added.tasks[0]?.ref ?? "";
      await signedIn(page, world, `/s/${world.mira.id}/inbox`);
      const row = page.locator(`li[data-task="${ref}"]`);
      await row.locator('[data-part="title"]').click();
      const place = row.locator('[data-part="place"]');
      await expect(place).toHaveAttribute("data-state", "work_folder");
      await place.hover();
      await place.getByRole("button", { name: "Choose folder" }).click();
      const dialog = page.getByRole("dialog", { name: `Folder for ${ref}` });
      await folderField(dialog).fill(folder);
      await dialog.getByRole("button", { name: "Use this folder" }).click();
      await expect(place).toHaveAttribute("data-state", "here", { timeout: SLOW_MS });
      await expect(place).toContainText(`notes-${browser}`);
      await expect(toast(page)).toContainText(`Folder set to`);

      await place.hover();
      await place.getByRole("button", { name: "Clear" }).click();
      await expect(toast(page)).toHaveText("Folder cleared");
      await expect(place).toHaveAttribute("data-state", "work_folder", { timeout: SLOW_MS });
      await page.locator("body").press("Control+z");
      await expect(place).toHaveAttribute("data-state", "here", { timeout: SLOW_MS });
      await expect(place).toContainText(`notes-${browser}`);
      expect(await violations(page)).toEqual([]);
    } finally {
      temp.done();
    }
  });
});

test.describe("[A7.3.12.m5-14.e2e.open-refused] Open refused on its folder offers the way on in place", () => {
  test("a folder that is gone: Choose another folder from the toast, then Open opens there; a marker's question: Use this folder or another @one-browser", async ({
    page,
    world,
  }) => {
    const temp = scratch();
    try {
      const browser = test.info().project.name;
      const gone = join(temp.root, `gone-${browser}`);
      const other = join(temp.root, `other-${browser}`);
      mkdirSync(gone);
      mkdirSync(other);
      const added = (await world.op(world.mira.id, "task.add", {
        tasks: [
          { title: `Check the old export (${browser})`, inbox: true },
          { title: `Tag the release (${browser})`, inbox: true },
        ],
      })) as { tasks: readonly { ref: string }[] };
      const first = added.tasks[0]?.ref ?? "";
      const second = added.tasks[1]?.ref ?? "";
      await world.op(world.mira.id, "folder.manage", { action: "set", task: first, folder: gone });
      rmSync(gone, { recursive: true });
      // Every write of the set-up comes before the page opens: a feed frame of one that reached the
      // page after the refused Open would read the detail again, and that read ends the question.
      const checkoutFolder = join(temp.root, `release-${browser}`);
      mkdirSync(checkoutFolder);
      await world.op(world.mira.id, "folder.manage", {
        action: "set",
        task: second,
        folder: checkoutFolder,
      });
      // Setting it marked it; then it is moved aside and another folder made at its path.
      renameSync(checkoutFolder, `${checkoutFolder}-aside`);
      mkdirSync(checkoutFolder);

      await signedIn(page, world, `/s/${world.mira.id}/inbox`);
      const row = page.locator(`li[data-task="${first}"]`);
      const before = world.terminal().length;
      await row.locator('[data-part="tile"]').click();
      await expect(toast(page)).toContainText("was not found on this machine");
      expect(world.terminal()).toHaveLength(before);
      await expect(toastAction(page)).toHaveText("Choose another folder");
      await toastAction(page).click();
      const dialog = page.getByRole("dialog", { name: `Folder for ${first}` });
      await folderField(dialog).fill(other);
      await dialog.getByRole("button", { name: "Use this folder" }).click();
      const place = row.locator('[data-part="place"]');
      await expect(place).toContainText(`other-${browser}`, { timeout: SLOW_MS });
      await row
        .getByRole("toolbar")
        .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
        .click();
      await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);

      // A folder replaced at its path: the line offers to use it, or to choose another.
      const next = page.locator(`li[data-task="${second}"]`);
      await next.locator('[data-part="title"]').click();
      await next
        .getByRole("toolbar")
        .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
        .click();
      const nextPlace = next.locator('[data-part="place"]');
      await expect(nextPlace.getByRole("button", { name: "Use this folder" })).toBeVisible({
        timeout: SLOW_MS,
      });
      expect(world.terminal()).toHaveLength(before + 1);
      await nextPlace.getByRole("button", { name: "Choose another folder" }).click();
      const chooser = page.getByRole("dialog", { name: `Folder for ${second}` });
      await folderField(chooser).fill(other);
      await chooser.getByRole("button", { name: "Use this folder" }).click();
      await expect(nextPlace).toContainText(`other-${browser}`, { timeout: SLOW_MS });
      await expect(nextPlace.getByRole("button", { name: "Use this folder" })).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    } finally {
      temp.done();
    }
  });
});

test.describe("[A7.3.12.m5-14.e2e.screens] New project, the chooser and the folder lines in both themes, wide and narrow", () => {
  test("in Sumi and Washi at 1,440 and 390 px: axe clean, no sideways scroll, saved for review", async ({
    browser: chrome,
    world,
  }) => {
    const temp = scratch();
    const shoot = async (page: Page, name: string, where: string): Promise<void> => {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await sideScroll(page), `sideways scroll at ${String(width)} px`).toBe(0);
        if (pictures()) expect(await axeFound(page, [where]), `axe on ${name}`).toEqual([]);
        await picture(page, `${name}-${String(width)}.png`, { fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    };
    try {
      const browser = test.info().project.name;
      const folder = join(temp.root, `atlas-${browser}`);
      checkout(folder, "atlas-web");
      mkdirSync(join(temp.root, "beacon"));
      mkdirSync(join(temp.root, "cedar"));
      for (const theme of themes()) {
        await world.machine("ui.theme", theme);
        const context = await chrome.newContext({
          bypassCSP: true,
          viewport: { width: 1440, height: 900 },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        try {
          await screens(page, theme);
        } finally {
          await context.close();
        }
      }
    } finally {
      await world.machine("ui.theme", null);
      temp.done();
    }

    async function screens(page: Page, theme: string): Promise<void> {
      const browser = test.info().project.name;
      const folder = join(temp.root, `atlas-${browser}`);
      await signedIn(page, world, `/s/${world.mira.id}/today`);
      {
        await newProject(page).click();
        const dialog = page.getByRole("dialog", { name: "New project" });
        await expect(folderField(dialog)).toBeFocused();
        await expect(dialog.getByRole("option", { name: "Home (~)" })).toBeVisible();
        await shoot(page, `project-new-${theme}`, '[role="dialog"]');
        const sep = process.platform === "win32" ? "\\" : "/";
        await folderField(dialog).fill(`${temp.root}${sep}`);
        await expect(dialog.getByRole("option", { name: "cedar" })).toBeVisible();
        await shoot(page, `project-list-${theme}`, '[role="dialog"]');
        await folderField(dialog).fill(folder);
        await expect(dialog.locator('[data-part="folder-facts"]')).toContainText("atlas-web");
        await shoot(page, `project-checkout-${theme}`, '[role="dialog"]');
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await page.getByRole("link", { name: "Lumen portal" }).click();
        await expect(page.locator('[data-part="project-folder"]')).toHaveAttribute(
          "data-state",
          "here",
        );
        await shoot(page, `project-line-${theme}`, "main");
        await page
          .locator('[data-part="project-folder"]')
          .getByRole("button", { name: "Change" })
          .click();
        const chooser = page.getByRole("dialog", { name: "Folder for Lumen portal" });
        await expect(chooser.locator('[data-part="folder-facts"]')).toBeVisible();
        await shoot(page, `project-change-${theme}`, '[role="dialog"]');
        await page.keyboard.press("Escape");
        const row = page.locator("li[data-task]").first();
        await row.locator('[data-part="title"]').click();
        await row.locator('[data-part="place"]').hover();
        await shoot(page, `task-line-${theme}`, "main");
      }
      expect(await violations(page)).toEqual([]);
    }
  });
});

test.describe("[A7.3.12.e2e.pictures-hide-machine] Pictures for review hide this machine's folders and drives", () => {
  test("a picture of the open New project dialog has its folder field and list masked, and the rest shown", async ({
    page,
    world,
  }) => {
    test.skip(!pictures(), "this browser takes no pictures");
    await signedIn(page, world, `/s/${world.mira.id}/today`);
    await newProject(page).click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await expect(dialog.getByRole("option", { name: "Home (~)" })).toBeVisible();
    const centre = async (part: Locator) => {
      const box = await part.boundingBox();
      if (box === null) throw new Error("the part is not shown");
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const points = {
      list: await centre(dialog.getByRole("listbox")),
      field: await centre(folderField(dialog)),
      heading: await centre(dialog.getByRole("heading", { name: "New project" })),
    };
    await picture(page, "masked.png");
    const png = readFileSync(test.info().outputPath("masked.png")).toString("base64");
    // The picture is read back in a page of its own, without the product's CSP.
    const reader = await page.context().newPage();
    const colours = await reader.evaluate(
      async ({ png, points, scale }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("no canvas");
        context.drawImage(image, 0, 0);
        return Object.fromEntries(
          Object.entries(points).map(([name, p]) => {
            const [r, g, b] = context.getImageData(p.x * scale, p.y * scale, 1, 1).data;
            return [name, [r, g, b]];
          }),
        );
      },
      { png, points, scale: await page.evaluate(() => devicePixelRatio) },
    );
    await reader.close();
    // Playwright paints a mask in magenta.
    const masked = [255, 0, 255];
    expect(colours["list"]).toEqual(masked);
    expect(colours["field"]).toEqual(masked);
    expect(colours["heading"]).not.toEqual(masked);
  });
});

async function sideScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe("[A7.3.12.e2e.folder-shared] A folder that is another project's is shared, and the page says whose it also is", () => {
  test("New project on the portal's folder: the dialog says it is also Lumen portal's, the project is added on it, and its Change says so too; at 1,440 and 390 px @one-browser", async ({
    page,
    world,
  }) => {
    const browser = test.info().project.name;
    const project = `Portal bugs ${browser}`;
    const also = "Also the folder of Lumen portal.";
    const shoot = async (name: string): Promise<void> => {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await sideScroll(page), `sideways scroll at ${String(width)} px`).toBe(0);
        if (pictures()) expect(await axeFound(page, ['[role="dialog"]'])).toEqual([]);
        await picture(page, `${name}-${String(width)}.png`, { fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    };
    await signedIn(page, world, `/s/${world.mira.id}/today`);
    await newProject(page).click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await folderField(dialog).fill(world.portal);
    await expect(dialog.locator('[data-part="folder-also"]')).toHaveText(also);
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(project);
    await shoot("folder-shared-new");
    await dialog.getByRole("button", { name: "Add project" }).click();
    await expect(page).toHaveURL(/\/project\/p_/u, { timeout: SLOW_MS });
    await expect(toast(page)).toHaveText(`Project ${project} added`);
    const line = page.locator('[data-part="project-folder"]');
    await expect(line).toHaveAttribute("data-state", "here");
    await expect(page.getByRole("link", { name: project })).toHaveAttribute("aria-current", "page");

    // Its own folder dialog names the other project, and not itself.
    await line.getByRole("button", { name: "Change" }).click();
    const chooser = page.getByRole("dialog", { name: `Folder for ${project}` });
    await expect(chooser.locator('[data-part="folder-also"]')).toHaveText(also);
    await shoot("folder-shared-change");
    await page.keyboard.press("Escape");

    // Ctrl+Z takes the project back; the portal keeps its folder.
    await page.locator("body").press("Control+z");
    await expect(page.getByRole("link", { name: project })).toHaveCount(0, { timeout: SLOW_MS });
    await page.getByRole("link", { name: "Lumen portal" }).click();
    await expect(line).toHaveAttribute("data-state", "here");

    // Added before the chooser could look at the folder: the toast says whose it also is.
    await page.route("**/api/v1/machine/folders**", () => undefined);
    await newProject(page).click();
    await folderField(dialog).fill(world.portal);
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(project);
    await dialog.getByRole("button", { name: "Add project" }).click();
    await expect(toast(page)).toHaveText(
      `Project ${project} added. Also the folder of Lumen portal`,
      { timeout: SLOW_MS },
    );
    await page.unroute("**/api/v1/machine/folders**");
    await page.locator("body").press("Control+z");
    await expect(page.getByRole("link", { name: project })).toHaveCount(0, { timeout: SLOW_MS });
    expect(await violations(page)).toEqual([]);
  });
});
