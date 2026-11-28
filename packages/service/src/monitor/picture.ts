// The Agents page's picture of one snapshot: each conversation's own agent with the agents inside
// it and the task TTasks started it for, and each account's plan usage. Only what the page shows
// leaves the service: no session ID, home path or process. TTAM's row and home IDs hold those, so
// a row's key is a digest of its ID.
import { createHash } from "node:crypto";
import type {
  AgentsAccount,
  AgentsTask,
  AgentsNested,
  AgentsPicture,
  AgentsSession,
  AgentsThread,
  MonitorAgent,
  MonitorSnapshot,
} from "@ttasks/contracts/monitor";

/** A key that stays the same for the same ID and tells nothing of it. */
const keyOf = (id: string): string =>
  createHash("sha256").update(id, "utf8").digest("base64url").slice(0, 16);

/**
 * The row an agent is shown under: the top of its chain of parents. An agent whose parent the
 * snapshot does not hold, or whose chain loops, stands on its own.
 */
function topOf(agent: MonitorAgent, byRow: ReadonlyMap<string, MonitorAgent>): MonitorAgent {
  const seen = new Set<string>([agent.rowId]);
  let at = agent;
  for (;;) {
    const parent = at.parentRowId === null ? undefined : byRow.get(at.parentRowId);
    if (parent === undefined) return at;
    if (seen.has(parent.rowId)) return agent;
    seen.add(parent.rowId);
    at = parent;
  }
}

/**
 * `snapshot` as the page shows it, `ageMs` after its capture, with each agent's task by its row ID
 * (links.ts), the agents TTasks holds that TTAM has not seen, and the tasks' T3 threads.
 */
export function pictureOf(
  snapshot: MonitorSnapshot,
  ageMs: number,
  links: ReadonlyMap<string, AgentsTask> = new Map(),
  unseen: readonly AgentsTask[] = [],
  threads: readonly AgentsThread[] = [],
): AgentsPicture {
  const byRow = new Map(snapshot.agents.map((a) => [a.rowId, a]));
  const nested = new Map<string, AgentsNested[]>();
  const tops: MonitorAgent[] = [];
  for (const agent of snapshot.agents) {
    const top = topOf(agent, byRow);
    if (top === agent) {
      tops.push(agent);
      continue;
    }
    const inside = nested.get(top.rowId) ?? [];
    inside.push({
      key: keyOf(agent.rowId),
      kind: agent.kind,
      title: agent.name,
      activity: agent.activity,
      ageMs: agent.ageMs,
    });
    nested.set(top.rowId, inside);
  }
  const sessions = tops.map((a): AgentsSession => ({
    key: keyOf(a.rowId),
    task: links.get(a.rowId) ?? null,
    app: a.provider,
    appName: a.providerName,
    account: a.profile,
    title: a.name,
    folder: a.folder,
    activity: a.activity,
    ageMs: a.ageMs,
    quietMs: a.quietMs,
    nested: nested.get(a.rowId) ?? [],
  }));
  const profiles = new Map(snapshot.accounts.map((a) => [a.homeId, a.profile]));
  const accounts = snapshot.accounts.map((a): AgentsAccount => ({
    key: keyOf(a.homeId),
    app: a.provider,
    appName: a.providerName,
    account: a.profile,
    sameAs:
      a.sameAccount === null || a.sameAccount === a.homeId
        ? null
        : (profiles.get(a.sameAccount) ?? null),
    plan: a.plan,
    windows: a.windows,
    readingAgeMs: a.readingAgeMs,
    refreshing: a.refreshing,
    limited: a.limited,
    failed: a.failed,
    retryInMs: a.retryInMs,
    unavailable: a.unavailable,
  }));
  return { ageMs, settling: snapshot.settling, sessions, unseen, threads, accounts };
}
