// The skeleton page end to end (A7 3.9 M2.13), in Chromium and Firefox, against the real service
// process with fixture data and the fake terminal behind the launch tile.
//
// Verify line: Open sends the shim to the fake terminal, the session runs, a log entry appears.
// Two tabs on two spaces stay on their own space.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import {
  CLI_NAME,
  FOLDER_MARKER,
  PRODUCT_ID,
  PRODUCT_NAME,
} from "../../packages/brand/src/index.ts";
import { FAKE_INSTANCE } from "./fake-terminal.ts";
import { test } from "./fixture.ts";
import { showsSpace, signIn, violations, watchViolations } from "./page.ts";
import { SLOW_MS } from "./world.ts";

const TOKEN_KEY = `${PRODUCT_ID}.token`;

test.describe("[A7.3.9.m2-13.e2e.open] Open from the skeleton page", () => {
  test("Open sends the shim to the fake terminal, the session runs, a log entry appears @one-browser", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    const before = world.terminal().length;
    await signIn(page, world, `/s/${world.mira.id}`);
    await showsSpace(page, world.mira.name);
    await expect(page).toHaveURL(`${world.origin}/s/${world.mira.id}/today`);
    // The task's area lists it (Today lists only what it selects, A5 3.4).
    await page.goto(`${world.origin}/s/${world.mira.id}/area/${world.task.area}`);
    await showsSpace(page, world.mira.name);

    const row = page.locator(`li[data-task="${world.task.ref}"]`);
    await expect(row.locator('[data-part="title"]')).toHaveText(world.task.title);
    // The row's one tile is the effective instance's (A5 3.6).
    const tile = row.locator('[data-part="tile"]');
    await expect(tile).toHaveAccessibleName(`Open in ${FAKE_INSTANCE.label}`);
    // Expanding the row shows its thread and a button per instance; Open on the fake agent's,
    // which runs until the test lets it end.
    world.hold(world.task.ref);
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
    await row
      .getByRole("toolbar")
      .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
      .click();

    // The fake terminal got exactly the shim's command line, and nothing of the task.
    await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
    const call = world.terminal().at(-1);
    expect(call?.argv.slice(0, 2)).toEqual([CLI_NAME, "shim"]);
    expect(call?.argv).toHaveLength(3);
    // A4 3.1's ticket: 24 symbols of A1's alphabet in upper case.
    expect(call?.argv[2]).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
    expect(JSON.stringify(call)).not.toContain(world.task.title);

    // The session runs, live in the expanded row, and the tile shows it.
    const running = row.locator('[data-entry][data-state="running"]');
    await expect(running).toBeVisible({ timeout: SLOW_MS });
    await expect(running).toContainText(`Opened in ${FAKE_INSTANCE.label} · running`);
    await expect(tile).toHaveAttribute("data-state", "running");

    // The agent logs on the task, as an agent does: the entry appears without a reload.
    const text = `Reproduced the time zone shift in ${test.info().project.name}.`;
    await world.agentLog(world.mira.id, world.task.id, text);
    await expect(row.locator('[data-part="entry-text"]', { hasText: text })).toBeVisible({
      timeout: SLOW_MS,
    });

    expect(await violations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("open-confirmed.png") });
    world.release(world.task.ref);
    await expect(row.locator('[data-entry][data-state="ended"]')).toBeVisible({ timeout: SLOW_MS });
  });
});

test.describe("[A4.5.e2e.open-folder] Open uses the task's folder, and says why when it is gone", () => {
  test("the expanded task shows its folder, and Open on a folder that went starts nothing and names it @one-browser", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    const temp = mkdtempSync(join(tmpdir(), "ttasks-e2e-folder-"));
    try {
      const folder = join(temp, "portal");
      mkdirSync(folder);
      const project = test.info().project.name;
      const added = (await world.op(world.mira.id, "task.add", {
        tasks: [
          { title: `Ship the portal release (${project})`, inbox: true },
          { title: `Read the release notes (${project})`, inbox: true },
        ],
      })) as { tasks: readonly { ref: string }[] };
      const ref = added.tasks[0]?.ref ?? "";
      const plain = added.tasks[1]?.ref ?? "";
      const base = ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string })
        .as_of;
      const set = (await world.op(world.mira.id, "folder.manage", {
        action: "set",
        task: ref,
        folder,
        base,
      })) as { folder: string };

      await signIn(page, world, `/s/${world.mira.id}/inbox`);
      await showsSpace(page, world.mira.name);
      // A task with no folder, in no project: it opens in the space's work folder.
      const other = page.locator(`li[data-task="${plain}"]`);
      await other.locator('[data-part="title"]').click();
      await expect(other.locator('[data-part="place"]')).toHaveAttribute(
        "data-state",
        "work_folder",
        { timeout: SLOW_MS },
      );
      await expect(other.locator('[data-part="place"]')).toContainText("TTasks work folder");
      const row = page.locator(`li[data-task="${ref}"]`);
      await row.locator('[data-part="title"]').click();
      await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
      const line = row.locator('[data-part="place"]');
      await expect(line).toHaveAttribute("data-state", "here", { timeout: SLOW_MS });
      await expect(line).toContainText(set.folder);
      await page.screenshot({ path: test.info().outputPath("open-folder-here.png") });

      // The folder goes before the click: nothing reaches the terminal, and the page says why.
      rmSync(folder, { recursive: true });
      const before = world.terminal().length;
      await row
        .getByRole("toolbar")
        .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` })
        .click();
      const said = page.getByRole("status").filter({
        hasText: `The folder ${set.folder} was not found on this machine. Nothing was started.`,
      });
      await expect(said).toBeVisible({ timeout: SLOW_MS });
      // The expanded task's folder line says the same at once, not "here" until a reload.
      await expect(line).toHaveAttribute("data-state", "missing");
      await expect(line).toContainText(`${set.folder} · not found on this machine`);
      expect(world.terminal()).toHaveLength(before);
      await expect(row.locator('[data-part="tile"]')).toHaveAttribute("data-state", "ready");
      expect(await violations(page)).toEqual([]);
      await page.screenshot({ path: test.info().outputPath("open-folder-gone.png") });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

test.describe("[A5.3.7.e2e.show-folder] the folder button opens the task's folder in the file manager", () => {
  test("the row's folder button and the expanded folder line show the task's folder; a folder that went is said and nothing opens @one-browser", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    const temp = mkdtempSync(join(tmpdir(), "ttasks-e2e-show-"));
    try {
      const folder = join(temp, "portal");
      mkdirSync(folder);
      const project = test.info().project.name;
      const added = (await world.op(world.mira.id, "task.add", {
        tasks: [{ title: `Check the portal build (${project})`, inbox: true }],
      })) as { tasks: readonly { ref: string }[] };
      const ref = added.tasks[0]?.ref ?? "";
      const base = ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string })
        .as_of;
      await world.op(world.mira.id, "folder.manage", { action: "set", task: ref, folder, base });

      await signIn(page, world, `/s/${world.mira.id}/inbox`);
      await showsSpace(page, world.mira.name);
      const row = page.locator(`li[data-task="${ref}"]`);
      const button = row.locator('[data-part="folder"]');
      await expect(button).toHaveAccessibleName("Open folder", { timeout: SLOW_MS });
      const before = world.folders().length;
      await button.click();
      await expect(
        page.getByRole("status").filter({ hasText: "Opened in the file manager on e2e-desktop" }),
      ).toBeVisible({ timeout: SLOW_MS });
      // The service resolved the task's own folder: the page sent no path.
      expect(world.folders().slice(before)).toEqual([realpathSync.native(folder)]);

      // Expanded, the folder line has the same action beside its copy button.
      await row.locator('[data-part="title"]').click();
      const line = row.locator('[data-part="place"]');
      await expect(line).toHaveAttribute("data-state", "here", { timeout: SLOW_MS });
      await line.getByRole("button", { name: "Open in the file manager" }).click();
      await expect.poll(() => world.folders().length, { timeout: SLOW_MS }).toBe(before + 2);
      expect(await violations(page)).toEqual([]);

      // The folder goes: the click says so, and nothing is asked of the file manager.
      rmSync(folder, { recursive: true });
      await line.getByRole("button", { name: "Open in the file manager" }).click();
      await expect(
        page.getByRole("status").filter({
          hasText: "Folder not found on this computer. Nothing was opened.",
        }),
      ).toBeVisible({ timeout: SLOW_MS });
      expect(world.folders()).toHaveLength(before + 2);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

test.describe("[A4.5.e2e.open-marker] Open asks before it opens a folder that may be another one", () => {
  test("the folder's line names its repository; a checkout replaced at its path starts nothing until the person uses it @one-browser", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    const temp = mkdtempSync(join(tmpdir(), "ttasks-e2e-marker-"));
    try {
      const folder = join(temp, "portal");
      mkdirSync(join(folder, ".git"), { recursive: true });
      writeFileSync(
        join(folder, ".git", "config"),
        '[remote "origin"]\n\turl = https://git.example.com/mira/portal-web.git\n',
      );
      const project = test.info().project.name;
      const added = (await world.op(world.mira.id, "task.add", {
        tasks: [{ title: `Tag the portal release (${project})`, inbox: true }],
      })) as { tasks: readonly { ref: string }[] };
      const ref = added.tasks[0]?.ref ?? "";
      const base = ((await world.op(world.mira.id, "task.get", { task: ref })) as { as_of: string })
        .as_of;
      const set = (await world.op(world.mira.id, "folder.manage", {
        action: "set",
        task: ref,
        folder,
        base,
      })) as { folder: string };

      await signIn(page, world, `/s/${world.mira.id}/inbox`);
      await showsSpace(page, world.mira.name);
      const row = page.locator(`li[data-task="${ref}"]`);
      await row.locator('[data-part="title"]').click();
      const line = row.locator('[data-part="place"]');
      await expect(line).toHaveAttribute("data-state", "here", { timeout: SLOW_MS });
      await expect(line).toContainText(`${set.folder} [portal-web]`);
      await page.screenshot({ path: test.info().outputPath("open-marker-repo.png") });

      // The checkout is moved aside and an unrelated folder made at its path.
      renameSync(folder, join(temp, "portal-aside"));
      mkdirSync(folder);
      const before = world.terminal().length;
      const open = row
        .getByRole("toolbar")
        .getByRole("button", { name: `Open in ${FAKE_INSTANCE.label}` });
      const composer = row.locator('[data-part="composer"]');
      await composer.fill("Tag it after the tests pass");
      await open.click();
      const said = page.getByRole("status").filter({
        hasText: `The folder ${set.folder} has no TTasks marker, so it may not be the folder set for this task. Nothing was started.`,
      });
      await expect(said).toBeVisible({ timeout: SLOW_MS });
      expect(world.terminal()).toHaveLength(before);
      await page.screenshot({ path: test.info().outputPath("open-marker-missing.png") });

      // Nothing started, so the words wait in the field.
      await expect(composer).toHaveValue("Tag it after the tests pass");
      // The person uses this folder: it opens there with the words, is marked as the task's, and
      // the field clears once the agent has them, as after any Open.
      await said.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => world.terminal().length, { timeout: SLOW_MS }).toBe(before + 1);
      expect(existsSync(join(folder, FOLDER_MARKER, "owners.json"))).toBe(true);
      await expect(composer).toHaveValue("", { timeout: SLOW_MS });
      expect(await violations(page)).toEqual([]);
    } finally {
      // The fake agent works in the folder for a few seconds, and Windows keeps a folder in use.
      rmSync(temp, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
  });
});

test.describe("[A7.3.9.m2-10.e2e.copy] Copy puts the pointer brief on the clipboard", () => {
  test("Copy copies the pointer brief, records its launch, and the receipt says it was copied @one-browser", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    await signIn(page, world, `/s/${world.mira.id}/area/${world.spare.area}`);
    await showsSpace(page, world.mira.name);
    // What the page writes to the clipboard, kept in the page: no clipboard permission needed.
    await page.evaluate(() => {
      const copied: string[] = [];
      (window as unknown as { copied: string[] }).copied = copied;
      navigator.clipboard.writeText = (text: string) => {
        copied.push(text);
        return Promise.resolve();
      };
    });
    const row = page.locator(`li[data-task="${world.spare.ref}"]`);
    // Copy sits in the expanded task's strip (A5 3.7): expand the row, then copy.
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
    const copy = row
      .getByRole("toolbar")
      .getByRole("button", { name: `Copy ${world.spare.title}` });
    // What Shift-click does is said to assistive technology too, not only in the hover label.
    await expect(copy).toHaveAccessibleDescription(/Shift-click copies the context pack/u);
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { copied: string[] }).copied.length), {
        timeout: SLOW_MS,
      })
      .toBe(1);
    const brief = await page.evaluate(() => (window as unknown as { copied: string[] }).copied[0]);
    const lines = (brief ?? "").split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^${PRODUCT_NAME} task ${world.spare.ref} \\(launch L[0-9A-Z]{5}\\)\\.$`, "u"),
    );
    expect(lines[4]).toMatch(/^Folder: /u);
    expect(lines).toHaveLength(6);
    // Its launch shows in the expanded row as copied.
    await expect(row.locator('[data-entry][data-state="dispatched"]')).toContainText(
      "Brief copied",
      {
        timeout: SLOW_MS,
      },
    );
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("[A7.3.14.m6-11.e2e.pack] Shift+Copy puts the context pack on the clipboard", () => {
  test("Shift+Copy copies the context pack, the toast says so, and the tooltip says what leaves @one-browser", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    await signIn(page, world, `/s/${world.mira.id}/area/${world.spare.area}`);
    await showsSpace(page, world.mira.name);
    await page.evaluate(() => {
      const copied: string[] = [];
      (window as unknown as { copied: string[] }).copied = copied;
      navigator.clipboard.writeText = (text: string) => {
        copied.push(text);
        return Promise.resolve();
      };
    });
    const row = page.locator(`li[data-task="${world.spare.ref}"]`);
    await row.locator('[data-part="title"]').click();
    await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true");
    const copy = row
      .getByRole("toolbar")
      .getByRole("button", { name: `Copy ${world.spare.title}` });
    await expect(copy).toHaveAttribute("data-tip", /Shift-click copies the context pack/u);
    await copy.click({ modifiers: ["Shift"] });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { copied: string[] }).copied.length), {
        timeout: SLOW_MS,
      })
      .toBe(1);
    const pack = await page.evaluate(() => (window as unknown as { copied: string[] }).copied[0]);
    expect(pack ?? "").toMatch(
      new RegExp(
        `^${PRODUCT_NAME} context pack for task ${world.spare.ref} \\(launch L[0-9A-Z]{5}\\)`,
        "u",
      ),
    );
    expect(pack ?? "").toContain(`\`\`\`ttasks-update\ntask: ${world.spare.ref}\n`);
    expect((pack ?? "").length).toBeLessThanOrEqual(8_000);
    await expect(page.getByRole("status").filter({ hasText: "Context pack copied" })).toBeVisible({
      timeout: SLOW_MS,
    });
    expect(await violations(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("pack-copied.png") });
  });
});

test.describe("[A7.3.9.m2-13.e2e.two-tabs] Each tab keeps its own space", () => {
  test("Two tabs on two spaces stay on their own space", async ({ context, world }) => {
    const mira = await context.newPage();
    const studio = await context.newPage();
    // The Inbox, where the add field puts a task.
    await signIn(mira, world, `/s/${world.mira.id}/inbox`);
    await signIn(studio, world, `/s/${world.studio.id}/inbox`);
    await showsSpace(mira, world.mira.name);
    await showsSpace(studio, world.studio.name);
    await expect(studio.locator('[data-part="title"]')).toHaveText(["Sketch the spring poster"]);

    // A task added in one tab lands in that tab's space only.
    const project = test.info().project.name;
    const forStudio = `Frame the poster proofs (${project})`;
    const forMira = `Book the clinic visit (${project})`;
    await studio.getByRole("textbox", { name: "New task" }).fill(forStudio);
    await studio.getByRole("textbox", { name: "New task" }).press("Enter");
    await mira.getByRole("textbox", { name: "New task" }).fill(forMira);
    await mira.getByRole("textbox", { name: "New task" }).press("Enter");
    await expect(studio.locator('[data-part="title"]', { hasText: forStudio })).toBeVisible();
    await expect(mira.locator('[data-part="title"]', { hasText: forMira })).toBeVisible();
    await expect(studio.locator('[data-part="title"]', { hasText: forMira })).toHaveCount(0);
    await expect(mira.locator('[data-part="title"]', { hasText: forStudio })).toHaveCount(0);

    // A reload keeps each tab on its space, from its route and the stored token.
    await studio.reload();
    await mira.reload();
    await showsSpace(studio, world.studio.name);
    await showsSpace(mira, world.mira.name);
    await expect(studio).toHaveURL(`${world.origin}/s/${world.studio.id}/inbox`);
    await expect(studio.locator('[data-part="title"]', { hasText: forStudio })).toBeVisible();
    await expect(studio.locator('[data-part="title"]', { hasText: forMira })).toHaveCount(0);
  });
});

test.describe("[A2.3.8.4.e2e.page-secrets] The code and the token stay out of URLs", () => {
  test("no request carries the code or the token in its URL, and a hostile stored value signs out", async ({
    page,
    world,
  }) => {
    const urls: string[] = [];
    page.on("request", (request) => urls.push(request.url()));
    const signIn = await world.signInUrl(`/s/${world.mira.id}`);
    const code = new URLSearchParams(new URL(signIn).hash.slice(1)).get("k") ?? "";
    expect(code).not.toBe("");
    await page.goto(signIn);
    await showsSpace(page, world.mira.name);
    expect(page.url()).not.toContain("#");
    const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
    expect(token).toMatch(/^ttasks_u_[A-Za-z0-9_-]{43}$/);
    for (const url of urls) {
      expect(url).not.toContain(code);
      expect(url).not.toContain(token ?? "no token");
    }

    // A value another page wrote under the token's key is not a token: dropped, signed out.
    await page.evaluate((key) => {
      localStorage.setItem(key, '{"token":"ttasks_u_x"}<img src=x onerror=alert(1)>');
    }, TOKEN_KEY);
    await page.reload();
    await expect(page.getByText(`Run ${CLI_NAME} open to sign in this browser.`)).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  });
});

test.describe("[A2.3.8.3.e2e.strict-csp] The built page under the strict CSP", () => {
  test("every script and stylesheet has an integrity hash, nothing is blocked, no service worker", async ({
    page,
    world,
  }) => {
    await watchViolations(page);
    const response = await signIn(page, world, `/s/${world.mira.id}`);
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    await showsSpace(page, world.mira.name);
    const tags = await page.evaluate(() => {
      const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content");
      return [...document.querySelectorAll("script, link[rel=stylesheet], style")].map((el) => ({
        tag: el.tagName,
        src: el.getAttribute("src") ?? el.getAttribute("href"),
        integrity: el.getAttribute("integrity"),
        // A runtime style element (React Aria's, M5.01) carries the response's nonce instead.
        nonced: el instanceof HTMLStyleElement && nonce !== null && el.nonce === nonce,
      }));
    });
    const files = tags.filter((tag) => tag.tag !== "STYLE");
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const tag of files) {
      expect(tag.src, tag.tag).toMatch(/^\/assets\//);
      expect(tag.integrity, `${tag.tag} ${String(tag.src)}`).toMatch(/^sha384-/);
    }
    for (const tag of tags.filter((t) => t.tag === "STYLE")) expect(tag.nonced).toBe(true);
    const workers = await page.evaluate(async () =>
      "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    );
    expect(workers).toBe(0);
    expect(await violations(page)).toEqual([]);
  });
});
