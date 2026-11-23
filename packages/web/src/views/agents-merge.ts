// Every agent once on the Agents page. A task of this space that agents work on is one row, placed
// by the agent that asks most of the person, with every one of its agents beneath it in its own
// state; "On this computer" leaves those agents out. TTasks' record decides what an agent is: a
// background run's state is TTasks' own, an agent in a terminal's is the monitor's, and a
// terminal agent TTasks holds as running that the monitor has not seen is shown as such, never
// as idle.
import type { AgentsPicture, AgentsSession } from "@ttasks/contracts/monitor";
import type { TaskRow } from "../store/rows.ts";

/** What an agent of a task does, in the page's order: what asks most of the person first. */
export const AGENT_STATES = [
  "waiting",
  "working",
  "idle",
  "shell",
  "suspended",
  "unknown",
  "unseen",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** One agent of a task, as the list beneath its row shows it. */
export interface TaskAgent {
  /** Unique among the task's agents. */
  readonly key: string;
  readonly state: AgentState;
  /** The monitor's session, with the agents inside it; null for one the monitor does not show. */
  readonly session: AgentsSession | null;
  readonly started: "run" | "terminal";
  /** The agent of the task's current background run, in TTasks' own state. */
  readonly current: boolean;
}

/** A task with agents: where it is placed, and its agents. */
export interface Placed {
  /** The state of the agent that asks most of the person. */
  readonly state: AgentState;
  /** That state is TTasks' own, from a background run's record, and not the monitor's. */
  readonly own: boolean;
  /** How long before the picture its oldest agent the monitor sees started; null: none known. */
  readonly ageMs: number | null;
  /** Every agent of the task: its current run first, then the others as they started. */
  readonly agents: readonly TaskAgent[];
}

export interface Merged {
  /** The tasks of this space with an agent, by ID. */
  readonly tasks: ReadonlyMap<string, Placed>;
  /** The monitor's sessions shown beneath a task's row: "On this computer" leaves them out. */
  readonly shown: ReadonlySet<string>;
}

const rank = (state: AgentState): number => AGENT_STATES.indexOf(state);

/** What a background run does, as its row's record says; undefined: no run on now. */
const runState = (row: TaskRow): AgentState | undefined =>
  row.run?.state === "needs_you" ? "waiting" : row.run?.state === "working" ? "working" : undefined;

const stateOf = (activity: AgentsSession["activity"]): AgentState =>
  activity === "waiting" ||
  activity === "working" ||
  activity === "idle" ||
  activity === "shell" ||
  activity === "suspended"
    ? activity
    : "unknown";

/** Oldest first; one of no known age after them; then by key, so equal ones keep their order. */
const byStart = (a: TaskAgent, b: TaskAgent): number =>
  (b.session?.ageMs ?? -1) - (a.session?.ageMs ?? -1) ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The tasks of `space` the monitor links an agent to that `rows` does not hold: those in the Trash,
 * whose rows the page reads so it places them as it places a live task. Sorted, so an unchanged
 * set reads nothing again.
 */
export function linkedOutside(
  picture: AgentsPicture | null,
  space: string | undefined,
  rows: ReadonlyMap<string, TaskRow>,
): string[] {
  if (picture === null || space === undefined) return [];
  const ids = new Set<string>();
  for (const session of picture.sessions) {
    if (session.task?.space === space && !rows.has(session.task.id)) ids.add(session.task.id);
  }
  for (const task of picture.unseen) {
    if (task.space === space && !rows.has(task.id)) ids.add(task.id);
  }
  return [...ids].sort();
}

/**
 * The agents of each task of `space` the page holds as `rows`, from the monitor's `picture`. The
 * agent of the task's current run is the session matched to that run, in TTasks' state; any other
 * session, one of an earlier run or launch resumed by hand among them, is an agent of its own in
 * the monitor's state.
 */
export function mergeAgents(
  picture: AgentsPicture | null,
  space: string | undefined,
  rows: ReadonlyMap<string, TaskRow>,
): Merged {
  const found = new Map<string, TaskAgent[]>();
  const shown = new Set<string>();
  const add = (task: string, agent: TaskAgent): void => {
    const list = found.get(task);
    if (list === undefined) found.set(task, [agent]);
    else list.push(agent);
  };
  if (picture !== null && space !== undefined) {
    for (const session of picture.sessions) {
      const task = session.task;
      if (task?.space !== space) continue;
      const row = rows.get(task.id);
      if (row === undefined) continue;
      shown.add(session.key);
      const run = task.of === row.run?.id ? runState(row) : undefined;
      add(task.id, {
        key: session.key,
        state: run ?? stateOf(session.activity),
        session,
        started: task.started,
        current: run !== undefined,
      });
    }
    for (const task of picture.unseen) {
      if (task.space !== space || !rows.has(task.id)) continue;
      add(task.id, {
        key: `unseen:${task.of}`,
        state: "unseen",
        session: null,
        started: "terminal",
        current: false,
      });
    }
  }
  const tasks = new Map<string, Placed>();
  for (const row of rows.values()) {
    const run = runState(row);
    const agents = (found.get(row.id) ?? []).sort(byStart);
    if (run === undefined && agents.length === 0) continue;
    const others = agents.filter((a) => !a.current);
    // TTasks' own run is one of the task's agents, also when the monitor does not see it.
    const current =
      agents.find((a) => a.current) ??
      (run !== undefined && others.length > 0
        ? {
            key: `run:${row.id}`,
            state: run,
            session: null,
            started: "run" as const,
            current: true,
          }
        : undefined);
    // An agent inside a conversation that waits for the person asks as much as its parent would.
    const states = [
      ...(run === undefined ? [] : [run]),
      ...agents.flatMap((a) => [
        a.state,
        ...(a.session?.nested ?? []).map((inner) => stateOf(inner.activity)),
      ]),
    ];
    const best = Math.min(...states.map(rank));
    const ages = agents.flatMap((a) =>
      a.session === null || a.session.ageMs === null ? [] : [a.session.ageMs],
    );
    tasks.set(row.id, {
      state: AGENT_STATES[best] ?? "unknown",
      own: run !== undefined && rank(run) === best,
      ageMs: ages.length === 0 ? null : Math.max(...ages),
      agents: current === undefined ? others : [current, ...others],
    });
  }
  return { tasks, shown };
}
