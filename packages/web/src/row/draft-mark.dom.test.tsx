// @vitest-environment happy-dom
//
// A row whose composer holds unsent words carries a quiet mark, so a draft left for days is found
// without expanding every task. It comes and goes with the draft, also when another tab of the
// browser writes or sends it.
import { PRODUCT_ID } from "@ttasks/brand";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { TaskRow } from "../store/rows.ts";
import { keepDraft } from "../task/composer.ts";
import { TaskList } from "../views/TaskList.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };

function task(n: number): TaskRow {
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
  };
}

let container: HTMLDivElement;
let root: Root;
let live: Live;

beforeEach(() => {
  localStorage.clear();
  const api = {
    client: { task: {} },
    busy: () => Promise.resolve([]),
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
          <TaskList view="open" filter={(t) => t.lifecycle === "active"} empty="" />
        </Session.Provider>
      </I18n>,
    );
  });
  act(() => {
    live.store.push({
      type: "snapshot",
      space: SPACE,
      cursor: { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 },
      tasks: [task(1), task(2)],
      areas: [{ id: "a_1", title: "Lumen", position: "a" }],
      projects: [],
      instances: [],
    });
    live.store.flush();
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  live.stop();
  localStorage.clear();
});

const markOf = (id: string) => {
  const marker = container.querySelector(`li[data-key="${id}"] [data-kind]`);
  return marker === null
    ? undefined
    : {
        kind: marker.getAttribute("data-kind"),
        label: marker.querySelector('[role="img"]')?.getAttribute("aria-label"),
      };
};

describe("[A5.3.6.web.draft-mark] a row shows that its composer holds unsent words", () => {
  test("the mark comes with a draft and goes when it is sent or emptied, also from another tab", () => {
    expect(markOf("t_00001")).toBeUndefined();
    act(() => {
      keepDraft(SPACE.id, "t_00001", "Ask about the March totals");
    });
    expect(markOf("t_00001")).toEqual({ kind: "draft", label: "Unsent words in its composer" });
    expect(markOf("t_00002")).toBeUndefined();
    // Blank lines are no words to send.
    act(() => {
      keepDraft(SPACE.id, "t_00001", "\n  \n");
    });
    expect(markOf("t_00001")).toBeUndefined();

    // Another tab of the browser keeps a draft, then sends it.
    const key = `${PRODUCT_ID}.draft.${SPACE.id}.t_00002`;
    act(() => {
      localStorage.setItem(key, "Check the invoice");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: "Check the invoice",
          storageArea: localStorage,
        }),
      );
    });
    expect(markOf("t_00002")).toMatchObject({ kind: "draft" });
    act(() => {
      localStorage.removeItem(key);
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: null, storageArea: localStorage }),
      );
    });
    expect(markOf("t_00002")).toBeUndefined();
  });
});
