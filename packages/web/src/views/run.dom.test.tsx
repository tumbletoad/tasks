// @vitest-environment happy-dom
//
// Run and Stop from an expanded task, with the real live store and the page's own actions,
// rendered by React into a DOM (happy-dom) against a fake service: one press is one run, a Run
// that got no answer is the same run when pressed again, and a Stop that did not reach the service
// leaves the run with its Stop.
import { act, type ReactNode } from "react";
import { areaNode, nodesOf } from "@ttasks/client/test/nodes";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import { AppError } from "@ttasks/contracts";
import { Unserved, Refused, type Api, type Busy, type Opened, type Run } from "../api.ts";
import type { Instance } from "@ttasks/contracts/runs";
import { ToastContext } from "../app/frame.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { SnapshotMessage, TaskRow } from "@ttasks/client/store";
import { readDraft } from "../unsent.ts";
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
  parent: "a_1",
  position: "p00001",
  created_at: Date.UTC(2026, 10, 1),
  version: 1,
};
const CODEX: Instance = {
  key: "codex-work",
  app: "Codex",
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
  nodes: nodesOf(SPACE.id, areaNode({ id: "a_1", title: "Lumen", position: "a" }, SPACE.id)),
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
/** While set, a read of the runs answers once it settles. */
let runsHeld: Promise<void> | undefined;
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
  leftOut: [],
});
/** How often the page read the runs. */
let reads: number;

beforeEach(async () => {
  started = [];
  listed = [];
  reads = 0;
  down = false;
  runsHeld = undefined;
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
                    more: { instructions: 0, notes: 0, log: 0, sources: 0, learnings: 0 },
                    version: 1,
                  },
                }
              : { view: "sections", as_of: "1.10.01234567", sections: {} },
          ),
      },
    },
    busy: () => Promise.resolve({ busy: busyNow, last: {} }),
    receipts: () => (down ? lost() : Promise.resolve([])),
    runs: () => {
      reads += 1;
      const answer = () =>
        down ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(listed);
      return runsHeld === undefined ? answer() : runsHeld.then(answer);
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
    unserved: new Unserved(),
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
  test("an instance that can only run here (no terminal opens it) offers its Run and no Open", async () => {
    const runOnly: Instance = {
      key: CODEX.key,
      app: CODEX.app,
      label: CODEX.label,
      glyph: CODEX.glyph,
      ring: CODEX.ring,
      runs: true,
    };
    act(() => {
      const at = snapshot();
      live.store.push({ ...at, cursor: { ...at.cursor, seq: 11 }, instances: [runOnly] });
      live.store.flush();
    });
    await settle();
    expect(runButton()).not.toBeNull();
    expect(
      container.querySelector(`li[data-key="${TASK.id}"] button[data-part="open"]`),
    ).toBeNull();
  });

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
      "Prompt copied",
      "Codex already had this task open or opening. What you typed is saved on the task as a note.",
    ]);
  });

  test("an Open that could not carry what its instance sets says what it left out, before anything is sent", async () => {
    openAnswer = (call) =>
      Promise.resolve({ ...opened(call, "request"), leftOut: ["read-only", "home"] });
    await open();
    openAnswer = (call) => Promise.resolve({ ...opened(call, "request"), leftOut: ["arguments"] });
    type("And the receipts");
    await open();
    expect(toasts).toEqual([
      `Opened in Codex without your read-only setting and the account you chose for it, which this way of opening cannot carry. A terminal can, where one is set up: see ${CLI_NAME} doctor.`,
      `Opened in Codex without your extra arguments, which this way of opening cannot carry. A terminal can, where one is set up: see ${CLI_NAME} doctor.`,
    ]);
  });

  test("an Open its instance cannot do here says why and what would, and starts nothing", async () => {
    for (const reason of ["no_terminal", "own_home", "not_for_space"]) {
      openAnswer = () =>
        Promise.reject(new Refused(400, "invalid_input", undefined, { field: "instance", reason }));
      await open();
    }
    expect(toasts).toEqual([
      `No terminal can open Codex here. Nothing was started. ${CLI_NAME} doctor says why.`,
      `Only a terminal opens Codex with the account you chose for it, and none can start here. Nothing was started. ${CLI_NAME} doctor says why.`,
      "Codex is set up for other spaces only. Nothing was started.",
    ]);
  });

  test("what an Open left out is said beside the clipboard's outcome, also when the browser did not allow copying", async () => {
    const leftOut = (call: Parameters<typeof opened>[0]) =>
      Promise.resolve({ ...opened(call, "request"), copy: "brief", leftOut: ["read-only"] });
    const without = `Opened in Codex without your read-only setting, which this way of opening cannot carry. A terminal can, where one is set up: see ${CLI_NAME} doctor.`;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    openAnswer = leftOut;
    await open();
    expect(toasts).toEqual([`The browser did not allow copying. ${without}`]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    type("And the receipts");
    await open();
    expect(toasts.slice(1)).toEqual(["Prompt copied", without]);
  });
});

describe("[M6.page.run-as-typed] Run sends the words as typed, and lets go only of a draft that is what it sent", () => {
  test("an indented block keeps its indent; a draft edited only in its whitespace while Run is on its way stays", async () => {
    let answer: () => void = () => undefined;
    startAnswer = () =>
      new Promise<Run>((resolve) => {
        answer = () => {
          resolve(record({ state: "queued", version: 1 }));
        };
      });
    type("\n    const a = 1;\n      return a;\n");
    click(1);
    await settle();
    expect(started.map((s) => s.text)).toEqual(["    const a = 1;\n      return a;"]);
    // The person fixes the indent of the last line while the Run is on its way.
    type("\n    const a = 1;\n    return a;\n");
    answer();
    await settle();
    expect(composer()?.value).toBe("\n    const a = 1;\n    return a;\n");
    expect(readDraft(SPACE.id, TASK.id)).toBe("\n    const a = 1;\n    return a;\n");
    // A trailing space is an edit too.
    startAnswer = () =>
      new Promise<Run>((resolve) => {
        answer = () => {
          resolve(record({ state: "queued", version: 1 }));
        };
      });
    type("Check it");
    click(1);
    await settle();
    type("Check it ");
    answer();
    await settle();
    expect(composer()?.value).toBe("Check it ");
    // Unchanged, the words go once the service holds them.
    startAnswer = queued;
    type("Check that");
    click(1);
    await settle();
    expect(composer()?.value).toBe("");
    expect(readDraft(SPACE.id, TASK.id)).toBe("");
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

describe("[M6.page.run-follow] a Stop on its way, and what the service said of it", () => {
  const entry = () =>
    container.querySelector<HTMLElement>(`li[data-key="${TASK.id}"] [data-entry="run"]`);
  const stop = () => entry()?.querySelector<HTMLButtonElement>('[data-part="run-stop"]');
  const state = () => entry()?.querySelector('[data-part="run-state"]')?.textContent ?? "";
  let answer: { ok: (run: Run) => void; fail: (error: unknown) => void };

  beforeEach(async () => {
    listed = [record({ state: "queued", started_at: null, version: 1 })];
    startAnswer = () => Promise.resolve(record({ state: "queued", started_at: null, version: 1 }));
    click(1);
    await settle();
    stopAnswer = () =>
      new Promise((ok, fail) => {
        answer = { ok, fail };
      });
    act(() => {
      stop()?.click();
    });
  });

  test("a queued run whose Stop is on its way says it is stopping, not that it stopped; the service's answer says how it ended", async () => {
    expect(state()).toContain("Stopping");
    expect(state()).not.toContain("Stopped before it started");
    expect(stop()).toBeNull();
    answer.ok(
      record({
        state: "cancelled",
        started_at: null,
        ended_at: Date.UTC(2026, 10, 1, 10),
        version: 2,
      }),
    );
    await settle();
    expect(state()).toContain("Stopped before it started");
  });

  test("a Stop whose answer never comes is offered again once a read since says the run still waits", async () => {
    expect(stop()).toBeNull();
    act(() => {
      live.store.push({ ...snapshot(), cursor: { ...snapshot().cursor, seq: 12 } });
      live.store.flush();
    });
    await settle();
    expect(state()).toContain("Waiting to start");
    expect(stop()).not.toBeNull();
  });

  test("a Stop whose answer was lost does not say it never arrived: the run shows as the service has it, with its Stop", async () => {
    answer.fail(new TypeError("Failed to fetch"));
    await settle();
    expect(toasts.at(-1)).not.toMatch(/did not reach/u);
    expect(toasts.at(-1)).toMatch(/may have stopped/u);
    expect(state()).toContain("Waiting to start");
    expect(stop()).not.toBeNull();
  });
});

describe("[M6.page.run-follow] a read that left before a Stop says nothing of it", () => {
  test("the run it finds still waiting stays stopping", async () => {
    listed = [record({ state: "queued", started_at: null, version: 1 })];
    click(1);
    await settle();
    const entry = () =>
      container.querySelector<HTMLElement>(`li[data-key="${TASK.id}"] [data-entry="run"]`);
    let release: () => void = () => undefined;
    runsHeld = new Promise((resolve) => {
      release = resolve;
    });
    act(() => {
      live.store.push({ ...snapshot(), cursor: { ...snapshot().cursor, seq: 12 } });
      live.store.flush();
    });
    stopAnswer = () => new Promise(() => undefined);
    act(() => {
      entry()?.querySelector<HTMLButtonElement>('[data-part="run-stop"]')?.click();
    });
    runsHeld = undefined;
    release();
    await settle();
    expect(entry()?.querySelector('[data-part="run-state"]')?.textContent).toContain("Stopping");
    expect(entry()?.querySelector('[data-part="run-stop"]')).toBeNull();
  });
});

describe("[M6.page.run-follow] a read of the runs that failed says so and is read again", () => {
  const thread = () => container.querySelector<HTMLElement>(`li[data-key="${TASK.id}"]`);
  const failedLine = () => thread()?.querySelector('[data-part="runs-failed"]');
  const entry = () => thread()?.querySelector<HTMLElement>('[data-entry="run"]');

  test("a thread with no entries whose read of the runs fails says the runs could not be read, not that nothing is logged", async () => {
    down = true;
    act(() => {
      live.store.push({ ...snapshot(), cursor: { ...snapshot().cursor, seq: 12 } });
      live.store.flush();
    });
    await settle();
    expect(failedLine()).not.toBeNull();
    expect(thread()?.textContent).not.toContain("Nothing logged yet.");
  });

  test("a working run whose next read fails shows that its runs could not be read, and the minute's read brings how it ended", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      listed = [record()];
      click(1);
      await settle();
      expect(entry()?.querySelector('[data-part="run-stop"]')).not.toBeNull();
      // It finishes; the read its run event asks for fails.
      listed = [record({ state: "succeeded", ended_at: Date.UTC(2026, 10, 1, 10), version: 5 })];
      down = true;
      act(() => {
        live.store.push({ ...snapshot(), cursor: { ...snapshot().cursor, seq: 12 } });
        live.store.flush();
      });
      await settle();
      expect(failedLine()).not.toBeNull();
      down = false;
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      await settle();
      expect(failedLine()).toBeNull();
      expect(entry()?.querySelector('[data-part="run-state"]')?.textContent).toContain("Done");
      expect(entry()?.querySelector('[data-part="run-stop"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("[M6.page.run-follow] a failed read of the runs is tried again while its card is open", () => {
  test("once the card closes, the minute reads nothing more", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      down = true;
      act(() => {
        live.store.push({ ...snapshot(), cursor: { ...snapshot().cursor, seq: 12 } });
        live.store.flush();
      });
      await settle();
      const title = () =>
        container.querySelector<HTMLElement>(`li[data-key="${TASK.id}"] [data-part="title"]`);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      await settle();
      const open = reads;
      act(() => {
        title()?.click();
      });
      await settle();
      act(() => {
        vi.advanceTimersByTime(180_000);
      });
      await settle();
      expect(reads).toBe(open);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("[M6.page.run-follow] a tab whose copy of the space is gone offers no Stop", () => {
  test("after the space was restored elsewhere, the old copy's working run keeps its state and loses its Stop", async () => {
    listed = [record()];
    click(1);
    await settle();
    const stop = () =>
      container.querySelector(
        `li[data-key="${TASK.id}"] [data-entry="run"] [data-part="run-stop"]`,
      );
    expect(stop()).not.toBeNull();
    act(() => {
      live.store.gone({ why: "restored" });
    });
    expect(stop()).toBeNull();
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

describe("[M6.page.run-finished] a finished task offers Reopen where Run would stand", () => {
  const reopenButton = () =>
    container.querySelector<HTMLButtonElement>(
      `li[data-key="${TASK.id}"] button[data-part="reopen-run"]`,
    );
  const push = (tasks: TaskRow[], seq: number) => {
    act(() => {
      const at = snapshot();
      live.store.push({ ...at, cursor: { ...at.cursor, seq }, tasks });
      live.store.flush();
    });
  };
  let reopened: unknown[];

  /** The task is finished: the live rows do not hold it, and the page reads it for its URL. */
  beforeEach(async () => {
    const digest = (await api.client.task.get({ task: TASK.id })) as { task: object };
    const client = api.client.task as unknown as Record<string, unknown>;
    client["get"] = () =>
      Promise.resolve({ ...digest, task: { ...digest.task, lifecycle: "completed" } });
    reopened = [];
    client["reopen"] = (input: unknown) => {
      reopened.push(input);
      return new Promise(() => undefined);
    };
    push([], 11);
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    mount(<TaskList view="open" filter={() => true} empty="" expand={TASK.ref} />, api);
    await settle();
  });

  test("Reopen stands where Run would, with Run's key, and a click reopens; Run is back once it is open", async () => {
    expect(runButton()).toBeNull();
    expect(reopenButton()?.getAttribute("aria-keyshortcuts")).toMatch(/Shift\+Enter$/);
    act(() => {
      reopenButton()?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    await settle();
    expect(reopened).toEqual([expect.objectContaining({ task: TASK.id })]);
    push([{ ...TASK, version: 2 }], 12);
    await settle();
    expect(reopenButton()).toBeNull();
    expect(runButton()).not.toBeNull();
    expect(started).toEqual([]);
  });

  test("Run's key reopens the finished task and starts no run", async () => {
    runKeys(false);
    await settle();
    expect(reopened).toEqual([expect.objectContaining({ task: TASK.id })]);
    expect(started).toEqual([]);
  });
});
