// Agents as far as the page's data allows: first "Needs you", the open tasks whose newest
// background run stopped to ask the person, and "Working", those whose run works now, both from
// the live rows; then "Recent", the tasks an agent or a routine changed while this tab followed
// the space, the ones it finished included, newest first, one small heading per day. The rows are
// ordinary rows, so a task expands to its thread, where its runs, Stop and the changes are.
// "Routines" and the full history with Revert wait for the service's read of sessions and
// routines.
import { useCallback, useContext, useSyncExternalStore } from "react";
import { changeLogOf } from "../app/changes.ts";
import { recentOf } from "../app/views.ts";
import { Session } from "../context.ts";
import type { Group } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { formatDay } from "../row/dates.ts";
import { useClock } from "../row/useClock.ts";
import type { TaskRow } from "../store/rows.ts";
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
  const groups = useCallback<GroupsOf>(
    (tasks, held) => {
      // First what needs the person, then what works now: from the rows, so every tab and a
      // reload show the same. Each task once: it leaves Recent while it is in one of them.
      const needs: TaskRow[] = [];
      const working: TaskRow[] = [];
      for (const row of tasks.values()) {
        if (row.run?.state === "needs_you") needs.push(row);
        else if (row.run?.state === "working") working.push(row);
      }
      const ran = new Set([...needs, ...working].map((r) => r.id));
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
            title: t(from === "r:needs" ? "agents.needsYou" : "agents.working"),
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
    [changes, clock, t],
  );
  return (
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
    />
  );
}
