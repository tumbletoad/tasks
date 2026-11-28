// @vitest-environment happy-dom
//
// A search's Completed group draws its rows as the Completed view does: when each task was finished
// and how, without the priority, effort and age of an open task. Its To do rows keep theirs.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import { withTaskRow, type TaskRow } from "@ttasks/client/store";
import { FakeFrames } from "../../test/fake-frames.ts";
import { searchGroups, type FoundRow } from "./search.ts";
import { TaskList } from "./TaskList.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };

function found(n: number, fields: Partial<TaskRow>): FoundRow {
  return {
    id: `t_${String(n).padStart(5, "0")}`,
    ref: `M-${String(n)}`,
    title: `Task ${String(n)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    position: `p${String(n).padStart(5, "0")}`,
    created_at: Date.UTC(2026, 9, 1),
    version: 1,
    priority: 1,
    effort: "L",
    ...fields,
  } as FoundRow;
}

let container: HTMLDivElement;
let root: Root;
let live: Live;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 14, 12), toFake: ["Date"] });
  const api = {
    client: { task: {} },
    busy: () => Promise.resolve({ busy: [], last: {} }),
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
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>
          <TaskList
            view="today"
            grouping="flat"
            filter={() => false}
            groups={() => searchGroups(open, finished, new Map())}
            empty=""
            keepsFinished
          />
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
  vi.useRealTimers();
});

const open = [found(1, { due_date: "2026-11-20" })];
const finished = [
  found(2, { lifecycle: "completed", completed_on: "2026-11-10" }),
  found(3, { lifecycle: "archived", completed_on: "2026-11-12" }),
  // Reopened since the search found it: it keeps its place until a refresh, as an open task.
  withTaskRow(found(4, { lifecycle: "completed", completed_on: "2026-11-11" }), {
    ...found(4, {}),
    version: 2,
  }),
];

/** What a row's columns say: its date column's tip, and whether priority and effort show. */
function columns(id: string) {
  const li = container.querySelector<HTMLElement>(`li[data-key="${id}"]`);
  return {
    tip: li?.querySelector("[data-tone]")?.getAttribute("data-tip") ?? undefined,
    priority: li?.querySelector("[data-level]") !== null,
    effort: (li?.querySelector('[data-part="row-effort"]')?.textContent ?? "") !== "",
  };
}

describe("[A5.3.13.web.search-finished] a search's Completed rows look as they do in Completed", () => {
  test("a finished row shows when and how it ended, and no open task's columns; a To do row keeps them", () => {
    expect(columns("t_00002")).toEqual({
      tip: "Completed Tuesday 10 November",
      priority: false,
      effort: false,
    });
    expect(columns("t_00003")).toMatchObject({ tip: "Dropped Thursday 12 November" });
    expect(columns("t_00001")).toMatchObject({ priority: true, effort: true });
    expect(columns("t_00001").tip).not.toMatch(/Completed|Dropped/);
    expect(columns("t_00004")).toMatchObject({ priority: true, effort: true });
    expect(columns("t_00004").tip ?? "").not.toMatch(/Completed|Dropped/);
    expect(finished[2]).not.toHaveProperty("completed_on");
  });
});
