// @vitest-environment happy-dom
//
// The expanded task's state in a view (A5 3.3, 3.7, 3.15), with the real live store, rendered by
// React into a DOM (happy-dom): the URL's task and the person's own choice, the injected row of a
// task the view does not hold, the title editor's base, focus when the card closes, the detail
// read again after a fresh snapshot, and a thread entry that keeps focus while entries arrive.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "../store/rows.ts";
import { Thread } from "../task/Thread.tsx";
import type { DetailLog } from "../task/detail.ts";
import { TaskList } from "./TaskList.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };

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

/** The digest `task.get` gives of a task, completed unless said otherwise. */
function digest(n: number, fields: Record<string, unknown> = {}) {
  return {
    view: "digest",
    as_of: "1.10.01234567",
    task: {
      id: `t_${String(n).padStart(5, "0")}`,
      ref: `M-${String(n)}`,
      title: `Task ${String(n)}`,
      summary: "",
      status: "open",
      inbox: false,
      lifecycle: "completed",
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
      version: 3,
      ...fields,
    },
  };
}

function snapshot(tasks: readonly TaskRow[], seq = CURSOR.seq): SnapshotMessage {
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

function batch(seq: number, rows: readonly TaskRow[], changed: readonly string[]): BatchMessage {
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

interface GetInput {
  readonly task?: string;
  readonly sections?: readonly string[];
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;
const updates: Record<string, unknown>[] = [];
/** What `task.get` answers; by default a not_found for an unknown task, sections empty. */
let answer: (input: GetInput) => Promise<unknown>;
const gets: GetInput[] = [];

const notFound = () => Object.assign(new Error("not found"), { code: "not_found" });

beforeEach(() => {
  updates.length = 0;
  gets.length = 0;
  answer = (input) =>
    input.sections === undefined
      ? Promise.reject(notFound())
      : Promise.resolve({ view: "sections", as_of: "1.10.01234567", sections: {} });
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
        update: (input: Record<string, unknown>) => {
          updates.push(input);
          return new Promise(() => undefined);
        },
        get: (input: GetInput) => {
          gets.push(input);
          return answer(input);
        },
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

/** Lets the promises that are due settle, inside React's act. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });

const titleOf = (id: string) =>
  container.querySelector<HTMLElement>(`li[data-key="${id}"] [data-part="title"]`);
const expandedOf = (id: string) => titleOf(id)?.getAttribute("aria-expanded");
const keys = () =>
  [...container.querySelectorAll<HTMLElement>("li[data-key]")].map((li) => li.dataset["key"]);

const press = (target: Element | null | undefined, key: string) => {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

const OPEN = (t: TaskRow) => t.lifecycle === "active";

describe("[A5.3.15.web.expanded-state] the expanded task's state holds against the URL, the feed and focus", () => {
  test("a lookup of the URL's task that answers after the person chose another row changes nothing", async () => {
    let fail: (error: unknown) => void = () => undefined;
    answer = (input) =>
      input.task === "M-999" && input.sections === undefined
        ? new Promise((_, reject) => {
            fail = reject;
          })
        : Promise.resolve({ view: "sections", as_of: "1.10.01234567", sections: {} });
    const onExpand = vi.fn<(task: TaskRow | undefined, gone?: boolean) => void>();
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" expand="M-999" onExpand={onExpand} />);
    apply(snapshot(tasks));
    expect(gets.some((g) => g.task === "M-999")).toBe(true);
    // The person expands a row while the lookup is on its way; the URL has not caught up yet.
    act(() => {
      titleOf(tasks[0]?.id ?? "")?.click();
    });
    expect(expandedOf(tasks[0]?.id ?? "")).toBe("true");
    // A frame in between renders with the old URL: it does not undo the click or ask again.
    apply(batch(11, [{ ...task(2), title: "Task 2, renamed", version: 2 }], ["title"]));
    expect(expandedOf(tasks[0]?.id ?? "")).toBe("true");
    expect(gets.filter((g) => g.task === "M-999" && g.sections === undefined)).toHaveLength(1);
    // The outdated lookup fails: no toast's URL change, and the chosen row stays expanded.
    fail(notFound());
    await settle();
    expect(onExpand.mock.calls.filter(([, gone]) => gone === true)).toEqual([]);
    expect(expandedOf(tasks[0]?.id ?? "")).toBe("true");
  });

  test("the injected row of a task the view does not hold leaves when another task expands", async () => {
    answer = (input) =>
      input.sections === undefined
        ? Promise.resolve(digest(50))
        : Promise.resolve({ view: "sections", as_of: "1.10.01234567", sections: {} });
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" expand="M-50" onExpand={() => undefined} />);
    apply(snapshot(tasks));
    await settle();
    const injected = "t_00050";
    expect(keys()).toContain(injected);
    expect(expandedOf(injected)).toBe("true");
    act(() => {
      titleOf(tasks[1]?.id ?? "")?.click();
    });
    expect(expandedOf(tasks[1]?.id ?? "")).toBe("true");
    expect(keys()).not.toContain(injected);
  });

  test("the injected row's title shows that the digest cut it", async () => {
    const long = "Long title ".repeat(30).trim();
    answer = (input) =>
      input.sections === undefined
        ? Promise.resolve(digest(51, { title: long.slice(0, 200), cut: { title: 129 } }))
        : Promise.resolve({ view: "sections", as_of: "1.10.01234567", sections: {} });
    mount(<TaskList view="open" filter={OPEN} empty="" expand="M-51" onExpand={() => undefined} />);
    apply(snapshot([task(1)]));
    await settle();
    expect(titleOf("t_00051")?.textContent).toBe(`${long.slice(0, 200)}…`);
  });

  test("a fresh snapshot reads the detail of an expanded task the working set does not hold again", async () => {
    answer = (input) =>
      input.sections === undefined
        ? Promise.resolve(digest(52))
        : Promise.resolve({ view: "sections", as_of: "1.10.01234567", sections: {} });
    mount(<TaskList view="open" filter={OPEN} empty="" expand="M-52" onExpand={() => undefined} />);
    apply(snapshot([task(1)]));
    await settle();
    const sectionReads = () =>
      gets.filter((g) => g.task === "t_00052" && g.sections !== undefined).length;
    const before = sectionReads();
    expect(before).toBeGreaterThan(0);
    apply(snapshot([task(1)], 20));
    await settle();
    expect(sectionReads()).toBe(before + 1);
  });

  test("the title editor saves against what the row showed when it opened", () => {
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const id = tasks[0]?.id ?? "";
    act(() => {
      titleOf(id)?.focus();
    });
    press(titleOf(id), "F2");
    const field = container.querySelector<HTMLInputElement>(
      `li[data-key="${id}"] [data-part="title-edit"]`,
    );
    expect(field).not.toBeNull();
    // An agent changes another task meanwhile: the store's cursor moves on.
    apply(batch(11, [{ ...task(2), title: "Task 2, renamed", version: 2 }], ["title"]));
    expect(live.store.asOf).toBe("1.11.01234567");
    act(() => {
      if (field !== null) field.value = "Task 1, fixed";
    });
    press(field, "Enter");
    expect(updates).toEqual([
      expect.objectContaining({ task: id, set: { title: "Task 1, fixed" }, base: "1.10.01234567" }),
    ]);
  });

  test("Collapse puts focus on the title, as Escape does", () => {
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const id = tasks[1]?.id ?? "";
    act(() => {
      titleOf(id)?.focus();
      titleOf(id)?.click();
    });
    const collapse = container.querySelector<HTMLElement>(
      `li[data-key="${id}"] [data-part="collapse"]`,
    );
    act(() => {
      collapse?.focus();
      collapse?.click();
    });
    expect(expandedOf(id)).toBe("false");
    expect(document.activeElement).toBe(titleOf(id));
  });
});

describe("[A5.3.11.web.edits] what the person types in an editor is never dropped", () => {
  const type = (field: HTMLInputElement | null, value: string) => {
    act(() => {
      if (field === null) return;
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const waitingField = (id: string) =>
    container.querySelector<HTMLInputElement>(`li[data-key="${id}"] [data-part="waiting-on"]`);
  const expand = (id: string) => {
    act(() => {
      titleOf(id)?.focus();
      titleOf(id)?.click();
    });
  };
  const waitingSets = () =>
    updates.filter((u) => (u["set"] as Record<string, unknown> | undefined)?.["waiting_on"]);

  test("who it waits on: typing again after Enter is saved again", async () => {
    // The service answers, so the second edit of the task goes out after the first.
    (api.client.task as { update: unknown }).update = (input: Record<string, unknown>) => {
      updates.push(input);
      return Promise.resolve({ result: "updated", as_of: "1.10.01234567", warnings: [] });
    };
    const tasks = [task(1, { status: "waiting" }), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    expand("t_00001");
    const field = waitingField("t_00001");
    expect(field).not.toBeNull();
    act(() => {
      field?.focus();
    });
    type(field, "First");
    press(field, "Enter");
    await settle();
    type(field, "Second");
    press(field, "Enter");
    await settle();
    expect(waitingSets().map((u) => (u["set"] as Record<string, unknown>)["waiting_on"])).toEqual([
      "First",
      "Second",
    ]);
  });

  test("who it waits on stays, with what was typed, when someone else moves the task out of Waiting", () => {
    const tasks = [task(1, { status: "waiting" }), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    expand("t_00001");
    const field = waitingField("t_00001");
    act(() => {
      field?.focus();
    });
    type(field, "Ana Reyes");
    apply(batch(11, [task(1, { status: "open", version: 2 })], ["status"]));
    // The field is still there, with the person's text, until they leave it.
    expect(waitingField("t_00001")).toBe(field);
    expect(field?.value).toBe("Ana Reyes");
    expect(waitingSets()).toHaveLength(0);
    press(field, "Enter");
    expect(waitingSets()).toEqual([
      expect.objectContaining({ set: { waiting_on: "Ana Reyes" }, base: "1.10.01234567" }),
    ]);
  });

  test("a title being typed is saved when the view changes under the person", () => {
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const id = "t_00001";
    act(() => {
      titleOf(id)?.focus();
    });
    press(titleOf(id), "F2");
    const field = container.querySelector<HTMLInputElement>(
      `li[data-key="${id}"] [data-part="title-edit"]`,
    );
    type(field, "Task 1, fixed");
    expect(updates).toHaveLength(0);
    // Another view replaces this one (a link, the back button): the editor goes away.
    mount(<div />);
    expect(keys()).not.toContain(id);
    expect(updates).toEqual([
      expect.objectContaining({ task: id, set: { title: "Task 1, fixed" }, base: "1.10.01234567" }),
    ]);
  });
});

describe("[A5.3.15.web.expanded-state] a thread entry keeps focus while entries arrive", () => {
  const entry = (n: number): DetailLog => ({
    kind: "log",
    ref: `l${String(n)}`,
    author: "agent:Codex",
    at: new Date(Date.UTC(2026, 10, 1, 9, n)).toISOString(),
    text: `Entry ${String(n)}`,
    logKind: "progress",
  });
  const thread = (count: number) => (
    <Thread
      notes={[]}
      log={Array.from({ length: count }, (_, i) => entry(i + 1))}
      receipts={[]}
      instances={[]}
      partial={false}
    />
  );

  test("the focused entry is not pushed out of the last six; it goes once focus leaves", () => {
    mount(thread(6));
    const firstCopy = () =>
      container.querySelector<HTMLElement>('[data-entry-key="l:l1"] button') ?? undefined;
    const button = firstCopy();
    expect(button).toBeDefined();
    act(() => {
      button?.focus();
    });
    mount(thread(7));
    expect(firstCopy()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(container.querySelectorAll("[data-entry]")).toHaveLength(7);
    act(() => {
      button?.blur();
    });
    expect(firstCopy()).toBeUndefined();
    expect(container.querySelectorAll("[data-entry]")).toHaveLength(6);
  });
});
