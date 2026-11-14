// Binding complete (A3 3.7, A4 3.10, M4.06) on the binding service alone: sessions made with their
// launch intent, rule 3 (a native ID a launch set or received binds alone), shared hosts and
// per-call binding, the user's end, unbind and rebind, and the session list with its Resume rule.
// A fake launch side, fake launch intents and a clock; no service, no files.
import { describe, expect, test } from "vitest";
import type { LaunchIntent } from "@tasks/launch";
import { newId } from "@tasks/storage";
import type { HomeGate, ServedSpace, Slot } from "../ops/index.ts";
import { Bindings, SESSION_STALE_MS, type BindingEvent, type LaunchPort } from "./bindings.ts";
import type { Ancestry } from "./hosts.ts";
import { MemorySessionStore, parseSessions, type SessionStore } from "./sessions.ts";

const SPACE = newId("sp");
const TASK = newId("t");
const OTHER_TASK = newId("t");
const MACHINE = newId("m");
const CLAUDE = "11111111-2222-4333-8444-555555555555";
const THREAD = "019a0000-0000-7000-8000-0000000000c1";
const T3_THREAD = "t3-thread-fixture-1";
const served: ServedSpace = {
  id: SPACE,
  name: "Mira",
  state: "open",
  writer: undefined,
  reader: undefined,
};

/** A launch side whose launches take the first binding they are told of; agents run when told. */
function launchSide(): LaunchPort & {
  readonly bound: Map<string, number>;
  readonly running: Set<string>;
  readonly tickets: Map<string, { launch: string; used: boolean }>;
} {
  const bound = new Map<string, number>();
  const running = new Set<string>();
  const tickets = new Map<string, { launch: string; used: boolean }>();
  return {
    bound,
    running,
    tickets,
    bridgeTicket: (ticket) => {
      const found = tickets.get(ticket);
      return found === undefined
        ? undefined
        : { launch: found.launch, space: SPACE, task: TASK, used: found.used, inWindow: true };
    },
    redeemBridge: (ticket) => {
      const found = tickets.get(ticket);
      if (found === undefined || found.used) return undefined;
      found.used = true;
      return { space: SPACE, launch: found.launch };
    },
    agentRuns: (launch) => running.has(launch),
    confirm: (_space, launch, at) => {
      if (!bound.has(launch)) bound.set(launch, at);
      return Promise.resolve({
        id: launch,
        state: "confirmed",
        evidence: { bound_at: bound.get(launch) },
      } as unknown as LaunchIntent);
    },
  };
}

function bindings(
  options: {
    store?: SessionStore;
    launches?: LaunchPort;
    now?: () => number;
    homes?: HomeGate;
    ancestry?: Ancestry;
    instances?: () => readonly { id: string; target: string; enabled: boolean }[];
  } = {},
): { bindings: Bindings; events: BindingEvent[] } {
  const events: BindingEvent[] = [];
  return {
    events,
    bindings: new Bindings({
      store: options.store ?? new MemorySessionStore(),
      machine: MACHINE,
      homes: options.homes ?? { may: () => true },
      spaces: () => [served],
      launches: options.launches ?? launchSide(),
      log: (event) => events.push(event),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.ancestry === undefined ? {} : { ancestry: options.ancestry }),
      ...(options.instances === undefined ? {} : { instances: options.instances }),
    }),
  };
}

/** A launch intent as the space records it: a new click unless told otherwise. */
const intentOf = (over: Partial<LaunchIntent> = {}): LaunchIntent => ({
  id: newId("la"),
  reference: "L00000",
  task: TASK,
  session: null,
  machine: MACHINE,
  instance: "unit-agent",
  route: "terminal",
  place: null,
  folderKind: "work_folder",
  taskVersion: 1,
  briefHash: null,
  state: "prepared",
  reason: null,
  evidence: {},
  at: {},
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  ...over,
});

const context = (extra: Record<string, unknown> = {}) => ({
  context: { space: SPACE, instance: "unit-agent", app: "unit", env: {}, ...extra },
});

/** One connection bound as the endpoint binds it. */
async function connect(
  b: Bindings,
  extra: Record<string, unknown> = {},
): Promise<{ slot: Slot; state: unknown; handle: unknown }> {
  const connection = context(extra);
  const result = await b.bridge(connection);
  const slot = b.attach(connection);
  if (slot === undefined) throw new Error("no slot");
  return { slot, state: result["state"], handle: result["handle"] };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("[A3.3.7.binding.launch-session] a launch's session is made with its intent, before dispatch", () => {
  test("a new click makes one session, a repeat or a later record of it makes none, a routine's none", () => {
    const store = new MemorySessionStore();
    const { bindings: b } = bindings({ store });
    const intent = intentOf({ evidence: { preset: CLAUDE } });
    b.launched(SPACE, intent);
    b.launched(SPACE, intent);
    b.launched(SPACE, { ...intent, state: "dispatching" });
    const session = b.sessionOfLaunch(intent.id);
    expect(session).toMatchObject({ space: SPACE, task: TASK, instance: "unit-agent" });
    // On disk before anything else happens, with no via: no agent bound it yet.
    const kept = parseSessions(store.text ?? "").state.sessions;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ via: null, opened_with: "unit-agent", route: "terminal" });
    expect(kept[0]?.native).toEqual([{ source: "claude", id: CLAUDE, trust: "preset" }]);
    // A record that is not a new click makes none, nor does a routine's launch.
    const late = intentOf({ state: "dispatched" });
    b.launched(SPACE, late);
    b.launched(SPACE, intentOf({ task: null }));
    expect(b.sessionOfLaunch(late.id)).toBeUndefined();
    expect(parseSessions(store.text ?? "").state.sessions).toHaveLength(1);
  });

  test("a CLI call with the ticket maps to the session before any bridge bound; the bridge then binds that session and takes its instance", async () => {
    const launches = launchSide();
    const { bindings: b } = bindings({ launches });
    const intent = intentOf({ instance: "launch-instance" });
    b.launched(SPACE, intent);
    launches.tickets.set("ticket-1", { launch: intent.id, used: false });
    launches.running.add(intent.id);
    const mapped = b.mapped({ TASKS_TICKET: "ticket-1" });
    const made = b.sessionOfLaunch(intent.id)?.id;
    expect(mapped?.session).toMatchObject({ id: made, task: TASK, instance: "launch-instance" });
    if (mapped === undefined) throw new Error("no mapping");
    await b.use(mapped);
    expect(mapped.session?.id).toBe(made);
    // The bridge's ticket binds that session, for the bridge's agent home.
    const bridge = await connect(b, { env: { TASKS_TICKET: "ticket-1" } });
    expect(bridge.state).toBe("bound");
    expect(bridge.slot.session).toMatchObject({ id: made, instance: "unit-agent" });
    await settled();
    expect(launches.bound.has(intent.id)).toBe(true);
    expect(b.sessionsOf(SPACE, TASK)[0]).toMatchObject({ id: made, via: "ticket", state: "live" });
  });

  test("a launch reference binds the waiting session; taken back when the launch does not take it", async () => {
    const launches = launchSide();
    const { bindings: b } = bindings({ launches });
    const intent = intentOf({ route: "clipboard", instance: "clipboard" });
    b.launched(SPACE, intent);
    const made = b.sessionOfLaunch(intent.id)?.id;
    const found = {
      id: intent.id,
      reference: "L00000",
      space: SPACE,
      task: TASK,
      taskRef: "M-1",
      state: "dispatched",
      route: "clipboard",
      boundAt: undefined,
      exited: false,
    };
    const first = await connect(b);
    expect(await b.redeem(first.slot, found)).toEqual({ kind: "bound" });
    expect(first.slot.session?.id).toBe(made);
    const second = await connect(b);
    expect(await b.redeem(second.slot, found)).toEqual({ kind: "launch_used" });

    // A launch that refuses the binding: the waiting session is as it was, nothing bound.
    const refusing: LaunchPort = {
      ...launchSide(),
      confirm: () => Promise.resolve(undefined),
    };
    const other = bindings({ launches: refusing }).bindings;
    const waiting = intentOf();
    other.launched(SPACE, waiting);
    const slot = (await connect(other)).slot;
    expect(await other.redeem(slot, { ...found, id: waiting.id })).toEqual({
      kind: "launch_unknown",
    });
    expect(slot.session).toBeUndefined();
    expect(other.sessionsOf(SPACE, TASK)[0]).toMatchObject({ state: "opening" });
  });

  test("a session no agent bound ends stale after 7 quiet days, and its ticket binds nothing then", async () => {
    let now = 1_800_000_000_000;
    const launches = launchSide();
    const { bindings: b, events } = bindings({ launches, now: () => now });
    const intent = intentOf();
    b.launched(SPACE, intent);
    now += SESSION_STALE_MS - 1;
    await connect(b); // a bind frame prunes
    expect(b.sessionsOf(SPACE, TASK)[0]?.state).toBe("opening");
    now += 2 * 60_000;
    launches.tickets.set("ticket-2", { launch: intent.id, used: false });
    expect((await connect(b, { env: { TASKS_TICKET: "ticket-2" } })).state).toBe("unbound");
    expect(b.sessionsOf(SPACE, TASK)[0]).toMatchObject({ state: "ended", end_reason: "stale" });
    expect(events).toContainEqual({ ev: "binding.ignored", input: "ticket", reason: "ended" });
  });
});

describe("[A3.3.7.binding.native] a native ID a launch set or received binds alone (rule 3)", () => {
  test("Claude's preset session ID binds its session at the bind frame, the launch records it, and the same ID binds again after a restart of the MCP server", async () => {
    const launches = launchSide();
    const { bindings: b } = bindings({ launches });
    const intent = intentOf({ evidence: { preset: CLAUDE } });
    b.launched(SPACE, intent);
    const first = await connect(b, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } });
    expect(first.state).toBe("bound");
    expect(first.slot.session?.launches).toEqual([intent.id]);
    await settled();
    expect(launches.bound.has(intent.id)).toBe(true);
    expect(b.sessionsOf(SPACE, TASK)[0]).toMatchObject({ via: "native_id", state: "live" });
    const second = await connect(b, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } });
    expect(second.slot.session?.id).toBe(first.slot.session?.id);
  });

  test("T3's returned thread ID binds at the bind frame; Codex's matched thread binds at the first tool call", async () => {
    const { bindings: b } = bindings();
    const t3 = intentOf({ route: "t3-mcp" });
    b.launched(SPACE, t3);
    b.launched(SPACE, { ...t3, state: "dispatched", evidence: { thread: T3_THREAD } });
    const thread = await connect(b, { env: { T3CODE_THREAD_ID: T3_THREAD } });
    expect(thread.state).toBe("bound");
    expect(thread.slot.session?.launches).toEqual([t3.id]);

    const codex = intentOf({ task: OTHER_TASK });
    b.launched(SPACE, codex);
    b.launched(SPACE, { ...codex, state: "dispatched", evidence: { thread: THREAD } });
    const call = await connect(b);
    expect(call.state).toBe("unbound");
    expect(b.forCall(call.slot, "codex", THREAD)).toBe(call.slot);
    expect(call.slot.session).toMatchObject({ task: OTHER_TASK, launches: [codex.id] });
  });

  test("an ID a connection only presented, another instance's, two sessions' or a refused space's binds nothing; a CLI call maps by a launch's ID alone", async () => {
    let granted = true;
    const { bindings: b, events } = bindings({ homes: { may: () => granted } });
    // Presented at an ad-hoc bind: recorded, never binding alone.
    const adhoc = await connect(b, { env: { CLAUDE_CODE_SESSION_ID: "presented-only-1" } });
    await b.bindTask(adhoc.slot, SPACE, TASK);
    expect((await connect(b, { env: { CLAUDE_CODE_SESSION_ID: "presented-only-1" } })).state).toBe(
      "unbound",
    );
    // Another instance's session.
    const mine = intentOf({ evidence: { preset: CLAUDE } });
    b.launched(SPACE, mine);
    expect(
      (await connect(b, { instance: "other-agent", env: { CLAUDE_CODE_SESSION_ID: CLAUDE } }))
        .state,
    ).toBe("unbound");
    // A home that may not use the space.
    granted = false;
    expect((await connect(b, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } })).state).toBe("unbound");
    expect(events).toContainEqual({ ev: "binding.ignored", input: "native", reason: "grant" });
    granted = true;
    // A CLI call names no instance: the launch's ID alone maps it, a presented one does not.
    expect(b.mapped({ CLAUDE_CODE_SESSION_ID: CLAUDE })?.session?.launches).toEqual([mine.id]);
    expect(b.mapped({ CLAUDE_CODE_SESSION_ID: "presented-only-1" })).toBeUndefined();
    // Two live sessions holding one ID: neither, never a guess.
    b.launched(SPACE, intentOf({ evidence: { preset: CLAUDE } }));
    expect((await connect(b, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } })).state).toBe("unbound");
    expect(b.mapped({ CLAUDE_CODE_SESSION_ID: CLAUDE })).toBeUndefined();
  });
});

describe("[A3.3.7.binding.hosts] a shared host binds nothing durably; a call's own ID proves its session for that call", () => {
  test("Claude Desktop's chat is shared at its bind frame: its ticket and session-less calls bind nothing, and the ticket is not spent", async () => {
    const launches = launchSide();
    const { bindings: b, events } = bindings({ launches });
    const intent = intentOf();
    b.launched(SPACE, intent);
    launches.tickets.set("ticket-3", { launch: intent.id, used: false });
    launches.running.add(intent.id);
    const chat = await connect(b, { app: "claude-desktop", env: { TASKS_TICKET: "ticket-3" } });
    expect(chat.state).toBe("unbound");
    expect(chat.slot.shared).toBe(true);
    expect(events).toContainEqual({ ev: "binding.ignored", input: "ticket", reason: "shared" });
    expect(b.forCall(chat.slot, "codex", undefined)).toBeUndefined();
    expect(launches.tickets.get("ticket-3")?.used).toBe(false);
    // Its Code tab, which carries a session ID, is per session.
    const tab = await connect(b, {
      app: "claude-desktop",
      env: { CLAUDE_CODE_SESSION_ID: "code-tab-1" },
    });
    expect(tab.slot.shared).toBe(false);
  });

  test("a Codex connection under an app-server is shared; a call carrying a thread a launch matched acts as that session for that call only", async () => {
    const appServer: Ancestry = () =>
      Promise.resolve([{ argv: ["codex", "app-server"] }, { argv: ["Codex"] }]);
    const { bindings: b } = bindings({ ancestry: appServer });
    const intent = intentOf();
    b.launched(SPACE, intent);
    b.launched(SPACE, { ...intent, state: "dispatched", evidence: { thread: THREAD } });
    const host = await connect(b, { app: "codex", parent: { pid: 4321 } });
    expect(host.slot.shared).toBe(true);
    const call = b.forCall(host.slot, "codex", THREAD);
    expect(call).toBeDefined();
    expect(call).not.toBe(host.slot);
    expect(call?.session?.launches).toEqual([intent.id]);
    // The connection itself stays unbound: another thread's call, or one without an ID, is not it.
    expect(host.slot.session).toBeUndefined();
    expect(b.forCall(host.slot, "codex", "019a0000-0000-7000-8000-0000000000c2")).toBeUndefined();
    expect(b.forCall(host.slot, "codex", undefined)).toBeUndefined();
    // A Codex CLI (no app-server among its ancestors) is per session.
    const cli = bindings({ ancestry: () => Promise.resolve([{ argv: ["codex"] }]) }).bindings;
    expect((await connect(cli, { app: "codex", parent: { pid: 4321 } })).slot.shared).toBe(false);
  });

  test("a reference opened on a shared connection marks its waiting session opened by reference, not tracked", () => {
    const { bindings: b } = bindings();
    const intent = intentOf({ route: "clipboard", instance: "clipboard" });
    b.launched(SPACE, intent);
    b.untracked(intent.id);
    expect(b.sessionsOf(SPACE, TASK)[0]).toMatchObject({ state: "opening", untracked: true });
  });
});

describe("[A3.3.7.binding.user-ops] the user's end, unbind and rebind end a session and its handles", () => {
  test("end: its connections say their session ended, its handles answer lost, its ticket binds it no more", async () => {
    const launches = launchSide();
    const store = new MemorySessionStore();
    const { bindings: b, events } = bindings({ launches, store });
    const intent = intentOf();
    b.launched(SPACE, intent);
    launches.tickets.set("ticket-4", { launch: intent.id, used: false });
    launches.running.add(intent.id);
    const agent = await connect(b, { env: { TASKS_TICKET: "ticket-4" } });
    const id = agent.slot.session?.id ?? "";
    expect(b.end(id)).toEqual({ kind: "changed", session: id });
    expect(b.end(id)).toEqual({ kind: "no_change", session: id });
    expect(b.end(newId("se"))).toEqual({ kind: "not_found" });
    expect(agent.slot.session).toBeUndefined();
    expect(agent.slot.lost).toBe(true);
    expect(events).toContainEqual({ ev: "binding.ended", reason: "user" });
    b.closed(agent.slot);
    // After a restart of the service, the handle answers lost and the ticket binds nothing.
    const restarted = bindings({ launches, store }).bindings;
    expect(
      (
        await connect(restarted, {
          resume: { handle: agent.handle },
          env: { TASKS_TICKET: "ticket-4" },
        })
      ).state,
    ).toBe("lost");
    expect(restarted.sessionsOf(SPACE, TASK)[0]).toMatchObject({
      state: "ended",
      end_reason: "user",
    });
  });

  test("unbind: its connections and handles go on unbound, quietly, and may bind again", async () => {
    const { bindings: b } = bindings();
    const agent = await connect(b);
    await b.bindTask(agent.slot, SPACE, TASK);
    const id = agent.slot.session?.id ?? "";
    expect(b.unbind(id)).toEqual({ kind: "changed", session: id });
    expect(agent.slot.session).toBeUndefined();
    expect(agent.slot.lost).toBe(false);
    b.closed(agent.slot);
    const again = await connect(b, { resume: { handle: agent.handle } });
    expect(again.state).toBe("unbound");
    expect(await b.bindTask(again.slot, SPACE, OTHER_TASK)).toEqual({ kind: "bound" });
  });

  test("rebind: a new session on the other task takes its place, with its launches and IDs; its connections and handles follow", async () => {
    const launches = launchSide();
    const store = new MemorySessionStore();
    const { bindings: b } = bindings({ launches, store });
    const intent = intentOf({ evidence: { preset: CLAUDE } });
    b.launched(SPACE, intent);
    launches.running.add(intent.id);
    const agent = await connect(b, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } });
    const id = agent.slot.session?.id ?? "";
    expect(b.rebind(id, TASK)).toEqual({ kind: "no_change", session: id });
    const changed = b.rebind(id, OTHER_TASK);
    expect(changed).toMatchObject({ kind: "changed", session: id });
    const next = changed.kind === "changed" ? changed.next : undefined;
    expect(agent.slot.session).toMatchObject({ id: next, task: OTHER_TASK, launches: [intent.id] });
    expect(b.rebind(id, TASK)).toEqual({ kind: "ended", session: id });
    expect(b.sessionsOf(SPACE, TASK)[0]).toMatchObject({ state: "ended", end_reason: "rebound" });
    expect(b.sessionsOf(SPACE, OTHER_TASK)[0]).toMatchObject({ id: next, via: "rebind" });
    // The preset ID now binds the new session; the handle restores it after a restart.
    b.closed(agent.slot);
    const restarted = bindings({ launches, store }).bindings;
    const resumed = await connect(restarted, { resume: { handle: agent.handle } });
    expect(resumed.slot.session?.id).toBe(next);
    expect(
      (await connect(restarted, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } })).slot.session?.id,
    ).toBe(next);
  });
});

describe("[A3.3.7.binding.sessions] the session list, and Resume only with a trusted native ID", () => {
  const instances = () => [
    { id: "claude-code", target: "claude-cli", enabled: true },
    { id: "codex-work", target: "codex-cli", enabled: true },
    { id: "claude-app", target: "claude-desktop", enabled: true },
    { id: "codex-off", target: "codex-cli", enabled: false },
  ];

  test("rows newest first with their states, and Resume offered by the rule", async () => {
    let now = 1_800_000_000_000;
    const launches = launchSide();
    const { bindings: b } = bindings({ launches, instances, now: () => (now += 1_000) });
    // Claude Code with its preset: Resume.
    const preset = intentOf({ instance: "claude-code", evidence: { preset: CLAUDE } });
    b.launched(SPACE, preset);
    // Codex CLI, no thread matched yet: Open. Its matched thread, later: Resume.
    const codex = intentOf({ instance: "codex-work" });
    b.launched(SPACE, codex);
    // Claude Desktop never resumes, whatever it holds; an instance that is off neither.
    const desktop = intentOf({ instance: "claude-app", route: "link" });
    b.launched(SPACE, desktop);
    const off = intentOf({ instance: "codex-off" });
    b.launched(SPACE, off);
    b.launched(SPACE, { ...off, state: "dispatched", evidence: { thread: "019a-off-thread" } });
    // A session no launch made, whose connection showed a Claude ID: Open, never Resume.
    const adhoc = await connect(b, { env: { CLAUDE_CODE_SESSION_ID: "presented-only-2" } });
    await b.bindTask(adhoc.slot, SPACE, TASK);

    const rows = () => new Map(b.sessionsOf(SPACE, TASK).map((row) => [row.id, row]));
    const of = (launch: string) => b.sessionOfLaunch(launch)?.id ?? "";
    expect(rows().get(of(preset.id))).toMatchObject({ state: "opening", resume: true });
    expect(rows().get(of(codex.id))).toMatchObject({ state: "opening", resume: false });
    expect(rows().get(of(desktop.id))).toMatchObject({ resume: false, route: "link" });
    expect(rows().get(of(off.id))).toMatchObject({ resume: false });
    expect(rows().get(adhoc.slot.session?.id ?? "")).toMatchObject({
      state: "live",
      via: "task",
      resume: false,
    });
    b.launched(SPACE, { ...codex, state: "dispatched", evidence: { thread: THREAD } });
    expect(rows().get(of(codex.id))).toMatchObject({ resume: true });
    // Newest first, IDs, words and times only.
    const list = b.sessionsOf(SPACE, TASK);
    expect(list[0]?.id).toBe(adhoc.slot.session?.id);
    expect(JSON.stringify(list)).not.toContain(CLAUDE);
    expect(JSON.stringify(list)).not.toContain(THREAD);
    // A bound session nothing keeps alive: unknown.
    b.closed(adhoc.slot);
    expect(rows().get(adhoc.slot.session?.id ?? "")).toMatchObject({ state: "unknown" });
  });

  test("a Resume's intent joins the session it continues, which goes on", async () => {
    const { bindings: b } = bindings();
    const first = intentOf({ evidence: { preset: CLAUDE } });
    b.launched(SPACE, first);
    const agent = await connect(b, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } });
    const id = agent.slot.session?.id ?? "";
    b.end(id);
    b.closed(agent.slot);
    const resume = intentOf({ session: id });
    b.launched(SPACE, resume);
    expect(b.sessionsOf(SPACE, TASK)).toHaveLength(1);
    expect(b.sessionOfLaunch(resume.id)?.id).toBe(id);
    // The resumed agent presents the same preset ID and binds the same session.
    const resumed = await connect(b, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } });
    expect(resumed.slot.session?.id).toBe(id);
    expect(b.sessionsOf(SPACE, TASK)[0]).toMatchObject({ id, state: "live" });
  });
});
