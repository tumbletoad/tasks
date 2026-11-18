// @vitest-environment happy-dom
//
// Run and Stop from an expanded task, with the real live store and the page's own actions,
// rendered by React into a DOM (happy-dom) against a fake service: one press is one run, a Run
// that got no answer is the same run when pressed again, and a Stop that did not reach the service
// leaves the run with its Stop.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppError } from "@tasks/contracts";
import { Refused, type Api, type Instance, type Opened, type Run } from "../api.ts";
import { ToastContext } from "../app/frame.ts";
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
const CODEX: Instance = {
  key: "codex-work",
  label: "Codex",
  glyph: "Cx",
  ring: 1,
  route: "terminal",
  runs: true,
};

const snapshot = (): SnapshotMessage => ({
  type: "snapshot",
  space: SPACE,
  cursor: { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 },
  tasks: [TASK],
  areas: [{ id: "a_1", title: "Lumen", position: "a" }],
  projects: [],
  instances: [CODEX],
});

const record = (patch: Partial<Run> = {}): Run => ({
  id: "ru_00r5mfcw5rfzxb9enb2vg50z3g",
  instance: CODEX.key,
  state: "running",
  reason: null,
  queued_at: Date.UTC(2026, 10, 1, 9),
  started_at: Date.UTC(2026, 10, 1, 9),
  ended_at: null,
  asked: null,
  answer: null,
  answer_final: false,
  answer_cut: false,
  version: 3,
  ...patch,
});

const lost = () => Promise.reject(new TypeError("Failed to fetch"));
const queued = () => Promise.resolve(record({ state: "queued", version: 1 }));

interface Started {
  readonly id: string;
  readonly text: string | undefined;
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let started: Started[];
/** What Run answers, call by call. */
let startAnswer: (call: number) => Promise<Run>;
let listed: readonly Run[];
let stopAnswer: () => Promise<Run>;
/** The service does not answer: a read of the runs fails as Run does. */
let down: boolean;
let opens: Started[];
/** What Open answers, call by call. */
let openAnswer: (call: number) => Promise<Opened>;
let toasts: string[];

/** An Open's answer: its launch, and where the words went. */
const opened = (call: number, text: Opened["text"]): Opened => ({
  receipt: {
    id: `la_${String(call)}`,
    reference: `L7KQ2${String(call)}`,
    instance: CODEX.key,
    route: "terminal",
    state: "dispatching",
    reason: null,
    at: { prepared: Date.UTC(2026, 10, 1, 9) },
    ...(text === "request" ? { request: "n1" } : {}),
  },
  copy: undefined,
  text,
  note: "n1",
});

beforeEach(async () => {
  started = [];
  listed = [];
  down = false;
  startAnswer = () => Promise.resolve(record({ state: "queued", version: 1 }));
  stopAnswer = () => Promise.reject(new TypeError("Failed to fetch"));
  opens = [];
  toasts = [];
  openAnswer = (call) => Promise.resolve(opened(call, "request"));
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
        get: (input: { readonly sections?: unknown }) =>
          Promise.resolve(
            input.sections === undefined
              ? {
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
                    more: { instructions: 0, notes: 0, log: 0, sources: 0 },
                    version: 1,
                  },
                }
              : { view: "sections", as_of: "1.10.01234567", sections: {} },
          ),
      },
    },
    receipts: () => (down ? lost() : Promise.resolve([])),
    runs: () => (down ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(listed)),
    startRun: (_task: string, _instance: string, id: string, text?: string) => {
      started.push({ id, text });
      return startAnswer(started.length);
    },
    stopRun: () => stopAnswer(),
    openLaunch: (_task: string, _instance: string, id: string, options: { text?: string }) => {
      opens.push({ id, text: options.text });
      return openAnswer(opens.length);
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
  mount(<TaskList view="open" filter={() => true} empty="" />, api);
  act(() => {
    live.store.push(snapshot());
    live.store.flush();
  });
  act(() => {
    container.querySelector<HTMLElement>(`li[data-key="${TASK.id}"] [data-part="title"]`)?.click();
  });
  await settle();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  live.stop();
  vi.restoreAllMocks();
});

function mount(node: ReactNode, api: Api) {
  act(() => {
    root.render(
      <I18n>
        <ToastContext.Provider value={(text) => toasts.push(text)}>
          <Session.Provider value={{ api, live }}>{node}</Session.Provider>
        </ToastContext.Provider>
      </I18n>,
    );
  });
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

const composer = () =>
  container.querySelector<HTMLTextAreaElement>(`li[data-key="${TASK.id}"] [data-part="composer"]`);
const runButton = () =>
  container.querySelector<HTMLButtonElement>(`li[data-key="${TASK.id}"] button[data-part="run"]`);

const type = (value: string) => {
  act(() => {
    const field = composer();
    if (field === null) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const click = (detail: number) => {
  act(() => {
    runButton()?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
    );
  });
};

const runKeys = (repeat: boolean) => {
  act(() => {
    composer()?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        shiftKey: true,
        repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

describe("[M6.page.run-once] one press is one run, and a Run without an answer is not started twice", () => {
  test("until the service answers again, the same words carry the same request ID", async () => {
    expect(runButton()).not.toBeNull();
    down = true;
    startAnswer = (call) => (call <= 2 ? lost() : queued());
    type("Check it");
    click(1);
    await settle();
    // No answer: the words stay, and pressing again is the same request.
    expect(composer()?.value).toBe("Check it");
    click(1);
    await settle();
    click(1);
    await settle();
    expect(started).toHaveLength(3);
    expect(started[1]).toEqual(started[0]);
    expect(started[2]).toEqual(started[0]);
    expect(composer()?.value).toBe("");
  });

  test("other words are another run", async () => {
    down = true;
    startAnswer = lost;
    type("Check it");
    click(1);
    await settle();
    type("Something else");
    click(1);
    await settle();
    click(1);
    await settle();
    expect(started.map((s) => s.text)).toEqual(["Check it", "Something else", "Something else"]);
    expect(started[1]?.id).not.toBe(started[0]?.id);
    expect(started[2]?.id).toBe(started[1]?.id);
  });

  test("once the service answered a read, the thread shows what started: the next Run is a new one", async () => {
    startAnswer = (call) => (call === 1 ? lost() : queued());
    click(1);
    await settle();
    click(1);
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]?.id).not.toBe(started[0]?.id);
  });

  test("the service's internal failure may follow a queued run: the same request; a refusal forgets it", async () => {
    down = true;
    startAnswer = (call) =>
      call === 1
        ? Promise.reject(new Refused(500, "internal"))
        : call === 2
          ? Promise.reject(new Refused(400, "invalid_input", undefined, { reason: "task_closed" }))
          : queued();
    for (let i = 0; i < 3; i += 1) {
      click(1);
      await settle();
    }
    expect(started.map((s) => s.id === started[0]?.id)).toEqual([true, true, false]);
  });

  test("the second click of a double click and a held key start nothing more", async () => {
    click(1);
    await settle();
    expect(started).toHaveLength(1);
    // The first click's run was queued before the second click came.
    click(2);
    await settle();
    expect(started).toHaveLength(1);
    runKeys(false);
    await settle();
    expect(started).toHaveLength(2);
    runKeys(true);
    await settle();
    expect(started).toHaveLength(2);
    // A held Enter on the Run button does not repeat its click; a single press clicks.
    const enter = (repeat: boolean) => {
      const press = new KeyboardEvent("keydown", {
        key: "Enter",
        repeat,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        runButton()?.dispatchEvent(press);
      });
      return press.defaultPrevented;
    };
    expect(enter(false)).toBe(false);
    expect(enter(true)).toBe(true);
  });
});

describe("[A5.3.8.web.open-once] an Open that got no answer is the same Open when pressed again", () => {
  const openButton = () =>
    container.querySelector<HTMLButtonElement>(
      `li[data-key="${TASK.id}"] button[data-part="open"]`,
    );
  const open = async () => {
    act(() => {
      openButton()?.click();
    });
    await settle();
  };

  const title = () =>
    container.querySelector<HTMLElement>(`li[data-key="${TASK.id}"] [data-part="title"]`);
  /** Collapse the task and expand it again: the composer is a new one, with the kept draft. */
  const reopen = async () => {
    act(() => {
      title()?.click();
    });
    act(() => {
      title()?.click();
    });
    await settle();
  };

  test("until the service answers it, the same words carry the same request ID; a refusal forgets it", async () => {
    expect(openButton()).not.toBeNull();
    openAnswer = (call) =>
      call <= 2
        ? lost()
        : call === 3
          ? // The generated client's error: the service refused, so nothing was done.
            Promise.reject(new AppError({ code: "invalid_input", message: "Refused" }))
          : Promise.resolve(opened(call, "request"));
    type("Check it");
    await open();
    // No answer: the words stay, the page says Codex may be opening, and pressing again is the
    // same request, which the service replays: one note, one launch. A read of the task's
    // launches meanwhile changes nothing: an empty list does not say the words were not saved.
    expect(composer()?.value).toBe("Check it");
    expect(toasts.at(-1)).toMatch(/did not answer, so Codex may be opening/u);
    await reopen();
    await open();
    await open();
    await open();
    expect(opens.map((o) => o.text)).toEqual(["Check it", "Check it", "Check it", "Check it"]);
    expect(opens.map((o) => o.id === opens[0]?.id)).toEqual([true, true, true, false]);
    // Saved on the task: the field clears.
    expect(composer()?.value).toBe("");
  });

  test("an Open still on its way is the same Open after the task was collapsed and expanded; other words are another", async () => {
    let answer: (value: Opened) => void = () => undefined;
    openAnswer = (call) =>
      call === 1
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : lost();
    type("Check it");
    await open();
    await reopen();
    await open();
    expect(opens.map((o) => o.text)).toEqual(["Check it", "Check it"]);
    expect(opens[1]?.id).toBe(opens[0]?.id);
    type("Something else");
    await open();
    expect(opens[2]?.id).not.toBe(opens[0]?.id);
    answer(opened(1, "request"));
    await settle();
  });

  test("a second click that got the launch of the first keeps its words as a note and says so last", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    openAnswer = (call) => Promise.resolve(opened(call, "note"));
    type("And the invoices");
    await open();
    expect(composer()?.value).toBe("");
    // An app that takes the brief by paste: the brief is copied, and what became of the words is
    // what the page says last.
    openAnswer = (call) => Promise.resolve({ ...opened(call, "note"), copy: "brief" });
    type("And the receipts");
    await open();
    expect(toasts).toEqual([
      "Codex was already opening this task. What you typed is saved on the task as a note.",
      "Copied",
      "Codex was already opening this task. What you typed is saved on the task as a note.",
    ]);
  });
});

describe("[M6.page.run-follow] a Stop that did not reach the service", () => {
  test("leaves the run as the service has it, with its Stop", async () => {
    listed = [record()];
    // The thread reads the task's runs when it expands: make it read again.
    click(1);
    await settle();
    const stop = () =>
      container.querySelector<HTMLButtonElement>(
        `li[data-key="${TASK.id}"] [data-entry="run"] [data-part="run-stop"]`,
      );
    expect(stop()).not.toBeNull();
    let fail: (error: unknown) => void = () => undefined;
    stopAnswer = () =>
      new Promise((_, reject) => {
        fail = reject;
      });
    act(() => {
      stop()?.click();
    });
    // On its way: the entry says it stops, without a second Stop.
    expect(stop()).toBeNull();
    fail(new TypeError("Failed to fetch"));
    await settle();
    expect(stop()).not.toBeNull();
  });
});
