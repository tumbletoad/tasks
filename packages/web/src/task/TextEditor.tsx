// The person's correction of a text in place: a task's summary, its context, the words of any
// note or log entry, whoever wrote them, and the library's pages and texts. A pen opens the whole text as an editable box where it
// stands; a text the card holds only in part has no box to save from. Enter saves the words as
// typed (Shift+Enter is a new line), Escape lets go, and leaving the box saves, as the title's
// editor does; in a page's body, which is written in paragraphs, Enter is a new line and
// Ctrl+Enter saves. A box whose words the person did not change writes nothing. What is typed is kept
// in this browser (unsent.ts) until the service holds it: after a reload the box opens again with
// it. The save is made from where the page was when the box opened, so a change someone made
// meanwhile is a refusal, never overwritten: the box closes on the text as it is now, and the
// person's words wait under it as not saved, with Copy and Discard.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import unsaved from "../edit/Unsaved.module.css";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT } from "../i18n/intl.tsx";
import { PencilIcon } from "../row/icons.tsx";
import {
  keepRefusedText,
  keepTextDraft,
  letGo,
  pageLeaving,
  readTextDraft,
  useRefusedTexts,
  type TextDraft,
  type TextPart,
} from "../unsent.ts";
import css from "./TextEditor.module.css";

const styles = classes(css, ["pen", "box", "field"]);
const line = classes(unsaved, ["line", "why", "act", "value"]);

/** A log entry's own limit, the writer's: shorter than a note's or a context's. */
export const LOG_MAX = 16_384;

/**
 * The pen that opens a text for the person to correct: always in sight, named for what it edits.
 * With `why`, it opens nothing and its tip says why.
 */
export function Pen({
  label,
  onPress,
  why,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly why?: string | undefined;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={styles.pen}
      data-part="pen"
      aria-label={label}
      aria-disabled={why === undefined ? undefined : true}
      {...(why === undefined ? {} : { "aria-description": why })}
      data-tip={why ?? t("text.edit")}
      onClick={(event) => {
        // The text around it asks an agent on a click: the pen only edits.
        event.stopPropagation();
        if (why === undefined) onPress();
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
    if (kept.typed !== latest.current) setOpen(true);
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

/**
 * The person's words for `part` that the service refused, each on a line under the text: not
 * saved, with Copy and Discard. They are put in by opening the pen again on the text as it is now.
 */
export function NotSaved({
  space,
  task,
  part,
}: {
  readonly space: string;
  readonly task: string;
  readonly part: TextPart;
}) {
  const t = useT();
  const say = useToast();
  return useRefusedTexts(space, task, part).map(({ tab, typed }) => (
    <span key={tab} className={line.line} data-part="not-saved" role="status">
      <span className={line.why}>{t("edit.notSaved")}</span>
      <span className={line.value} dir="auto" data-part="not-saved-value">
        {typed}
      </span>
      <button
        type="button"
        className={line.act}
        aria-label={t("edit.copyValue", { value: typed })}
        onClick={() => {
          navigator.clipboard.writeText(typed).then(
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
        className={line.act}
        data-part="discard-not-saved"
        onClick={() => {
          letGo(space, { kind: "text", task, part, text: typed, tab, refused: true });
        }}
      >
        {t("edit.discard")}
      </button>
    </span>
  ));
}

export interface TextEditorProps {
  readonly space: string;
  readonly task: string;
  readonly part: TextPart;
  /** The box's name for a screen reader. */
  readonly label: string;
  /** The whole text as the card shows it now. */
  readonly text: string;
  /** One line, as the summary is: Enter saves and no new line is typed. */
  readonly line?: boolean;
  /** Written in paragraphs, as a page's body: Enter is a new line, Ctrl+Enter saves. */
  readonly paragraphs?: boolean;
  /** An emptied box is sent: it takes the text away (the text for agents, a description). */
  readonly clears?: boolean;
  readonly max: number;
  /** Where the page is now: the base of a save made from here. */
  readonly base: string | undefined;
  /** Saves the words from `base`: resolves once the service holds them, rejects with its refusal. */
  readonly save: (words: string, base: string | undefined) => Promise<unknown>;
  /** The box closes: with the words saved, or with none. */
  readonly onDone: (saved: string | undefined) => void;
}

export function TextEditor({
  space,
  task,
  part,
  label,
  text,
  line: single = false,
  paragraphs = false,
  clears = false,
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
  const [opened] = useState(
    (): TextDraft =>
      readTextDraft(space, task, part) ?? {
        typed: text,
        before: text,
        ...(base === undefined ? {} : { base }),
      },
  );
  /** A save on its way: the box takes no other. */
  const sending = useRef(false);
  const [saving, setSaving] = useState(false);
  const fit = () => {
    const box = field.current;
    if (single || box === null) return;
    box.style.height = "auto";
    box.style.height = `${String(box.scrollHeight + 2)}px`;
  };
  useLayoutEffect(fit);
  useEffect(() => {
    const box = field.current;
    box?.focus({ preventScroll: true });
    box?.setSelectionRange(box.value.length, box.value.length);
  }, []);
  const draft = (typed: string): TextDraft => ({
    typed,
    before: opened.before,
    ...(opened.base === undefined ? {} : { base: opened.base }),
  });
  const keep = (typed: string) => {
    keepTextDraft(space, task, part, typed === opened.before ? undefined : draft(typed));
  };
  const release = () => {
    const kept = readTextDraft(space, task, part);
    if (kept !== undefined) letGo(space, { kind: "text", task, part, text: kept.typed });
  };
  const finish = (send: boolean) => {
    if (sending.current) return;
    const typed = field.current?.value ?? "";
    // Nothing the person changed, or nothing at all, is never sent: an emptied text is taken back
    // with its own control, and a box opened over words that changed since writes nothing.
    if (!send || typed === opened.before || (typed.trim() === "" && !clears)) {
      release();
      onDone(undefined);
      return;
    }
    sending.current = true;
    setSaving(true);
    save(typed, opened.base).then(
      () => {
        letGo(space, { kind: "text", task, part, text: typed });
        onDone(typed);
      },
      (error: unknown) => {
        // Refused: never sent again from here. The words wait under the text as not saved.
        keepRefusedText(space, task, part, draft(typed));
        release();
        say(refusalText(error, t("text.notSaved")));
        onDone(undefined);
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
      fit();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.nativeEvent.isComposing) return;
      const saves = paragraphs ? event.ctrlKey || event.metaKey : !event.shiftKey;
      if (event.key === "Enter" && saves) {
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
      {single ? <input {...props} /> : <textarea {...props} rows={1} />}
    </div>
  );
}
