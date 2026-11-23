// Every agent once on the Agents page: an agent the monitor sees that works on a task of this
// space is shown as that task's row, in the group its state puts it in, and not again under "On
// this computer". TTasks' record decides what a row is: a background run's state is TTasks' own,
// and its row stays where the run puts it; an agent in a terminal is where the monitor's state
// puts it. A terminal agent TTasks holds as running that the monitor has not seen is shown as
// such, never as idle.
import type { AgentsPicture, AgentsSession } from "@ttasks/contracts/monitor";
import type { TaskRow } from "../store/rows.ts";

/** The states of the third group, in its order: every state but needing the person or working. */
export const OTHER_STATES = ["idle", "shell", "suspended", "unknown", "unseen"] as const;
export type OtherState = (typeof OTHER_STATES)[number];

export interface Merged {
  /** The tasks an agent in a terminal waits on the person for, by ID. */
  readonly needs: ReadonlySet<string>;
  /** The tasks an agent in a terminal works on. */
  readonly working: ReadonlySet<string>;
  /** The tasks with an agent in any other state, with that state. */
  readonly other: ReadonlyMap<string, OtherState>;
  /** The monitor's sessions shown as a task's row: "On this computer" leaves them out. */
  readonly shown: ReadonlySet<string>;
}

export const NOTHING_MERGED: Merged = {
  needs: new Set(),
  working: new Set(),
  other: new Map(),
  shown: new Set(),
};

const otherOf = (activity: AgentsSession["activity"]): OtherState =>
  activity === "idle" || activity === "shell" || activity === "suspended" ? activity : "unknown";

/** Where the monitor's `picture` puts the tasks of `space` the page holds as `tasks`. */
export function mergeAgents(
  picture: AgentsPicture | null,
  space: string | undefined,
  tasks: ReadonlyMap<string, TaskRow>,
): Merged {
  if (picture === null || space === undefined) return NOTHING_MERGED;
  const needs = new Set<string>();
  const working = new Set<string>();
  const other = new Map<string, OtherState>();
  const shown = new Set<string>();
  for (const session of picture.sessions) {
    const task = session.task;
    if (task?.space !== space) continue;
    const row = tasks.get(task.id);
    if (row === undefined) continue;
    shown.add(session.key);
    // A background run's row shows TTasks' own state while the run is on; its agent is that row.
    if (task.started === "run" && row.run !== undefined) continue;
    if (session.activity === "waiting") needs.add(task.id);
    else if (session.activity === "working") working.add(task.id);
    else if (!other.has(task.id)) other.set(task.id, otherOf(session.activity));
  }
  for (const task of picture.unseen) {
    if (task.space === space && tasks.has(task.id) && !other.has(task.id)) {
      other.set(task.id, "unseen");
    }
  }
  for (const id of [...needs, ...working]) other.delete(id);
  for (const id of needs) working.delete(id);
  return { needs, working, other, shown };
}
