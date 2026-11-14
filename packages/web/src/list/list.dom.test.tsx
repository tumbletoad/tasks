// @vitest-environment happy-dom
//
// The list with the real live store, rendered by React into a DOM (happy-dom), without a browser:
// how often each row renders when the store changes (A5 3.25 "An event re-renders only the rows it
// changed"), and the list's keyboard and focus (A5 3.22). The row function is wrapped to count its
// calls per task: a row's component calls it exactly once per render, so the count is the row's
// render count. Layout is stubbed (happy-dom lays nothing out): every item is 52 px high and the
// window 800 px, which is what the virtualiser reads.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "../store/rows.ts";
import { TaskList } from "../views/TaskList.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

const renders = vi.hoisted(() => new Map<string, number>());

vi.mock("../row/model.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../row/model.ts")>();
  return {
    ...real,
    renderRow: (
      row: Parameters<typeof real.renderRow>[0],
      ctx: Parameters<typeof real.renderRow>[1],
    ) => {
      renders.set(row.task.id, (renders.get(row.task.id) ?? 0) + 1);
      return real.renderRow(row, ctx);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };
const ITEM_HEIGHT = 52;

function task(n: number, fields: Partial<TaskRow> = {}): TaskRow {
  const id = `t_${String(n).padStart(5, "0")}`;
  return {
    id,
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

function snapshot(tasks: readonly TaskRow[]): SnapshotMessage {
  return {
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks,
    areas: [{ id: "a_1", title: "Lumen", position: "a" }],
    projects: [],
    instances: [{ key: "cx", label: "Codex · work", glyph: "Cx", ring: 6, route: "terminal" }],
  };
}

let seq = CURSOR.seq;
function batch(
  rows: readonly TaskRow[],
  changed: readonly string[],
  actor = "human",
): BatchMessage {
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
        actor: { kind: actor, label: actor === "agent" ? "Codex" : "Mira" },
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
const updates: unknown[] = [];

beforeEach(() => {
  renders.clear();
  updates.length = 0;
  seq = CURSOR.seq;
  // Layout as the virtualiser reads it: items of 52 px in an 800 px window.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.hasAttribute("data-index") ? ITEM_HEIGHT : 0;
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
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-index") ? ITEM_HEIGHT : 0;
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  api = {
    client: {
      task: {
        update: (input: unknown) => {
          updates.push(input);
          return new Promise(() => undefined);
        },
        get: () => Promise.resolve({ sections: { log: [] } }),
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

const rowsInDom = () => [...container.querySelectorAll<HTMLElement>("li[data-key]")];
const titleOf = (key: string) =>
  container.querySelector<HTMLElement>(`li[data-key="${key}"] [data-part="title"]`);
const counts = () => new Map(renders);
/** The rows whose render count went up since `before`. */
const renderedSince = (before: ReadonlyMap<string, number>) =>
  [...renders].filter(([id, n]) => n !== (before.get(id) ?? 0)).map(([id]) => id);

const OPEN = (t: TaskRow) => t.status === "open";

describe("[A5.3.25.web.render-count] a store update renders only the rows it changed", () => {
  test("a short list: an agent's edit of one task renders that row and no other", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task(i + 1));
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    expect(rowsInDom()).toHaveLength(30);
    expect(container.querySelector("[data-list]")?.getAttribute("data-virtual")).toBe("false");
    const before = counts();
    const edited = { ...task(7), title: "Task 7, renamed", version: 2 };
    apply(batch([edited], ["title"], "agent"));
    expect(renderedSince(before)).toEqual([edited.id]);
    expect(titleOf(edited.id)?.textContent).toBe("Task 7, renamed");
  });

  test("a virtualised list: one mounted task renders once, an unmounted one renders nothing", () => {
    const tasks = Array.from({ length: 1_000 }, (_, i) => task(i + 1));
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const list = container.querySelector("[data-list]");
    expect(list?.getAttribute("data-virtual")).toBe("true");
    // 800 px of 52 px items, plus 10 each way: far fewer than 1,000.
    const mounted = rowsInDom().length;
    expect(mounted).toBeGreaterThan(10);
    expect(mounted).toBeLessThan(40);
    let before = counts();
    const shown = { ...task(3), title: "Task 3, renamed", version: 2 };
    apply(batch([shown], ["title"]));
    expect(renderedSince(before)).toEqual([shown.id]);
    before = counts();
    const hidden = { ...task(900), priority: 1, version: 2 };
    apply(batch([hidden], ["priority"]));
    expect(renderedSince(before)).toEqual([]);
  });

  test("starring a row shows at once through its overlay and renders only that row", () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task(i + 1));
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const star = container.querySelector<HTMLButtonElement>(
      `li[data-key="${tasks[0]?.id ?? ""}"] [data-part="star"]`,
    );
    expect(star?.getAttribute("aria-pressed")).toBe("false");
    const before = counts();
    act(() => {
      star?.click();
    });
    expect(star?.getAttribute("aria-pressed")).toBe("true");
    expect(renderedSince(before)).toEqual([tasks[0]?.id]);
    expect(updates).toEqual([
      // The base is the applied cursor the row was drawn from.
      expect.objectContaining({ task: tasks[0]?.id, set: { focus: true }, base: "1.10.01234567" }),
    ]);
  });
});

describe("[A5.3.22.web.list-keys] the list's keyboard and focus", () => {
  const press = (key: string) => {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  };
  const focused = () =>
    document.activeElement?.closest<HTMLElement>("li[data-key]")?.dataset["key"];

  test("one title in the tab order; j, k, the arrows, Home, End, [ and ] move it", () => {
    const tasks = [task(1), task(2), task(3, { area_id: "a_2" }), task(4, { area_id: "a_2" })];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    act(() => {
      live.store.push({
        ...snapshot(tasks),
        areas: [
          { id: "a_1", title: "Lumen", position: "a" },
          { id: "a_2", title: "Home", position: "b" },
        ],
      });
      live.store.flush();
    });
    const tabbable = () =>
      [...container.querySelectorAll<HTMLElement>('[data-part="title"]')]
        .filter((b) => b.tabIndex === 0)
        .map((b) => b.closest<HTMLElement>("li")?.dataset["key"]);
    expect(tabbable()).toEqual([tasks[0]?.id]);
    // The other controls of a row that is not current are out of the tab order too.
    const second = container.querySelector(`li[data-key="${tasks[1]?.id ?? ""}"]`);
    expect([...(second?.querySelectorAll("button") ?? [])].every((b) => b.tabIndex === -1)).toBe(
      true,
    );
    // Rows announce their place in their list.
    expect(second?.getAttribute("aria-posinset")).toBe("2");
    expect(second?.getAttribute("aria-setsize")).toBe("2");

    act(() => {
      titleOf(tasks[0]?.id ?? "")?.focus();
    });
    press("j");
    expect(focused()).toBe(tasks[1]?.id);
    expect(tabbable()).toEqual([tasks[1]?.id]);
    press("ArrowDown");
    expect(focused()).toBe(tasks[2]?.id);
    press("k");
    expect(focused()).toBe(tasks[1]?.id);
    press("End");
    expect(focused()).toBe(tasks[3]?.id);
    press("Home");
    expect(focused()).toBe(tasks[0]?.id);
    press("]");
    expect(focused()).toBe(tasks[2]?.id);
    press("[");
    expect(focused()).toBe(tasks[0]?.id);
    press("ArrowUp");
    expect(focused()).toBe(tasks[0]?.id);
  });

  test("Enter expands through the title, Escape collapses and focuses the title", () => {
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const title = titleOf(tasks[1]?.id ?? "");
    act(() => {
      title?.focus();
      title?.click();
    });
    expect(title?.getAttribute("aria-expanded")).toBe("true");
    const region = container.querySelector(`#${title?.getAttribute("aria-controls") ?? "none"}`);
    expect(region?.getAttribute("role")).toBe("region");
    press("Escape");
    expect(title?.getAttribute("aria-expanded")).toBe("false");
    expect(focused()).toBe(tasks[1]?.id);
  });

  test("a focused row that an update takes out of the view stays until focus leaves", () => {
    const tasks = [task(1), task(2), task(3)];
    mount(
      <>
        <button type="button" id="outside" />
        <TaskList view="open" filter={OPEN} empty="" />
      </>,
    );
    apply(snapshot(tasks));
    act(() => {
      titleOf(tasks[1]?.id ?? "")?.focus();
    });
    apply(batch([{ ...task(2), status: "waiting", version: 2 }], ["status"], "agent"));
    // Still there, still focused: nothing moves under focus.
    expect(rowsInDom().map((r) => r.dataset["key"])).toEqual(tasks.map((t) => t.id));
    expect(focused()).toBe(tasks[1]?.id);
    act(() => {
      container.querySelector<HTMLElement>("#outside")?.focus();
    });
    expect(rowsInDom().map((r) => r.dataset["key"])).toEqual([tasks[0]?.id, tasks[2]?.id]);
  });

  test("a focused row that an update moves to another group stays where it was until focus leaves", () => {
    const tasks = [task(1), task(2), task(3, { area_id: "a_2" })];
    mount(
      <>
        <button type="button" id="outside" />
        <TaskList view="open" filter={OPEN} empty="" />
      </>,
    );
    act(() => {
      live.store.push({
        ...snapshot(tasks),
        areas: [
          { id: "a_1", title: "Lumen", position: "a" },
          { id: "a_2", title: "Home", position: "b" },
        ],
      });
      live.store.flush();
    });
    const title = titleOf(tasks[1]?.id ?? "");
    act(() => {
      title?.focus();
    });
    const moved = { ...task(2), area_id: "a_2", title: "Task 2, moved", version: 2 };
    apply(batch([moved], ["area_id", "title"], "agent"));
    // The same element keeps focus, in its old group, and shows the new data.
    expect(document.activeElement).toBe(title);
    expect(title?.isConnected).toBe(true);
    expect(title?.textContent).toBe("Task 2, moved");
    const groupOf = (key: string) =>
      container
        .querySelector(`li[data-key="${key}"]`)
        ?.closest<HTMLElement>('[role="group"]')
        ?.getAttribute("aria-label");
    expect(groupOf(moved.id)).toBe("Lumen");
    expect(rowsInDom().filter((r) => r.dataset["key"] === moved.id)).toHaveLength(1);
    act(() => {
      container.querySelector<HTMLElement>("#outside")?.focus();
    });
    expect(groupOf(moved.id)).toBe("Home");
  });

  test("the last row of a view stays while it holds focus; the empty line follows when focus leaves", () => {
    const tasks = [task(1)];
    mount(
      <>
        <button type="button" id="outside" />
        <TaskList view="open" filter={OPEN} empty="Nothing open." />
      </>,
    );
    apply(snapshot(tasks));
    const title = titleOf(tasks[0]?.id ?? "");
    act(() => {
      title?.focus();
    });
    apply(batch([{ ...task(1), status: "waiting", version: 2 }], ["status"], "agent"));
    expect(document.activeElement).toBe(title);
    expect(container.textContent).not.toContain("Nothing open.");
    act(() => {
      container.querySelector<HTMLElement>("#outside")?.focus();
    });
    expect(rowsInDom()).toHaveLength(0);
    expect(container.textContent).toContain("Nothing open.");
  });

  test("a held row stays the current row: it keeps the tab order and the keys move from it", () => {
    const tasks = [task(1), task(2), task(3), task(4)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    act(() => {
      titleOf(tasks[2]?.id ?? "")?.focus();
    });
    apply(batch([{ ...task(3), status: "waiting", version: 2 }], ["status"], "agent"));
    expect(focused()).toBe(tasks[2]?.id);
    // Only the held, focused row's title is in the tab order.
    const tabbable = [...container.querySelectorAll<HTMLElement>('[data-part="title"]')]
      .filter((b) => b.tabIndex === 0)
      .map((b) => b.closest<HTMLElement>("li")?.dataset["key"]);
    expect(tabbable).toEqual([tasks[2]?.id]);
    // j moves on from the held row, not from the top of the list.
    press("j");
    expect(focused()).toBe(tasks[3]?.id);
  });
});
