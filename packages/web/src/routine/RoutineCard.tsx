// A routine's card: what it is, its schedule and its next time, the times done or skipped (newest
// first, from get_task's routine view), and its two actions, Pause or Resume, and "Finish
// routine…". Finishing for good is the one action behind a dialog: it is the only one that ends a
// routine, and the box never does it.
import { useState } from "react";
import { useIntl } from "react-intl";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { RoutineRow } from "@ttasks/client/store";
import { formatDay, type Clock } from "@ttasks/client/today";
import { classes } from "../app/css.ts";
import { useList, useT } from "../i18n/intl.tsx";
import setupCss from "../app/Setup.module.css";
import css from "./Routine.module.css";
import { lineOf, whenOf } from "./model.ts";

const styles = classes(css, ["card", "kind", "line", "part", "entries", "entry", "group", "menu"]);
const sheet = classes(setupCss, [
  "overlay",
  "modal",
  "dialog",
  "title",
  "lead",
  "actions",
  "primary",
  "secondary",
]);

/** A time done or skipped, as get_task's routine view gives it (contracts' RoutineEntry). */
export interface RoutineEntryView {
  readonly due?: { readonly date: string; readonly at?: string };
  readonly state: "done" | "skipped";
  readonly at: string;
  readonly by: string;
  readonly why?: "you" | "run_failed";
  readonly note?: string;
}

export interface RoutineCardActions {
  readonly pause: (routine: RoutineRow) => void;
  readonly resume: (routine: RoutineRow) => void;
  readonly finish: (routine: RoutineRow) => void;
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
  const list = useList();
  const { locale } = useIntl();
  const [finishing, setFinishing] = useState(false);
  const day = (date: string) =>
    formatDay(date, clock.locale, { weekday: "short", day: "numeric", month: "short" });
  const when = whenOf(routine, clock);
  return (
    <div className={styles.card} data-part="routine-card">
      <div className={styles.line}>
        <span className={styles.part}>{t("routine.kind")}</span>
        <span className={styles.part}>{lineOf(routine, t, { t, list, locale })}</span>
        {routine.paused ? null : <span className={styles.part}>{t(when.id, when.values)}</span>}
      </div>
      <h3 className={styles.group}>{t("routine.entries")}</h3>
      {entries.length === 0 ? (
        <p className={styles.line}>{t("routine.entriesNone")}</p>
      ) : (
        <ul className={styles.entries}>
          {entries.map((entry) => (
            <li
              key={`${entry.at}-${entry.due?.date ?? ""}`}
              className={styles.entry}
              data-part="routine-entry"
            >
              <span className={styles.part}>{day(entry.due?.date ?? entry.at.slice(0, 10))}</span>
              {entry.due === undefined ? (
                <span className={styles.part}>{t("routine.entryExtra")}</span>
              ) : null}
              {entry.state === "skipped" ? (
                <span className={styles.part}>
                  {t(
                    entry.why === "run_failed" ? "routine.entryRunFailed" : "routine.entrySkipped",
                  )}
                </span>
              ) : null}
              {entry.note === undefined ? null : <span className={styles.part}>{entry.note}</span>}
            </li>
          ))}
        </ul>
      )}
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
              <div className={sheet.actions}>
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
