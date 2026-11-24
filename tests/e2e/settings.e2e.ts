// Settings and the keyboard end to end (A7 3.12 M5.11), in Chromium and Firefox, against the real
// service process: the theme is this machine's, so a second tab and a fresh browser profile
// follow it; Open's terminal is chosen among those found and goes back to the default; the keys
// work where they should and never where a person types; the sheet lists what works; the
// single-letter setting takes the single keys away; the tooltip shows on hover and on keyboard
// focus. The service's detection sees the same two terminals on every OS (serve-entry.ts).
import { expect, type Page } from "@playwright/test";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
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

const LEGACY_THEME_KEY = `${PRODUCT_ID}.theme`;

async function open(page: Page, world: World, path: string): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}${path}`);
  await showsSpace(page, world.mira.name);
}

const html = (page: Page) => page.locator("html");
const theme = (page: Page) => page.getByRole("radiogroup", { name: "Theme" });
const terminal = (page: Page) => page.getByRole("radiogroup", { name: "Terminal" });
const keysSwitch = (page: Page) => page.getByRole("switch", { name: "Single-letter keys" });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const addField = (page: Page) => page.getByRole("textbox", { name: "New task" });
const searchField = (page: Page) => page.getByRole("textbox", { name: "Search" });

/** Chooses a radio the way a person does: a press on its label (the radio itself is hidden). */
async function choose(group: ReturnType<Page["locator"]>, name: string): Promise<void> {
  await group.locator("label", { hasText: name }).click();
  await expect(group.getByRole("radio", { name: new RegExp(`^${name}`, "u") })).toBeChecked();
}

/** Focus on the page itself, outside every field. */
async function rest(page: Page): Promise<void> {
  await page.locator("main").focus();
}

test.describe("[A7.3.12.m5-11.e2e.theme] The theme is this machine's: every tab and browser here follows it", () => {
  test("a choice shows at once, a second tab follows live, a fresh profile paints it first, and the browser keeps nothing", async ({
    page,
    browser,
    world,
  }) => {
    try {
      await watchViolations(page);
      // The theme is the machine's: this test starts from the default, whatever ran before it.
      await world.machine("ui.theme", null);
      await open(page, world, "/settings");
      await expect(html(page)).toHaveAttribute("data-theme", "sumi");
      const second = await page.context().newPage();
      await second.goto(`${world.origin}/s/${world.mira.id}/today`);
      await showsSpace(second, world.mira.name);

      await choose(theme(page), "Washi");
      await expect(html(page)).toHaveAttribute("data-theme", "washi");
      // The other tab follows without a reload.
      await expect(html(second)).toHaveAttribute("data-theme", "washi", { timeout: SLOW_MS });

      // A fresh browser profile: its first paint is already Washi, before any script ran.
      const fresh = await browser.newContext();
      try {
        const other = await fresh.newPage();
        const response = await signIn(other, world, `/s/${world.mira.id}/today`);
        expect(await response?.text()).toContain('data-theme="washi"');
        await showsSpace(other, world.mira.name);
        await expect(html(other)).toHaveAttribute("data-theme", "washi");
        expect(await other.evaluate((key) => localStorage.getItem(key), LEGACY_THEME_KEY)).toBe(
          null,
        );
        await choose(theme(page), "System");
        await expect(html(other)).toHaveAttribute("data-theme", "system", { timeout: SLOW_MS });
        await expect(html(second)).toHaveAttribute("data-theme", "system", { timeout: SLOW_MS });
      } finally {
        await fresh.close();
      }
      await choose(theme(page), "Sumi");
      await expect(html(second)).toHaveAttribute("data-theme", "sumi", { timeout: SLOW_MS });
      expect(await violations(page)).toEqual([]);
    } finally {
      await world.machine("ui.theme", null);
    }
  });

  test("a theme an older build kept in this browser is handed to this machine once", async ({
    browser,
    world,
  }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript((key) => {
        // Only the first load carries it, as an update would find it.
        if (sessionStorage.getItem("seeded") === null) {
          sessionStorage.setItem("seeded", "1");
          localStorage.setItem(key, "washi");
        }
      }, LEGACY_THEME_KEY);
      await open(page, world, "/today");
      await expect(html(page)).toHaveAttribute("data-theme", "washi", { timeout: SLOW_MS });
      await expect
        .poll(() => page.evaluate((key) => localStorage.getItem(key), LEGACY_THEME_KEY))
        .toBeNull();
      // This machine holds it now: the shell is served in it.
      await page.reload();
      await expect(html(page)).toHaveAttribute("data-theme", "washi");
    } finally {
      await context.close();
      await world.machine("ui.theme", null);
    }
  });
});

test.describe("[A7.3.12.m5-11.e2e.terminal] Open's terminal: which one and why, another one found here, and back to the default", () => {
  test("Settings says which terminal Open uses and why, takes another found here, and goes back to the default", async ({
    page,
    world,
  }) => {
    await open(page, world, "/settings");
    const group = terminal(page);
    await expect(group.getByRole("radio")).toHaveCount(3);
    await expect(group.getByRole("radio", { name: "This machine's default" })).toBeChecked();
    await expect(group).toContainText("Open uses Ghostty: the first one found.");
    try {
      await choose(group, "kitty");
      await expect(group).toContainText("Open uses kitty: chosen here.");
      // Kept by the service: a reload, and another tab, show it.
      await page.reload();
      await showsSpace(page, world.mira.name);
      await expect(terminal(page).getByRole("radio", { name: "kitty" })).toBeChecked();
      await picture(page, "terminal-kitty-1440.png");
    } finally {
      await choose(terminal(page), "This machine's default");
    }
    await expect(terminal(page)).toContainText("Open uses Ghostty: the first one found.");
  });

  test("the page reads the terminal again on focus; that answer, older than kitty's, leaves kitty chosen", async ({
    page,
    world,
  }) => {
    await open(page, world, "/settings");
    const group = terminal(page);
    await expect(group.getByRole("radio", { name: "This machine's default" })).toBeChecked();
    // The next read reaches the service before the choice, and its answer comes after it.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let read: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      read = resolve;
    });
    await page.route("**/api/v1/machine/terminal", async (route) => {
      if (route.request().postData()?.includes('"app"') === true) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      read();
      await held;
      await route.fulfill({ response }).catch(() => undefined);
    });
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await reached;
      await choose(group, "kitty");
      await expect(group).toContainText("Open uses kitty: chosen here.");
      const late = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/v1/machine/terminal") &&
          r.request().postData()?.includes('"app"') !== true,
      );
      release();
      await late;
      await expect(group.getByRole("radio", { name: "kitty" })).toBeChecked();
      await expect(group).toContainText("Open uses kitty: chosen here.");
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await choose(terminal(page), "This machine's default");
    }
  });
});

test.describe("[A7.3.12.m5-11.e2e.keys] The keys: each where it works, never where a person types", () => {
  test("n, / and Ctrl+K reach the top field, ? the sheet, and none fires while typing, composing or with Alt", async ({
    page,
    world,
  }) => {
    await open(page, world, "/inbox");
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    // n: a new task, from anywhere outside a field.
    await rest(page);
    await page.keyboard.press("n");
    await expect(addField(page)).toBeFocused();
    // Typed into the field, n, / and ? are text.
    await page.keyboard.type("n/?");
    await expect(addField(page)).toHaveValue("n/?");
    await expect(page).toHaveURL(/\/inbox$/u);
    await expect(sheet(page)).toHaveCount(0);

    // Ctrl+K searches from inside the field; the draft stays the add mode's.
    await page.keyboard.press(`${mod}+k`);
    await expect(page).toHaveURL(/\/search$/u);
    await expect(searchField(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/inbox$/u);
    await expect(addField(page)).toHaveValue("n/?");
    await addField(page).fill("");

    // / from the page searches.
    await rest(page);
    await page.keyboard.press("/");
    await expect(searchField(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/inbox$/u);

    // A composition, or Alt held: nothing.
    await rest(page);
    for (const init of [
      { key: "n", isComposing: true },
      { key: "n", keyCode: 229 },
      { key: "n", altKey: true },
      { key: "?", altKey: true },
    ]) {
      await page.evaluate((event) => {
        document
          .getElementById("main")
          ?.dispatchEvent(
            new KeyboardEvent("keydown", { ...event, bubbles: true, cancelable: true }),
          );
      }, init);
    }
    await expect(page.locator("main")).toBeFocused();
    await expect(sheet(page)).toHaveCount(0);

    // ?: the sheet, with what works in this view; Escape closes it.
    await page.keyboard.press("?");
    await expect(sheet(page)).toBeVisible();
    for (const heading of ["Anywhere", "On a task", "In the top field"]) {
      await expect(sheet(page).getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect(sheet(page).locator('[data-action="new"]')).toHaveText("n");
    await expect(sheet(page).locator('[data-action="search"]')).toContainText("/");
    // Inside the sheet, the page's keys wait.
    await page.keyboard.press("n");
    await expect(addField(page)).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
  });

  test("with single-letter keys off, no single key fires, chords still do, and the sheet says so", async ({
    page,
    world,
  }) => {
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    try {
      await open(page, world, "/settings");
      await expect(keysSwitch(page)).toBeChecked();
      await page.locator("label", { hasText: "Single-letter keys" }).click();
      await expect(keysSwitch(page)).not.toBeChecked();
      await page.goto(`${world.origin}/s/${world.mira.id}/inbox`);
      await showsSpace(page, world.mira.name);
      // The field's hint names the key that searches now.
      await expect(page.locator("header kbd")).toHaveText(/Ctrl K|⌘ K/u);
      await expect(addField(page)).toHaveAttribute("aria-keyshortcuts", /^(Control|Meta)\+K$/u);
      await rest(page);
      for (const key of ["n", "/", "?", "j"]) await page.keyboard.press(key);
      // Nothing of the page's took a key: no field, no row, no sheet. Where the focus is now is the
      // browser's: "/" is its own again, and Firefox's quick find moves to a link that matches.
      await expect(page.locator("header :focus, main :focus")).toHaveCount(0);
      await expect(page).toHaveURL(/\/inbox$/u);
      await expect(sheet(page)).toHaveCount(0);
      await page.keyboard.press(`${mod}+k`);
      await expect(searchField(page)).toBeFocused();
      await page.keyboard.press("Escape");

      // The sheet, from Settings: no single key on it, and where to turn them on.
      await page.goto(`${world.origin}/s/${world.mira.id}/settings`);
      await showsSpace(page, world.mira.name);
      await page.getByRole("button", { name: "Show every key" }).click();
      await expect(sheet(page)).toContainText("Single-letter keys are off.");
      await expect(sheet(page).locator('[data-action="new"]')).toHaveCount(0);
      await expect(sheet(page).locator('[data-action="search"]')).not.toContainText("/");
      await picture(page, "sheet-keys-off-1440.png");
      await sheet(page).getByRole("link", { name: "Turn them on in Settings" }).click();
      await expect(sheet(page)).toHaveCount(0);
      await page.locator("label", { hasText: "Single-letter keys" }).click();
      await expect(keysSwitch(page)).toBeChecked();
      await rest(page);
      await page.keyboard.press("n");
      await expect(addField(page)).toBeFocused();
    } finally {
      await world.machine("ui.single_keys", null);
    }
  });

  test("the tooltip shows after the mouse rests and at once on keyboard focus, and Escape closes it", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    await open(page, world, "/inbox");
    const gear = page.getByRole("link", { name: "Settings" });
    const tip = page.getByRole("tooltip", { includeHidden: true });
    await gear.hover();
    await expect(tip).toHaveText("Settings");
    // Escape closes a label the mouse brought, and nothing else.
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await expect(page).toHaveURL(/\/inbox$/u);
    await page.mouse.move(600, 600);
    await gear.hover();
    await expect(tip).toHaveText("Settings");
    await page.mouse.move(600, 600);
    await expect(tip).toHaveCount(0);
    // By keyboard: the field's mode button carries a label too.
    await addField(page).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Search instead" })).toBeFocused();
    await expect(tip).toHaveText("Search instead");
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Search instead" })).toBeFocused();
    await expect(page).toHaveURL(/\/inbox$/u);
    // The label is placed under the strict CSP without an inline style the policy blocks.
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A7.3.12.m5-11.e2e.screens] Settings and the sheet in both themes, wide and narrow", () => {
  test("Settings and the shortcut sheet in Sumi and Washi at 1,440 and 390 px, axe clean, no sideways scroll", async ({
    browser,
    world,
  }) => {
    try {
      for (const name of themes()) {
        await world.machine("ui.theme", name);
        const context = await browser.newContext({
          bypassCSP: true,
          viewport: { width: 1440, height: 900 },
          reducedMotion: "reduce",
        });
        try {
          const page = await context.newPage();
          await open(page, world, "/settings");
          await expect(terminal(page)).toContainText("Open uses");
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await sideScroll(page), `sideways scroll at ${String(width)} px`).toBe(0);
            if (pictures())
              expect(await axeFound(page, ["main"]), `axe on Settings in ${name}`).toEqual([]);
            await picture(page, `settings-${name}-${String(width)}.png`, { fullPage: true });
            await page.getByRole("button", { name: "Show every key" }).click();
            await expect(sheet(page)).toBeVisible();
            await picture(page, `sheet-${name}-${String(width)}.png`);
            if (pictures())
              expect(await axeFound(page, ['[role="dialog"]']), "axe on the sheet").toEqual([]);
            await page.keyboard.press("Escape");
            await expect(sheet(page)).toHaveCount(0);
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await world.machine("ui.theme", null);
    }
  });
});

async function sideScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}
