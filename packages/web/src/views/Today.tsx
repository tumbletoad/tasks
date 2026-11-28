// Today: today's date and a few numbers about the day, then Focus, This week, Next and
// Changes, with no heading above them, and after the tasks the pages agents changed (PageChanges).
// The sections and their membership are `todayOf` (@ttasks/client/today), a pure function of the
// live rows; this component hands their rows to the one list (TaskList), which draws every row and
// keeps the list's rules: nothing moves under focus, and the expanded task stays at its place in
// its section until it is collapsed (`holdExpanded`), its reference in the URL's `?task=`.
//
// The numbers count what the page each links to lists: late and due today (Search), waiting on
// others (Waiting), and done this week (Completed). Each keeps its place and width as it changes,
// and none is guessed: done this week shows a dash until a read answers, and while the last one
// failed.
import { Link } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { changeLogOf } from "../app/changes.ts";
import { classes } from "../app/css.ts";
import {
  dayNumbersOf,
  holdExpanded,
  isTodaySection,
  TODAY_LABEL,
  todayOf,
  weekStartOf,
  type DayNumbers,
  type Today,
  formatDay,
  type Clock,
} from "@ttasks/client/today";
import { Session } from "../context.ts";
import type { Group } from "../list/items.ts";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { affects } from "../store/queries.ts";
import type { TaskRow } from "@ttasks/client/store";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { countFinished, type FinishedCounts } from "./finished.ts";
import css from "./Today.module.css";
import { TaskList, type GroupsOf } from "./TaskList.tsx";
import { PageChanges } from "../library/PageChanges.tsx";
import { useRoutineActions } from "../routine/actions.ts";
import { RoutineItem } from "../routine/Routine.tsx";

const styles = classes(css, [
  "day",
  "date",
  "numbers",
  "number",
  "value",
  "label",
  "sub",
  "routines",
  "routinesHead",
]);

/** Agents' changes may touch any task, so Today announces and fades in every agent's row. */
const ANY = (): boolean => true;

const COMPLETED = { kind: "completed" } as const;

export interface TodayProps {
  /** The task the URL holds expanded. */
  readonly task?: string | undefined;
  readonly onExpand: (task: TaskRow | undefined, gone?: boolean) => void;
}

export function TodayPage({ task, onExpand }: TodayProps) {
  const t = useT();
  const { live } = useContext(Session);
  const state = useLive();
  const log = changeLogOf(live);
  const changes = useSyncExternalStore(log.subscribe, log.getEntries);
  const timed = useMemo(
    () => [...state.tasks.values()].some((row) => row.due_at !== undefined),
    [state.tasks],
  );
  const clock = useClock(timed);
  const today = useMemo(
    () => todayOf(state.tasks.values(), clock, { changes, routines: state.routines.values() }),
    [state.tasks, state.routines, clock, changes],
  );
  const numbers = useMemo(() => dayNumbersOf(state.tasks.values(), clock), [state.tasks, clock]);
  const finished = useFinished(clock);

  // The sections of the rows the list hands over: the live rows and the rows in their check-off
  // hold, so a checked-off task stays at its place for the hold here too.
  const groups = useCallback<GroupsOf>(
    (tasks, held) => {
      const sections = holdExpanded(
        tasks === state.tasks
          ? today.sections
          : todayOf(tasks.values(), clock, { changes }).sections,
        held === undefined
          ? undefined
          : {
              task: held.task,
              ...(held.group !== undefined && isTodaySection(held.group)
                ? { section: held.group }
                : {}),
              ...(held.index === undefined ? {} : { index: held.index }),
            },
      );
      return sections.map((section): Group => ({
        key: section.key,
        kind: "section",
        label: TODAY_LABEL[section.key],
        sections: [{ key: section.key, tasks: section.tasks }],
      }));
    },
    [today, state.tasks, clock, changes],
  );

  return (
    <div>
      <Day clock={clock} numbers={numbers} finished={finished} />
      <TodayRoutines today={today} clock={clock} />
      <TaskList
        key="today"
        view="today"
        grouping="flat"
        filter={ANY}
        groups={groups}
        clock={clock}
        empty={t("today.nothing")}
        expand={task}
        onExpand={onExpand}
      />
      <PageChanges />
    </div>
  );
}

/**
 * The routines you do that Today holds, above its tasks under a quiet "Routines" line as Focus and
 * Next have theirs, aligned with the task rows: due today or late, then this week's. Each line says
 * when; a routine takes no section of the tasks.
 */
function TodayRoutines({ today, clock }: { readonly today: Today; readonly clock: Clock }) {
  const t = useT();
  const actions = useRoutineActions();
  const routines = today.sections.flatMap((s) => s.routines ?? []);
  if (routines.length === 0) return null;
  return (
    <section
      data-part="today-routines"
      className={styles.routines}
      aria-label={t("today.routines")}
    >
      <h2 className={styles.routinesHead}>{t("today.routines")}</h2>
      {routines.map((routine) => (
        <RoutineItem key={routine.id} routine={routine} clock={clock} actions={actions} />
      ))}
    </section>
  );
}

/**
 * The tasks completed today and this week, read again when a task is finished or reopened, after
 * a fresh snapshot, when the feed is live again, and when the day changes. One read at a time:
 * changes while it runs ask for one more after it, so a burst of completions costs two reads. A
 * failed read leaves no answer: an old count could miss what was finished since.
 */
function useFinished(clock: Clock): FinishedCounts | undefined {
  const { api, live } = useContext(Session);
  const { today, timeZone } = clock;
  const day = `${live.spaceId ?? ""} ${today} ${timeZone}`;
  const [found, setFound] = useState<{ day: string; counts: FinishedCounts } | undefined>();
  useEffect(() => {
    let alive = true;
    let reading = false;
    let again = false;
    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      again = false;
      countFinished((input) => api.client.task.finished(input), weekStartOf(today), today, timeZone)
        .then(
          (counts) => {
            if (alive && !again) setFound({ day, counts });
          },
          () => {
            if (alive && !again) setFound(undefined);
          },
        )
        .finally(() => {
          reading = false;
          if (alive && again) read();
        });
    };
    read();
    const stop = live.onChanges(({ changes }) => {
      if (changes.some((change) => affects(COMPLETED, change))) read();
    });
    const unwatch = live.onBack(read);
    return () => {
      alive = false;
      stop();
      unwatch();
    };
  }, [api, live, today, timeZone, day]);
  return found?.day === day ? found.counts : undefined;
}

/** Today's date, then the day's numbers, each a link to the page that lists what it counts. */
function Day({
  clock,
  numbers,
  finished,
}: {
  readonly clock: Clock;
  readonly numbers: DayNumbers;
  readonly finished: FinishedCounts | undefined;
}) {
  const t = useT();
  const intl = useIntl();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  const date = t("row.fullDate", {
    weekday: formatDay(clock.today, clock.locale, { weekday: "long" }),
    day: Number(clock.today.slice(8, 10)),
    month: formatDay(clock.today, clock.locale, { month: "long" }),
  });
  /** A number's figure: a dash while it is not known yet. */
  const figure = (n: number | undefined, more = false) =>
    n === undefined ? DASH : more ? t("today.atLeast", { n }) : intl.formatNumber(n);
  const item = (
    kind: string,
    label: MessageId,
    n: number | undefined,
    to: { readonly q: string } | { readonly view: "waiting" | "completed" },
    more = false,
    sub?: string,
  ) => {
    const shown = figure(n, more);
    const inner = (
      <>
        <span className={styles.value} data-zero={n === 0 || undefined}>
          {shown}
          {sub === undefined ? null : <span className={styles.sub}>{sub}</span>}
        </span>
        <span className={styles.label}>{t(label)}</span>
      </>
    );
    const common = {
      className: styles.number,
      "data-kind": kind,
      "aria-label":
        sub === undefined
          ? t("today.numberName", { label: t(label), value: shown })
          : t("today.numberNameSub", { label: t(label), value: shown, sub }),
    };
    return (
      <li key={kind}>
        {"q" in to ? (
          <Link to="/s/$space/search" params={{ space }} search={{ q: to.q }} {...common}>
            {inner}
          </Link>
        ) : (
          <Link to="/s/$space/$view" params={{ space, view: to.view }} {...common}>
            {inner}
          </Link>
        )}
      </li>
    );
  };
  return (
    <div className={styles.day} data-part="day">
      <p className={styles.date} data-part="date">
        {date}
      </p>
      <ul className={styles.numbers} aria-label={t("today.numbers")}>
        {item("late", "today.late", numbers.late, { q: "is:overdue" })}
        {item("due", "today.dueToday", numbers.dueToday, { q: DUE_TODAY })}
        {item("waiting", "today.waiting", numbers.waiting, { view: "waiting" })}
        {item(
          "done",
          "today.doneWeek",
          finished?.week,
          { view: "completed" },
          finished?.more ?? false,
          // Today's share only once there is one: "0 · 0 today" says nothing twice.
          finished === undefined || finished.today === 0
            ? undefined
            : t("today.doneToday", { value: figure(finished.today, finished.todayMore) }),
        )}
      </ul>
    </div>
  );
}

/** What Due today counts: the open tasks due today, not the finished ones. */
const DUE_TODAY = "due:today -is:completed -is:archived";

/** What a number shows until it is known. */
const DASH = "–";
