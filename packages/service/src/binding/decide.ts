// Who an agent's connection is: a session of a launch or a run TTasks started, or none. One rule
// for a bridge's bind and for every shell call, decided only from values TTasks issued for the
// start (the ticket, Claude Code's preset session ID) and the home the click recorded, never from
// what a connection says about itself: not its folder, `TTASKS_TASK`, `TTASKS_SPACE`, a native
// thread ID or a tool argument. None is the connection's own identity, exactly as if it presented
// nothing.
//
// - A bridge of a terminal launch must also present the app the click recorded and the instance
//   its home expects: a live row's, any row's when all were revoked (every call is then refused),
//   or `manual` for a home that never had a row. So another app's bridge inside the agent is
//   none, and setup run after Open works.
// - A shell sends its environment only: the value alone decides.
// - A run's bridge presents the run's instance; no app is asked.
// What a session may do is decided again at every call (`standing`), never who it is.
import { INSTANCE_ID, MANUAL_INSTANCE } from "@ttasks/launch";
import type { Named, Live } from "../hub/named.ts";
import type { HomeRows } from "../hub/home-rows.ts";
import type { BoundBy, Decision, Presented, Session, SessionHome, Standing } from "../ops/index.ts";

/** What the rule reads, each a port so the bind, a shell call and the model test share it. */
export interface DecideSources {
  /** The live launch or run the values name (hub/named.ts). Throws when it cannot be read. */
  named(values: { readonly ticket?: string; readonly preset?: string }): Named;
  /** The rows of a home (hub/home-rows.ts), revoked ones included, newest first. */
  rows(app: string, home: string): HomeRows;
  /** Whether a run of `instance` may use `space` now: while it runs, its own space only. */
  runAllows(instance: string, space: string, run: string): boolean;
  /** The space a hand-made entry may use: the machine's default, else the one space. */
  machineDefault(): string | undefined;
}

const TICKET = "TTASKS_TICKET";
const PRESET = "CLAUDE_CODE_SESSION_ID";

/** A launch without an app or a task, or a run without a task, names nothing. */
function sessionOf(live: Live): Session | undefined {
  if (live.task === null) return undefined;
  if (live.of === "run") {
    return {
      session: live.session,
      space: live.space,
      task: live.task,
      home: { of: "run", run: live.run, instance: live.instance },
    };
  }
  if (live.app === undefined) return undefined;
  return {
    session: live.session,
    space: live.space,
    task: live.task,
    home: { of: "launch", app: live.app, home: live.home },
  };
}

/** The one session the values name: two live values of different sessions name none. */
function namedSession(named: Named): { session: Session; by: BoundBy } | undefined {
  if (named.kind === "none") return undefined;
  if (named.kind === "one") {
    const session = sessionOf(named.live);
    return session === undefined ? undefined : { session, by: named.by };
  }
  const ticket = sessionOf(named.ticket);
  const preset = sessionOf(named.preset);
  if (ticket !== undefined && preset !== undefined) return undefined;
  if (ticket !== undefined) return { session: ticket, by: "ticket" };
  return preset === undefined ? undefined : { session: preset, by: "preset" };
}

/** The rows of the home the click recorded; a click that recorded no folder has none. */
const rowsOf = (sources: DecideSources, home: { app: string; home: string | undefined }) =>
  home.home === undefined
    ? ({ kind: "rows", rows: [] } as const)
    : sources.rows(home.app, home.home);

/** The rule: who the connection that presented `presented` is. */
export function decide(sources: DecideSources, presented: Presented): Decision {
  const ticket = presented.env[TICKET];
  const preset = presented.env[PRESET];
  if (ticket === undefined && preset === undefined) return { kind: "none" };
  let named: Named;
  try {
    named = sources.named({
      ...(ticket === undefined ? {} : { ticket }),
      ...(preset === undefined ? {} : { preset }),
    });
  } catch {
    return { kind: "failed" };
  }
  const found = namedSession(named);
  if (found === undefined) return { kind: "none", reason: "values" };
  const { session, by } = found;
  if (presented.via === "shell") return { kind: "session", session, by };

  // An omitted `--instance` is the hand-made entry's; a malformed one names no home.
  const instance = presented.instance ?? MANUAL_INSTANCE;
  if (!INSTANCE_ID.test(instance)) return { kind: "none", reason: "home" };
  if (session.home.of === "run") {
    if (instance !== session.home.instance) return { kind: "none", reason: "home" };
    return heldElsewhere(presented, session)
      ? { kind: "none", reason: "space" }
      : { kind: "session", session, by };
  }
  if (presented.app !== session.home.app) return { kind: "none", reason: "app" };
  const rows = rowsOf(sources, session.home);
  if (rows.kind === "failed") return { kind: "failed" };
  const live = rows.rows.filter((row) => row.live);
  const expected =
    rows.rows.length === 0
      ? [MANUAL_INSTANCE]
      : (live.length > 0 ? live : rows.rows).map((row) => row.instance);
  if (!expected.includes(instance)) return { kind: "none", reason: "home" };
  if (heldElsewhere(presented, session)) return { kind: "none", reason: "space" };
  return {
    kind: "session",
    session: { ...session, home: { ...session.home, instance } },
    by,
  };
}

/**
 * One bridge process works in one space for its life: what it holds from an earlier bind, a space
 * or none, wins over a launch's, where the same task reference can name another task.
 */
const heldElsewhere = (presented: Presented, session: Session): boolean =>
  presented.via === "bridge" && presented.held !== undefined && presented.held !== session.space;

/**
 * What a session may do now. A terminal session may use a space its home's live row names, and a
 * bridge only while that row names the instance it bound with, so one connection never writes
 * under two actor names; a home that never had a row may use the machine's default as `manual`.
 * A run's session may use its space while the run runs, whatever rows its home has.
 */
export function standing(sources: DecideSources, home: SessionHome): Standing {
  if (home.of === "run") {
    return {
      kind: "read",
      instance: home.instance,
      may: (space) => sources.runAllows(home.instance, space, home.run),
    };
  }
  const rows = rowsOf(sources, home);
  if (rows.kind === "failed") return { kind: "failed" };
  if (rows.rows.length === 0) {
    const instance = home.instance ?? MANUAL_INSTANCE;
    return {
      kind: "read",
      instance,
      may: (space) => instance === MANUAL_INSTANCE && space === sources.machineDefault(),
    };
  }
  const live = rows.rows.filter((row) => row.live);
  const bound = home.instance;
  const row = live.find((r) => bound === undefined || r.instance === bound);
  const instance = bound ?? row?.instance ?? rows.rows[0]?.instance ?? MANUAL_INSTANCE;
  return {
    kind: "read",
    instance,
    may: (space) => row?.spaces.includes(space) === true,
  };
}
