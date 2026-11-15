// The composer's field (A5 3.8), as far as M5.08 needs it: a text area whose draft is kept per
// space and task, and where a click on an agent-only field starts a request (A5 3.11
// "Click-to-ask"). What acts on its text (Note on Enter, Open with the text, Run, Copy) is M5.07's:
// until then Enter makes a new line and nothing is sent, so what the person writes is only kept.
import { useContext, useEffect, useRef, useState } from "react";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT, type MessageId } from "../i18n/intl.tsx";
import type { AskField } from "../row/actions.ts";
import type { TaskRow } from "../store/rows.ts";
import { keepDraft, onAsk, readDraft } from "./composer.ts";
import css from "./Expanded.module.css";

const styles = classes(css, ["input"]);

const STUBS: Readonly<Record<AskField, MessageId>> = {
  summary: "ask.summary",
  context: "ask.context",
  sources: "ask.sources",
  outcome: "ask.outcome",
  learnings: "ask.learnings",
};

export function ComposerField({ task }: { readonly task: TaskRow }) {
  const t = useT();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => readDraft(space, task.id));

  // A request starts here: its stub follows what the person had written, which stays.
  useEffect(
    () =>
      onAsk((ask) => {
        if (ask.space !== space || ask.task !== task.id) return;
        const stub = t(STUBS[ask.field]);
        const now = field.current?.value ?? "";
        const next = now.trim() === "" ? stub : `${now.trimEnd()}\n${stub}`;
        setText(next);
        keepDraft(space, task.id, next);
        requestAnimationFrame(() => {
          const element = field.current;
          if (element === null) return;
          element.focus();
          element.setSelectionRange(element.value.length, element.value.length);
        });
      }),
    [space, task.id, t],
  );

  return (
    <textarea
      ref={field}
      className={styles.input}
      data-part="composer"
      aria-label={t("composer.label")}
      placeholder={t("composer.placeholder")}
      rows={1}
      maxLength={20_000}
      dir="auto"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        keepDraft(space, task.id, event.target.value);
      }}
    />
  );
}
