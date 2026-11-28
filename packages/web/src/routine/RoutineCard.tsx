// A routine's card: what its row does not show. Its title and its schedule, each corrected in place
// (the schedule in words, read back as the person types), its times done newest first, and its two
// actions, Pause or Resume, and "Finish routine…". Finishing for good is the one action behind a
// dialog: it is the only one that ends a routine, and the box never does it. A finished routine's
// card shows its times done only.
import { useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { OutputOf } from "@ttasks/contracts";
import { localDate } from "@ttasks/contracts/day";
import { parseRepeat } from "@ttasks/contracts/repeat";
import { formatRule, parseRule } from "@ttasks/contracts/schedule";
import type { RoutineRow } from "@ttasks/client/store";
import { formatDay, type Clock } from "@ttasks/client/today";
import { classes } from "../app/css.ts";
import { useList, useT } from "../i18n/intl.tsx";
import { scheduleWords } from "../row/schedule.ts";
import setupCss from "../app/Setup.module.css";
import css from "./Routine.module.css";

const styles = classes(css, [
  "card",
  "edit",
  "field",
  "preview",
  "late",
  "part",
  "entries",
  "entry",
  "group",
  "menu",
  "finishActions",
]);
const sheet = classes(setupCss, [
  "overlay",
  "modal",
  "dialog",
  "title",
  "lead",
  "primary",
  "secondary",
]);

/** A time done or skipped, as get_task's routine view gives it. */
export type RoutineEntryView = Extract<
  OutputOf<"task.get">,
  { view: "routine" }
>["history"][number];

export interface RoutineCardActions {
  readonly pause: (routine: RoutineRow) => void;
  readonly resume: (routine: RoutineRow) => void;
  readonly finish: (routine: RoutineRow) => void;
  /** A new title or schedule; true once it is saved. */
  readonly change: (
    routine: RoutineRow,
    change: { readonly title: string } | { readonly rule: string },
  ) => Promise<boolean>;
}

export function RoutineCard({
  routine,
  entries,
  clock,
  actions,
}: {
  readonly routine: RoutineRow;
  readonly entries: readonly RoutineEntryView[];
  readonly clock: Clock;
  readonly actions: RoutineCardActions;
}) {
  const t = useT();
  const [finishing, setFinishing] = useState(false);
  const day = (date: string) =>
    formatDay(date, clock.locale, { weekday: "short", day: "numeric", month: "short" });
  const finished = routine.lifecycle !== "active";
  return (
    <div className={styles.card} data-part="routine-card">
      {finished ? null : <Fields routine={routine} clock={clock} actions={actions} />}
      <h3 className={styles.group}>{t("routine.entries")}</h3>
      {entries.length === 0 ? (
        <p className={styles.part}>{t("routine.entriesNone")}</p>
      ) : (
        <ul className={styles.entries}>
          {entries.map((entry) => {
            // The day it was done; the day it was for, when that is another.
            const done = localDate(Date.parse(entry.at), clock.timeZone);
            const due = entry.due?.date;
            return (
              <li
                key={`${entry.at}-${due ?? ""}`}
                className={styles.entry}
                data-part="routine-entry"
              >
                <span className={styles.part}>{day(done)}</span>
                {due === undefined ? (
                  <span className={styles.part}>{t("routine.entryExtra")}</span>
                ) : due === done ? null : (
                  <span className={styles.part}>{t("routine.entryFor", { date: day(due) })}</span>
                )}
                {entry.state === "skipped" ? (
                  <span className={styles.part}>
                    {t(
                      entry.why === "run_failed"
                        ? "routine.entryRunFailed"
                        : "routine.entrySkipped",
                    )}
                  </span>
                ) : null}
                {entry.note === undefined ? null : (
                  <span className={styles.part}>{entry.note}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {finished ? null : (
        <div className={styles.menu}>
          <Button
            data-part="routine-pause"
            onPress={() => {
              (routine.paused ? actions.resume : actions.pause)(routine);
            }}
          >
            {t(routine.paused ? "routine.resume" : "routine.pause")}
          </Button>
          <Button
            data-part="routine-finish"
            onPress={() => {
              setFinishing(true);
            }}
          >
            {t("routine.finish")}
          </Button>
        </div>
      )}
      {finishing ? (
        <ModalOverlay
          className={sheet.overlay}
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setFinishing(false);
          }}
        >
          <Modal className={sheet.modal}>
            <Dialog
              className={sheet.dialog}
              role="alertdialog"
              aria-label={t("routine.finishTitle", { title: routine.title })}
            >
              <Heading slot="title" level={2} className={sheet.title}>
                {t("routine.finishTitle", { title: routine.title })}
              </Heading>
              <p className={sheet.lead}>{t("routine.finishLead", { count: routine.entries })}</p>
              <div className={styles.finishActions}>
                <Button className={sheet.secondary} slot="close">
                  {t("routine.finishCancel")}
                </Button>
                <Button
                  className={sheet.primary}
                  data-part="routine-finish-confirm"
                  onPress={() => {
                    setFinishing(false);
                    actions.finish(routine);
                  }}
                >
                  {t("routine.finishConfirm")}
                </Button>
              </div>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
    </div>
  );
}

/**
 * The routine's title and schedule, each corrected in place and saved with Enter or on leaving the
 * field. The schedule is in the words the row shows, read back as the person types; words that are
 * no schedule say so and save nothing. A refused save keeps what was typed.
 */
function Fields({
  routine,
  clock,
  actions,
}: {
  readonly routine: RoutineRow;
  readonly clock: Clock;
  readonly actions: RoutineCardActions;
}) {
  const t = useT();
  const list = useList();
  const wording = { t, list, locale: clock.locale };
  const rule = parseRule(routine.rule);
  const shown = rule === undefined ? routine.rule : scheduleWords(rule, wording);
  const [title, setTitle] = useState(routine.title);
  const [words, setWords] = useState(shown);
  const [saving, setSaving] = useState(false);
  const read = parseRepeat(words, clock.today);
  const save = (change: { readonly title: string } | { readonly rule: string }) => {
    if (saving) return;
    setSaving(true);
    void actions.change(routine, change).finally(() => {
      setSaving(false);
    });
  };
  const saveTitle = () => {
    const next = title.trim();
    if (next !== "" && next !== routine.title) save({ title: next });
  };
  const saveRule = () => {
    if (read === undefined) return;
    const next = formatRule(read);
    if (next !== routine.rule) save({ rule: next });
  };
  return (
    <div className={styles.edit}>
      <input
        className={styles.field}
        data-part="routine-title"
        aria-label={t("routine.newTitle")}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) saveTitle();
        }}
      />
      <input
        className={styles.field}
        data-part="routine-schedule"
        aria-label={t("routine.newSchedule")}
        aria-describedby={`routine-schedule-${routine.id}`}
        aria-invalid={read === undefined}
        value={words}
        onChange={(event) => {
          setWords(event.target.value);
        }}
        onBlur={saveRule}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) saveRule();
        }}
      />
      <p
        id={`routine-schedule-${routine.id}`}
        className={read === undefined ? `${styles.preview} ${styles.late}` : styles.preview}
        data-part="routine-schedule-preview"
        aria-live="polite"
      >
        {read === undefined ? t("routine.notASchedule") : scheduleWords(read, wording)}
      </p>
    </div>
  );
}
