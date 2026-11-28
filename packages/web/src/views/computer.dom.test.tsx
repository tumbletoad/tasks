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
import type {
  AgentsAccount,
  AgentsSession,
  AgentsTask,
  AgentsView,
} from "@ttasks/contracts/monitor";
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
  run: { id: "ru_1", state: "working", instance: "fake-agent" },
};

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
    task: null,
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
    sameAs: null,
    failed: null,
    retryInMs: null,
    unavailable: null,
    ...fields,
  };
}

const picture = (
  sessions: readonly AgentsSession[],
  accounts: readonly AgentsAccount[] = [account()],
  more: { ageMs?: number; settling?: boolean; unseen?: readonly AgentsTask[] } = {},
) => ({
  ageMs: more.ageMs ?? 0,
  settling: more.settling ?? false,
  sessions,
  unseen: more.unseen ?? [],
  accounts,
});

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
    client: {
      task: {
        get: () => new Promise(() => undefined),
        trash: () => Promise.resolve({ rows: [] }),
      },
    },
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

async function mount(tasks: readonly TaskRow[] = [working]) {
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
    live.store.push(snapshot(tasks));
    live.store.flush();
  });
}

/** The monitor's view, with no T3 threads unless it names some. */
const show = (view: Omit<AgentsView, "threads"> & Partial<Pick<AgentsView, "threads">>) => {
  act(() => {
    live.agents.show({ threads: [], ...view }, performance.now());
  });
};

const text = (part: string) =>
  container.querySelector<HTMLElement>(`[data-part="${part}"]`)?.textContent ?? undefined;

/** The facts of an element, each a span after a middle dot. */
const facts = (element: Element | null | undefined) =>
  [...(element?.children ?? [])].map((child) => child.textContent);

const headings = () => [...container.querySelectorAll("h2")].map((h) => h.textContent);

/** Whether each part of the monitor shows as not current. */
const stale = () =>
  [...container.querySelectorAll<HTMLElement>('[data-part="computer"], [data-part="usage"]')].map(
    (part) => part.dataset["stale"],
  );

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

  test("a monitor that does not fit names the side to update, and older or newer only when known", async () => {
    await mount();
    const found = { version: "0.9.0", build: null };
    show({ picture: null, trouble: { kind: "does_not_fit", monitor: "newer", found } });
    expect(text("monitor-note")).toContain("newer than TTasks can read. Update TTasks");
    show({ picture: null, trouble: { kind: "does_not_fit", monitor: "older", found } });
    expect(text("monitor-note")).toContain("older than TTasks can read. Update TTAM");
    // The versions fit, the snapshot does not: neither older nor newer.
    show({ picture: null, trouble: { kind: "does_not_fit", monitor: "other_shape", found } });
    expect(text("monitor-note")).toBe(
      "This TTAM does not fit TTasks. Update TTAM to see the agents on this computer.",
    );
  });

  test("looking, settling, no agents at all", async () => {
    await mount();
    show({ picture: null, trouble: null });
    expect(text("monitor-status")).toBe("Looking for agents on this computer.");
    show({ picture: picture([session(1)], [], { settling: true }), trouble: null });
    expect(text("monitor-status")).toBe("Still looking: an agent may be missing for a moment.");
    expect(sessions()).toHaveLength(1);
    show({ picture: picture([]), trouble: null });
    expect(text("monitor-status")).toBe("TTAM sees no agent on this computer.");
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
      "TTAM stopped answering. If this lasts, run ttam doctor. Not updating: this is what TTAM saw 3 min ago.",
    );
    expect(sessions()).toHaveLength(1);
    // Its states no longer look live.
    expect(stale()).toEqual(["true"]);
    show({ picture: picture([session(1)], [], { ageMs: 2 * MIN }), trouble: { kind: "slow" } });
    expect(text("monitor-status")).toBe(
      "TTAM has not answered for a while. Not updating: this is what TTAM saw 2 min ago.",
    );
    show({ picture: picture([session(1)]), trouble: null });
    expect(stale()).toEqual([undefined, undefined]);
  });

  test("a picture that is not current mutes both parts, says how old it is, and speaks of nothing now", async () => {
    await mount();
    const now = picture([session(1, { activity: "working" })], [account({ refreshing: true })], {
      ageMs: MIN,
    });
    show({ picture: now, trouble: null });
    expect(text("account")).toContain("Checking now");
    expect(text("usage-status")).toBeUndefined();
    // The monitor stops answering: both parts say so, and no check is said to run.
    show({ picture: now, trouble: { kind: "failed", reason: "exited" } });
    expect(stale()).toEqual(["true", "true"]);
    expect(text("usage-status")).toBe("Not updating: this is what TTAM saw 1 min ago.");
    expect(text("account")).not.toContain("Checking now");
    // The feed is cut (the service restarts): the page's own bar says why, the parts how old.
    show({ picture: now, trouble: null });
    act(() => {
      live.agents.cut();
    });
    expect(stale()).toEqual(["true", "true"]);
    expect(text("monitor-status")).toBe("Not updating: this is what TTAM saw 1 min ago.");
    expect(text("usage-status")).toBe("Not updating: this is what TTAM saw 1 min ago.");
    expect(text("account")).not.toContain("Checking now");
    // Cut before any picture: it is not looking either.
    show({ picture: null, trouble: null });
    act(() => {
      live.agents.cut();
    });
    expect(text("monitor-status")).toBe("Not updating.");
    // The next view is current again.
    show({ picture: now, trouble: null });
    expect(stale()).toEqual([undefined, undefined]);
    expect(text("account")).toContain("Checking now");
  });

  test("a monitor slow before its first answer is said in its part, not as the quiet line", async () => {
    await mount();
    show({ picture: null, trouble: { kind: "slow" } });
    expect(text("monitor-note")).toBeUndefined();
    expect(text("monitor-status")).toBe("TTAM has not answered for a while.");
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
          account({
            key: "a4",
            windows: [],
            unavailable: "An API key sign-in has no plan usage.",
            plan: null,
            account: "api",
          }),
          account({
            key: "a5",
            failed: "The usage service turned the request away (a rate limit).",
            retryInMs: 5 * MIN,
            account: "old",
          }),
          account({ key: "a6", sameAs: "work", account: "other" }),
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
      ["Claude Code", "other", "Max"],
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
    const notes = (a: Element | undefined) => facts(a?.querySelector('[class*="meta"]'));
    expect(notes(accounts[3])).toEqual(["An API key sign-in has no plan usage."]);
    expect(notes(accounts[4])).toEqual([
      "The usage service turned the request away (a rate limit).",
      "Asks again in 5 min",
      "Read 2 min ago",
    ]);
    expect(notes(accounts[5])).toEqual(["Same account as work", "Read 2 min ago"]);
  });

  test("a limit read more than a minute apart from its account says how old its own reading is", async () => {
    await mount();
    const base = account().windows[0];
    if (base === undefined) throw new Error("no window");
    show({
      picture: picture(
        [],
        [account({ windows: [base, { ...base, kind: "weekly", readingAgeMs: 7 * MIN }] })],
      ),
      trouble: null,
    });
    const figures = [...container.querySelectorAll('[data-part="window"]')].map(
      (w) => w.lastElementChild?.textContent,
    );
    expect(figures).toEqual([
      "6% usedresets in 2 h 30 min",
      "6% usedresets in 2 h 30 minRead 7 min ago",
    ]);
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

/** A task of the space on screen, open, without a run. */
const task = (n: number): TaskRow => ({
  id: `t_0000${String(n)}`,
  ref: `M-${String(n)}`,
  title: `Fixture task ${String(n)}`,
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: `p${String(n)}`,
  created_at: 0,
  version: 1,
});

/**
 * The task `row` as the service links a session to it: by default to its current run, or to a
 * terminal launch of its own.
 */
const linkTo = (
  row: TaskRow,
  started: AgentsTask["started"] = "terminal",
  of = started === "run" ? (row.run?.id ?? "ru_ended") : `la_${row.id}`,
): AgentsTask => ({
  space: SPACE.id,
  spaceName: SPACE.name,
  id: row.id,
  ref: row.ref,
  started,
  of,
});

/** TTasks' own groups and labels with their rows' references, in order. */
const layout = () =>
  [...container.querySelectorAll<HTMLElement>("h2, h3, li[data-task]")]
    .filter((e) => e.closest('[data-part="computer"], [data-part="usage"]') === null)
    .map((e) => (e.tagName === "LI" ? e.dataset["task"] : `${e.tagName}:${e.textContent}`));

/** The states the agents beneath the task `ref` say, in order. */
const statesOf = (ref: string) =>
  [...container.querySelectorAll(`li[data-task="${ref}"] [data-part="agent"]`)].map(
    (li) => li.querySelector("[data-state]:not(li)")?.textContent,
  );

describe("[A5.agents.web-merge] an agent working on a task of this space is shown as the task's row", () => {
  test("by its state: needs you, working, or with an agent, its line saying which; never twice", async () => {
    const [waits, works, idle, shell, unknown, unseen] = [2, 3, 4, 5, 6, 7].map((n) => task(n));
    if (!waits || !works || !idle || !shell || !unknown || !unseen) throw new Error("no rows");
    await mount([working, waits, works, idle, shell, unknown, unseen]);
    show({
      picture: picture(
        [
          session(1, { task: linkTo(waits), activity: "waiting" }),
          session(2, { task: linkTo(works), activity: "working" }),
          session(3, { task: linkTo(idle), activity: "idle" }),
          session(4, { task: linkTo(shell), activity: "shell" }),
          session(5, { task: linkTo(unknown), activity: "unknown" }),
          session(6, { title: "Agent of no task" }),
        ],
        [],
        { unseen: [linkTo(unseen)] },
      ),
      trouble: null,
    });
    expect(layout()).toEqual([
      "H2:Needs you",
      "M-2",
      "H2:Working",
      "M-1",
      "M-3",
      "H2:With an agent",
      "M-4",
      "M-5",
      "M-6",
      "M-7",
    ]);
    expect(["M-4", "M-5", "M-6", "M-7"].flatMap(statesOf)).toEqual([
      "Idle",
      "At a shell",
      "State unknown",
      "Not seen by TTAM",
    ]);
    // "On this computer" lists only the agent no row above shows.
    expect(sessions().map(([title]) => title)).toEqual(["Agent of no task"]);
    // A session of this space whose task the page does not hold is listed, with its task's link.
    show({
      picture: picture([
        session(7, { task: { ...linkTo(waits), id: "t_absent", ref: "M-9" }, title: "Agent 7" }),
      ]),
      trouble: null,
    });
    expect(sessions().map(([title]) => title)).toEqual(["Agent 7"]);
    expect(text("session-task")).toBe("Task M-9");
  });

  test("a task with one, two or three agents is one row, with each of its agents beneath it", async () => {
    const [one, two, three] = [2, 3, 4].map((n) => task(n));
    if (!one || !two || !three) throw new Error("no rows");
    const ran: TaskRow = {
      ...three,
      run: { id: "ru_3", state: "working", instance: "fake-agent" },
    };
    await mount([one, two, ran]);
    const nested = (n: number, activity: AgentsSession["activity"]) => ({
      key: `n${String(n)}`,
      kind: "subagent" as const,
      title: `Inner ${String(n)}`,
      activity,
      ageMs: MIN,
    });
    const reported = [
      session(1, { task: linkTo(one), activity: "idle", title: "One idle" }),
      // Opened twice: one works, the other is idle with an agent inside it that waits.
      session(2, { task: linkTo(two), activity: "working", title: "Two works", ageMs: 30 * MIN }),
      session(3, {
        task: linkTo(two),
        activity: "idle",
        title: "Two rests",
        nested: [nested(1, "waiting")],
      }),
      // A background run, which keeps TTasks' own state, and two terminal agents beside it.
      session(4, { task: linkTo(ran, "run"), activity: "idle", title: "Three runs" }),
      session(5, { task: linkTo(ran), activity: "shell", title: "Three at a shell" }),
      session(6, {
        task: linkTo(ran),
        activity: "suspended",
        title: "Three suspended",
        nested: [nested(2, "working"), nested(3, "idle")],
      }),
      session(7, { title: "Agent of no task" }),
    ];
    show({ picture: picture(reported, []), trouble: null });
    // Each task once, placed by what asks most of the person: the waiting agent inside M-3.
    expect(layout()).toEqual([
      "H2:Needs you",
      "M-3",
      "H2:Working",
      "M-4",
      "H2:With an agent",
      "M-2",
    ]);
    const beneath = (ref: string) =>
      [...container.querySelectorAll(`li[data-task="${ref}"] [data-part="agent"]`)].map((li) => [
        li.querySelector("span")?.textContent,
        li.querySelector("[data-state]:not(li)")?.textContent,
      ]);
    expect(beneath("M-2")).toEqual([["One idle", "Idle"]]);
    expect(beneath("M-3")).toEqual([
      ["Two works", "Working"],
      ["Two rests", "Idle"],
    ]);
    expect(beneath("M-4")).toEqual([
      ["Three runs", "Working"],
      ["Three at a shell", "At a shell"],
      ["Three suspended", "Suspended"],
    ]);
    // No agent the monitor reports is on neither list, and none is on both.
    const listed = container.querySelectorAll('[data-part="agent"], [data-part="session"]');
    expect(listed).toHaveLength(reported.length);
    expect(container.querySelectorAll('[data-part="nested"]')).toHaveLength(3);
    expect(sessions().map(([title]) => title)).toEqual(["Agent of no task"]);
  });

  test("a background run the monitor does not see is listed beside the task's other agents", async () => {
    const ran: TaskRow = {
      ...working,
      run: { id: "ru_1", state: "needs_you", instance: "fake-agent" },
    };
    const gone = task(2);
    await mount([ran, gone]);
    show({
      picture: picture([session(1, { task: linkTo(ran), activity: "working" })], [], {
        unseen: [linkTo(gone)],
      }),
      trouble: null,
    });
    expect(layout()).toEqual(["H2:Needs you", "M-1", "H2:With an agent", "M-2"]);
    const states = (ref: string) =>
      [...container.querySelectorAll(`li[data-task="${ref}"] [data-part="agent"]`)].map(
        (li) => li.textContent,
      );
    expect(states("M-1")[0]).toBe("Background runNeeds you");
    expect(states("M-2")).toEqual(["Agent in a terminalNot seen by TTAM"]);
  });

  test("a conversation of an earlier run resumed by hand is an agent of its own beside the current run", async () => {
    const ran: TaskRow = { ...working, run: { id: "ru_new", state: "working", instance: "x" } };
    await mount([ran]);
    const earlier = session(1, {
      task: linkTo(ran, "run", "ru_old"),
      activity: "waiting",
      title: "Earlier conversation",
    });
    const agents = () =>
      [...container.querySelectorAll('li[data-task="M-1"] [data-part="agent"]')].map((li) => [
        li.querySelector("span")?.textContent,
        li.querySelector("[data-state]:not(li)")?.textContent,
      ]);
    // The monitor does not see the current run: TTasks' own line, and the earlier conversation.
    show({ picture: picture([earlier], []), trouble: null });
    expect(layout()).toEqual(["H2:Needs you", "M-1"]);
    expect(agents()).toEqual([
      ["Background run", "Working"],
      ["Earlier conversation", "Needs you"],
    ]);
    // It sees both: each its own line, the current run in TTasks' state.
    const current = session(2, {
      task: linkTo(ran, "run"),
      activity: "idle",
      title: "Current run",
    });
    show({ picture: picture([earlier, current], []), trouble: null });
    expect(layout()).toEqual(["H2:Needs you", "M-1"]);
    expect(agents()).toEqual([
      ["Current run", "Working"],
      ["Earlier conversation", "Needs you"],
    ]);
    expect(sessions()).toEqual([]);
  });

  test("TTasks' own rows come first; the monitor's follow as their agents started; only what changed moves", async () => {
    const [older, newer, newest] = [2, 3, 4].map((n) => task(n));
    if (!older || !newer || !newest) throw new Error("no rows");
    await mount([working, older, newer, newest]);
    const at = (olderState: AgentsSession["activity"], newerState: AgentsSession["activity"]) => ({
      picture: picture(
        [
          session(1, { task: linkTo(newest), activity: "working", ageMs: MIN }),
          session(2, { task: linkTo(newer), activity: newerState, ageMs: 20 * MIN }),
          session(3, { task: linkTo(older), activity: olderState, ageMs: 40 * MIN }),
        ],
        [],
      ),
      trouble: null,
    });
    show(at("idle", "working"));
    expect(layout()).toEqual(["H2:Working", "M-1", "M-3", "M-4", "H2:With an agent", "M-2"]);
    // The older agent starts working: it joins Working after TTasks' own run, at its start.
    show(at("working", "working"));
    expect(layout()).toEqual(["H2:Working", "M-1", "M-2", "M-3", "M-4"]);
    // One leaves the group: the others keep their order.
    show(at("working", "idle"));
    expect(layout()).toEqual(["H2:Working", "M-1", "M-2", "M-4", "H2:With an agent", "M-3"]);
  });

  test("an expanded task stays once, at its place, whatever the next picture says; its lines say what is true now", async () => {
    const [idle, shell, other] = [2, 3, 4].map((n) => task(n));
    if (!idle || !shell || !other) throw new Error("no rows");
    await mount([idle, shell, other]);
    const at = (shellState: AgentsSession["activity"], otherState: AgentsSession["activity"]) => ({
      picture: picture(
        [
          session(1, { task: linkTo(idle), activity: "idle" }),
          session(2, { task: linkTo(shell), activity: shellState }),
          session(3, { task: linkTo(other), activity: otherState }),
        ],
        [],
      ),
      trouble: null,
    });
    show(at("shell", "idle"));
    const before = ["H2:With an agent", "M-2", "M-3", "M-4"];
    expect(layout()).toEqual(before);
    await act(async () => {
      container.querySelector<HTMLElement>('li[data-task="M-3"] [data-part="title"]')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('li[data-task="M-3"]')?.getAttribute("data-expanded")).toBe(
      "true",
    );
    // The same picture again: nothing moves.
    show(at("shell", "idle"));
    show(at("shell", "idle"));
    expect(layout()).toEqual(before);
    // Its agent now works and another task's waits: the expanded task stays where it is, once,
    // and its line says it works; the other moves.
    show(at("working", "waiting"));
    expect(layout()).toEqual(["H2:Needs you", "M-4", "H2:With an agent", "M-2", "M-3"]);
    expect(statesOf("M-3")).toEqual(["Working"]);
    // Collapsed, it goes where its agent puts it.
    await act(async () => {
      container.querySelector<HTMLElement>('li[data-task="M-3"] [data-part="title"]')?.click();
      await Promise.resolve();
    });
    expect(layout()).toEqual([
      "H2:Needs you",
      "M-4",
      "H2:Working",
      "M-3",
      "H2:With an agent",
      "M-2",
    ]);
  });

  test("an expanded task whose agent was not seen stays at its place when the monitor's word is withdrawn", async () => {
    const gone = task(2);
    await mount([working, gone]);
    show({ picture: picture([], [], { unseen: [linkTo(gone)] }), trouble: null });
    expect(layout()).toEqual(["H2:Working", "M-1", "H2:With an agent", "M-2"]);
    await act(async () => {
      container.querySelector<HTMLElement>('li[data-task="M-2"] [data-part="title"]')?.click();
      await Promise.resolve();
    });
    expect(statesOf("M-2")).toEqual(["Not seen by TTAM"]);
    // Its home is gone, or the monitor cannot look there: nothing says it is unseen any more.
    show({ picture: picture([], []), trouble: null });
    expect(layout()).toEqual(["H2:Working", "M-1", "H2:With an agent", "M-2"]);
    expect(statesOf("M-2")).toEqual([]);
    expect(container.textContent).not.toContain("Not seen by TTAM");
    // The monitor sees it again: its line says what it does.
    show({
      picture: picture([session(1, { task: linkTo(gone), activity: "idle" })], []),
      trouble: null,
    });
    expect(layout()).toEqual(["H2:Working", "M-1", "H2:With an agent", "M-2"]);
    expect(statesOf("M-2")).toEqual(["Idle"]);
  });

  test("a background run's row keeps TTasks' own state, and its agent is that row", async () => {
    await mount();
    show({
      picture: picture([session(1, { task: linkTo(working, "run"), activity: "idle" })]),
      trouble: null,
    });
    expect(layout()).toEqual(["H2:Working", "M-1"]);
    expect(sessions()).toEqual([]);
    expect(text("monitor-status")).toBe("");
  });

  test("an agent of another space is listed with a link that opens its task there", async () => {
    await mount();
    show({
      picture: picture([
        session(1, {
          task: {
            space: "sp_9876543210abcdefghjkmnpqrs",
            spaceName: "Studio",
            id: "t_studio",
            ref: "S-4",
            started: "terminal",
            of: "la_studio",
          },
          title: "Agent of Studio",
        }),
      ]),
      trouble: null,
    });
    const link = container.querySelector<HTMLAnchorElement>('[data-part="session-task"]');
    expect(link?.textContent).toBe("Task S-4 in Studio");
    expect(link?.getAttribute("href")).toBe("/s/sp_9876543210abcdefghjkmnpqrs/agents?task=S-4");
  });

  test("a picture that is not current mutes the rows it placed, and moves none", async () => {
    const waits = task(2);
    await mount([working, waits]);
    show({
      picture: picture([session(1, { task: linkTo(waits), activity: "waiting" })]),
      trouble: null,
    });
    const before = layout();
    act(() => {
      live.agents.cut();
    });
    expect(layout()).toEqual(before);
    const muted = (ref: string) =>
      container.querySelector(`li[data-task="${ref}"]`)?.hasAttribute("data-muted");
    expect(muted("M-2")).toBe(true);
    expect(muted("M-1")).toBe(false);
  });

  test("two folders of one name are told apart by as much of their paths as it takes", async () => {
    await mount();
    show({
      picture: picture([
        session(1, { folder: "/home/mira/work/portal" }),
        session(2, { folder: "/home/mira/play/portal" }),
        session(3, { folder: "/home/mira/api" }),
      ]),
      trouble: null,
    });
    const folders = [...container.querySelectorAll('[data-part="session"] [title]')].map(
      (e) => e.textContent,
    );
    expect(folders.sort()).toEqual(["api", "…/play/portal", "…/work/portal"]);
  });

  test("a folder's label is bounded, whatever ending two folders share; the tip has the whole path", async () => {
    await mount();
    const shared = "clients/northwind-traders-international/appointments-portal-frontend/src";
    const a = `/home/mira/alpha/${shared}`;
    const b = `/home/mira/beta/${shared}`;
    show({
      picture: picture([session(1, { folder: a }), session(2, { folder: b })]),
      trouble: null,
    });
    const shown = [...container.querySelectorAll<HTMLElement>('[data-part="session"] [title]')];
    expect(shown.map((e) => e.title).sort()).toEqual([a, b]);
    for (const label of shown.map((e) => e.textContent)) {
      expect(label.length).toBeLessThanOrEqual(40);
      expect(label.startsWith("…")).toBe(true);
      expect(label.endsWith("/src")).toBe(true);
    }
  });
});
