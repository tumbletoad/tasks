// The expanded row's thread (A5 3.7, 3.9; the skeleton's, M2.13, until M5.06 builds the expanded task): the task's log entries and its launch receipts, oldest
// first, so it reads like a conversation. The log comes from `task.get` (sections: log) and is
// fetched again whenever the feed says the task changed; receipts come from the row's launch list,
// which the feed's launch events refresh. All text is plain text: React escapes it, and nothing is
// read as markup (A5 3.26). Markdown rendering arrives with the expanded task (M5.06).
import { useContext, useEffect, useState } from "react";
import type { Instance, Receipt } from "../api.ts";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { Latest } from "../latest.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import css from "./Expanded.module.css";

const styles = classes(css, ["line", "thread", "entry", "mark", "head", "who", "when", "text"]);

interface LogEntry {
  readonly ref: string;
  readonly author: string;
  readonly at: string;
  readonly text: string;
}

interface Item {
  readonly key: string;
  readonly at: number;
  readonly mark: string;
  readonly who: string;
  readonly text: string;
  readonly state?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The log of a `task.get` sections result, checked by its shape. */
function logOf(result: unknown): LogEntry[] {
  if (!isRecord(result) || !isRecord(result["sections"])) return [];
  const log = result["sections"]["log"];
  if (!Array.isArray(log)) return [];
  return log.filter(
    (e): e is LogEntry =>
      isRecord(e) &&
      typeof e["ref"] === "string" &&
      typeof e["author"] === "string" &&
      typeof e["at"] === "string" &&
      // An instant the page cannot read is no entry: it would have no time to show or sort by.
      Number.isFinite(Date.parse(e["at"])) &&
      typeof e["text"] === "string",
  );
}

/** An actor as the thread names it: "You" for the person, the agent's label otherwise. */
function actorOf(author: string, t: Translate): { who: string; mark: string } {
  if (author === "user") {
    const you = t("thread.you");
    return { who: you, mark: you.slice(0, 1) };
  }
  // An agent that has not said who it is (an unbound CLI call) is just "Agent".
  const named = author.replace(/^agent:/, "");
  const who = named === "" || named === "unknown" ? t("thread.agent") : named;
  const words = who.split(/[-_ :]+/).filter((w) => w !== "");
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

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function when(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? clock.format(date) : day.format(date);
}

export interface ThreadProps {
  readonly task: string;
  readonly receipts: readonly Receipt[];
  readonly instances: readonly Instance[];
}

export function Thread({ task, receipts, instances }: ThreadProps) {
  const t = useT();
  const { api, live } = useContext(Session);
  const [log, setLog] = useState<LogEntry[] | "failed" | undefined>(undefined);

  useEffect(() => {
    let current = true;
    // Only the newest read applies: an older one that answers late never replaces a newer log.
    const reads = new Latest();
    const load = () => {
      const newest = reads.begin(task);
      api.client.task
        .get({ task, sections: ["log"], log_limit: 20 })
        .then((result) => {
          if (current && newest()) setLog(logOf(result));
        })
        .catch((error: unknown) => {
          if (current && newest() && !live.failed(error)) setLog("failed");
        });
    };
    load();
    const stop = live.onTouched((touched) => {
      if (touched.tasks.has(task)) load();
    });
    return () => {
      current = false;
      stop();
    };
  }, [api, live, task]);

  const items: Item[] = [];
  for (const entry of Array.isArray(log) ? log : []) {
    const { who, mark } = actorOf(entry.author, t);
    items.push({ key: entry.ref, at: Date.parse(entry.at), who, mark, text: entry.text });
  }
  for (const receipt of receipts) {
    const instance = instances.find((i) => i.key === receipt.instance);
    const label =
      instance?.label ?? (receipt.route === "clipboard" ? t("row.copy") : receipt.instance);
    const text = receiptText(receipt, label, t);
    if (text === undefined) continue;
    items.push({
      key: receipt.id,
      at: receipt.at.prepared ?? 0,
      who: label,
      mark: instance?.glyph ?? "",
      text,
      state: receipt.state,
    });
  }
  items.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));

  if (log === undefined && items.length === 0) return null;
  if (log === "failed" && items.length === 0) {
    return <p className={styles.line}>{t("thread.failed")}</p>;
  }
  if (items.length === 0) return <p className={styles.line}>{t("thread.empty")}</p>;
  return (
    <ol className={styles.thread} aria-live="polite">
      {items.map((item) => (
        <li key={item.key} className={styles.entry} data-entry="" data-state={item.state}>
          <span className={styles.mark} aria-hidden="true">
            {item.mark}
          </span>
          <div>
            <div className={styles.head}>
              <span className={styles.who}>{item.who}</span>
              <time className={styles.when} dateTime={new Date(item.at).toISOString()}>
                {when(item.at)}
              </time>
            </div>
            <p className={styles.text} data-part="entry-text" dir="auto">
              {item.text}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
