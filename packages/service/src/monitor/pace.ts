// How often the Agent Monitor is asked, set by the tabs that show an Agents page, and what those
// tabs are sent. Each tab says on its feed connection whether an Agents page is mounted, the tab
// is visible and its window has the focus; the service counts the five minutes since the focus
// went itself. The pace is that of the most attentive tab:
//
// - looked at (visible, and focused within five minutes): after each answer a rest of four times
//   its pass, at least 1 s and at most 15 s, with plan usage asked live;
// - visible only: every 30 s, plan usage from TTAM's cache;
// - none: nothing is asked, and the child ends by itself ten minutes after the last request.
//
// An answer that says `settling` is followed after 1 s, at most three times in a row. A launch or
// a stop in TTasks while someone watches asks once more right after the answer on its way. A tab
// that starts watching gets the newest picture, or why there is none, at once; the newest
// snapshot is kept for 30 s after the last tab stopped watching, and an answer that comes later
// is not kept at all. A monitor that is missing or does not fit is looked for again when an
// Agents page opens or a tab showing one gets the focus back.
//
// Each answer is joined with the agent sessions TTasks holds, read after the answer came, so an
// agent shows with the task TTasks started it for (links.ts), and with the tasks' T3 Code threads
// as T3 Code tells them then.
//
// Attention is read on the steady clock when a request is made, so a request that falls due late
// (a machine that slept) asks for what the tabs' attention is then. Ages count on the same clock
// from the moment a snapshot arrived, never from a time in it.
import type {
  AgentsTask,
  AgentsThread,
  AgentsView,
  AgentsWatch,
  MonitorProblem,
} from "@ttasks/contracts/monitor";
import { linksOf, Unseen, type HeldSession } from "./links.ts";
import type { Monitor, MonitorAnswer } from "./monitor.ts";
import { pictureOf } from "./picture.ts";

export const PACE = {
  /** Looked at: the rest is this many passes, within restMinMs and restMaxMs. */
  restPasses: 4,
  restMinMs: 1_000,
  restMaxMs: 15_000,
  /** Visible only. */
  visibleMs: 30_000,
  /** After an answer that says `settling`, at most settlingRuns times in a row. */
  settlingMs: 1_000,
  settlingRuns: 3,
  /** Since the focus went: still looked at. */
  focusMs: 5 * 60_000,
  /** The newest snapshot is kept this long after the last tab stopped watching. */
  keepMs: 30_000,
} as const;

export type PaceTimerKind = "monitor_ask" | "monitor_keep";

export type PaceTimers = (
  spec: { readonly kind: PaceTimerKind; readonly conn: number | undefined; readonly ms: number },
  fire: () => void,
) => { refresh(): void; clear(): void };

/** A tab: what it is sent. */
export interface Watcher {
  show(view: AgentsView): void;
}

type Attention = "none" | "visible" | "looked";
const RANK: Readonly<Record<Attention, number>> = { none: 0, visible: 1, looked: 2 };

interface Watching {
  readonly facts: AgentsWatch;
  /** On the steady clock: looked at until then. Infinity while focused. */
  readonly lookedUntil: number;
}

const verdict = (problem: MonitorProblem | undefined): boolean =>
  problem !== undefined && problem.kind !== "failed";

export interface PaceOptions {
  readonly monitor: Pick<Monitor, "ask" | "recheck" | "status">;
  readonly timers: PaceTimers;
  /** A steady clock in ms. */
  readonly now: () => number;
  /** The agent sessions TTasks holds now, in every open space. Default: none. */
  readonly held?: () => Promise<readonly HeldSession[]>;
  /** The tasks' T3 Code threads now, in every open space. Default: none. */
  readonly threads?: () => Promise<readonly AgentsThread[]>;
  /** Whose path rules join TTasks' agent homes to TTAM's. */
  readonly platform: NodeJS.Platform;
  /** How long a running agent must be missed before it is not seen. Default: UNSEEN_MS. */
  readonly unseenMs?: number;
}

/** The newest answer, with the tasks its agents work on. */
interface Newest {
  readonly answer: MonitorAnswer & { ok: true };
  readonly links: ReadonlyMap<string, AgentsTask>;
  readonly unseen: readonly AgentsTask[];
  readonly threads: readonly AgentsThread[];
  readonly at: number;
}

export class MonitorPace {
  readonly #options: PaceOptions;
  readonly #watching = new Map<Watcher, Watching>();
  #newest: Newest | undefined;
  readonly #unseen: Unseen;
  #problem: MonitorProblem | undefined;
  /** When the last answer came, of either kind: the rest counts from it. */
  #answeredAt: number | undefined;
  #settlingRun = 0;
  #asking = false;
  #again = false;
  /** An answer is overdue: raised by the monitor, cleared only with the next answer. */
  #slow = false;
  #ask: ReturnType<PaceTimers> | undefined;
  /** Nobody watches: until then the newest is kept, and an answer after it is not. */
  #keepUntil: number | undefined;
  #keep: ReturnType<PaceTimers> | undefined;
  #closed = false;

  constructor(options: PaceOptions) {
    this.#options = options;
    this.#unseen = new Unseen(options.unseenMs);
  }

  /** A tab's facts, as it sent them. */
  watch(watcher: Watcher, facts: AgentsWatch): void {
    if (this.#closed) return;
    const now = this.#options.now();
    const before = this.#watching.get(watcher);
    const was = before === undefined ? "none" : this.#attention(before, now);
    const opened = facts.agents && before?.facts.agents !== true;
    const focusBack = facts.focused && before?.facts.focused !== true;
    const lookedUntil = facts.focused
      ? Infinity
      : before?.facts.focused === true
        ? now + PACE.focusMs
        : (before?.lookedUntil ?? -Infinity);
    const entry: Watching = { facts, lookedUntil };
    this.#watching.set(watcher, entry);
    if ((opened || focusBack) && verdict(this.#problem)) {
      this.#problem = undefined;
      this.#answeredAt = undefined;
      this.#options.monitor.recheck();
    }
    if (was === "none" && this.#attention(entry, now) !== "none") watcher.show(this.#view());
    this.#plan();
  }

  /**
   * The tab's connection closed, or its sign-in ended (`signedOut`): when it was the last that
   * watched, what it was to be shown is dropped now, the answer on its way included.
   */
  leave(watcher: Watcher, signedOut = false): void {
    if (!this.#watching.delete(watcher)) return;
    if (signedOut && this.#level() === "none") {
      this.#keepUntil = this.#options.now();
      this.#drop();
    }
    this.#plan();
  }

  /** TTasks launched or stopped an agent: one more request, right after the answer on its way. */
  nudge(): void {
    if (this.#closed || this.#level() === "none") return;
    if (this.#asking) {
      this.#again = true;
      return;
    }
    this.#request();
  }

  /**
   * The monitor's status changed: an overdue answer marks the picture as not updating. Only the
   * next answer clears it, so the old picture is never shown as current in between.
   */
  changed(): void {
    if (this.#slow || !this.#options.monitor.status().slow) return;
    this.#slow = true;
    this.#show();
  }

  close(): void {
    this.#closed = true;
    this.#ask?.clear();
    this.#keep?.clear();
    this.#watching.clear();
  }

  #attention(entry: Watching, now: number): Attention {
    if (!entry.facts.agents || !entry.facts.visible) return "none";
    return now < entry.lookedUntil ? "looked" : "visible";
  }

  #level(): Attention {
    const now = this.#options.now();
    let level: Attention = "none";
    for (const entry of this.#watching.values()) {
      const attention = this.#attention(entry, now);
      if (RANK[attention] > RANK[level]) level = attention;
    }
    return level;
  }

  /** The rest after the last answer at `level`; undefined: ask no more until something changes. */
  #rest(level: Attention): number | undefined {
    if (level === "none" || verdict(this.#problem)) return undefined;
    const snapshot = this.#newest?.answer.snapshot;
    if (snapshot?.settling === true && this.#settlingRun <= PACE.settlingRuns) {
      return PACE.settlingMs;
    }
    if (level === "visible") return PACE.visibleMs;
    const pass = snapshot?.collectionMs ?? 0;
    return Math.min(PACE.restMaxMs, Math.max(PACE.restMinMs, PACE.restPasses * pass));
  }

  /** What no tab watches any more: the newest, and the rest that counted from it. */
  #drop(): void {
    this.#keep?.clear();
    this.#keep = undefined;
    this.#newest = undefined;
    this.#answeredAt = undefined;
    this.#settlingRun = 0;
    this.#unseen.reset();
  }

  /** Sets the next request by the most attentive tab, or none; keeps or drops the newest. */
  #plan(): void {
    if (this.#closed) return;
    const level = this.#level();
    if (level === "none") {
      this.#ask?.clear();
      this.#ask = undefined;
      if (this.#keepUntil === undefined) {
        this.#keepUntil = this.#options.now() + PACE.keepMs;
        this.#keep = this.#options.timers(
          { kind: "monitor_keep", conn: undefined, ms: PACE.keepMs },
          () => {
            this.#drop();
          },
        );
      }
      return;
    }
    this.#keepUntil = undefined;
    this.#keep?.clear();
    this.#keep = undefined;
    if (this.#asking) return;
    this.#ask?.clear();
    this.#ask = undefined;
    const rest = this.#rest(level);
    if (rest === undefined) return;
    const wait = this.#answeredAt === undefined ? 0 : this.#answeredAt + rest - this.#options.now();
    if (wait <= 0) {
      this.#request();
      return;
    }
    // When it fires the plan is made again: the attention may have changed meanwhile.
    this.#ask = this.#options.timers({ kind: "monitor_ask", conn: undefined, ms: wait }, () => {
      this.#ask = undefined;
      this.#plan();
    });
  }

  #request(): void {
    this.#ask?.clear();
    this.#ask = undefined;
    this.#asking = true;
    this.#again = false;
    const usage = this.#level() === "looked" ? "live" : "cached";
    void this.#options.monitor.ask(usage).then(async (answer) => {
      const [held, threads] = answer.ok
        ? await Promise.all([this.#held(), this.#threads()])
        : [[], []];
      this.#answered(answer, held, threads);
    });
  }

  /** What TTasks holds; none when it cannot be read now. */
  async #held(): Promise<readonly HeldSession[]> {
    try {
      return (await this.#options.held?.()) ?? [];
    } catch {
      return [];
    }
  }

  /** The tasks' T3 threads; none when they cannot be read now. */
  async #threads(): Promise<readonly AgentsThread[]> {
    try {
      return (await this.#options.threads?.()) ?? [];
    } catch {
      return [];
    }
  }

  #answered(
    answer: MonitorAnswer,
    held: readonly HeldSession[],
    threads: readonly AgentsThread[],
  ): void {
    this.#asking = false;
    if (this.#closed) return;
    const now = this.#options.now();
    this.#answeredAt = now;
    this.#slow = this.#options.monitor.status().slow;
    if (answer.ok) {
      this.#problem = undefined;
      this.#settlingRun = answer.snapshot.settling ? this.#settlingRun + 1 : 0;
      // An answer that comes after the newest would have been dropped is not kept either.
      if (this.#keepUntil !== undefined && now >= this.#keepUntil) this.#drop();
      else {
        const { snapshot } = answer;
        const platform = this.#options.platform;
        this.#newest = {
          answer,
          links: linksOf(snapshot, held, platform),
          unseen: this.#unseen.next(snapshot, held, platform, now),
          threads,
          at: now,
        };
      }
    } else {
      this.#problem = answer.problem;
      if (verdict(answer.problem)) this.#newest = undefined;
    }
    this.#show();
    if (this.#again && this.#level() !== "none") this.#request();
    else this.#plan();
  }

  #view(): AgentsView {
    const newest = this.#newest;
    const picture =
      newest === undefined
        ? null
        : pictureOf(
            newest.answer.snapshot,
            Math.max(0, this.#options.now() - newest.at),
            newest.links,
            newest.unseen,
            newest.threads,
          );
    const trouble = this.#problem ?? (this.#slow ? { kind: "slow" as const } : null);
    return { picture, trouble };
  }

  /** Every tab that watches gets the view now. */
  #show(): void {
    const now = this.#options.now();
    const watchers = [...this.#watching].filter(([, e]) => this.#attention(e, now) !== "none");
    if (watchers.length === 0) return;
    const view = this.#view();
    for (const [watcher] of watchers) watcher.show(view);
  }
}
