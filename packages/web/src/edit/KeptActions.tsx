// The lines on a task's card for what a page did not get to send before it went: a check-off, a
// reopen, a move to or from the Trash, an undo or a redo that waited behind an edit. "Not done yet:
// check off · Try again · Discard", as a kept field edit shows its value (Unsaved.tsx). Try again is
// the person's own action again, with its request ID; Discard lets it go. Every tab of the browser
// shows them, and nothing is sent until the person asks.
import { useContext } from "react";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import type { TaskRow } from "@ttasks/client/store";
import { letGoAction, useKeptActions } from "../unsent.ts";
import css from "./Unsaved.module.css";
import { useEdits } from "./useEdits.ts";

const styles = classes(css, ["line", "why", "act"]);

export function KeptActions({ task }: { readonly task: TaskRow }) {
  const t = useT();
  const edits = useEdits();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  return useKeptActions(space, task.id).map((action) => (
    <span
      key={action.request}
      className={styles.line}
      data-part="kept-action"
      data-kind={action.kind}
      role="status"
    >
      <span className={styles.why}>{t("edit.keptAction", { kind: action.kind })}</span>
      <button
        type="button"
        className={styles.act}
        data-part="kept-action-again"
        aria-label={t("edit.keptActionAgain", { kind: action.kind })}
        onClick={() => {
          edits.retryKept(action, task);
        }}
      >
        {t("edit.tryAgain")}
      </button>
      <button
        type="button"
        className={styles.act}
        data-part="kept-action-discard"
        aria-label={t("edit.keptActionDiscard", { kind: action.kind })}
        onClick={() => {
          letGoAction(space, action.request);
        }}
      >
        {t("edit.discard")}
      </button>
    </span>
  ));
}
