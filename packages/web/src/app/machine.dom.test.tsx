// @vitest-environment happy-dom
//
// This machine's settings as the page holds them: a change shows at once, stays once the service
// kept it whether or not the feed has said so yet, and goes back when the service refuses it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Api } from "../api.ts";
import type { MachinePreference } from "../store/messages.ts";
import { useMachineControl, type MachineControl } from "./machine.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FEED: MachinePreference[] = [
  { key: "ui.theme", value: "sumi", state: "default" },
  { key: "ui.single_keys", value: true, state: "default" },
];

let container: HTMLElement;
let root: Root;
let control: MachineControl;

function Probe({ api }: { readonly api: Api }) {
  control = useMachineControl(api, undefined);
  return null;
}

/** An api whose writes the test answers by hand. */
function fakeApi() {
  const calls: {
    value: unknown;
    resolve: (read: MachinePreference) => void;
    reject: (e: Error) => void;
  }[] = [];
  const api = {
    setMachinePreference: (_key: string, value: unknown) =>
      new Promise<MachinePreference>((resolve, reject) => {
        calls.push({ value, resolve, reject });
      }),
  } as unknown as Api;
  return { api, calls };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("[A7.3.12.m5-11.machine-page] the page's copy of this machine's settings", () => {
  test("a kept change stays when the service's answer comes before the feed's message", async () => {
    const { api, calls } = fakeApi();
    act(() => {
      root.render(<Probe api={api} />);
    });
    act(() => {
      control.receive(FEED);
    });
    let done: Promise<void> | undefined;
    act(() => {
      done = control.setSingleKeys(false);
    });
    expect(control.singleKeys).toBe(false);
    await act(async () => {
      calls[0]?.resolve({ key: "ui.single_keys", value: false, state: "set" });
      await done;
    });
    // No feed message yet: the service's answer alone keeps the change on screen.
    expect(control.singleKeys).toBe(false);
    expect(control.theme).toBe("sumi");
  });

  test("a refused change goes back to what the service holds", async () => {
    const { api, calls } = fakeApi();
    act(() => {
      root.render(<Probe api={api} />);
    });
    act(() => {
      control.receive(FEED);
    });
    let done: Promise<void> | undefined;
    act(() => {
      done = control.setTheme("washi");
    });
    expect(control.theme).toBe("washi");
    expect(document.documentElement.dataset["theme"]).toBe("washi");
    await act(async () => {
      calls[0]?.reject(new Error("refused"));
      await done?.catch(() => undefined);
    });
    expect(control.theme).toBe("sumi");
    expect(document.documentElement.dataset["theme"]).toBe("sumi");
  });

  test("quick choices go one at a time, and of those that wait only the newest is sent", async () => {
    const { api, calls } = fakeApi();
    act(() => {
      root.render(<Probe api={api} />);
    });
    act(() => {
      control.receive(FEED);
    });
    let done: Promise<void>[] = [];
    act(() => {
      done = [control.setTheme("washi"), control.setTheme("system"), control.setTheme("sumi")];
    });
    expect(control.theme).toBe("sumi");
    // Washi is on its way; the others wait for its answer, so nothing can overtake it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.map((c) => c.value)).toEqual(["washi"]);
    await act(async () => {
      calls[0]?.resolve({ key: "ui.theme", value: "washi", state: "set" });
      await done[0];
      await done[1];
    });
    // System was replaced before it was sent: only Sumi follows.
    expect(calls.map((c) => c.value)).toEqual(["washi", "sumi"]);
    expect(control.theme).toBe("sumi");
    await act(async () => {
      calls[1]?.resolve({ key: "ui.theme", value: "sumi", state: "set" });
      await done[2];
    });
    expect(control.theme).toBe("sumi");
  });
});
