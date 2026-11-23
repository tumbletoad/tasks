// The app shell end to end (A7 3.12 M5.01), in Chromium and Firefox, against the real service
// process with fixture data.
//
// Verify line: No style is blocked under the strict CSP. Switching space in one tab leaves another
// tab on its space, and a new tab opens the default space. (The contrast and the lint are unit
// tests: packages/web/src/theme/contrast.test.ts, scripts/lint-rules.test.ts.)
import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { CLI_NAME, PRODUCT_ID, PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { test } from "./fixture.ts";
import {
  picture,
  pictures,
  showsSpace,
  signIn,
  spaceSwitcher,
  violations,
  watchViolations,
} from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

const THEME_KEY = `${PRODUCT_ID}.theme`;

const field = (page: Page) => page.getByRole("textbox", { name: "New task" });
const spaces = (page: Page) => page.getByRole("dialog", { name: "Spaces on this machine" });

/** Chooses a theme the way a person does: a press on its label (the radio itself is hidden). */
/** The service's answer to the page's choice of `theme`. */
const kept = (page: Page, theme: string) =>
  page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/machine/pref") &&
      response.request().postData()?.includes(`"value":"${theme}"`) === true,
  );

async function choose(page: Page, theme: string): Promise<void> {
  await page.locator("label", { hasText: theme }).click();
  await expect(page.getByRole("radio", { name: new RegExp(`^${theme}`) })).toBeChecked();
}

/** Opens the switcher and picks `name`: this tab only moves to that space. */
async function switchTo(page: Page, from: string, name: string): Promise<void> {
  await spaceSwitcher(page, from).click();
  await spaces(page).getByRole("link", { name }).click();
  await showsSpace(page, name);
}

test.describe("[A7.3.12.m5-01.e2e.space-per-tab] Each tab keeps its space; a new tab opens the default", () => {
  test("switching space in one tab leaves another tab on its space, and a new tab opens the default space", async ({
    context,
    world,
  }) => {
    const { origin, mira, studio } = world;
    const project = test.info().project.name;
    const a = await context.newPage();
    const b = await context.newPage();
    await signIn(a, world, `/s/${mira.id}`);
    await showsSpace(a, mira.name);
    await expect(a).toHaveURL(`${origin}/s/${mira.id}/today`);
    // The second tab uses the token the first one stored, on a view of its own.
    await b.goto(`${origin}/s/${mira.id}/inbox`);
    await showsSpace(b, mira.name);
    await expect(b.getByRole("link", { name: /^Inbox, \d+ tasks?$/ })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Drafts in both tabs, then tab A switches to Studio.
    const draftA = `Ask about the lease (${project})`;
    const draftB = `Return the library books (${project})`;
    await field(a).fill(draftA);
    await field(b).fill(draftB);
    await switchTo(a, mira.name, studio.name);
    await expect(a).toHaveURL(`${origin}/s/${studio.id}/today`);
    // Studio's Today, live: its tasks wait in the Inbox, so nothing is planned.
    await expect(a.getByText("Nothing planned.")).toBeVisible();
    await expect(a.getByRole("link", { name: /^Inbox, \d+ tasks?$/ })).toBeVisible();
    await expect(field(a)).toHaveValue("");

    // Tab B is still on Mira: its route, its draft, and a feed of Mira's that still delivers.
    await expect(b).toHaveURL(`${origin}/s/${mira.id}/inbox`);
    await showsSpace(b, mira.name);
    await expect(field(b)).toHaveValue(draftB);
    await field(b).press("Enter");
    await expect(b.locator('[data-part="title"]', { hasText: draftB })).toBeVisible();
    await expect(a.locator('[data-part="title"]', { hasText: draftB })).toHaveCount(0);

    // Back to Mira in tab A: its draft is still there, and B's add is in Mira's Inbox.
    await switchTo(a, studio.name, mira.name);
    await expect(field(a)).toHaveValue(draftA);
    await a.getByRole("link", { name: /^Inbox, \d+ tasks?$/ }).click();
    await expect(a.locator('[data-part="title"]', { hasText: draftB })).toBeVisible();
    await a.goBack();
    await expect(a).toHaveURL(`${origin}/s/${mira.id}/today`);

    // Make default: Studio. It changes only what a new tab opens.
    await spaceSwitcher(a, mira.name).click();
    await spaces(a)
      .getByRole("button", { name: `Make ${studio.name} the default space` })
      .click();
    await expect(a.getByText(`New tabs open ${studio.name}.`)).toBeVisible();
    await expect(spaces(a).getByText("Default", { exact: true })).toBeVisible();
    await a.keyboard.press("Escape");
    await expect(a).toHaveURL(`${origin}/s/${mira.id}/today`);
    await expect(b).toHaveURL(`${origin}/s/${mira.id}/inbox`);
    await showsSpace(b, mira.name);

    const c = await context.newPage();
    await c.goto(`${origin}/`);
    await expect(c).toHaveURL(`${origin}/s/${studio.id}/today`, { timeout: SLOW_MS });
    await showsSpace(c, studio.name);
    // A task link without a space opens in the default space too, on the task's host view: S-1
    // is in the Inbox (A5 3.3).
    await c.goto(`${origin}/?task=S-1`);
    await expect(c).toHaveURL(`${origin}/s/${studio.id}/inbox?task=S-1`);

    // And back: Mira is the default again, so the world's other tests see the machine as it was.
    await spaceSwitcher(c, studio.name).click();
    await spaces(c)
      .getByRole("button", { name: `Make ${mira.name} the default space` })
      .click();
    await expect(c.getByText(`New tabs open ${mira.name}.`)).toBeVisible();
    const d = await context.newPage();
    await d.goto(`${origin}/`);
    await expect(d).toHaveURL(`${origin}/s/${mira.id}/today`, { timeout: SLOW_MS });
    await expect(c).toHaveURL(`${origin}/s/${studio.id}/inbox?task=S-1`);
  });
});

test.describe("[A7.3.12.m5-01.e2e.strict-csp] The shell under the strict CSP", () => {
  test("no style is blocked: React Aria's style takes the nonce, the bundled fonts load, nothing leaves the origin", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const response = await signIn(page, world, `/s/${world.mira.id}`);
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/]{22}=='/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    await showsSpace(page, world.mira.name);

    // A press on React Aria's controls: the switcher's popover, Settings' radio group.
    await spaceSwitcher(page, world.mira.name).click();
    await expect(spaces(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(`${world.origin}/s/${world.mira.id}/settings`);
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await background()).toBe("rgb(23, 22, 20)");
    await choose(page, "Washi");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "washi");
    expect(await background()).toBe("rgb(245, 242, 235)");
    await page.emulateMedia({ colorScheme: "dark" });
    // A choice made while another is on its way is sent after that one's answer: the reload waits
    // until the service kept System.
    const system = kept(page, "system");
    await choose(page, "System");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
    expect(await background()).toBe("rgb(23, 22, 20)");
    await page.emulateMedia({ colorScheme: "light" });
    expect(await background()).toBe("rgb(245, 242, 235)");
    // The choice holds after a reload.
    await system;
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
    const sumi = kept(page, "sumi");
    await choose(page, "Sumi");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "sumi");
    // This machine keeps the choice: the browser keeps none of its own.
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBeNull();
    await sumi;
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "sumi");

    // The narrow layout's drawer is a React Aria modal too.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Views and areas" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: /^Open, \d+ tasks?$/ }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(`${world.origin}/s/${world.mira.id}/open`);

    // Every style element carries the page's nonce; no inline style attribute came from markup.
    const styles = await page.evaluate(() => {
      const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content");
      return [...document.querySelectorAll("style")].map((s) => ({
        id: s.id,
        ok: nonce !== null && nonce !== undefined && s.nonce === nonce,
      }));
    });
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.every((s) => s.ok)).toBe(true);
    // Every script and stylesheet the live page holds is a file of the build with its hash.
    const files = await page.evaluate(() =>
      [...document.querySelectorAll("script[src], link[rel=stylesheet]")].map(
        (el) =>
          `${el.getAttribute("src") ?? el.getAttribute("href") ?? ""} ${el.getAttribute("integrity") ?? "no hash"}`,
      ),
    );
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) expect(file).toMatch(/^\/assets\/\S+ sha384-/);

    // The bundled faces load from this origin.
    const faces = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family);
    });
    expect(faces.map((f) => f.replaceAll('"', ""))).toContain("Inter Variable");
    for (const url of requests) {
      expect(url.startsWith(`${world.origin}/`) || url.startsWith("ws://127.0.0.1:"), url).toBe(
        true,
      );
    }

    // The web app manifest, its icons, and no service worker.
    const manifest = await page.request.get(`${world.origin}/manifest.webmanifest`);
    expect(manifest.status()).toBe(200);
    const body = (await manifest.json()) as {
      name: string;
      start_url: string;
      icons: { src: string }[];
    };
    expect(body.name).toBe(PRODUCT_NAME);
    expect(body.start_url).toBe("/");
    for (const icon of body.icons) {
      expect((await page.request.get(`${world.origin}${icon.src}`)).status(), icon.src).toBe(200);
    }
    const workers = await page.evaluate(async () =>
      "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    );
    expect(workers).toBe(0);
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A5.3.19.e2e.screens] The shell in Sumi, Washi and System, wide and narrow", () => {
  test("screenshots of every theme at 1,440 and 390 px, with the switcher and the drawer open", async ({
    page,
    world,
  }) => {
    await signIn(page, world, `/s/${world.mira.id}/task/${world.task.ref}`);
    const row = page.locator(`li[data-task="${world.task.ref}"]`);
    await expect(row).toHaveAttribute("data-expanded", "true");
    // System is shown with the machine in light mode, so it differs from Sumi.
    const shown = [
      { theme: "sumi", scheme: "dark" },
      { theme: "washi", scheme: "dark" },
      { theme: "system", scheme: "light" },
    ] as const;
    for (const { theme, scheme } of pictures() ? shown : shown.slice(0, 1)) {
      // Reduced motion: no transition is caught half way in a screenshot.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await world.machine("ui.theme", theme);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await expect(row).toHaveAttribute("data-expanded", "true");
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const scroll = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(scroll, `horizontal scroll at ${String(width)} px`).toBeLessThanOrEqual(0);
        await picture(page, `shell-${theme}-${String(width)}.png`, { fullPage: true });
      }
      await page.getByRole("button", { name: "Menu" }).click();
      await expect(page.getByRole("dialog", { name: "Views and areas" })).toBeVisible();
      await picture(page, `shell-${theme}-390-drawer.png`);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 900 });
      await spaceSwitcher(page, world.mira.name).click();
      await expect(spaces(page).getByRole("link", { name: world.studio.name })).toBeVisible();
      await picture(page, `shell-${theme}-1440-spaces.png`);
      await page.keyboard.press("Escape");
    }
    // The tests of a worker share its service: the theme goes back to its default.
    await world.machine("ui.theme", null);
  });
});

/** The tab's feed sockets, each with a switch that holds what the service sends it. */
interface Feed {
  hold: boolean;
  readonly held: (string | Buffer)[];
  release(): void;
}

/** Routes the page's feed sockets through the test, so a test can hold back a confirmation. */
async function feeds(page: Page): Promise<Feed[]> {
  const sockets: Feed[] = [];
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    const server = ws.connectToServer();
    const feed: Feed = {
      hold: false,
      held: [],
      release() {
        this.hold = false;
        for (const message of this.held.splice(0)) ws.send(message);
      },
    };
    sockets.push(feed);
    server.onMessage((message) => {
      if (feed.hold) feed.held.push(message);
      else ws.send(message);
    });
  });
  return sockets;
}

test.describe("[A7.3.12.m5-01.e2e.add-once] An add on its way is sent once, and its text goes once", () => {
  test("Enter again before the feed confirms sends nothing more; the add lands once", async ({
    page,
    world,
  }) => {
    const sockets = await feeds(page);
    const adds: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/op/task.add")) adds.push(request.url());
    });
    // The Inbox, where the add field puts a task.
    await signIn(page, world, `/s/${world.mira.id}/inbox`);
    await showsSpace(page, world.mira.name);
    await expect(field(page)).toBeEnabled();
    const feed = sockets.at(-1);
    if (feed === undefined) throw new Error("the page opened no feed");

    // The service takes the add, but its confirmation is held back.
    feed.hold = true;
    const title = `Water the office plants (${test.info().project.name})`;
    await field(page).fill(title);
    await Promise.all([page.waitForResponse("**/api/v1/op/task.add"), field(page).press("Enter")]);
    await field(page).press("Enter");
    await page.getByRole("button", { name: "Add the task" }).click();
    await expect(field(page)).toHaveValue(title);

    feed.release();
    await expect(page.locator('[data-part="title"]', { hasText: title })).toHaveCount(1, {
      timeout: SLOW_MS,
    });
    await expect(field(page)).toHaveValue("");
    expect(adds).toHaveLength(1);
  });

  test("the next draft typed before the feed confirms an add stays in the field", async ({
    page,
    world,
  }) => {
    const sockets = await feeds(page);
    await signIn(page, world, `/s/${world.mira.id}/inbox`);
    await showsSpace(page, world.mira.name);
    await expect(field(page)).toBeEnabled();
    const feed = sockets.at(-1);
    if (feed === undefined) throw new Error("the page opened no feed");

    feed.hold = true;
    const project = test.info().project.name;
    const first = `Call the plumber (${project})`;
    const second = `Water the plants (${project})`;
    await field(page).fill(first);
    await Promise.all([page.waitForResponse("**/api/v1/op/task.add"), field(page).press("Enter")]);
    // The person goes on typing the next one while the first waits for its confirmation.
    await field(page).fill(second);
    feed.release();
    await expect(page.locator('[data-part="title"]', { hasText: first })).toHaveCount(1, {
      timeout: SLOW_MS,
    });
    await expect(field(page)).toHaveValue(second);
  });

  test("a switch of space before the feed confirms an add leaves no draft of it behind", async ({
    page,
    world,
  }) => {
    const sockets = await feeds(page);
    await signIn(page, world, `/s/${world.mira.id}`);
    await showsSpace(page, world.mira.name);
    await expect(field(page)).toBeEnabled();
    const feed = sockets.at(-1);
    if (feed === undefined) throw new Error("the page opened no feed");

    feed.hold = true;
    const title = `Send the meeting notes (${test.info().project.name})`;
    await field(page).fill(title);
    await Promise.all([page.waitForResponse("**/api/v1/op/task.add"), field(page).press("Enter")]);
    // The old space's session stops with its confirmation still held back.
    await switchTo(page, world.mira.name, world.studio.name);
    await switchTo(page, world.studio.name, world.mira.name);
    await page.getByRole("link", { name: /^Inbox, \d+ tasks?$/ }).click();
    await expect(page.locator('[data-part="title"]', { hasText: title })).toHaveCount(1, {
      timeout: SLOW_MS,
    });
    await expect(field(page)).toHaveValue("");
  });
});

/** A fixture task's host view with the task expanded: the area view of its area (A5 3.3). */
const hostOf = (world: World, ref: string) =>
  new RegExp(`^${world.origin}/s/${world.mira.id}/area/[a-z0-9_]+\\?task=${ref}$`);

test.describe("[A7.3.12.m5-01.e2e.task-links] A route that names a task opens that task", () => {
  test("the chooser of a machine without a default keeps the task a link named", async ({
    page,
    world,
  }) => {
    // The machine's default is unset, as the page reads it: the person chooses the space.
    await page.route("**/api/v1/space/list", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { result: Record<string, unknown> };
      await route.fulfill({
        response,
        json: { ...body, result: { ...body.result, default: null } },
      });
    });
    // The link `ttasks open <task>` makes without a space.
    await signIn(page, world, `/task/${world.task.ref}`);
    await page.getByRole("link", { name: world.mira.name }).click();
    // The task route lands on the task's host view, the task in its URL (A5 3.3).
    await expect(page).toHaveURL(hostOf(world, world.task.ref));
    await expect(page.locator(`li[data-task="${world.task.ref}"]`)).toHaveAttribute(
      "data-expanded",
      "true",
    );
  });

  test("going from one task's route to another's, and back, expands the task each names", async ({
    page,
    world,
  }) => {
    const first = page.locator(`li[data-task="${world.task.ref}"]`);
    const second = page.locator(`li[data-task="${world.spare.ref}"]`);
    await signIn(page, world, `/s/${world.mira.id}/task/${world.task.ref}`);
    await expect(first).toHaveAttribute("data-expanded", "true");
    // A navigation inside the page, as the router makes one.
    await page.evaluate((path) => {
      history.pushState(null, "", path);
    }, `/s/${world.mira.id}/task/${world.spare.ref}`);
    await expect(second).toHaveAttribute("data-expanded", "true");
    await expect(first).not.toHaveAttribute("data-expanded", "true");
    await expect(page).toHaveURL(hostOf(world, world.spare.ref));
    await page.goBack();
    await expect(page).toHaveURL(hostOf(world, world.task.ref));
    await expect(first).toHaveAttribute("data-expanded", "true");
    await expect(second).not.toHaveAttribute("data-expanded", "true");
  });
});

test.describe("[A5.3.3.e2e.not-open] A space that is not open says why and what to run", () => {
  test("a machine whose only space needs recovery names the command, never space create @one-browser", async ({
    page,
    world,
  }) => {
    // The service's answer for a space whose open was refused before it learned its ID.
    await page.route("**/api/v1/space/list", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { result: Record<string, unknown> };
      await route.fulfill({
        response,
        json: {
          ...body,
          result: {
            spaces: [],
            unopened: [{ state: "unavailable", reason: "needs_recovery" }],
            default: null,
          },
        },
      });
    });
    await signIn(page, world, "/");
    const note = page.locator('[data-part="not-open"]');
    await expect(note).toHaveAttribute("data-why", "needs_recovery");
    await expect(note).toContainText(`${CLI_NAME} space recover`);
    await expect(page.getByText(`${CLI_NAME} space create`)).toHaveCount(0);
    await picture(page, "landing-needs-recovery.png");
  });

  test("a link to a space the machine does not have says so, and never lands on the default", async ({
    page,
    world,
  }) => {
    // A name where the ID goes, as an older command line wrote it, with any character a name
    // may hold: the page offers the spaces and chooses none, also after the sign-in.
    for (const name of ["Shared List", "Café"]) {
      await signIn(page, world, `/s/${name}/task/M-1`);
      await expect(page.locator('[data-part="unknown-space"]')).toHaveText(
        "This link names a space this machine does not have, so no space was opened.",
      );
      await expect(page).toHaveURL(/\/s\/unknown$/);
    }
    await signIn(page, world, "/s/Mira/task/M-1");
    await expect(page.locator('[data-part="unknown-space"]')).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New task" })).toHaveCount(0);
    await picture(page, "landing-unknown-space.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await picture(page, "landing-unknown-space-390.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("link", { name: world.mira.name }).click();
    await showsSpace(page, world.mira.name);
    // An ID of no space here: its page says the space is not open.
    await signIn(page, world, `/s/sp_${"0".repeat(26)}`);
    await expect(
      page.getByText(`This space is not open on this machine. ${CLI_NAME} space list`),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/s\/sp_0{26}/);
  });
});

test.describe("[A5.3.3.e2e.backup-trouble] A space whose backups fail says so calmly in the switcher", () => {
  test("the switcher carries a mark, and its popover names what to run; the mark goes when backups work again", async ({
    page,
    world,
  }) => {
    // The service's answer for an open space whose daily backup failed for want of disk space.
    let failing = true;
    await page.route("**/api/v1/space/list", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        result: { spaces: { id: string }[] } & Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: {
          ...body,
          result: {
            ...body.result,
            spaces: body.result.spaces.map((s) =>
              s.id === world.mira.id && failing ? { ...s, backup: "disk_full" } : s,
            ),
          },
        },
      });
    });
    // Screenshots of the popover as it stands, not as it fades in.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, world, `/s/${world.mira.id}/inbox`);
    const trigger = page.getByRole("button", {
      name: `Space ${world.mira.name}. Its backups need attention. Switch space`,
    });
    await expect(trigger.locator('[data-part="backup-attention"]')).toBeVisible();
    await picture(page, "switcher-backup-mark.png");
    await trigger.click();
    const note = spaces(page).locator('[data-part="backup-trouble"]');
    await expect(note).toHaveAttribute("data-why", "disk_full");
    await expect(note).toContainText(`${world.mira.name}: the daily backup failed`);
    await expect(note).toContainText(`${CLI_NAME} space backup`);
    await picture(page, "switcher-backup-note.png");

    // A backup works again while the page stays open: coming back to the tab clears the mark
    // without opening the switcher.
    await page.keyboard.press("Escape");
    await expect(note).toBeHidden();
    failing = false;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(
      page.getByRole("button", { name: `Space ${world.mira.name}. Switch space` }),
    ).toBeVisible();
    await expect(page.locator('[data-part="backup-attention"]')).toHaveCount(0);
  });
});

test.describe("[A5.3.3.e2e.installed] A newer installed version, and the restart into it", () => {
  test("the page names the installed version and the restart; after the restart it offers a reload and does not call the service down", async ({
    page,
    world,
  }) => {
    // The service's hello names an installed version newer than its own, as one whose install
    // put another version in place says it.
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
      const server = ws.connectToServer();
      sockets.push(ws);
      server.onMessage((message) => {
        const parsed = JSON.parse(String(message)) as Record<string, unknown>;
        ws.send(
          parsed["type"] === "hello" ? JSON.stringify({ ...parsed, installed: "99.0.0" }) : message,
        );
      });
    });
    await signIn(page, world, `/s/${world.mira.id}/task/${world.task.ref}`);
    const row = page.locator(`li[data-task="${world.task.ref}"]`);
    await expect(row).toBeVisible();
    const installed = page.locator('[data-part="installed"]');
    await expect(installed).toContainText(`${PRODUCT_NAME} 99.0.0 is installed.`);
    await expect(installed).toContainText(`${CLI_NAME} service restart`);
    await picture(page, "installed-newer.png");

    // The service restarts into another build: the page's feed closes, and the service refuses
    // the page's build when it asks to come back.
    await page.route("**/api/v1/ws-ticket", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "service_unavailable",
            message: `${PRODUCT_NAME} was updated. Reload the page.`,
            data: { reason: "build" },
          },
        }),
      }),
    );
    await sockets.at(-1)?.close({ code: 1001 });
    await expect(page.getByText(`${PRODUCT_NAME} was updated.`)).toBeVisible({ timeout: SLOW_MS });
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(page.getByText(`${PRODUCT_NAME}'s service is not running`)).toHaveCount(0);
    await expect(installed).toHaveCount(0);
    // The rows it had stay on screen until the person reloads.
    await expect(row).toBeVisible();
    await picture(page, "installed-restarted.png");
  });
});
