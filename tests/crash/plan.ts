// One round's plan and how it ends, from the round's seeded random source and what the ledger
// holds. The same seed and the same ledger give the same plan: the requests, their sessions,
// bases and positions, the backups and restores, the window, and the kill. Fixture text only.
//
// The workload mixes every operation of this build and every outcome the write path decides:
// creates with client IDs (some with initial children in the same request), patches with fresh,
// stale and missing bases, two patches of one field in one request (one change row), moves,
// completes, reopens, notes, log entries and sources by key, recent patches and links sent again
// under a new request ID (mostly no-ops), and requests for tasks that do not exist. The requests come from ten writer scopes, several in
// flight at once; two of them write as agent actors, which join the space on their first act. Each
// round first retries the requests the last kill left unanswered, and a few answered ones, whose
// replays must match.
import { newId } from "../../packages/storage/src/ids.ts";
import type { Operation } from "../../packages/storage/src/write/request.ts";
import type { Rng } from "../../packages/testkit/src/rng.ts";
import type { Ledger } from "./ledger.ts";
import { POINTS, type Action, type Kill, type PlannedRequest, type RoundPlan } from "./protocol.ts";
import { REVISION_0_1 } from "./steps.ts";

export const SESSIONS = 10;

/**
 * The sessions that write as an agent actor, as the service's `cli-script` and `cli-agent` classes
 * do: the actor joins the space on its first act in an `actor.register` system
 * commit, which the checker must account for. The other sessions write as the space's human.
 */
export const AGENT_SESSIONS: ReadonlyMap<number, string> = new Map([
  [9, "script"],
  [10, "agent:unknown"],
]);

const STATUSES = ["open", "waiting", "review", "backlog"] as const;

/** How the round ends, before the plan is built (the plan makes the chosen point reachable). */
export function chooseKill(rng: Rng, ledger: Ledger): Kill {
  if (ledger.revision === REVISION_0_1 && rng.chance(0.75)) {
    // The space migrates when the writer opens: kill inside the migration or its barrier backup.
    // A space migrates once (and again after a restore of its barrier backup), so most of those
    // rounds stop inside it.
    const where = rng.chance(0.6) ? "migrate" : "barrier";
    const point = rng.pick(POINTS[where]);
    const nth = where === "migrate" && point === "step-applied" ? rng.range(1, 2) : 1;
    return { kind: "point", arm: { where, point, nth } };
  }
  const roll = rng.int(100);
  if (roll < 38) {
    const point = rng.pick(POINTS.write);
    // Most write kills land on any request; some on the nth new decision of one outcome, so the
    // receipt-only outcomes (no-ops, conflicts, refusals) are killed at too, not only applied ones.
    if (rng.chance(0.35)) {
      const outcome = rng.pick(["unchanged", "conflict", "rejected"]);
      return { kind: "point", arm: { where: "write", point, nth: rng.range(1, 2), outcome } };
    }
    return { kind: "point", arm: { where: "write", point, nth: rng.range(1, 40) } };
  }
  if (roll < 50) {
    return {
      kind: "point",
      arm: { where: "backup", point: rng.pick(POINTS.backup), nth: rng.range(1, 2) },
    };
  }
  if (roll < 60) {
    return { kind: "point", arm: { where: "restore", point: rng.pick(POINTS.restore), nth: 1 } };
  }
  // A round's plan takes a few hundred milliseconds on Windows 11, so a timer counts from a request
  // the child reports as sent, which lands it inside the plan on a fast machine and a slow one alike.
  if (roll < 80) return { kind: "timer", sends: rng.range(1, 100), afterMs: rng.range(0, 8) };
  if (roll < 87) return { kind: "timer", sends: 0, afterMs: rng.range(0, 40) };
  return { kind: "none" };
}

const hex = (rng: Rng, bytes: number): string => {
  let out = "";
  for (let i = 0; i < bytes; i += 1) out += rng.int(256).toString(16).padStart(2, "0");
  return out;
};

/** A new request, registered in the ledger. */
function newRequest(rng: Rng, ledger: Ledger, round: number, n: number): PlannedRequest {
  const session = rng.range(1, SESSIONS);
  const scope_id = `cli:crash-${String(session)}`;
  const request_id = `crash-${String(round)}-${String(n)}-${hex(rng, 4)}`;
  ledger.counter += 1;
  const c = ledger.counter;
  const taskId = (): string =>
    newId("t", (bytes) => {
      rng.fill(bytes);
    });
  const existing = (): string => rng.pick(ledger.tasks);
  const fresh = rng.chance(0.85) ? "fresh" : rng.chance(0.7) ? "stale" : "none";
  let ops: Operation[];
  let base: PlannedRequest["base"] = "none";
  const roll = ledger.tasks.length === 0 ? 0 : rng.int(100);
  if (roll < 24) {
    const id = taskId();
    ledger.tasks.push(id);
    ops = [
      {
        kind: "task.create",
        id: id as `t_${string}`,
        title: `Crash task ${String(c)}`,
        ...(rng.chance(0.3) ? { priority: rng.range(1, 4) } : {}),
      },
    ];
  } else if (roll < 30) {
    // A task and its first children in one request: all of it commits, or none. It asks for a new
    // task whatever its source's key matches, so the task is always created, as the
    // checker expects.
    const id = taskId();
    ledger.tasks.push(id);
    ops = [
      {
        kind: "task.create",
        id: id as `t_${string}`,
        title: `Crash task ${String(c)}`,
        dedupe: "new",
      },
      { kind: "note.add", task: id, body: `Note ${String(c)}` },
      {
        kind: "source.add",
        task: id,
        source: {
          kind: "ticket",
          title: `Source ${String(c)}`,
          key: `crash:k${String(rng.int(16))}`,
        },
      },
    ];
  } else if (roll < 52) {
    base = fresh;
    const set =
      rng.int(4) === 0
        ? { title: `Crash task ${String(c)} renamed` }
        : rng.int(3) === 0
          ? { priority: rng.range(1, 4), summary: `Summary ${String(c)}` }
          : rng.int(2) === 0
            ? { status: rng.pick(STATUSES), due: { date: `2026-12-${String(rng.range(10, 28))}` } }
            : { owner: `Owner ${String(rng.int(5))}` };
    ops = [{ kind: "task.patch", task: existing(), set }];
  } else if (roll < 56) {
    // One field written twice in one request: one change row, first before, final after.
    base = fresh;
    const task = existing();
    ops = [
      { kind: "task.patch", task, set: { summary: `First ${String(c)}` } },
      { kind: "task.patch", task, set: { summary: `Second ${String(c)}` } },
    ];
  } else if (roll < 60) {
    base = fresh;
    ops = [{ kind: "task.move", task: existing(), after: existing() }];
  } else if (roll < 67) {
    base = fresh;
    ops = [{ kind: "task.complete", task: existing() }];
  } else if (roll < 72) {
    base = fresh;
    ops = [{ kind: "task.reopen", task: existing() }];
  } else if (roll < 81) {
    ops = [{ kind: "note.add", task: existing(), body: `Note ${String(c)}` }];
  } else if (roll < 89) {
    ops = [{ kind: "log.add", task: existing(), body: `Log ${String(c)}` }];
  } else if (roll < 93) {
    ops = [
      {
        kind: "source.add",
        task: existing(),
        source: {
          kind: "ticket",
          title: `Source ${String(c)}`,
          key: `crash:k${String(rng.int(16))}`,
        },
      },
    ];
  } else if (roll < 97 && ledger.recent.length > 0) {
    // A recent request's operations again under a new request ID: usually a no-op by now, a
    // decision whose receipt is its only trace.
    base = "fresh";
    ops = structuredClone(rng.pick(ledger.recent));
  } else {
    // A task that was never created: NOT_FOUND, decided and stored.
    base = fresh;
    ops = [{ kind: "task.patch", task: taskId(), set: { summary: `Lost ${String(c)}` } }];
  }
  if (ops.length === 1 && (ops[0]?.kind === "task.patch" || ops[0]?.kind === "source.add")) {
    ledger.recent.push(ops);
    if (ledger.recent.length > 16) ledger.recent.shift();
  }
  const agent = AGENT_SESSIONS.get(session);
  const planned: PlannedRequest = {
    key: `${scope_id} ${request_id}`,
    request_id,
    scope_id,
    base,
    ops,
    ...(agent === undefined ? {} : { agent }),
  };
  ledger.requests.set(planned.key, planned);
  return planned;
}

/** Inserts `action` at a random index from `from` to `to` (default: the end). Returns the index. */
function insert(
  rng: Rng,
  actions: Action[],
  from: number,
  action: Action,
  to: number = actions.length,
): number {
  const last = Math.min(to, actions.length);
  const at = rng.range(Math.min(from, last), last);
  actions.splice(at, 0, action);
  return at;
}

/** The round's plan. New requests are registered in the ledger as they are planned. */
export function buildPlan(rng: Rng, ledger: Ledger, round: number, kill: Kill): RoundPlan {
  const actions: Action[] = [];
  // Retries first, in the order they were sent: a retry carries a fresh base when the request had
  // one, which the fingerprint leaves out, so a committed retry replays.
  for (const request of ledger.inflight.values()) {
    actions.push({
      a: "submit",
      req: { ...request, base: request.base === "none" ? "none" : "fresh" },
    });
  }
  const answered = [...ledger.expected.keys()];
  for (let i = rng.int(4); i > 0 && answered.length > 0; i -= 1) {
    const request = ledger.requests.get(rng.pick(answered));
    if (request !== undefined) {
      actions.push({
        a: "submit",
        req: { ...request, base: request.base === "none" ? "none" : "fresh" },
      });
    }
  }
  const retries = actions.length;
  const count = rng.range(30, 120);
  for (let n = 1; n <= count; n += 1) {
    actions.push({ a: "submit", req: newRequest(rng, ledger, round, n) });
  }

  const arm = kill.kind === "point" ? kill.arm : null;
  let backups = rng.chance(0.4) ? rng.range(1, 2) : 0;
  if (arm?.where === "backup") backups = Math.max(backups, arm.nth);
  let firstBackup = actions.length;
  for (let i = 0; i < backups; i += 1) {
    firstBackup = Math.min(
      firstBackup,
      insert(rng, actions, retries, { a: "backup", kind: rng.chance(0.5) ? "manual" : "daily" }),
    );
  }
  if (arm?.where === "restore" || rng.chance(0.15)) {
    // Early in the plan, so that most restores finish before a kill elsewhere in the round, and
    // the space works on in its new incarnation.
    const early = retries + Math.floor((actions.length - retries) / 4);
    const known = [...ledger.backups.keys()];
    if (known.length > 0 && rng.chance(0.5)) {
      insert(rng, actions, retries, { a: "restore", backup: rng.pick(known) }, early);
    } else {
      // The newest backup this round took: one is planned before the restore.
      if (backups === 0 || firstBackup > early) {
        firstBackup = insert(rng, actions, retries, { a: "backup", kind: "manual" }, early);
      }
      insert(rng, actions, firstBackup + 1, { a: "restore", backup: "" }, firstBackup + 8);
    }
  }
  if (arm?.where === "write" && arm.outcome === undefined) {
    // The point must be reachable: one of the round's request transactions. An outcome's nth may
    // not come; the round then runs to its end, counted as an armed point not reached.
    const submits = actions.filter((a) => a.a === "submit").length;
    arm.nth = 1 + ((arm.nth - 1) % Math.max(1, submits));
  }
  return {
    round,
    folder: ledger.folder,
    spaceId: ledger.spaceId,
    owner: ledger.owner,
    base: ledger.base,
    knownEpochs: [...ledger.epochs],
    window: rng.range(1, SESSIONS),
    arm,
    actions,
  };
}
