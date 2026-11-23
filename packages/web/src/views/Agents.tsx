// Agents as far as the page's data allows: first "Needs you", the open tasks whose newest
// background run stopped to ask the person or whose agent in a terminal waits for them, and
// "Working", those whose run or agent works now; then "With an agent", the tasks whose agent is in
// any other state, under that state; then "Recent", the tasks an agent or a routine changed while
// this tab followed the space, the ones it finished included, newest first, one small heading per
// day. The runs' states come from the live rows, the terminal agents' from the Agent Monitor
// (agents-merge.ts), and each task is in one group. The rows are ordinary rows, so a task expands
// to its thread, where its runs, Stop and the changes are. A row the monitor put in its group is
// muted while the monitor's picture is not current. Below them, every other agent on this
// computer and the plan usage of each account (Computer.tsx). "Routines" and the full history with
// Revert wait for the service's read of sessions and routines.
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { changeLogOf } from "../app/changes.ts";
import { recentOf } from "../app/views.ts";
import { Session } from "../context.ts";
import type { Group } from "../groups.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { formatDay } from "../row/dates.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import { mergeAgents, OTHER_STATES } from "./agents-merge.ts";
import { Computer } from "./Computer.tsx";
import { TaskList, type GroupsOf } from "./TaskList.tsx";

/** Agents' changes may touch any task: its rows fade in and are announced like Today's. */
const ANY = (): boolean => true;

/** `group` without the task `id`. */
function without(group: Group, id: string): Group {
  return {
    ...group,
    sections: group.sections.map((s) => ({ ...s, tasks: s.tasks.filter((r) => r.id !== id) })),
  };
}

const hasTasks = (group: Group): boolean => group.sections.some((s) => s.tasks.length > 0);

/**
 * The groups with `task` in the group `key` at `index`, and nowhere else; undefined when no group
 * has that key now.
 */
function keepIn(
  groups: readonly Group[],
  key: string,
  task: TaskRow,
  index: number,
): Group[] | undefined {
  if (!groups.some((g) => g.key === key)) return undefined;
  return groups
    .map((g) => {
      if (g.key !== key) return without(g, task.id);
      const [section, ...rest] = g.sections;
      const tasks = section?.tasks ?? [];
      if (tasks.some((r) => r.id === task.id)) return g;
      const at = Math.min(index, tasks.length);
      return {
        ...g,
        sections: [
          { key: section?.key ?? key, tasks: [...tasks.slice(0, at), task, ...tasks.slice(at)] },
          ...rest,
        ],
      };
    })
    .filter(hasTasks);
}

/** The heading of a group of agents' own, by its key. */
const runTitle = (key: string, t: Translate): string =>
  t(
    key === "r:needs" ? "agents.needsYou" : key === "r:working" ? "agents.working" : "agents.other",
  );

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
        : new Set([...merged.needs, ...merged.working, ...merged.other.keys()]),
    [agents.current, merged],
  );
  const groups = useCallback<GroupsOf>(
    (tasks, held) => {
      // First what needs the person, then what works now, then what has an agent in another
      // state. Each task once: it leaves Recent while it is in one of them.
      const needs: TaskRow[] = [];
      const working: TaskRow[] = [];
      const other = new Map<string, TaskRow[]>(OTHER_STATES.map((state) => [state, []]));
      for (const row of tasks.values()) {
        const state = merged.other.get(row.id);
        if (row.run?.state === "needs_you" || merged.needs.has(row.id)) needs.push(row);
        else if (row.run?.state === "working" || merged.working.has(row.id)) working.push(row);
        else if (state !== undefined) other.get(state)?.push(row);
      }
      const ran = new Set([...needs, ...working, ...[...other.values()].flat()].map((r) => r.id));
      const otherSections = OTHER_STATES.flatMap((state) => {
        const listed = other.get(state) ?? [];
        return listed.length === 0
          ? []
          : [{ key: `r:other:${state}`, title: t("agents.state", { state }), tasks: listed }];
      });
      const days = recentOf(changes, tasks, clock.timeZone)
        .map((day) => ({ ...day, tasks: day.tasks.filter((r) => !ran.has(r.id)) }))
        .filter((day) => day.tasks.length > 0);
      const runGroups: Group[] = [
        ...(needs.length === 0
          ? []
          : [
              {
                key: "r:needs",
                kind: "label" as const,
                title: t("agents.needsYou"),
                sections: [{ key: "r:needs", tasks: needs }],
              },
            ]),
        ...(working.length === 0
          ? []
          : [
              {
                key: "r:working",
                kind: "label" as const,
                title: t("agents.working"),
                sections: [{ key: "r:working", tasks: working }],
              },
            ]),
        ...(otherSections.length === 0
          ? []
          : [
              {
                key: "r:other",
                kind: "label" as const,
                title: t("agents.other"),
                sections: otherSections,
              },
            ]),
      ];
      const out: Group[] = days.map((day) => ({
        key: `d:${day.date}`,
        kind: "label",
        title:
          day.date === clock.today
            ? t("row.today")
            : t("row.fullDate", {
                weekday: formatDay(day.date, clock.locale, { weekday: "long" }),
                day: Number(day.date.slice(8, 10)),
                month: formatDay(day.date, clock.locale, { month: "long" }),
              }),
        sections: [{ key: `d:${day.date}`, tasks: day.tasks }],
      }));
      out.unshift(...runGroups);
      // The expanded task stays in the group it was shown in while it is expanded: a run that
      // starts or ends moves it to its new group only once it is collapsed.
      const from = held?.group;
      if (held !== undefined && from !== undefined) {
        const id = held.task.id;
        const kept = keepIn(out, from, held.task, held.index ?? 0);
        if (kept === undefined && from.startsWith("r:")) {
          const group: Group = {
            key: from,
            kind: "label",
            title: runTitle(from, t),
            sections: [{ key: from, tasks: [held.task] }],
          };
          return [group, ...out.map((g) => without(g, id))].filter(hasTasks);
        }
        if (kept !== undefined) return kept;
      }
      // The expanded task stays shown while it is expanded, at the top of the list.
      const shown =
        held !== undefined &&
        out.some((g) => g.sections.some((s) => s.tasks.some((r) => r.id === held.task.id)));
      if (held === undefined || shown) return out;
      const [first, ...rest] = out;
      if (first === undefined) {
        return [{ key: "d:", kind: "flat", sections: [{ key: "d:", tasks: [held.task] }] }];
      }
      const section = first.sections[0];
      return [
        {
          ...first,
          sections: [
            { key: section?.key ?? first.key, tasks: [held.task, ...(section?.tasks ?? [])] },
          ],
        },
        ...rest,
      ];
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
      />
      <Computer shown={merged.shown} />
    </div>
  );
}
