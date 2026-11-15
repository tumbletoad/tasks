// The line under a control whose edit the service did not take (A5 3.11 "Writes"): the control
// shows the current value, and this line keeps the person's own value one click away. After a
// conflict: "Changed by Codex just now · Apply mine · Keep theirs". After a failed call: "Not saved
// · Try again · Discard". On a finished task, which takes no edit until it is reopened: "Not saved:
// the task is finished · Copy · Discard". The line stays until the person chooses, whatever the
// feed brings.
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useT } from "../i18n/intl.tsx";
import { sayMsg } from "../row/say.ts";
import type { Field } from "./change.ts";
import { keyOf, whoOf } from "./edits.ts";
import css from "./Unsaved.module.css";
import { useEditState, useEdits } from "./useEdits.ts";

const styles = classes(css, ["line", "why", "act", "value"]);

export function Unsaved({
  task,
  field,
  finished = false,
  withValue = false,
}: {
  readonly task: string;
  readonly field: Field;
  /** The task is finished: the value cannot be saved now, only copied or discarded. */
  readonly finished?: boolean;
  /** On a finished task, the line shows the value itself too: no fact shows it (the title). */
  readonly withValue?: boolean;
}) {
  const t = useT();
  const say = useToast();
  const edits = useEdits();
  const unsaved = useEditState().unsaved.get(keyOf(task, field));
  if (unsaved === undefined) return null;
  const shown = unsaved.change.shown;
  const mine = typeof shown === "string" ? shown : sayMsg(t, shown);
  const conflict = unsaved.reason === "conflict";
  if (finished) {
    return (
      <span className={styles.line} data-part="unsaved" data-reason="finished" role="status">
        {withValue ? (
          <span className={styles.value} dir="auto" data-part="unsaved-value">
            {mine}
          </span>
        ) : null}
        <span className={styles.why}>{t("edit.notSavedFinished")}</span>
        <button
          type="button"
          className={styles.act}
          data-part="copy-mine"
          aria-label={t("edit.copyValue", { value: mine })}
          onClick={() => {
            navigator.clipboard.writeText(mine).then(
              () => {
                say(t("row.copied"));
              },
              () => {
                say(t("row.copyFailed"));
              },
            );
          }}
        >
          {t("row.copy")}
        </button>
        <button
          type="button"
          className={styles.act}
          data-part="keep-theirs"
          onClick={() => {
            edits.dismiss(task, field);
          }}
        >
          {t("edit.discard")}
        </button>
      </span>
    );
  }
  return (
    <span className={styles.line} data-part="unsaved" data-reason={unsaved.reason} role="status">
      <span className={styles.why}>
        {conflict ? t("edit.changedBy", whoOf(unsaved.by ?? "")) : t("edit.notSaved")}
      </span>
      <button
        type="button"
        className={styles.act}
        data-part="apply-mine"
        aria-label={t(conflict ? "edit.applyMineValue" : "edit.tryAgainValue", { value: mine })}
        onClick={() => {
          edits.apply(task, field);
        }}
      >
        {conflict ? t("edit.applyMine") : t("edit.tryAgain")}
      </button>
      <button
        type="button"
        className={styles.act}
        data-part="keep-theirs"
        onClick={() => {
          edits.dismiss(task, field);
        }}
      >
        {conflict ? t("edit.keepTheirs") : t("edit.discard")}
      </button>
    </span>
  );
}
