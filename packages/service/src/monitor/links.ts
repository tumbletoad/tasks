// Which task each of TTAM's agents works on: the session TTasks started it in, joined by the agent
// app, the agent home and the session ID together. Only a join that names one task is a link: a
// home TTAM does not list, a home two of its homes could be, or a session TTasks holds for two
// tasks links nothing, since a wrong task is worse than none. No process ID is used.
import type { AgentsTask, MonitorAgent, MonitorSnapshot } from "@ttasks/contracts/monitor";
import { samePath } from "../setup/agents.ts";

/** An agent session TTasks started, as its own records hold it. */
export interface HeldSession {
  readonly task: AgentsTask;
  readonly provider: "claude" | "codex";
  /** The agent home's absolute path on this machine. */
  readonly home: string;
  /** The agent app's own session ID. */
  readonly sessionId: string;
  /** TTasks holds this agent in a terminal as running now. */
  readonly running: boolean;
}

const sameTask = (a: AgentsTask, b: AgentsTask): boolean => a.space === b.space && a.id === b.id;

const joinKey = (provider: string, homeId: string, sessionId: string): string =>
  JSON.stringify([provider, homeId, sessionId]);

/** TTAM's home of `held`: undefined when it lists none, or more than one, at that path. */
function homeOf(
  snapshot: MonitorSnapshot,
  held: HeldSession,
  platform: NodeJS.Platform,
): string | undefined {
  const homes = snapshot.homes.filter(
    (h) => h.provider === held.provider && samePath(platform, h.path, held.home),
  );
  return homes.length === 1 ? homes[0]?.id : undefined;
}

/** The task each join of app, home and session names; null where two tasks share one. */
function joined(
  snapshot: MonitorSnapshot,
  held: readonly HeldSession[],
  platform: NodeJS.Platform,
): Map<string, AgentsTask | null> {
  const out = new Map<string, AgentsTask | null>();
  for (const h of held) {
    const home = homeOf(snapshot, h, platform);
    if (home === undefined) continue;
    const key = joinKey(h.provider, home, h.sessionId);
    const found = out.get(key);
    out.set(
      key,
      found === undefined || (found !== null && sameTask(found, h.task)) ? h.task : null,
    );
  }
  return out;
}

const keyOfAgent = (a: MonitorAgent): string => joinKey(a.provider, a.homeId, a.sessionId);

/**
 * The task of each agent of `snapshot` by its row ID, for the agents that have one. An agent
 * inside a conversation shares its conversation's session ID, so it links as its parent does.
 */
export function linksOf(
  snapshot: MonitorSnapshot,
  held: readonly HeldSession[],
  platform: NodeJS.Platform,
): Map<string, AgentsTask> {
  const joins = joined(snapshot, held, platform);
  const out = new Map<string, AgentsTask>();
  for (const agent of snapshot.agents) {
    const task = joins.get(keyOfAgent(agent));
    if (task !== undefined && task !== null) out.set(agent.rowId, task);
  }
  return out;
}

/**
 * A running agent is "not seen" once this many complete answers in a row missed it, over at least
 * UNSEEN_MS: an agent that just started takes a few seconds to write its session, and while the
 * page is looked at answers come a second apart.
 */
export const UNSEEN_ANSWERS = 2;
export const UNSEEN_MS = 10_000;

/**
 * Agents in a terminal that TTasks holds as running and TTAM has not seen. An answer that says
 * `settling` may miss a session, so it counts neither way. An agent whose home TTAM does not list
 * cannot be seen at all, and is never called unseen.
 */
export class Unseen {
  /** Per join: the complete answers in a row that missed it, and when the first of them came. */
  #missed = new Map<string, { readonly count: number; readonly since: number }>();

  /** The agents not seen now, `snapshot` the newest answer, `now` on the steady clock. */
  next(
    snapshot: MonitorSnapshot,
    held: readonly HeldSession[],
    platform: NodeJS.Platform,
    now: number,
  ): AgentsTask[] {
    const present = new Set(snapshot.agents.map(keyOfAgent));
    const missed = new Map<string, { readonly count: number; readonly since: number }>();
    const out: AgentsTask[] = [];
    for (const h of held) {
      if (!h.running || h.task.started !== "terminal") continue;
      const home = homeOf(snapshot, h, platform);
      if (home === undefined) continue;
      const key = joinKey(h.provider, home, h.sessionId);
      if (present.has(key)) continue;
      const before = this.#missed.get(key);
      if (snapshot.settling) {
        if (before !== undefined) missed.set(key, before);
        continue;
      }
      const miss = { count: (before?.count ?? 0) + 1, since: before?.since ?? now };
      missed.set(key, miss);
      const gone = miss.count >= UNSEEN_ANSWERS && now - miss.since >= UNSEEN_MS;
      if (gone && !out.some((t) => sameTask(t, h.task))) out.push(h.task);
    }
    this.#missed = missed;
    return out;
  }

  /** Nobody watched for a while: what was missed before counts no more. */
  reset(): void {
    this.#missed = new Map();
  }
}
