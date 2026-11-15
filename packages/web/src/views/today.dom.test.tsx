// @vitest-environment happy-dom
//
// Today in a DOM (A5 3.4, 3.15), with the real live store, rendered by React into happy-dom: the
// strip shows the date once, the sections are `section` elements under small headings, an agent's
// update leaves the expanded task at its place in its section until it is collapsed, Changes lists
// what an agent changed off Today, and the strip's day and Escape go to the page. Fixture data only.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "../store/rows.ts";
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
    area_id: "a_1",
    position: `p${String(n).padStart(5, "0")}`,
    created_at: Date.UTC(2026, 10, 1),
    version: 1,
    ...fields,
  };
}

const TASKS: readonly TaskRow[] = [
  task(1, { title: "Fix appointment time zones", focus_on: "2026-11-11", priority: 1 }),
  task(2, { title: "Investigate checkout crash", focus_on: "2026-11-12", priority: 2 }),
  task(3, { title: "Sign the lease", due_date: "2026-11-14", priority: 3, area_id: "a_2" }),
  task(4, { title: "Book the moving van", due_date: "2026-11-21", priority: 2 }),
  task(5, { title: "Docs migration", status: "review" }),
];

function snapshot(tasks: readonly TaskRow[]): SnapshotMessage {
  return {
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks,
    areas: [
      { id: "a_1", title: "Lumen", position: "a" },
      { id: "a_2", title: "Home", position: "b" },
    ],
    projects: [],
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
  api = {
    client: {
      task: {
        update: () => new Promise(() => undefined),
        get: (input: { sections?: readonly string[] }) =>
          input.sections === undefined
            ? new Promise(() => undefined)
            : Promise.resolve({ view: "sections", as_of: "1.10.01234567", sections: {} }),
      },
    },
    receipts: () => Promise.resolve([]),
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

function mount(node: ReactNode) {
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>{node}</Session.Provider>
      </I18n>,
    );
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

describe("[A5.3.4.web.today-page] Today's strip and sections in a DOM", () => {
  test("the strip shows the date once; the sections are sections under small headings", () => {
    const onDay = vi.fn<(day: string | undefined) => void>();
    mount(<TodayPage onExpand={() => undefined} onDay={onDay} />);
    apply(snapshot(TASKS));

    const cells = [...container.querySelectorAll<HTMLButtonElement>("[data-date]")];
    expect(cells.map((cell) => cell.dataset["date"])).toEqual([
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
    ]);
    expect(cells[0]?.textContent).toBe("Thu12 Nov");
    expect(cells[0]?.getAttribute("aria-current")).toBe("date");
    expect(cells[0]?.getAttribute("aria-label")).toBe("Thursday 12 November");
    expect(cells[1]?.textContent).toBe("Fri13");
    // Today's date appears once on the screen: in its cell, nowhere else.
    expect(container.textContent.split("12 Nov")).toHaveLength(2);
    expect(container.textContent).not.toContain("Thursday");
    // Saturday's cell marks the lease, in its area's colour, and names it in its tooltip.
    expect(cells[2]?.querySelectorAll("[data-ring]")).toHaveLength(1);
    expect(cells[2]?.dataset["tip"]).toBe("Sign the lease");
    // One cell in the tab order, today's.
    expect(cells.map((cell) => cell.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);

    expect(sections()).toEqual([
      ["Focus", ["Fix appointment time zones", "Investigate checkout crash"]],
      ["This week", ["Sign the lease"]],
      ["Next", ["Book the moving van"]],
    ]);
    // No heading above the sections, and no task twice.
    expect(container.querySelector("h1")).toBeNull();
    const keys = [...container.querySelectorAll<HTMLElement>("li[data-key]")].map(
      (li) => li.dataset["key"],
    );
    expect(new Set(keys).size).toBe(keys.length);

    // A click on a day chooses it; on the chosen day it clears it.
    act(() => {
      cells[2]?.click();
    });
    expect(onDay).toHaveBeenLastCalledWith("2026-11-14");
  });

  test("a tab that wakes on a later day moves on to it when it is shown again", () => {
    mount(<TodayPage onExpand={() => undefined} onDay={() => undefined} />);
    apply(snapshot([...TASKS, task(6, { title: "Pay the deposit", due_date: "2026-11-19" })]));
    expect(container.querySelector("[aria-current='date']")?.getAttribute("data-date")).toBe(
      "2026-11-12",
    );
    expect(sections()[2]).toEqual(["Next", ["Book the moving van", "Pay the deposit"]]);
    // The machine slept past midnight: the midnight timer has not fired yet.
    vi.setSystemTime(NOW + 86_400_000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.querySelector("[aria-current='date']")?.getAttribute("data-date")).toBe(
      "2026-11-13",
    );
    expect(container.querySelectorAll("[data-date]")[6]?.getAttribute("data-date")).toBe(
      "2026-11-19",
    );
    expect(sections()[1]).toEqual(["This week", ["Sign the lease", "Pay the deposit"]]);
  });

  test("the chosen day narrows Focus and This week, and Escape clears it", () => {
    const onDay = vi.fn<(day: string | undefined) => void>();
    mount(<TodayPage day="2026-11-14" onExpand={() => undefined} onDay={onDay} />);
    apply(snapshot(TASKS));
    expect(sections()).toEqual([
      ["This week", ["Sign the lease"]],
      ["Next", ["Book the moving van"]],
    ]);
    const saturday = container.querySelector<HTMLButtonElement>('[data-date="2026-11-14"]');
    expect(saturday?.getAttribute("aria-pressed")).toBe("true");
    expect(saturday?.tabIndex).toBe(0);
    act(() => {
      saturday?.click();
    });
    expect(onDay).toHaveBeenLastCalledWith(undefined);
    onDay.mockClear();
    press(titleOf("Sign the lease"), "Escape");
    expect(onDay).toHaveBeenLastCalledWith(undefined);
    // The arrows move along the strip.
    press(saturday, "ArrowRight");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-11-15");
  });

  test("an agent's update leaves the expanded task where it is until it is collapsed", async () => {
    const onExpand = vi.fn<(task: TaskRow | undefined) => void>();
    mount(<TodayPage onExpand={onExpand} onDay={() => undefined} />);
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

  test("Changes lists what an agent changed off Today, and not what Today shows", () => {
    mount(<TodayPage onExpand={() => undefined} onDay={() => undefined} />);
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
});
