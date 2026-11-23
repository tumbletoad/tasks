// @vitest-environment happy-dom
//
// The Agents page's parts from the Agent Monitor, in a DOM with the real live store: TTasks' own
// rows first, then every state of the monitor in plain words, the sessions in the order that puts
// what needs the person first, and each account's plan usage. Invented data only.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentsAccount, AgentsSession, AgentsView } from "@ttasks/contracts/monitor";
import { FakeFrames } from "../../test/fake-frames.ts";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { SnapshotMessage, TaskRow } from "../store/rows.ts";
import { AgentsPage } from "./Agents.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };
const MIN = 60_000;

const working: TaskRow = {
  id: "t_00001",
  ref: "M-1",
  title: "Fix appointment time zones",
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: "p1",
  created_at: 0,
  version: 1,
  run: { id: "r_1", state: "working" },
} as TaskRow;

function snapshot(tasks: readonly TaskRow[]): SnapshotMessage {
  return {
    type: "snapshot",
    space: SPACE,
    cursor: CURSOR,
    tasks,
    areas: [],
    projects: [],
    instances: [],
  };
}

function session(n: number, fields: Partial<AgentsSession> = {}): AgentsSession {
  return {
    key: `s${String(n)}`,
    app: "claude",
    appName: "claude",
    account: "work",
    title: `Session ${String(n)}`,
    folder: "/home/mira/projects/portal",
    activity: "idle",
    ageMs: 10 * MIN,
    quietMs: MIN,
    nested: [],
    ...fields,
  };
}

function account(fields: Partial<AgentsAccount> = {}): AgentsAccount {
  return {
    key: "a1",
    app: "claude",
    appName: "claude",
    account: "work",
    plan: "Max",
    windows: [
      {
        scope: null,
        kind: "session",
        label: null,
        usedPercent: 6,
        windowMinutes: 300,
        resetsInMs: 150 * MIN,
        limited: false,
        readingAgeMs: MIN,
      },
    ],
    readingAgeMs: 2 * MIN,
    refreshing: false,
    limited: false,
    failed: false,
    unavailable: false,
    ...fields,
  };
}

const picture = (
  sessions: readonly AgentsSession[],
  accounts: readonly AgentsAccount[] = [account()],
  more: { ageMs?: number; settling?: boolean } = {},
) => ({ ageMs: more.ageMs ?? 0, settling: more.settling ?? false, sessions, accounts });

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;
const sent: Record<string, unknown>[] = [];

beforeEach(() => {
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
    client: { task: { get: () => new Promise(() => undefined) } },
    busy: () => Promise.resolve([]),
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
    attention: { visible: () => true, focused: () => true, onChange: () => () => undefined },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  live.stop();
  sent.length = 0;
  vi.restoreAllMocks();
});

async function mount() {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <I18n>
          <Session.Provider value={{ api, live }}>
            <AgentsPage onExpand={() => undefined} />
          </Session.Provider>
        </I18n>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  act(() => {
    live.store.push(snapshot([working]));
    live.store.flush();
  });
}

const show = (view: AgentsView) => {
  act(() => {
    live.agents.show(view, performance.now());
  });
};

const text = (part: string) =>
  container.querySelector<HTMLElement>(`[data-part="${part}"]`)?.textContent ?? undefined;

/** The facts of an element, each a span after a middle dot. */
const facts = (element: Element | null | undefined) =>
  [...(element?.children ?? [])].map((child) => child.textContent);

const headings = () => [...container.querySelectorAll("h2")].map((h) => h.textContent);

const sessions = () =>
  [...container.querySelectorAll<HTMLElement>('[data-part="session"]')].map((li) => [
    li.querySelector("span")?.textContent,
    li.querySelector("[data-state]:not(li)")?.textContent,
  ]);

describe("[A5.agents.web-page] the Agents page shows the monitor's every state in words", () => {
  test("TTasks' own rows come first; before the monitor says anything, nothing else shows", async () => {
    await mount();
    expect(container.textContent).toContain("Fix appointment time zones");
    expect(text("computer")).toBeUndefined();
    expect(text("monitor-note")).toBeUndefined();
    show({ picture: picture([session(1)]), trouble: null });
    const all = container.textContent;
    expect(all.indexOf("Fix appointment time zones")).toBeLessThan(all.indexOf("On this computer"));
    expect(headings()).toEqual(["Working", "On this computer", "Plan usage"]);
  });

  test("not installed, a script, too old: one quiet line and no part of its own", async () => {
    await mount();
    show({ picture: null, trouble: { kind: "not_installed", reason: "not_found" } });
    expect(text("monitor-note")).toBe(
      "With TTAM installed, this page also shows every agent on this computer.",
    );
    expect(text("computer")).toBeUndefined();
    expect(headings()).toEqual(["Working"]);
    show({ picture: null, trouble: { kind: "not_installed", reason: "script" } });
    expect(text("monitor-note")).toContain("is a script, which TTasks does not run");
    show({ picture: null, trouble: { kind: "not_installed", reason: "no_query" } });
    expect(text("monitor-note")).toBe(
      "This TTAM is too old for TTasks. Update TTAM to see every agent on this computer here.",
    );
  });

  test("a monitor that does not fit names the side to update", async () => {
    await mount();
    const found = { version: "0.9.0", build: null };
    show({ picture: null, trouble: { kind: "does_not_fit", update: "ttasks", found } });
    expect(text("monitor-note")).toContain("Update TTasks");
    show({ picture: null, trouble: { kind: "does_not_fit", update: "monitor", found } });
    expect(text("monitor-note")).toContain("older than TTasks can read. Update TTAM");
  });

  test("looking, settling, no agents at all", async () => {
    await mount();
    show({ picture: null, trouble: null });
    expect(text("monitor-status")).toBe("Looking for agents on this computer.");
    show({ picture: picture([session(1)], [], { settling: true }), trouble: null });
    expect(text("monitor-status")).toBe("Still looking: an agent may be missing for a moment.");
    expect(sessions()).toHaveLength(1);
    show({ picture: picture([]), trouble: null });
    expect(text("monitor-status")).toBe("No agent is running on this computer.");
    // Plan usage still shows without a session.
    expect(text("usage")).toContain("6% used");
  });

  test("failed and not updating: what to do, and how old the picture is", async () => {
    await mount();
    show({ picture: null, trouble: { kind: "failed", reason: "exited" } });
    expect(text("monitor-status")).toBe("TTAM stopped answering. If this lasts, run ttam doctor.");
    show({
      picture: picture([session(1)], [], { ageMs: 3 * MIN }),
      trouble: { kind: "failed", reason: "exited" },
    });
    expect(text("monitor-status")).toBe(
      "TTAM stopped answering. If this lasts, run ttam doctor. Not updating: this is what it saw 3 min ago.",
    );
    expect(sessions()).toHaveLength(1);
    show({ picture: picture([session(1)], [], { ageMs: 2 * MIN }), trouble: { kind: "slow" } });
    expect(text("monitor-status")).toBe(
      "TTAM has not answered for a while. Not updating: this is what it saw 2 min ago.",
    );
  });

  test("what needs you first, then what works, then the rest as they started; unknown is never idle", async () => {
    await mount();
    show({
      picture: picture([
        session(1, { activity: "idle", ageMs: 50 * MIN }),
        session(2, { activity: "unknown", ageMs: 40 * MIN, quietMs: null }),
        session(3, { activity: "working", ageMs: 5 * MIN }),
        session(4, { activity: "waiting", ageMs: MIN }),
        session(5, { activity: "shell", ageMs: 30 * MIN }),
        session(6, { activity: "suspended", ageMs: null }),
      ]),
      trouble: null,
    });
    expect(sessions()).toEqual([
      ["Session 4", "Needs you"],
      ["Session 3", "Working"],
      ["Session 1", "Idle"],
      ["Session 2", "State unknown"],
      ["Session 5", "At a shell"],
      ["Session 6", "Suspended"],
    ]);
  });

  test("a session names its agent app, account, folder and age, and lists the agents inside it", async () => {
    await mount();
    show({
      picture: picture([
        session(1, {
          activity: "working",
          ageMs: 90 * MIN,
          nested: [
            {
              key: "n1",
              kind: "subagent",
              title: "Survey the fixtures",
              activity: "unknown",
              ageMs: MIN,
            },
            {
              key: "n2",
              kind: "workflow_agent",
              title: "Run the tests",
              activity: "working",
              ageMs: MIN,
            },
          ],
        }),
        session(2, { app: "unknown", appName: "example", folder: null }),
      ]),
      trouble: null,
    });
    const [first, second] = container.querySelectorAll<HTMLElement>('[data-part="session"]');
    expect(facts(first?.querySelector('[class*="meta"]'))).toEqual([
      "Claude Code",
      "work",
      "portal",
      "Started 1 h 30 min ago",
    ]);
    const inside = first?.querySelector("ul");
    expect(inside?.getAttribute("aria-label")).toBe("2 agents inside");
    expect(
      [...(inside?.querySelectorAll('[data-part="nested"]') ?? [])].map((li) => li.textContent),
    ).toEqual(["Survey the fixturesSubagentState unknown", "Run the testsWorkflow agentWorking"]);
    // An agent app TTasks does not know keeps the name TTAM gives it.
    expect(facts(second?.querySelector('[class*="meta"]'))).toEqual([
      "example",
      "work",
      "Started 10 min ago",
    ]);
  });

  test("plan usage per account: each limit, a limit reached, and an account without a reading", async () => {
    await mount();
    show({
      picture: picture(
        [],
        [
          account({ refreshing: true }),
          account({
            key: "a2",
            app: "codex",
            appName: "codex",
            account: "spare",
            plan: null,
            limited: true,
            windows: [
              {
                scope: "bucket",
                kind: "weekly",
                label: null,
                usedPercent: 100,
                windowMinutes: 10_080,
                resetsInMs: 3 * 24 * 60 * MIN + 4 * 60 * MIN,
                limited: true,
                readingAgeMs: MIN,
              },
              {
                scope: null,
                kind: "session",
                label: null,
                usedPercent: 20,
                windowMinutes: 300,
                resetsInMs: -MIN,
                limited: false,
                readingAgeMs: MIN,
              },
            ],
          }),
          account({ key: "a3", windows: [], readingAgeMs: null, plan: null, account: "new" }),
          account({ key: "a4", windows: [], unavailable: true, plan: null, account: "api" }),
          account({ key: "a5", failed: true, account: "old" }),
        ],
      ),
      trouble: null,
    });
    const accounts = [...container.querySelectorAll<HTMLElement>('[data-part="account"]')];
    expect(accounts.map((a) => facts(a.querySelector("span")))).toEqual([
      ["Claude Code", "work", "Max"],
      ["Codex", "spare"],
      ["Claude Code", "new"],
      ["Claude Code", "api"],
      ["Claude Code", "old", "Max"],
    ]);
    const windows = (a: Element | undefined) =>
      [...(a?.querySelectorAll('[data-part="window"]') ?? [])].map((w) =>
        [...w.children].map((part) => facts(part)),
      );
    expect(facts(accounts[0]?.querySelector('[class*="meta"]'))).toEqual([
      "Checking now",
      "Read 2 min ago",
    ]);
    expect(windows(accounts[0])).toEqual([
      [["Session"], [""], ["6% used", "resets in 2 h 30 min"]],
    ]);
    expect(accounts[1]?.querySelector('[class*="top"]')?.textContent).toContain("Limit reached");
    expect(windows(accounts[1])).toEqual([
      [["Week", "bucket"], [""], ["100% used", "Limit reached", "resets in 3 d 4 h"]],
      [["Session"], [""], ["20% used", "from an earlier period"]],
    ]);
    expect(accounts[2]?.textContent).toContain("No reading yet");
    expect(accounts[3]?.textContent).toContain("No plan usage for this sign-in");
    expect(accounts[4]?.textContent).toContain("The last check failed");
  });

  test("the page unmounted: the picture is dropped", async () => {
    await mount();
    show({ picture: picture([session(1)]), trouble: null });
    act(() => {
      root.unmount();
    });
    expect(live.agents.getState().view).toBeUndefined();
    root = createRoot(container);
  });
});
