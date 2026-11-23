// @vitest-environment happy-dom
//
// The real top bar with the real live store and the browser's storage (happy-dom), its service
// faked: Enter frees the field at once whatever happens to the add, and an add without an answer is
// a line under the field that says what is known and goes again by itself.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppError } from "@ttasks/contracts";
import { Refused, type Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { SnapshotMessage } from "../store/rows.ts";
import { FakeFrames } from "../../test/fake-frames.ts";
import { ToastContext } from "./frame.ts";
import { AuthContext } from "./session.tsx";
import { TopBar } from "./TopBar.tsx";

const SPACE = vi.hoisted(() => ({
  id: "sp_0123456789abcdefghjkmnpqrs",
  name: "Mira",
  ref_prefix: "M",
}));
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };

vi.mock("@tanstack/react-router", () => {
  const location = { pathname: `/s/${SPACE.id}/today`, search: {}, href: `/s/${SPACE.id}/today` };
  return {
    useNavigate: () => () => Promise.resolve(),
    useParams: () => ({}),
    useRouter: () => ({ history: { push: () => undefined } }),
    useRouterState: ({ select }: { select: (state: { location: typeof location }) => unknown }) =>
      select({ location }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: SnapshotMessage = {
  type: "snapshot",
  space: SPACE,
  cursor: CURSOR,
  tasks: [],
  areas: [{ id: "a_1", title: "Home", position: "a" }],
  projects: [],
  instances: [],
};

interface Sent {
  readonly input: {
    readonly tasks: readonly Record<string, unknown>[];
    readonly request_id: string;
  };
  answer(result: unknown): void;
  fail(error: unknown): void;
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let sent: Sent[];
let toasts: string[];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sent = [];
  toasts = [];
  const api = {
    client: {
      task: {
        add: (input: Sent["input"]) =>
          new Promise((resolve, reject) => {
            sent.push({ input, answer: resolve, fail: reject });
          }),
      },
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
    live.store.push(snapshot);
    live.store.flush();
  });
  act(() => {
    root.render(
      <I18n>
        <AuthContext.Provider
          value={{ token: "ttasks_u_test", build: "", signedOut: () => undefined }}
        >
          <ToastContext.Provider value={(text) => toasts.push(text)}>
            <Session.Provider value={{ api, live }}>
              <TopBar space={SPACE.id} live />
            </Session.Provider>
          </ToastContext.Provider>
        </AuthContext.Provider>
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
});

function field(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="New task"]');
  if (input === null) throw new Error("no field");
  return input;
}
const lines = () =>
  [...container.querySelectorAll<HTMLElement>('[data-part="add-line"]')].map((line) => [
    line.querySelector('[data-part="add-words"]')?.textContent,
    line.dataset["state"],
    [...line.querySelectorAll("button")].map((button) => button.textContent),
  ]);
const press = (part: string) => {
  act(() => {
    container.querySelector<HTMLButtonElement>(`[data-part="${part}"]`)?.click();
  });
};
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

function type(text: string) {
  const input = field();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function enter() {
  act(() => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("[A5.3.13.web.add-line] the top field is never tied to an add", () => {
  test("Enter empties the field at once; the next words go out while the first add is still on its way", async () => {
    type("Call the plumber");
    enter();
    expect(field().value).toBe("");
    type("Buy milk");
    enter();
    await flush();
    expect(field().value).toBe("");
    expect(sent.map((s) => s.input.tasks[0]?.["title"])).toEqual(["Call the plumber", "Buy milk"]);
    expect(lines()).toEqual([]);
  });

  test("a lost answer is a line with the words, Try again and Discard; Try again is the same request, and the field stays free", async () => {
    type("Order the hinge pins p1");
    enter();
    await flush();
    await act(async () => {
      sent[0]?.fail(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lines()).toEqual([["Order the hinge pins p1", "unanswered", ["Try again", "Discard"]]]);
    expect(field().value).toBe("");
    expect(field().disabled).toBe(false);
    press("add-again");
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input).toEqual(sent[0]?.input);
    expect(lines()).toEqual([["Order the hinge pins p1", "adding", ["Discard"]]]);
    await act(async () => {
      sent[1]?.answer({ tasks: [], as_of: "1.10.01234567" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lines()).toEqual([]);
    expect(toasts).toEqual(["Added to Inbox"]);
    expect(localStorage.length).toBe(0);
  });

  test("the feed live again after it was down sends the add by itself", async () => {
    type("Fix the gate latch");
    enter();
    await flush();
    act(() => {
      live.store.set({ phase: "offline" });
    });
    await act(async () => {
      sent[0]?.fail(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sent).toHaveLength(1);
    act(() => {
      live.store.set({ phase: "live" });
    });
    await flush();
    expect(sent.map((s) => s.input.request_id)).toEqual([
      sent[0]?.input.request_id,
      sent[0]?.input.request_id,
    ]);
  });

  test("a refused add gives its words back with Edit, chips kept as text included, or Copy while the field holds other words; Discard lets it go", async () => {
    type("Plan the trip tomorrow");
    // The date kept as text: the cross on its chip.
    act(() => {
      field().focus();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Keep tomorrow as text"]')?.click();
    });
    enter();
    await flush();
    expect(sent[0]?.input.tasks[0]).toEqual({ title: "Plan the trip tomorrow", inbox: true });
    await act(async () => {
      sent[0]?.fail(new AppError({ code: "invalid_input", message: "The title is too long." }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lines()).toEqual([["Plan the trip tomorrow", "refused", ["Edit", "Discard"]]]);
    expect(container.textContent).toContain("Not added: The title is too long.");
    type("Something else");
    expect(lines()).toEqual([["Plan the trip tomorrow", "refused", ["Copy", "Discard"]]]);
    type("");
    press("add-edit");
    expect(field().value).toBe("Plan the trip tomorrow");
    expect(lines()).toEqual([]);
    enter();
    await flush();
    expect(sent[1]?.input.tasks[0]).toEqual({ title: "Plan the trip tomorrow", inbox: true });
    expect(sent[1]?.input.request_id).not.toBe(sent[0]?.input.request_id);
    await act(async () => {
      sent[1]?.fail(new Refused(400, "invalid_input"));
      await vi.advanceTimersByTimeAsync(0);
    });
    press("add-discard");
    expect(lines()).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
});
