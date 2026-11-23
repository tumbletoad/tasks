// What the e2e tests do and read on the page: the sign-in, the space a tab shows, a task's card,
// CSP violations, and the screens tests' pictures and axe scans. Tests only.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { SLOW_MS, type World } from "./world.ts";

/** What can make a sign-in link: every world. */
interface SignsIn {
  signInUrl(to: string): Promise<string>;
}

const isRedeem = (request: Request) => request.url().endsWith("/api/v1/auth/redeem");

/**
 * Opens `to` through a fresh sign-in link. A refused sign-in fails here, saying how: the answer's
 * status and reason, or the failure on the way, and how long after the code was made, so a
 * failure on CI names its cause. Returns the page's response.
 */
export async function signIn(page: Page, world: SignsIn, to: string): Promise<Response | null> {
  const made = Date.now();
  const url = await world.signInUrl(to);
  let stop: () => void = () => undefined;
  const refused = new Promise<string | undefined>((resolve) => {
    const answered = (response: Response) => {
      if (!isRedeem(response.request())) return;
      stop();
      if (response.status() === 200) {
        resolve(undefined);
        return;
      }
      const after = Date.now() - made;
      void response
        .json()
        .catch(() => undefined)
        .then((body: unknown) => {
          const error = (
            body as { error?: { code?: unknown; data?: { reason?: unknown } } } | undefined
          )?.error;
          const why = [error?.code, error?.data?.reason].filter((w) => typeof w === "string");
          resolve(`answered ${String(response.status())} ${why.join(" ")}, ${String(after)} ms`);
        });
    };
    const failed = (request: Request) => {
      if (!isRedeem(request)) return;
      stop();
      const after = Date.now() - made;
      resolve(`failed on the way (${request.failure()?.errorText ?? "?"}), ${String(after)} ms`);
    };
    page.on("response", answered);
    page.on("requestfailed", failed);
    stop = () => {
      page.off("response", answered);
      page.off("requestfailed", failed);
    };
  });
  const response = await page.goto(url);
  // A page that never asks (one already signed in) leaves it to the steps that follow.
  let cancel: () => void = () => undefined;
  const why = await Promise.race([
    refused,
    new Promise<undefined>((resolve) => {
      const handle = setTimeout(resolve, SLOW_MS);
      cancel = () => {
        clearTimeout(handle);
      };
    }),
  ]);
  cancel();
  stop();
  if (why !== undefined) throw new Error(`The sign-in was refused: ${why} after its code was made`);
  return response;
}

/** The space switcher of the sidebar that is on screen, which names the tab's space. */
export function spaceSwitcher(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Space ${name}. Switch space` });
}

/**
 * Waits until the tab shows `name`'s space, live, with every face of the page loaded: a face
 * arrives after the first text that needs it, and a box measured before it is another width once
 * it is in. Every face, not only those loading now: the mono face or another script's face is
 * first asked for when its text appears, later in the test.
 */
export async function showsSpace(page: Page, name: string): Promise<void> {
  await expect(spaceSwitcher(page, name)).toBeVisible();
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load()));
  });
}

/**
 * Opens a task's card through its link, signed in, and waits for its thread: its notes, sessions
 * and runs are drawn. Returns the task's row.
 */
export async function openTask(page: Page, world: World, ref: string): Promise<Locator> {
  await signIn(page, world, `/s/${world.mira.id}/task/${ref}`);
  await showsSpace(page, world.mira.name);
  const row = page.locator(`main li[data-task="${ref}"]`);
  await expect(row.locator('[data-part="title"]')).toHaveAttribute("aria-expanded", "true", {
    timeout: SLOW_MS,
  });
  await expect(
    row
      .getByRole("list", { name: "Notes, log, sessions and runs" })
      .or(row.getByText("Nothing logged yet.")),
  ).toBeVisible({ timeout: SLOW_MS });
  return row;
}

/** Records every CSP violation the page reports, from before its first script runs. */
export async function watchViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { violations: string[] }).violations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

export const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { violations?: string[] }).violations ?? []);

/**
 * Whether this browser takes the pictures, runs axe and repeats a screen in Washi: Chromium does.
 * A theme changes colours only and axe reads the same page in both engines, while text widths and
 * overlays are the engine's own, so Firefox runs every width and layout check, in Sumi.
 */
export const pictures = (): boolean => test.info().project.name === "chromium";

/** The themes a screens test goes through in this browser (see `pictures`). */
export const themes = (): readonly ("sumi" | "washi")[] =>
  pictures() ? ["sumi", "washi"] : ["sumi"];

/** The home folder as text on the page names it, with either slash. */
const HOME = new RegExp(
  homedir()
    .split(/[\\/]/)
    .filter((part) => part !== "")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]"),
  "i",
);

/**
 * Saves `name` in the test's results for review, in the browser that takes pictures. The pictures
 * go to a public pull request, so they hide this machine: what the page marks `data-machine` (its
 * folders, drives and files, and machine names), and any text naming the home folder.
 */
export async function picture(
  target: Page | Locator,
  name: string,
  options: { readonly fullPage?: boolean } = {},
): Promise<void> {
  if (!pictures()) return;
  const path = test.info().outputPath(name);
  const page = "goto" in target ? target : target.page();
  const mask = [page.locator("[data-machine]"), page.getByText(HOME)];
  if ("goto" in target) await target.screenshot({ path, mask, ...options });
  else await target.screenshot({ path, mask });
}

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/**
 * axe's violations, one line each, in the parts of the page `include` selects, or in the whole
 * document. axe runs a script of its own, so the page's context must bypass the CSP.
 */
export async function axeFound(
  page: Page,
  include?: readonly string[],
  rules: Readonly<Record<string, { readonly enabled: boolean }>> = {},
): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.evaluate(AXE);
  return page.evaluate(
    async ({ include, rules }) => {
      const run = (
        window as unknown as {
          axe: {
            run: (
              context: unknown,
              options: unknown,
            ) => Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }>;
          };
        }
      ).axe.run;
      const result = await run(include === undefined ? document : { include }, {
        resultTypes: ["violations"],
        rules,
      });
      return result.violations.map(
        (v) => `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`,
      );
    },
    { include, rules },
  );
}
