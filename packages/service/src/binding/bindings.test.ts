// The binding service on its own (A3 3.7.3, 3.7.4): records that survive a restart through their
// store and are checked when read back, one binding per launch when two connections redeem it at
// once, and a store that cannot write. A fake launch side and a clock; no service, no files.
import { describe, expect, test } from "vitest";
import type { LaunchIntent } from "@tasks/launch";
import { newId } from "@tasks/storage";
import { sessionPrincipal, type FoundLaunch, type ServedSpace } from "../ops/index.ts";
import { Bindings, type BindingEvent, type LaunchPort } from "./bindings.ts";
import { MAX_SESSIONS, MemorySessionStore, parseSessions, type SessionStore } from "./sessions.ts";

const SPACE = newId("sp");
const TASK = newId("t");
const MACHINE = newId("m");
const served: ServedSpace = {
  id: SPACE,
  name: "Mira",
  state: "open",
  writer: undefined,
  reader: undefined,
};

/** A launch side whose launches take the first binding they are told of, after `delayMs`. */
function launchSide(delayMs = 0): LaunchPort & { readonly bound: Map<string, number> } {
  const bound = new Map<string, number>();
  return {
    bound,
    bridgeTicket: () => undefined,
    redeemBridge: () => undefined,
    agentRuns: () => false,
    confirm: async (_space, launch, at) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!bound.has(launch)) bound.set(launch, at);
      return {
        id: launch,
        state: "confirmed",
        evidence: { bound_at: bound.get(launch) },
      } as unknown as LaunchIntent;
    },
  };
}

function bindings(
  options: { store?: SessionStore; launches?: LaunchPort; now?: () => number } = {},
): { bindings: Bindings; events: BindingEvent[] } {
  const events: BindingEvent[] = [];
  return {
    events,
    bindings: new Bindings({
      store: options.store ?? new MemorySessionStore(),
      machine: MACHINE,
      spaces: () => [served],
      launches: options.launches ?? launchSide(),
      log: (event) => events.push(event),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  };
}

const context = (extra: Record<string, unknown> = {}) => ({
  context: { space: SPACE, instance: "unit-agent", app: "unit", env: {}, ...extra },
});

const launchOf = (id = newId("la")): FoundLaunch => ({
  id,
  reference: "L0000",
  space: SPACE,
  task: TASK,
  taskRef: "M-1",
  state: "dispatched",
  route: "clipboard",
  boundAt: undefined,
  exited: false,
});

describe("[A3.3.7.binding.records] session records and handles", () => {
  test("a binding survives a restart through its store, and its handle restores it", async () => {
    const store = new MemorySessionStore();
    const first = bindings({ store }).bindings;
    const connection = context();
    const result = await first.bridge(connection);
    const slot = first.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    expect(await first.bindTask(slot, SPACE, TASK)).toEqual({ kind: "bound" });

    const restarted = bindings({ store }).bindings;
    const again = context({ resume: { handle: result["handle"] } });
    expect(await restarted.bridge(again)).toMatchObject({
      state: "bound",
      handle: result["handle"],
      space: SPACE,
    });
    expect(restarted.attach(again)?.session).toMatchObject({ task: TASK, instance: "unit-agent" });
    // The store holds the handle's hash, never the handle.
    expect(store.text).not.toContain(String(result["handle"]));
  });

  test("records read back are checked one by one: a bad one is left out and counted", () => {
    const good = {
      id: newId("se"),
      space: SPACE,
      task: TASK,
      instance: "unit-agent",
      via: "task",
      launches: [],
      native: [],
      created_at: 1,
      seen_at: 1,
    };
    const parsed = parseSessions(
      JSON.stringify({
        format: 1,
        sessions: [
          good,
          { ...good, id: "se_not-an-id" },
          { ...good, instance: "Has Spaces" },
          { ...good, via: "folder" },
          { ...good, native: [{ source: "claude", id: "a line\nbreak" }] },
        ],
        handles: [{ hash: "00", instance: "unit-agent" }],
      }),
    );
    expect(parsed.state.sessions).toEqual([good]);
    expect(parsed.state.handles).toEqual([]);
    expect(parsed.dropped).toBe(5);
    expect(parseSessions("not json").dropped).toBe(1);

    const store = new MemorySessionStore();
    store.text = JSON.stringify({ format: 1, sessions: [{ ...good, via: "folder" }], handles: [] });
    expect(bindings({ store }).events).toEqual([{ ev: "binding.store_dropped", count: 1 }]);
  });

  test("two connections redeem one launch at once: one binds, the other gets launch_used", async () => {
    const launches = launchSide(20);
    const { bindings: b } = bindings({ launches });
    const slots = await Promise.all(
      [1, 2].map(async () => {
        const connection = context();
        await b.bridge(connection);
        const slot = b.attach(connection);
        if (slot === undefined) throw new Error("no slot");
        return slot;
      }),
    );
    const launch = launchOf();
    const outcomes = await Promise.all(slots.map((slot) => b.redeem(slot, launch)));
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["bound", "launch_used"]);
    expect(slots.filter((slot) => slot.session !== undefined)).toHaveLength(1);
    expect(launches.bound.size).toBe(1);
  });

  test("a launch that holds another binding already binds nothing, and leaves no session", async () => {
    const launches = launchSide();
    const launch = launchOf();
    launches.bound.set(launch.id, 1_000);
    const { bindings: b } = bindings({ launches });
    const connection = context();
    await b.bridge(connection);
    const slot = b.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    expect(await b.redeem(slot, launch)).toEqual({ kind: "launch_used" });
    expect(slot.session).toBeUndefined();
    expect(b.sessionOfLaunch(launch.id)).toBeUndefined();
  });

  test("a store that cannot write: nothing binds and nothing is spent, and the failure is logged", async () => {
    const failing: SessionStore = {
      load: () => ({ state: { sessions: [], handles: [] }, dropped: 0 }),
      save: () => {
        throw new Error("disk full");
      },
    };
    const launch = newId("la");
    let spent = 0;
    const side = launchSide();
    const launches: LaunchPort = {
      ...side,
      bridgeTicket: () => ({ space: SPACE, launch, task: TASK, used: spent > 0, inWindow: true }),
      redeemBridge: () => {
        spent += 1;
        return { space: SPACE, launch };
      },
      agentRuns: () => true,
    };
    const { bindings: b, events } = bindings({ store: failing, launches });
    // The ticket's role is spent only once its session is on disk: here it never is.
    const connection = context({ env: { TASKS_TICKET: "fixture-ticket" } });
    expect(await b.bridge(connection)).toMatchObject({ state: "unbound" });
    expect(spent).toBe(0);
    const slot = b.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    expect(slot.session).toBeUndefined();
    // A reference's evidence is recorded in the space only once its session is on disk.
    await expect(b.redeem(slot, launchOf())).rejects.toMatchObject({ code: "internal" });
    await expect(b.bindTask(slot, SPACE, TASK)).rejects.toMatchObject({ code: "internal" });
    expect(slot.session).toBeUndefined();
    expect(side.bound.size).toBe(0);
    expect(events.some((e) => e.ev === "binding.store_failed")).toBe(true);
  });

  test("a connection unbound at its bind keeps its unbound scope as a receipt lookup, on disk with its handle, whatever is written later", async () => {
    let saves = 0;
    const store = new MemorySessionStore();
    const flaky: SessionStore = {
      load: () => store.load(),
      save: (state) => {
        saves += 1;
        // The handle's own first write lands; every later one fails.
        if (saves > 1) throw new Error("disk full");
        store.save(state);
      },
    };
    const first = bindings({ store: flaky }).bindings;
    const connection = context();
    const result = await first.bridge(connection);
    const slot = first.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    expect(slot.wroteUnbound).toBe(true);
    // An unbound write's marker cannot reach the disk now: it is there already.
    await first.use(slot);

    const restarted = bindings({ store }).bindings;
    const again = context({ resume: { handle: result["handle"] } });
    await restarted.bridge(again);
    const resumed = restarted.attach(again);
    if (resumed === undefined) throw new Error("no slot");
    expect(await restarted.bindTask(resumed, SPACE, TASK)).toEqual({ kind: "bound" });
    expect(resumed.wroteUnbound).toBe(true);
    const session = resumed.session;
    if (session === undefined) throw new Error("not bound");
    expect(sessionPrincipal(resumed, session).earlierScope).toBe(`bridge:unit-agent:${MACHINE}`);
  });

  test("a ticket presented again binds only once its slot is on disk", async () => {
    let failing = false;
    const store = new MemorySessionStore();
    const flaky: SessionStore = {
      load: () => store.load(),
      save: (state) => {
        if (failing) throw new Error("disk full");
        store.save(state);
      },
    };
    const launch = newId("la");
    let spent = false;
    const launches: LaunchPort = {
      ...launchSide(),
      bridgeTicket: () => ({ space: SPACE, launch, task: TASK, used: spent, inWindow: true }),
      redeemBridge: () => {
        spent = true;
        return { space: SPACE, launch };
      },
      agentRuns: () => true,
    };
    const { bindings: b } = bindings({ store: flaky, launches });
    const NATIVE = "11111111-2222-4333-8444-555555555555";
    const env = { TASKS_TICKET: "fixture-ticket", CLAUDE_CODE_SESSION_ID: NATIVE };
    const connection = context({ env });
    expect(await b.bridge(connection)).toMatchObject({ state: "bound" });
    const firstSlot = b.attach(connection);
    if (firstSlot === undefined) throw new Error("no slot");
    b.closed(firstSlot);

    failing = true;
    const again = context({ env });
    expect(await b.bridge(again)).toMatchObject({ state: "unbound" });
    expect(b.attach(again)?.session).toBeUndefined();
    failing = false;
    expect(await b.bridge(context({ env }))).toMatchObject({ state: "bound" });
  });

  test("a connection that carries two conversations stays shared after a reconnect or a restart: another thread's ID joins no session", async () => {
    const store = new MemorySessionStore();
    const first = bindings({ store }).bindings;
    const A = "019a0000-0000-7000-8000-00000000000a";
    const B = "019a0000-0000-7000-8000-00000000000b";
    const connection = context();
    const result = await first.bridge(connection);
    const slot = first.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    expect(first.forCall(slot, "codex", A)).toBe(slot);
    expect(await first.bindTask(slot, SPACE, TASK)).toEqual({ kind: "bound" });
    expect(first.forCall(slot, "codex", B)).toBeUndefined();
    expect(first.forCall(slot, "codex", A)).toBe(slot);
    first.closed(slot);

    // A reconnect with the handle, thread B's call first.
    for (const service of [first, bindings({ store }).bindings]) {
      const again = context({ resume: { handle: result["handle"] } });
      expect(await service.bridge(again)).toMatchObject({ state: "bound" });
      const resumed = service.attach(again);
      if (resumed === undefined) throw new Error("no slot");
      expect(service.forCall(resumed, "codex", B)).toBeUndefined();
      expect(service.forCall(resumed, "codex", undefined)).toBeUndefined();
      expect(service.forCall(resumed, "codex", A)).toBe(resumed);
      service.closed(resumed);
    }
  });

  test("a bound session's own thread ID, seen first through a new connection, is checked against the session: another thread's is not taken for it", async () => {
    const { bindings: b } = bindings();
    const A = "019a0000-0000-7000-8000-00000000000a";
    const B = "019a0000-0000-7000-8000-00000000000b";
    const connection = context();
    const result = await b.bridge(connection);
    const slot = b.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    b.forCall(slot, "codex", A);
    await b.bindTask(slot, SPACE, TASK);
    b.closed(slot);
    // Not shared yet on this connection, but the session holds A: B is another conversation.
    const again = context({ resume: { handle: result["handle"] } });
    await b.bridge(again);
    const resumed = b.attach(again);
    if (resumed === undefined) throw new Error("no slot");
    expect(b.forCall(resumed, "codex", B)).toBeUndefined();
    expect(resumed.shared).toBe(true);
  });

  test("a reference bind the launch does not take leaves no slot bound to its session, a resumed one included; calls made meanwhile wait for its outcome", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const launches: LaunchPort = {
      ...launchSide(),
      confirm: async (_space, launch) => {
        await gate;
        // It failed meanwhile: it takes no binding.
        return { id: launch, state: "failed", evidence: {} } as unknown as LaunchIntent;
      },
    };
    const { bindings: b } = bindings({ launches });
    const connection = context();
    const first = await b.bridge(connection);
    const slot = b.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    const redeeming = b.redeem(slot, launchOf());
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The bridge reconnects with its handle while the launch has not answered.
    const again = context({ resume: { handle: first["handle"] } });
    await b.bridge(again);
    const resumed = b.attach(again);
    if (resumed === undefined) throw new Error("no slot");
    let entered = false;
    const using = b.use(resumed).then(() => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(entered).toBe(false);

    open();
    expect(await redeeming).toEqual({ kind: "launch_ended" });
    await using;
    expect(slot.session).toBeUndefined();
    expect(resumed.session).toBeUndefined();
    // Not lost: it was never bound, so its calls ask for a task as any unbound call does.
    expect(resumed.lost).toBe(false);
  });

  test("a launch whose store does not answer binds nothing yet: the same connection's retry asks again with the same instant, and a late write is its own", async () => {
    const recorded = launchSide();
    let calls = 0;
    const launches: LaunchPort = {
      ...recorded,
      confirm: async (space, launch, at) => {
        calls += 1;
        // The first answer is lost, though its write lands late.
        const after = await recorded.confirm(space, launch, at);
        if (calls === 1) throw new Error("the store did not answer");
        return after;
      },
    };
    const { bindings: b } = bindings({ launches });
    const connection = context();
    const result = await b.bridge(connection);
    const slot = b.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    const launch = launchOf();
    await expect(b.redeem(slot, launch)).rejects.toThrow();
    expect(slot.session).toBeUndefined();
    const landed = recorded.bound.get(launch.id);
    expect(landed).toBeDefined();

    // Another connection: the launch holds a binding, and not its own.
    const other = context();
    await b.bridge(other);
    const otherSlot = b.attach(other);
    if (otherSlot === undefined) throw new Error("no slot");
    expect(await b.redeem(otherSlot, { ...launch, boundAt: landed })).toEqual({
      kind: "launch_used",
    });

    // The same connection, reconnected with its handle: the binding the launch holds is its own.
    b.closed(slot);
    const again = context({ resume: { handle: result["handle"] } });
    await b.bridge(again);
    const resumed = b.attach(again);
    if (resumed === undefined) throw new Error("no slot");
    expect(await b.redeem(resumed, { ...launch, boundAt: landed })).toEqual({ kind: "bound" });
    expect(resumed.session?.launches).toEqual([launch.id]);
  });

  test("a launch whose store does not answer, then answers that it takes no binding: nothing stays bound", async () => {
    let calls = 0;
    const launches: LaunchPort = {
      ...launchSide(),
      confirm: (_space, launch) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("the store did not answer"));
        // A terminal launch no shim claimed: it takes no binding.
        return Promise.resolve({
          id: launch,
          state: "dispatched",
          evidence: {},
        } as unknown as LaunchIntent);
      },
    };
    const { bindings: b } = bindings({ launches });
    const connection = context();
    await b.bridge(connection);
    const slot = b.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    const launch = launchOf();
    await expect(b.redeem(slot, launch)).rejects.toThrow();
    expect(slot.session).toBeUndefined();
    expect(await b.redeem(slot, launch)).toEqual({ kind: "launch_unknown" });
    expect(slot.session).toBeUndefined();
    expect(b.sessionOfLaunch(launch.id)).toBeUndefined();
  });

  test("at capacity a bind makes room without evicting a live session, and survives a restart", async () => {
    let now = 1_000;
    const store = new MemorySessionStore();
    // MAX_SESSIONS records seen later than the live one below, none of them live.
    const older = Array.from({ length: MAX_SESSIONS - 1 }, (_, i) => ({
      id: newId("se"),
      space: SPACE,
      task: TASK,
      instance: "unit-agent",
      via: "task",
      launches: [],
      native: [],
      created_at: 5_000 + i,
      seen_at: 5_000 + i,
    }));
    store.text = JSON.stringify({ format: 1, sessions: older, handles: [] });
    const first = bindings({ store, now: () => now }).bindings;

    // The live one: the least recently seen, and open.
    const live = context();
    await first.bridge(live);
    const liveSlot = first.attach(live);
    if (liveSlot === undefined) throw new Error("no slot");
    expect(await first.bindTask(liveSlot, SPACE, TASK)).toEqual({ kind: "bound" });
    const liveSession = liveSlot.session?.id;

    // One more past the capacity.
    now = 2_000;
    const late = context();
    const lateResult = await first.bridge(late);
    const lateSlot = first.attach(late);
    if (lateSlot === undefined) throw new Error("no slot");
    expect(await first.bindTask(lateSlot, SPACE, TASK)).toEqual({ kind: "bound" });
    await first.use(liveSlot);
    expect(liveSlot.session?.id).toBe(liveSession);
    const saved = parseSessions(store.text).state.sessions;
    expect(saved.length).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(saved.some((s) => s.id === liveSession)).toBe(true);

    // After a restart, the newest binding is still there.
    const restarted = bindings({ store, now: () => now }).bindings;
    expect(
      await restarted.bridge(context({ resume: { handle: lateResult["handle"] } })),
    ).toMatchObject({ state: "bound" });
  });

  test("native IDs a connection presents join its session at a bind, bounded and checked", async () => {
    const { bindings: b } = bindings();
    const connection = context({
      env: {
        CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555",
        T3CODE_THREAD_ID: "x y",
      },
    });
    await b.bridge(connection);
    const slot = b.attach(connection);
    if (slot === undefined) throw new Error("no slot");
    // A value with a blank is no ID: left out.
    expect([...slot.presented.keys()]).toEqual(["claude"]);
    b.present(slot, "codex", "019a0000-0000-7000-8000-000000000000");
    await b.bindTask(slot, SPACE, TASK);
    expect([...slot.presented.keys()].sort()).toEqual(["claude", "codex"]);
  });
});
