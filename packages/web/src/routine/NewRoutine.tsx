// "+ New routine": its title and its schedule in words, read as the person types ("Every
// Saturday"), and made where the schedule reads. The days count in the page's own time zone.
import { useState } from "react";
import { parseRepeat } from "@ttasks/contracts/repeat";
import { formatRule } from "@ttasks/contracts/schedule";
import type { Clock } from "@ttasks/client/today";
import { classes } from "../app/css.ts";
import { PlusIcon } from "../app/Icons.tsx";
import { useList, useT } from "../i18n/intl.tsx";
import { scheduleWords } from "../row/schedule.ts";
import css from "./Routine.module.css";

const styles = classes(css, ["new", "form", "field", "preview", "late", "actions", "add"]);

export function NewRoutine({
  clock,
  onMake,
}: {
  readonly clock: Clock;
  /** Makes it; true once it is saved, so the form closes. */
  readonly onMake: (title: string, rule: string) => Promise<boolean>;
}) {
  const t = useT();
  const list = useList();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [words, setWords] = useState("");
  // One save at a time: a second press while it is on its way does nothing.
  const [saving, setSaving] = useState(false);
  const rule = parseRepeat(words, clock.today);
  if (!open) {
    return (
      <button
        type="button"
        className={styles.add}
        data-part="routine-new"
        onClick={() => {
          setOpen(true);
        }}
      >
        <PlusIcon />
        {t("routine.new")}
      </button>
    );
  }
  const ready = title.trim() !== "" && rule !== undefined;
  return (
    <form
      className={styles.form}
      data-part="routine-new-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving) return;
        setSaving(true);
        void onMake(title.trim(), formatRule(rule)).then((made) => {
          setSaving(false);
          if (!made) return;
          setOpen(false);
          setTitle("");
          setWords("");
        });
      }}
    >
      <input
        className={styles.field}
        data-part="routine-new-title"
        aria-label={t("routine.newTitle")}
        placeholder={t("routine.newTitle")}
        autoFocus
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <input
        className={styles.field}
        data-part="routine-new-schedule"
        aria-label={t("routine.newSchedule")}
        aria-describedby="routine-new-preview"
        placeholder={t("routine.newSchedulePlaceholder")}
        value={words}
        onChange={(event) => {
          setWords(event.target.value);
        }}
      />
      <p
        id="routine-new-preview"
        className={
          rule === undefined && words !== "" ? `${styles.preview} ${styles.late}` : styles.preview
        }
        data-part="routine-new-preview"
        aria-live="polite"
      >
        {words === ""
          ? ""
          : rule === undefined
            ? t("routine.notASchedule")
            : scheduleWords(rule, { t, list, locale: clock.locale })}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
        >
          {t("routine.newCancel")}
        </button>
        <button type="submit" data-part="routine-new-save" disabled={!ready || saving}>
          {t("routine.newSave")}
        </button>
      </div>
    </form>
  );
}
