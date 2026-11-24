// @vitest-environment happy-dom
//
// Which agent an expanded task's Open and Run use, with the real live store and the page's own
// actions, rendered by React into a DOM (happy-dom) against a fake service: one button names its
// agent (the task's last, else the space's last, else the first), and a menu beside it holds every
// agent, grouped by app, from the keyboard too.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api, Busy, Instance, LastUsed, Receipt, Run } from "../api.ts";
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

const agent = (key: string, app: string, label: string, ring: number): Instance => ({
  key,
  app,
  label,
  glyph: app.slice(0, 2),
  ring,
  route: "terminal",
  runs: true,
});

/** Three Claude Code accounts and two Codex homes, in Settings' order. */
const FIVE = [
  agent("claude", "Claude Code", "Claude Code · default", 1),
  agent("codex", "Codex", "Codex · default", 2),
  agent("claude-work", "Claude Code", "Claude Code · work", 3),
  agent("codex-personal", "Codex", "Codex · personal", 4),
  agent("claude-test", "Claude Code", "Claude Code · test", 5),
];

let container: HTMLDivElement;
let root: Root;
let live: Live;
let opened: string[];
let ran: string[];
let busyNow: Busy[];
let lastNow: LastUsed;
let receiptsNow: Receipt[];

const receipt = (instance: string): Receipt => ({
  id: `la_${instance}`,
  reference: "L7KQ21",
  instance,
  route: "terminal",
  state: "confirmed",
  reason: null,
  at: { prepared: Date.UTC(2026, 10, 1, 9) },
});

const runOf = (instance: string): Run => ({
  id: `ru_00r5mfcw5rfzxb9enb2vg50z3${String(ran.length)}`,
  instance,
  state: "queued",
  reason: null,
  queued_at: Date.UTC(2026, 10, 1, 9),
  started_at: null,
  ended_at: null,
  asked: null,
  answer: null,
  answer_final: false,
  answer_cut: false,
  version: 1,
});

beforeEach(() => {
  opened = [];
  ran = [];
  busyNow = [];
  lastNow = {};
  receiptsNow = [];
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
        get: () =>
          Promise.resolve({
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
              more: { instructions: 0, notes: 0, log: 0, sources: 0, learnings: 0 },
              version: 1,
            },
          }),
      },
    },
    busy: () => Promise.resolve({ busy: busyNow, last: lastNow }),
    receipts: () => Promise.resolve(receiptsNow),
    runs: () => Promise.resolve([]),
    openLaunch: (_task: string, instance: string) => {
      opened.push(instance);
      receiptsNow = [...receiptsNow, receipt(instance)];
      return Promise.resolve({ receipt: receipt(instance), copy: undefined });
    },
    startRun: (_task: string, instance: string) => {
      ran.push(instance);
      return Promise.resolve(runOf(instance));
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
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>
          <TaskList view="open" filter={() => true} empty="" />
        </Session.Provider>
      </I18n>,
    );
  });
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

/** The space as the service serves it, with these agents, and the task expanded. */
async function showWith(instances: readonly Instance[]) {
  act(() => {
    live.store.push({
      type: "snapshot",
      space: SPACE,
      cursor: { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 },
      tasks: [TASK],
      areas: [{ id: "a_1", title: "Lumen", position: "a" }],
      projects: [],
      instances: [...instances],
    } satisfies SnapshotMessage);
    live.store.flush();
  });
  await settle();
  if (part("open") !== null) return;
  act(() => {
    container.querySelector<HTMLElement>('[data-part="title"]')?.click();
  });
  await settle();
}

const part = (name: string) =>
  container.querySelector<HTMLButtonElement>(`[data-part="strip"] [data-part="${name}"]`);
/** What the Open button says it opens in. */
const openSays = () => part("open")?.querySelector("span > span:not([data-off])")?.textContent;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const groups = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="group"]')].map((g) =>
    g.getAttribute("aria-label"),
  );

const press = (target: Element | null, key: string) => {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target?.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
};
const click = (target: Element | null | undefined) => {
  act(() => {
    target?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    target?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
};

describe("[M6.page.open-choice] Open and Run each name one agent, with every other one in a menu beside", () => {
  test("the button names the first in Settings' order, the space's last when there is one, the task's own last above that", async () => {
    await showWith(FIVE);
    expect(openSays()).toBe("Open in Claude Code · default");
    expect(part("run")?.textContent).toContain("Run with Claude Code · default");

    lastNow = { open: "codex-personal", run: "claude-work" };
    act(() => {
      live.store.set({ phase: "offline" });
    });
    act(() => {
      live.store.set({ phase: "live" });
    });
    await settle();
    expect(openSays()).toBe("Open in Codex · personal");
    expect(part("run")?.textContent).toContain("Run with Claude Code · work");
  });

  test("the task's own last Open is its button, whatever the space used last", async () => {
    lastNow = { open: "codex-personal" };
    receiptsNow = [receipt("codex"), receipt("claude-test")];
    await showWith(FIVE);
    expect(openSays()).toBe("Open in Claude Code · test");
    // The row's tile opens in the same one.
    expect(container.querySelector('[data-part="tile"]')?.getAttribute("data-instance")).toBe(
      "claude-test",
    );
  });

  test("a pick in the menu opens with it, and it is then the button's; Run's menu is the same", async () => {
    await showWith(FIVE);
    click(part("open-other"));
    await settle();
    expect(groups()).toEqual(["Claude Code", "Codex"]);
    expect(items().map((i) => i.textContent)).toEqual([
      "ClOpen in Claude Code · default",
      "ClOpen in Claude Code · work",
      "ClOpen in Claude Code · test",
      "CoOpen in Codex · default",
      "CoOpen in Codex · personal",
    ]);
    expect(items().map((i) => i.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    click(items()[4]);
    await settle();
    expect(opened).toEqual(["codex-personal"]);
    expect(openSays()).toBe("Open in Codex · personal");
    click(part("open"));
    await settle();
    expect(opened).toEqual(["codex-personal", "codex-personal"]);

    click(part("run-other"));
    await settle();
    expect(groups()).toEqual(["Claude Code", "Codex"]);
    click(items()[2]);
    await settle();
    expect(ran).toEqual(["claude-test"]);
    expect(part("run")?.textContent).toContain("Run with Claude Code · test");
  });

  test("from the keyboard: Down opens the menu on its first agent and the arrows move; Escape closes it and gives the focus back", async () => {
    await showWith(FIVE);
    const trigger = part("open-other");
    act(() => {
      trigger?.focus();
    });
    press(trigger, "ArrowDown");
    await settle();
    expect(document.activeElement?.textContent).toContain("Claude Code · default");
    press(document.activeElement, "ArrowDown");
    press(document.activeElement, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Claude Code · test");
    press(document.activeElement, "ArrowUp");
    expect(document.activeElement?.textContent).toContain("Claude Code · work");
    press(document.activeElement, "Escape");
    await settle();
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
    expect(opened).toEqual([]);
  });

  test("a default that cannot open now says why on its button, and the menu says it on its row", async () => {
    busyNow = [{ task: TASK.id, instance: "claude", state: "opening" }];
    await showWith(FIVE);
    expect(part("open")?.getAttribute("aria-disabled")).toBe("true");
    expect(part("open")?.getAttribute("aria-description")).toBe("Claude Code · default is opening");
    click(part("open"));
    await settle();
    expect(opened).toEqual([]);
    click(part("open-other"));
    await settle();
    expect(items()[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(items()[0]?.textContent).toContain("Claude Code · default is opening");
  });

  test("one agent has no menu; fifteen keep one Open button and list all fifteen in their groups", async () => {
    await showWith([agent("claude", "Claude Code", "Claude Code", 1)]);
    expect(openSays()).toBe("Open in Claude Code");
    expect(part("open-other")).toBeNull();
    expect(part("run-other")).toBeNull();

    const apps = ["Claude Code", "Codex", "T3 Code"];
    const fifteen = Array.from({ length: 15 }, (_, i) => {
      const app = apps[i % 3] ?? "";
      return agent(`a${String(i)}`, app, `${app} · ${String(i)}`, (i % 8) + 1);
    });
    await showWith(fifteen);
    expect(container.querySelectorAll('[data-part="strip"] [data-part="open"]')).toHaveLength(1);
    click(part("open-other"));
    await settle();
    expect(groups()).toEqual(apps);
    expect(items()).toHaveLength(15);
    expect(items()[1]?.textContent).toContain("Claude Code · 3");
  });
});
