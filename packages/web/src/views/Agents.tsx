// Agents as far as the page's data allows: first "Needs you", the open tasks whose newest
// background run stopped to ask the person or whose agent in a terminal waits for them, and
// "Working", those whose run or agent works now; then "With an agent", the tasks whose agent is in
// any other state, under that state; then "Recent", the tasks an agent or a routine changed while
// this tab followed the space, the ones it finished included, newest first, one small heading per
// day. The runs' states come from the live rows, the terminal agents' from the Agent Monitor
// (agents-merge.ts). A task is in one group, by the agent that asks most of the person, and every
// one of its agents is listed beneath its row in its own state. The rows are ordinary rows, so a
// task expands to its thread, where its runs, Stop and the changes are. A row the monitor put in
// its group is muted while the monitor's picture is not current. Below them, every other agent on
// this computer and the plan usage of each account (Computer.tsx). "Routines" and the full history
// with Revert wait for the service's read of sessions and routines.
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { changeLogOf } from "../app/changes.ts";
import { recentOf } from "../app/views.ts";
import { Session } from "../context.ts";
import type { Group } from "../groups.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { formatDay, type Clock } from "../row/dates.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import { AGENT_STATES, mergeAgents, type AgentState } from "./agents-merge.ts";
import { Computer, TaskAgents } from "./Computer.tsx";
import { TaskList, type GroupsOf } from "./TaskList.tsx";

/** Agents' changes may touch any task: its rows fade in and are announced like Today's. */
const ANY = (): boolean => true;

/** The sections of agents' own, in the page's order: "Needs you", "Working", then each state. */
const AGENT_SECTIONS = AGENT_STATES.map((state) =>
  state === "waiting" ? "r:needs" : state === "working" ? "r:working" : `r:other:${state}`,
);

const sectionOf = (state: AgentState): string => AGENT_SECTIONS[AGENT_STATES.indexOf(state)] ?? "";

/** A section a task can be held in: one of agents' own, or a day of Recent. */
const isSection = (key: string): boolean =>
  AGENT_SECTIONS.includes(key) || /^d:\d{4}-\d{2}-\d{2}$/.test(key);

export interface AgentsProps {
  readonly task?: string | undefined;
  readonly onExpand: (task: TaskRow | undefined, gone?: boolean) => void;
}

export function AgentsPage({ task, onExpand }: AgentsProps) {
  const t = useT();
  const { live } = useContext(Session);
  const log = changeLogOf(live);
  const changes = useSyncExternalStore(log.subscribe, log.getEntries);
  const clock = useClock(false);
  const { tasks: rows } = useLive();
  const agents = useSyncExternalStore(live.agents.subscribe, live.agents.getState);
  const picture = agents.view?.picture ?? null;
  const merged = useMemo(
    () => mergeAgents(picture, live.spaceId, rows),
    [picture, live.spaceId, rows],
  );
  // What the monitor put in a group is as old as its picture: muted while that is not current.
  const muted = useMemo(
    () =>
      agents.current
        ? new Set<string>()
        : new Set([...merged.tasks].flatMap(([id, placed]) => (placed.own ? [] : [id]))),
    [agents.current, merged],
  );
  const beneath = useCallback(
    (row: TaskRow) => {
      const listed = merged.tasks.get(row.id)?.agents ?? [];
      return listed.length === 0 ? undefined : (
        <TaskAgents agents={listed} current={agents.current} />
      );
    },
    [merged, agents.current],
  );
  const groups = useCallback<GroupsOf>(
    (tasks, held) => {
      // Each task in one section: its agents' first, else the day of Recent of its newest change.
      const sections = new Map<string, TaskRow[]>(AGENT_SECTIONS.map((key) => [key, []]));
      const placed = new Set<string>();
      const put = (key: string, row: TaskRow): void => {
        if (placed.has(row.id)) return;
        placed.add(row.id);
        const list = sections.get(key);
        if (list === undefined) sections.set(key, [row]);
        else list.push(row);
      };
      for (const row of tasks.values()) {
        const state = merged.tasks.get(row.id)?.state;
        if (state !== undefined) put(sectionOf(state), row);
      }
      for (const day of recentOf(changes, tasks, clock.timeZone)) {
        for (const row of day.tasks) put(`d:${day.date}`, row);
      }
      // The expanded task stays in the section it was shown in, at its place there, until it is
      // collapsed; one the list has not shown yet joins the top of the first section.
      if (held !== undefined) {
        const id = held.task.id;
        const into =
          held.section !== undefined && isSection(held.section) ? held.section : undefined;
        if (into !== undefined || !placed.has(id)) {
          for (const list of sections.values()) {
            const at = list.findIndex((r) => r.id === id);
            if (at >= 0) list.splice(at, 1);
          }
          const key = into ?? [...sections].find(([, list]) => list.length > 0)?.[0] ?? "d:";
          const list = sections.get(key) ?? [];
          list.splice(
            into === undefined ? 0 : Math.min(held.index ?? 0, list.length),
            0,
            held.task,
          );
          sections.set(key, list);
        }
      }
      return groupsOf(sections, t, clock);
    },
    [changes, clock, t, merged],
  );
  return (
    <div>
      <TaskList
        key="agents"
        view="agents"
        grouping="flat"
        filter={ANY}
        groups={groups}
        clock={clock}
        empty={t("view.empty.agents")}
        expand={task}
        onExpand={onExpand}
        muted={muted}
        beneath={beneath}
      />
      <Computer shown={merged.shown} />
    </div>
  );
}

/**
 * The page's groups from its sections: "Needs you" and "Working" with one section each, "With an
 * agent" with a section per state, then a group per day of Recent, newest first.
 */
function groupsOf(
  sections: ReadonlyMap<string, readonly TaskRow[]>,
  t: Translate,
  clock: Clock,
): Group[] {
  const listed = (key: string) => sections.get(key) ?? [];
  const label = (key: string, title: string): Group[] =>
    listed(key).length === 0
      ? []
      : [{ key, kind: "label", title, sections: [{ key, tasks: listed(key) }] }];
  const others = AGENT_STATES.slice(2).flatMap((state) => {
    const key = sectionOf(state);
    return listed(key).length === 0
      ? []
      : [{ key, title: t("agents.state", { state }), tasks: listed(key) }];
  });
  const days = [...sections.keys()]
    .filter((key) => key.startsWith("d:") && key !== "d:")
    .sort()
    .reverse()
    .flatMap((key) => {
      const date = key.slice(2);
      return label(
        key,
        date === clock.today
          ? t("row.today")
          : t("row.fullDate", {
              weekday: formatDay(date, clock.locale, { weekday: "long" }),
              day: Number(date.slice(8, 10)),
              month: formatDay(date, clock.locale, { month: "long" }),
            }),
      );
    });
  const loose = listed("d:");
  return [
    ...(loose.length === 0
      ? []
      : [{ key: "d:", kind: "flat" as const, sections: [{ key: "d:", tasks: loose }] }]),
    ...label("r:needs", t("agents.needsYou")),
    ...label("r:working", t("agents.working")),
    ...(others.length === 0
      ? []
      : [{ key: "r:other", kind: "label" as const, title: t("agents.other"), sections: others }]),
    ...days,
  ];
}
