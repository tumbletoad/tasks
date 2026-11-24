// The line under a control whose edit the service did not take (A5 3.11 "Writes"): the control
// shows the current value, and this line shows the person's own value with what they can do. After
// a conflict: "<value> Changed by Codex just now · Apply mine · Copy · Keep theirs". After a failed
// call: "<value> Not saved · Try again · Copy · Discard". On a finished task, which takes no edit
// until it is reopened: "<value> Not saved: the task is finished · Copy · Discard", and on one in
// the Trash "… the task is in the Trash". An edit made against a history the space no longer has
// (restored since) is not sent again: "<value> Not saved: the space was restored since · Copy ·
// Discard"; nor a size chosen from effort levels that changed since, which may mean something else
// now. In a space that takes no change (a restored copy, one another machine owns), nothing
// can be saved until that changes: "<value> Not saved: this is a restored copy · Copy · Discard";
// nor from a tab whose copy of the space was closed or replaced since it loaded. The line stays
// until the person chooses, whatever the feed brings.
//
// Every edit of the field the browser keeps has its line. One this tab did not make (another tab's,
// a closed tab's, an earlier build's) is never sent from here: "<value> Typed in another tab · Copy
// · Discard", as a title typed in another tab (KeptTitles.tsx).
import { useContext } from "react";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { Session } from "../context.ts";
import { sayMsg } from "../row/say.ts";
import { useLive } from "../store/hooks.ts";
import { letGo, useKeptEdits } from "../unsent.ts";
import type { Field } from "./change.ts";
import { fieldWords, keyOf, whoOf, type Unsaved as Line } from "./edits.ts";
import { readOnlyWhy } from "./read-only.ts";
import css from "./Unsaved.module.css";
import { useEditState, useEdits } from "./useEdits.ts";

const styles = classes(css, ["line", "why", "act", "value"]);

/** A conflict this recent still reads "just now": one kept from before a reload may be older. */
const RECENT_MS = 120_000;

const recent = (at: number | undefined): boolean => at === undefined || Date.now() - at < RECENT_MS;

/** Why a line offers no Try again, as it says so. */
const WHY = {
  trash: "edit.notSavedTrash",
  finished: "edit.notSavedFinished",
  "other-tab": "edit.otherTab",
  gone: "edit.notSavedGone",
  restored: "edit.notSavedRestored",
  levels: "edit.notSavedLevels",
} as const satisfies Record<string, MessageId>;

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
}: {
  readonly task: string;
  readonly field: Field;
  /** The task is finished: the value cannot be saved now, only copied or discarded. */
  readonly finished?: boolean;
  /** The task is in the Trash: the same, until it is restored. */
  readonly trashed?: boolean;
}) {
  return useUnsaved(task, field).map(({ line, kept }) => (
    <UnsavedLine key={line.id} line={line} kept={kept} finished={finished} trashed={trashed} />
  ));
}

function UnsavedLine({
  line: unsaved,
  kept,
  finished,
  trashed,
}: {
  readonly line: Line;
  readonly kept: string | undefined;
  readonly finished: boolean;
  readonly trashed: boolean;
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
  const named = { field: t(fieldWords(field)) };
  const conflict = unsaved.reason === "conflict";
  const blocked = trashed
    ? "trash"
    : finished
      ? "finished"
      : kept !== undefined
        ? "other-tab"
        : state.gone !== undefined
          ? "gone"
          : readOnly !== undefined
            ? "read_only"
            : undefined;
  const why =
    blocked ??
    (edits.restored(unsaved) ? "restored" : edits.relevelled(unsaved) ? "levels" : undefined);
  const sendable = why === undefined;
  return (
    <span
      className={styles.line}
      data-part="unsaved"
      data-reason={why ?? unsaved.reason}
      role="status"
    >
      <span className={styles.value} dir="auto" data-part="unsaved-value">
        {mine}
      </span>
      <span className={styles.why}>
        {why === undefined
          ? conflict
            ? t(
                recent(unsaved.at) ? "edit.changedBy" : "edit.changedByEarlier",
                whoOf(unsaved.by ?? ""),
              )
            : t("edit.notSaved")
          : why === "read_only"
            ? t("edit.notSavedReadOnly", {
                why: sayMsg(t, readOnlyWhy(readOnly?.reason ?? "")),
              })
            : t(why === "finished" && kept !== undefined ? "edit.otherTabFinished" : WHY[why])}
      </span>
      {sendable ? (
        <button
          type="button"
          className={styles.act}
          data-part="apply-mine"
          aria-label={t(conflict ? "edit.applyMineField" : "edit.tryAgainField", named)}
          onClick={() => {
            edits.apply(task, field);
          }}
        >
          {conflict ? t("edit.applyMine") : t("edit.tryAgain")}
        </button>
      ) : null}
      <button
        type="button"
        className={styles.act}
        data-part="copy-mine"
        aria-label={t("edit.copyField", named)}
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
        {sendable && conflict ? t("edit.keepTheirs") : t("edit.discard")}
      </button>
    </span>
  );
}
