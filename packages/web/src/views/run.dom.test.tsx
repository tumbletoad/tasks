// @vitest-environment happy-dom
//
// Run and Stop from an expanded task, with the real live store and the page's own actions,
// rendered by React into a DOM (happy-dom) against a fake service: one press is one run, a Run
// that got no answer is the same run when pressed again, and a Stop that did not reach the service
// leaves the run with its Stop.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppError } from "@ttasks/contracts";
import { Refused, type Api, type Busy, type Instance, type Opened, type Run } from "../api.ts";
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
let opens: (Started & { readonly another: boolean })[];
/** What a read of busy answers. */
let busyNow: Busy[];
let api: Api;
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
/** How often the page read the runs. */
let reads: number;

beforeEach(async () => {
  started = [];
  listed = [];
  reads = 0;
  down = false;
  startAnswer = () => Promise.resolve(record({ state: "queued", version: 1 }));
  stopAnswer = () => Promise.reject(new TypeError("Failed to fetch"));
  opens = [];
  busyNow = [];
  localStorage.clear();
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
  api = {
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
    busy: () => Promise.resolve(busyNow),
    receipts: () => (down ? lost() : Promise.resolve([])),
    runs: () => {
      reads += 1;
      return down ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(listed);
    },
    startRun: (_task: string, _instance: string, id: string, text?: string) => {
      started.push({ id, text });
      return startAnswer(started.length);
    },
    stopRun: () => stopAnswer(),
    openLaunch: (
      _task: string,
      _instance: string,
      id: string,
      options: { text?: string; another?: boolean },
    ) => {
      opens.push({ id, text: options.text, another: options.another === true });
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

  test("pressed again and answered with a run that already ended (done, failed or stopped), the words stay and the page says so; the next press is a new run", async () => {
    down = true;
    const ended = record({ state: "succeeded", ended_at: Date.UTC(2026, 10, 1, 10), version: 5 });
    startAnswer = (call) => (call === 1 ? lost() : Promise.resolve(ended));
    type("Check it");
    click(1);
    await settle();
    click(1);
    await settle();
    expect(started[1]?.id).toBe(started[0]?.id);
    expect(composer()?.value).toBe("Check it");
    expect(toasts.at(-1)).toBe(
      "This request was already taken: its run is in the thread. Press Run again to start a new one.",
    );
    startAnswer = queued;
    click(1);
    await settle();
    expect(started[2]?.id).not.toBe(started[0]?.id);
    expect(composer()?.value).toBe("");
  });

  test("a first press answered with a run that ended at once is that run, and clears the words", async () => {
    startAnswer = () =>
      Promise.resolve(record({ state: "failed", ended_at: Date.UTC(2026, 10, 1, 10), version: 4 }));
    type("Check it");
    click(1);
    await settle();
    expect(composer()?.value).toBe("");
    expect(toasts).toEqual([]);
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

  test("a read of the runs since says nothing of which run that request made: pressed again, the same request", async () => {
    startAnswer = (call) => (call === 1 ? lost() : queued());
    click(1);
    await settle();
    click(1);
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]?.id).toBe(started[0]?.id);
    // Answered: the next Run is a new one.
    click(1);
    await settle();
    expect(started[2]?.id).not.toBe(started[0]?.id);
  });

  test("the service's internal failure may follow a queued run: the same request, also after a refusal of it again; a refusal of a first press forgets it", async () => {
    down = true;
    const closed = () =>
      Promise.reject(new Refused(400, "invalid_input", undefined, { reason: "task_closed" }));
    startAnswer = (call) =>
      call === 1
        ? Promise.reject(new Refused(500, "internal"))
        : call === 2 || call === 4
          ? closed()
          : queued();
    for (let i = 0; i < 5; i += 1) {
      click(1);
      await settle();
    }
    // The refusal of the second press says nothing of the first, which may have queued a run.
    expect(started.map((s) => s.id === started[0]?.id)).toEqual([true, true, true, false, false]);
    expect(started[4]?.id).not.toBe(started[3]?.id);
  });

  test("a read of the runs while a Run is on its way says nothing of it: pressed again after its answer was lost, the same request", async () => {
    let fail: (error: unknown) => void = () => undefined;
    startAnswer = (call) =>
      call === 1
        ? new Promise((_, reject) => {
            fail = reject;
          })
        : queued();
    click(1);
    await settle();
    // The task collapsed and expanded: its runs are read, and none is there yet.
    const title = () =>
      container.querySelector<HTMLElement>(`li[data-key="${TASK.id}"] [data-part="title"]`);
    act(() => {
      title()?.click();
    });
    act(() => {
      title()?.click();
    });
    await settle();
    down = true;
    fail(new TypeError("Failed to fetch"));
    await settle();
    click(1);
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]?.id).toBe(started[0]?.id);
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

  test("until the service answers it, the same words carry the same request ID, also after a refusal of it again; a refusal of a first press forgets it", async () => {
    expect(openButton()).not.toBeNull();
    // The generated client's error: the service refused this press, so it did nothing.
    const refused = () => Promise.reject(new AppError({ code: "read_only", message: "Refused" }));
    openAnswer = (call) =>
      call <= 2
        ? lost()
        : call === 3 || call === 5
          ? refused()
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
    // The refusal of the third press says nothing of the first two, which may have saved the words.
    expect(opens.map((o) => o.text)).toEqual(["Check it", "Check it", "Check it", "Check it"]);
    expect(opens.map((o) => o.id === opens[0]?.id)).toEqual([true, true, true, true]);
    // Saved on the task: the field clears.
    expect(composer()?.value).toBe("");
    // A first press refused did nothing: pressed again, it is a new Open.
    type("Then this");
    await open();
    await open();
    expect(opens.slice(4).map((o) => o.text)).toEqual(["Then this", "Then this"]);
    expect(opens[5]?.id).not.toBe(opens[4]?.id);
  });

  test("an Open still on its way is the same Open after the task was collapsed and expanded, and after its answer was lost; other words are another", async () => {
    let fail: (error: unknown) => void = () => undefined;
    openAnswer = (call) =>
      call === 1
        ? new Promise((_, reject) => {
            fail = reject;
          })
        : lost();
    type("Check it");
    await open();
    await reopen();
    // A press of this tab while its Open waits for the answer is that Open.
    await open();
    expect(opens).toHaveLength(1);
    fail(new TypeError("Failed to fetch"));
    await settle();
    await open();
    expect(opens.map((o) => o.text)).toEqual(["Check it", "Check it"]);
    expect(opens[1]?.id).toBe(opens[0]?.id);
    type("Something else");
    await open();
    expect(opens[2]?.id).not.toBe(opens[0]?.id);
  });

  /** The tab goes offline and is live again: it reads what busies the apps again. */
  const reconnect = async () => {
    act(() => {
      live.store.set({ phase: "offline" });
    });
    act(() => {
      live.store.set({ phase: "live" });
    });
    await settle();
  };

  /** The page loads again: a new list, with what the browser kept, and the task expanded. */
  const reload = async () => {
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    mount(<TaskList view="open" filter={() => true} empty="" />, api);
    await settle();
    act(() => {
      title()?.click();
    });
    await settle();
  };

  test("an Open whose answer was lost after the service saved it stays the button to press, through its launch on its way and a reload, and is pressed as that Open", async () => {
    openAnswer = (call) => (call === 1 ? lost() : Promise.resolve(opened(call, "request")));
    type("Check it");
    await open();
    expect(toasts.at(-1)).toMatch(/did not answer, so Codex may be opening/u);
    // The service did save the words and record the launch, which is on its way.
    busyNow = [{ task: TASK.id, instance: CODEX.key, state: "opening" }];
    await reconnect();
    expect(openButton()?.getAttribute("aria-disabled")).toBe("false");
    await reload();
    expect(composer()?.value).toBe("Check it");
    expect(openButton()?.getAttribute("aria-disabled")).toBe("false");
    // Its agent runs by now: the button still repeats the Open that got no answer.
    busyNow = [{ task: TASK.id, instance: CODEX.key, state: "running" }];
    await reconnect();
    expect(openButton()?.textContent).toContain("Open in Codex");
    await open();
    expect(opens.map((o) => [o.id, o.another])).toEqual([
      [opens[0]?.id, false],
      [opens[0]?.id, false],
    ]);
    expect(composer()?.value).toBe("");
    // Answered: the same words again are a new Open, a second session as the button says.
    type("Check it");
    expect(openButton()?.textContent).toContain("Open another in Codex");
    await open();
    expect(opens[2]?.id).not.toBe(opens[0]?.id);
    expect(opens[2]?.another).toBe(true);
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
      "Codex already had this task open or opening. What you typed is saved on the task as a note.",
      "Copied",
      "Codex already had this task open or opening. What you typed is saved on the task as a note.",
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

describe("[M6.page.run-follow] how long a working run has said nothing stays true", () => {
  test("its runs are read again every minute, however often they were read in between", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      listed = [record()];
      click(1);
      await settle();
      const first = reads;
      // A read in between, 40 s into the minute.
      act(() => {
        vi.advanceTimersByTime(40_000);
      });
      click(1);
      await settle();
      expect(reads).toBe(first + 1);
      act(() => {
        vi.advanceTimersByTime(25_000);
      });
      await settle();
      expect(reads).toBe(first + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
