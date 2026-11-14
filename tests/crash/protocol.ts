// What the crash harness (harness.ts) and its child process (child.ts) say to each other, and the
// fault seam both of the child's threads install.
//
// The parent writes one round's plan to the child's stdin as JSON. The child writes one JSON
// message per line to its stdout, with a synchronous write to file descriptor 1, from its main
// thread and from its storage worker thread alike: a worker thread that stops at a fault point
// must get its message out before it waits to be killed, without help from the main thread. The
// child never writes anything else to stdout. No message carries task text: requests go in on
// stdin, and results come back reduced to statuses, IDs, sequence numbers and codes.
import { writeSync } from "node:fs";
import type { Operation, WriteResult } from "../../packages/storage/src/write/request.ts";

/** Where a fault point is, by the code that calls its seam. */
export const WHERES = ["write", "backup", "barrier", "migrate", "restore"] as const;
export type Where = (typeof WHERES)[number];

/** Every named point, by where it is (the storage seams of A1 5 and M1.07). */
export const POINTS: { readonly [W in Where]: readonly string[] } = {
  write: ["before-commit", "after-commit"],
  backup: ["copied", "checked", "compressed", "data-renamed", "sidecar-renamed"],
  barrier: ["copied", "checked", "compressed", "data-renamed", "sidecar-renamed"],
  migrate: ["backed-up", "step-applied", "checked", "committed"],
  restore: ["unpacked", "claimed", "moved-aside", "moved-into-place", "backups-carried"],
};

/** The statuses of a decision the write path stores (A1 3.8). */
export const OUTCOMES: readonly string[] = ["applied", "unchanged", "conflict", "rejected"];

/** The child stops at the `nth` time it reaches `where`/`point`, and waits to be killed. */
export interface Arm {
  where: Where;
  point: string;
  nth: number;
  /**
   * At a write point: count only new decisions with this status, so a kill lands on the rarer
   * outcomes too (a no-op's or a refusal's receipt is its only trace, A1 3.8).
   */
  outcome?: string;
}

/** How a round ends. */
export type Kill =
  /** At a named point: the child reports it and waits, and the parent kills it there. */
  | { kind: "point"; arm: Arm }
  /**
   * At a time: the parent kills the child `afterMs` after the child reported its `sends`th request
   * as sent, or, when `sends` is 0, after it reported `ready`. Where that lands is the OS's choice.
   */
  | { kind: "timer"; sends: number; afterMs: number }
  /** Not at all: the child runs its plan, closes the space and exits. */
  | { kind: "none" };

/** A request the plan sends: everything but the base, which the child fills in. */
export interface PlannedRequest {
  /** `<scope_id> <request_id>`: the receipt's key. */
  key: string;
  request_id: string;
  scope_id: string;
  /** `fresh`: the newest as_of the child has seen. `stale`: an older one. */
  base: "none" | "fresh" | "stale";
  ops: Operation[];
  /**
   * The label of the agent actor the request is from (A3 3.7.4: `script`, `agent:unknown`), which
   * joins the space on its first act through `actor.register`, as the service's request path adds
   * it. Absent: the space's human.
   */
  agent?: string;
}

export type Action =
  | { a: "submit"; req: PlannedRequest }
  /** Starts a backup beside the writes. The next backup or restore waits for it. */
  | { a: "backup"; kind: "manual" | "daily" }
  /** Closes the writer, restores the named backup in place, and opens the writer again. */
  | { a: "restore"; backup: string };

export interface RoundPlan {
  round: number;
  folder: string;
  spaceId: string;
  /** The space's human owner: the principal of every request. */
  owner: string;
  /** The as_of the parent read before the round, wire form. */
  base: string;
  /** Epochs seen in this space so far: a restore's claim goes above them. */
  knownEpochs: number[];
  /** Requests in flight at once. */
  window: number;
  arm: Arm | null;
  actions: Action[];
}

/** One operation's result, reduced. */
export interface AckedOp {
  i: number;
  status: string;
  id: string;
  task?: string;
  ref?: string;
  entry?: string;
  version: number;
  /** `source.add` on an existing source: the names of the fields the input gives otherwise. */
  differs?: string[];
}

/** One conflicting field, as a receipt stores it: without its value, and without the label. */
export interface AckedConflict {
  op: number;
  entity: string;
  id: string;
  task?: string;
  ref?: string;
  field: string;
  version: number;
  actor: string;
  kind: string;
  at: number;
}

/**
 * A write result, reduced to what the ledger compares: everything a receipt stores and a replay
 * returns (A1 3.8), as statuses, IDs, numbers, codes and field names. No values, no text:
 * a conflict's current value is in the first reply only, and an author's label and a problem's
 * sentence are left out.
 */
export interface Acked {
  status: string;
  as_of: string;
  epoch: number;
  incarnation: string;
  seq: number;
  commit?: string;
  replayed: boolean;
  code?: string;
  /** The problem's operation index, input path or field, time and reason, as codes. */
  problem?: { op?: number; field?: string; at?: number; reason?: string };
  ops: AckedOp[];
  conflicts: AckedConflict[];
  warnings: number;
}

/** A decision the write seam reports with its point: whose request it is, and the result. */
export interface Decided {
  key: string;
  result: Acked;
}

export interface BackupFacts {
  name: string;
  seq: number;
  incarnation: string;
  userVersion: number;
}

export type ChildMessage =
  | { t: "ready"; migrated: BackupFacts | null }
  /**
   * The agent actor a label resolved to on its first use by this writer: the writer added it in
   * an `actor.register` system commit, or found it. An ID and a fixed label, no task text.
   */
  | { t: "actor"; label: string; id: string }
  | { t: "send"; key: string }
  | { t: "ack"; key: string; result: Acked }
  | { t: "backup-start"; n: number }
  | { t: "backup-done"; n: number; backup: BackupFacts }
  | { t: "restore-start"; backup: string }
  | { t: "restore-done"; backup: string; epoch: number; incarnation: string; seq: number }
  /**
   * The child stopped at its armed point. At a write point, `decided` is the request's decision:
   * committed at `after-commit`, rolled back by the kill at `before-commit`.
   */
  | { t: "at"; where: Where; point: string; nth: number; decided?: Decided }
  /** An error the child did not expect: its StorageError code, or the error's class name. */
  | { t: "error"; during: string; code: string }
  | { t: "done" };

/** A write result as the child reports it: statuses, IDs, versions and codes, no values. */
export function reduce(result: WriteResult): Acked {
  const { error } = result;
  return {
    status: result.status,
    as_of: result.as_of,
    epoch: result.epoch,
    incarnation: result.incarnation,
    seq: result.seq,
    ...(result.commit === undefined ? {} : { commit: result.commit }),
    replayed: result.replayed === true,
    ...(error === undefined
      ? {}
      : {
          code: error.code,
          problem: {
            ...(error.op === undefined ? {} : { op: error.op }),
            ...(error.field === undefined ? {} : { field: error.field }),
            ...(error.at === undefined ? {} : { at: error.at }),
            ...(error.reason === undefined ? {} : { reason: error.reason }),
          },
        }),
    ops: result.results.map((r) => ({
      i: r.i,
      status: r.status,
      id: r.id,
      ...(r.task === undefined ? {} : { task: r.task }),
      ...(r.ref === undefined ? {} : { ref: r.ref }),
      ...(r.entry === undefined ? {} : { entry: r.entry }),
      version: r.version,
      ...(r.differs === undefined ? {} : { differs: [...r.differs] }),
    })),
    conflicts: result.conflicts.map((c) => ({
      op: c.op,
      entity: c.entity,
      id: c.id,
      ...(c.task === undefined ? {} : { task: c.task }),
      ...(c.ref === undefined ? {} : { ref: c.ref }),
      field: c.field,
      version: c.version,
      actor: c.by.actor,
      kind: c.by.kind,
      at: c.at,
    })),
    warnings: result.warnings.length,
  };
}

/**
 * Whether a replay returned what the first answer said: every reduced field but `replayed`. A
 * receipt stores the whole result but a conflict's value (A1 3.8), which `reduce` leaves out.
 */
export function sameResult(a: Acked, b: Acked): boolean {
  return differingParts(a, b).length === 0;
}

/** The names of the parts of two results that differ, `replayed` aside: names, never values. */
export function differingParts(a: Acked, b: Acked): (keyof Acked)[] {
  return (Object.keys({ ...a, ...b }) as (keyof Acked)[]).filter(
    (part) => part !== "replayed" && JSON.stringify(a[part]) !== JSON.stringify(b[part]),
  );
}

/** Writes one message, whole, to stdout. Safe from any thread of the child. */
export function emit(message: ChildMessage): void {
  const line = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  let offset = 0;
  while (offset < line.length) offset += writeSync(1, line, offset, line.length - offset);
}

/** The environment variable that hands the arm to the child's storage worker thread. */
export const ARM_VARIABLE = "TASKS_CRASH_ARM";

/** How long a child waits at its point for the kill before it gives up. */
export const KILL_WAIT_MS = 60_000;

/**
 * The seam for `where`: it counts the points reached there, and at the armed one it reports the
 * point, with the decision `decided` returns when the caller gives it (the write path's), and
 * blocks this thread until the parent kills the process. Each thread counts its own points, and
 * each `where` lives in one thread.
 */
export function faultSeam(
  where: Where,
  arm: Arm | null,
): (point: string, decided?: () => Decided) => void {
  const counts = new Map<string, number>();
  return (point, decided) => {
    const armed = arm?.where === where && arm.point === point ? arm : undefined;
    let detail: Decided | undefined;
    if (armed?.outcome !== undefined) {
      // Only the armed outcome counts at the armed point.
      detail = decided?.();
      if (
        detail === undefined ||
        detail.result.replayed ||
        detail.result.status !== armed.outcome
      ) {
        return;
      }
    }
    const nth = (counts.get(point) ?? 0) + 1;
    counts.set(point, nth);
    if (armed?.nth !== nth) return;
    detail ??= decided?.();
    emit({ t: "at", where, point, nth, ...(detail === undefined ? {} : { decided: detail }) });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KILL_WAIT_MS);
    // Still alive: the parent did not kill at the point. The run is broken, not the storage.
    throw new Error("The crash harness did not kill the child at its point");
  };
}

/** The arm the parent put in the environment, or null. */
export function armFromEnvironment(): Arm | null {
  const text = process.env[ARM_VARIABLE];
  if (text === undefined || text === "") return null;
  const value = JSON.parse(text) as Arm;
  if (
    !WHERES.includes(value.where) ||
    !POINTS[value.where].includes(value.point) ||
    (value.outcome !== undefined && (value.where !== "write" || !OUTCOMES.includes(value.outcome)))
  ) {
    throw new Error("The crash harness armed an unknown point");
  }
  return value;
}
