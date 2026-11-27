// The person's correction of a task's text in place: its summary, its context, and the words of
// any note or log entry, whoever wrote them. A pen opens the words as an editable box where they
// stand. Enter saves (Shift+Enter is a new line), Escape lets go, and leaving the box saves, as the
// title's editor does. What is typed is kept in this browser (unsent.ts) until the service holds
// it: after a reload the box opens again with it. The save is made from where the page was when
// the box opened, so a change someone made meanwhile is a refusal, never overwritten; the box then
// keeps the person's words, and a second Enter saves them over what is there now.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT } from "../i18n/intl.tsx";
import { PencilIcon } from "../row/icons.tsx";
import {
  keepTextDraft,
  letGo,
  pageLeaving,
  readTextDraft,
  wordsOf,
  type TextDraft,
  type TextPart,
} from "../unsent.ts";
import css from "./TextEditor.module.css";

const styles = classes(css, ["pen", "box", "field", "status"]);

/** The pen that opens a text for the person to correct: always in sight, named for what it edits. */
export function Pen({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={styles.pen}
      data-part="pen"
      aria-label={label}
      data-tip={t("text.edit")}
      onClick={(event) => {
        // The text around it asks an agent on a click: the pen only edits.
        event.stopPropagation();
        onPress();
      }}
    >
      <PencilIcon />
    </button>
  );
}

/**
 * Whether the person's editor of `part` is open. Once the text can be edited (its card is open),
 * words kept for it from before a reload open the editor with them, unless the text already shows
 * them: their save went through before the page went.
 */
export function useEditing(
  space: string,
  task: string,
  part: TextPart,
  text: string,
  editable: boolean,
): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const latest = useRef(text);
  latest.current = text;
  useLayoutEffect(() => {
    if (!editable) return;
    const kept = readTextDraft(space, task, part);
    if (kept === undefined) return;
    if (wordsOf(kept.typed) !== wordsOf(latest.current)) setOpen(true);
    else letGo(space, { kind: "text", task, part, text: kept.typed });
  }, [editable, space, task, part]);
  return [open && editable, setOpen];
}

/**
 * The words to show of a text the person just saved: the saved ones until the text read next
 * differs from the one they were saved over, then the text as read.
 */
export function useSaved(text: string): readonly [string, (words: string | undefined) => void] {
  const [saved, setSaved] = useState<{ readonly over: string; readonly words: string }>();
  if (saved !== undefined && saved.over !== text) setSaved(undefined);
  const shown = saved !== undefined && saved.over === text ? saved.words : text;
  return [
    shown,
    (words) => {
      setSaved(words === undefined ? undefined : { over: text, words });
    },
  ];
}

export interface TextEditorProps {
  readonly space: string;
  readonly task: string;
  readonly part: TextPart;
  /** The box's name for a screen reader. */
  readonly label: string;
  /** The words as the card shows them now. */
  readonly text: string;
  /** One line, as the summary is: Enter saves and no new line is typed. */
  readonly line?: boolean;
  readonly max: number;
  /** Where the page is now: the base of a save made from here. */
  readonly base: () => string | undefined;
  /** Saves the words from `base`: resolves once the service holds them, rejects with its refusal. */
  readonly save: (words: string, base: string | undefined) => Promise<unknown>;
  /** The box closes: with the words saved, or with none when the person let go. */
  readonly onDone: (saved: string | undefined) => void;
}

export function TextEditor({
  space,
  task,
  part,
  label,
  text,
  line = false,
  max,
  base,
  save,
  onDone,
}: TextEditorProps) {
  const t = useT();
  const say = useToast();
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  // Taken once, as the box opens: the words it began from and the base of their save, also when a
  // reload brought back what was typed.
  const [opened] = useState((): TextDraft => {
    const kept = readTextDraft(space, task, part);
    const now = base();
    return kept ?? { typed: text, before: text, ...(now === undefined ? {} : { base: now }) };
  });
  const from = useRef(opened.base);
  /** A save on its way: the box takes no other until it is answered. */
  const sending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string>();
  const fit = () => {
    const box = field.current;
    if (line || box === null) return;
    box.style.height = "auto";
    box.style.height = `${String(box.scrollHeight + 2)}px`;
  };
  useLayoutEffect(fit);
  useEffect(() => {
    const box = field.current;
    box?.focus({ preventScroll: true });
    box?.setSelectionRange(box.value.length, box.value.length);
  }, []);
  const keep = (typed: string) => {
    keepTextDraft(
      space,
      task,
      part,
      typed === opened.before
        ? undefined
        : {
            typed,
            before: opened.before,
            ...(from.current === undefined ? {} : { base: from.current }),
          },
    );
  };
  const release = () => {
    const kept = readTextDraft(space, task, part);
    if (kept !== undefined) letGo(space, { kind: "text", task, part, text: kept.typed });
  };
  const finish = (saving: boolean) => {
    if (sending.current) return;
    const typed = field.current?.value ?? "";
    const words = line ? typed.trim() : wordsOf(typed);
    // Nothing to save: an emptied text is taken back with its own control, not by clearing it.
    if (!saving || words === "" || words === wordsOf(text)) {
      release();
      onDone(undefined);
      return;
    }
    sending.current = true;
    setSaving(true);
    save(words, from.current).then(
      () => {
        letGo(space, { kind: "text", task, part, text: typed });
        onDone(words);
      },
      (error: unknown) => {
        // Refused: the words stay, kept, and the next save is made from what the page shows now.
        const why = refusalText(error, t("text.notSaved"));
        sending.current = false;
        setSaving(false);
        setRefused(why);
        from.current = base();
        keep(typed);
        say(why);
        field.current?.focus({ preventScroll: true });
      },
    );
  };
  const props = {
    ref: field,
    className: styles.field,
    "data-part": "text-edit",
    "aria-label": label,
    "aria-busy": saving,
    readOnly: saving,
    defaultValue: opened.typed,
    maxLength: max,
    dir: "auto",
    onInput: (event: { currentTarget: { value: string } }) => {
      keep(event.currentTarget.value);
      setRefused(undefined);
      fit();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        // Escape leaves the box only: the list must not collapse the card.
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    },
    onBlur: () => {
      // The window lost focus or the page goes away: the box keeps what was typed for its return.
      if (!document.hasFocus() || pageLeaving()) return;
      finish(true);
    },
  };
  return (
    <div className={styles.box} data-part="text-editor">
      {line ? <input {...props} /> : <textarea {...props} rows={1} />}
      {refused === undefined ? null : (
        <p className={styles.status} role="status" data-part="text-refused">
          {refused}
        </p>
      )}
    </div>
  );
}
