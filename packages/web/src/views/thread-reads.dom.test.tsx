// @vitest-environment happy-dom
//
// An expanded task's thread waits for its sessions and runs to be read, so they never slot in
// between its notes later; a read that fails counts as read, and the thread is drawn all the same.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
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
  title: "Plan the garden shed",
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: "p00001",
  created_at: Date.UTC(2026, 10, 1),
  version: 1,
};

const snapshot: SnapshotMessage = {
  type: "snapshot",
  space: SPACE,
  cursor: { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 },
  tasks: [TASK],
  areas: [],
  projects: [],
  instances: [],
};

const digest = {
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
    context: "",
    learnings: [],
    instructions: [],
    notes: [],
    log: [],
    sources: [],
    more: { instructions: 0, notes: 0, log: 0, sources: 0 },
    version: 1,
  },
};

const sections = {
  view: "sections",
  as_of: "1.10.01234567",
  sections: {
    notes: [
      {
        ref: "n1",
        author: "user",
        for_agents: false,
        at: "2026-11-10T09:00:00Z",
        text: "Measured the spot: level.",
      },
    ],
  },
};

const lost = () => Promise.reject(new TypeError("Failed to fetch"));

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let live: Live | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  live?.stop();
  vi.restoreAllMocks();
});

/** Opens the task's card against a service whose sessions or runs read fails. */
async function open(fails: "receipts" | "runs"): Promise<HTMLElement> {
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
          Promise.resolve(input.sections === undefined ? digest : sections),
      },
    },
    busy: () => Promise.resolve([]),
    receipts: () => (fails === "receipts" ? lost() : Promise.resolve([])),
    runs: () => (fails === "runs" ? lost() : Promise.resolve([])),
  } as unknown as Api;
  live = new Live({
    api,
    route: { space: SPACE.id },
    build: "",
    onSpace: () => undefined,
    onSignedOut: () => undefined,
    frames: new FakeFrames(),
  });
  const shown = document.createElement("div");
  container = shown;
  document.body.append(shown);
  root = createRoot(shown);
  const session = { api, live };
  act(() => {
    root?.render(
      <I18n>
        <ToastContext.Provider value={() => undefined}>
          <Session.Provider value={session}>
            <TaskList view="open" filter={() => true} empty="" />
          </Session.Provider>
        </ToastContext.Provider>
      </I18n>,
    );
  });
  act(() => {
    live?.store.push(snapshot);
    live?.store.flush();
  });
  act(() => {
    shown.querySelector<HTMLElement>(`li[data-key="${TASK.id}"] [data-part="title"]`)?.click();
  });
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  return shown;
}

const noteText = (shown: HTMLElement) =>
  [...shown.querySelectorAll('[data-entry="note"] [data-part="entry-text"]')].map(
    (note) => note.textContent,
  );

describe("[A5.3.7.web.thread-reads] a failed read of the sessions or the runs still lets the thread be drawn", () => {
  test("the runs cannot be read: the card's notes are drawn", async () => {
    expect(noteText(await open("runs"))).toEqual(["Measured the spot: level."]);
  });

  test("the sessions cannot be read: the card's notes are drawn", async () => {
    expect(noteText(await open("receipts"))).toEqual(["Measured the spot: level."]);
  });
});
