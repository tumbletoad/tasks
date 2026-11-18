// The expanded task's body (A5 3.7). The row (Row.tsx) owns the header (check, title, summary,
// star, collapse), its expansion and the region; this is what the region holds, in two columns:
//
// - Content, with no section labels: the outcome and the task's own learnings once it is done,
//   the context (Markdown, clamped at ten lines with More), one line per source with its own text,
//   the place on this machine, a hairline, then the thread (Thread.tsx).
// - Facts (Facts.tsx): short muted labels and their controls, edited in place (A5 3.11). Each fact
//   shows here and nowhere else in the card; the row's columns for them are hidden while it is
//   expanded.
//
// Below both, the composer (Composer.tsx): its field and the strip of what the text goes to. A
// click on an agent-only field (the context, the outcome, a source's line, a learning, the summary
// in the header) starts a request for an agent there. Everything a task holds is untrusted text: it
// is rendered as text or as Markdown that is never HTML, and links open only through allowed
// schemes (A5 3.26).
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { Instance, Receipt, Run } from "../api.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { useT } from "../i18n/intl.tsx";
import { Button } from "react-aria-components";
import { FolderDialog, refusalText } from "../folder/FolderDialog.tsx";
import folderCss from "../folder/Folder.module.css";
import { useFolderWrites } from "../folder/writes.ts";
import type { MessageId } from "../i18n/intl.tsx";
import type { FolderRefusal } from "../row/launch.ts";
import type { AskField, RowActions } from "../row/actions.ts";
import {
  BulbIcon,
  CopyIcon,
  FolderElsewhereIcon,
  FolderIcon,
  FolderOpenIcon,
  OutcomeIcon,
  SourceIcon,
} from "../row/icons.tsx";
import { safeHref } from "../row/model.ts";
import { useClock } from "../row/useClock.ts";
import type { TaskRow } from "../store/rows.ts";
import { Composer } from "./Composer.tsx";
import type { Detail, SourceOutput } from "./detail.ts";
import css from "./Expanded.module.css";
import { Facts } from "./Facts.tsx";
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
  "repo",
  "hairline",
  "line",
  "composer",
]);
const line = classes(folderCss, ["act"]);

export interface ExpandedProps {
  readonly task: TaskRow;
  readonly receipts: readonly Receipt[];
  /** Its background runs, oldest first. */
  readonly runs: readonly Run[];
  readonly instances: readonly Instance[];
  readonly actions: RowActions;
  /** The last Open of this task, refused on its folder; none once an Open went through. */
  readonly refused?: FolderRefusal | undefined;
}

/** Two texts a person reads as the same: case, spacing and a closing full stop aside. */
function sameText(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  const plain = (s: string) => {
    const words = s.normalize("NFC").trim().split(/\s+/u).join(" ");
    let end = words.length;
    while (end > 0 && words[end - 1] === ".") end -= 1;
    return words.slice(0, end).toLocaleLowerCase();
  };
  const left = plain(a);
  return left !== "" && left === plain(b);
}

/**
 * A source's line: its kind's icon, then its own text (a link when its URL may open). A source
 * whose own text is the task's title or summary (a task named after its email) shows its key, or
 * else its kind's name, instead: the card shows each fact string once (A5 3.7).
 */
function SourceLine({
  source,
  task,
  onAsk,
}: {
  readonly source: SourceOutput;
  readonly task: TaskRow;
  readonly onAsk: (event: MouseEvent<HTMLElement>) => void;
}) {
  const t = useT();
  const ref = source.key === undefined ? undefined : keyRef(source.kind, source.key);
  const link = source.url === undefined ? undefined : safeHref(source.url);
  const tip =
    link?.domain === undefined
      ? source.url
      : t("source.tip", { domain: link.domain, url: source.url ?? "" });
  const repeats = sameText(source.title, task.title) || sameText(source.title, task.summary);
  // What opens the source: its own text, or, when that repeats the task, its key or kind's name.
  const own: ReactNode = repeats ? (
    ref === undefined ? (
      t("source.kind", { kind: source.kind })
    ) : (
      <span className={`${styles.key} ${styles.mono}`}>{ref}</span>
    )
  ) : (
    source.title
  );
  const opener =
    link === undefined ? (
      <span dir="auto">{own}</span>
    ) : (
      <a
        href={link.href}
        target="_blank"
        rel={LINK_REL}
        data-tip={tip}
        aria-description={tip}
        dir="auto"
      >
        {own}
      </a>
    );
  return (
    <li
      className={styles.link}
      data-part="source"
      data-kind={source.kind}
      data-ask=""
      data-tip={t("ask.tip")}
      onClick={onAsk}
    >
      <span className={styles.icon} role="img" aria-label={t("source.kind", { kind: source.kind })}>
        <SourceIcon kind={source.kind} />
      </span>
      <span data-fact="">
        {ref === undefined || repeats ? null : (
          <span className={`${styles.key} ${styles.mono}`}>{ref}</span>
        )}
        {opener}
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

/**
 * The folder's line: where the task opens here (its own folder or its project's, the home as `~`),
 * a folder not found, another machine, or the work folder. Quiet words at its end set, change or
 * clear the task's own folder; after an Open refused on the folder they are the ways on.
 */
function PlaceLine({
  task,
  detail,
  base,
  refused,
  onShow,
}: {
  readonly task: TaskRow;
  readonly detail: Detail | undefined;
  /** Where the feed was when `detail` was read: a folder it shows is changed or cleared from it. */
  readonly base: string | undefined;
  /** An Open refused on the folder since the detail was read: what it found is the newer word. */
  readonly refused: FolderRefusal | undefined;
  /** Shows the folder in the file manager. */
  readonly onShow: (task: TaskRow) => void;
}) {
  const t = useT();
  const say = useToast();
  const writes = useFolderWrites();
  const [choosing, setChoosing] = useState(false);
  // The toast's "Choose another folder" opens the chooser, once for each time it is asked.
  const [asked, setAsked] = useState<FolderRefusal>();
  if (refused?.choose === true && asked !== refused) {
    setAsked(refused);
    setChoosing(true);
  }
  const folder = detail?.task.folder;
  const own = folder !== undefined && "path" in folder && folder.of === "task" ? folder : undefined;
  const marker = refused?.anyway;
  const ways = (choose: MessageId) => (
    <>
      {marker === undefined ? null : (
        <Button className={line.act} onPress={marker}>
          {t("row.openAnyway")}
        </Button>
      )}
      <Button
        className={line.act}
        data-quiet={refused === undefined || undefined}
        onPress={() => {
          setChoosing(true);
        }}
      >
        {t(refused === undefined ? choose : "row.chooseFolder")}
      </Button>
      {own === undefined || refused !== undefined ? null : (
        <Button
          className={line.act}
          data-quiet
          onPress={() => {
            writes.clearTask(task, base).catch((error: unknown) => {
              say(refusalText(error, t("folder.notCleared")));
            });
          }}
        >
          {t("folder.clear")}
        </Button>
      )}
    </>
  );
  const chooser = choosing ? (
    <FolderDialog
      title={t("folder.forTask", { ref: task.ref })}
      {...(folder !== undefined &&
      "path" in folder &&
      folder.of === "project" &&
      refused === undefined
        ? { lead: t("folder.taskLead") }
        : {})}
      start={own?.path ?? ""}
      base={base}
      onClose={() => {
        setChoosing(false);
      }}
      onChoose={async (chosen, base) => {
        await writes.setTask(task, chosen, base);
      }}
    />
  ) : null;
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
  const show = (
    <button
      type="button"
      className={styles.act}
      data-part="show-folder"
      aria-label={t("place.show")}
      data-tip={t("place.show")}
      onClick={() => {
        onShow(task);
      }}
    >
      <FolderOpenIcon />
    </button>
  );
  const shown =
    refused?.folder !== undefined
      ? {
          path: refused.folder,
          // A marker's question is the toast's to word: the folder itself is there.
          words: marker === undefined ? t("place.refused", { reason: refused.reason }) : undefined,
        }
      : folder !== undefined && "path" in folder
        ? {
            path: folder.path,
            words: folder.missing === true ? t("place.missing") : undefined,
            repo: folder.repo === undefined ? undefined : t("place.repo", { repo: folder.repo }),
          }
        : undefined;
  if (shown !== undefined) {
    const missing = shown.words !== undefined;
    const repo = "repo" in shown ? shown.repo : undefined;
    return (
      <li className={styles.link} data-part="place" data-state={missing ? "missing" : "here"}>
        <span className={styles.icon} aria-hidden="true">
          <FolderIcon />
        </span>
        <span data-fact="">
          <span className={`${styles.mono} ${missing ? styles.muted : ""}`} dir="ltr">
            {shown.path}
          </span>
          {repo === undefined ? null : (
            <span className={styles.repo} data-tip={t("place.repoTip")}>
              {repo}
            </span>
          )}
          {missing ? <span className={styles.muted}> {shown.words}</span> : null}
        </span>
        <span className={styles.acts}>
          {show}
          <button
            type="button"
            className={styles.act}
            aria-label={t("place.copy")}
            data-tip={t("place.copy")}
            onClick={() => {
              copy(shown.path);
            }}
          >
            <CopyIcon />
          </button>
          {ways(own === undefined ? "folder.ownChange" : "folder.change")}
        </span>
        {chooser}
      </li>
    );
  }
  const elsewhere =
    folder !== undefined && "machine" in folder
      ? folder.machine
      : task.place?.state === "elsewhere"
        ? task.place.machine
        : undefined;
  if (elsewhere !== undefined) {
    return (
      <li className={styles.link} data-part="place" data-state="elsewhere">
        <span className={styles.icon} aria-hidden="true">
          <FolderElsewhereIcon />
        </span>
        <span className={styles.muted} data-fact="" dir="auto">
          {t("place.elsewhere", { machine: elsewhere })}
        </span>
        <span className={styles.acts}>{ways("folder.chooseHere")}</span>
        {chooser}
      </li>
    );
  }
  // No folder for this task here: Open and Run use the space's work folder (A5 3.7, U25).
  if (detail === undefined || task.place !== undefined) return null;
  return (
    <li className={styles.link} data-part="place" data-state="work_folder">
      <span className={styles.icon} aria-hidden="true">
        <FolderIcon />
      </span>
      <span className={styles.muted} data-fact="" data-tip={t("place.workFolderTip")}>
        {t("place.workFolder")}
      </span>
      <span className={styles.acts}>
        {show}
        {ways("folder.choose")}
      </span>
      {chooser}
    </li>
  );
}

/**
 * Click-to-ask (A5 3.11): a click on an agent-only field starts a request for an agent in the
 * composer, unless it was on a link or a button inside it, or ended a selection of its text.
 */
function askOn(
  ask: (task: TaskRow, field: AskField) => void,
  task: TaskRow,
  field: AskField,
): (event: MouseEvent<HTMLElement>) => void {
  return (event) => {
    if ((event.target as Element).closest("a, button") !== null) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    ask(task, field);
  };
}

/** The context, clamped at ten lines with More when it is longer. */
function Context({
  text,
  onAsk,
}: {
  readonly text: string;
  readonly onAsk: (event: MouseEvent<HTMLElement>) => void;
}) {
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
    <div
      className={styles.context}
      data-part="context"
      data-ask=""
      data-tip={t("ask.tip")}
      onClick={onAsk}
    >
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

export function Expanded({ task, receipts, runs, instances, actions, refused }: ExpandedProps) {
  const t = useT();
  const clock = useClock(false);
  const { detail, base, failed } = useDetail(task.id);
  // A refusal holds until the detail is read again: that read says where the folder stands then.
  const [held, setHeld] = useState<{ refused: FolderRefusal; detail: Detail | undefined }>();
  if (refused !== held?.refused) setHeld(refused === undefined ? undefined : { refused, detail });
  const fresh = held !== undefined && held.refused === refused && held.detail === detail;
  const sources: readonly SourceOutput[] =
    detail?.sources ??
    (task.sources ?? []).map((s) => ({
      kind: s.kind as SourceOutput["kind"],
      title: s.title,
      ...(s.who === undefined ? {} : { who: s.who }),
      ...(s.url === undefined ? {} : { url: s.url }),
    }));
  const learnings = detail?.learnings ?? [];
  const ask = actions.ask;
  // A row read from search knows no creation time (Completed, A5 3.5): the digest's says it.
  const created = detail?.task.created === undefined ? Number.NaN : Date.parse(detail.task.created);
  const facts =
    task.created_at <= 0 && Number.isFinite(created) ? { ...task, created_at: created } : task;
  return (
    <div className={styles.body} data-part="expanded">
      {/* First in the document: below 1,024 px the facts come before the content (A5 3.7). */}
      <Facts task={facts} clock={clock} />
      <div className={styles.content}>
        {detail?.outcome === undefined ? null : (
          <div
            className={styles.outcome}
            data-part="outcome"
            data-ask=""
            data-tip={t("ask.tip")}
            onClick={askOn(ask, task, "outcome")}
          >
            <span className={styles.icon} role="img" aria-label={t("task.outcome")}>
              <OutcomeIcon />
            </span>
            <div data-fact="">
              <Markdown text={detail.outcome} />
            </div>
          </div>
        )}
        {detail === undefined || detail.context.trim() === "" ? null : (
          <Context text={detail.context} onAsk={askOn(ask, task, "context")} />
        )}
        <ul className={styles.links}>
          {sources.map((source, i) => (
            <SourceLine
              key={`${String(i)}:${source.key ?? source.title}`}
              source={source}
              task={task}
              onAsk={askOn(ask, task, "sources")}
            />
          ))}
          <PlaceLine
            task={task}
            detail={detail}
            base={base}
            refused={fresh ? refused : undefined}
            onShow={actions.folder}
          />
          {learnings.map((learning, i) => (
            <li
              key={`learning:${String(i)}`}
              className={styles.link}
              data-part="learning"
              data-ask=""
              data-tip={t("ask.tip")}
              onClick={askOn(ask, task, "learnings")}
            >
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
            runs={runs}
            instances={instances}
            partial={detail.partial}
            onStop={(run) => {
              actions.stop(task, run);
            }}
          />
        )}
        {failed && detail !== undefined ? (
          <p className={styles.line} role="status">
            {t("task.stale")}
          </p>
        ) : null}
      </div>
      <div className={styles.composer}>
        <Composer task={task} receipts={receipts} instances={instances} actions={actions} />
      </div>
    </div>
  );
}
