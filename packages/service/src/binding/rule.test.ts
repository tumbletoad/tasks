// The one rule (decide.ts) and the bind's space (bridges.ts) over stand-ins for the readers: what
// the values name, a home's rows, a run's right and the machine's default.
import { describe, expect, test } from "vitest";
import type { JsonObject } from "@ttasks/bridge/protocol";
import type { Live, Named } from "../hub/named.ts";
import type { HomeRow, HomeRows } from "../hub/home-rows.ts";
import type { Decision, Presented, SessionPort } from "../ops/index.ts";
import { BindNotYet, Bridges } from "./bridges.ts";
import { decide, standing, type DecideSources } from "./decide.ts";

const S1 = "sp_00000000000000000000000001";
const S2 = "sp_00000000000000000000000002";
const TASK = "t_0k3m5n7p9q1r3s5t7v9w1x3y5z";
const HOME = "/fixture/homes/codex";

const launch = (n: number, extra: Partial<Live> = {}): Live =>
  ({
    of: "launch",
    launch: `la_${String(n).padStart(26, "0")}`,
    space: S1,
    task: TASK,
    session: `se_${String(n).padStart(26, "0")}`,
    app: "codex",
    home: HOME,
    ...extra,
  }) as Live;
/** A launch whose click recorded no `key`. */
const without = (live: Live, key: "app" | "home"): Live => {
  const copy: Record<string, unknown> = { ...live };
  Reflect.deleteProperty(copy, key);
  return copy as unknown as Live;
};
const run: Live = {
  of: "run",
  run: "ru_00000000000000000000000009",
  space: S1,
  task: TASK,
  instance: "runner",
  session: "se_00000000000000000000000009",
};

const row = (instance: string, live = true, spaces = [S1]): HomeRow => ({
  grant: `gr_${instance}`,
  instance,
  registration: undefined,
  spaces,
  live,
});

function sources(
  options: {
    named?: Named;
    rows?: HomeRows;
    allows?: boolean;
    machineDefault?: string;
  } = {},
): DecideSources {
  return {
    named: () => options.named ?? { kind: "none" },
    rows: () => options.rows ?? { kind: "rows", rows: [] },
    runAllows: () => options.allows ?? false,
    machineDefault: () => options.machineDefault,
  };
}

const one = (live: Live, by: "ticket" | "preset" = "ticket"): Named => ({ kind: "one", by, live });
const ticket = { TTASKS_TICKET: "fixture-ticket" };
const bridge = (extra: Partial<Extract<Presented, { via: "bridge" }>> = {}): Presented => ({
  via: "bridge",
  instance: "codex-a",
  app: "codex",
  env: ticket,
  held: undefined,
  ...extra,
});
const shell: Presented = { via: "shell", env: ticket };
const kindOf = (d: Decision): string =>
  d.kind === "none" ? `none${d.reason === undefined ? "" : `:${d.reason}`}` : d.kind;

describe("[A3.3.7.binding.rule] the one rule, and the space a bridge's bind settles", () => {
  test("no value is none; a value that names nothing live, a launch without app or task, two live sessions are none for the values", () => {
    expect(decide(sources(), { via: "shell", env: {} })).toEqual({ kind: "none" });
    expect(kindOf(decide(sources(), shell))).toBe("none:values");
    for (const live of [without(launch(1), "app"), launch(1, { task: null })]) {
      expect(kindOf(decide(sources({ named: one(live) }), shell))).toBe("none:values");
    }
    const two: Named = { kind: "two", ticket: launch(1), preset: launch(2) };
    expect(kindOf(decide(sources({ named: two }), shell))).toBe("none:values");
    // One of the two names nothing: the other is the session.
    const half: Named = { kind: "two", ticket: without(launch(1), "app"), preset: launch(2) };
    expect(decide(sources({ named: half }), shell)).toMatchObject({
      kind: "session",
      by: "preset",
      session: { session: launch(2).session },
    });
  });

  test("a shell is the session by the value alone; a run's shell too, with its run", () => {
    expect(decide(sources({ named: one(launch(1)) }), shell)).toEqual({
      kind: "session",
      by: "ticket",
      session: {
        session: launch(1).session,
        space: S1,
        task: TASK,
        home: { of: "launch", app: "codex", home: HOME },
      },
    });
    expect(decide(sources({ named: one(run) }), shell)).toMatchObject({
      kind: "session",
      session: { home: { of: "run", run: "ru_00000000000000000000000009", instance: "runner" } },
    });
  });

  test("a bridge presents the click's app and its home's instance: a live row's, any row's when all are revoked, manual when it never had one", () => {
    const named = one(launch(1));
    const live = sources({ named, rows: { kind: "rows", rows: [row("codex-a")] } });
    expect(decide(live, bridge())).toMatchObject({
      kind: "session",
      session: { home: { instance: "codex-a" } },
    });
    expect(kindOf(decide(live, bridge({ app: "claude-code" })))).toBe("none:app");
    expect(kindOf(decide(live, bridge({ app: null })))).toBe("none:app");
    expect(kindOf(decide(live, bridge({ instance: "codex-b" })))).toBe("none:home");
    expect(kindOf(decide(live, bridge({ instance: "Not An Instance" })))).toBe("none:home");
    expect(kindOf(decide(live, bridge({ instance: null })))).toBe("none:home");
    const revoked = sources({
      named,
      rows: { kind: "rows", rows: [row("codex-b", false), row("codex-a", false)] },
    });
    expect(kindOf(decide(revoked, bridge()))).toBe("session");
    const never = sources({ named });
    expect(decide(never, bridge({ instance: null }))).toMatchObject({
      kind: "session",
      session: { home: { instance: "manual" } },
    });
    expect(kindOf(decide(never, bridge()))).toBe("none:home");
    // A click that recorded no folder: manual too.
    const homeless = sources({ named: one(without(launch(1), "home")) });
    expect(kindOf(decide(homeless, bridge({ instance: null })))).toBe("session");
  });

  test("a run's bridge presents the run's instance, and no app is asked", () => {
    expect(
      kindOf(decide(sources({ named: one(run) }), bridge({ instance: "runner", app: null }))),
    ).toBe("session");
    expect(kindOf(decide(sources({ named: one(run) }), bridge({ instance: "codex-a" })))).toBe(
      "none:home",
    );
  });

  test("a space the bridge process holds wins: a launch in another space leaves it none there", () => {
    const named = one(launch(1));
    const rows: HomeRows = { kind: "rows", rows: [row("codex-a")] };
    // Held as no space: also a launch's own space does not move it.
    expect(kindOf(decide(sources({ named, rows }), bridge({ held: null })))).toBe("none:space");
    expect(kindOf(decide(sources({ named, rows }), bridge({ held: S2 })))).toBe("none:space");
    expect(kindOf(decide(sources({ named, rows }), bridge({ held: S1 })))).toBe("session");
    expect(
      kindOf(decide(sources({ named: one(run) }), bridge({ instance: "runner", held: S2 }))),
    ).toBe("none:space");
  });

  test("home rows that could not be read are never an answer", () => {
    expect(decide(sources({ named: one(launch(1)), rows: { kind: "failed" } }), bridge())).toEqual({
      kind: "failed",
    });
    expect(
      standing(sources({ rows: { kind: "failed" } }), { of: "launch", app: "codex", home: HOME }),
    ).toEqual({
      kind: "failed",
    });
  });

  test("what a session may do now: its home's live row, the instance a bridge bound with, the default as manual, a run while it runs", () => {
    const home = { of: "launch", app: "codex", home: HOME } as const;
    const may = (rows: HomeRow[], instance?: string, machineDefault?: string) => {
      const read = standing(
        sources({
          rows: { kind: "rows", rows },
          ...(machineDefault === undefined ? {} : { machineDefault }),
        }),
        instance === undefined ? home : { ...home, instance },
      );
      if (read.kind === "failed") throw new Error("failed");
      return { instance: read.instance, s1: read.may(S1), s2: read.may(S2) };
    };
    // A shell takes the live row's instance at each call.
    expect(may([row("codex-a")])).toEqual({ instance: "codex-a", s1: true, s2: false });
    expect(may([row("codex-b"), row("codex-a", false)])).toEqual({
      instance: "codex-b",
      s1: true,
      s2: false,
    });
    // A bridge keeps the instance it bound with: another one registered since gives it nothing.
    expect(may([row("codex-b")], "codex-a")).toEqual({ instance: "codex-a", s1: false, s2: false });
    expect(may([row("codex-a", false)], "codex-a")).toEqual({
      instance: "codex-a",
      s1: false,
      s2: false,
    });
    // Manual while the home never had a row: the machine's default only; once setup registered
    // the home, a bridge bound as manual is refused until it reconnects.
    expect(may([], undefined, S2)).toEqual({ instance: "manual", s1: false, s2: true });
    expect(may([row("codex-a")], "manual", S2)).toEqual({
      instance: "manual",
      s1: false,
      s2: false,
    });
    const runs = (allows: boolean) =>
      standing(sources({ allows }), {
        of: "run",
        run: "ru_00000000000000000000000009",
        instance: "runner",
      });
    expect(runs(true)).toMatchObject({ kind: "read", instance: "runner" });
    const ran = runs(false);
    expect(ran.kind === "read" && ran.may(S1)).toBe(false);
  });

  test("a bridge's bind settles its space once: what it holds, a session's own, else its entry's, the default, the only space by registered ID; else none", () => {
    const port = (decision: Decision): SessionPort => ({
      decide: () => decision,
      standing: () => ({ kind: "failed" }),
      live: () => new Map(),
    });
    const none: Decision = { kind: "none" };
    const session: Decision = {
      kind: "session",
      by: "ticket",
      session: {
        session: "se_1",
        space: S2,
        task: TASK,
        home: { of: "launch", app: "codex", home: HOME },
      },
    };
    const opening = [{ id: undefined, registered: S1, name: undefined, state: "opening" }];
    const open = [
      { id: S1, registered: S1, name: "Mira", state: "open" },
      { id: S2, registered: S2, name: "Life", state: "open" },
    ];
    const bind = (
      decision: Decision,
      context: JsonObject,
      spaces: typeof open | typeof opening = open,
      defaultSpace?: string,
    ) =>
      new Bridges({
        sessions: port(decision),
        spaces: () => spaces,
        defaultSpace: () => defaultSpace,
      }).bind({ context });
    expect(bind(session, { space: S1 })).toEqual({ space: S2, state: "bound" });
    expect(bind(none, { space: S1, held_space: S2 })).toEqual({ space: S2, state: "unbound" });
    expect(bind(none, { space: S1 })).toEqual({ space: S1, state: "unbound" });
    expect(bind(none, { space: "life" })).toEqual({ space: S2, state: "unbound" });
    expect(bind(none, { space: "nowhere" })).toEqual({ space: null, state: "unbound" });
    expect(() => bind(none, { space: "Mira" }, opening)).toThrow(BindNotYet);
    expect(bind(none, {}, open, S2)).toEqual({ space: S2, state: "unbound" });
    expect(bind(none, {}, open)).toEqual({ space: null, state: "unbound" });
    // While spaces open: the only one by the ID its entry in the configuration names.
    expect(bind(none, {}, opening)).toEqual({ space: S1, state: "unbound" });
    expect(() => bind({ kind: "failed" }, {})).toThrow(BindNotYet);
    // A process told it has no space keeps none: a default set since gives it none.
    expect(bind(none, { held_space: null }, open, S2)).toEqual({ space: null, state: "unbound" });
    // An older bridge reconnects with a handle and no held space: on an entry that names no space,
    // which space it worked in is not known, so it gets none; one its entry names is that one.
    const legacy = { resume: { handle: "bh_0123456789abcdefghijkl" } };
    expect(bind(none, legacy, open, S2)).toEqual({ space: null, state: "unbound" });
    expect(bind(none, { ...legacy, space: S1 }, open, S2)).toEqual({ space: S1, state: "unbound" });
  });
});
