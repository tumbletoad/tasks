// The Agents page's parts from the Agent Monitor (TTAM), under TTasks' own rows: "On this
// computer", every agent running here with its state, and "Plan usage", each account's limits.
// They come below the rows so that their arrival never moves what the person reads. A tab without
// TTAM shows one quiet line. While it watches, the tab tells the service, which asks TTAM at the
// tab's pace; the picture lives in memory only and is dropped when the page unmounts.
//
// Each state says what it is in words: what needs you first, then what works, then the rest in
// the order they started, so a new agent joins at the end of its group. Unknown is shown as
// unknown, never as idle.
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import type { AgentsAccount, AgentsSession, AgentsView, MonitorWindow } from "../store/agents.ts";
import css from "./Computer.module.css";

const styles = classes(css, [
  "part",
  "heading",
  "line",
  "note",
  "list",
  "item",
  "top",
  "title",
  "state",
  "meta",
  "nested",
  "inner",
  "account",
  "windows",
  "window",
  "bar",
  "fill",
  "figure",
]);

/** How often ages move on the page while it is shown. */
const TICK_MS = 15_000;

/** The order of states in "On this computer": what needs the person, then what works. */
const RANK: Readonly<Record<string, number>> = { waiting: 0, working: 1 };

/** A span of time in the page's short words: "under a minute", "5 min", "2 h 5 min", "3 d 4 h". */
export function spanOf(ms: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t("computer.spanNow");
  if (minutes < 60) return t("computer.spanMinutes", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("computer.spanHours", { hours, minutes: minutes % 60 });
  return t("computer.spanDays", { days: Math.floor(hours / 24), hours: hours % 24 });
}

/** The sessions in the order the page shows them. */
export function sessionOrder(sessions: readonly AgentsSession[]): AgentsSession[] {
  return [...sessions].sort(
    (a, b) =>
      (RANK[a.activity] ?? 2) - (RANK[b.activity] ?? 2) ||
      (b.ageMs ?? -1) - (a.ageMs ?? -1) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** The folder's last part: what names a project. */
const folderName = (folder: string): string =>
  folder
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? folder;

/** Ages move on while the page is shown, once every TICK_MS. */
function useNow(): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(performance.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/** The sentence of a view's trouble, and of a picture that does not update. */
function troubleLine(view: AgentsView, t: Translate, since: number): string | undefined {
  const trouble = view.trouble;
  if (trouble === null) return undefined;
  if (trouble.kind === "not_installed") {
    return t("computer.notInstalled", { why: trouble.reason });
  }
  if (trouble.kind === "does_not_fit") return t("computer.doesNotFit", { update: trouble.update });
  return t("computer.trouble", {
    kind: trouble.kind,
    stale: view.picture === null ? "no" : "yes",
    age: spanOf(since, t),
  });
}

function App({ app, name }: { readonly app: string; readonly name: string }) {
  const t = useT();
  return <span>{t("computer.app", { app, name })}</span>;
}

function SessionItem({
  session,
  since,
}: {
  readonly session: AgentsSession;
  readonly since: number;
}) {
  const t = useT();
  const age = session.ageMs === null ? undefined : spanOf(session.ageMs + since, t);
  return (
    <li className={styles.item} data-part="session" data-state={session.activity}>
      <div className={styles.top}>
        <span className={styles.title}>{session.title}</span>
        <span className={styles.state} data-state={session.activity}>
          {t("computer.state", { state: session.activity })}
        </span>
      </div>
      <div className={styles.meta}>
        <App app={session.app} name={session.appName} />
        <span>{session.account}</span>
        {session.folder === null ? null : (
          <span title={session.folder}>{folderName(session.folder)}</span>
        )}
        {age === undefined ? null : <span>{t("computer.started", { age })}</span>}
      </div>
      {session.nested.length === 0 ? null : (
        <ul
          className={styles.nested}
          aria-label={t("computer.nested", { count: session.nested.length })}
        >
          {session.nested.map((inner) => (
            <li key={inner.key} className={styles.inner} data-part="nested">
              <span className={styles.title}>{inner.title}</span>
              <span className={styles.meta}>
                <span>{t("computer.kind", { kind: inner.kind })}</span>
                <span className={styles.state} data-state={inner.activity}>
                  {t("computer.state", { state: inner.activity })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function WindowLine({
  window: w,
  since,
}: {
  readonly window: MonitorWindow;
  readonly since: number;
}) {
  const t = useT();
  const percent = Math.round(Math.min(100, Math.max(0, w.usedPercent)));
  const resets = w.resetsInMs === null ? undefined : w.resetsInMs - since;
  return (
    <li className={styles.window} data-part="window" data-limited={w.limited || undefined}>
      <span className={styles.meta}>
        <span>{t("computer.window", { kind: w.kind })}</span>
        {w.scope === null ? null : <span>{w.scope}</span>}
        {w.label === null ? null : <span>{w.label}</span>}
      </span>
      <span className={styles.bar} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${String(percent)}%` }} />
      </span>
      <span className={styles.figure}>
        <span>{t("computer.used", { percent })}</span>
        {w.limited ? <span>{t("computer.limited")}</span> : null}
        {resets === undefined ? null : (
          <span>
            {resets < 0
              ? t("computer.resetEarlier")
              : t("computer.resets", { age: spanOf(resets, t) })}
          </span>
        )}
      </span>
    </li>
  );
}

function AccountItem({
  account,
  since,
}: {
  readonly account: AgentsAccount;
  readonly since: number;
}) {
  const t = useT();
  const notes = [
    account.refreshing ? t("computer.refreshing") : undefined,
    account.failed ? t("computer.checkFailed") : undefined,
    account.unavailable
      ? t("computer.unavailable")
      : account.readingAgeMs === null
        ? t("computer.noReading")
        : t("computer.read", { age: spanOf(account.readingAgeMs + since, t) }),
  ].filter((note) => note !== undefined);
  return (
    <li className={styles.item} data-part="account" data-limited={account.limited || undefined}>
      <div className={styles.top}>
        <span className={`${styles.title} ${styles.account}`}>
          <App app={account.app} name={account.appName} />
          <span>{account.account}</span>
          {account.plan === null ? null : <span>{account.plan}</span>}
        </span>
        {account.limited ? <span className={styles.state}>{t("computer.limited")}</span> : null}
      </div>
      <div className={styles.meta}>
        {notes.map((note) => (
          <span key={note}>{note}</span>
        ))}
      </div>
      {account.windows.length === 0 ? null : (
        <ul className={styles.windows}>
          {account.windows.map((w, i) => (
            <WindowLine key={`${w.kind}:${w.scope ?? ""}:${String(i)}`} window={w} since={since} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The parts from TTAM, for the tab's Agents page. */
export function Computer() {
  const t = useT();
  const { live } = useContext(Session);
  useEffect(() => live.watchAgents(), [live]);
  const { view, at } = useSyncExternalStore(live.agents.subscribe, live.agents.getState);
  const now = useNow();
  if (view === undefined) return null;
  const picture = view.picture;
  // How much older the picture is now than when the service sent it.
  const since = Math.max(0, Math.max(now, at) - at) + (picture?.ageMs ?? 0);
  const trouble = troubleLine(view, t, since);
  // Without TTAM, or with one that does not fit: one quiet line, and no part.
  if (picture === null && trouble !== undefined && view.trouble?.kind !== "failed") {
    return (
      <p className={styles.note} data-part="monitor-note">
        {trouble}
      </p>
    );
  }
  const status =
    trouble ??
    (picture === null
      ? t("computer.looking")
      : picture.settling
        ? t("computer.settling")
        : picture.sessions.length === 0
          ? t("computer.empty")
          : undefined);
  return (
    <>
      <section className={styles.part} aria-labelledby="computer-heading" data-part="computer">
        <h2 className={styles.heading} id="computer-heading">
          {t("computer.heading")}
        </h2>
        <p className={styles.line} role="status" data-part="monitor-status">
          {status ?? ""}
        </p>
        {picture === null || picture.sessions.length === 0 ? null : (
          <ul className={styles.list}>
            {sessionOrder(picture.sessions).map((session) => (
              <SessionItem key={session.key} session={session} since={since} />
            ))}
          </ul>
        )}
      </section>
      {picture === null || picture.accounts.length === 0 ? null : (
        <section className={styles.part} aria-labelledby="usage-heading" data-part="usage">
          <h2 className={styles.heading} id="usage-heading">
            {t("computer.usage")}
          </h2>
          <ul className={styles.list}>
            {picture.accounts.map((account) => (
              <AccountItem key={account.key} account={account} since={since} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
