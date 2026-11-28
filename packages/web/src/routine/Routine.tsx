// A routine's row and the Routines page's lists. The box is round with a small loop: checking it
// off logs this time and shows the next, and never finishes the routine, which only "Finish
// routine…" in its card does. Due routines offer Skip beside it.
import { Fragment, type ReactNode } from "react";
import { useIntl } from "react-intl";
import type { RoutineRow } from "@ttasks/client/store";
import type { Clock } from "@ttasks/client/today";
import { classes } from "../app/css.ts";
import { Icon } from "../app/Icons.tsx";
import { useList, useT } from "../i18n/intl.tsx";
import css from "./Routine.module.css";
import { lastOf, lineOf, routineGroups, whenOf } from "./model.ts";

const styles = classes(css, [
  "item",
  "box",
  "main",
  "still",
  "title",
  "open",
  "line",
  "part",
  "late",
  "skip",
  "group",
]);

/** A loop: work that comes back. */
export const LoopIcon = () => (
  <Icon>
    <path d="M19 12a7 7 0 0 1-12 4.9M5 12a7 7 0 0 1 12-4.9M17 3.5v3.6h-3.6M7 20.5v-3.6h3.6" />
  </Icon>
);

export interface RoutineActions {
  readonly done: (routine: RoutineRow) => void;
  readonly skip: (routine: RoutineRow) => void;
}

export function RoutineItem({
  routine,
  clock,
  actions,
  onOpen,
}: {
  readonly routine: RoutineRow;
  readonly clock: Clock;
  readonly actions: RoutineActions;
  /** Its title opens the routine's card. */
  readonly onOpen?: ((routine: RoutineRow) => void) | undefined;
}) {
  const t = useT();
  const list = useList();
  const { locale } = useIntl();
  const line = lineOf(routine, t, { t, list, locale });
  const when = whenOf(routine, clock);
  const last = lastOf(routine, clock);
  const finished = routine.lifecycle !== "active";
  const due = !finished && !routine.paused && routine.due_date <= clock.today;
  return (
    <div className={styles.item} data-part="routine" data-ref={routine.ref}>
      {/* A finished routine comes back no more: its box is its mark, and checks nothing off. */}
      {finished ? (
        <span className={`${styles.box} ${styles.still}`} aria-hidden="true">
          <LoopIcon />
        </span>
      ) : (
        <button
          type="button"
          className={styles.box}
          data-part="routine-check"
          aria-label={t("routine.done", { title: routine.title })}
          onClick={() => {
            actions.done(routine);
          }}
        >
          <LoopIcon />
        </button>
      )}
      <div className={styles.main}>
        {onOpen === undefined ? (
          <div className={styles.title}>{routine.title}</div>
        ) : (
          <button
            type="button"
            className={`${styles.title} ${styles.open}`}
            data-part="routine-open"
            onClick={() => {
              onOpen(routine);
            }}
          >
            {routine.title}
          </button>
        )}
        <div className={styles.line}>
          <span className={styles.part} data-part="routine-part">
            {line}
          </span>
          {routine.paused ? null : (
            <span
              data-part="routine-part"
              className={when.id === "routine.late" ? `${styles.part} ${styles.late}` : styles.part}
            >
              {t(when.id, when.values)}
            </span>
          )}
          {last === undefined ? null : (
            <span className={styles.part} data-part="routine-part">
              {t(last.id, last.values)}
            </span>
          )}
        </div>
      </div>
      {due ? (
        <button
          type="button"
          className={styles.skip}
          data-part="routine-skip"
          aria-label={t("routine.skipThis", { title: routine.title })}
          onClick={() => {
            actions.skip(routine);
          }}
        >
          {t("routine.skip")}
        </button>
      ) : null}
    </div>
  );
}

/** The Routines page's lists: Due, Coming, then Paused with its count. */
export function RoutineLists({
  routines,
  clock,
  actions,
  open,
  onOpen,
  below,
}: {
  readonly routines: Iterable<RoutineRow>;
  readonly clock: Clock;
  readonly actions: RoutineActions;
  /** The routine whose card is open, under its row. */
  readonly open?: string | undefined;
  readonly onOpen?: (routine: RoutineRow) => void;
  readonly below?: (routine: RoutineRow) => ReactNode;
}) {
  const t = useT();
  const groups = routineGroups(routines, clock);
  const section = (key: "due" | "coming" | "paused", rows: readonly RoutineRow[]) =>
    rows.length === 0 ? null : (
      <section key={key} data-part={`routines-${key}`}>
        <h2 className={styles.group}>
          {key === "paused"
            ? t("routines.paused", { count: rows.length })
            : t(key === "due" ? "routines.due" : "routines.coming")}
        </h2>
        {rows.map((routine) => (
          <Fragment key={routine.id}>
            <RoutineItem routine={routine} clock={clock} actions={actions} onOpen={onOpen} />
            {open === routine.id ? below?.(routine) : null}
          </Fragment>
        ))}
      </section>
    );
  return (
    <>
      {section("due", groups.due)}
      {section("coming", groups.coming)}
      {section("paused", groups.paused)}
    </>
  );
}
