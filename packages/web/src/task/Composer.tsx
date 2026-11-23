// The composer: what the person types about a task, and the one strip under it where that text
// goes. Note saves it as a note on the task. Open saves it on the task as the request of the agent
// it starts, which never goes on a command line or in a link (without text it opens as the tile
// does). Copy puts the brief on the clipboard with the text, Shift+Copy the context pack. Each
// clears the field once its text has gone somewhere: the note or the request is on the task, the
// brief is on the clipboard. Text typed meanwhile stays. Until then the draft is kept
// (unsent.ts), so a reload brings it back. A note is kept from the moment it is sent until the
// service holds it: one that is not on its way from here and is not what the field shows waits
// above the field, with Send again, Copy and Discard. Near its limit the strip says how much more
// fits.
//
// Run starts an agent that works on the task in the background, without a window, with the text
// as its request (without text it works on the task): one button for the first instance that can
// run, and, when several can, a menu beside it with the others. Its words clear once the service
// queued the run, which holds them; a refusal keeps them. A finished task runs nothing: Reopen
// stands where Run would, on Run's key, until the task is open again.
//
// Enter saves a note, Ctrl+Enter opens the first instance and Ctrl+Shift+Enter runs the first
// that can (keymap.ts): never while an input method composes.
import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Button, Dialog, DialogTrigger, Popover, Toolbar } from "react-aria-components";
import { requestId, type Instance } from "../api.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useMachine } from "../app/machine.ts";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { actionOf, ariaKeys, isMac, keysOf } from "../keys/keymap.ts";
import { useKeyLabel } from "../keys/labels.ts";
import type { AskField, RowActions } from "../row/actions.ts";
import { ChevronIcon as ChevronDownIcon } from "../app/Icons.tsx";
import { CopyIcon, RunIcon } from "../row/icons.tsx";
import { runners } from "./runs.ts";
import { tileState, type BusyOf } from "../row/launch.ts";
import { questionsWaiting, type TaskRow } from "../store/rows.ts";
import { typingIn } from "../kept.ts";
import {
  DRAFT_MAX,
  keepDraft,
  keepNote,
  letGo,
  onDraft,
  readDraft,
  readNotes,
  useNotes,
  wordsOf,
  type NoteRequest,
} from "../unsent.ts";
import { onAsk, onSaved } from "./composer.ts";
import { openAsked, useUnansweredOpens } from "../views/unanswered.ts";
import keptCss from "../edit/Unsaved.module.css";
import css from "./Expanded.module.css";

const styles = classes(css, [
  "input",
  "strip",
  "button",
  "glyph",
  "hint",
  "label",
  "gap",
  "runs",
  "others",
  "runMenu",
  "runItem",
  "limit",
]);
const noteLine = classes(keptCss, ["line", "why", "act", "value"]);

/** The strip says how much more fits once the field holds this much of DRAFT_MAX. */
const LIMIT_SHOWN = DRAFT_MAX - 2_000;

const STUBS: Readonly<Record<AskField, MessageId>> = {
  summary: "ask.summary",
  context: "ask.context",
  sources: "ask.sources",
  outcome: "ask.outcome",
  learnings: "ask.learnings",
};

export interface ComposerProps {
  readonly task: TaskRow;
  /** What busies each agent app with the task on this machine. */
  readonly busy: BusyOf | undefined;
  readonly instances: readonly Instance[];
  readonly actions: RowActions;
}

/**
 * The task's notes not on their way from here whose words the field does not show: each with its
 * words and Copy, and on a live card Send again and Discard. A note waits here until the service
 * holds it or the person lets it go.
 */
function KeptNotes({
  task,
  shown,
  flying,
  send,
}: {
  readonly task: string;
  /** The words the field shows, and those of the note on its way from here. */
  readonly shown: readonly string[];
  /** The notes this card sent and has no answer for yet, by request ID. */
  readonly flying?: ReadonlySet<string>;
  /** Sends the note again, with its request ID; none on a card that writes nothing. */
  readonly send?: (note: NoteRequest) => void;
}) {
  const t = useT();
  const say = useToast();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  const notes = useNotes(space, task).filter((note) => !shown.includes(note.words));
  return notes.map((note) => (
    <p key={note.id} className={noteLine.line} data-part="kept-note" role="status">
      <span className={noteLine.value} dir="auto">
        {note.words}
      </span>
      <span className={noteLine.why}>
        {t(flying?.has(note.id) === true ? "composer.noteOnItsWay" : "composer.noteKept")}
      </span>
      {send === undefined || flying?.has(note.id) === true ? null : (
        <button
          type="button"
          className={noteLine.act}
          data-part="send-kept-note"
          onClick={() => {
            send(note);
          }}
        >
          {t("composer.noteAgain")}
        </button>
      )}
      <button
        type="button"
        className={noteLine.act}
        data-part="copy-kept-note"
        aria-label={t("edit.copyValue", { value: note.words })}
        onClick={() => {
          navigator.clipboard.writeText(note.words).then(
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
      {send === undefined || flying?.has(note.id) === true ? null : (
        <button
          type="button"
          className={noteLine.act}
          data-part="discard-kept-note"
          onClick={() => {
            letGo(space, { kind: "note", task, id: note.id });
          }}
        >
          {t("edit.discard")}
        </button>
      )}
    </p>
  ));
}

/**
 * The composer of a task in the Trash: its kept draft and notes as they are, to read and copy,
 * following another tab's changes. It writes nothing, and nothing a click elsewhere asks reaches
 * it: Restore first. The foot of the Trash discards them.
 */
export function KeptDraft({ task }: { readonly task: TaskRow }) {
  const t = useT();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  const [text, setText] = useState(() => readDraft(space, task.id));
  useEffect(() => onDraft(space, task.id, setText), [space, task.id]);
  return (
    <>
      <KeptNotes task={task.id} shown={[wordsOf(text)]} />
      {text === "" ? null : (
        <textarea
          className={styles.input}
          data-part="composer"
          aria-label={t("composer.label")}
          readOnly
          rows={1}
          dir="auto"
          value={text}
        />
      )}
      <p className={styles.strip} data-part="strip-trash">
        {t("composer.inTrash")}
      </p>
    </>
  );
}

export function Composer({ task, busy, instances, actions }: ComposerProps) {
  const t = useT();
  const say = useToast();
  const edits = useEdits();
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
  /** The words of the note on their way from this tab, at once and for drawing. */
  const sending = useRef<string | undefined>(undefined);
  const [onItsWay, setOnItsWay] = useState<string | undefined>(undefined);
  /** Every note this card sent and has no answer for yet, by request ID. */
  const [flying, setFlying] = useState<ReadonlySet<string>>(new Set());
  /** The instances whose Open is on its way from here. */
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());
  /** A Run on its way from here: the words it carries, until the service answered. */
  const starting = useRef<string | undefined>(undefined);
  const [runningFrom, setRunningFrom] = useState(false);

  const write = (next: string) => {
    setText(next);
    keepDraft(space, task.id, next);
  };

  /**
   * The words went somewhere: the kept draft and the field clear, each unless the person has
   * typed on since (here, in another tab, or in this task's composer opened again). A kept note
   * of the same words goes only when a note of them was `saved`: a Copy or an Open posts no note,
   * so a note that was not saved stays until its own answer or the person's Discard.
   */
  const sent = (words: string, saved = false) => {
    const kept = readDraft(space, task.id);
    if (wordsOf(kept) === words) letGo(space, { kind: "draft", task: task.id, text: kept });
    if (wordsOf(now.current) === words) setText("");
    if (!saved || sending.current === words) return;
    for (const note of readNotes(space, task.id)) {
      if (note.words === words) letGo(space, { kind: "note", task: task.id, id: note.id });
    }
  };

  // An Open saved the words on the task, also one the person confirmed from a toast.
  useEffect(
    () =>
      onSaved((saved) => {
        if (saved.space === space && saved.task === task.id) sent(saved.words);
      }),
    // `sent` reads the field through a ref and the draft as it is kept: it never goes stale.
    [space, task.id],
  );

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
        // The stub is drawn before focus goes to its end, within the click: a key pressed right
        // after lands in the field, and nothing moves focus later.
        flushSync(() => {
          setText(next);
        });
        keepDraft(space, task.id, next);
        const element = field.current;
        if (element === null) return;
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
        // Focus alone leaves a field behind the sticky top bar where it is: the field's scroll
        // margin brings it out from under the bar.
        element.scrollIntoView({ block: "nearest" });
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
  const unanswered = useUnansweredOpens(space, task.id);
  /**
   * An Open of these words in `instance` that got no answer, here, before a reload or in another
   * tab: whether it asked for a second session. Undefined when there is none.
   */
  const retried = (instance: Instance): boolean | undefined => {
    const asked = unanswered(instance.key);
    const text = words === "" ? undefined : words;
    if (asked === openAsked(false, text)) return false;
    if (asked === openAsked(true, text)) return true;
    return undefined;
  };

  /** Sends `words` as a note: kept until the service holds them, which then lets them go. */
  const note = (words: string, known?: string) => {
    if (sending.current === words) return;
    // The same words again (after a failure, a reload, or from another tab) are the same request:
    // the service saves them once. A kept note sent again goes with the ID it shows, also when
    // another tab has let its record go meanwhile.
    const id =
      known ?? readNotes(space, task.id).find((kept) => kept.words === words)?.id ?? requestId();
    if (flying.has(id)) return;
    keepNote(space, task.id, { words, id });
    sending.current = words;
    setOnItsWay(words);
    setFlying((before) => new Set(before).add(id));
    const done = () => {
      setFlying((before) => {
        const next = new Set(before);
        next.delete(id);
        return next;
      });
      if (sending.current !== words) return;
      sending.current = undefined;
      setOnItsWay(undefined);
    };
    // The note answers every question that waits: the person hears it when it was more than one.
    const answers = questionsWaiting(task);
    api.client.entry.add({ task: task.id, kind: "note", text: words, request_id: id }).then(
      () => {
        done();
        letGo(space, { kind: "note", task: task.id, id });
        sent(words, true);
        if (answers > 1) say(t("composer.noteAnswers"));
      },
      (error: unknown) => {
        done();
        if (!live.failed(error)) say(t("composer.noteFailed"));
      },
    );
  };

  const addNote = () => {
    if (words === "") {
      field.current?.focus();
      return;
    }
    note(words);
  };

  /**
   * Whether `instance`'s Open asks for a second session: as the unanswered Open of these words did,
   * which pressing again repeats, else when the button says "Open another".
   */
  const another = (instance: Instance): boolean =>
    retried(instance) ?? tileState(busy, instance.key) === "running";

  const open = (instance: Instance) => {
    if (opening.has(instance.key)) return;
    setOpening((known) => new Set(known).add(instance.key));
    const request = words;
    // The open action says when the words are on the task (savedWords): the field clears then.
    const carried = { ...(request === "" ? {} : { text: request }), another: another(instance) };
    void actions.open(task, instance, carried).then(() => {
      setOpening((known) => {
        const next = new Set(known);
        next.delete(instance.key);
        return next;
      });
    });
  };

  /** Run with `instance`: one at a time from here. */
  const run = (instance: Instance) => {
    if (starting.current !== undefined) return;
    const request = words;
    starting.current = request;
    setRunningFrom(true);
    void actions.run(task, instance, request === "" ? undefined : request).then((queued) => {
      starting.current = undefined;
      setRunningFrom(false);
      // The service holds the words in the run: they went somewhere.
      if (queued !== undefined && request !== "") sent(request);
    });
  };

  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    const request = words;
    void actions.copy(task, event.shiftKey, request === "" ? undefined : request).then((ok) => {
      if (ok && request !== "") sent(request);
    });
  };

  /**
   * Why an instance does not open now, as its tip says it; undefined when it opens. Only an Open on
   * its way holds it: a click then would return that very launch. A running session does not: the
   * button says it opens another. Nor does a launch on its way when an Open of these words got no
   * answer: pressing again is that Open, which the page asked the person to do.
   */
  const held = (instance: Instance): string | undefined =>
    opening.has(instance.key) ||
    (retried(instance) === undefined && tileState(busy, instance.key) === "opening")
      ? t("composer.opening", { label: instance.label })
      : undefined;

  const noteKeys = keysOf("note", singleKeys);
  const openKeys = keysOf("open-first", singleKeys);
  const runKeys = keysOf("run-first", singleKeys);
  const first = instances[0];
  const [runner, ...others] = runners(instances);
  const finished = task.lifecycle !== "active";
  /** Run's key on a finished task: Reopen, the step before any run. */
  const runOrReopen = (instance: Instance) => {
    if (finished) edits.reopen(task);
    else run(instance);
  };
  // A task without a folder of its own runs in the space's work folder, as Open does.
  const runTip = (instance: Instance) =>
    t(task.place === undefined ? "composer.runTipWorkFolder" : "composer.runTip", {
      label: instance.label,
      words: words === "" ? "task" : "words",
    });

  return (
    <>
      <KeptNotes
        task={task.id}
        shown={onItsWay === undefined ? [words] : [words, onItsWay]}
        flying={flying}
        send={(kept) => {
          note(kept.words, kept.id);
        }}
      />
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
            // A held key repeats: one press is one Open.
            if (event.repeat) return;
            if (first === undefined) say(t("composer.noAgent"));
            else {
              const why = held(first);
              if (why === undefined) open(first);
              else say(why);
            }
          } else if (action === "run-first") {
            event.preventDefault();
            // A held key repeats: one press is one run.
            if (event.repeat) return;
            if (runner === undefined) say(t("composer.noRunner"));
            else runOrReopen(runner);
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
          const state = tileState(busy, instance.key);
          const second = another(instance);
          const tip =
            why ??
            t(
              second
                ? "composer.anotherTip"
                : words === ""
                  ? "composer.openTip"
                  : "composer.openWithTip",
              { label: instance.label },
            );
          return (
            <button
              key={instance.key}
              type="button"
              className={styles.button}
              data-part="open"
              data-default={i === 0 ? "" : undefined}
              data-state={state}
              data-ring={instance.ring}
              aria-disabled={why !== undefined}
              aria-keyshortcuts={i === 0 ? ariaKeys(openKeys, mac) : undefined}
              aria-description={tip}
              data-tip={tip}
              onClick={(event) => {
                // A double click is one Open, even when the first one's answer came in between.
                if (event.detail > 1) return;
                if (why === undefined) open(instance);
              }}
              onKeyDown={(event) => {
                // A held Enter repeats the button's click: one press is one Open.
                if (event.key === "Enter" && event.repeat) event.preventDefault();
              }}
            >
              <span className={styles.glyph} aria-hidden="true">
                {instance.glyph}
              </span>
              {/* Both labels hold the button's width: reading that a session runs never moves
                  the buttons after it under a press. */}
              <span className={styles.label}>
                <span data-off={second || undefined}>
                  {t("row.openIn", { label: instance.label })}
                </span>
                <span data-off={!second || undefined}>
                  {t("composer.openAnother", { label: instance.label })}
                </span>
              </span>
              {i === 0 && openKeys[0] !== undefined ? (
                <kbd className={styles.hint} aria-hidden="true">
                  {keyLabel(openKeys[0])}
                </kbd>
              ) : null}
            </button>
          );
        })}
        {runner === undefined ? null : finished ? (
          <button
            type="button"
            className={styles.button}
            data-part="reopen-run"
            aria-keyshortcuts={ariaKeys(runKeys, mac)}
            aria-description={t("composer.reopenTip")}
            data-tip={t("composer.reopenTip")}
            onClick={(event) => {
              // A double click is one Reopen.
              if (event.detail > 1) return;
              edits.reopen(task);
            }}
          >
            {t("fact.reopen")}
            {runKeys[0] === undefined ? null : (
              <kbd className={styles.hint} aria-hidden="true">
                {keyLabel(runKeys[0])}
              </kbd>
            )}
          </button>
        ) : (
          <span className={styles.runs}>
            <button
              type="button"
              className={styles.button}
              data-part="run"
              data-ring={runner.ring}
              aria-disabled={runningFrom}
              aria-keyshortcuts={ariaKeys(runKeys, mac)}
              aria-description={runTip(runner)}
              data-tip={runTip(runner)}
              onClick={(event) => {
                // A double click is one Run, even when the first one's answer came in between.
                if (event.detail > 1) return;
                run(runner);
              }}
              onKeyDown={(event) => {
                // A held Enter repeats the button's click: one press is one Run.
                if (event.key === "Enter" && event.repeat) event.preventDefault();
              }}
            >
              <RunIcon />
              {t("composer.run", { label: runner.label })}
              {runKeys[0] === undefined ? null : (
                <kbd className={styles.hint} aria-hidden="true">
                  {keyLabel(runKeys[0])}
                </kbd>
              )}
            </button>
            {others.length === 0 ? null : (
              <DialogTrigger>
                <Button
                  className={`${styles.button} ${styles.others}`}
                  data-part="run-other"
                  aria-label={t("composer.runOther")}
                >
                  <ChevronDownIcon />
                </Button>
                <Popover className={styles.runMenu} placement="bottom end" offset={4}>
                  <Dialog aria-label={t("composer.runOther")}>
                    {({ close }) =>
                      others.map((instance) => (
                        <button
                          key={instance.key}
                          type="button"
                          className={styles.runItem}
                          data-ring={instance.ring}
                          onClick={() => {
                            close();
                            run(instance);
                          }}
                        >
                          <span className={styles.glyph} aria-hidden="true">
                            {instance.glyph}
                          </span>
                          {t("composer.run", { label: instance.label })}
                        </button>
                      ))
                    }
                  </Dialog>
                </Popover>
              </DialogTrigger>
            )}
          </span>
        )}
        {text.length >= LIMIT_SHOWN ? (
          <span className={styles.limit} data-part="limit" aria-live="polite">
            {t("composer.left", { left: Math.max(0, DRAFT_MAX - text.length), max: DRAFT_MAX })}
          </span>
        ) : null}
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
