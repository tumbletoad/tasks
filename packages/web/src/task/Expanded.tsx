// The expanded task's body (A5 3.7). The row (Row.tsx) owns the header (check, title, summary,
// star, collapse), its expansion and the region; this is what the region holds, in two columns:
//
// - Content, with no section labels: the outcome and the task's own learnings once it is done,
//   the context (Markdown, clamped at ten lines with More), one line per source with its own text,
//   the place on this machine, a hairline, then the thread (Thread.tsx).
// - Facts: a list of short muted labels and values. Each fact shows here and nowhere else in the
//   card; the row's columns for them are hidden while it is expanded. Editing them is M5.08's, so
//   no value is outlined yet: the outline is the only hint that a value can be changed by hand.
//
// Below both, the composer's place: until M5.07 builds the composer and its strip, it holds a
// button per instance and Copy, as the skeleton did. Everything a task holds is untrusted text: it
// is rendered as text or as Markdown that is never HTML, and links open only through allowed
// schemes (A5 3.26).
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Instance, Receipt } from "../api.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { areaSlots } from "../groups.ts";
import { useT, type MessageId, type Translate } from "../i18n/intl.tsx";
import { tileClick, tileState } from "../row/launch.ts";
import type { RowActions } from "../row/actions.ts";
import { formatDay, formatInstant, localDate, type Clock } from "../row/dates.ts";
import {
  BulbIcon,
  CopyIcon,
  FolderElsewhereIcon,
  FolderIcon,
  OutcomeIcon,
  SourceIcon,
} from "../row/icons.tsx";
import { contextFor, renderRow, safeHref } from "../row/model.ts";
import { sayMsg } from "../row/say.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import type { Detail, SourceOutput } from "./detail.ts";
import css from "./Expanded.module.css";
import { LINK_REL, Markdown } from "./markdown.tsx";
import { Thread } from "./Thread.tsx";
import { useDetail } from "./useDetail.ts";

const styles = classes(css, [
  "body",
  "content",
  "outcome",
  "context",
  "more",
  "links",
  "link",
  "icon",
  "key",
  "muted",
  "mono",
  "acts",
  "act",
  "hairline",
  "line",
  "facts",
  "dot",
  "composer",
  "strip",
  "button",
  "glyph",
]);

export interface ExpandedProps {
  readonly task: TaskRow;
  readonly receipts: readonly Receipt[];
  readonly instances: readonly Instance[];
  readonly actions: RowActions;
}

const STATUS_LABEL: Readonly<Record<string, MessageId>> = {
  open: "status.open",
  waiting: "status.waiting",
  review: "status.review",
  backlog: "status.backlog",
};

/** The status fact: the lifecycle for a finished task, Inbox, else the status's name. */
function statusOf(task: TaskRow, t: Translate): string {
  if (task.lifecycle === "completed") return t("status.completed");
  if (task.lifecycle === "archived") return t("status.archived");
  if (task.inbox) return t("status.inbox");
  const label = STATUS_LABEL[task.status];
  return label === undefined ? task.status : t(label);
}

/** "Fri 13 Nov", with the year when it is not this year; the catalogue orders the parts. */
function shortDate(date: string, clock: Clock, t: Translate): string {
  const options = (o: Intl.DateTimeFormatOptions) => formatDay(date, clock.locale, o);
  const values = {
    weekday: options({ weekday: "short" }),
    day: Number(date.slice(8, 10)),
    month: options({ month: "short" }),
    year: date.slice(0, 4),
  };
  return date.slice(0, 4) === clock.today.slice(0, 4)
    ? t("row.fullDate", values)
    : t("row.fullDateYear", values);
}

/** The due fact: its date (and time), with the row's relative words as the tooltip. */
function dueOf(
  task: TaskRow,
  clock: Clock,
  t: Translate,
): { text: string; tip: string } | undefined {
  const model = renderRow({ task, instances: [], receipts: [] }, contextFor("open", "flat", clock));
  const relative = model.due === undefined ? "" : sayMsg(t, model.due.text);
  if (task.due_at !== undefined) {
    const date = shortDate(localDate(task.due_at, clock.timeZone), clock, t);
    const time = formatInstant(task.due_at, clock, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return { text: t("fact.dueAt", { date, time }), tip: relative };
  }
  if (task.due_date !== undefined) {
    return { text: shortDate(task.due_date, clock, t), tip: relative };
  }
  return undefined;
}

/** The created fact: "9 Nov · 3d", the only place a task's age shows while it is expanded. */
function createdOf(task: TaskRow, clock: Clock, t: Translate): string {
  const model = renderRow({ task, instances: [], receipts: [] }, contextFor("open", "flat", clock));
  const date = localDate(task.created_at, clock.timeZone);
  const day = formatDay(date, clock.locale, { day: "numeric" });
  const month = formatDay(date, clock.locale, { month: "short" });
  const shown =
    date.slice(0, 4) === clock.today.slice(0, 4)
      ? t("row.date", { day, month })
      : t("row.dateYear", { day, month, year: date.slice(0, 4) });
  return t("fact.createdValue", { date: shown, age: sayMsg(t, model.age.text) });
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-fact="">{children}</dd>
    </>
  );
}

function Facts({ task, clock }: { readonly task: TaskRow; readonly clock: Clock }) {
  const t = useT();
  const state = useLive();
  const area = task.area_id === undefined ? undefined : state.areas.get(task.area_id);
  const project = task.project_id === undefined ? undefined : state.projects.get(task.project_id);
  const slot = area === undefined ? undefined : areaSlots(state.areas.values()).get(area.id);
  const due = dueOf(task, clock, t);
  const level = task.priority;
  return (
    <dl className={styles.facts} aria-label={t("fact.label")}>
      <Fact label={t("fact.status")}>{statusOf(task, t)}</Fact>
      {task.status === "waiting" && task.waiting_on !== undefined && task.waiting_on !== "" ? (
        <Fact label={t("fact.waitingOn")}>
          <span dir="auto">{task.waiting_on}</span>
        </Fact>
      ) : null}
      {level === 1 || level === 2 || level === 3 ? (
        <Fact label={t("fact.priority")}>{t("row.priority", { level })}</Fact>
      ) : null}
      {task.effort === undefined || task.effort === "" ? null : (
        <Fact label={t("fact.effort")}>
          <span dir="auto">{task.effort}</span>
        </Fact>
      )}
      {due === undefined ? null : (
        <Fact label={t("fact.due")}>
          <span data-tip={due.tip} title={due.tip}>
            {due.text}
          </span>
        </Fact>
      )}
      {area === undefined ? null : (
        <Fact label={t("fact.area")}>
          <span
            className={`${styles.dot} slot-${String(slot ?? 1)}`}
            aria-hidden="true"
            data-slot={slot}
          />
          <span dir="auto">
            {project === undefined
              ? area.title
              : t("fact.areaProject", { area: area.title, project: project.title })}
          </span>
        </Fact>
      )}
      <Fact label={t("fact.created")}>{createdOf(task, clock, t)}</Fact>
    </dl>
  );
}

/** A source's line: its kind's icon, then its own text (a link when its URL may open). */
function SourceLine({ source }: { readonly source: SourceOutput }) {
  const t = useT();
  const ref = source.key === undefined ? undefined : keyRef(source.kind, source.key);
  const link = source.url === undefined ? undefined : safeHref(source.url);
  const tip =
    link?.domain === undefined
      ? source.url
      : t("source.tip", { domain: link.domain, url: source.url ?? "" });
  const title =
    link === undefined ? (
      <span dir="auto">{source.title}</span>
    ) : (
      <a href={link.href} target="_blank" rel={LINK_REL} data-tip={tip} title={tip} dir="auto">
        {source.title}
      </a>
    );
  return (
    <li className={styles.link} data-part="source" data-kind={source.kind}>
      <span className={styles.icon} role="img" aria-label={t("source.kind", { kind: source.kind })}>
        <SourceIcon kind={source.kind} />
      </span>
      <span data-fact="">
        {ref === undefined ? null : <span className={`${styles.key} ${styles.mono}`}>{ref}</span>}
        {title}
        {source.who === undefined ? null : (
          <span className={styles.muted} dir="auto">
            {t("source.whoSuffix", { who: source.who })}
          </span>
        )}
      </span>
    </li>
  );
}

/** The kinds whose key names the item in its own system (as the service's feed.ts reads them). */
const KEYED_KINDS: ReadonlySet<string> = new Set(["ticket", "issue", "pr"]);

/** `jira:LUM-212` gives `LUM-212` for a ticket, an issue or a pull request; else nothing. */
function keyRef(kind: string, key: string): string | undefined {
  if (!KEYED_KINDS.has(kind)) return undefined;
  const at = key.indexOf(":");
  const ref = at < 0 ? "" : key.slice(at + 1);
  return ref !== "" && ref.length <= 40 && !/\s/u.test(ref) ? ref : undefined;
}

/** The place's line: its folder here, a folder not found, another machine, or the work folder. */
function PlaceLine({
  task,
  detail,
}: {
  readonly task: TaskRow;
  readonly detail: Detail | undefined;
}) {
  const t = useT();
  const say = useToast();
  const place = detail?.task.place;
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        say(t("place.copied"));
      },
      () => {
        say(t("row.copyFailed"));
      },
    );
  };
  if (place !== undefined) {
    const found = place.folder;
    const shown = found ?? (place.path === "" ? place.root : `${place.root}/${place.path}`);
    return (
      <li
        className={styles.link}
        data-part="place"
        data-state={found === undefined ? "missing" : "here"}
      >
        <span className={styles.icon} aria-hidden="true">
          <FolderIcon />
        </span>
        <span data-fact="">
          <span className={`${styles.mono} ${found === undefined ? styles.muted : ""}`} dir="ltr">
            {shown}
          </span>
          {found === undefined ? <span className={styles.muted}> {t("place.missing")}</span> : null}
        </span>
        {found === undefined ? null : (
          <span className={styles.acts}>
            <button
              type="button"
              className={styles.act}
              aria-label={t("place.copy")}
              data-tip={t("place.copy")}
              onClick={() => {
                copy(found);
              }}
            >
              <CopyIcon />
            </button>
          </span>
        )}
      </li>
    );
  }
  if (task.place?.state === "elsewhere") {
    return (
      <li className={styles.link} data-part="place" data-state="elsewhere">
        <span className={styles.icon} aria-hidden="true">
          <FolderElsewhereIcon />
        </span>
        <span className={styles.muted} data-fact="" dir="auto">
          {t("place.elsewhere", { machine: task.place.machine })}
        </span>
      </li>
    );
  }
  // No place on this machine: Open and Run use the space's work folder (A5 3.7, U25).
  if (detail === undefined || task.place !== undefined) return null;
  return (
    <li className={styles.link} data-part="place" data-state="work_folder">
      <span className={styles.icon} aria-hidden="true">
        <FolderIcon />
      </span>
      <span
        className={styles.muted}
        data-fact=""
        data-tip={t("place.workFolderTip")}
        title={t("place.workFolderTip")}
      >
        {t("place.workFolder")}
      </span>
    </li>
  );
}

/** The context, clamped at ten lines with More when it is longer. */
function Context({ text }: { readonly text: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || open) return;
    setLong(element.scrollHeight > element.clientHeight + 1);
  }, [text, open]);
  return (
    <div className={styles.context} data-part="context">
      <div ref={box} data-clamped={!open} data-fact="">
        <Markdown text={text} />
      </div>
      {long || open ? (
        <button
          type="button"
          className={styles.more}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {t(open ? "task.less" : "task.more")}
        </button>
      ) : null}
    </div>
  );
}

/** The composer's place until M5.07: a button per instance, then Copy. */
function Strip({ task, receipts, instances, actions }: ExpandedProps) {
  const t = useT();
  return (
    <div className={styles.strip} role="toolbar" aria-label={t("strip.label")}>
      {instances.map((instance) => {
        const state = tileState(receipts, instance.key);
        return (
          <button
            key={instance.key}
            type="button"
            className={styles.button}
            data-state={state}
            data-ring={instance.ring}
            aria-disabled={state === "opening"}
            onClick={() => {
              const action = tileClick(state);
              if (action === "open") actions.open(task, instance);
            }}
          >
            <span className={styles.glyph} aria-hidden="true">
              {instance.glyph}
            </span>
            {t("row.openIn", { label: instance.label })}
          </button>
        );
      })}
      <button
        type="button"
        className={styles.button}
        aria-label={t("row.copyFor", { title: task.title })}
        onClick={() => {
          actions.copy(task);
        }}
      >
        <CopyIcon />
        {t("row.copy")}
      </button>
    </div>
  );
}

export function Expanded({ task, receipts, instances, actions }: ExpandedProps) {
  const t = useT();
  const clock = useClock(false);
  const { detail, failed } = useDetail(task.id);
  const sources: readonly SourceOutput[] =
    detail?.sources ??
    (task.sources ?? []).map((s) => ({
      kind: s.kind as SourceOutput["kind"],
      title: s.title,
      ...(s.who === undefined ? {} : { who: s.who }),
      ...(s.url === undefined ? {} : { url: s.url }),
    }));
  const learnings = detail?.learnings ?? [];
  return (
    <div className={styles.body} data-part="expanded">
      {/* First in the document: below 1,024 px the facts come before the content (A5 3.7). */}
      <Facts task={task} clock={clock} />
      <div className={styles.content}>
        {detail?.outcome === undefined ? null : (
          <div className={styles.outcome} data-part="outcome">
            <span className={styles.icon} role="img" aria-label={t("task.outcome")}>
              <OutcomeIcon />
            </span>
            <div data-fact="">
              <Markdown text={detail.outcome} />
            </div>
          </div>
        )}
        {detail === undefined || detail.context.trim() === "" ? null : (
          <Context text={detail.context} />
        )}
        <ul className={styles.links}>
          {sources.map((source, i) => (
            <SourceLine key={`${String(i)}:${source.key ?? source.title}`} source={source} />
          ))}
          <PlaceLine task={task} detail={detail} />
          {learnings.map((learning, i) => (
            <li key={`learning:${String(i)}`} className={styles.link} data-part="learning">
              <span className={styles.icon} role="img" aria-label={t("task.learning")}>
                <BulbIcon />
              </span>
              <div data-fact="">
                <Markdown text={learning} />
              </div>
            </li>
          ))}
        </ul>
        <hr className={styles.hairline} />
        {detail === undefined ? (
          failed ? (
            <p className={styles.line} role="status">
              {t("thread.failed")}
            </p>
          ) : null
        ) : (
          <Thread
            notes={detail.notes}
            log={detail.log}
            receipts={receipts}
            instances={instances}
            partial={detail.partial}
          />
        )}
        {failed && detail !== undefined ? (
          <p className={styles.line} role="status">
            {t("task.stale")}
          </p>
        ) : null}
      </div>
      <div className={styles.composer}>
        <Strip task={task} receipts={receipts} instances={instances} actions={actions} />
      </div>
    </div>
  );
}
