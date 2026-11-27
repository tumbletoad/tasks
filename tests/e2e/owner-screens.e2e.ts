// A space the size of one in real use (five areas, thirty-two projects, about a hundred open
// tasks), end to end in Chromium and Firefox against the real service: the side menu, Today, a
// status view, an area, a project and an expanded task at 1,280, 1,440, 1,920 and 390 px in both
// themes, nothing scrolling sideways; and the expanded task's facts with two, four and six
// statuses and effort keys, each in one calm block: every option whole and inside it, on one line
// while the names fit. Screenshots go to the results folder for review. Fixture data only.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixture.ts";
import { picture, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, startWorld, type World } from "./world.ts";

const WIDTHS = [1280, 1440, 1920, 390] as const;

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Views and areas" });

/** Opens a view: signed in once per browser context, then by its address alone. */
const signedIn = new WeakSet<object>();
async function open(page: Page, world: World, path: string): Promise<void> {
  const to = `/s/${world.mira.id}/${path}`;
  if (signedIn.has(page.context())) await page.goto(`${world.origin}${to}`);
  else {
    await signIn(page, world, to);
    signedIn.add(page.context());
  }
  // Narrow, the space's name is in the drawer: the page is there once its Menu is.
  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
  } else await showsSpace(page, world.mira.name);
}

/** How far the page scrolls sideways: none is wanted. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The options of a control whose name is cut, or that reach outside the facts' block. */
const astray = async (control: Locator, block: Locator) =>
  control.getByRole("radio").evaluateAll(
    (cells, dl) => {
      const box = dl?.getBoundingClientRect();
      return cells
        .filter((c) => {
          const at = c.getBoundingClientRect();
          const outside = box === undefined || at.left < box.left - 1 || at.right > box.right + 1;
          return (
            outside || c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1
          );
        })
        .map((c) => c.textContent);
    },
    await block.elementHandle(),
  );

/** The distinct top edges of a control's options: one per row. */
const rows = async (control: Locator) =>
  new Set(
    await control
      .getByRole("radio")
      .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().top))),
  ).size;

test.describe("[A5.3.3.e2e.owner-screens] a space the size of one in use, at every width and in both themes", () => {
  test("the menu, Today, Open, an area, a project and an expanded task at 1,280, 1,440, 1,920 and 390 px, nothing scrolling sideways", async ({
    browser,
    large,
  }) => {
    test.setTimeout(600_000);
    const areas = (await large.op(large.mira.id, "group.manage", { action: "list" })) as {
      areas: { id: string; name: string; projects: { id: string; name: string }[] }[];
    };
    const client = areas.areas.find((a) => a.name === "Client work");
    const project = client?.projects[0];
    if (client === undefined || project === undefined)
      throw new Error("the large space has no areas");
    const project_path = `area/${client.id}/project/${project.id}`;
    for (const theme of themes()) {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      try {
        const page = await context.newPage();
        await large.machine("ui.theme", theme);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
          for (const [name, path] of [
            ["today", "today"],
            ["open", "open"],
            ["area", `area/${client.id}`],
            ["project", project_path],
          ] as const) {
            await open(page, large, path);
            await expect(page.locator("main li[data-key]").first()).toBeVisible({
              timeout: SLOW_MS,
            });
            expect(await sideways(page), `${name} at ${String(width)} px`).toBeLessThanOrEqual(0);
            await picture(page, `owner-${name}-${theme}-${String(width)}.png`, {
              fullPage: name !== "open",
            });
          }
          // The first task of Open, expanded: its facts and its composer.
          await open(page, large, "open");
          const first = page.locator("main li[data-key]").first();
          await first.locator('[data-part="title"]').click();
          await expect(first.locator("dl")).toBeVisible({ timeout: SLOW_MS });
          expect(await sideways(page), `expanded at ${String(width)} px`).toBeLessThanOrEqual(0);
          await picture(first, `owner-expanded-${theme}-${String(width)}.png`);
          // Narrow, the menu is a drawer with the same entries.
          if (width === 390) {
            await page.getByRole("button", { name: "Menu" }).click();
            const drawer = page.getByRole("dialog", { name: "Views and areas" });
            await expect(drawer.getByRole("button", { name: "Fold Client work" })).toBeVisible();
            await picture(page, `owner-drawer-${theme}-390.png`);
            await page.keyboard.press("Escape");
          } else {
            await expect(
              sidebar(page).getByRole("button", { name: "Fold Client work" }),
            ).toBeVisible();
          }
        }
      } finally {
        await context.close();
      }
    }
    await large.machine("ui.theme", null);
  });

  test("the facts hold their block with two, four and six statuses and effort keys, and long names whole", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const ui = process.env["E2E_UI_BUILD"];
    if (ui === undefined) throw new Error("global-setup.ts did not build the page");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const scales = [
      { statuses: ["open", "backlog"], efforts: ["S", "L"] },
      { statuses: ["open", "waiting", "review", "backlog"], efforts: ["S", "M", "L", "XL"] },
      {
        statuses: ["open", "waiting", "review", "backlog", "blocked", "someday"],
        efforts: ["XS", "S", "M", "L", "XL", "XXL"],
      },
      // Long names that start alike: each is read whole.
      {
        statuses: ["open", "waiting-for-client", "waiting-for-review", "backlog"],
        efforts: ["S", "M", "L"],
      },
    ];
    /** Whether each scale's statuses fit on one line of the 304 px facts column. */
    const oneLine = [true, true, false, false];
    // No tool sets a space's statuses yet: one service, with a space of its own per scale, each
    // set before the service opens it.
    const world = await startWorld(ui, { scales });
    try {
      for (const [at, scale] of scales.entries()) {
        const name = `statuses ${scale.statuses.join(", ")}; effort ${scale.efforts.join(", ")}`;
        await test.step(name, async () => {
          const space = world.scaled[at];
          if (space === undefined) throw new Error("the world has no space for this scale");
          // A task of the test's own, with no effort: the sample's tasks may hold a key the scale
          // leaves out, which the facts then show as well.
          const added = (await world.op(space.id, "task.add", {
            tasks: [{ title: "Book the hall for the spring fair", inbox: true }],
          })) as { tasks: { ref: string }[] };
          const ref = added.tasks[0]?.ref;
          if (ref === undefined) throw new Error("the task was not added");
          const to = `/s/${space.id}/task/${ref}`;
          if (at === 0) await signIn(page, world, to);
          else await page.goto(`${world.origin}${to}`);
          await showsSpace(page, space.name);
          const row = page.locator(`main li[data-task="${ref}"]`);
          await expect(row.locator('[data-part="title"]')).toHaveAttribute(
            "aria-expanded",
            "true",
            {
              timeout: SLOW_MS,
            },
          );
          const facts = row.locator("dl");
          const statuses = facts.getByRole("radiogroup", { name: "Status" });
          const priority = facts.getByRole("radiogroup", { name: "Priority" });
          const effort = facts.getByRole("radiogroup", { name: "Effort" });
          await expect(statuses.getByRole("radio")).toHaveCount(scale.statuses.length, {
            timeout: SLOW_MS,
          });
          await expect(effort.getByRole("radio")).toHaveCount(scale.efforts.length);
          // Every option whole and inside the block; one line while the names fit, more only
          // when they do not. These effort keys and the priorities always fit.
          for (const control of [statuses, priority, effort]) {
            expect(await astray(control, facts)).toEqual([]);
          }
          expect((await rows(statuses)) === 1).toBe(oneLine[at]);
          expect(await rows(priority)).toBe(1);
          expect(await rows(effort)).toBe(1);
          await picture(facts, `owner-facts-${scale.statuses.join("-")}.png`);
        });
      }
    } finally {
      await world.close();
    }
  });
});
