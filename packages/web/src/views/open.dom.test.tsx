// @vitest-environment happy-dom
//
// Open from a row's tile and an expanded task's strip, with the real live store and the page's own
// actions, rendered by React into a DOM (happy-dom) against a fake service: one press is one Open,
// an Open that got no answer is the same Open when pressed again, only "Open another" asks for a
// second session, and what busies the apps is read again until the service answers.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Refused, type Api, type Busy, type Instance, type Receipt } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { SnapshotMessage, TaskRow } from "../store/rows.ts";
import { TaskList } from "./TaskList.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const TASK: TaskRow = {
  id: "t_00001",
  ref: "M-1",
  title: "Task 1",
  status: "open",
  inbox: false,
  lifecycle: "active",
  area_id: "a_1",
  position: "p00001",
  created_at: Date.UTC(2026, 10, 1),
  version: 1,
};
const CLAUDE: Instance = {
  key: "claude-work",
  label: "Claude Code",
  glyph: "Cc",
  ring: 1,
  route: "terminal",
};

const snapshot = (): SnapshotMessage => ({
  type: "snapshot",
  space: SPACE,
  cursor: { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 },
  tasks: [TASK],
  areas: [{ id: "a_1", title: "Lumen", position: "a" }],
  projects: [],
  instances: [CLAUDE],
});

const receipt = (id: string): Receipt => ({
  id,
  reference: "L7KQ21",
  instance: CLAUDE.key,
  route: "terminal",
  state: "prepared",
  reason: null,
  at: { prepared: Date.UTC(2026, 10, 1, 9) },
});

const lost = () => Promise.reject(new TypeError("Failed to fetch"));
const RUNNING: Busy[] = [{ task: TASK.id, instance: CLAUDE.key, state: "running" }];

interface Opened {
  readonly id: string;
  readonly another: boolean;
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let opened: Opened[];
/** What Open answers, call by call. */
let openAnswer: (call: number) => Promise<{ receipt: Receipt; copy: undefined }>;
/** What a read of busy answers, read by read. */
let busyAnswer: (read: number) => Promise<Busy[]>;
let busyReads: number;

beforeEach(() => {
  opened = [];
  busyReads = 0;
  openAnswer = (call) =>
    Promise.resolve({ receipt: receipt(`la_${String(call)}`), copy: undefined });
  busyAnswer = () => Promise.resolve([]);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.hasAttribute("data-index") ? 52 : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: height,
      right: 800,
      width: 800,
      height,
    } as DOMRect;
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  const api = {
    client: {
      task: {
        get: (input: { readonly sections?: unknown }) =>
          Promise.resolve(
            input.sections === undefined
              ? {
                  view: "digest",
                  as_of: "1.10.01234567",
                  task: {
                    id: TASK.id,
                    ref: TASK.ref,
                    title: TASK.title,
                    summary: "",
                    status: "open",
                    inbox: false,
                    lifecycle: "active",
                    priority: 4,
                    focus: false,
                    area: "Lumen",
                    context: "",
                    learnings: [],
                    instructions: [],
                    notes: [],
                    log: [],
                    sources: [],
                    more: { instructions: 0, notes: 0, log: 0, sources: 0 },
                    version: 1,
                  },
                }
              : { view: "sections", as_of: "1.10.01234567", sections: {} },
          ),
      },
    },
    busy: () => {
      busyReads += 1;
      return busyAnswer(busyReads);
    },
    receipts: () => Promise.resolve([]),
    runs: () => Promise.resolve([]),
    openLaunch: (
      _task: string,
      _instance: string,
      id: string,
      options: { readonly another?: boolean } = {},
    ) => {
      opened.push({ id, another: options.another === true });
      return openAnswer(opened.length);
    },
  } as unknown as Api;
  live = new Live({
    api,
    route: { space: SPACE.id },
    build: "",
    onSpace: () => undefined,
    onSignedOut: () => undefined,
    frames: new FakeFrames(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mount(<TaskList view="open" filter={() => true} empty="" />, api);
  act(() => {
    live.store.push(snapshot());
    live.store.flush();
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  live.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(node: ReactNode, api: Api) {
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>{node}</Session.Provider>
      </I18n>,
    );
  });
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

const row = `li[data-key="${TASK.id}"]`;
const tile = () => container.querySelector<HTMLButtonElement>(`${row} button[data-part="tile"]`);
const openButton = () =>
  container.querySelector<HTMLButtonElement>(`${row} button[data-part="open"]`);

/** The tab goes offline and is live again: it reads what busies the apps again. */
const reconnect = async () => {
  act(() => {
    live.store.set({ phase: "offline" });
  });
  act(() => {
    live.store.set({ phase: "live" });
  });
  await settle();
};

const expand = async () => {
  act(() => {
    container.querySelector<HTMLElement>(`${row} [data-part="title"]`)?.click();
  });
  await settle();
};

const click = (button: HTMLButtonElement | null, detail: number) => {
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  });
};

const openKeys = (repeat: boolean) => {
  act(() => {
    container.querySelector(`${row} [data-part="composer"]`)?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

describe("[M6.page.open-once] one press is one Open, and an Open without an answer is not sent as a new one", () => {
  test("the second click of a double click on the tile or the strip, and a held key, open nothing more", async () => {
    await settle();
    // The first click's answer came before the second click.
    click(tile(), 1);
    await settle();
    click(tile(), 2);
    await settle();
    expect(opened).toHaveLength(1);
    await expand();
    click(openButton(), 1);
    await settle();
    click(openButton(), 2);
    await settle();
    expect(opened).toHaveLength(2);
    openKeys(false);
    await settle();
    openKeys(true);
    await settle();
    expect(opened).toHaveLength(3);
    // A held Enter on the Open button does not repeat its click.
    const press = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      openButton()?.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
  });

  test("until the service answers, the same Open carries the same request ID; an answer or a refusal ends it", async () => {
    openAnswer = (call) =>
      call <= 2
        ? lost()
        : call === 3
          ? Promise.resolve({ receipt: receipt("la_3"), copy: undefined })
          : call === 4
            ? Promise.reject(new Refused(500, "internal"))
            : call === 5
              ? Promise.reject(new Refused(400, "invalid_input", undefined, { reason: "x" }))
              : Promise.resolve({ receipt: receipt("la_6"), copy: undefined });
    await settle();
    for (let i = 0; i < 6; i += 1) {
      click(tile(), 1);
      await settle();
    }
    const ids = opened.map((o) => o.id);
    expect(ids).toHaveLength(6);
    // Lost twice, then answered: one request. Then an internal failure and its retry, refused:
    // one request. Then a new one.
    expect(new Set(ids.slice(0, 3)).size).toBe(1);
    expect(ids[3]).not.toBe(ids[0]);
    expect(ids[4]).toBe(ids[3]);
    expect(ids[5]).not.toBe(ids[4]);
  });

  test("only the strip's Open another asks for a second session; a running tile expands", async () => {
    await settle();
    busyAnswer = () => Promise.resolve(RUNNING);
    await reconnect();
    expect(tile()?.dataset["state"]).toBe("running");
    click(tile(), 1);
    await settle();
    expect(opened).toEqual([]);
    expect(openButton()?.textContent).toContain("Open another");
    click(openButton(), 1);
    await settle();
    expect(opened.map((o) => o.another)).toEqual([true]);
  });
});

describe("[M6.page.busy-read] what busies the apps is read again until the service answers", () => {
  test("a failed read is tried again while the tab is live, and the tab reads again once it is live after being offline", async () => {
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = busyReads;
    // The read on going live fails, and so does its first retry.
    busyAnswer = (read) => (read <= before + 2 ? lost() : Promise.resolve(RUNNING));
    await reconnect();
    expect(busyReads).toBe(before + 1);
    expect(tile()?.dataset["state"]).toBe("ready");
    // Each retry waits a little longer: 1 s, then 2 s.
    for (const wait of [1_000, 2_000]) {
      act(() => {
        vi.advanceTimersByTime(wait);
      });
      await settle();
    }
    expect(busyReads).toBe(before + 3);
    expect(tile()?.dataset["state"]).toBe("running");

    // The session ends while the tab is offline: once it is live again it reads, and is Ready.
    busyAnswer = () => Promise.resolve([]);
    const offline = busyReads;
    act(() => {
      live.store.set({ phase: "offline" });
    });
    await settle();
    expect(busyReads).toBe(offline);
    act(() => {
      live.store.set({ phase: "live" });
    });
    await settle();
    expect(busyReads).toBe(offline + 1);
    expect(tile()?.dataset["state"]).toBe("ready");
  });
});
