// @vitest-environment happy-dom
//
// The expanded task's state in a view (A5 3.3, 3.7, 3.15), with the real live store, rendered by
// React into a DOM (happy-dom): the URL's task and the person's own choice, the injected row of a
// task the view does not hold, the title editor's base, focus when the card closes, the detail
// read again after a fresh snapshot, and a thread entry that keeps focus while entries arrive.
import { PRODUCT_ID } from "@ttasks/brand";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "../store/rows.ts";
import { Thread } from "../task/Thread.tsx";
import { keepTitleDraft, readTitleDraft, unsavedKeeper } from "../unsent.ts";
import { priorityChange, waitingChange } from "../edit/change.ts";
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
      more: { instructions: 0, notes: 0, log: 0, sources: 0, learnings: 0 },
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
    // Each read of the detail reads the task's notes once: they fit one page.
    const sectionReads = () =>
      gets.filter((g) => g.task === "t_00052" && g.sections?.includes("notes") === true).length;
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

  test("a fresh snapshot without the expanded active task shows it as it is now: finished elsewhere, without a star to press, with Reopen", async () => {
    answer = (input) =>
      input.sections === undefined
        ? Promise.resolve(digest(1, { version: 15 }))
        : Promise.resolve({ view: "sections", as_of: "1.20.01234567", sections: {} });
    mount(<TaskList view="open" filter={OPEN} empty="" onExpand={() => undefined} />);
    apply(snapshot([task(1), task(2)]));
    act(() => {
      titleOf("t_00001")?.click();
    });
    await settle();
    const card = () => container.querySelector<HTMLElement>(`li[data-key="t_00001"]`);
    const star = () => card()?.querySelector<HTMLElement>('[data-part="star"]');
    expect(star()?.getAttribute("aria-disabled")).toBeNull();
    // Completed elsewhere while the tab heard nothing: the snapshot after it leaves the task out.
    apply(snapshot([task(2)], 20));
    await settle();
    expect(expandedOf("t_00001")).toBe("true");
    expect(star()?.getAttribute("aria-disabled")).toBe("true");
    expect(card()?.querySelector<HTMLInputElement>('[data-part="check"]')?.checked).toBe(true);
    expect(card()?.querySelector('[data-part="reopen"]')).not.toBeNull();
    expect(card()?.querySelector('[data-part="status"]')).toBeNull();
  });

  test("a fresh snapshot without the expanded task, which no longer exists, closes its card and drops it from the URL", async () => {
    const onExpand = vi.fn<(task: TaskRow | undefined, gone?: boolean) => void>();
    mount(<TaskList view="open" filter={OPEN} empty="" onExpand={onExpand} />);
    apply(snapshot([task(1), task(2)]));
    act(() => {
      titleOf("t_00001")?.click();
    });
    await settle();
    apply(snapshot([task(2)], 20));
    await settle();
    expect(keys()).toEqual(["t_00002"]);
    expect(onExpand).toHaveBeenLastCalledWith(undefined, true);
  });

  test("while the expanded task a fresh snapshot left out is read again, its card says so and offers nothing; a failed read is tried again with the minute's read", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const digests: ((error: unknown) => void)[] = [];
      answer = (input) =>
        input.sections === undefined
          ? new Promise((_, reject) => {
              digests.push(reject);
            })
          : Promise.resolve({ view: "sections", as_of: "1.20.01234567", sections: {} });
      mount(<TaskList view="open" filter={OPEN} empty="" onExpand={() => undefined} />);
      apply(snapshot([task(1), task(2)]));
      act(() => {
        titleOf("t_00001")?.click();
      });
      await settle();
      const card = () => container.querySelector<HTMLElement>(`li[data-key="t_00001"]`);
      // What the card shows: a part of a hidden card's body is not there for the person.
      const part = (name: string) => {
        const found = card()?.querySelector<HTMLElement>(`[data-part="${name}"]`) ?? undefined;
        return found?.closest("[hidden]") === null ? found : undefined;
      };
      const asked = digests.length;
      apply(snapshot([task(2)], 20));
      await settle();
      // Every read of the task since the snapshot, the card's detail's among them.
      const fail = (error: unknown) => {
        for (const reject of digests.slice(asked)) reject(error);
      };
      const offers = () => ({
        unresolved: part("unresolved")?.textContent ?? null,
        star: part("star")?.getAttribute("aria-disabled") ?? null,
        check: part("check")?.hasAttribute("disabled") ?? null,
        trash: part("move-to-trash") ?? null,
        status: part("status") ?? null,
        composer: part("composer") ?? null,
      });
      expect(offers()).toMatchObject({
        unresolved: expect.stringContaining("Reading it again") as unknown,
        star: "true",
        check: true,
        trash: null,
        status: null,
        composer: null,
      });
      fail(new TypeError("Failed to fetch"));
      await settle();
      expect(offers()).toMatchObject({
        unresolved: expect.stringContaining("could not be read") as unknown,
        star: "true",
        trash: null,
      });
      // The minute's read tries again, and its answer shows the task as it is now.
      const before = gets.filter((g) => g.task === "t_00001" && g.sections === undefined).length;
      answer = (input) =>
        input.sections === undefined
          ? Promise.resolve(digest(1, { version: 15 }))
          : Promise.resolve({ view: "sections", as_of: "1.20.01234567", sections: {} });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      await settle();
      expect(gets.filter((g) => g.task === "t_00001" && g.sections === undefined)).toHaveLength(
        before + 1,
      );
      expect(part("unresolved")).toBeUndefined();
      expect(part("reopen")).not.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an answer about the expanded task that the feed outdated while it was on its way changes nothing", async () => {
    const digests: ((error: unknown) => void)[] = [];
    answer = (input) =>
      input.sections === undefined
        ? new Promise((_, reject) => {
            digests.push(reject);
          })
        : Promise.resolve({ view: "sections", as_of: "1.20.01234567", sections: {} });
    const onExpand = vi.fn<(task: TaskRow | undefined, gone?: boolean) => void>();
    mount(<TaskList view="open" filter={OPEN} empty="" onExpand={onExpand} />);
    apply(snapshot([task(1), task(2)]));
    act(() => {
      titleOf("t_00001")?.click();
    });
    await settle();
    const asked = digests.length;
    apply(snapshot([task(2)], 20));
    await settle();
    // Every read of the task since the snapshot, the card's detail's among them.
    const fail = (error: unknown) => {
      for (const reject of digests.slice(asked)) reject(error);
    };
    // The feed brings the task back, active, before the read's answer.
    apply(batch(21, [{ ...task(1), version: 21 }], ["lifecycle"]));
    await settle();
    fail(notFound());
    await settle();
    expect(expandedOf("t_00001")).toBe("true");
    expect(onExpand.mock.calls.filter(([, gone]) => gone === true)).toEqual([]);
    const card = container.querySelector<HTMLElement>(`li[data-key="t_00001"]`);
    expect(card?.querySelector('[data-part="unresolved"]')).toBeNull();
    expect(card?.querySelector('[data-part="move-to-trash"]')).not.toBeNull();
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

  test.each<readonly [string, (field: HTMLInputElement | null) => void]>([
    ["without typing", () => undefined],
    [
      "after typing back what was there",
      (field: HTMLInputElement | null) => {
        type(field, "Ana Reyes!");
        type(field, "Ana Reyes");
      },
    ],
  ])(
    "who it waits on, changed by someone else under an open field the person leaves %s: nothing is sent, ever, and the field shows the new value",
    (_, touch) => {
      const tasks = [task(1, { status: "waiting", waiting_on: "Ana Reyes" }), task(2)];
      mount(<TaskList view="open" filter={OPEN} empty="" />);
      apply(snapshot(tasks));
      expand("t_00001");
      const field = waitingField("t_00001");
      act(() => {
        field?.focus();
      });
      touch(field);
      apply(
        batch(
          11,
          [task(1, { status: "waiting", waiting_on: "Ben Ito", version: 2 })],
          ["waiting_on"],
        ),
      );
      act(() => {
        field?.blur();
      });
      expect(field?.value).toBe("Ben Ito");
      // In and out again, still without typing: Codex's value stays.
      act(() => {
        field?.focus();
      });
      act(() => {
        field?.blur();
      });
      expect(waitingSets()).toEqual([]);
      expect(field?.value).toBe("Ben Ito");
    },
  );

  test("who it waits on, typed while someone else changes it: the change shows under the field, and leaving sends the typed words against what the person saw", () => {
    const tasks = [task(1, { status: "waiting", waiting_on: "Ana Reyes" }), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    expand("t_00001");
    const field = waitingField("t_00001");
    act(() => {
      field?.focus();
    });
    type(field, "Cleo");
    apply(
      batch(
        11,
        [task(1, { status: "waiting", waiting_on: "Ben Ito", version: 2 })],
        ["waiting_on"],
      ),
    );
    expect(field?.value).toBe("Cleo");
    const card = container.querySelector('li[data-key="t_00001"]');
    expect(card?.querySelector('[data-part="remote"]')?.textContent).toContain("Codex");
    act(() => {
      field?.blur();
    });
    expect(waitingSets()).toEqual([
      expect.objectContaining({ set: { waiting_on: "Cleo" }, base: "1.10.01234567" }),
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

  test("who it waits on, typed while an agent checks the task off, stays readable with its choice", async () => {
    (api.client.task as { update: unknown }).update = (input: Record<string, unknown>) => {
      updates.push(input);
      return Promise.reject(
        Object.assign(new Error("not active"), { code: "invalid_state", data: {} }),
      );
    };
    const tasks = [task(1, { status: "waiting" }), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    expand("t_00001");
    const field = waitingField("t_00001");
    act(() => {
      field?.focus();
    });
    type(field, "Ana Reyes");
    apply(
      batch(
        11,
        [task(1, { status: "waiting", lifecycle: "completed", version: 2 })],
        ["lifecycle"],
      ),
    );
    await settle();
    const card = container.querySelector('li[data-key="t_00001"]');
    expect(card?.querySelector('[data-part="unsaved-value"]')?.textContent).toBe("Ana Reyes");
    // A finished task takes no edit: the line says why and offers Copy, never a Try again that
    // fails again.
    const line = card?.querySelector('[data-part="unsaved"]');
    expect(line?.getAttribute("data-reason")).toBe("finished");
    expect(line?.querySelector('[data-part="apply-mine"]')).toBeNull();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
    act(() => {
      line?.querySelector<HTMLButtonElement>('[data-part="copy-mine"]')?.click();
    });
    expect(copied).toEqual(["Ana Reyes"]);
    expect(updates).toHaveLength(1);
    // It waits until the person discards it: reopened, the task offers Try again.
    expect(line?.querySelector('[data-part="keep-theirs"]')).not.toBeNull();
  });

  test("a title typed while an agent checks the task off stays readable with Copy; Try again only once it is reopened", async () => {
    (api.client.task as { update: unknown }).update = (input: Record<string, unknown>) => {
      updates.push(input);
      return Promise.reject(
        Object.assign(new Error("not active"), {
          code: "wrong_tool",
          data: { cause: "TASK_NOT_ACTIVE" },
        }),
      );
    };
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const id = "t_00001";
    expand(id);
    press(titleOf(id), "F2");
    const field = container.querySelector<HTMLInputElement>(
      `li[data-key="${id}"] [data-part="title-edit"]`,
    );
    type(field, "Task 1, fixed");
    // An agent completes the task while the person types; then the person presses Enter.
    apply(batch(11, [task(1, { lifecycle: "completed", version: 2 })], ["lifecycle"]));
    press(field, "Enter");
    await settle();
    expect(updates).toHaveLength(1);
    const card = container.querySelector(`li[data-key="${id}"]`);
    const line = card?.querySelector('[data-part="unsaved"]');
    // The typed title is shown, with Copy and Discard, and no Try again that would fail again.
    expect(line?.getAttribute("data-reason")).toBe("finished");
    expect(line?.querySelector('[data-part="unsaved-value"]')?.textContent).toBe("Task 1, fixed");
    expect(line?.querySelector('[data-part="apply-mine"]')).toBeNull();
    expect(line?.querySelector('[data-part="copy-mine"]')).not.toBeNull();
    expect(line?.querySelector('[data-part="keep-theirs"]')).not.toBeNull();
    // Reopened, the title offers Try again.
    apply(batch(12, [task(1, { lifecycle: "active", version: 3 })], ["lifecycle"]));
    const again = container.querySelector(`li[data-key="${id}"] [data-part="unsaved"]`);
    expect(again?.getAttribute("data-reason")).toBe("failed");
    expect(again?.querySelector('[data-part="apply-mine"]')).not.toBeNull();
  });

  test("a title typed while the task is moved to the Trash elsewhere is sent nowhere: the words stay kept, unsent", async () => {
    (api.client.task as { update: unknown }).update = (input: Record<string, unknown>) => {
      updates.push(input);
      return new Promise(() => undefined);
    };
    localStorage.clear();
    const tasks = [task(1), task(2)];
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot(tasks));
    const id = "t_00001";
    expand(id);
    press(titleOf(id), "F2");
    type(
      container.querySelector<HTMLInputElement>(`li[data-key="${id}"] [data-part="title-edit"]`),
      "Task 1, fixed",
    );
    apply(batch(11, [task(1, { deleted_at: Date.UTC(2026, 10, 2), version: 2 })], ["deleted"]));
    await settle();
    expect(container.querySelector('[data-part="title-edit"]')).toBeNull();
    expect(updates).toEqual([]);
    const kept = Object.keys(localStorage).filter((key) => key.startsWith(`${PRODUCT_ID}.title.`));
    expect(kept.map((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as unknown)).toEqual([
      expect.objectContaining({ typed: "Task 1, fixed" }),
    ]);
  });

  test("leaving the title editor for another control keeps focus there", async () => {
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
    const other = titleOf("t_00002");
    act(() => {
      other?.focus();
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(other);
    expect(updates).toEqual([
      expect.objectContaining({ task: id, set: { title: "Task 1, fixed" } }),
    ]);
  });

  test("an edit kept from before the space was restored is not sent again: its line says why, shows the value, and offers Copy and Discard", async () => {
    // Kept by this tab before a reload, on a page of the space's earlier history: another
    // incarnation than the screen's. It is the only kept edit.
    localStorage.clear();
    unsavedKeeper(SPACE.id).save(
      new Map([
        [
          "t_00001 priority",
          {
            id: crypto.randomUUID(),
            task: "t_00001",
            ref: "M-1",
            field: "priority",
            change: priorityChange(1),
            reason: "failed",
            base: "1.10.zzzzzzzz",
          },
        ],
      ]),
    );
    try {
      mount(<TaskList view="open" filter={OPEN} empty="" />);
      apply(snapshot([task(1)]));
      expand("t_00001");
      await settle();
      const line = container.querySelector('li[data-key="t_00001"] [data-part="unsaved"]');
      expect(line?.getAttribute("data-reason")).toBe("restored");
      expect(line?.textContent).toContain("Not saved: the space was restored since");
      expect(line?.querySelector('[data-part="unsaved-value"]')?.textContent).toBe("P1");
      expect(line?.querySelector('[data-part="apply-mine"]')).toBeNull();
      expect(line?.querySelector('[data-part="copy-mine"]')).not.toBeNull();
      act(() => {
        line?.querySelector<HTMLElement>('[data-part="keep-theirs"]')?.click();
      });
      expect(Object.keys(localStorage).filter((key) => key.includes(".t_00001."))).toEqual([]);
      expect(updates).toEqual([]);
    } finally {
      localStorage.clear();
    }
  });

  describe("kept edits of who it waits on", () => {
    /** Each update waits until the test refuses it: `refuse()` the oldest one still waiting. */
    const held: ((error: Error) => void)[] = [];
    const refuse = (error: Error = Object.assign(new Error("down"), { code: "internal" })) => {
      held.shift()?.(error);
    };
    const conflict = () =>
      Object.assign(new Error("conflict"), {
        code: "conflict",
        data: {
          cause: "VERSION_CONFLICT",
          conflicts: [
            {
              task: "M-1",
              field: "waiting_on",
              value: "Ben Ito",
              version: 2,
              by: "Codex",
              at: new Date().toISOString(),
            },
          ],
        },
      });
    /** The browser's kept edits of the field: each name with its value. */
    const keptHere = () =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.includes(`.${SPACE.id}.t_00001.waiting_on`))
          .sort()
          .map((key) => [key, localStorage.getItem(key)]),
      );
    const card = () => container.querySelector('li[data-key="t_00001"]');
    const lines = () => [...(card()?.querySelectorAll('[data-part="unsaved"]') ?? [])];
    const valueOf = (line: Element | undefined) =>
      line?.querySelector('[data-part="unsaved-value"]')?.textContent;

    beforeEach(() => {
      localStorage.clear();
      held.length = 0;
      (api.client.task as { update: unknown }).update = (input: Record<string, unknown>) => {
        updates.push(input);
        return new Promise((_, reject) => held.push(reject));
      };
    });
    afterEach(() => {
      localStorage.clear();
    });

    /** The card of a waiting task, with this tab's edit of who it waits on refused. */
    const refusedHere = async (words: string) => {
      mount(<TaskList view="open" filter={OPEN} empty="" />);
      apply(snapshot([task(1, { status: "waiting", waiting_on: "Dee Park" })]));
      expand("t_00001");
      const field = waitingField("t_00001");
      act(() => {
        field?.focus();
      });
      type(field, words);
      press(field, "Enter");
      await settle();
      refuse();
      await settle();
      return field;
    };

    test("another tab's kept edits show their words, where they came from, Copy and Discard, and nothing that sends them; Try again on this tab's own leaves them as they were, while on its way and refused again", async () => {
      await refusedHere("Ana Reyes");
      // Two other tabs' refusals of the same field.
      act(() => {
        for (const [n, words] of [
          [2, "Ben Ito"],
          [3, "Cleo"],
        ] as const) {
          unsavedKeeper(SPACE.id).save(
            new Map([
              [
                "t_00001\u0000waiting_on",
                {
                  id: crypto.randomUUID(),
                  task: "t_00001",
                  ref: "M-1",
                  field: "waiting_on",
                  change: waitingChange(words),
                  reason: "failed",
                  base: `1.${String(n)}.01234567`,
                },
              ],
            ]),
          );
        }
      });
      const values = () => [valueOf(lines()[0]), ...lines().slice(1).map(valueOf).sort()];
      expect(values()).toEqual(["Ana Reyes", "Ben Ito", "Cleo"]);
      for (const line of lines().slice(1)) {
        expect(line.textContent).toContain("Typed in another tab");
        expect(line.querySelector('[data-part="copy-mine"]')).not.toBeNull();
        expect(line.querySelector('[data-part="keep-theirs"]')).not.toBeNull();
      }
      const before = keptHere();
      expect(Object.keys(before)).toHaveLength(3);
      // Every button that sends a line leaves the others' words in the browser.
      const sending = card()?.querySelectorAll<HTMLElement>('[data-part="apply-mine"]') ?? [];
      expect(sending).toHaveLength(1);
      for (const button of sending) {
        act(() => {
          button.click();
        });
        await settle();
        expect(keptHere()).toEqual(before);
      }
      // Try again sends the base the person made the edit at.
      expect(updates.at(-1)).toMatchObject({
        set: { waiting_on: "Ana Reyes" },
        base: "1.10.01234567",
      });
      // Refused again: the same kept edit, once, and the other tabs' as they were.
      refuse();
      await settle();
      expect(keptHere()).toEqual(before);
      expect(values()).toEqual(["Ana Reyes", "Ben Ito", "Cleo"]);
      // Discard on another tab's line takes only its words.
      const gone = valueOf(lines()[2]);
      act(() => {
        lines()[2]?.querySelector<HTMLElement>('[data-part="keep-theirs"]')?.click();
      });
      expect(values()).toEqual(["Ana Reyes", "Ben Ito", "Cleo"].filter((v) => v !== gone));
    });

    test("a lone kept edit of this tab, under a field that shows the saved value, shows its words with Copy; its Try again is named by the field", async () => {
      const field = await refusedHere(
        "Ana Reyes of the north office, who signs the lease for the new hall",
      );
      expect(field?.value).toBe("Dee Park");
      const [line] = lines();
      expect(valueOf(line)).toBe(
        "Ana Reyes of the north office, who signs the lease for the new hall",
      );
      expect(line?.querySelector('[data-part="copy-mine"]')).not.toBeNull();
      expect(line?.querySelector('[data-part="apply-mine"]')?.getAttribute("aria-label")).toBe(
        "Try again: who it waits on",
      );
    });

    test("typed on while the first save is on its way and an agent changes the field: the next edit's base is what the person was looking at", async () => {
      mount(<TaskList view="open" filter={OPEN} empty="" />);
      apply(snapshot([task(1, { status: "waiting", waiting_on: "Dee Park" })]));
      expand("t_00001");
      const field = waitingField("t_00001");
      act(() => {
        field?.focus();
      });
      type(field, "Ana");
      press(field, "Enter");
      await settle();
      apply(
        batch(
          11,
          [task(1, { status: "waiting", waiting_on: "Ben Ito", version: 2 })],
          ["waiting_on"],
        ),
      );
      // The field shows the person's first edit, not Codex's change behind it.
      expect(field?.value).toBe("Ana");
      type(field, "Ana Reyes");
      press(field, "Enter");
      refuse(conflict());
      await settle();
      expect(
        waitingSets().map((u) => [(u["set"] as { waiting_on: string }).waiting_on, u["base"]]),
      ).toEqual([
        ["Ana", "1.10.01234567"],
        ["Ana Reyes", "1.10.01234567"],
      ]);
    });

    test("after a change by someone else shows, typing the old value back and pressing Enter sends it against what the person began from", () => {
      mount(<TaskList view="open" filter={OPEN} empty="" />);
      apply(snapshot([task(1, { status: "waiting", waiting_on: "Ana Reyes" })]));
      expand("t_00001");
      const field = waitingField("t_00001");
      act(() => {
        field?.focus();
      });
      type(field, "Ana Reyes!");
      apply(
        batch(
          11,
          [task(1, { status: "waiting", waiting_on: "Ben Ito", version: 2 })],
          ["waiting_on"],
        ),
      );
      expect(card()?.querySelector('[data-part="remote"]')?.textContent).toContain("Codex");
      type(field, "Ana Reyes");
      press(field, "Enter");
      expect(field?.value).toBe("Ana Reyes");
      expect(waitingSets()).toEqual([
        expect.objectContaining({ set: { waiting_on: "Ana Reyes" }, base: "1.10.01234567" }),
      ]);
    });
  });

  test("a title a reload brought back whose save was on its way: when the title arrives as those words, the editor closes and lets them go", async () => {
    localStorage.clear();
    keepTitleDraft(SPACE.id, "t_00001", { typed: "Task 1, fixed", title: "Task 1" });
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot([task(1)]));
    expand("t_00001");
    await settle();
    const field = () =>
      container.querySelector<HTMLInputElement>('li[data-key="t_00001"] [data-part="title-edit"]');
    expect(field()?.value).toBe("Task 1, fixed");
    apply(batch(11, [task(1, { title: "Task 1, fixed", version: 2 })], ["title"]));
    await settle();
    expect(field()).toBeNull();
    expect(readTitleDraft(SPACE.id, "t_00001")).toBeUndefined();
    expect(updates).toEqual([]);
  });

  test("a title a reload brought back whose save lands as the card opens: the card and its editor agree, and the editor closes", async () => {
    localStorage.clear();
    keepTitleDraft(SPACE.id, "t_00001", { typed: "Task 1, fixed", title: "Task 1" });
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot([task(1)]));
    // The save's answer arrives right after the opened card has read the kept title, before
    // anything the card decided is drawn.
    const read = localStorage.getItem.bind(localStorage);
    let delivered = false;
    vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
      const opened = container.querySelector('li[data-key="t_00001"][data-expanded="true"]');
      if (!delivered && opened !== null && key.includes(".title.")) {
        delivered = true;
        live.store.push(batch(11, [task(1, { title: "Task 1, fixed", version: 2 })], ["title"]));
        live.store.flush();
      }
      return read(key);
    });
    expand("t_00001");
    await settle();
    expect(delivered).toBe(true);
    expect(container.querySelector('li[data-key="t_00001"] [data-part="title-edit"]')).toBeNull();
    expect(titleOf("t_00001")?.textContent).toContain("Task 1, fixed");
    expect(readTitleDraft(SPACE.id, "t_00001")).toBeUndefined();
    expect(updates).toEqual([]);
  });

  test("a title saved on this tab, its card closed and opened again before the answer: no editor opens, and the answer lets the words go", async () => {
    localStorage.clear();
    let answer: (value: unknown) => void = () => undefined;
    (api.client.task as { update: unknown }).update = (input: Record<string, unknown>) => {
      updates.push(input);
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot([task(1), task(2)]));
    const field = () =>
      container.querySelector<HTMLInputElement>('li[data-key="t_00001"] [data-part="title-edit"]');
    act(() => {
      titleOf("t_00001")?.focus();
    });
    press(titleOf("t_00001"), "F2");
    type(field(), "Task 1, fixed");
    press(field(), "Enter");
    expect(updates).toHaveLength(1);
    expand("t_00001");
    expect(expandedOf("t_00001")).toBe("false");
    expand("t_00001");
    await settle();
    expect(field()).toBeNull();
    expect(expandedOf("t_00001")).toBe("true");
    // The words are kept until the answer: it is what lets them go, not the card's opening.
    expect(readTitleDraft(SPACE.id, "t_00001")?.typed).toBe("Task 1, fixed");
    act(() => {
      answer({ result: "updated", as_of: "1.11.01234567", warnings: [] });
    });
    await settle();
    expect(readTitleDraft(SPACE.id, "t_00001")).toBeUndefined();
    expect(field()).toBeNull();
    expect(updates).toHaveLength(1);
  });

  test("words typed over a title a reload brought back are the ones kept and sent, also after the task was finished and reopened meanwhile", async () => {
    localStorage.clear();
    (api.client.task as { update: unknown }).update = (input: Record<string, unknown>) => {
      updates.push(input);
      return Promise.reject(
        Object.assign(new Error("not active"), {
          code: "wrong_tool",
          data: { cause: "TASK_NOT_ACTIVE" },
        }),
      );
    };
    keepTitleDraft(SPACE.id, "t_00001", { typed: "First draft", title: "Task 1" });
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot([task(1), task(2)]));
    expand("t_00001");
    await settle();
    const card = () => container.querySelector('li[data-key="t_00001"]');
    const field = () =>
      container.querySelector<HTMLInputElement>('li[data-key="t_00001"] [data-part="title-edit"]');
    expect(field()?.value).toBe("First draft");
    type(field(), "Newer words");
    // An agent finishes the task while the person types, and reopens it.
    apply(batch(11, [task(1, { lifecycle: "completed", version: 2 })], ["lifecycle"]));
    await settle();
    apply(batch(12, [task(1, { lifecycle: "active", version: 3 })], ["lifecycle"]));
    await settle();
    if (field() != null) press(field(), "Enter");
    await settle();
    const sent = updates.map((update) => (update["set"] as { title?: string }).title);
    expect(sent).not.toContain("First draft");
    expect([
      readTitleDraft(SPACE.id, "t_00001")?.typed,
      card()?.querySelector('[data-part="unsaved-value"]')?.textContent,
      ...sent,
    ]).toContain("Newer words");
  });

  test("a kept title discarded on the finished card is gone: reopened, the editor starts from the title and sends nothing", async () => {
    localStorage.clear();
    keepTitleDraft(SPACE.id, "t_00001", { typed: "First draft", title: "Task 1" });
    mount(<TaskList view="open" filter={OPEN} empty="" />);
    apply(snapshot([task(1), task(2)]));
    expand("t_00001");
    await settle();
    const card = () => container.querySelector('li[data-key="t_00001"]');
    const field = () =>
      container.querySelector<HTMLInputElement>('li[data-key="t_00001"] [data-part="title-edit"]');
    expect(field()?.value).toBe("First draft");
    apply(batch(11, [task(1, { lifecycle: "completed", version: 2 })], ["lifecycle"]));
    await settle();
    const discard = card()?.querySelector<HTMLElement>('[data-part="discard-kept-title"]');
    expect(discard).not.toBeNull();
    act(() => {
      discard?.click();
    });
    expect(readTitleDraft(SPACE.id, "t_00001")).toBeUndefined();
    apply(batch(12, [task(1, { lifecycle: "active", version: 3 })], ["lifecycle"]));
    await settle();
    expect(field()?.value ?? "Task 1").toBe("Task 1");
    if (field() != null) press(field(), "Enter");
    await settle();
    expect(updates).toEqual([]);
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
