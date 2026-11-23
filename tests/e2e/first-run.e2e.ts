// The first start in the page, in Chromium and Firefox, against the real service process of a fresh
// install (first-run.ts): no space yet, a Claude Code and a Codex home whose commands are fakes.
// From the sign-in to a space with its agent apps without a terminal, Skip, a second visit in
// Settings, a home that changed between the view and the click, removing again, and the space
// switcher's New space and Open folder. The tests run in order on one worker's install.
import { join } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { startFresh, SLOW_MS, type FreshWorld } from "./first-run.ts";
import {
  axeFound,
  picture,
  pictures,
  showsSpace,
  signIn,
  spaceSwitcher,
  themes,
  violations,
  watchViolations,
} from "./page.ts";

const test = base.extend<object, { fresh: FreshWorld }>({
  fresh: [
    // Playwright reads the fixtures a function takes from its first parameter: none here.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const ui = process.env["E2E_UI_BUILD"];
      if (ui === undefined) throw new Error("global-setup.ts did not build the page");
      const world = await startFresh(ui);
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
});

test.describe.configure({ mode: "serial" });

const nameField = (page: Page) => page.getByRole("textbox", { name: "Name" });
const appsHeading = (page: Page) => page.getByRole("heading", { name: "Agent apps" });
const toggle = (page: Page, name: string) => page.getByRole("switch", { name });
const changes = (page: Page) => page.locator('[data-part="changes"]');
const openIn = (app: string) => `Open tasks in ${app}`;
const toolsFor = (app: string) => `Give ${app} the ${PRODUCT_NAME} tools`;

/** Turns a switch over the way a person does: a press on its label. */
async function flip(page: Page, name: string, on: boolean): Promise<void> {
  await page.locator("label", { hasText: name }).click();
  if (on) await expect(toggle(page, name)).toBeChecked();
  else await expect(toggle(page, name)).not.toBeChecked();
}

/** The space a tab shows, from its route. */
const spaceOf = (page: Page): string => /\/s\/([^/]+)\//u.exec(page.url())?.[1] ?? "";

async function firstStart(page: Page, fresh: FreshWorld): Promise<void> {
  await signIn(page, fresh, "/");
  await expect(page.getByRole("heading", { name: "Make a space" })).toBeVisible({
    timeout: SLOW_MS,
  });
}

test.describe("[A7.3.12.m5-12.e2e.skip] Skip: a space is all a person needs, and nothing else is changed", () => {
  test("a name and one button make the space, and Skip goes to it with every agent app as it was", async ({
    page,
    fresh,
  }) => {
    await watchViolations(page);
    await firstStart(page, fresh);
    await nameField(page).fill("Mira");
    await expect(page.getByText(/M-1, M-2 and on/u)).toBeVisible();
    await page.getByRole("button", { name: "Make the space" }).click();
    await expect(appsHeading(page)).toBeVisible({ timeout: SLOW_MS });
    // The usual choice is made: every switch that can be on is on.
    for (const app of ["Claude Code", "Codex"]) {
      await expect(toggle(page, openIn(app))).toBeChecked();
      await expect(toggle(page, toolsFor(app))).toBeChecked();
    }
    await page.getByRole("button", { name: "Skip for now" }).click();
    await showsSpace(page, "Mira");
    expect(fresh.claudeEntry()).toBeUndefined();
    expect(fresh.codexConfig()).not.toContain("tasks");
    expect(fresh.machineToml()).not.toContain("[[instance]]");
    expect(await violations(page)).toEqual([]);
    await fresh.forgetSpaces();
  });
});

test.describe("[A7.3.12.m5-12.e2e.first-start] The first start: a space, two apps found, one switched off, applied, and Open offers the app", () => {
  test("from the sign-in to a space whose task opens in the app that was set up @one-browser", async ({
    page,
    fresh,
  }) => {
    await firstStart(page, fresh);
    await nameField(page).fill("Studio");
    await page.getByRole("button", { name: "Choose another prefix or folder" }).click();
    await page.getByRole("textbox", { name: "Prefix" }).fill("st");
    await page.getByRole("button", { name: "Make the space" }).click();
    await expect(appsHeading(page)).toBeVisible({ timeout: SLOW_MS });
    const list = page.locator("ul").filter({ has: page.locator("[data-app]") });
    await expect(list.locator("[data-app]")).toHaveCount(2);

    await flip(page, openIn("Codex"), false);
    await expect(changes(page).locator("li")).toHaveCount(3);
    await expect(changes(page)).toContainText("Open offers Claude Code");
    await expect(changes(page)).toContainText(`Codex gets the ${PRODUCT_NAME} tools`);
    await expect(changes(page)).not.toContainText("Open offers Codex");
    await page.getByRole("button", { name: "Show exactly what is written" }).click();
    const detail = changes(page).locator("pre");
    await expect(detail).toContainText("[[instance]]");
    await expect(detail).toContainText("mcp add");

    await page.getByRole("button", { name: "Apply" }).click();
    await showsSpace(page, "Studio");
    const space = spaceOf(page);
    expect(fresh.claudeEntry()).toMatchObject({
      args: expect.arrayContaining(["--space", space, "--app", "claude-code"]),
    });
    expect(fresh.codexConfig()).toContain("[mcp_servers.ttasks]");
    expect(fresh.machineToml()).toContain('id = "claude"');
    expect(fresh.machineToml()).not.toContain('id = "codex"');

    // A task's Open button offers the app that was set up.
    await fresh.op(space, "task.add", {
      tasks: [{ title: "Draft the spring newsletter", inbox: true }],
    });
    await page.goto(`${fresh.origin}/s/${space}/inbox`);
    await showsSpace(page, "Studio");
    const row = page.locator("li[data-task]", { hasText: "Draft the spring newsletter" });
    await expect(row.locator('[data-part="tile"]')).toHaveAccessibleName("Open in Claude Code", {
      timeout: SLOW_MS,
    });
    // The prefix the person chose numbers its tasks.
    await expect(row).toHaveAttribute("data-task", "ST-1");
  });
});

test.describe("[A7.3.12.m5-12.e2e.settings] A second visit in Settings: removing is as easy as adding, and a home that changed is not written", () => {
  test("Settings shows the apps as they stand, takes one out, refuses a changed home with the new view, and takes the rest out @one-browser", async ({
    page,
    fresh,
  }) => {
    await signIn(page, fresh, "/");
    await showsSpace(page, "Studio");
    const space = spaceOf(page);
    await page.goto(`${fresh.origin}/s/${space}/settings`);
    await expect(appsHeading(page)).toBeVisible();
    await expect(toggle(page, openIn("Claude Code"))).toBeChecked();
    await expect(toggle(page, toolsFor("Claude Code"))).toBeChecked();
    await expect(toggle(page, openIn("Codex"))).not.toBeChecked();
    await expect(toggle(page, toolsFor("Codex"))).toBeChecked();
    await expect(changes(page)).toHaveCount(0);

    // Removing: one switch, then Apply.
    await flip(page, toolsFor("Codex"), false);
    await expect(changes(page)).toContainText(`Codex no longer has the ${PRODUCT_NAME} tools`);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("status")).toContainText("Done.");
    expect(fresh.codexConfig()).not.toContain("[mcp_servers.ttasks]");

    // Codex's file changes between the view and the click: nothing is written, the new view shows.
    await flip(page, toolsFor("Codex"), true);
    fresh.touchCodex();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("alert")).toContainText("Something changed on this machine");
    await picture(page, "settings-apps-changed-1440.png");
    const bare = fresh.codexConfig();
    expect(bare).not.toContain("[mcp_servers.ttasks]");
    // The choice stays, against the new view: one more press applies it.
    await expect(toggle(page, toolsFor("Codex"))).toBeChecked();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("status")).toContainText("Done.");
    expect(fresh.codexConfig()).toContain("[mcp_servers.ttasks]");

    // Changed by hand: the switch still turns the tools off, and the person's entry stays, said
    // apart from the tools.
    fresh.editCodexEntry();
    const edited = fresh.codexConfig();
    await page.reload();
    await expect(appsHeading(page)).toBeVisible();
    await expect(page.getByText("Changed by hand since.")).toBeVisible();
    await flip(page, toolsFor("Codex"), false);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("status")).toContainText(
      `Codex no longer has the ${PRODUCT_NAME} tools. Your changed entry is still in ~`,
    );
    await picture(page, "settings-apps-kept-1440.png");
    expect(fresh.codexConfig()).toBe(edited);
    await expect(toggle(page, toolsFor("Codex"))).not.toBeChecked();
    // The person takes it out.
    fresh.writeCodex(bare);
    await page.reload();
    await expect(appsHeading(page)).toBeVisible();

    // Everything out again, from the same place.
    await flip(page, openIn("Claude Code"), false);
    await flip(page, toolsFor("Claude Code"), false);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("status")).toContainText("Done.");
    expect(fresh.claudeEntry()).toBeUndefined();
    expect(fresh.codexConfig()).not.toContain("[mcp_servers.ttasks]");
    expect(fresh.machineToml()).not.toContain('id = "claude"');
    // Open no longer offers it in this tab: the apply took a fresh snapshot.
    await page
      .getByRole("link", { name: /^Inbox/u })
      .first()
      .click();
    const row = page.locator("li[data-task]", { hasText: "Draft the spring newsletter" });
    await expect(row.locator('[data-part="tile"]')).toBeVisible();
    await expect(row.locator('[data-part="tile"]')).not.toHaveAccessibleName("Open in Claude Code");
  });
});

test.describe("[A7.3.12.m5-12.e2e.switcher] The space switcher's New space and Open folder", () => {
  test("New space makes one and goes to it; Open folder serves a space folder and goes to it @one-browser", async ({
    page,
    fresh,
  }) => {
    await signIn(page, fresh, "/");
    await showsSpace(page, "Studio");
    await spaceSwitcher(page, "Studio").click();
    await page.getByRole("button", { name: "New space" }).click();
    const dialog = page.getByRole("dialog", { name: "Make a space" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Garden");
    await dialog.getByRole("button", { name: "Make the space" }).click();
    await showsSpace(page, "Garden");

    await spaceSwitcher(page, "Garden").click();
    await page.getByRole("button", { name: "Open folder" }).click();
    const open = page.getByRole("dialog", { name: "Open a space folder" });
    // A folder that is not a full path is refused in the service's words.
    await open.getByRole("combobox", { name: "Folder" }).fill("spaces/mira");
    await open.getByRole("button", { name: "Open", exact: true }).click();
    await expect(open.getByRole("alert")).toBeVisible();
    // Mira, made at the first start and forgotten since: its folder holds it still.
    await open.getByRole("combobox", { name: "Folder" }).fill(join(fresh.spaces, "mira"));
    await open.getByRole("button", { name: "Open", exact: true }).click();
    await showsSpace(page, "Mira");
  });
});

test.describe("[A7.3.12.m5-12.e2e.screens] The first start and the agent apps in both themes, wide and narrow", () => {
  test("the space form, the agent apps and Settings' agent apps in Sumi and Washi at 1,440 and 390 px, axe clean, no sideways scroll", async ({
    browser,
    fresh,
  }) => {
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
      const spaces = { sumi: "Work", washi: "Home" } as const;
      for (const theme of themes()) {
        const space = spaces[theme];
        await fresh.machine("ui.theme", theme);
        await fresh.forgetSpaces();
        const context = await browser.newContext({
          bypassCSP: true,
          viewport: { width: 1440, height: 900 },
          reducedMotion: "reduce",
        });
        try {
          const page = await context.newPage();
          await firstStart(page, fresh);
          await nameField(page).fill(space);
          await expect(page.getByText(/-1, .*-2 and on/u)).toBeVisible();
          await shoot(page, `start-${theme}`, "main");
          await page.getByRole("button", { name: "Choose another prefix or folder" }).click();
          await shoot(page, `start-more-${theme}`, "main");
          await page.getByRole("button", { name: "Open a space folder instead" }).click();
          await shoot(page, `start-open-${theme}`, "main");
          await page.getByRole("button", { name: "Make a new space instead" }).click();
          await nameField(page).fill(space);
          await page.getByRole("button", { name: "Make the space" }).click();
          await expect(appsHeading(page)).toBeVisible({ timeout: SLOW_MS });
          // The details name the fake agents' own paths in this run's scratch folder: not shot.
          await shoot(page, `start-apps-${theme}`, "main");
          await page.getByRole("button", { name: "Skip for now" }).click();
          await showsSpace(page, space);
          await page.goto(`${fresh.origin}/s/${spaceOf(page)}/settings`);
          await expect(appsHeading(page)).toBeVisible();
          await flip(page, toolsFor("Codex"), true);
          await shoot(page, `settings-apps-${theme}`, "main");
          await spaceSwitcher(page, space).click();
          await page.getByRole("button", { name: "New space" }).click();
          await expect(page.getByRole("dialog", { name: "Make a space" })).toBeVisible();
          await shoot(page, `new-space-${theme}`, '[role="dialog"]');
        } finally {
          await context.close();
        }
      }
    } finally {
      await fresh.machine("ui.theme", null);
    }
  });
});

async function sideScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}
