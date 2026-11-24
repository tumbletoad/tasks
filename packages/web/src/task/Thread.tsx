// The expanded task's thread (A5 3.7 item 5, 3.9): notes, log entries, sessions and background
// runs, oldest first, as a conversation reads. Notes and log
// entries come from the detail (detail.ts); sessions are the task's launch receipts and runs are
// its run records, which the feed's launch and run events refresh. The last six entries show,
// "Earlier" reveals the rest the page holds, and "Older entries" reads further back for as long as
// there is more; the entry that was the oldest shown stays where it was on the screen. Each entry: the actor's mark (the person's initial, an agent's
// initials, an instance's monogram), the actor, the mode, the time, then the text, as Markdown
// that is never HTML (markdown.tsx). A run shows what was asked, its state in plain words with
// Stop while it may still work, and the agent's answer or question (RunBody). A session shows what
// was asked the same way (the note its launch names) above its state, and a launch that did not
// open offers to open again with it, or says that the person took the request back. Copy on a log
// entry and Remove on a note or a session's request show on hover and on focus, and always without
// hover; Remove takes the note back, and the card's removed line puts it back. Grouped field
// changes and their Revert join with M5.09.
import { useLayoutEffect, useRef, useState } from "react";
import { localDate } from "@ttasks/contracts/day";
import type { Instance, Receipt, Run } from "../api.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useT, type MessageId, type Translate } from "../i18n/intl.tsx";
import { formatInstant, type Clock } from "../row/dates.ts";
import { useClock } from "../row/useClock.ts";
import type { DetailLog, DetailNote } from "./detail.ts";
import css from "./Expanded.module.css";
import { Markdown } from "./markdown.tsx";
import { Asked, RunBody } from "./RunBody.tsx";
import { runLabel } from "./runs.ts";

const styles = classes(css, [
  "line",
  "thread",
  "earlier",
  "entry",
  "mark",
  "meta",
  "who",
  "when",
  "text",
  "state",
  "acts",
  "act",
  "again",
]);

/** The entries shown before "Earlier" (A5 3.7). */
export const SHOWN_ENTRIES = 6;

/** An actor as the thread names it: "You" for the person, the agent's label otherwise. */
export function actorOf(author: string, t: Translate): { who: string; mark: string } {
  if (author === "user") {
    const you = t("thread.you");
    return { who: you, mark: you.slice(0, 1) };
  }
  if (author === "import") {
    const imported = t("thread.import");
    return { who: imported, mark: imported.slice(0, 1) };
  }
  // An agent that has not said who it is (an unbound CLI call) is just "Agent".
  const named = author.replace(/^agent:/, "");
  const who = named === "" || named === "unknown" ? t("thread.agent") : named;
  const words = who.split(/[-_ :·]+/).filter((w) => w !== "");
  const mark = words
    .slice(0, 2)
    .map((w) => w.slice(0, 1).toUpperCase())
    .join("");
  return { who, mark: mark === "" ? "?" : mark };
}

/**
 * How a launch's entry looks: the receipt's state, except that a session that opened is shown as
 * what the service knows of it now. Only `running` carries the live mark.
 */
export function entryState(receipt: Receipt): string {
  if (receipt.state === "confirmed") return receipt.session ?? "opened";
  return receipt.state;
}

/** How long a session ran, in the thread's short words: "40 s", "2 min", "1 h 5 min". */
export function ranFor(ms: number, t: Translate): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("receipt.seconds", { count: Math.max(1, Math.round(ms / 1000)) });
  if (minutes < 60) return t("receipt.minutes", { count: minutes });
  return t("receipt.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * A launch's entry in the thread (A5 3.9): a record of what happened. Prepared shows nothing yet.
 * A terminal launch names the terminal and why it was chosen once one was Dispatched. A session
 * that opened says so, and then whether it runs or ended as far as the service knows; where it
 * cannot know, it says only that it opened.
 */
export function receiptText(receipt: Receipt, label: string, t: Translate): string | undefined {
  // ICU select keys cannot hold `-`: the adapter's name goes in with `_`.
  const where =
    receipt.terminal === undefined
      ? undefined
      : t("receipt.terminal", {
          terminal: receipt.terminal.app.replaceAll("-", "_"),
          source: receipt.terminal.source,
        });
  const opened = t("receipt.opened", { where: where ?? label });
  switch (receipt.state) {
    case "prepared":
      return undefined;
    case "dispatching":
      return t("receipt.dispatching", { label });
    case "dispatched":
      if (receipt.route === "terminal" && where !== undefined) {
        return t("receipt.dispatchedIn", { where });
      }
      if (receipt.route === "terminal") return t("receipt.dispatchedTerminal");
      // A link or T3 only asked the app: it says so until the agent connects.
      return t(receipt.route === "clipboard" ? "receipt.copied" : "receipt.asked", { label });
    case "confirmed":
      if (receipt.session === "running") return t("receipt.running", { opened });
      if (receipt.session === "restored") return t("receipt.restored", { opened });
      if (receipt.session === "ended") {
        return receipt.ran_ms === undefined
          ? t("receipt.ended", { opened })
          : t("receipt.endedAfter", { opened, ran: ranFor(receipt.ran_ms, t) });
      }
      return opened;
    case "failed":
      if (receipt.reason === "restored") return t("receipt.restoredOpening");
      return t("receipt.failed", {
        reason: receipt.reason ?? "failed",
        words: (receipt.reason ?? "failed").replaceAll("_", " "),
      });
    case "unknown":
      return t("receipt.unknown");
    case "recorded":
      return receipt.at.confirmed === undefined
        ? t("receipt.recordedOpening", { label })
        : t("receipt.recorded", { opened });
  }
}

/** The word a log entry's kind adds after its actor; progress, the usual kind, adds none. */
const LOG_MODE: Readonly<Record<string, MessageId>> = {
  evidence: "log.evidence",
  blocker: "log.blocker",
  decision: "log.decision",
  question: "log.question",
  handoff: "log.handoff",
};

interface Item {
  readonly key: string;
  readonly at: number;
  readonly mark: string;
  readonly ring?: number;
  readonly who: string;
  readonly mode?: string;
  readonly text: string;
  /** Plain text (a receipt's words), or the Markdown of a note or a log entry. */
  readonly markdown: boolean;
  readonly kind: "note" | "log" | "session" | "run";
  readonly state?: string;
  /** What the person asked the session's agent: the note its launch names. */
  readonly asked?: DetailNote;
  /** The session's request was taken back: no agent reads it from now on. */
  readonly askedRemoved?: boolean;
  /** The note a note's entry shows: the one Remove takes back. */
  readonly note?: DetailNote;
  /** Open the session's instance again with what was asked. */
  readonly again?: () => void;
  /** A run's entry: its record, drawn by RunBody in place of the text. */
  readonly run?: Run;
}

/** "14:02" today, "12 Nov" another day. */
function when(ms: number, clock: Clock): string {
  return localDate(ms, clock.timeZone) === clock.today
    ? formatInstant(ms, clock, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : formatInstant(ms, clock, { day: "numeric", month: "short" });
}

export interface ThreadProps {
  readonly notes: readonly DetailNote[];
  readonly log: readonly DetailLog[];
  readonly receipts: readonly Receipt[];
  /** The task's background runs, oldest first. */
  readonly runs?: readonly Run[];
  readonly instances: readonly Instance[];
  /** The pages ran out before the oldest entries. */
  readonly partial: boolean;
  /** Reads the entries before the oldest the thread holds. */
  readonly onOlder?: (() => void) | undefined;
  /** Older entries were asked for and have not come yet. */
  readonly loadingOlder?: boolean;
  /** The last read of older entries failed. */
  readonly olderFailed?: boolean;
  /** Open an instance again with a request already on the task (its note). */
  readonly onOpenAgain?: (note: DetailNote, instance: Instance) => void;
  /** The notes taken back: a session whose request is one of them says so. */
  readonly removed?: readonly DetailNote[];
  /** The person's Remove of a note: none in a card that only reads. */
  readonly onRemove?: ((note: DetailNote) => void) | undefined;
  /** The last read of the runs failed: what shows of them may be out of date. */
  readonly runsFailed?: boolean;
  /** The person's Stop of a run. */
  readonly onStop?: (run: Run) => void;
}

export function Thread({
  notes,
  log,
  receipts,
  runs = [],
  instances,
  partial,
  onOlder,
  loadingOlder = false,
  olderFailed = false,
  onOpenAgain,
  removed = [],
  onRemove,
  runsFailed = false,
  onStop,
}: ThreadProps) {
  const t = useT();
  const say = useToast();
  const [all, setAll] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  /** The entry that was the oldest shown when the person asked for earlier ones, and where it was. */
  const anchor = useRef<{ key: string; top: number } | undefined>(undefined);
  /** The entry that holds focus: it stays shown while it does, however many entries arrive. */
  const [focused, setFocused] = useState<string | undefined>(undefined);

  const items: Item[] = [];
  // A request shows in its sessions' entries; one whose sessions are not listed shows on its own.
  // A receipt names its note from the click on; a note names its launches once it is read again.
  const byRef = new Map(notes.map((note) => [note.ref, note]));
  const byLaunch = new Map<string, DetailNote>();
  for (const note of notes) {
    for (const launch of note.requestFor ?? []) byLaunch.set(launch.launch, note);
  }
  const askedOf = (receipt: Receipt): DetailNote | undefined =>
    (receipt.request === undefined ? undefined : byRef.get(receipt.request)) ??
    byLaunch.get(receipt.reference);
  const inSessions = new Set(receipts.flatMap((receipt) => askedOf(receipt)?.ref ?? []));
  const labelOf = (key: string) => instances.find((i) => i.key === key)?.label ?? key;
  for (const note of notes) {
    const launches = note.requestFor ?? [];
    if (inSessions.has(note.ref)) continue;
    const { who, mark } = actorOf(note.author, t);
    const last = launches.at(-1);
    items.push({
      key: `n:${note.ref}`,
      at: Date.parse(note.at),
      who,
      mark,
      ...(last !== undefined
        ? { mode: t("thread.askedTo", { label: labelOf(last.instance) }) }
        : note.forAgents
          ? { mode: t("thread.toAgents") }
          : {}),
      text: note.text,
      markdown: true,
      kind: "note",
      note,
    });
  }
  const taken = new Set(removed.map((note) => note.ref));
  // Open again is offered on the newest launch of a request, when it did not open.
  const newest = new Map<string, Receipt>();
  for (const receipt of receipts) {
    const note = askedOf(receipt);
    const known = note === undefined ? undefined : newest.get(note.ref);
    if (
      note !== undefined &&
      (known === undefined || (receipt.at.prepared ?? 0) >= (known.at.prepared ?? 0))
    ) {
      newest.set(note.ref, receipt);
    }
  }
  for (const entry of log) {
    const { who, mark } = actorOf(entry.author, t);
    const mode = LOG_MODE[entry.logKind];
    items.push({
      key: `l:${entry.ref}`,
      at: Date.parse(entry.at),
      who,
      mark,
      ...(mode === undefined ? {} : { mode: t(mode) }),
      text: entry.text,
      markdown: true,
      kind: "log",
    });
  }
  for (const receipt of receipts) {
    const instance = instances.find((i) => i.key === receipt.instance);
    const label =
      instance?.label ?? (receipt.route === "clipboard" ? t("row.copy") : receipt.instance);
    const text = receiptText(receipt, label, t);
    const asked = askedOf(receipt);
    const askedRemoved =
      asked === undefined && receipt.request !== undefined && taken.has(receipt.request);
    if (text === undefined && asked === undefined && !askedRemoved) continue;
    const again =
      asked !== undefined &&
      instance !== undefined &&
      onOpenAgain !== undefined &&
      receipt.state === "failed" &&
      newest.get(asked.ref) === receipt
        ? () => {
            onOpenAgain(asked, instance);
          }
        : undefined;
    items.push({
      key: `r:${receipt.id}`,
      at: receipt.at.prepared ?? 0,
      who: label,
      mark: instance?.glyph ?? label.slice(0, 2),
      ...(instance === undefined ? {} : { ring: instance.ring }),
      mode: t("thread.session"),
      text: text ?? "",
      markdown: false,
      kind: "session",
      state: entryState(receipt),
      ...(asked === undefined ? {} : { asked, note: asked }),
      ...(askedRemoved ? { askedRemoved } : {}),
      ...(again === undefined ? {} : { again }),
    });
  }
  for (const run of runs) {
    const instance = instances.find((i) => i.key === run.instance);
    const label = runLabel(run, instances);
    items.push({
      key: `u:${run.id}`,
      at: run.queued_at,
      who: label,
      mark: instance?.glyph ?? label.slice(0, 2),
      ...(instance === undefined ? {} : { ring: instance.ring }),
      mode: t("thread.run"),
      text: "",
      markdown: false,
      kind: "run",
      state: run.state,
      run,
    });
  }
  // An instant the page cannot read sorts first rather than vanish.
  items.sort(
    (a, b) =>
      (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0) ||
      (a.key < b.key ? -1 : 1),
  );

  // Nothing moves under focus (A5 3.15): an entry that holds focus is not pushed out of the last
  // six by an entry that arrives; the window grows to keep it until focus leaves it.
  const held = focused === undefined ? -1 : items.findIndex((item) => item.key === focused);
  const hidden = all
    ? 0
    : Math.max(0, Math.min(items.length - SHOWN_ENTRIES, held < 0 ? Infinity : held));
  const shown = items.slice(hidden);
  const clock = useClock(false);
  const first = shown[0]?.key;
  /** Earlier entries go above the one shown first: it is kept where the person sees it. */
  const keepPlace = () => {
    const entry = first === undefined ? null : entryOf(list.current, first);
    if (first !== undefined && entry !== null) {
      anchor.current = { key: first, top: entry.getBoundingClientRect().top };
    }
  };
  useLayoutEffect(() => {
    const kept = anchor.current;
    if (kept === undefined || kept.key === first) return;
    anchor.current = undefined;
    const entry = entryOf(list.current, kept.key);
    if (entry === null) return;
    window.scrollBy(0, entry.getBoundingClientRect().top - kept.top);
    // The button went with the last of them: the place stays with the entry.
    if (document.activeElement === document.body) entry.focus({ preventScroll: true });
  });
  const older = hidden === 0 && partial && onOlder !== undefined;
  // A thread whose first pages held no entry has older ones: it is not empty. Nor is one whose runs
  // could not be read: it may have some.
  const failedRuns = (
    <p className={styles.line} role="status" data-part="runs-failed">
      {t("thread.runsFailed")}
    </p>
  );
  if (items.length === 0 && !older) {
    return runsFailed ? failedRuns : <p className={styles.line}>{t("thread.empty")}</p>;
  }
  return (
    <>
      {runsFailed ? failedRuns : null}
      {older && olderFailed ? (
        <p className={styles.line} role="status">
          {t("thread.olderFailed")}
        </p>
      ) : null}
      {hidden > 0 || older ? (
        <button
          type="button"
          className={styles.earlier}
          data-part="earlier"
          aria-busy={older && loadingOlder}
          onClick={() => {
            keepPlace();
            if (hidden > 0) setAll(true);
            else if (!loadingOlder) onOlder?.();
          }}
        >
          {hidden > 0
            ? t("thread.earlier", { count: hidden })
            : loadingOlder
              ? t("thread.loadingOlder")
              : t("thread.older")}
        </button>
      ) : null}
      {/* New entries are announced politely; the ones there when it opens are not. */}
      <ol
        ref={list}
        className={styles.thread}
        aria-label={t("thread.label")}
        aria-live="polite"
        aria-relevant="additions"
        onFocus={(event) => {
          const key = (event.target as HTMLElement).closest<HTMLElement>("[data-entry-key]")
            ?.dataset["entryKey"];
          setFocused(key);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next === null || !event.currentTarget.contains(next)) setFocused(undefined);
        }}
      >
        {shown.map((item) => (
          <li
            key={item.key}
            data-entry-key={item.key}
            tabIndex={-1}
            className={styles.entry}
            data-entry={item.kind}
            data-state={item.state}
            data-ring={item.ring}
          >
            <span className={styles.mark} aria-hidden="true">
              {item.mark}
            </span>
            <div>
              <div className={styles.meta}>
                <span className={styles.who} dir="auto">
                  {item.who}
                </span>
                {item.mode === undefined ? null : <span>{item.mode}</span>}
                {Number.isFinite(item.at) && item.at > 0 ? (
                  <time className={styles.when} dateTime={new Date(item.at).toISOString()}>
                    {when(item.at, clock)}
                  </time>
                ) : null}
              </div>
              {item.asked === undefined ? null : <Asked words={item.asked.text} part="asked" />}
              {item.askedRemoved === true ? (
                <p className={`${styles.text} ${styles.state}`} data-part="asked-removed">
                  {t("thread.requestRemoved")}
                </p>
              ) : null}
              {item.run !== undefined ? (
                <RunBody
                  run={item.run}
                  label={item.who}
                  {...(onStop === undefined ? {} : { onStop })}
                />
              ) : item.markdown ? (
                <div data-part="entry-text">
                  <Markdown text={item.text} className={styles.text} />
                </div>
              ) : item.text === "" ? null : (
                <p className={`${styles.text} ${styles.state}`} data-part="entry-text" dir="auto">
                  {item.text}
                </p>
              )}
              {item.again === undefined ? null : (
                <button
                  type="button"
                  className={styles.again}
                  data-part="open-again"
                  aria-label={t("thread.openAgainLabel", { label: item.who })}
                  onClick={item.again}
                >
                  {t("thread.openAgain")}
                </button>
              )}
            </div>
            <span className={styles.acts}>
              {item.kind === "log" ? (
                <button
                  type="button"
                  className={styles.act}
                  aria-label={t("thread.copyEntry", { who: item.who })}
                  data-tip={t("thread.copy")}
                  onClick={() => {
                    navigator.clipboard.writeText(item.text).then(
                      () => {
                        say(t("row.copied"));
                      },
                      () => {
                        say(t("row.copyFailed"));
                      },
                    );
                  }}
                >
                  {t("thread.copy")}
                </button>
              ) : null}
              {item.note === undefined || onRemove === undefined ? null : (
                <button
                  type="button"
                  className={styles.act}
                  data-part="remove-note"
                  aria-label={t(
                    item.kind === "session"
                      ? "thread.removeRequest"
                      : item.note.author === "user"
                        ? "thread.removeMine"
                        : "thread.removeNote",
                    { who: item.who },
                  )}
                  onClick={() => {
                    if (item.note !== undefined) onRemove(item.note);
                  }}
                >
                  {t("thread.remove")}
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function entryOf(list: HTMLOListElement | null, key: string): HTMLElement | null {
  return list?.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(key)}"]`) ?? null;
}
