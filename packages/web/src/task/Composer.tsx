// The composer: what the person types about a task, and the one strip under it where that text
// goes. Note saves it as a note on the task. Open starts an agent instance on the task with the
// text as its request (without text it opens as the tile does). Copy puts the brief on the
// clipboard with the text, Shift+Copy the context pack. Each clears the field once its text has
// gone somewhere: the note was saved, the launch reached the agent, the brief is on the
// clipboard. Text typed meanwhile stays. Until then the draft is kept (composer.ts), so a reload
// brings it back.
//
// Enter saves a note and Ctrl+Enter opens the first instance (keymap.ts): never while an input
// method composes. Run, an agent working without a window, is not offered until it can start.
import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Toolbar } from "react-aria-components";
import { requestId, type Instance, type Receipt } from "../api.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useMachine } from "../app/machine.ts";
import { Session } from "../context.ts";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { actionOf, ariaKeys, isMac, keysOf } from "../keys/keymap.ts";
import { useKeyLabel } from "../keys/labels.ts";
import type { AskField, RowActions } from "../row/actions.ts";
import { CopyIcon } from "../row/icons.tsx";
import { tileState } from "../row/launch.ts";
import type { TaskRow } from "../store/rows.ts";
import { typingIn } from "../kept.ts";
import {
  DRAFT_MAX,
  carry,
  delivered,
  keepDraft,
  keepNote,
  onAsk,
  onDraft,
  readDraft,
  readNote,
  settled,
  wordsOf,
} from "./composer.ts";
import css from "./Expanded.module.css";

const styles = classes(css, ["input", "strip", "button", "glyph", "hint", "gap"]);

const STUBS: Readonly<Record<AskField, MessageId>> = {
  summary: "ask.summary",
  context: "ask.context",
  sources: "ask.sources",
  outcome: "ask.outcome",
  learnings: "ask.learnings",
};

export interface ComposerProps {
  readonly task: TaskRow;
  readonly receipts: readonly Receipt[];
  readonly instances: readonly Instance[];
  readonly actions: RowActions;
}

export function Composer({ task, receipts, instances, actions }: ComposerProps) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const { singleKeys } = useMachine();
  const mac = useMemo(isMac, []);
  const keyLabel = useKeyLabel();
  const space = live.spaceId ?? "";
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => readDraft(space, task.id));
  /** The text on screen, for answers that arrive later. */
  const now = useRef(text);
  now.current = text;
  /** The words of the note on their way from this tab. */
  const sending = useRef<string | undefined>(undefined);
  /** The instances whose Open is on its way from here. */
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());

  const write = (next: string) => {
    setText(next);
    keepDraft(space, task.id, next);
  };

  /**
   * The words went somewhere: the kept draft and the field clear, each unless the person has
   * typed on since (here, in another tab, or in this task's composer opened again).
   */
  const sent = (words: string) => {
    if (wordsOf(readDraft(space, task.id)) === words) keepDraft(space, task.id, "");
    if (wordsOf(now.current) === words) setText("");
  };

  // A launch that carries the words clears them once they reached the agent; a failed one leaves
  // them here.
  useEffect(() => {
    for (const words of settled(space, task.id, receipts)) sent(words);
  });

  // A request starts here: its stub follows what the person had written, which stays.
  useEffect(
    () =>
      onAsk((ask) => {
        if (ask.space !== space || ask.task !== task.id) return;
        const stub = t(STUBS[ask.field]);
        const before = field.current?.value ?? "";
        const joined = before.trim() === "" ? stub : `${before.trimEnd()}\n${stub}`;
        // A field already full keeps what the person wrote: the stub is only a start.
        const next = joined.length > DRAFT_MAX ? before : joined;
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

  // Another tab of this task changed the draft: this one follows unless the person types here.
  useEffect(
    () =>
      onDraft(space, task.id, (next) => {
        if (!typingIn(field.current)) setText(next);
      }),
    [space, task.id],
  );

  const words = wordsOf(text);

  const addNote = () => {
    if (words === "") {
      field.current?.focus();
      return;
    }
    if (sending.current === words) return;
    // The same words again (after a failure, a reload, or from another tab) are the same request:
    // the service saves them once.
    const known = readNote(space, task.id);
    const id = known?.words === words ? known.id : requestId();
    keepNote(space, task.id, { words, id });
    sending.current = words;
    api.client.entry.add({ task: task.id, kind: "note", text: words, request_id: id }).then(
      () => {
        if (sending.current === words) sending.current = undefined;
        if (readNote(space, task.id)?.id === id) keepNote(space, task.id, undefined);
        sent(words);
      },
      (error: unknown) => {
        if (sending.current === words) sending.current = undefined;
        if (!live.failed(error)) say(t("composer.noteFailed"));
      },
    );
  };

  const open = (instance: Instance) => {
    if (opening.has(instance.key)) return;
    setOpening((known) => new Set(known).add(instance.key));
    const request = words;
    // A click while a launch of the instance lives returns that launch: it takes no new request.
    const before = new Set(receipts.filter((r) => r.instance === instance.key).map((r) => r.id));
    void actions.open(task, instance, request === "" ? undefined : request).then((receipt) => {
      setOpening((known) => {
        const next = new Set(known);
        next.delete(instance.key);
        return next;
      });
      if (receipt === undefined || before.has(receipt.id) || request === "") return;
      const reached = delivered(receipt);
      if (reached === true) sent(request);
      else if (reached === undefined) carry(space, task.id, receipt.id, request);
    });
  };

  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    const request = words;
    void actions.copy(task, event.shiftKey, request === "" ? undefined : request).then((ok) => {
      if (ok && request !== "") sent(request);
    });
  };

  /** Why an instance does not open now, as its tip says it; undefined when it opens. */
  const held = (instance: Instance): string | undefined => {
    const state = tileState(receipts, instance.key);
    if (opening.has(instance.key) || state === "opening") {
      return t("composer.opening", { label: instance.label });
    }
    // A click would return the launch it has, which takes no new request.
    if (state === "connected" || state === "not_confirmed") {
      return t("composer.hasSession", { label: instance.label });
    }
    return undefined;
  };

  const noteKeys = keysOf("note", singleKeys);
  const openKeys = keysOf("open-first", singleKeys);
  const first = instances[0];

  return (
    <>
      <textarea
        ref={field}
        className={styles.input}
        data-part="composer"
        aria-label={t("composer.label")}
        placeholder={t("composer.placeholder")}
        rows={1}
        maxLength={DRAFT_MAX}
        dir="auto"
        value={text}
        onChange={(event) => {
          write(event.target.value);
        }}
        onKeyDown={(event) => {
          const action = actionOf(event.nativeEvent, "composer", singleKeys);
          if (action === "note") {
            event.preventDefault();
            addNote();
          } else if (action === "open-first") {
            event.preventDefault();
            if (first === undefined) say(t("composer.noAgent"));
            else {
              const why = held(first);
              if (why === undefined) open(first);
              else say(why);
            }
          }
        }}
      />
      <Toolbar className={styles.strip} aria-label={t("strip.label")} data-part="strip">
        <button
          type="button"
          className={styles.button}
          data-part="note"
          aria-disabled={words === ""}
          aria-keyshortcuts={ariaKeys(noteKeys, mac)}
          aria-description={t(words === "" ? "composer.noteEmpty" : "composer.noteTip")}
          data-tip={t(words === "" ? "composer.noteEmpty" : "composer.noteTip")}
          onClick={addNote}
        >
          {t("composer.note")}
          {noteKeys[0] === undefined ? null : (
            <kbd className={styles.hint} aria-hidden="true">
              {keyLabel(noteKeys[0])}
            </kbd>
          )}
        </button>

        {instances.map((instance, i) => {
          const why = held(instance);
          const tip =
            why ??
            t(words === "" ? "composer.openTip" : "composer.openWithTip", {
              label: instance.label,
            });
          return (
            <button
              key={instance.key}
              type="button"
              className={styles.button}
              data-part="open"
              data-default={i === 0 ? "" : undefined}
              data-state={tileState(receipts, instance.key)}
              data-ring={instance.ring}
              aria-disabled={why !== undefined}
              aria-keyshortcuts={i === 0 ? ariaKeys(openKeys, mac) : undefined}
              aria-description={tip}
              data-tip={tip}
              onClick={() => {
                if (why === undefined) open(instance);
              }}
            >
              <span className={styles.glyph} aria-hidden="true">
                {instance.glyph}
              </span>
              {t("row.openIn", { label: instance.label })}
              {i === 0 && openKeys[0] !== undefined ? (
                <kbd className={styles.hint} aria-hidden="true">
                  {keyLabel(openKeys[0])}
                </kbd>
              ) : null}
            </button>
          );
        })}
        <span className={styles.gap} aria-hidden="true" />
        <button
          type="button"
          className={styles.button}
          data-part="copy"
          aria-label={t("row.copyFor", { title: task.title })}
          aria-description={t(words === "" ? "row.copyTip" : "composer.copyTip")}
          data-tip={t(words === "" ? "row.copyTip" : "composer.copyTip")}
          onClick={copy}
        >
          <CopyIcon />
          {t("row.copy")}
        </button>
      </Toolbar>
    </>
  );
}
