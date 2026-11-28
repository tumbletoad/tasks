// @vitest-environment happy-dom
//
// Today in a DOM, with the real live store, rendered by React into happy-dom: the
// date shows once with the day's numbers, each a link to what it counts, the sections are `section`
// elements under small headings, an agent's update leaves the expanded task at its place in its
// section until it is collapsed, and Changes lists what an agent changed off Today. Fixture data
// only.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { areaNode, nodesOf } from "@ttasks/client/test/nodes";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "@ttasks/client/store";
import { TodayPage } from "./Today.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };
/** Thursday 12 November 2026 at noon UTC: the 12th in every zone from UTC-11 to UTC+11. */
const NOW = Date.UTC(2026, 10, 12, 12, 0);

function task(n: number, fields: Partial<TaskRow> = {}): TaskRow {
  return {
    id: `t_${String(n).padStart(5, "0")}`,
    ref: `M-${String(n)}`,
    title: `Task ${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    parent: "a_1",
    position: `p${String(n).padStart(5, "0")}`,
    created_at: Date.UTC(2026, 10, 1),
    version: 1,
    ...fields,
  };
}

const TASKS: readonly TaskRow[] = [
  task(1, { title: "Fix appointment time zones", focus_on: "2026-11-11", priority: 1 }),
  task(2, { title: "Investigate checkout crash", focus_on: "2026-11-12", priority: 2 }),
  task(3, { title: "Sign the lease", due_date: "2026-11-14", priority: 3, parent: "a_2" }),
  task(4, { title: "Book the moving van", due_date: "2026-11-21", priority: 2 }),
  task(5, { title: "Docs migration", status: "review" }),
];

function snapshot(tasks: readonly TaskRow[]): SnapshotMessage {
  return {
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks,
    nodes: nodesOf(
      SPACE.id,
      areaNode({ id: "a_1", title: "Lumen", position: "a" }, SPACE.id),
      areaNode({ id: "a_2", title: "Home", position: "b" }, SPACE.id),
    ),
    instances: [],
  };
}

let seq = CURSOR.seq;
function agentUpdate(rows: readonly TaskRow[], changed: readonly string[]): BatchMessage {
  seq += 1;
  return {
    type: "batch",
    space_id: SPACE.id,
    epoch: CURSOR.epoch,
    incarnation: CURSOR.incarnation,
    from: seq - 1,
    through: seq,
    events: [
      {
        seq,
        request_id: `r${String(seq)}`,
        actor: { kind: "agent", label: "Codex" },
        kind: "task.update",
        entities: rows.map((row) => ({
          type: "task",
          id: row.id,
          row: row as unknown as Record<string, unknown>,
          changed,
          created: false,
        })),
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;
/** The service's finished tasks, newest first, as `task.finished` answers. */
let finished: Record<string, unknown>[];
let finishedReads: number;
/** Held: the service's answer to `task.finished` waits until it is released. */
let finishedGate: Promise<void>;
/** The service cannot be reached: `task.finished` fails. */
let finishedFails: boolean;

beforeEach(() => {
  seq = CURSOR.seq;
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
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
  finished = [];
  finishedReads = 0;
  finishedGate = Promise.resolve();
  finishedFails = false;
  api = {
    client: {
      task: {
        finished: async (input: { limit: number; cursor?: string }) => {
          finishedReads += 1;
          await finishedGate;
          if (finishedFails) throw new Error("offline");
          const from = Number(input.cursor ?? 0);
          const through = from + input.limit;
          return {
            rows: finished.slice(from, through),
            ...(through < finished.length ? { cursor: String(through) } : {}),
          };
        },
        update: () => new Promise(() => undefined),
        get: (input: { sections?: readonly string[] }) =>
          input.sections === undefined
            ? new Promise(() => undefined)
            : Promise.resolve({ view: "sections", as_of: "1.10.01234567", sections: {} }),
      },
    },
    busy: () => Promise.resolve({ busy: [], last: {} }),
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

/** Renders `node` in the page's frame: its messages, its session, and a router for its links. */
async function mount(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <I18n>
          <Session.Provider value={{ api, live }}>{node}</Session.Provider>
        </I18n>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
}

function apply(message: SnapshotMessage | BatchMessage) {
  act(() => {
    live.store.push(message);
    live.store.flush();
  });
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });

/** Each section's heading and its rows' titles, in order. */
const sections = () =>
  [...container.querySelectorAll<HTMLElement>("section")].map((section) => [
    section.querySelector("h2")?.textContent ?? "",
    [...section.querySelectorAll<HTMLElement>('li [data-part="title"]')].map(
      (title) => title.textContent,
    ),
  ]);

const titleOf = (title: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-part="title"]')].find(
    (element) => element.textContent === title,
  );

const press = (target: Element | null | undefined, key: string) => {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

/** A task the service reports finished at `at`: completed, or dropped. */
const done = (n: number, at: number, lifecycle = "completed") => ({
  ...task(n, { title: `Finished ${String(n)}` }),
  lifecycle,
  completed_at: at,
  finished_at: at,
});

/** The day's numbers as their links name them, in order. */
const numbers = () =>
  [...container.querySelectorAll<HTMLAnchorElement>('[data-part="day"] a')].map((a) => [
    a.dataset["kind"],
    a.getAttribute("aria-label"),
    a.getAttribute("href"),
  ]);

describe("[A5.3.4.web.today-page] Today's date, numbers and sections in a DOM", () => {
  test("the date shows once, with the day's numbers as links; the sections are sections under small headings", async () => {
    finished = [
      done(20, NOW - 3_600_000),
      done(21, NOW - 86_400_000),
      // Dropped this week: finished, but not done.
      done(22, NOW - 7_200_000, "archived"),
      // Last week's Friday: the count stops there.
      done(23, Date.UTC(2026, 10, 6, 12, 0)),
    ];
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(
      snapshot([
        ...TASKS,
        task(6, { title: "Renew the domain", due_date: "2026-11-10" }),
        task(7, { title: "Pay the deposit", due_date: "2026-11-12" }),
        task(8, { title: "Photos from Tom", status: "waiting", waiting_on: "Tom Haas" }),
      ]),
    );
    await settle();

    const date = container.querySelector('[data-part="date"]');
    expect(date?.textContent).toBe("Thursday 12 November");
    // Today's date appears once on the screen.
    const shown = container.cloneNode(true) as HTMLElement;
    for (const hidden of shown.querySelectorAll("[hidden]")) hidden.remove();
    expect(shown.textContent.split("12 November")).toHaveLength(2);
    expect(numbers()).toEqual([
      ["late", "Late: 1", `/s/${SPACE.id}/search?q=is%3Aoverdue`],
      ["due", "Due today: 1", `/s/${SPACE.id}/search?q=due%3Atoday+-is%3Acompleted+-is%3Aarchived`],
      ["waiting", "Waiting on others: 1", `/s/${SPACE.id}/waiting`],
      ["done", "Done this week: 2, 1 today", `/s/${SPACE.id}/completed`],
    ]);

    expect(sections()).toEqual([
      [
        "Focus",
        [
          "Renew the domain",
          "Pay the deposit",
          "Fix appointment time zones",
          "Investigate checkout crash",
        ],
      ],
      ["This week", ["Sign the lease"]],
      ["Next", ["Book the moving van"]],
    ]);
    // No heading above the sections, and no task twice.
    expect(container.querySelector("h1")).toBeNull();
    const keys = [...container.querySelectorAll<HTMLElement>("li[data-key]")].map(
      (li) => li.dataset["key"],
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("done this week shows a dash until the service answers, and reads again when a task is finished", async () => {
    let release: () => void = () => undefined;
    finishedGate = new Promise((resolve) => {
      release = resolve;
    });
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot(TASKS));
    expect(numbers().at(-1)?.[1]).toBe("Done this week: –");
    release();
    await settle();
    expect(numbers().at(-1)?.[1]).toBe("Done this week: 0");
    const reads = finishedReads;
    // An agent finishes a task: the count is read again, and its link keeps its place.
    finished = [done(2, NOW)];
    apply(
      agentUpdate(
        [{ ...(TASKS[1] as TaskRow), lifecycle: "completed", version: 2 }],
        ["lifecycle"],
      ),
    );
    await settle();
    expect(finishedReads).toBe(reads + 1);
    expect(numbers().map(([kind]) => kind)).toEqual(["late", "due", "waiting", "done"]);
    expect(numbers().at(-1)?.[1]).toBe("Done this week: 1, 1 today");
    // A change that finishes nothing reads nothing.
    apply(agentUpdate([{ ...(TASKS[0] as TaskRow), priority: 2, version: 2 }], ["priority"]));
    await settle();
    expect(finishedReads).toBe(reads + 1);
  });

  test("tasks finished in a burst cost one more read, and its answer is the one shown", async () => {
    let release: () => void = () => undefined;
    finishedGate = new Promise((resolve) => {
      release = resolve;
    });
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot(TASKS));
    finished = [done(2, NOW), done(3, NOW)];
    for (const n of [1, 2]) {
      apply(
        agentUpdate(
          [{ ...(TASKS[n] as TaskRow), lifecycle: "completed", version: 2 }],
          ["lifecycle"],
        ),
      );
    }
    expect(finishedReads).toBe(1);
    release();
    await settle();
    await settle();
    expect(finishedReads).toBe(2);
    expect(numbers().at(-1)?.[1]).toBe("Done this week: 2, 2 today");
  });

  test("a read that fails shows a dash, and the feed being live again reads the count", async () => {
    // The tab holds its rows, and its connection dropped before Today was opened.
    apply(snapshot(TASKS));
    act(() => {
      live.store.set({ phase: "offline" });
    });
    finishedFails = true;
    await mount(<TodayPage onExpand={() => undefined} />);
    await settle();
    expect(numbers().at(-1)?.[1]).toBe("Done this week: –");
    // Meanwhile a task was finished elsewhere. The feed resumes with nothing to send.
    finishedFails = false;
    finished = [done(2, NOW)];
    act(() => {
      live.store.set({ phase: "live" });
    });
    await settle();
    expect(numbers().at(-1)?.[1]).toBe("Done this week: 1, 1 today");
    // A refresh that fails takes the count away rather than leave one nobody vouches for.
    finishedFails = true;
    apply(
      agentUpdate(
        [{ ...(TASKS[1] as TaskRow), lifecycle: "completed", version: 2 }],
        ["lifecycle"],
      ),
    );
    await settle();
    expect(numbers().at(-1)?.[1]).toBe("Done this week: –");
  });

  test("a day busier than the reads go marks today's share as a floor too", async () => {
    finished = Array.from({ length: 1_051 }, (_, i) => done(100 + i, NOW - i));
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot(TASKS));
    await settle();
    await settle();
    expect(numbers().at(-1)?.[1]).toBe("Done this week: 1,050+, 1,050+ today");
  });

  test("a tab that wakes on a later day moves on to it when it is shown again", async () => {
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot([...TASKS, task(6, { title: "Pay the deposit", due_date: "2026-11-19" })]));
    expect(container.querySelector('[data-part="date"]')?.textContent).toBe("Thursday 12 November");
    expect(sections()[2]).toEqual(["Next", ["Book the moving van", "Pay the deposit"]]);
    // The machine slept past midnight: the midnight timer has not fired yet.
    vi.setSystemTime(NOW + 86_400_000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.querySelector('[data-part="date"]')?.textContent).toBe("Friday 13 November");
    expect(sections()[1]).toEqual(["This week", ["Sign the lease", "Pay the deposit"]]);
  });

  test("a task an agent completes says when on the page's clock, in its zone", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW });
    const here = new Intl.DateTimeFormat().resolvedOptions();
    const away = here.timeZone === "Asia/Tokyo" ? "America/Lima" : "Asia/Tokyo";
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...here,
      timeZone: away,
    });
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot(TASKS));
    const crash = TASKS[1] as TaskRow;
    apply(agentUpdate([{ ...crash, lifecycle: "completed", version: 2 }], ["lifecycle"]));
    await settle();
    const time = new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: away }).format(NOW);
    expect(
      container.querySelector(`li[data-task="${crash.ref}"] [data-tip]`)?.getAttribute("data-tip"),
    ).toBe(`Completed by Codex · ${time}`);
  });

  test("a tab that wakes on a later day and was never hidden moves on to it at the next minute", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW });
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot([...TASKS, task(6, { title: "Pay the deposit", due_date: "2026-11-19" })]));
    expect(container.querySelector('[data-part="date"]')?.textContent).toBe("Thursday 12 November");
    // The machine slept past midnight with the tab in front: no timer saw the night go by.
    vi.setSystemTime(NOW + 86_400_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(container.querySelector('[data-part="date"]')?.textContent).toBe("Friday 13 November");
    expect(sections()[1]).toEqual(["This week", ["Sign the lease", "Pay the deposit"]]);
  });
  test("an agent's update leaves the expanded task where it is until it is collapsed", async () => {
    const onExpand = vi.fn<(task: TaskRow | undefined) => void>();
    await mount(<TodayPage onExpand={onExpand} />);
    apply(snapshot(TASKS));
    act(() => {
      titleOf("Fix appointment time zones")?.click();
    });
    await settle();
    expect(onExpand).toHaveBeenLastCalledWith(expect.objectContaining({ ref: "M-1" }));
    expect(titleOf("Fix appointment time zones")?.getAttribute("aria-expanded")).toBe("true");

    // An agent unstars it and moves it to Saturday: it would go to This week, and stays.
    const moved = task(1, {
      title: "Fix appointment time zones",
      due_date: "2026-11-14",
      priority: 1,
      version: 2,
    });
    apply(agentUpdate([moved], ["focus", "due"]));
    expect(sections()).toEqual([
      ["Focus", ["Fix appointment time zones", "Investigate checkout crash"]],
      ["This week", ["Sign the lease"]],
      ["Next", ["Book the moving van"]],
    ]);
    // An agent completes it: off Today, still where it was while expanded.
    apply(agentUpdate([{ ...moved, lifecycle: "completed", version: 3 }], ["lifecycle"]));
    expect(sections()[0]).toEqual([
      "Focus",
      ["Fix appointment time zones", "Investigate checkout crash"],
    ]);
    // With its latest data: the card says it is checked off, though the live rows no longer hold it.
    const card = container.querySelector('[role="region"]');
    expect(card?.textContent).toContain("StatusChecked off");
    expect(card?.textContent).not.toContain("StatusOpen");

    // Collapsed, it leaves.
    press(titleOf("Fix appointment time zones"), "Escape");
    expect(onExpand).toHaveBeenLastCalledWith(undefined);
    expect(sections()[0]).toEqual(["Focus", ["Investigate checkout crash"]]);
  });

  test("Changes lists what an agent changed off Today, and not what Today shows", async () => {
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot(TASKS));
    expect(sections().map(([heading]) => heading)).not.toContain("Changes");
    // The review task is on no section; the starred one is in Focus already.
    apply(
      agentUpdate(
        [{ ...task(5, { title: "Docs migration", status: "review" }), version: 2 }],
        ["status"],
      ),
    );
    apply(agentUpdate([{ ...TASKS[1], version: 2 } as TaskRow], ["summary"]));
    expect(sections().at(-1)).toEqual(["Changes", ["Docs migration"]]);
  });

  test("a task completed while Today shows it stays at its place, struck through, for the hold", async () => {
    await mount(<TodayPage onExpand={() => undefined} />);
    apply(snapshot(TASKS));
    apply(
      agentUpdate(
        [{ ...(TASKS[1] as TaskRow), lifecycle: "completed", version: 2 }],
        ["lifecycle"],
      ),
    );
    expect(sections()[0]).toEqual([
      "Focus",
      ["Fix appointment time zones", "Investigate checkout crash"],
    ]);
    expect(container.querySelector('li[data-key="t_00002"]')?.getAttribute("data-done")).toBe(
      "true",
    );
  });
});
