// Today (A5 3.4): the week strip, then Focus, This week, Next and Changes, with no heading above
// them. The sections and their membership are `todayOf` (app/views.ts), a pure function of the live
// rows; this component hands their rows to the one list (TaskList), which draws every row and
// keeps the list's rules: nothing moves under focus, and the expanded task stays at its place in
// its section until it is collapsed (`holdExpanded`), its reference in the URL's `?task=`.
//
// The strip is the one place the date appears (U1). Clicking a day narrows Focus and This week to
// it (`?day=` in the URL); clicking it again, or Escape, clears that.
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { changeLogOf } from "../app/changes.ts";
import { classes } from "../app/css.ts";
import {
  holdExpanded,
  isTodaySection,
  STRIP_MARKS,
  stripDays,
  TODAY_LABEL,
  todayOf,
  type StripDay,
} from "../app/views.ts";
import { Session } from "../context.ts";
import { areaSlots, type Group } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { formatDay, type Clock } from "../row/dates.ts";
import type { TaskRow } from "../store/rows.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import css from "./Today.module.css";
import { TaskList, type GroupsOf } from "./TaskList.tsx";

const styles = classes(css, ["strip", "day", "weekday", "date", "marks", "mark", "plus"]);

/** Agents' changes may touch any task, so Today announces and fades in every agent's row. */
const ANY = (): boolean => true;
/** The titles of a day's tasks in its tooltip. */
const TIP_SEPARATOR = " · ";

export interface TodayProps {
  /** The task the URL holds expanded. */
  readonly task?: string | undefined;
  /** The strip's chosen day, from the URL: ignored unless it is one of the strip's days. */
  readonly day?: string | undefined;
  readonly onExpand: (task: TaskRow | undefined, gone?: boolean) => void;
  /** The person chose a day in the strip, or cleared it: the page puts it in the URL. */
  readonly onDay: (day: string | undefined) => void;
}

export function TodayPage({ task, day: wantedDay, onExpand, onDay }: TodayProps) {
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
  const days = useMemo(() => stripDays(clock), [clock]);
  const day = wantedDay !== undefined && days.includes(wantedDay) ? wantedDay : undefined;
  const slots = useMemo(() => areaSlots(state.areas.values()), [state.areas]);
  const today = useMemo(
    () => todayOf(state.tasks.values(), clock, { day, changes, slots }),
    [state.tasks, clock, day, changes, slots],
  );

  const groups = useCallback<GroupsOf>(
    (_tasks, held) => {
      const sections = holdExpanded(
        today.sections,
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
    [today],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape clears the day once nothing inside (an expanded task, an editor) has taken it.
    if (event.key === "Escape" && !event.defaultPrevented && day !== undefined) {
      event.preventDefault();
      onDay(undefined);
    }
  };

  return (
    <div onKeyDown={onKeyDown}>
      <Strip days={today.strip} chosen={day} clock={clock} onChoose={onDay} />
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
    </div>
  );
}

function Strip({
  days,
  chosen,
  clock,
  onChoose,
}: {
  readonly days: readonly StripDay[];
  readonly chosen: string | undefined;
  readonly clock: Clock;
  readonly onChoose: (date: string | undefined) => void;
}) {
  const t = useT();
  const cells = useRef<(HTMLButtonElement | null)[]>([]);
  // One cell in the tab order: the chosen day, else today. The arrows move between the cells.
  const stop = chosen ?? days[0]?.date;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = cells.current.findIndex((cell) => cell === event.target);
    if (at < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const moves: Readonly<Record<string, number>> = {
      ArrowRight: rtl ? at - 1 : at + 1,
      ArrowLeft: rtl ? at + 1 : at - 1,
      Home: 0,
      End: days.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    cells.current[Math.max(0, Math.min(days.length - 1, to))]?.focus();
  };
  return (
    <div className={styles.strip} role="group" aria-label={t("today.strip")} onKeyDown={onKeyDown}>
      {days.map((cell, i) => {
        const p = {
          weekday: formatDay(cell.date, clock.locale, { weekday: "long" }),
          weekdayShort: formatDay(cell.date, clock.locale, { weekday: "short" }),
          day: Number(cell.date.slice(8, 10)),
          month: formatDay(cell.date, clock.locale, { month: "long" }),
          monthShort: formatDay(cell.date, clock.locale, { month: "short" }),
        };
        const titles = cell.marks.map((mark) => mark.title).join(TIP_SEPARATOR);
        const tipId = `strip-${cell.date}`;
        return (
          <button
            key={cell.date}
            ref={(element) => {
              cells.current[i] = element;
            }}
            type="button"
            className={styles.day}
            data-date={cell.date}
            aria-label={t("row.fullDate", { weekday: p.weekday, day: p.day, month: p.month })}
            aria-current={cell.today ? "date" : undefined}
            aria-pressed={chosen === cell.date}
            aria-describedby={titles === "" ? undefined : tipId}
            data-tip={titles === "" ? undefined : titles}
            tabIndex={cell.date === stop ? 0 : -1}
            onClick={() => {
              onChoose(chosen === cell.date ? undefined : cell.date);
            }}
          >
            <span className={styles.weekday} aria-hidden="true">
              {p.weekdayShort}
            </span>
            <span className={styles.date} aria-hidden="true">
              {cell.today ? t("row.date", { day: p.day, month: p.monthShort }) : p.day}
            </span>
            <span className={styles.marks} aria-hidden="true">
              {cell.marks.slice(0, STRIP_MARKS).map((mark, m) => (
                <span
                  key={`${mark.task}:${String(m)}`}
                  className={
                    mark.slot === undefined
                      ? styles.mark
                      : `${styles.mark} slot-${String(mark.slot)}`
                  }
                  data-ring={mark.ring}
                />
              ))}
              {cell.marks.length > STRIP_MARKS ? <PlusMark /> : null}
            </span>
            {titles === "" ? null : (
              <span id={tipId} hidden>
                {titles}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The small plus after four marks: more tasks that day than the strip draws. */
function PlusMark() {
  return (
    <svg className={styles.plus} viewBox="0 0 8 8" aria-hidden="true" focusable="false">
      <path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
