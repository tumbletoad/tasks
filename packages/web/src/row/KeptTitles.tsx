// Titles kept in the browser that no editor of this tab holds (unsent.ts): what another tab is
// typing, and on a task finished or in the Trash what was typed and cannot be saved now. Each shows
// its words with Copy and Discard, in the line an unsaved edit uses (Unsaved.tsx); Discard is the
// person's choice, never a side effect of another tab's editor, and takes only the words shown.
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import css from "../edit/Unsaved.module.css";
import { useT } from "../i18n/intl.tsx";
import { letGo, useKeptTitles } from "../unsent.ts";

const styles = classes(css, ["line", "why", "act", "value"]);

export function KeptTitles({
  space,
  task,
  finished,
  trashed = false,
}: {
  readonly space: string;
  readonly task: string;
  /** The task is finished: no editor saves a title now, this tab's own included. */
  readonly finished: boolean;
  /** The task is in the Trash, which is the reason it is not saved. */
  readonly trashed?: boolean;
}) {
  const t = useT();
  const say = useToast();
  const kept = useKeptTitles(space, task).filter((k) => finished || !k.mine);
  return kept.map(({ tab, draft, mine }) => (
    <span
      key={tab}
      className={styles.line}
      data-part="kept-title"
      data-reason={finished ? "finished" : "other-tab"}
      role="status"
    >
      <span className={styles.value} dir="auto" data-part="kept-title-value">
        {draft.typed}
      </span>
      <span className={styles.why}>
        {finished
          ? t(
              trashed
                ? "edit.notSavedTrash"
                : mine
                  ? "edit.notSavedFinished"
                  : "title.otherTabFinished",
            )
          : t("title.otherTab")}
      </span>
      <button
        type="button"
        className={styles.act}
        data-part="copy-kept-title"
        aria-label={t("edit.copyValue", { value: draft.typed })}
        onClick={() => {
          navigator.clipboard.writeText(draft.typed).then(
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
        data-part="discard-kept-title"
        onClick={() => {
          letGo(space, { kind: "title", task, tab, text: draft.typed });
        }}
      >
        {t("edit.discard")}
      </button>
    </span>
  ));
}
