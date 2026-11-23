// The line under a control whose edit the service did not take (A5 3.11 "Writes"): the control
// shows the current value, and this line keeps the person's own value one click away. After a
// conflict: "Changed by Codex just now · Apply mine · Keep theirs". After a failed call: "Not saved
// · Try again · Discard". On a finished task, which takes no edit until it is reopened: "Not saved:
// the task is finished · Copy · Discard", and on one in the Trash "Not saved: the task is in the
// Trash · Copy · Discard", after the value itself where no fact shows it (the title). An edit made
// against a history the space no longer has (restored since) is not sent again: "<value> Not saved:
// the space was restored since · Copy · Discard". In a space that takes no change (a restored copy,
// one another machine owns), nothing can be saved until that changes: "<value> Not saved: this is a
// restored copy · Copy · Discard"; nor from a tab whose copy of the space was closed or replaced
// since it loaded. The line stays until the person chooses, whatever the feed brings.
//
// Every edit of the field the browser keeps has its line: this tab's own, and each one another tab
// kept. With more than one, or one not this tab's own, each line shows its value, so the person
// sees which is which.
import { useContext } from "react";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useT } from "../i18n/intl.tsx";
import { Session } from "../context.ts";
import { sayMsg } from "../row/say.ts";
import { useLive } from "../store/hooks.ts";
import { letGo, useKeptEdits } from "../unsent.ts";
import type { Field } from "./change.ts";
import { keyOf, whoOf, type Unsaved as Line } from "./edits.ts";
import { readOnlyWhy } from "./read-only.ts";
import css from "./Unsaved.module.css";
import { useEditState, useEdits } from "./useEdits.ts";

const styles = classes(css, ["line", "why", "act", "value"]);

/** A conflict this recent still reads "just now": one kept from before a reload may be older. */
const RECENT_MS = 120_000;

const recent = (at: number | undefined): boolean => at === undefined || Date.now() - at < RECENT_MS;

/** A kept edit as its line shows it: this tab's own, or another's with its value as kept. */
interface Shown {
  readonly line: Line;
  /** Not this tab's own: the value the browser keeps, which Discard lets go of. */
  readonly kept?: string;
}

/** The kept edits of a task's field: this tab's own first, then the others not on their way. */
export function useUnsaved(task: string, field: Field): readonly Shown[] {
  const edits = useEdits();
  const { live } = useContext(Session);
  const own = useEditState().unsaved.get(keyOf(task, field));
  const kept = useKeptEdits(live.spaceId ?? "", task, field);
  return [
    ...(own === undefined ? [] : [{ line: own }]),
    ...kept
      .filter(({ unsaved }) => unsaved.id !== own?.id && !edits.sendingKept(unsaved.id))
      .map(({ unsaved, value }) => ({ line: unsaved, kept: value })),
  ];
}

export function Unsaved({
  task,
  field,
  finished = false,
  trashed = false,
  withValue = false,
}: {
  readonly task: string;
  readonly field: Field;
  /** The task is finished: the value cannot be saved now, only copied or discarded. */
  readonly finished?: boolean;
  /** The task is in the Trash: the same, until it is restored. */
  readonly trashed?: boolean;
  /** On a finished task, the line shows the value itself too: no fact shows it (the title). */
  readonly withValue?: boolean;
}) {
  const lines = useUnsaved(task, field);
  return lines.map(({ line, kept }) => (
    <UnsavedLine
      key={line.id}
      line={line}
      kept={kept}
      finished={finished}
      trashed={trashed}
      withValue={withValue || kept !== undefined || lines.length > 1}
    />
  ));
}

function UnsavedLine({
  line: unsaved,
  kept,
  finished,
  trashed,
  withValue,
}: {
  readonly line: Line;
  readonly kept: string | undefined;
  readonly finished: boolean;
  readonly trashed: boolean;
  readonly withValue: boolean;
}) {
  const t = useT();
  const say = useToast();
  const edits = useEdits();
  const { live } = useContext(Session);
  const state = useLive();
  const readOnly = state.space?.read_only;
  const { task, field } = unsaved;
  /** Discard: this tab's own goes from its edits, another's from the browser, as kept. */
  const discard = () => {
    if (kept === undefined) edits.dismiss(task, field);
    else letGo(live.spaceId ?? "", { kind: "edit", task, field, id: unsaved.id, value: kept });
  };
  const shown = unsaved.change.shown;
  const mine = typeof shown === "string" ? shown : sayMsg(t, shown);
  const conflict = unsaved.reason === "conflict";
  const blocked = trashed
    ? "trash"
    : finished
      ? "finished"
      : state.gone !== undefined
        ? "gone"
        : readOnly !== undefined
          ? "read_only"
          : undefined;
  const why = blocked ?? (edits.restored(unsaved) ? "restored" : undefined);
  if (why !== undefined) {
    return (
      <span className={styles.line} data-part="unsaved" data-reason={why} role="status">
        {withValue || (why !== "finished" && why !== "trash") ? (
          <span className={styles.value} dir="auto" data-part="unsaved-value">
            {mine}
          </span>
        ) : null}
        <span className={styles.why}>
          {why === "read_only"
            ? t("edit.notSavedReadOnly", {
                why: sayMsg(t, readOnlyWhy(readOnly?.reason ?? "")),
              })
            : t(
                why === "trash"
                  ? "edit.notSavedTrash"
                  : why === "finished"
                    ? "edit.notSavedFinished"
                    : why === "gone"
                      ? "edit.notSavedGone"
                      : "edit.notSavedRestored",
              )}
        </span>
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
        <button type="button" className={styles.act} data-part="keep-theirs" onClick={discard}>
          {t("edit.discard")}
        </button>
      </span>
    );
  }
  return (
    <span className={styles.line} data-part="unsaved" data-reason={unsaved.reason} role="status">
      {withValue ? (
        <span className={styles.value} dir="auto" data-part="unsaved-value">
          {mine}
        </span>
      ) : null}
      <span className={styles.why}>
        {conflict
          ? t(
              recent(unsaved.at) ? "edit.changedBy" : "edit.changedByEarlier",
              whoOf(unsaved.by ?? ""),
            )
          : t("edit.notSaved")}
      </span>
      <button
        type="button"
        className={styles.act}
        data-part="apply-mine"
        aria-label={t(conflict ? "edit.applyMineValue" : "edit.tryAgainValue", { value: mine })}
        onClick={() => {
          edits.apply(unsaved);
        }}
      >
        {conflict ? t("edit.applyMine") : t("edit.tryAgain")}
      </button>
      <button type="button" className={styles.act} data-part="keep-theirs" onClick={discard}>
        {conflict ? t("edit.keepTheirs") : t("edit.discard")}
      </button>
    </span>
  );
}
