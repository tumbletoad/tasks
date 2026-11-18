// @vitest-environment happy-dom
//
// Run and Stop from an expanded task, with the real live store and the page's own actions,
// rendered by React into a DOM (happy-dom) against a fake service: one press is one run, a Run
// that got no answer is the same run when pressed again, and a Stop that did not reach the service
// leaves the run with its Stop.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Refused, type Api, type Instance, type Run } from "../api.ts";
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

beforeEach(async () => {
  started = [];
  listed = [];
  startAnswer = () => Promise.resolve(record({ state: "queued", version: 1 }));
  stopAnswer = () => Promise.reject(new TypeError("Failed to fetch"));
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
    receipts: () => Promise.resolve([]),
    runs: () => Promise.resolve(listed),
    startRun: (_task: string, _instance: string, id: string, text?: string) => {
      started.push({ id, text });
      return startAnswer(started.length);
    },
    stopRun: () => stopAnswer(),
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
        <Session.Provider value={{ api, live }}>{node}</Session.Provider>
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
  container.querySelector<HTMLButtonElement>(`li[data-key="${TASK.id}"] [data-part="run"]`);

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
  test("pressed again after no answer, the same words carry the same request ID", async () => {
    startAnswer = (call) =>
      call === 1
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(record({ state: "queued", version: 1, asked: "Check it" }));
    expect(runButton()).not.toBeNull();
    type("Check it");
    click(1);
    await settle();
    // No answer: the words stay.
    expect(composer()?.value).toBe("Check it");
    click(1);
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]).toEqual(started[0]);
    expect(composer()?.value).toBe("");
    // Other words are another run.
    type("Something else");
    click(1);
    await settle();
    expect(started[2]?.id).not.toBe(started[0]?.id);
  });

  test("a refusal forgets the request: the next Run is a new one", async () => {
    startAnswer = (call) =>
      call === 1
        ? Promise.reject(new Refused(400, "invalid_input", undefined, { reason: "task_closed" }))
        : Promise.resolve(record({ state: "queued", version: 1 }));
    click(1);
    await settle();
    click(1);
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]?.id).not.toBe(started[0]?.id);
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
