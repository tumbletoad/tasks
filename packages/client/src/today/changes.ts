// Agents' changes, as Today's Changes and the Agents page's Recent list them: each task an agent
// or a routine changed in the last seven days, newest change first, dated by its commit; and the
// pages an agent changed last. Every snapshot brings the service's list, as of its cursor (the
// service's feed.ts), so the list is the same after a reload, in another tab and on a phone; the
// batches after it add the changes agents make while the reader follows the space, and a change
// leaves when it turns seven days old.
//
// Plain code, no React: the page reads a log through `useSyncExternalStore`, the phone's session
// feeds one from its link.
import type { Change } from "../store/core.ts";
import type { AgentChange, PageRow, TaskRow } from "../store/rows.ts";
import { CHANGES_DAYS, type TaskChange } from "./views.ts";

/** What a reader of the feed hears at each frame: what applied, and whether a snapshot replaced all. */
export interface ChangeFrame {
  readonly changes: readonly Change[];
  readonly reset: boolean;
  /** With `reset`: the tasks agents changed lately, as of the snapshot, before `changes`. */
  readonly agentChanges?: readonly AgentChange[];
}

/** The actors whose changes Changes lists: not the person, the system or an import. */
export const AGENT_KINDS: ReadonlySet<string> = new Set(["agent", "routine"]);
/** The tasks the log remembers, newest first, as many as a snapshot brings: far more than Changes shows. */
const KEPT = 100;
/** How long a change stays. */
const KEPT_MS = CHANGES_DAYS * 86_400_000;

export interface ChangeSource {
  onChanges(listener: (changes: ChangeFrame) => void): () => void;
}

export class ChangeLog {
  #entries: readonly TaskChange[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  /** Fires when the oldest entry turns seven days old. */
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(source: ChangeSource, now: () => number = Date.now) {
    this.#now = now;
    source.onChanges((frame) => {
      this.#apply(frame);
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Each changed task once, its newest change first. Keeps its identity until a change lands. */
  readonly getEntries = (): readonly TaskChange[] => this.#entries;

  #apply({ changes, reset, agentChanges }: ChangeFrame): void {
    const now = this.#now();
    const fresh = new Map<string, TaskChange>();
    /** Each task's newest row in the frame, whoever changed it. */
    const rows = new Map<string, TaskRow>();
    // A frame's changes are in commit order: the last one of a task is its newest.
    for (const change of changes) {
      if (change.type === "task" && change.after !== undefined) {
        rows.set(change.id, change.after as TaskRow);
      }
      if (!AGENT_KINDS.has(change.actor.kind) || change.task === undefined) continue;
      // A launch is the person's act and its receipts are the tile's, not a change to the task.
      if (change.type === "launch") continue;
      fresh.delete(change.task);
      fresh.set(change.task, {
        task: change.task,
        actor: change.actor.label,
        at: change.at ?? now,
      });
    }
    // A snapshot's list replaces what the log held: the frame's changes come after it.
    const seeded = reset && agentChanges !== undefined;
    const base = seeded ? agentChanges : this.#entries;
    const held = base.filter((e) => !fresh.has(e.task));
    if (!seeded && fresh.size === 0 && !held.some((e) => rows.has(e.task))) return;
    const before = new Map(base.map((e) => [e.task, e.row]));
    const withRow = (entry: TaskChange): TaskChange => {
      const row = rows.get(entry.task) ?? before.get(entry.task);
      return row === undefined ? entry : { ...entry, row };
    };
    const newest = [...fresh.values()].reverse();
    // A deleted task leaves, so it takes no place of one the person comes back to see.
    this.#set(
      [...newest, ...held]
        .map(withRow)
        .filter((e) => e.row?.deleted_at === undefined && e.at >= now - KEPT_MS)
        .slice(0, KEPT),
    );
  }

  #set(entries: readonly TaskChange[]): void {
    this.#entries = entries;
    this.#schedule();
    for (const listener of this.#listeners) listener();
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#entries.length === 0) return;
    const oldest = Math.min(...this.#entries.map((e) => e.at));
    this.#timer = setTimeout(
      () => {
        this.#expire();
      },
      Math.max(0, oldest + KEPT_MS - this.#now()) + 1,
    );
  }

  #expire(): void {
    const since = this.#now() - KEPT_MS;
    const kept = this.#entries.filter((e) => e.at >= since);
    if (kept.length < this.#entries.length) this.#set(kept);
    else this.#schedule();
  }
}

/**
 * The pages an agent or a routine changed last in the past `days`, newest first, at most `limit`:
 * Today's Changes beside the tasks. A page the person changed after it is the person's again.
 */
export function agentPages(
  pages: Iterable<PageRow>,
  now: number,
  days: number,
  limit: number,
): PageRow[] {
  const since = now - days * 86_400_000;
  return [...pages]
    .filter((page) => page.by !== "user" && page.by !== "import" && page.at >= since)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
