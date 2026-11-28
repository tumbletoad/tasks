// Open in T3 Code from the page (A4 3.4.1, A7 M2.10t), in Chromium and Firefox against the real
// service process: a T3 Code instance whose T3 is testkit's fake server in this worker, and an app
// link opener that records each link instead of opening it (world.ts `links`), so no real T3 Code
// is reached. The common click from the start: T3 not running offers Start, not paired offers Pair
// (approved on the fake's page), a read-only pairing fails the launch at once with Pair again,
// then Open makes one thread with the brief in its composer, at a project root and in a folder
// inside it, and the thread's entry brings it up again. That thread is the task's: Open again
// brings it forward, its entry and the Agents page say what its agent does as T3 tells, and a
// thread deleted in T3 is made again at the next Open, its entry ended. Fixture data.
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { openTask, picture, signIn } from "./page.ts";
import { SLOW_MS, T3_INSTANCE, type World } from "./world.ts";

/** A folder as the space stores it, as a path here: `~` is this account's home. */
const here = (folder: string): string =>
  folder.startsWith("~") ? join(homedir(), folder.slice(2)) : folder;

/** A new task of Mira's in the Inbox whose own folder is `folder`. */
async function newTask(world: World, title: string, folder: string): Promise<string> {
  const added = (await world.op(world.mira.id, "task.add", {
    tasks: [{ title: `${title} (${test.info().project.name})`, inbox: true }],
  })) as { tasks: readonly { ref: string }[] };
  const ref = added.tasks[0]?.ref ?? "";
  await world.op(world.mira.id, "folder.manage", { action: "set", task: ref, folder });
  return ref;
}

function parts(page: Page, ref: string) {
  const row = page.locator(`main li[data-task="${ref}"]`);
  return {
    composer: row.locator('[data-part="composer"]'),
    /** Open in T3 Code from the menu beside Open, which holds every agent, the button's too. */
    open: async () => {
      await row
        .getByRole("toolbar", { name: "Act on this task" })
        .getByRole("button", { name: "Open with another agent" })
        .click();
      await page
        .getByRole("menu", { name: "Open with another agent" })
        .getByRole("menuitemradio", { name: `Open in ${T3_INSTANCE.label}` })
        .click();
    },
    opened: row.locator('[data-entry="session"]:not([data-state="failed"])'),
    button: row.locator('[data-part="strip"] [data-part="open"]'),
    menu: async () => {
      await row
        .getByRole("toolbar", { name: "Act on this task" })
        .getByRole("button", { name: "Open with another agent" })
        .click();
      return page
        .getByRole("menu", { name: "Open with another agent" })
        .getByRole("menuitemradio", { name: `Open in ${T3_INSTANCE.label}` });
    },
  };
}

/** The page at both widths the pull request shows, `shown` scrolled to the middle; then wide again. */
async function pictures(page: Page, name: string, shown?: Locator): Promise<void> {
  for (const [width, height] of [
    [1440, 1000],
    [390, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await shown?.evaluate((element) => {
      element.scrollIntoView({ block: "center" });
    });
    await picture(page, `${name}-${String(width)}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

const lastLink = (world: World): URL => new URL(world.links().at(-1) ?? "about:blank");

test.describe("[A4.3.4.1.t3.e2e] Open in T3 Code from the page", () => {
  test("Start, then Pair, then Open: one thread with the brief in its composer, at a project root and in a folder inside it", async ({
    page,
    t3,
  }) => {
    const { world, fake } = t3;
    const ref = await newTask(world, "Plan the handoff", world.portal);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openTask(page, world, ref);
    const p = parts(page, ref);

    // T3 Code is not running: Start comes first, and starts it through its link.
    await fake.stop();
    await p.open();
    const stopped = page.getByRole("status").filter({ hasText: "T3 Code is not running." });
    await expect(stopped).toBeVisible({ timeout: SLOW_MS });
    await pictures(page, "t3-not-running");
    // The refused pick is not Open's agent; its menu item says why, and picking it again offers
    // Start again.
    await expect(p.button).not.toHaveAttribute("data-instance", T3_INSTANCE.key);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
      const item = await p.menu();
      await expect(item).toContainText("T3 Code is not running");
      await picture(page, `t3-not-running-menu-${String(width)}.png`);
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stopped.getByRole("button", { name: "Start T3 Code" }).click();
    await expect(page.getByRole("status").filter({ hasText: "T3 Code is starting." })).toBeVisible({
      timeout: SLOW_MS,
    });
    expect(world.links().at(-1)).toBe("t3code://");
    await fake.restart();

    // Not paired: Pair opens T3 Code's approval page, where the person approves, here choosing
    // read only.
    await p.open();
    const unpaired = page.getByRole("status").filter({ hasText: "Pair TTasks with T3 Code" });
    await expect(unpaired).toBeVisible({ timeout: SLOW_MS });
    await pictures(page, "t3-not-paired");
    const pair = async (toast: Locator) => {
      const links = world.links().length;
      await toast.getByRole("button", { name: "Pair" }).click();
      await expect.poll(() => world.links().length, { timeout: SLOW_MS }).toBe(links + 1);
      expect(await fake.approveInBrowser(lastLink(world).href)).toBe(200);
    };
    fake.access = "read-only";
    await pair(unpaired);

    // A read-only pairing: one press, no thread, the reason and Pair again.
    const portal = fake.addProject(here(world.portal), "portal");
    await p.open();
    const narrow = page
      .getByRole("status")
      .filter({ hasText: "The pairing with T3 Code does not allow this" });
    await expect(narrow).toBeVisible({ timeout: SLOW_MS });
    await pictures(page, "t3-pairing-denied");
    expect(fake.callsOf("t3_thread_launch")).toHaveLength(1);
    expect(fake.threads.size).toBe(0);
    fake.access = "full-access";
    await pair(narrow);

    // Open at the project's root, with words of the person's: one thread, the brief in its
    // composer, and the words only in the launch's request.
    await p.composer.fill("Fixture words: read the handoff notes first.");
    await p.open();
    await expect(p.opened).toHaveCount(1, { timeout: SLOW_MS });
    await expect(p.opened).toContainText(`Opened in ${T3_INSTANCE.label}`);
    const thread = [...fake.threads.values()].find((t) => t.title.startsWith(`${ref} `));
    expect(thread).toMatchObject({ projectId: portal, message: false });
    const link = lastLink(world);
    expect(`${link.protocol}//${link.host}${decodeURIComponent(link.pathname)}`).toBe(
      `t3code://threads/${fake.environmentId}/${thread?.id ?? ""}`,
    );
    expect(link.searchParams.get("prompt")).toContain(ref);
    expect(link.searchParams.get("prompt")).not.toContain("Fixture words");
    await pictures(page, "t3-opened", p.opened);

    // Open in T3 on its entry brings the same thread up, without the brief this time.
    await p.opened.getByRole("button", { name: "Open in T3" }).click();
    await expect.poll(() => lastLink(world).search, { timeout: SLOW_MS }).toBe("");
    expect(fake.threads.size).toBe(1);

    // Open again: the task's thread comes forward, and no second one is made.
    const links = world.links().length;
    await p.open();
    await expect.poll(() => world.links().length, { timeout: SLOW_MS }).toBe(links + 1);
    expect(decodeURIComponent(lastLink(world).pathname)).toContain(thread?.id ?? "");
    expect(lastLink(world).search).toBe("");
    expect(fake.threads.size).toBe(1);
    await expect(p.opened).toHaveCount(1);
    await expect(p.opened).toContainText("· idle");

    // Its agent asks the person in T3: the entry and the Agents page say so.
    const made = fake.threads.get(thread?.id ?? "");
    if (made === undefined) throw new Error("no thread");
    made.status = "running";
    made.pendingRequestCount = 1;
    await openTask(page, world, ref);
    await expect(p.opened).toContainText("· needs you", { timeout: SLOW_MS });
    await pictures(page, "t3-thread-needs-you", p.opened);
    await signIn(page, world, `/s/${world.mira.id}/agents`);
    const agent = page
      .locator(`main li[data-task="${ref}"]`)
      .locator('[data-part="agent"]', { hasText: "T3 Code thread" });
    await expect(agent).toContainText("Needs you", { timeout: SLOW_MS });
    await pictures(page, "t3-thread-agents", agent);

    // The person deleted the thread in T3: the next Open notices and makes a new one.
    fake.threads.delete(made.id);
    await openTask(page, world, ref);
    await p.open();
    await expect(p.opened).toHaveCount(2, { timeout: SLOW_MS });
    const remade = [...fake.threads.values()].filter((t) => t.title.startsWith(`${ref} `));
    expect(remade.map((t) => t.id)).not.toContain(made.id);
    expect(remade).toHaveLength(1);
    // The deleted thread's entry says it ended and offers no way back to it.
    const ended = p.opened.and(page.locator('[data-state="ended"]'));
    await expect(ended).toHaveCount(1, { timeout: SLOW_MS });
    await expect(ended).toContainText("· ended");
    await expect(ended.getByRole("button", { name: "Open in T3" })).toHaveCount(0);

    // A folder inside the project becomes a project of its own: the thread runs exactly there.
    const inside = await newTask(
      world,
      "Check the appointments",
      join(here(world.portal), "appointments"),
    );
    await openTask(page, world, inside);
    const q = parts(page, inside);
    await q.open();
    await expect(q.opened).toHaveCount(1, { timeout: SLOW_MS });
    const own = [...fake.projects.values()].find((project) =>
      here(project.workspaceRoot).endsWith("appointments"),
    );
    const nested = [...fake.threads.values()].find((t) => t.title.startsWith(`${inside} `));
    expect(nested?.projectId).toBe(own?.id);
  });
});
