// The supervisor: which queued runs start and when, the update's hold on new starts, and which run
// folders go. It works on every space open as this machine's at once (a lane each: its run machine
// and run host), in rounds, one at a time. A round reads each space's open runs, settles a run left
// `starting` with nothing behind it, and starts what its limits allow:
//
// - The limits are guidelines a person sets in machine.toml (QUEUE_LIMITS by default): runs at once
//   on this machine, per agent instance and per task. A lower limit stops nothing that runs; it only
//   holds back what waits. A run counts from `starting` until its container is confirmed empty, so
//   a run whose end could not be confirmed (`unknown`) no longer holds a place.
// - The oldest queued run its limits allow starts first. One held back by its own instance or task
//   holds back no younger run of another, so no run waits while there is room for it.
// - Right before a queued run starts, what it needs is checked again (`prepare`): one that can no
//   longer start fails with why, before anything exists for it.
// - While an update holds the supervisor, or an update has not finished, nothing new starts;
//   queued runs wait and say so.
// - A run folder goes once its run is final, confirmed, saved in its space and old (retain).
import {
  FINAL_RUN_STATES,
  awaitsConfirmation,
  type QueueLimits,
  type RunRecord,
  type RunState,
} from "@tasks/contracts/runs";
import type { AgentCommand, RunHost } from "./host.ts";
import type { RunMachine, StartRefusal } from "./machine.ts";

export { QUEUE_LIMITS, type QueueLimits } from "@tasks/contracts/runs";

/** Why a queued run waits. */
export type WaitReason =
  /** As many runs as the machine allows run already. */
  | "machine_limit"
  /** As many runs of its agent instance as allowed run already. */
  | "instance_limit"
  /** Its task has as many runs as allowed already. */
  | "task_limit"
  /** An update waits for the runs to finish before it restarts the service. */
  | "update"
  /** Runs cannot be contained on this machine now (the container probe failed). */
  | "unavailable";

/** One space's runs: its run machine and its host, recovered before the supervisor gets it. */
export interface Lane {
  readonly space: string;
  readonly machine: RunMachine;
  readonly host: RunHost;
}

/**
 * What runs for a queued run, or why it can no longer start. `command` is asked once, after the
 * `starting` commit: a start whose commit did not land leaves it to the next try.
 */
export type Prepared =
  | { readonly command: (run: RunRecord) => AgentCommand | Promise<AgentCommand> }
  | { readonly refused: StartRefusal };

/** A run an update would cut short: one that may still run, or whose end is not confirmed. */
export interface Blocker {
  readonly space: string;
  readonly run: string;
  readonly task: string | null;
  readonly state: RunState;
}

/** The run folders the supervisor removes: RunFiles. */
export interface RunFolderList {
  list(): readonly { readonly id: string; readonly changedAt: number }[];
  remove(id: string): void;
  /** Whether the folder may hold an answer: one is there, or it could not be told. */
  hasAnswer(id: string): boolean;
}

/** How long run folders are kept: a folder older than `days`, or past the newest `count`, goes. */
export interface Retention {
  readonly days: number;
  readonly count: number;
}

export const RETENTION: Retention = { days: 14, count: 200 };

/** How often retention looks at the run folders. */
const RETAIN_EVERY_MS = 60 * 60_000;

/** How long a Stop of every blocking run may take: the grace, the confirmation, the drain. */
export const STOP_ALL_MS = 30_000;

/**
 * How long the check before a start may take. One that takes longer leaves its run queued for a
 * later round, so a folder that does not answer holds up no other run and no update.
 */
export const PREPARE_MS = 30_000;

export type SupervisorLog = (
  event: "run.refused" | "run.removed" | "run.failed",
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export interface SupervisorOptions {
  /** The spaces whose runs it works on now. */
  readonly lanes: () => readonly Lane[];
  /** The limits as the person set them now. */
  readonly limits: () => QueueLimits;
  /** Whether runs can be contained on this machine now. */
  readonly available: () => Promise<boolean>;
  /**
   * Checks a queued run again right before it starts, and names what runs. A check that throws
   * leaves the run queued for the next round.
   */
  readonly prepare: (lane: Lane, run: RunRecord) => Promise<Prepared>;
  /** Default: PREPARE_MS. */
  readonly prepareMs?: number;
  /**
   * Whether an update is under way that has not finished: nothing new starts meanwhile, even when
   * the updater's hold is gone. Default: none.
   */
  readonly updating?: () => boolean;
  /** The run folders, for retention. Without it no folder is removed. */
  readonly folders?: RunFolderList;
  readonly retention?: Retention;
  /** Wall clock milliseconds. Default: Date.now. */
  readonly now?: () => number;
  readonly log?: SupervisorLog;
}

/** A queued or active run as the limits see it. */
export interface Slot {
  readonly space: string;
  readonly id: string;
  readonly task: string | null;
  readonly instance: string;
  readonly queuedAt: number;
}

/** The states in which a run holds a place: its container may hold processes. */
const ACTIVE: ReadonlySet<RunState> = new Set([
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
  "reconciling",
]);

const FINAL: ReadonlySet<RunState> = new Set(FINAL_RUN_STATES);

const taskKey = (slot: { space: string; task: string | null }): string | undefined =>
  slot.task === null ? undefined : `${slot.space}\n${slot.task}`;

/**
 * Which queued runs start now, oldest first, and why each other one waits. `active` holds the runs
 * that hold a place. A run held back by its instance or task does not hold back a younger one.
 */
export function planStarts(
  queued: readonly Slot[],
  active: readonly Slot[],
  limits: QueueLimits,
): { start: Slot[]; waiting: Map<string, WaitReason> } {
  let total = active.length;
  const instances = new Map<string, number>();
  const tasks = new Map<string, number>();
  const count = (slot: Slot) => {
    instances.set(slot.instance, (instances.get(slot.instance) ?? 0) + 1);
    const key = taskKey(slot);
    if (key !== undefined) tasks.set(key, (tasks.get(key) ?? 0) + 1);
  };
  for (const slot of active) count(slot);
  const start: Slot[] = [];
  const waiting = new Map<string, WaitReason>();
  const ordered = [...queued].sort(
    (a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const slot of ordered) {
    const key = taskKey(slot);
    if (total >= limits.runs) waiting.set(slot.id, "machine_limit");
    else if ((instances.get(slot.instance) ?? 0) >= limits.perInstance) {
      waiting.set(slot.id, "instance_limit");
    } else if (key !== undefined && (tasks.get(key) ?? 0) >= limits.perTask) {
      waiting.set(slot.id, "task_limit");
    } else {
      start.push(slot);
      count(slot);
      total += 1;
    }
  }
  return { start, waiting };
}

const slotOf = (space: string, run: RunRecord): Slot => ({
  space,
  id: run.id,
  task: run.task,
  instance: run.instance,
  queuedAt: run.queuedAt,
});

/** An update's hold: nothing new starts until it is released, or its holder is gone. */
export interface Hold {
  release(): void;
}

export class Supervisor {
  readonly #options: SupervisorOptions;
  readonly #now: () => number;
  readonly #log: SupervisorLog;
  readonly #holds = new Set<object>();
  /** Runs whose start this supervisor has under way: their record may still say `queued`. */
  readonly #starting = new Set<string>();
  /** What the last round read of each space, by space. */
  #records = new Map<string, readonly RunRecord[]>();
  #waiting = new Map<string, WaitReason>();
  #tail: Promise<void> = Promise.resolve();
  #pending: Promise<void> | undefined;
  #rounds = 0;
  #roundEnded: (() => void)[] = [];
  #retainedAt: number | undefined;
  #closed = false;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => undefined);
  }

  /** Why a queued run waits, as the last round saw it; undefined for any other run. */
  waiting(run: string): WaitReason | undefined {
    return this.#waiting.get(run);
  }

  /** Whether an update holds new starts back now. */
  get held(): boolean {
    if (this.#holds.size > 0) return true;
    try {
      return this.#options.updating?.() === true;
    } catch {
      return true;
    }
  }

  /**
   * A round soon, after the one under way: resolves once it ended. Rounds never overlap, so two of
   * them never start the same run or count past a limit.
   */
  round(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#pending !== undefined) return this.#pending;
    const next: Promise<void> = this.#tail.then(async () => {
      if (this.#pending === next) this.#pending = undefined;
      try {
        await this.#once();
      } catch (error) {
        this.#failed("round", error);
      } finally {
        this.#rounds += 1;
        for (const resolve of this.#roundEnded.splice(0)) resolve();
      }
    });
    this.#pending = next;
    this.#tail = next;
    return next;
  }

  /** Holds every new start until released; queued runs wait with the reason `update`. */
  hold(): Hold {
    const token = {};
    this.#holds.add(token);
    void this.round();
    return {
      release: () => {
        if (this.#holds.delete(token)) void this.round();
      },
    };
  }

  /** The runs an update would cut short now, read afresh. */
  async blocking(): Promise<Blocker[]> {
    await this.round();
    return this.#blockers();
  }

  /**
   * Stops every run an update would cut short: a Stop for each that may still run, End by force
   * for each whose end was not confirmed. Waits up to `ms` for them to end, and returns those left.
   */
  async stopAll(ms: number = STOP_ALL_MS): Promise<Blocker[]> {
    const lanes = new Map(this.#options.lanes().map((lane) => [lane.space, lane]));
    const ending: Promise<unknown>[] = [];
    for (const blocker of await this.blocking()) {
      const lane = lanes.get(blocker.space);
      if (lane === undefined) continue;
      const host = lane.host;
      const done =
        blocker.state === "unknown"
          ? host.forceEnd(blocker.run)
          : host.stop(blocker.run).then(() => host.ended(blocker.run));
      ending.push(
        done.catch((error: unknown) => {
          this.#failed("stop_all", error);
        }),
      );
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(ending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    return this.blocking();
  }

  /**
   * The run once it is final: a queued run waits for the round that starts or refuses it, a run
   * the host works on for the host's end of it.
   */
  async ended(lane: Lane, id: string): Promise<RunRecord | undefined> {
    let asked = false;
    for (;;) {
      const seen = this.#rounds;
      const run = await lane.machine.read(id);
      if (run === undefined || FINAL.has(run.state) || this.#closed) return run;
      if (lane.host.hosted().includes(id)) return lane.host.ended(id);
      if (this.#rounds !== seen) continue;
      // A queued run waits for the round that starts or refuses it. One left `starting` with
      // nothing behind it is settled by a round: one is asked for now, and if that did not settle
      // it (its store did not answer), the regular rounds go on trying.
      const next = new Promise<void>((resolve) => {
        this.#roundEnded.push(resolve);
      });
      if (run.state !== "queued" && !asked) {
        asked = true;
        void this.round();
      }
      await next;
    }
  }

  /** Ends the rounds: what runs is the hosts' to end, what waits stays queued. */
  close(): void {
    this.#closed = true;
    for (const resolve of this.#roundEnded.splice(0)) resolve();
  }

  /**
   * The runs whose record says they may still run, and every run a host works on whatever its
   * last read record says: a space whose store did not answer keeps what was read before, and a
   * run that started after that read is still in it as `queued`.
   */
  #blockers(): Blocker[] {
    const out: Blocker[] = [];
    const lanes = new Map(this.#options.lanes().map((lane) => [lane.space, lane]));
    const spaces = new Set([...this.#records.keys(), ...lanes.keys()]);
    for (const space of spaces) {
      const runs = this.#records.get(space) ?? [];
      const hosted = new Set(lanes.get(space)?.host.hosted() ?? []);
      for (const run of runs) {
        const listed = ACTIVE.has(run.state) || awaitsConfirmation(run);
        if (listed || hosted.has(run.id)) {
          out.push({
            space,
            run: run.id,
            task: run.task,
            state: run.state === "queued" ? "starting" : run.state,
          });
        }
        hosted.delete(run.id);
      }
      for (const id of hosted) out.push({ space, run: id, task: null, state: "running" });
    }
    return out;
  }

  async #once(): Promise<void> {
    if (this.#closed) return;
    const lanes = this.#options.lanes();
    const read = await Promise.all(
      lanes.map(async (lane) => {
        try {
          return { lane, runs: await lane.machine.open() };
        } catch (error) {
          this.#failed("read", error);
          return { lane, runs: undefined };
        }
      }),
    );
    // A run whose `starting` commit landed after its host gave up on it: nothing runs for it.
    for (const { lane, runs } of read) {
      for (const run of runs ?? []) {
        if (
          run.state === "starting" &&
          !this.#starting.has(run.id) &&
          !lane.host.hosted().includes(run.id)
        ) {
          await lane.host.settleUnstarted(run.id).catch((error: unknown) => {
            this.#failed("unstarted", error);
          });
        }
      }
    }
    const records = new Map<string, readonly RunRecord[]>();
    const queued: Slot[] = [];
    const active: Slot[] = [];
    for (const { lane, runs } of read) {
      if (runs === undefined) {
        // Its store did not answer: what this host runs there still holds a place, and its queue
        // waits for the next round.
        const known = this.#records.get(lane.space) ?? [];
        records.set(lane.space, known);
        for (const run of known) {
          if (ACTIVE.has(run.state) || lane.host.hosted().includes(run.id)) {
            active.push(slotOf(lane.space, run));
          }
        }
        continue;
      }
      const fresh = await this.#fresh(lane, runs);
      records.set(lane.space, fresh);
      for (const run of fresh) {
        if (run.state === "queued") queued.push(slotOf(lane.space, run));
        else if (ACTIVE.has(run.state)) active.push(slotOf(lane.space, run));
      }
    }
    this.#records = records;

    let start: Slot[] = [];
    let waiting: Map<string, WaitReason>;
    if (this.held) {
      waiting = new Map(queued.map((slot) => [slot.id, "update" as const]));
    } else if (queued.length > 0 && !(await this.#available())) {
      waiting = new Map(queued.map((slot) => [slot.id, "unavailable" as const]));
    } else {
      ({ start, waiting } = planStarts(queued, active, this.#options.limits()));
    }
    this.#waiting = waiting;

    const byId = new Map<string, { lane: Lane; run: RunRecord }>();
    for (const { lane } of read) {
      for (const run of records.get(lane.space) ?? []) byId.set(run.id, { lane, run });
    }
    // A planned run that left the queue without starting (refused, or stopped meanwhile) leaves
    // its place to the next round, which comes at once. One still queued waits for a later round.
    let again = false;
    for (const slot of start) {
      const found = byId.get(slot.id);
      if (found === undefined || this.#isClosed() || this.held) continue;
      if (await this.#start(found.lane, found.run)) again = true;
    }
    await this.#retainWhenDue();
    if (again) void this.round();
  }

  /** The runs after the strays were settled: those are read again. */
  async #fresh(lane: Lane, runs: readonly RunRecord[]): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const run of runs) {
      if (run.state !== "starting" || lane.host.hosted().includes(run.id)) {
        out.push(run);
        continue;
      }
      const now = await lane.machine.read(run.id).catch(() => run);
      if (now !== undefined && (!FINAL.has(now.state) || awaitsConfirmation(now))) out.push(now);
    }
    return out;
  }

  async #available(): Promise<boolean> {
    try {
      return await this.#options.available();
    } catch {
      return false;
    }
  }

  /**
   * Starts one queued run. True when its place went unused: it left the queue without starting
   * (refused, or stopped meanwhile). A check or a store that failed, or a store that did not take
   * the move, leaves it queued for a later round, and its place unused until then.
   */
  async #start(lane: Lane, run: RunRecord): Promise<boolean> {
    this.#starting.add(run.id);
    try {
      let prepared: Prepared | undefined;
      try {
        prepared = await this.#bounded(this.#options.prepare(lane, run));
      } catch (error) {
        this.#failed("prepare", error);
        return false;
      }
      if (prepared === undefined) {
        this.#log("run.failed", { stage: "prepare", type: "timeout" });
        return false;
      }
      if ("refused" in prepared) {
        const after = await lane.machine.refuse(run.id, prepared.refused);
        this.#log("run.refused", { reason: prepared.refused });
        return after !== undefined && after.state !== "queued";
      }
      const begun = await lane.host.start(run.id, prepared.command);
      if (begun?.state === "starting" && lane.host.hosted().includes(run.id)) {
        // Its end frees a place: the next round may start what waits.
        void lane.host.ended(run.id).then(
          () => this.round(),
          () => this.round(),
        );
        return false;
      }
      return begun !== undefined && begun.state !== "queued";
    } catch (error) {
      this.#failed("start", error);
      return false;
    } finally {
      this.#starting.delete(run.id);
    }
  }

  /** `promise`'s value, or undefined once it took longer than prepareMs. */
  async #bounded<T>(promise: Promise<T>): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            resolve(undefined);
          }, this.#options.prepareMs ?? PREPARE_MS);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #retainWhenDue(): Promise<void> {
    const now = this.#now();
    if (this.#options.folders === undefined) return;
    if (this.#retainedAt !== undefined && now - this.#retainedAt < RETAIN_EVERY_MS) return;
    this.#retainedAt = now;
    await this.retain().catch((error: unknown) => {
      this.#failed("retain", error);
    });
  }

  /**
   * Removes the run folders past the newest `count` or older than `days`, each only when its run
   * is final, its end confirmed, its host done with it, and its answer saved in its space (its
   * record holds the answer, or the folder has no answer file). A folder whose run no open space
   * knows stays: its space may open again. Returns how many went.
   */
  async retain(): Promise<number> {
    const folders = this.#options.folders;
    if (folders === undefined) return 0;
    const { days, count } = this.#options.retention ?? RETENTION;
    const oldest = this.#now() - days * 24 * 60 * 60_000;
    const listed = [...folders.list()].sort((a, b) => b.changedAt - a.changedAt);
    const candidates = listed.filter((folder, i) => i >= count || folder.changedAt < oldest);
    if (candidates.length === 0) return 0;
    const lanes = this.#options.lanes();
    let removed = 0;
    for (const folder of candidates) {
      if (this.#closed) break;
      if (!(await this.#removable(lanes, folder.id, folders))) continue;
      try {
        folders.remove(folder.id);
        removed += 1;
      } catch (error) {
        this.#failed("remove", error);
      }
    }
    if (removed > 0) this.#log("run.removed", { folders: removed });
    return removed;
  }

  async #removable(lanes: readonly Lane[], id: string, folders: RunFolderList): Promise<boolean> {
    for (const lane of lanes) {
      let run: RunRecord | undefined;
      try {
        run = await lane.machine.read(id);
      } catch {
        return false;
      }
      if (run === undefined) continue;
      if (!FINAL.has(run.state) || awaitsConfirmation(run)) return false;
      if (lane.host.hosted().includes(id) || this.#starting.has(id)) return false;
      if (typeof run.result?.text === "string") return true;
      return !folders.hasAnswer(id);
    }
    return false;
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #failed(stage: string, error: unknown): void {
    this.#log("run.failed", { stage, type: error instanceof Error ? error.name : typeof error });
  }
}
