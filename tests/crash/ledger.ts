// What the crash harness knows about one space: every request it planned, the results the child
// acknowledged (which must stay true after any kill), the requests that were in flight when the
// child died (which the next round retries), the backups that completed with what each must hold,
// and the restores in place with the folder each one replaced.
//
// "Must stay true" is a lower bound: a request in flight at the kill may have committed, so the
// space may hold more than the ledger expects, never less. A restore in place replaces the
// expectation with what the restored backup holds: the results acknowledged before that backup
// started. Its old expectation moves to the replaced folder, which must keep it.
import { basename, dirname } from "node:path";
import type { Operation } from "../../packages/storage/src/write/request.ts";
import {
  differingParts,
  sameResult,
  type Acked,
  type BackupFacts,
  type ChildMessage,
  type PlannedRequest,
} from "./protocol.ts";

/** A broken guarantee: the invariant's name and a detail that holds no task text. */
export interface Violation {
  invariant: string;
  detail: string;
}

export interface BackupEntry {
  facts: BackupFacts;
  /** The results acknowledged before the backup started: the backup holds at least these. */
  snapshot: Map<string, Acked>;
}

/** The live folder a restore in place moved aside, and what it must still hold. */
export interface ReplacedSpace {
  incarnation: string;
  expected: Map<string, Acked>;
}

interface PendingRestore {
  backup: string;
  before: Map<string, Acked>;
  incarnation: string;
}

export interface LedgerStats {
  acked: number;
  replays: number;
  backups: number;
  migrations: number;
  restores: number;
  /** Agent actors the child's writers resolved: each joined the space in an `actor.register`. */
  actors: number;
}

export class Ledger {
  readonly folder: string;
  readonly parent: string;
  readonly slug: string;
  readonly spaceId: string;
  readonly owner: string;
  /** Acknowledged results that must stay true, by `<scope> <request ID>`. */
  expected = new Map<string, Acked>();
  /** Every request planned, for retries. */
  readonly requests = new Map<string, PlannedRequest>();
  /** Sent and not answered, in the order they were sent. */
  readonly inflight = new Map<string, PlannedRequest>();
  /** Task IDs the plan created or meant to. */
  readonly tasks: string[] = [];
  /** The operations of recent single patches and source links, which the plan sends again. */
  readonly recent: Operation[][] = [];
  readonly backups = new Map<string, BackupEntry>();
  readonly replaced: ReplacedSpace[] = [];
  pending: PendingRestore | undefined;
  /**
   * Decisions a kill rolled back: the write seam reported them at `before-commit`, so neither
   * their receipt nor their commit may be in the space before the next round retries them.
   */
  readonly uncommitted = new Map<string, Acked>();
  /** The stamps of the `<slug>.replaced-<stamp>` folders the last check found. */
  replacedSeen = new Set<string>();
  /** Restores in place that reported their end since the last check: each made one such folder. */
  swapsSinceCheck = 0;
  /**
   * The restores in place applied since the last check, each with the incarnation its claim
   * reported and the backup the harness asked for: the check finds that claim in the lineage and
   * requires it to name that backup, as for an interrupted restore.
   */
  readonly claimsSinceCheck: { incarnation: string; backup: BackupFacts }[] = [];
  /** What the last check read, and the counters it must never see go back. */
  incarnation = "";
  epoch = 0;
  readonly epochs = new Set<number>();
  /** The highest last_seq and next_ref seen per incarnation. */
  readonly highWater = new Map<string, { seq: number; nextRef: number }>();
  revision = 0;
  base = "";
  /** A counter for fixture text and request IDs. */
  counter = 0;
  readonly stats: LedgerStats = {
    acked: 0,
    replays: 0,
    backups: 0,
    migrations: 0,
    restores: 0,
    actors: 0,
  };
  readonly #starting = new Map<number, Map<string, Acked>>();
  readonly #agents = new Set<string>();

  constructor(folder: string, spaceId: string, owner: string) {
    this.folder = folder;
    this.parent = dirname(folder);
    this.slug = basename(folder);
    this.spaceId = spaceId;
    this.owner = owner;
  }

  /** Takes in one message of the child. Returns what it proves broken at once. */
  take(message: ChildMessage): Violation[] {
    switch (message.t) {
      case "ready":
        if (message.migrated !== null) {
          this.stats.migrations += 1;
          this.#backupDone(message.migrated, new Map(this.expected));
        }
        return [];
      case "actor":
        // The checker accounts for the actor's commit (system-commit); this only counts them.
        this.#agents.add(message.id);
        this.stats.actors = this.#agents.size;
        return [];
      case "send": {
        const request = this.requests.get(message.key);
        if (request !== undefined) {
          this.inflight.delete(message.key);
          this.inflight.set(message.key, request);
        }
        return [];
      }
      case "ack":
        return this.#ack(message.key, message.result);
      case "backup-start":
        this.#starting.set(message.n, new Map(this.expected));
        return [];
      case "backup-done":
        this.#backupDone(message.backup, this.#starting.get(message.n) ?? new Map<string, Acked>());
        this.#starting.delete(message.n);
        return [];
      case "restore-start":
        this.pending = {
          backup: message.backup,
          before: new Map(this.expected),
          incarnation: this.incarnation,
        };
        return [];
      case "restore-done":
        this.swapsSinceCheck += 1;
        return this.applyRestore(message.incarnation, message.epoch);
      case "at":
        return message.decided === undefined ? [] : this.#atPoint(message.point, message.decided);
      case "error":
      case "done":
        return [];
    }
  }

  /**
   * A write point's decision. After COMMIT it is durable although no reply went back: it must stay
   * true exactly like an acknowledged result, and a retry must replay it (A1 3.8: every
   * decided outcome's receipt is in its own transaction). Before COMMIT the kill rolls it back: a
   * new decision must leave no trace, and the next round retries it. A replay decided nothing new.
   */
  #atPoint(point: string, decided: { key: string; result: Acked }): Violation[] {
    if (point === "after-commit") {
      const violations = this.#ack(decided.key, decided.result);
      // The caller never got the reply, so the next round retries the request, which must replay.
      const request = this.requests.get(decided.key);
      if (request !== undefined) this.inflight.set(decided.key, request);
      return violations;
    }
    if (point === "before-commit" && !decided.result.replayed) {
      this.uncommitted.set(decided.key, decided.result);
    }
    return [];
  }

  #backupDone(facts: BackupFacts, snapshot: Map<string, Acked>): void {
    this.stats.backups += 1;
    this.backups.set(facts.name, { facts, snapshot });
  }

  #ack(key: string, result: Acked): Violation[] {
    this.inflight.delete(key);
    this.stats.acked += 1;
    if (result.replayed) this.stats.replays += 1;
    const prior = this.expected.get(key);
    if (prior === undefined) {
      this.expected.set(key, result);
      return [];
    }
    if (!result.replayed) {
      return [
        {
          invariant: "retry-applies-once",
          detail: `a request with a stored receipt (${prior.status} at seq ${String(prior.seq)}) was decided again (${result.status} at seq ${String(result.seq)})`,
        },
      ];
    }
    if (!sameResult(prior, result)) {
      // The parts that differ, by name: the values themselves stay out of the report.
      return [
        {
          invariant: "retry-replays-identically",
          detail: `a replay of ${prior.status} at seq ${String(prior.seq)} differs from the first answer in ${differingParts(prior, result).join(", ")}`,
        },
      ];
    }
    return [];
  }

  /**
   * A restore in place took effect: the space is now the restored backup under a new incarnation
   * and epoch. The replaced folder must keep what the space held before.
   */
  applyRestore(incarnation: string, epoch: number): Violation[] {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) {
      return [{ invariant: "incarnation", detail: "a restore finished that never started" }];
    }
    const entry = this.backups.get(pending.backup);
    if (entry === undefined) {
      return [
        { invariant: "incarnation", detail: "a restore used a backup the harness never saw" },
      ];
    }
    this.stats.restores += 1;
    this.claimsSinceCheck.push({ incarnation, backup: entry.facts });
    this.replaced.push({ incarnation: pending.incarnation, expected: pending.before });
    this.expected = new Map(entry.snapshot);
    const violations: Violation[] = [];
    const highest = Math.max(0, ...this.epochs);
    if (epoch <= highest) {
      violations.push({
        invariant: "epoch-monotonic",
        detail: `a restore's claim took epoch ${String(epoch)}, not above ${String(highest)}`,
      });
    }
    this.incarnation = incarnation;
    this.epoch = epoch;
    this.epochs.add(epoch);
    return violations;
  }

  /** The backup a pending restore used. */
  pendingBackup(): BackupEntry | undefined {
    return this.pending === undefined ? undefined : this.backups.get(this.pending.backup);
  }
}
