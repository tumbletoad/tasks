// The Agents page's parts from the Agent Monitor (TTAM), under TTasks' own rows: "On this
// computer", every agent running here with its state that the rows above do not show already,
// each with a link to the task TTasks started it for when it has one (in this space or another),
// and "Plan usage", each account's limits.
// They come below the rows so that their arrival never moves what the person reads. A tab without
// TTAM shows one quiet line. While it watches, the tab tells the service, which asks TTAM at the
// tab's pace; the picture lives in memory only and is dropped when the page unmounts.
//
// Each state says what it is in words: what needs you first, then what works, then the rest in
// the order they started, so a new agent joins at the end of its group. Unknown is shown as
// unknown, never as idle.
import { Link } from "@tanstack/react-router";
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import type {
  AgentsAccount,
  AgentsSession,
  AgentsTask,
  AgentsView,
  MonitorWindow,
} from "../store/agents.ts";
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

const partsOf = (folder: string): string[] =>
  folder
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter((part) => part !== "");

/**
 * Each folder by as few of its last parts as tell it apart from the others: its own name, which
 * names a project, and more of its path only where two folders share that name.
 */
export function folderLabels(folders: readonly string[]): Map<string, string> {
  const unique = [...new Set(folders)];
  const parts = new Map(unique.map((f) => [f, partsOf(f)]));
  const labelOf = (folder: string, n: number): string =>
    (parts.get(folder) ?? []).slice(-n).join("/") || folder;
  const out = new Map<string, string>();
  for (const folder of unique) {
    const own = parts.get(folder)?.length ?? 1;
    let n = 1;
    while (
      n < own &&
      unique.some((other) => other !== folder && labelOf(other, n) === labelOf(folder, n))
    ) {
      n += 1;
    }
    out.set(folder, labelOf(folder, n));
  }
  return out;
}

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

/** Without TTAM, or with one that does not fit: the one quiet line that stands for the parts. */
function noteOf(view: AgentsView, t: Translate): string | undefined {
  const trouble = view.trouble;
  if (view.picture !== null || trouble === null) return undefined;
  if (trouble.kind === "not_installed") {
    return t("computer.notInstalled", { why: trouble.reason });
  }
  if (trouble.kind === "does_not_fit") return t("computer.doesNotFit", { side: trouble.monitor });
  return undefined;
}

/**
 * The line of "On this computer". A view that is not current says why when the monitor is the
 * cause (the page's own bar says it for the feed) and how old the picture is; a current one says
 * what TTAM is doing, or nothing.
 */
function statusOf(view: AgentsView, current: boolean, t: Translate, since: number): string {
  const { picture, trouble } = view;
  if (!current) {
    const cause =
      trouble?.kind === "slow" || trouble?.kind === "failed"
        ? t("computer.trouble", { kind: trouble.kind })
        : undefined;
    const old =
      picture === null
        ? cause === undefined
          ? t("computer.paused")
          : undefined
        : t("computer.old", { age: spanOf(since, t) });
    return [cause, old].filter((line) => line !== undefined).join(" ");
  }
  if (picture === null) return t("computer.looking");
  if (picture.settling) return t("computer.settling");
  if (picture.sessions.length === 0) return t("computer.empty");
  return "";
}

function App({ app, name }: { readonly app: string; readonly name: string }) {
  const t = useT();
  return <span>{t("computer.app", { app, name })}</span>;
}

/** The task TTasks started the agent for: a link that opens it on its own space's Agents page. */
function TaskLink({ task, here }: { readonly task: AgentsTask; readonly here: boolean }) {
  const t = useT();
  return (
    <Link
      to="/s/$space/$view"
      params={{ space: task.space, view: "agents" }}
      search={{ task: task.ref }}
      data-part="session-task"
    >
      {here
        ? t("computer.taskHere", { ref: task.ref })
        : t("computer.taskThere", { ref: task.ref, space: task.spaceName })}
    </Link>
  );
}

function SessionItem({
  session,
  since,
  folder,
  space,
}: {
  readonly session: AgentsSession;
  readonly since: number;
  /** The folder as this list names it. */
  readonly folder: string | undefined;
  /** The space on screen. */
  readonly space: string | undefined;
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
        {session.folder === null ? null : <span title={session.folder}>{folder}</span>}
        {age === undefined ? null : <span>{t("computer.started", { age })}</span>}
        {session.task === null ? null : (
          <TaskLink task={session.task} here={session.task.space === space} />
        )}
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

/** A limit read this much before or after its account says how old its own reading is. */
const OWN_AGE_MS = 60_000;

function WindowLine({
  window: w,
  since,
  accountAgeMs,
}: {
  readonly window: MonitorWindow;
  readonly since: number;
  readonly accountAgeMs: number | null;
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
        {accountAgeMs !== null && Math.abs(w.readingAgeMs - accountAgeMs) > OWN_AGE_MS ? (
          <span>{t("computer.read", { age: spanOf(w.readingAgeMs + since, t) })}</span>
        ) : null}
      </span>
    </li>
  );
}

function AccountItem({
  account,
  since,
  current,
}: {
  readonly account: AgentsAccount;
  readonly since: number;
  readonly current: boolean;
}) {
  const t = useT();
  const notes = [
    // A check that ran then may have ended since: said only of a current picture.
    account.refreshing && current ? t("computer.refreshing") : undefined,
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
            <WindowLine
              key={`${w.kind}:${w.scope ?? ""}:${String(i)}`}
              window={w}
              since={since}
              accountAgeMs={account.readingAgeMs}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The parts from TTAM, for the tab's Agents page. `shown`: the sessions the rows above show with
 * their task, which this list leaves out.
 */
export function Computer({ shown }: { readonly shown: ReadonlySet<string> }) {
  const t = useT();
  const { live } = useContext(Session);
  useEffect(() => live.watchAgents(), [live]);
  const { view, at, current } = useSyncExternalStore(live.agents.subscribe, live.agents.getState);
  const now = useNow();
  const picture = view?.picture ?? null;
  const listed = useMemo(
    () => sessionOrder((picture?.sessions ?? []).filter((s) => !shown.has(s.key))),
    [picture, shown],
  );
  const folders = useMemo(
    () => folderLabels(listed.flatMap((s) => (s.folder === null ? [] : [s.folder]))),
    [listed],
  );
  if (view === undefined) return null;
  // How much older the picture is now than when the service sent it.
  const since = Math.max(0, Math.max(now, at) - at) + (picture?.ageMs ?? 0);
  const note = noteOf(view, t);
  if (note !== undefined) {
    return (
      <p className={styles.note} data-part="monitor-note">
        {note}
      </p>
    );
  }
  const status = statusOf(view, current, t, since);
  // A picture that is not current shows both parts muted: what worked then may not work now.
  const stale = !current || undefined;
  return (
    <>
      <section
        className={styles.part}
        aria-labelledby="computer-heading"
        data-part="computer"
        data-stale={stale}
      >
        <h2 className={styles.heading} id="computer-heading">
          {t("computer.heading")}
        </h2>
        <p className={styles.line} role="status" data-part="monitor-status">
          {status}
        </p>
        {listed.length === 0 ? null : (
          <ul className={styles.list}>
            {listed.map((session) => (
              <SessionItem
                key={session.key}
                session={session}
                since={since}
                folder={session.folder === null ? undefined : folders.get(session.folder)}
                space={live.spaceId}
              />
            ))}
          </ul>
        )}
      </section>
      {picture === null || picture.accounts.length === 0 ? null : (
        <section
          className={styles.part}
          aria-labelledby="usage-heading"
          data-part="usage"
          data-stale={stale}
        >
          <h2 className={styles.heading} id="usage-heading">
            {t("computer.usage")}
          </h2>
          {/* Said again here: on a narrow screen this part is read far below the other. */}
          {current ? null : (
            <p className={styles.line} data-part="usage-status">
              {t("computer.old", { age: spanOf(since, t) })}
            </p>
          )}
          <ul className={styles.list}>
            {picture.accounts.map((account) => (
              <AccountItem key={account.key} account={account} since={since} current={current} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
