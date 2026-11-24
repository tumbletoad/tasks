// @vitest-environment happy-dom
//
// A search left open into another day: what it finds can depend on the day (`due:today`, a star,
// `created:-7d`), so the results are read again when the page's day moves, over midnight while
// the page is open, and when a page that slept wakes on a later day, without the person doing
// anything and without closing the card they had open. Fixture data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { SnapshotMessage } from "../store/rows.ts";
import { FakeFrames } from "../../test/fake-frames.ts";
import { SearchPage } from "./Search.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };
const at = (seq: number) => `1.${String(seq)}.01234567`;
const id = (n: number) => `t_${String(n).padStart(5, "0")}`;
/** Thursday 12 November 2026, a minute before midnight on this machine's calendar. */
const LATE = new Date(2026, 10, 12, 23, 59).getTime();
const MINUTE = 60_000;
const EXPANDED = `[data-part="title"][aria-expanded="true"]`;

function found(n: number) {
  return {
    kind: "task",
    id: id(n),
    ref: `M-${String(n)}`,
    title: `Task ${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    priority: 4,
    area: "Lumen",
  };
}

function snapshot(): SnapshotMessage {
  return {
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks: [
      {
        id: id(1),
        ref: "M-1",
        title: "Task 1",
        status: "open",
        inbox: false,
        lifecycle: "active",
        area_id: "a_1",
        position: "p1",
        created_at: Date.UTC(2026, 10, 1),
        version: 4,
      },
    ],
    areas: [{ id: "a_1", title: "Lumen", position: "a" }],
    projects: [],
    instances: [],
  };
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;
/** What a search of the open tasks finds now. */
let open: unknown[];
let searches: number;
/** The service does not answer searches. */
let failing: boolean;
/** The zone each search was asked to count its days in. */
let zones: unknown[];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    now: LATE,
  });
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
  open = [found(1)];
  searches = 0;
  failing = false;
  zones = [];
  api = {
    client: {
      task: {
        search: (input: { scope?: string; time_zone?: string }) => {
          searches += 1;
          zones.push(input.time_zone);
          if (failing) return Promise.reject(new Error("unreachable"));
          return Promise.resolve({
            as_of: at(10),
            scope: input.scope,
            parsed: "due:today",
            total: 1,
            first: 1,
            rows: input.scope === "finished" ? [] : open,
          });
        },
        get: () => new Promise(() => undefined),
      },
    },
    busy: () => Promise.resolve([]),
    receipts: () => Promise.resolve([]),
    runs: () => Promise.resolve([]),
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

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

const titles = () =>
  [...container.querySelectorAll('li[data-key] [data-part="title"]')].map((el) => el.textContent);

async function mount(task?: string) {
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>
          <SearchPage q="due:today" task={task} onExpand={() => undefined} />
        </Session.Provider>
      </I18n>,
    );
  });
  await settle();
}

describe("[A5.3.13.web.search-day] a search left open reads again on the page's next day", () => {
  test("over midnight while the page is open, with the open card kept open", async () => {
    await mount("M-1");
    expect(titles()).toEqual(["Task 1"]);
    expect(container.querySelector(EXPANDED)?.textContent).toBe("Task 1");
    const before = searches;
    open = [found(1), found(2)];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
    });
    await settle();
    expect(searches).toBeGreaterThan(before);
    expect(titles()).toEqual(["Task 1", "Task 2"]);
    expect(container.querySelector(EXPANDED)?.textContent).toBe("Task 1");
    expect(container.textContent).not.toContain("Results changed");
  });

  test("a page that slept past midnight, shown again", async () => {
    await mount();
    open = [found(2)];
    // The machine slept: the clock moved, no timer fired.
    vi.setSystemTime(LATE + 8 * 60 * MINUTE);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(titles()).toEqual(["Task 2"]);
  });

  test("a page that slept past midnight and was never hidden, at the next minute", async () => {
    await mount();
    open = [found(2)];
    vi.setSystemTime(LATE + 8 * 60 * MINUTE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE + 1_000);
    });
    await settle();
    expect(titles()).toEqual(["Task 2"]);
  });

  test("a page that wakes before the service answers reads the new day once the feed is back", async () => {
    await mount();
    open = [found(2)];
    failing = true;
    act(() => {
      live.store.set({ phase: "offline" });
    });
    vi.setSystemTime(LATE + 8 * 60 * MINUTE);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(container.textContent).toContain("The search could not be read.");
    failing = false;
    act(() => {
      live.store.set({ phase: "live" });
    });
    await settle();
    expect(titles()).toEqual(["Task 2"]);
    expect(container.textContent).not.toContain("The search could not be read.");
  });

  test("a read of the new day that fails while the feed stays live is read again on its next snapshot", async () => {
    await mount();
    open = [found(2)];
    failing = true;
    vi.setSystemTime(LATE + 8 * 60 * MINUTE);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(container.textContent).toContain("The search could not be read.");
    failing = false;
    act(() => {
      live.store.push(snapshot());
      live.store.flush();
    });
    await settle();
    expect(titles()).toEqual(["Task 2"]);
    expect(container.textContent).not.toContain("Results changed");
  });

  test("a search counts its days in the page's zone, and in the new one after travel", async () => {
    await mount();
    const here = new Intl.DateTimeFormat().resolvedOptions();
    expect(zones).toEqual([here.timeZone, here.timeZone]);
    const away = here.timeZone === "Asia/Tokyo" ? "America/Lima" : "Asia/Tokyo";
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...here,
      timeZone: away,
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(zones.slice(2)).toEqual([away, away]);
  });

  test("the same day: the search is not read again", async () => {
    vi.setSystemTime(LATE - 60 * MINUTE);
    await mount();
    const before = searches;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(searches).toBe(before);
  });
});
