// Agents (A5 3.5, 3.14) as far as the page's data allows: "Recent", the tasks an agent or a routine
// changed while this tab followed the space, newest first, one small heading per day. The rows are
// ordinary rows, so a task expands to its thread, where the changes are. "Running", "Routines" and
// the full history with Revert wait for the service's read of sessions, runs and routines (A5 3.5).
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
      const days = recentOf(changes, tasks, clock.timeZone);
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
      // The expanded task stays shown while it is expanded, at the top of the list (A5 3.3).
      const shown =
        held !== undefined && days.some((d) => d.tasks.some((r) => r.id === held.task.id));
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
