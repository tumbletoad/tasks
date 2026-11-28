// @vitest-environment happy-dom
//
// A task's brief and description in its card, with the real live store and edits, rendered by
// React into a DOM (happy-dom): named so, added where there is none, corrected, emptied with Undo,
// previewed as Markdown, kept as not saved when refused, and only read on a finished task. The
// client answers `task.update` as each test says. Fixture text only.
import { areaNode, nodesOf } from "@ttasks/client/test/nodes";
import type { BatchMessage, SnapshotMessage, TaskRow } from "@ttasks/client/store";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import type { Toast } from "../edit/edits.ts";
import { editsOf } from "../edit/useEdits.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import { TaskList } from "./TaskList.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };
const AS_OF = "1.10.01234567";
const WROTE = "1.11.01234567";

interface Texts {
  readonly summary?: string;
  readonly context?: string;
  readonly lifecycle?: TaskRow["lifecycle"];
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;
let texts: Texts;
const updates: Record<string, unknown>[] = [];
const undos: Record<string, unknown>[] = [];
const toasts: Toast[] = [];
/** How the service answers the next `task.update`. */
let reply: () => Promise<unknown>;

function row(): TaskRow {
  return {
    id: "t_00001",
    ref: "M-1",
    title: "Renew the library card",
    status: "open",
    inbox: false,
    lifecycle: texts.lifecycle ?? "active",
    parent: "a_1",
    position: "p00001",
    created_at: Date.UTC(2026, 10, 1),
    version: 1,
    ...(texts.summary === undefined ? {} : { summary: texts.summary }),
  };
}

function snapshot(): SnapshotMessage {
  return {
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks: [row()],
    nodes: nodesOf(SPACE.id, areaNode({ id: "a_1", title: "Lumen", position: "a" }, SPACE.id)),
    instances: [],
  };
}

/** The feed brings the person's write of `fields`: its commit, and the row as it is after it. */
function feed(request: unknown, after: TaskRow, fields: readonly string[]) {
  const message: BatchMessage = {
    type: "batch",
    space_id: SPACE.id,
    epoch: CURSOR.epoch,
    incarnation: CURSOR.incarnation,
    from: CURSOR.seq,
    through: CURSOR.seq + 1,
    events: [
      {
        seq: CURSOR.seq + 1,
        op_id: `op_${"11".padStart(26, "0")}`,
        request_id: String(request),
        actor: { kind: "human", label: "Mira" },
        kind: "task.update",
        entities: [
          {
            type: "task",
            id: after.id,
            row: after as unknown as Record<string, unknown>,
            changed: fields,
            created: false,
          },
        ],
      },
    ],
  };
  act(() => {
    live.store.push(message);
    live.store.flush();
  });
}

function read(input: { sections?: unknown }): Promise<unknown> {
  const context = texts.context ?? "";
  if (input.sections !== undefined) {
    return Promise.resolve({
      view: "sections",
      as_of: AS_OF,
      sections: { context, notes: [], log: [], sources: [] },
    });
  }
  return Promise.resolve({
    view: "digest",
    as_of: AS_OF,
    task: {
      ...row(),
      summary: texts.summary ?? "",
      priority: 4,
      focus: false,
      area: "Lumen",
      context,
      learnings: [],
      instructions: [],
      notes: [],
      log: [],
      sources: [],
      more: { instructions: 0, notes: 0, log: 0, sources: 0, learnings: 0 },
      version: 3,
    },
  });
}

function mount() {
  root = createRoot(container);
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>
          <TaskList
            view="open"
            filter={() => true}
            empty=""
            expand="M-1"
            onExpand={() => undefined}
          />
        </Session.Provider>
      </I18n>,
    );
  });
  act(() => {
    live.store.push(snapshot());
    live.store.flush();
  });
}

beforeEach(() => {
  texts = {};
  updates.length = 0;
  undos.length = 0;
  toasts.length = 0;
  localStorage.clear();
  reply = () => Promise.resolve({ as_of: WROTE, result: "updated" });
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
          return reply();
        },
        get: read,
      },
      history: {
        undo: (input: Record<string, unknown>) => {
          undos.push(input);
          return Promise.resolve({ result: "undone", as_of: "1.12.01234567", tasks: [] });
        },
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
  editsOf(live, api).onToast((toast) => {
    if (toast !== undefined) toasts.push(toast);
  });
  container = document.createElement("div");
  document.body.append(container);
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

/** The card, opened, with its detail read. */
async function card(given: Texts): Promise<void> {
  texts = given;
  mount();
  await settle();
  await settle();
}

const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  );
const box = () => container.querySelector<HTMLTextAreaElement>('[data-part="text-edit"]');

const press = (target: Element | null | undefined, key: string, mods: KeyboardEventInit = {}) => {
  act(() => {
    target?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
};
const click = (target: HTMLElement | null | undefined) => {
  act(() => {
    target?.click();
  });
};
const type = (words: string) => {
  const field = box();
  act(() => {
    if (field === null) return;
    field.value = words;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const toastText = (toast: Toast | undefined) => toast?.text;

describe("[A5.text.add.web.card] a task's brief and description in its card", () => {
  test("the two texts are named Brief and Description, by their pens and their boxes", async () => {
    await card({ summary: "Bring the old card", context: "At the **Main Street** branch." });
    expect($('[data-part="summary"]')?.textContent).toContain("Bring the old card");
    expect($('[data-part="context"] strong')?.textContent).toBe("Main Street");
    expect(button("Add a brief")).toBeUndefined();
    expect(button("Add a description")).toBeUndefined();
    click(button("Edit the brief"));
    expect(box()?.getAttribute("aria-label")).toBe("Brief");
    expect(box()?.value).toBe("Bring the old card");
    press(box(), "Escape");
    click(button("Edit the description"));
    expect(box()?.getAttribute("aria-label")).toBe("Description");
    expect(box()?.value).toBe("At the **Main Street** branch.");
    press(box(), "Escape");
    expect(box()).toBeNull();
    expect(updates).toEqual([]);
  });

  test("a task with neither text has Add a brief and Add a description where each would stand; each opens an empty box and saves what is typed", async () => {
    await card({});
    const line = $('[data-part="summary"]');
    expect(line?.querySelector('[data-part="add-summary"]')?.textContent).toBe("Add a brief");
    expect($('[data-part="expanded"] [data-part="add-context"]')?.textContent).toBe(
      "Add a description",
    );

    click(button("Add a brief"));
    expect(document.activeElement).toBe(box());
    expect(box()?.value).toBe("");
    type("Bring the old card");
    press(box(), "Enter");
    await settle();
    expect(updates[0]).toMatchObject({ task: "M-1", set: { summary: "Bring the old card" } });
    expect(toastText(toasts.at(-1))).toEqual({ id: "toast.summary", values: { ref: "M-1" } });
    expect($('[data-part="summary"]')?.textContent).toContain("Bring the old card");
    expect(button("Add a brief")).toBeUndefined();

    // In the description Enter is a new line: Ctrl+Enter saves.
    click(button("Add a description"));
    expect(box()?.getAttribute("aria-label")).toBe("Description");
    type("At the branch\n- open until 6");
    press(box(), "Enter");
    expect(updates).toHaveLength(1);
    press(box(), "Enter", { ctrlKey: true });
    await settle();
    expect(updates[1]).toMatchObject({
      task: "M-1",
      context: { mode: "replace", text: "At the branch\n- open until 6" },
    });
    expect($('[data-part="context"] li')?.textContent).toBe("open until 6");
    expect(button("Add a description")).toBeUndefined();
  });

  test("emptying a text takes it away, the brief cleared, and the toast's Undo takes that back", async () => {
    await card({ summary: "Bring the old card", context: "At the branch." });
    click(button("Edit the brief"));
    type("   ");
    press(box(), "Enter");
    await settle();
    expect(updates[0]).toMatchObject({ task: "M-1", clear: ["summary"] });
    expect(updates[0]).not.toHaveProperty("set");
    expect(button("Add a brief")).toBeDefined();
    texts = { context: "At the branch." };
    feed(updates[0]?.["request_id"], { ...row(), version: 2 }, ["summary"]);
    expect(button("Add a brief")).toBeDefined();
    const toast = toasts.at(-1);
    expect(toastText(toast)).toEqual({ id: "toast.summary", values: { ref: "M-1" } });
    act(() => {
      toast?.action?.run();
    });
    await settle();
    expect(undos).toEqual([expect.objectContaining({ commit: `op_${"11".padStart(26, "0")}` })]);

    click(button("Edit the description"));
    type("");
    press(box(), "Enter", { ctrlKey: true });
    await settle();
    expect(updates[1]).toMatchObject({ context: { mode: "replace", text: "" } });
    expect($('[data-part="context"]')).toBeNull();
    expect(button("Add a description")).toBeDefined();
    expect(toasts.at(-1)?.action).toBeDefined();
  });

  test("Preview shows the typed words as Markdown in the box's place; Ctrl+Enter there saves, and back to the words keeps them", async () => {
    await card({ summary: "Bring the old card", context: "At the branch." });
    click(button("Edit the description"));
    type("At the **Main Street** branch.");
    const preview = button("Preview");
    click(preview);
    expect(preview?.getAttribute("aria-pressed")).toBe("true");
    expect($('[data-part="text-preview"] strong')?.textContent).toBe("Main Street");
    expect(box()?.hidden).toBe(true);
    // Back to the words: they are as typed, and take the focus.
    click(preview);
    expect($('[data-part="text-preview"]')).toBeNull();
    expect(box()?.hidden).toBe(false);
    expect(box()?.value).toBe("At the **Main Street** branch.");
    expect(document.activeElement).toBe(box());
    click(preview);
    press(preview, "Enter", { ctrlKey: true });
    await settle();
    expect(updates).toEqual([
      expect.objectContaining({
        context: { mode: "replace", text: "At the **Main Street** branch." },
      }),
    ]);
    expect(box()).toBeNull();
  });

  test("Escape in the Preview lets the words go and sends nothing", async () => {
    await card({ context: "At the branch." });
    click(button("Edit the description"));
    type("At the other branch.");
    const preview = button("Preview");
    click(preview);
    press(preview, "Escape");
    await settle();
    expect(box()).toBeNull();
    expect(updates).toEqual([]);
    expect($('[data-part="context"]')?.textContent).toContain("At the branch.");
  });

  test("a refused save keeps the words under the text as not saved, also after a reload", async () => {
    reply = () =>
      Promise.reject(
        Object.assign(new Error("Someone changed this task meanwhile"), { code: "conflict" }),
      );
    await card({});
    click(button("Add a description"));
    type("At the branch.");
    press(box(), "Enter", { ctrlKey: true });
    await settle();
    await settle();
    expect(box()).toBeNull();
    const kept = () => $('[data-part="not-saved-value"]')?.textContent;
    expect(kept()).toBe("At the branch.");
    expect(updates).toHaveLength(1);
    act(() => {
      root.unmount();
    });
    mount();
    await settle();
    await settle();
    expect(kept()).toBe("At the branch.");
    expect(button("Add a description")).toBeDefined();
    expect(updates).toHaveLength(1);
  });

  test("a finished task's card shows its texts with no pen and no Add: the service refuses their change", async () => {
    await card({ lifecycle: "completed", context: "At the **Main Street** branch." });
    expect($('[data-part="context"] strong')?.textContent).toBe("Main Street");
    expect(button("Edit the description")).toBeUndefined();
    expect(button("Edit the brief")).toBeUndefined();
    expect(button("Add a brief")).toBeUndefined();
    expect(button("Add a description")).toBeUndefined();
  });
});
