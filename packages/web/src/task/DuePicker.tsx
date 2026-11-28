// The due date's control: a pill button with the date that opens the date popover.
// The popover holds a text field with a live preview ("Friday 20 November"), five quick picks
// (Today, Tomorrow, Next Monday, In a week, None) and a month grid. Unparseable text shows "Not a
// date" and Enter does nothing; a past date says so in the preview. Enter applies and Escape
// cancels; focus returns to the pill.
//
// The popover is an editor that stays open while the person reads and types: its base is taken
// when it opens, so a due date someone else changed meanwhile is a conflict, never overwritten, and
// the popover says so while it is open.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { classes } from "../app/css.ts";
import { dueChange } from "../edit/change.ts";
import { addDays, addMonths, quickPicks, readDue, weekdayOf } from "@ttasks/client/capture";
import { whoOf } from "../edit/edits.ts";
import { useEdits } from "../edit/useEdits.ts";
import { parseRepeat } from "@ttasks/contracts/repeat";
import { formatRule } from "@ttasks/contracts/schedule";
import { useList, useT, type Translate } from "../i18n/intl.tsx";
import { scheduleWords } from "../row/schedule.ts";
import { formatDay, type Clock } from "@ttasks/client/today";
import type { TaskRow } from "@ttasks/client/store";
import css from "./Picker.module.css";

const styles = classes(css, [
  "pill",
  "empty",
  "popover",
  "dialog",
  "field",
  "preview",
  "remote",
  "picks",
  "pick",
  "month",
  "head",
  "nav",
  "grid",
  "day",
]);

/** What the due date is, as one string: a change to any of its columns is a change. */
const dueKey = (task: TaskRow) =>
  `${task.due_date ?? ""}|${String(task.due_at ?? "")}|${task.due_tz ?? ""}`;

/** "Friday 20 November", with the year when it is not this year. */
export function longDate(date: string, clock: Clock, t: Translate): string {
  const part = (o: Intl.DateTimeFormatOptions) => formatDay(date, clock.locale, o);
  const values = {
    weekday: part({ weekday: "long" }),
    day: Number(date.slice(8, 10)),
    month: part({ month: "long" }),
    year: date.slice(0, 4),
  };
  return date.slice(0, 4) === clock.today.slice(0, 4)
    ? t("due.full", values)
    : t("due.fullYear", values);
}

export function DuePicker({
  task,
  clock,
  shown,
  tip,
  shortOf,
  onRepeat,
}: {
  readonly task: TaskRow;
  readonly clock: Clock;
  /** The pill's text: the due date as the facts show it, or undefined for none. */
  readonly shown: string | undefined;
  readonly tip: string | undefined;
  /** A date as the pill shows it ("Fri 20 Nov"), for the toast. */
  readonly shortOf: (date: string) => string;
  /**
   * Offered on a task with no task above or below it, on a space that keeps routines: a schedule
   * typed in the field ("every saturday") makes the task a routine you do, by its stored rule.
   */
  readonly onRepeat?: ((rule: string, base: string | undefined) => void) | undefined;
}) {
  const t = useT();
  const edits = useEdits();
  const [open, setOpen] = useState(false);
  const opened = useRef<{ base: string | undefined; mark: number; due: string } | undefined>(
    undefined,
  );
  const apply = (date: string | undefined) => {
    const base = opened.current?.base;
    edits.edit(
      task,
      dueChange(date, date === undefined ? undefined : shortOf(date)),
      base === undefined ? {} : { base },
    );
    setOpen(false);
  };
  const label = t("fact.due");
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        if (next) {
          opened.current = {
            base: edits.seen(task, ["due"]),
            mark: edits.mark(),
            due: dueKey(task),
          };
        }
        setOpen(next);
      }}
    >
      <Button
        className={shown === undefined ? `${styles.pill} ${styles.empty}` : styles.pill}
        data-part="due"
        aria-label={t("fact.control", { label, value: shown ?? t("fact.noDate") })}
        data-tip={tip}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="2.5" y="3.5" width="11" height="10" rx="2" fill="none" stroke="currentColor" />
          <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" fill="none" />
        </svg>
        <span>{shown ?? t("fact.noDate")}</span>
      </Button>
      <Popover className={styles.popover} placement="bottom start">
        <Dialog className={styles.dialog} aria-label={t("due.label")}>
          <DueBody
            task={task}
            clock={clock}
            changed={
              opened.current !== undefined && dueKey(task) !== opened.current.due
                ? (edits.changedSince(task.id, "due", opened.current.mark)?.by ?? "")
                : undefined
            }
            onPick={apply}
            {...(onRepeat === undefined
              ? {}
              : {
                  onRepeat: (rule: string) => {
                    onRepeat(rule, opened.current?.base);
                    setOpen(false);
                  },
                })}
          />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function DueBody({
  task,
  clock,
  changed,
  onPick,
  onRepeat,
}: {
  readonly task: TaskRow;
  readonly clock: Clock;
  /** Who changed the due date since the popover opened, if anyone did. */
  readonly changed: string | undefined;
  readonly onPick: (date: string | undefined) => void;
  readonly onRepeat?: (rule: string) => void;
}) {
  const t = useT();
  const list = useList();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const reading = readDue(text, clock.today);
  // A schedule in the field, where a routine is offered: it is read only when no date is.
  const repeat =
    onRepeat !== undefined && reading.kind === "invalid"
      ? parseRepeat(text, clock.today)
      : undefined;
  let preview: string;
  switch (reading.kind) {
    case "date":
      preview =
        reading.date < clock.today
          ? t("due.past", { date: longDate(reading.date, clock, t) })
          : longDate(reading.date, clock, t);
      break;
    case "clear":
      preview = t("due.clear");
      break;
    case "invalid": {
      if (repeat === undefined) {
        preview = t("due.notADate");
        break;
      }
      const words = scheduleWords(repeat, { t, list, locale: clock.locale });
      preview = t("capture.repeat", {
        schedule: words.charAt(0).toLocaleLowerCase(clock.locale) + words.slice(1),
      });
      break;
    }
    case "empty":
      preview = "";
  }
  const picks = quickPicks(clock.today);
  const current = task.due_date;
  return (
    <>
      <input
        className={styles.field}
        data-part="due-field"
        aria-label={t("due.field")}
        aria-describedby={`due-preview-${task.id}`}
        ref={field}
        aria-invalid={reading.kind === "invalid" && repeat === undefined}
        placeholder={t("due.placeholder")}
        // The popover's first stop: the person types at once.
        autoFocus
        value={text}
        dir="auto"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (reading.kind === "date") onPick(reading.date);
          else if (reading.kind === "clear") onPick(undefined);
          else if (repeat !== undefined) onRepeat?.(formatRule(repeat));
        }}
      />
      <p
        id={`due-preview-${task.id}`}
        className={styles.preview}
        data-part="due-preview"
        data-state={reading.kind}
        aria-live="polite"
      >
        {preview}
      </p>
      {changed === undefined ? null : (
        <p className={styles.remote} role="status" data-part="remote">
          {t("edit.changedBy", whoOf(changed))}
        </p>
      )}
      <div className={styles.picks} role="group" aria-label={t("due.picks")}>
        {(
          [
            ["due.today", picks.today],
            ["due.tomorrow", picks.tomorrow],
            ["due.nextMonday", picks.nextMonday],
            ["due.inAWeek", picks.inAWeek],
          ] as const
        ).map(([id, date]) => (
          <button
            key={id}
            type="button"
            className={styles.pick}
            data-tip={longDate(date, clock, t)}
            aria-description={longDate(date, clock, t)}
            onClick={() => {
              onPick(date);
            }}
          >
            {t(id)}
          </button>
        ))}
        <button
          type="button"
          className={styles.pick}
          onClick={() => {
            onPick(undefined);
          }}
        >
          {t("due.none")}
        </button>
        {onRepeat === undefined ? null : (
          <button
            type="button"
            className={styles.pick}
            data-part="due-repeat"
            onClick={() => {
              setText(t("due.repeatStart"));
              field.current?.focus();
            }}
          >
            {t("due.repeat")}
          </button>
        )}
      </div>
      <MonthGrid
        clock={clock}
        selected={reading.kind === "date" ? reading.date : current}
        onPick={onPick}
      />
    </>
  );
}

/** Monday first: the week the facts and the strip read. */
const WEEK_START = 1;

/**
 * The month grid: a grid of day buttons with one tab stop. The arrows move a day or a week, Page
 * Up and Page Down a month, Home and End to the week's ends; Enter or a click picks the day.
 */
function MonthGrid({
  clock,
  selected,
  onPick,
}: {
  readonly clock: Clock;
  readonly selected: string | undefined;
  readonly onPick: (date: string) => void;
}) {
  const t = useT();
  const [focused, setFocused] = useState(selected ?? clock.today);
  const grid = useRef<HTMLTableElement>(null);
  const moved = useRef(false);
  // The typed date moves the grid to its month.
  useEffect(() => {
    if (selected !== undefined) setFocused(selected);
  }, [selected]);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [focused]);

  const month = focused.slice(0, 7);
  const first = `${month}-01`;
  const start = addDays(first, -((weekdayOf(first) - WEEK_START + 7) % 7));
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w += 1) {
    const days = Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d));
    if (w > 0 && days[0]?.slice(0, 7) !== month) break;
    weeks.push(days);
  }
  const heading = t("due.month", {
    month: formatDay(first, clock.locale, { month: "long" }),
    year: first.slice(0, 4),
  });
  const go = (date: string) => {
    moved.current = true;
    setFocused(date);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const offset = (weekdayOf(date) - WEEK_START + 7) % 7;
    const moves: Readonly<Record<string, () => string>> = {
      ArrowLeft: () => addDays(date, -1),
      ArrowRight: () => addDays(date, 1),
      ArrowUp: () => addDays(date, -7),
      ArrowDown: () => addDays(date, 7),
      PageUp: () => addMonths(date, -1),
      PageDown: () => addMonths(date, 1),
      Home: () => addDays(date, -offset),
      End: () => addDays(date, 6 - offset),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    go(move());
  };
  return (
    <div className={styles.month}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.nav}
          aria-label={t("due.previousMonth")}
          onClick={() => {
            setFocused(addMonths(focused, -1));
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" fill="none" strokeWidth="1.5" />
          </svg>
        </button>
        <span aria-hidden="true">{heading}</span>
        <button
          type="button"
          className={styles.nav}
          aria-label={t("due.nextMonth")}
          onClick={() => {
            setFocused(addMonths(focused, 1));
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" fill="none" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      <table ref={grid} className={styles.grid} role="grid" aria-label={heading}>
        <thead>
          <tr>
            {(weeks[0] ?? []).map((day) => (
              <th key={day} scope="col" abbr={formatDay(day, clock.locale, { weekday: "long" })}>
                {formatDay(day, clock.locale, { weekday: "narrow" })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((days) => (
            <tr key={days[0]}>
              {days.map((day) => (
                <td key={day} role="gridcell" aria-selected={day === selected}>
                  <button
                    type="button"
                    className={styles.day}
                    tabIndex={day === focused ? 0 : -1}
                    aria-label={longDate(day, clock, t)}
                    aria-current={day === clock.today ? "date" : undefined}
                    data-outside={day.slice(0, 7) !== month || undefined}
                    data-selected={day === selected || undefined}
                    onClick={() => {
                      onPick(day);
                    }}
                    onKeyDown={(event) => {
                      onKey(event, day);
                    }}
                  >
                    {Number(day.slice(8, 10))}
                  </button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
