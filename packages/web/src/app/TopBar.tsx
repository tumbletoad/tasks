// The top bar (A5 3.3): one field and a New task button. The field takes a title and adds the task
// to the Inbox (A5 3.13: a task without an area goes to the Inbox); search, the capture syntax and
// the `/` shortcut's full keymap are M5.10 and M5.11. `/` already moves focus to the field, as its
// hint says. Refresh joins the bar with the refresh routine (M6): a button that cannot start
// anything yet would only be noise.
//
// The field's draft is kept per space, so it survives a switch to another space and back (A5 3.3:
// drafts are stored per space). A draft typed while an add was on its way stays.
//
// An add's text stays in the field until the feed confirms the add (A5 3.15), so the field
// tracks it until then: the same text is not sent again while it is on its way, and when the
// space's session ends first (a switch of space stops its store, which then confirms nothing), an
// add the service took drops its text from the space's kept draft.
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useToast } from "./frame.ts";
import { PlusIcon } from "./Icons.tsx";
import css from "./TopBar.module.css";
import { classes } from "./css.ts";

const styles = classes(css, ["bar", "button", "field", "hint", "input"]);

/** This tab's drafts of the field, per space. */
const drafts = new Map<string, string>();

/** Drops `text` from the space's kept draft, unless the draft has become something else. */
function forget(space: string, text: string): void {
  if (drafts.get(space) === text) drafts.delete(space);
}

/** Whether a key press belongs to a text field or an IME composition, where `/` is a character. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target;
  if (event.isComposing) return true;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function TopBar({ space, live }: { readonly space: string; readonly live: boolean }) {
  const t = useT();
  const say = useToast();
  const { api, live: feed } = useContext(Session);
  const [text, setText] = useState(() => drafts.get(space) ?? "");
  const field = useRef<HTMLInputElement>(null);
  /** The texts of adds on their way: sent, and not yet confirmed or refused. */
  const sending = useRef(new Set<string>());
  /** Of those, the ones the service took: they wait only for the feed. */
  const taken = useRef(new Set<string>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const took = taken.current;
    return () => {
      mounted.current = false;
      for (const text of took) forget(space, text);
    };
  }, [space]);

  useEffect(() => {
    if (text === "") drafts.delete(space);
    else drafts.set(space, text);
  }, [space, text]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || typing(event)) {
        return;
      }
      event.preventDefault();
      field.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const add = () => {
    const submitted = text;
    const title = submitted.trim();
    if (title === "") {
      field.current?.focus();
      return;
    }
    if (!live || sending.current.has(submitted)) return;
    sending.current.add(submitted);
    // Through the live store (A5 3.15): no optimistic row, and the text goes when the feed
    // confirms the add, so the new row is on screen when it does. Only the text that was added
    // goes: whatever the person typed meanwhile stays, here and in the space's kept draft.
    const sent = feed.write((request_id) =>
      api.client.task.add({ tasks: [{ title, inbox: true }], request_id }),
    );
    void sent.settled.then((settled) => {
      sending.current.delete(submitted);
      taken.current.delete(submitted);
      if (settled !== "confirmed") return;
      forget(space, submitted);
      setText((current) => (current === submitted ? "" : current));
    });
    sent.answer.then(
      () => {
        if (!sending.current.has(submitted)) return;
        if (mounted.current) taken.current.add(submitted);
        else forget(space, submitted);
      },
      (error: unknown) => {
        sending.current.delete(submitted);
        if (!feed.failed(error)) say(t("top.addFailed"));
      },
    );
  };

  return (
    <div className={styles.bar}>
      <div className={styles.field}>
        <input
          ref={field}
          className={styles.input}
          type="text"
          value={text}
          maxLength={500}
          placeholder={t("top.newTask")}
          aria-label={t("top.newTask")}
          aria-keyshortcuts="/"
          autoComplete="off"
          spellCheck
          disabled={!live}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add();
            }
          }}
        />
        <kbd className={styles.hint} aria-hidden="true">
          {t("top.slash")}
        </kbd>
      </div>
      <Button className={styles.button} aria-label={t("top.add")} isDisabled={!live} onPress={add}>
        <PlusIcon />
      </Button>
    </div>
  );
}
