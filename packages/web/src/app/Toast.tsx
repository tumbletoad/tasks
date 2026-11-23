// The toast (A5 3.12): one at a time, at the foot of the main column, a short past-tense sentence
// and at most one action. A new one replaces the old; the replaced change stays undoable with
// Ctrl+Z. Undo toasts last 6 s, plain ones 2.5 s, and errors stay until they are dismissed. A
// timer pauses while the pointer or focus is on the toast. F6 moves focus to its action, and focus
// goes back where it was once the action ran or Escape left the toast.
//
// The region is always in the page (a polite live region must exist before what it announces), and
// the toast's words are formatted here from message IDs: the edits controller holds no text.
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/intl.tsx";
import { is } from "../keys/keymap.ts";
import type { Msg } from "../row/model.ts";
import { namesMachine, sayMsg } from "../row/say.ts";
import type { ToastKind } from "../edit/edits.ts";
import { classes } from "./css.ts";
import css from "./Toast.module.css";

const styles = classes(css, ["toast", "text", "action", "dismiss"]);

/** How long each kind stays (A5 3.12): errors until dismissed. */
const LASTS: Readonly<Record<ToastKind, number | undefined>> = {
  undo: 6_000,
  info: 2_500,
  error: undefined,
};

export interface Shown {
  readonly key: number;
  readonly kind: ToastKind;
  readonly text: string | Msg;
  readonly action?: { readonly label: Msg; readonly run: () => void };
}

export interface ToastHandle {
  /** Focus the action (F6). Returns whether there was one. */
  readonly focusAction: () => boolean;
}

export function Toast({
  toast,
  onDone,
  handle,
}: {
  readonly toast: Shown | undefined;
  readonly onDone: (key: number) => void;
  readonly handle: { current: ToastHandle | undefined };
}) {
  const t = useT();
  const action = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  /** Where focus was before F6 took it to the toast. */
  const back = useRef<Element | null>(null);
  const [held, setHeld] = useState(false);

  handle.current = {
    focusAction: () => {
      if (action.current === null) return false;
      back.current = document.activeElement;
      action.current.focus();
      return true;
    },
  };

  // The toast's own timer: restarted for each toast, paused while held.
  const lasts = toast === undefined ? undefined : LASTS[toast.kind];
  const key = toast?.key;
  useEffect(() => {
    if (key === undefined || lasts === undefined || held) return;
    const timer = setTimeout(() => {
      onDone(key);
    }, lasts);
    return () => {
      clearTimeout(timer);
    };
  }, [key, lasts, held, onDone]);

  const returnFocus = useCallback(() => {
    const element = back.current;
    back.current = null;
    if (!(box.current?.contains(document.activeElement) ?? false)) return;
    if (element instanceof HTMLElement && element.isConnected) element.focus();
    else document.getElementById("main")?.focus();
  }, []);

  const text =
    toast === undefined ? "" : typeof toast.text === "string" ? toast.text : sayMsg(t, toast.text);
  return (
    <div
      ref={box}
      className={styles.toast}
      role="status"
      aria-live="polite"
      aria-label={t("toast.label")}
      data-kind={toast?.kind}
      data-shown={toast !== undefined}
      onMouseEnter={() => {
        setHeld(true);
      }}
      onMouseLeave={() => {
        setHeld(false);
      }}
      onFocus={() => {
        setHeld(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
      onKeyDown={(event) => {
        if (is(event.nativeEvent, "close") && toast !== undefined) {
          event.preventDefault();
          returnFocus();
        }
      }}
    >
      {toast === undefined ? null : (
        <>
          <span
            className={styles.text}
            data-part="toast-text"
            data-machine={
              typeof toast.text !== "string" && namesMachine(toast.text) ? "" : undefined
            }
          >
            {text}
          </span>
          {toast.action === undefined ? null : (
            <button
              ref={action}
              type="button"
              className={styles.action}
              data-part="toast-action"
              onClick={() => {
                const run = toast.action?.run;
                returnFocus();
                onDone(toast.key);
                run?.();
              }}
            >
              {sayMsg(t, toast.action.label)}
            </button>
          )}
          {toast.kind === "error" ? (
            <button
              type="button"
              className={styles.dismiss}
              data-part="toast-dismiss"
              aria-label={t("toast.dismiss")}
              onClick={() => {
                returnFocus();
                onDone(toast.key);
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
