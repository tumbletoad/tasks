// @vitest-environment happy-dom
//
// The card of a task in the Trash is for reading (A5's Trash), with the real live store, rendered
// by React into a DOM (happy-dom): every control a live task's card offers, pressed on a removed
// one, leaves the stored draft, the task and the requests as they were. Only reads reach the
// service. Fixture text only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PRODUCT_ID } from "@ttasks/brand";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { SnapshotMessage } from "@ttasks/client/store";
import { keepDraft, keepNote, readDraft, readNotes } from "../unsent.ts";
import { TaskList } from "./TaskList.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };
const TASK = "t_00050";
const DRAFT = "Original typed words";

const snapshot: SnapshotMessage = {
  type: "snapshot",
  space: SPACE,
  cursor: CURSOR,
  tasks: [],
  areas: [{ id: "a_1", title: "Lumen", position: "a" }],
  projects: [],
  instances: [
    {
      key: "codex-work",
      app: "Codex",
      label: "Codex",
      glyph: "C",
      ring: 1,
      route: "terminal",
      runs: true,
    },
  ],
};

/** The digest of a task in the Trash, with a folder on this machine. */
const digest = {
  view: "digest",
  as_of: "1.10.01234567",
  task: {
    id: TASK,
    ref: "M-50",
    title: "Renew the passport",
    summary: "Book an appointment at the town hall",
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
    folder: { of: "task", path: "~/work/passport", machine: "m_1" },
    version: 3,
    deleted: {
      at: "2026-11-20T10:00:00.000Z",
      by: "user",
      change: "op_0123456789abcdefghjkmnpqrs",
    },
  },
};

/** Every section a live task's card has a control in. */
const sections = {
  view: "sections",
  as_of: "1.10.01234567",
  sections: {
    context: "The old one runs out in December.",
    notes: [
      {
        ref: "n1",
        author: "user",
        for_agents: false,
        at: "2026-11-10T09:00:00Z",
        text: "Bring two photos.",
      },
    ],
    log: [],
    sources: [
      {
        id: "s_1",
        kind: "ticket",
        title: "Passport renewal form",
        key: "jira:LUM-7",
        url: "https://example.org/form",
      },
      {
        id: "s_2",
        kind: "mail",
        title: "Old reminder",
        removed: { at: "2026-11-09T09:00:00Z", by: "user" },
      },
    ],
    outcome: { outcome: "Booked for Friday.", learnings: ["Book early."] },
  },
};

/** The calls that only read: anything else is a write, or starts one. */
const READS = new Set(["task.get", "busy", "receipts", "runs", "runs.list", "task.brief"]);

let container: HTMLDivElement;
let root: Root;
let live: Live;
const calls: string[] = [];

/** The client: records every call by its path, answers the reads, and leaves writes pending. */
function client(path: string[] = []): unknown {
  return new Proxy(() => undefined, {
    get: (_, key) => (typeof key === "string" ? client([...path, key]) : undefined),
    apply: (_, __, args: unknown[]) => {
      const name = path.join(".");
      calls.push(name);
      if (name === "task.get") {
        const input = args[0] as { sections?: unknown };
        return Promise.resolve(input.sections === undefined ? digest : sections);
      }
      return new Promise(() => undefined);
    },
  });
}

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
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
    client: client(),
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
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>
          <TaskList
            view="trash"
            filter={() => false}
            empty=""
            expand="M-50"
            onExpand={() => undefined}
          />
        </Session.Provider>
      </I18n>,
    );
  });
  act(() => {
    live.store.push(snapshot);
    live.store.flush();
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

const card = () => container.querySelector<HTMLElement>(`li[data-key="${TASK}"]`);

/** A key pressed on an element, as the keyboard sends it. */
const press = (target: Element, key: string, mods: KeyboardEventInit = {}) => {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
};

describe("[A5.trash.web.card] the card of a task in the Trash is for reading", () => {
  test("every control a live card offers, pressed on a removed task, leaves its draft, its pending note and the task as they were", async () => {
    keepDraft(SPACE.id, TASK, DRAFT);
    const note = { words: "A note on its way", id: "0190a0b0-0000-7000-8000-000000000001" };
    keepNote(SPACE.id, TASK, note);
    await settle();
    await settle();
    const shown = card();
    expect(shown?.querySelector('[data-part="in-trash"]')).not.toBeNull();
    expect(shown?.querySelector('[data-part="context"]')).not.toBeNull();
    // The draft is shown as it is kept, to read and copy.
    const field = shown?.querySelector<HTMLTextAreaElement>('[data-part="composer"]');
    expect(field?.value).toBe(DRAFT);

    // Every field that starts a request to an agent on a live task: the summary, the context, the
    // outcome, a learning, each source line.
    for (const part of shown?.querySelectorAll<HTMLElement>(
      '[data-part="summary"], [data-part="context"], [data-part="outcome"], [data-part="learning"], [data-part="source"], [data-ask]',
    ) ?? []) {
      act(() => {
        part.click();
      });
    }
    // Every button but Restore, the one way back, and the title and Collapse, which fold the card:
    // Copy, Show, More and the like only read.
    for (const button of shown?.querySelectorAll<HTMLElement>("button, [role='button']") ?? []) {
      if (["restore", "collapse", "title"].includes(button.dataset["part"] ?? "")) continue;
      act(() => {
        button.click();
      });
    }
    // The composer's keys: Note, Open and Run.
    if (field !== null && field !== undefined) {
      press(field, "Enter");
      press(field, "Enter", { ctrlKey: true });
      press(field, "Enter", { ctrlKey: true, shiftKey: true });
      press(field, "Enter", { metaKey: true });
    }
    // The title, which a live task edits in place.
    const title = shown?.querySelector<HTMLElement>('[data-part="title"]');
    if (title !== null && title !== undefined) press(title, "F2");
    await settle();

    expect(readDraft(SPACE.id, TASK)).toBe(DRAFT);
    expect(readNotes(SPACE.id, TASK)).toEqual([note]);
    expect(card()?.querySelector<HTMLTextAreaElement>('[data-part="composer"]')?.value).toBe(DRAFT);
    expect(calls.filter((name) => !READS.has(name))).toEqual([]);
    // No control that writes is offered at all.
    expect(card()?.querySelector("[data-ask]")).toBeNull();
    for (const part of ["move-to-trash", "check", "strip", "tile"]) {
      expect(card()?.querySelector(`[data-part="${part}"]`), part).toBeNull();
    }
  });
});

describe("[A5.trash.web.unsent] the card's Discard takes the words it shows", () => {
  test("another tab's title, kept newer before this tab heard of it: the card's Discard of the older one leaves it", async () => {
    const name = `${PRODUCT_ID}.title.${SPACE.id}.${TASK}.othertab`;
    const kept = (typed: string) => JSON.stringify({ typed, title: "Renew the passport" });
    localStorage.setItem(name, kept("Renew the passport in May"));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: name, storageArea: localStorage }));
    });
    await settle();
    const line = card()?.querySelector('[data-part="kept-title"]');
    expect(line?.textContent).toContain("Renew the passport in May");
    // The newer words arrive before their event does.
    localStorage.setItem(name, kept("Renew the passport in June"));
    act(() => {
      line?.querySelector<HTMLElement>('[data-part="discard-kept-title"]')?.click();
    });
    expect(localStorage.getItem(name)).toBe(kept("Renew the passport in June"));
  });
});
