// @vitest-environment happy-dom
//
// Settings > Phones against a service the test answers: the list, the Run switch, Remove after a
// confirmation, and the pairing dialog, which shows the code with its warning and ends it on close.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { I18n } from "../i18n/intl.tsx";
import { Phones } from "./Phones.tsx";
import { qrPath, readCode, readPhones } from "./phones.ts";
import { AuthContext } from "./session.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const posted: { action: string; body: Record<string, unknown> }[] = [];
let phones: Record<string, unknown>[] = [];

const PHONE = {
  id: "gr_phone",
  name: "Fixture phone",
  platform: "android",
  space: "sp_1",
  space_name: "Mira",
  paired_at: "2026-11-01T10:00:00.000Z",
  last_used_at: null,
  run: false,
  removing: false,
};

/** The next answer to these actions fails as a save that did not reach the disk. */
const failNext = new Set<string>();
/** The next answer to Run waits for this. */
let holdRun: Promise<void> | undefined;

function answer(action: string, body: Record<string, unknown>, failed = false): unknown {
  if (action === "phones") {
    return typeof body["ticket"] === "string"
      ? { phones, pairing: { state: "waiting" } }
      : { phones };
  }
  if (action === "phone_pair") {
    return body["end"] === undefined
      ? { code: "TTASKS1:fixture-code", ticket: "fixture-ticket", expires_at: "", addresses: 1 }
      : { ended: true };
  }
  if (action === "phone_rights") {
    // As the service: Run on counts only once saved; Run off holds at once.
    const on = body["run"] === true;
    if (!failed || !on) phones = phones.map((p) => ({ ...p, run: on }));
    return { run: body["run"] };
  }
  phones = failed ? phones.map((p) => ({ ...p, removing: true })) : [];
  return { removed: true };
}

beforeEach(() => {
  posted.length = 0;
  phones = [PHONE];
  failNext.clear();
  holdRun = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const action = url.split("/").pop() ?? "";
      const body = JSON.parse(init.body) as Record<string, unknown>;
      posted.push({ action, body });
      if (action === "phone_rights") await holdRun;
      const failed = failNext.delete(action);
      const result = answer(action, body, failed);
      return failed
        ? new Response(
            JSON.stringify({
              error: {
                code: "service_unavailable",
                message: "Not saved",
                data: { reason: "not_saved" },
              },
            }),
            { status: 503 },
          )
        : new Response(JSON.stringify({ result }), { status: 200 });
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render() {
  act(() => {
    root.render(
      <I18n>
        <AuthContext.Provider value={{ token: "t", build: "b", signedOut: () => undefined }}>
          <Phones space="Mira" />
        </AuthContext.Provider>
      </I18n>,
    );
  });
  await settle();
}

const button = (name: string, within: ParentNode = document): HTMLElement => {
  const found = [...within.querySelectorAll<HTMLElement>("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};

const press = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};

describe("[S5.phones.web] Settings > Phones", () => {
  test("lists each phone with its space and last use, and turns Run on", async () => {
    await render();
    expect(container.textContent).toContain("Fixture phone");
    expect(container.textContent).toContain("Mira · not used yet");
    const run = container.querySelector<HTMLInputElement>(
      'input[aria-label="Run from Fixture phone"]',
    );
    expect(run?.checked).toBe(false);
    await press(run as unknown as HTMLElement);
    expect(posted).toContainEqual({
      action: "phone_rights",
      body: { phone: "gr_phone", run: true },
    });
  });

  test("Remove asks first, then removes", async () => {
    await render();
    await press(button("Remove Fixture phone"));
    expect(document.body.textContent).toContain("Remove Fixture phone?");
    expect(posted.some((p) => p.action === "phone_remove")).toBe(false);
    const dialog = document.querySelector('[role="alertdialog"]');
    if (dialog === null) throw new Error("no confirmation");
    await press(button("Remove", dialog));
    expect(posted).toContainEqual({ action: "phone_remove", body: { phone: "gr_phone" } });
  });

  test("Run on shows as on only once its save answered", async () => {
    await render();
    let release: () => void = () => undefined;
    holdRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Run from Fixture phone"]');
    await press(run() as unknown as HTMLElement);
    expect(run()?.checked).toBe(false);
    expect(run()?.disabled).toBe(true);
    release();
    await settle();
    expect(run()?.checked).toBe(true);
  });

  test("a Run switch or a Remove that was not saved shows as it is, with the way to save it again", async () => {
    await render();
    failNext.add("phone_rights");
    const run = () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Run from Fixture phone"]');
    await press(run() as unknown as HTMLElement);
    expect(run()?.checked).toBe(false);
    expect(container.textContent).toContain(
      "Run on was not saved, so Run stays off for this phone.",
    );
    await press(button("Switch Run on again"));
    expect(run()?.checked).toBe(true);
    expect(container.textContent).not.toContain("was not saved");
    failNext.add("phone_remove");
    await press(button("Remove Fixture phone"));
    const dialog = document.querySelector('[role="alertdialog"]');
    if (dialog === null) throw new Error("no confirmation");
    await press(button("Remove", dialog));
    expect(container.textContent).toContain("Removed: it has no access now. This was not saved");
    expect(run()).toBeNull();
    await press(button("Remove again"));
    expect(container.textContent).not.toContain("Fixture phone");
    expect(posted.filter((p) => p.action === "phone_remove")).toHaveLength(2);
  });

  test("the pairing dialog shows the code with its warning, and ends it when it closes", async () => {
    await render();
    await press(button("Pair a phone"));
    expect(posted).toContainEqual({ action: "phone_pair", body: { space: "Mira" } });
    expect(document.querySelector('svg[role="img"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Anyone who sees this code and is on your network");
    await press(button("Close"));
    expect(posted).toContainEqual({ action: "phone_pair", body: { end: "fixture-ticket" } });
  });

  test("answers are read by their shape, and the code draws as a square of modules", () => {
    expect(readPhones({ phones: [{ id: 3 }, PHONE], pairing: { state: "odd" } })).toEqual({
      phones: [expect.objectContaining({ id: "gr_phone", spaceName: "Mira", run: false })],
      pairing: { state: "ended" },
    });
    expect(readCode(null)).toEqual({ code: "", ticket: "", expiresAt: "", addresses: 0 });
    const qr = qrPath("TTASKS1:fixture");
    expect(qr.size).toBeGreaterThan(20);
    expect(qr.d).toMatch(/^M\d+ \d+h1v1h-1z/u);
  });
});
