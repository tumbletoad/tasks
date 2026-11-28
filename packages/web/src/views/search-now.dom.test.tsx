// @vitest-environment happy-dom
//
// A search result's controls change the task as the result shows it: the Search page with the real
// live store and the page's own edits, rendered by React into a DOM (happy-dom) against a fake
// service. A result is sent with the base of the read that showed it, and once a read after a
// reconnect says how the task is now, the result shows that, in its place, with the controls that
// fit it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "@ttasks/client/store";
import { FakeFrames } from "../../test/fake-frames.ts";
import { SearchPage } from "./Search.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };
/** The `as_of` of the space at `seq`. */
const at = (seq: number) => `1.${String(seq)}.01234567`;

const id = (n: number) => `t_${String(n).padStart(5, "0")}`;

function live1(n: number, fields: Partial<TaskRow> = {}): TaskRow {
  return {
    id: id(n),
    ref: `M-${String(n)}`,
    title: `Task ${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    area_id: "a_1",
    position: `p${String(n).padStart(5, "0")}`,
    created_at: Date.UTC(2026, 10, 1),
    version: 4,
    ...fields,
  };
}

/** A search's row of task `n`. */
function found(n: number, fields: Record<string, unknown> = {}) {
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
    ...fields,
  };
}

/** The digest `task.get` gives of task `n`. */
function digest(n: number, fields: Record<string, unknown>) {
  return {
    view: "digest",
    as_of: at(20),
    task: {
      id: id(n),
      ref: `M-${String(n)}`,
      title: `Task ${String(n)}`,
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
      more: { instructions: 0, notes: 0, log: 0, sources: 0, learnings: 0 },
      version: 3,
      ...fields,
    },
  };
}

function snapshot(tasks: readonly TaskRow[], seq: number): SnapshotMessage {
  return {
    type: "snapshot",
    space: SPACE,
    cursor: { ...CURSOR, seq },
    tasks,
    areas: [{ id: "a_1", title: "Lumen", position: "a" }],
    projects: [],
    instances: [],
  };
}

/** A change by an agent to `row`, at `seq`. */
function batch(seq: number, row: TaskRow): BatchMessage {
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
        entities: [
          {
            type: "task",
            id: row.id,
            row: row as unknown as Record<string, unknown>,
            changed: ["title"],
            created: false,
          },
        ],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;
/** What the two searches find: the open tasks, the finished ones. */
let results: { open: unknown[]; finished: unknown[] };
/** What `task.get` of a task's digest answers. */
let answer: () => Promise<unknown>;
const writes: { name: string; input: Record<string, unknown> }[] = [];

beforeEach(() => {
  writes.length = 0;
  results = { open: [], finished: [] };
  answer = () => new Promise(() => undefined);
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
  const write = (name: string) => (input: Record<string, unknown>) => {
    writes.push({ name, input });
    return new Promise(() => undefined);
  };
  api = {
    client: {
      task: {
        search: (input: { scope?: string }) =>
          Promise.resolve({
            as_of: at(10),
            scope: input.scope,
            parsed: "fence",
            total: 1,
            first: 1,
            rows: input.scope === "finished" ? results.finished : results.open,
          }),
        get: (input: { sections?: unknown }) =>
          input.sections === undefined
            ? answer()
            : Promise.resolve({ view: "sections", as_of: at(20), sections: {} }),
        update: write("task.update"),
        reopen: write("task.reopen"),
        finish: write("task.finish"),
        delete: write("task.delete"),
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
  vi.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

function apply(message: SnapshotMessage | BatchMessage) {
  act(() => {
    live.store.push(message);
    live.store.flush();
  });
}

async function mount(tasks: readonly TaskRow[]) {
  apply(snapshot(tasks, 10));
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>
          <SearchPage q="fence" onExpand={() => undefined} />
        </Session.Provider>
      </I18n>,
    );
  });
  await settle();
}

const row = (n: number) => container.querySelector<HTMLElement>(`li[data-key="${id(n)}"]`);
/** A part of the row the person sees: one in a hidden card's body is not there for them. */
function part(n: number, name: string): HTMLElement | null {
  const found = row(n)?.querySelector<HTMLElement>(`[data-part="${name}"]`) ?? null;
  return found?.closest("[hidden]") === null ? found : null;
}

async function expand(n: number) {
  act(() => {
    part(n, "title")?.click();
  });
  await settle();
}

describe("[A5.3.13.web.search-now] a search result's controls change the task as the result shows it", () => {
  test("Reopen on a finished result goes with the base of the read that showed it, not the screen's now", async () => {
    results.finished = [found(1, { lifecycle: "completed", completed: "2026-11-10" })];
    await mount([live1(2)]);
    // The feed moves on with other tasks' changes: the result says nothing newer of its task.
    apply(batch(11, live1(2, { title: "Task 2, renamed", version: 11 })));
    apply(batch(12, live1(2, { title: "Task 2, again", version: 12 })));
    await expand(1);
    act(() => {
      part(1, "reopen")?.click();
    });
    await settle();
    expect(writes.map((w) => [w.name, w.input["base"]])).toEqual([["task.reopen", at(10)]]);
  });

  test("a finished result someone else dropped while the tab was away shows Dropped once a read says so, and Reopen goes with that read's version", async () => {
    results.finished = [found(1, { lifecycle: "completed", completed: "2026-11-10" })];
    await mount([live1(2)]);
    await expand(1);
    expect(part(1, "lifecycle")?.textContent).toBe("Checked off");
    // Away: someone reopened it and dropped it at 18. The snapshot after it never held it.
    let read: (value: unknown) => void = () => undefined;
    answer = () =>
      new Promise((resolve) => {
        read = resolve;
      });
    apply(snapshot([live1(2)], 20));
    await settle();
    // Until the read answers, the card says the task is being read again and offers nothing.
    expect(part(1, "reopen")).toBeNull();
    expect(part(1, "unresolved")).not.toBeNull();
    read(digest(1, { lifecycle: "archived", completed: "2026-11-20", version: 18 }));
    await settle();
    expect(part(1, "lifecycle")?.textContent).toBe("Dropped");
    act(() => {
      part(1, "reopen")?.click();
    });
    await settle();
    expect(writes.map((w) => [w.name, w.input["base"]])).toEqual([["task.reopen", at(18)]]);
  });

  test("the result keeps what the read said once its card closes", async () => {
    results.finished = [found(1, { lifecycle: "completed", completed: "2026-11-10" })];
    await mount([live1(2)]);
    await expand(1);
    answer = () =>
      Promise.resolve(digest(1, { lifecycle: "archived", completed: "2026-11-20", version: 18 }));
    apply(snapshot([live1(2)], 20));
    await settle();
    await expand(1);
    expect(row(1)?.getAttribute("data-expanded")).toBe("false");
    expect(part(1, "check")?.getAttribute("data-dropped")).toBe("true");
    // Still under Completed, where the person found it.
    expect(container.textContent).toContain("Task 1");
  });

  test("an open result finished elsewhere while the tab was away loses its star once a read says so, in its place", async () => {
    results.open = [found(1), found(3)];
    await mount([live1(1), live1(3)]);
    await expand(1);
    expect(part(1, "star")?.getAttribute("aria-disabled")).toBeNull();
    answer = () =>
      Promise.resolve(digest(1, { lifecycle: "completed", completed: "2026-11-20", version: 15 }));
    apply(snapshot([live1(3)], 20));
    await settle();
    expect(part(1, "star")?.getAttribute("aria-disabled")).toBe("true");
    expect(part(1, "reopen")).not.toBeNull();
    expect(
      [...container.querySelectorAll("li[data-key]")].map((li) => li.getAttribute("data-key")),
    ).toEqual([id(1), id(3)]);
  });
});
