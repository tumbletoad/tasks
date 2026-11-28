// Settings > Phones end to end, in Chromium and Firefox, against the real service process: the
// dialog shows a code as a QR code with its warning, a phone (Node's TLS, as the app will use the
// platform's) pairs with that very code and the dialog says so, the list shows the phone, Run is
// switched on and off, and Remove asks first. The service's link listens on loopback here
// (serve-entry.ts).
import { expect, type Page } from "@playwright/test";
import { openLink, phoneKey, readPairing } from "../../packages/service/test/phone-client.ts";
import { test } from "./fixture.ts";
import { axeFound, picture, pictures, showsSpace, signIn, themes } from "./page.ts";
import { SLOW_MS, type World } from "./world.ts";

async function open(page: Page, world: World): Promise<void> {
  await signIn(page, world, `/s/${world.mira.id}/settings`);
  await showsSpace(page, world.mira.name);
}

const phones = (page: Page) => page.getByRole("region", { name: "Phones" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Pair a phone" });

/** Opens Pair a phone, and pairs a phone with the code the dialog shows. */
async function pairThroughDialog(page: Page, name: string): Promise<void> {
  const made = page.waitForResponse((r) => r.url().endsWith("/api/v1/machine/phone_pair"));
  await phones(page).getByRole("button", { name: "Pair a phone" }).click();
  const code = ((await (await made).json()) as { result: { code: string } }).result.code;
  await expect(
    dialog(page).getByRole("img", { name: "The pairing code as a QR code" }),
  ).toBeVisible();
  await expect(dialog(page)).toContainText("Anyone who sees this code and is on your network");
  const pairing = readPairing(code);
  const opened = await openLink(pairing.addrs[0] ?? "", pairing.pin, phoneKey(), {
    space: pairing.space.id,
    pair: { code: pairing.code, name, platform: "android" },
  });
  expect(opened.kind).toBe("served");
  if (opened.kind === "served") opened.link.ws.close();
  await expect(dialog(page)).toContainText(`Paired with ${name}`, { timeout: SLOW_MS });
}

test.describe("[S5.phones.e2e] Settings > Phones pairs a phone with its QR code, switches Run and removes it", () => {
  test("pair through the dialog, list, Run on and off, Remove after a confirmation", async ({
    page,
    world,
  }) => {
    await open(page, world);
    await pairThroughDialog(page, "Fixture phone");
    await dialog(page).getByRole("button", { name: "Done" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(phones(page)).toContainText("Fixture phone");
    await expect(phones(page)).toContainText(world.mira.name);
    const run = phones(page).getByRole("switch", { name: "Run from Fixture phone" });
    await expect(run).not.toBeChecked();
    await run.click({ force: true });
    await expect(run).toBeChecked();
    await page.reload();
    await showsSpace(page, world.mira.name);
    await expect(
      phones(page).getByRole("switch", { name: "Run from Fixture phone" }),
    ).toBeChecked();
    await phones(page)
      .getByRole("switch", { name: "Run from Fixture phone" })
      .click({ force: true });
    await expect(
      phones(page).getByRole("switch", { name: "Run from Fixture phone" }),
    ).not.toBeChecked();
    await phones(page).getByRole("button", { name: "Remove Fixture phone" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Remove Fixture phone?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(phones(page)).not.toContainText("Fixture phone");
  });

  test("Settings > Phones, the dialog and the confirmation in Sumi and Washi at 1,440 and 390 px, axe clean", async ({
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
          await open(page, world);
          await pairThroughDialog(page, `Screens phone ${name}`);
          await dialog(page).getByRole("button", { name: "Done" }).click();
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            const scroll = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(scroll, `sideways scroll at ${String(width)} px`).toBe(0);
            await phones(page).scrollIntoViewIfNeeded();
            await picture(phones(page), `phones-${name}-${String(width)}.png`);
            // A Run off the computer holds but could not save, as the service reports it: the
            // switch's save is refused, and the list says what the service holds.
            const run = phones(page).getByRole("switch", {
              name: `Run from Screens phone ${name}`,
            });
            await run.click({ force: true });
            await expect(run).toBeChecked();
            await page.route("**/api/v1/machine/phone_rights", (route) =>
              route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                  error: {
                    code: "service_unavailable",
                    message: "Run is off for this phone now. It was not saved.",
                    data: { reason: "not_saved", retryable: true },
                  },
                }),
              }),
            );
            await page.route("**/api/v1/machine/phones", async (route) => {
              const real = await route.fetch();
              const body = (await real.json()) as { result: { phones: Record<string, unknown>[] } };
              for (const phone of body.result.phones)
                Object.assign(phone, { run: false, unsaved: "run_off" });
              await route.fulfill({ response: real, json: body });
            });
            await run.click({ force: true });
            await expect(phones(page)).toContainText(
              "Run is off for this phone now. This was not saved",
            );
            await expect(run).not.toBeChecked();
            await picture(phones(page), `phones-unsaved-${name}-${String(width)}.png`);
            await page.unroute("**/api/v1/machine/phone_rights");
            await page.unroute("**/api/v1/machine/phones");
            await phones(page).getByRole("button", { name: "Switch Run off again" }).click();
            await expect(phones(page)).not.toContainText("was not saved");
            await expect(run).not.toBeChecked();
            if (pictures()) expect(await axeFound(page, ["main"]), "axe on Settings").toEqual([]);
            const made = page.waitForResponse((r) =>
              r.url().endsWith("/api/v1/machine/phone_pair"),
            );
            await phones(page).getByRole("button", { name: "Pair a phone" }).click();
            await made;
            await expect(dialog(page).getByRole("img")).toBeVisible();
            await picture(page, `phones-pair-${name}-${String(width)}.png`);
            if (pictures())
              expect(await axeFound(page, ['[role="dialog"]']), "axe on the dialog").toEqual([]);
            await dialog(page).getByRole("button", { name: "Close" }).click();
            await expect(dialog(page)).toHaveCount(0);
            await phones(page)
              .getByRole("button", { name: `Remove Screens phone ${name}` })
              .click();
            const confirm = page.getByRole("alertdialog");
            await expect(confirm).toBeVisible();
            await picture(page, `phones-remove-${name}-${String(width)}.png`);
            await confirm.getByRole("button", { name: "Cancel" }).click();
            await expect(confirm).toHaveCount(0);
          }
          await phones(page)
            .getByRole("button", { name: `Remove Screens phone ${name}` })
            .click();
          await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
          await expect(phones(page)).not.toContainText(`Screens phone ${name}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await world.machine("ui.theme", null);
    }
  });
});
