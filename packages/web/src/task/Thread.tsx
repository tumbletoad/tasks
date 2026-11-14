// The expanded task's thread (A5 3.7 item 5, 3.9): notes, log entries and sessions, oldest first,
// so it reads like a conversation that ends at the composer. Notes and log entries come from the
// detail (detail.ts); sessions are the task's launch receipts, which the feed's launch events
// refresh. The last six entries show, and "Earlier" reveals the rest. Each entry: the actor's mark
// (the person's initial, an agent's initials, an instance's monogram), the actor, the mode, the
// time, then the text, as Markdown that is never HTML (markdown.tsx). Copy on a log entry shows on
// hover and on focus. Runs join with M6, and grouped field changes and their Revert with M5.09.
import { useState } from "react";
import type { Instance, Receipt } from "../api.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useT, type MessageId, type Translate } from "../i18n/intl.tsx";
import type { DetailLog, DetailNote } from "./detail.ts";
import css from "./Expanded.module.css";
import { Markdown } from "./markdown.tsx";

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

/** A4's receipt text for a state (A5 3.9). Prepared shows nothing yet. */
export function receiptText(receipt: Receipt, label: string, t: Translate): string | undefined {
  switch (receipt.state) {
    case "prepared":
      return undefined;
    case "dispatching":
      return t("receipt.dispatching", { label });
    case "dispatched":
      return t(
        receipt.route === "clipboard"
          ? "receipt.copied"
          : receipt.route === "link"
            ? "receipt.dispatchedLink"
            : "receipt.dispatchedTerminal",
      );
    case "confirmed":
      return t("receipt.confirmed", { label });
    case "failed":
      return t("receipt.failed", { reason: (receipt.reason ?? "failed").replaceAll("_", " ") });
    case "unknown":
      return t("receipt.unknown");
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
  readonly kind: "note" | "log" | "session";
  readonly state?: string;
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function when(ms: number, today: string): string {
  const date = new Date(ms);
  return date.toDateString() === today ? clock.format(date) : day.format(date);
}

export interface ThreadProps {
  readonly notes: readonly DetailNote[];
  readonly log: readonly DetailLog[];
  readonly receipts: readonly Receipt[];
  readonly instances: readonly Instance[];
  /** The pages ran out before the oldest entries. */
  readonly partial: boolean;
}

export function Thread({ notes, log, receipts, instances, partial }: ThreadProps) {
  const t = useT();
  const say = useToast();
  const [all, setAll] = useState(false);
  /** The entry that holds focus: it stays shown while it does, however many entries arrive. */
  const [focused, setFocused] = useState<string | undefined>(undefined);

  const items: Item[] = [];
  for (const note of notes) {
    const { who, mark } = actorOf(note.author, t);
    items.push({
      key: `n:${note.ref}`,
      at: Date.parse(note.at),
      who,
      mark,
      ...(note.forAgents ? { mode: t("thread.toAgents") } : {}),
      text: note.text,
      markdown: true,
      kind: "note",
    });
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
    if (text === undefined) continue;
    items.push({
      key: `r:${receipt.id}`,
      at: receipt.at.prepared ?? 0,
      who: label,
      mark: instance?.glyph ?? label.slice(0, 2),
      ...(instance === undefined ? {} : { ring: instance.ring }),
      mode: t("thread.session"),
      text,
      markdown: false,
      kind: "session",
      state: receipt.state,
    });
  }
  // An instant the page cannot read sorts first rather than vanish.
  items.sort(
    (a, b) =>
      (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0) ||
      (a.key < b.key ? -1 : 1),
  );

  if (items.length === 0) return <p className={styles.line}>{t("thread.empty")}</p>;
  // Nothing moves under focus (A5 3.15): an entry that holds focus is not pushed out of the last
  // six by an entry that arrives; the window grows to keep it until focus leaves it.
  const held = focused === undefined ? -1 : items.findIndex((item) => item.key === focused);
  const hidden = all
    ? 0
    : Math.max(0, Math.min(items.length - SHOWN_ENTRIES, held < 0 ? Infinity : held));
  const shown = items.slice(hidden);
  const today = new Date().toDateString();
  return (
    <>
      {hidden > 0 || partial ? (
        <button
          type="button"
          className={styles.earlier}
          data-part="earlier"
          disabled={hidden === 0}
          onClick={() => {
            setAll(true);
          }}
        >
          {hidden > 0 ? t("thread.earlier", { count: hidden }) : t("thread.partial")}
        </button>
      ) : null}
      {/* New entries are announced politely; the ones there when it opens are not. */}
      <ol
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
                    {when(item.at, today)}
                  </time>
                ) : null}
              </div>
              {item.markdown ? (
                <div data-part="entry-text">
                  <Markdown text={item.text} className={styles.text} />
                </div>
              ) : (
                <p className={`${styles.text} ${styles.state}`} data-part="entry-text" dir="auto">
                  {item.text}
                </p>
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
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
