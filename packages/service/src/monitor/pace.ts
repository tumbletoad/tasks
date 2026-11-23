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
// snapshot is kept for 30 s after the last tab stopped watching. A monitor that is missing or does
// not fit is looked for again when an Agents page opens or a tab showing one gets the focus back.
//
// Ages count on the service's steady clock from the moment a snapshot arrived, never from a time
// in it.
import type { AgentsView, AgentsWatch, MonitorProblem } from "@ttasks/contracts/monitor";
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

export type PaceTimerKind = "monitor_ask" | "monitor_focus" | "monitor_keep";

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
  facts: AgentsWatch;
  /** Focused within focusMs. */
  recent: boolean;
  focus: ReturnType<PaceTimers> | undefined;
}

const verdict = (problem: MonitorProblem | undefined): boolean =>
  problem !== undefined && problem.kind !== "failed";

export interface PaceOptions {
  readonly monitor: Pick<Monitor, "ask" | "recheck" | "status">;
  readonly timers: PaceTimers;
  /** A steady clock in ms. */
  readonly now: () => number;
}

export class MonitorPace {
  readonly #options: PaceOptions;
  readonly #watching = new Map<Watcher, Watching>();
  #newest: { readonly answer: MonitorAnswer & { ok: true }; readonly at: number } | undefined;
  #problem: MonitorProblem | undefined;
  /** When the last answer came, of either kind: the rest counts from it. */
  #answeredAt: number | undefined;
  #settlingRun = 0;
  #asking = false;
  #again = false;
  #slow = false;
  #ask: ReturnType<PaceTimers> | undefined;
  #keep: ReturnType<PaceTimers> | undefined;
  #closed = false;

  constructor(options: PaceOptions) {
    this.#options = options;
  }

  /** A tab's facts, as it sent them. */
  watch(watcher: Watcher, facts: AgentsWatch): void {
    if (this.#closed) return;
    const before = this.#watching.get(watcher);
    const was = before === undefined ? "none" : this.#attention(before);
    const entry: Watching = before ?? { facts, recent: false, focus: undefined };
    const opened = facts.agents && before?.facts.agents !== true;
    const focusBack = facts.focused && before?.facts.focused !== true;
    if (facts.focused) {
      entry.focus?.clear();
      entry.focus = undefined;
      entry.recent = true;
    } else if (before?.facts.focused === true) {
      entry.focus?.clear();
      entry.focus = this.#options.timers(
        { kind: "monitor_focus", conn: undefined, ms: PACE.focusMs },
        () => {
          entry.focus = undefined;
          entry.recent = false;
          this.#plan();
        },
      );
    }
    entry.facts = facts;
    this.#watching.set(watcher, entry);
    if ((opened || focusBack) && verdict(this.#problem)) {
      this.#problem = undefined;
      this.#answeredAt = undefined;
      this.#options.monitor.recheck();
    }
    if (was === "none" && this.#attention(entry) !== "none") {
      this.#keep?.clear();
      this.#keep = undefined;
      watcher.show(this.#view());
    }
    this.#plan();
  }

  /** The tab's connection closed, or its sign-in ended. */
  leave(watcher: Watcher): void {
    const entry = this.#watching.get(watcher);
    if (entry === undefined) return;
    entry.focus?.clear();
    this.#watching.delete(watcher);
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

  /** The monitor's status changed: an overdue answer marks the picture as not updating. */
  changed(): void {
    const slow = this.#options.monitor.status().slow;
    if (slow === this.#slow) return;
    this.#slow = slow;
    this.#show();
  }

  close(): void {
    this.#closed = true;
    this.#ask?.clear();
    this.#keep?.clear();
    for (const entry of this.#watching.values()) entry.focus?.clear();
    this.#watching.clear();
  }

  #attention(entry: Watching): Attention {
    if (!entry.facts.agents || !entry.facts.visible) return "none";
    return entry.recent ? "looked" : "visible";
  }

  #level(): Attention {
    let level: Attention = "none";
    for (const entry of this.#watching.values()) {
      const attention = this.#attention(entry);
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

  /** Sets the next request by the most attentive tab, or none; keeps or drops the newest. */
  #plan(): void {
    if (this.#closed) return;
    const level = this.#level();
    if (level === "none") {
      this.#ask?.clear();
      this.#ask = undefined;
      if (this.#newest !== undefined && this.#keep === undefined) {
        this.#keep = this.#options.timers(
          { kind: "monitor_keep", conn: undefined, ms: PACE.keepMs },
          () => {
            this.#keep = undefined;
            this.#newest = undefined;
            this.#answeredAt = undefined;
            this.#settlingRun = 0;
          },
        );
      }
      return;
    }
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
    this.#ask = this.#options.timers({ kind: "monitor_ask", conn: undefined, ms: wait }, () => {
      this.#ask = undefined;
      this.#request();
    });
  }

  #request(): void {
    this.#ask?.clear();
    this.#ask = undefined;
    this.#asking = true;
    this.#again = false;
    const usage = this.#level() === "looked" ? "live" : "cached";
    void this.#options.monitor.ask(usage).then((answer) => {
      this.#answered(answer);
    });
  }

  #answered(answer: MonitorAnswer): void {
    this.#asking = false;
    if (this.#closed) return;
    const now = this.#options.now();
    this.#answeredAt = now;
    if (answer.ok) {
      this.#newest = { answer, at: now };
      this.#problem = undefined;
      this.#settlingRun = answer.snapshot.settling ? this.#settlingRun + 1 : 0;
    } else {
      this.#problem = answer.problem;
      if (verdict(answer.problem)) this.#newest = undefined;
    }
    this.#slow = this.#options.monitor.status().slow;
    this.#show();
    if (this.#again && this.#level() !== "none") this.#request();
    else this.#plan();
  }

  #view(): AgentsView {
    const newest = this.#newest;
    const picture =
      newest === undefined
        ? null
        : pictureOf(newest.answer.snapshot, Math.max(0, this.#options.now() - newest.at));
    const trouble = this.#problem ?? (this.#slow ? { kind: "slow" as const } : null);
    return { picture, trouble };
  }

  /** Every tab that watches gets the view now. */
  #show(): void {
    const watchers = [...this.#watching].filter(([, e]) => this.#attention(e) !== "none");
    if (watchers.length === 0) return;
    const view = this.#view();
    for (const [watcher] of watchers) watcher.show(view);
  }
}
