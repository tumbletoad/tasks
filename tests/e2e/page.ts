// What the e2e tests do and read on the page: the sign-in, the space a tab shows, a task's card,
// and CSP violations. Tests only.
import { expect, type Locator, type Page, type Request, type Response } from "@playwright/test";
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

/** Waits until the tab shows `name`'s space, live. */
export async function showsSpace(page: Page, name: string): Promise<void> {
  await expect(spaceSwitcher(page, name)).toBeVisible();
}

/**
 * Opens a task's card through its link, signed in, and waits for its thread: the thread arrives
 * after the card and pushes the composer and the strip down, so a click before it can land where
 * a button no longer is. Runs come on a read of their own: a test that expects some waits for
 * them as well. Returns the task's row.
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
