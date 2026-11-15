// Agents' changes as this tab has seen them (A5 3.4's Changes, as far as the page's data allows).
// The digest proper is M5.09's: a per-space digest cursor in the service's machine-local UI state,
// the lines' sentences with Revert, Clear and "More in Agents" (A5 3.14). Until then Changes lists
// the tasks an agent or a routine changed while this tab followed the space, newest first: the
// feed names each commit's actor, and a change the tab did not see (before it opened, or behind a
// fresh snapshot) is not in it. A reload starts it empty, as a cleared digest does.
//
// One log per live session, kept beside it (`changeLogOf`), so it survives a switch of view and
// ends with the session's space. Plain code, no React; Today reads it through
// `useSyncExternalStore`.
import type { Change } from "../store/core.ts";
import type { Changes } from "../store/store.ts";
import type { TaskChange } from "./views.ts";

/** The actors whose changes Changes lists (A1 `actors.kind`): not the person, the system or an import. */
const AGENT_KINDS: ReadonlySet<string> = new Set(["agent", "routine"]);
/** The tasks the log remembers, newest first: far more than Changes shows. */
const KEPT = 100;

interface Source {
  onChanges(listener: (changes: Changes) => void): () => void;
}

export class ChangeLog {
  #entries: readonly TaskChange[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;

  constructor(source: Source, now: () => number = Date.now) {
    this.#now = now;
    source.onChanges(({ changes }) => {
      this.#apply(changes);
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

  #apply(changes: readonly Change[]): void {
    const at = this.#now();
    const fresh = new Map<string, TaskChange>();
    // A frame's changes are in commit order: the last one of a task is its newest.
    for (const change of changes) {
      if (!AGENT_KINDS.has(change.actor.kind) || change.task === undefined) continue;
      // A launch is the person's act and its receipts are the tile's, not a change to the task.
      if (change.type === "launch") continue;
      fresh.delete(change.task);
      fresh.set(change.task, { task: change.task, actor: change.actor.label, at });
    }
    if (fresh.size === 0) return;
    const newest = [...fresh.values()].reverse();
    this.#entries = [...newest, ...this.#entries.filter((e) => !fresh.has(e.task))].slice(0, KEPT);
    for (const listener of this.#listeners) listener();
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
