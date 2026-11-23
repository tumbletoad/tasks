// Agents' changes, as Today's Changes and the Agents page's Recent list them: each task an agent
// or a routine changed in the last seven days, newest change first, dated by its commit. Every
// snapshot brings the service's list, as of its cursor (the service's feed.ts), so the list is the
// same after a reload and in another tab; the batches after it add the changes agents make while
// the tab follows the space, and a change leaves when it turns seven days old.
//
// One log per live session, made with it (`changeLogOf`), so it hears the first snapshot and
// survives a switch of view. Plain code, no React; the views read it through
// `useSyncExternalStore`.
import type { TaskRow } from "../store/rows.ts";
import type { Changes } from "../store/store.ts";
import { CHANGES_DAYS, type TaskChange } from "./views.ts";

/** The actors whose changes Changes lists (A1 `actors.kind`): not the person, the system or an import. */
const AGENT_KINDS: ReadonlySet<string> = new Set(["agent", "routine"]);
/** The tasks the log remembers, newest first, as many as a snapshot brings: far more than Changes shows. */
const KEPT = 100;
/** How long a change stays. */
const KEPT_MS = CHANGES_DAYS * 86_400_000;

interface Source {
  onChanges(listener: (changes: Changes) => void): () => void;
}

export class ChangeLog {
  #entries: readonly TaskChange[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  /** Fires when the oldest entry turns seven days old. */
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(source: Source, now: () => number = Date.now) {
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

  #apply({ changes, reset, agentChanges }: Changes): void {
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

const logs = new WeakMap<Source, ChangeLog>();

/** The live session's change log, made the first time it is asked for. */
export function changeLogOf(live: Source): ChangeLog {
  let log = logs.get(live);
  if (log === undefined) {
    log = new ChangeLog(live);
    logs.set(live, log);
  }
  return log;
}
