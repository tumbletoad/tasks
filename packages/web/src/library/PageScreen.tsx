// A page of the library on a screen of its own (`/s/:space/page/:ref`): its title and brief, who
// changed it last and why, its versions, and its body, each text with its pen. The way back names
// where the person came from, kept in the history entry; without one it is what holds the page.
//
// The versions list opens under the line of the last change, a part at a time. Show puts one
// version's words in place of the body, read-only, under a line with Restore and the way back to
// the current words. Restore writes that version back as a new edit from the body on screen: when
// someone changed the body since, nothing is written, the page reads again and Restore is there on
// the newest words.
//
// The feed never moves the reader's words: a newer change shows a line with the way to the newest
// words, and an open pen keeps what the person typed.
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { classes } from "../app/css.ts";
import { useTitle, useToast } from "../app/frame.ts";
import { Session } from "../context.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT } from "../i18n/intl.tsx";
import { formatWhen } from "@ttasks/client/today";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { trail, type PageRow } from "@ttasks/client/store";
import { Markdown } from "../task/markdown.tsx";
import { TEXT_MAX } from "../unsent.ts";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import type { PageView, TrashedPage, Version } from "./calls.ts";
import { LibraryLink } from "./Library.tsx";
import css from "./Library.module.css";
import { Penned, useChanged, whoOf } from "./parts.tsx";
import { useLibraryWrites } from "./writes.ts";

const styles = classes(css, [
  "screen",
  "top",
  "back",
  "crumb",
  "head",
  "titleLine",
  "pageTitle",
  "ref",
  "brief",
  "meta",
  "quiet",
  "act",
  "notice",
  "words",
  "actions",
  "fold",
  "quietAct",
  "versions",
  "version",
  "when",
  "who",
  "why",
  "acts",
  "current",
  "more",
  "body",
  "shown",
  "md",
  "penned",
]);

const TITLE_MAX = 300;
const BRIEF_MAX = 400;
/** Parts of a long body read on with its cursor before the rest is left for another time. */
const MAX_PARTS = 20;

/** A page as read: its answer, its whole body, and whether the body is all of it. */
interface Read {
  readonly page: PageView;
  readonly body: string;
  readonly whole: boolean;
}

const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/**
 * A page the service does not read: in the Trash (its own screen says so, with Restore), or not
 * there at all. A page hidden because what holds it is in the Trash is not listed there.
 */
async function missing(calls: Client, ref: string): Promise<{ inTrash: TrashedPage } | "gone"> {
  const { rows } = await calls.page.trashed({ q: ref });
  const row = rows.find((page) => page.ref === ref);
  return row === undefined ? "gone" : { inTrash: row };
}

async function readPage(calls: Client, ref: string): Promise<Read | "gone"> {
  const first = await calls.page.read({ target: ref });
  if (first.view !== "page") return "gone";
  let body = first.body ?? "";
  let cursor = first.cursor;
  for (let part = 0; cursor !== undefined && part < MAX_PARTS; part += 1) {
    const next = await calls.page.read({ target: ref, cursor });
    if (next.view !== "page") break;
    body += next.body ?? "";
    cursor = next.cursor;
  }
  return { page: first, body, whole: cursor === undefined };
}

/** The way back: where the person came from, in the history entry, or else what holds the page. */
function Back({ page, row }: { readonly page: PageView; readonly row: PageRow | undefined }) {
  const t = useT();
  const router = useRouter();
  const from = useRouterState({ select: (s) => s.location.state.from });
  const { space } = useLive();
  if (from !== undefined) {
    return (
      <a
        className={styles.back}
        href={from.path}
        data-part="page-back"
        onClick={(event) => {
          event.preventDefault();
          router.history.back();
        }}
      >
        {t("page.back", { label: from.label })}
      </a>
    );
  }
  const { owner } = page;
  if (owner.kind === "task") {
    return (
      <Link
        to="/s/$space/task/$task"
        params={{ space: space?.id ?? "", task: row?.task?.ref ?? owner.id }}
        className={styles.back}
        data-part="page-back"
      >
        {t("page.back", { label: owner.title })}
      </Link>
    );
  }
  return (
    <LibraryLink
      node={owner.kind === "space" ? { kind: "space" } : { kind: owner.kind, id: owner.id }}
      className={styles.back}
    >
      {t("page.back", { label: t("library.of", { name: owner.title }) })}
    </LibraryLink>
  );
}

/** Where the page stands: its area and project, each to its Library. */
function Crumb({ row }: { readonly row: PageRow | undefined }) {
  const { nodes } = useLive();
  if (row === undefined) return null;
  const [area, project] = trail(nodes, row.under);
  if (area === undefined) return null;
  return (
    <span className={styles.crumb} data-part="page-crumb">
      <LibraryLink node={{ kind: "area", id: area.id }}>{area.title}</LibraryLink>
      {project === undefined ? null : (
        <LibraryLink node={{ kind: "project", id: project.id }}>{project.title}</LibraryLink>
      )}
    </span>
  );
}

/** The versions of the body, newest first, a part at a time; each with Show and Restore. */
function Versions({
  page,
  round,
  shown,
  onShow,
  onRestore,
}: {
  readonly page: string;
  /** Grows when the versions may have changed: they are read again. */
  readonly round: number;
  readonly shown: number | undefined;
  readonly onShow: (version: Version) => void;
  readonly onRestore: (version: Version) => void;
}) {
  const t = useT();
  const { api, live } = useContext(Session);
  const clock = useClock(true);
  const { instances } = useLive();
  const [list, setList] = useState<{ versions: Version[]; cursor?: string | undefined }>();
  const [failed, setFailed] = useState(false);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    let current = true;
    api.client.page.history({ target: page }).then(
      (answer) => {
        if (!current || answer.view !== "versions") return;
        setFailed(false);
        setList({ versions: answer.versions, cursor: answer.cursor });
      },
      (error: unknown) => {
        if (current && !live.failed(error)) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [api, live, page, round, again]);
  const older = () => {
    const cursor = list?.cursor;
    if (cursor === undefined) return;
    api.client.page.history({ target: page, cursor }).then(
      (answer) => {
        if (answer.view !== "versions") return;
        setList((now) => ({
          versions: [...(now?.versions ?? []), ...answer.versions],
          cursor: answer.cursor,
        }));
      },
      (error: unknown) => {
        if (!live.failed(error)) setFailed(true);
      },
    );
  };
  if (failed) {
    return (
      <p className={styles.quiet} role="status">
        {t("page.versionsFailed")}
        <button
          type="button"
          className={styles.act}
          onClick={() => {
            setAgain((n) => n + 1);
          }}
        >
          {t("edit.tryAgain")}
        </button>
      </p>
    );
  }
  if (list === undefined) return null;
  const whenOf = (version: Version) => formatWhen(Date.parse(version.at), clock);
  const whyOf = (version: Version): string => {
    if (version.why !== undefined) return version.why;
    if (version.restored_from === undefined) return "";
    const of = list.versions.find((v) => v.seq === version.restored_from);
    return of === undefined
      ? t("page.restoredEarlier")
      : t("page.restoredOf", { when: whenOf(of) });
  };
  return (
    <div className={styles.versions} data-part="versions">
      <ol aria-label={t("page.versions")}>
        {list.versions.map((version, i) => (
          <li
            key={version.seq}
            className={styles.version}
            data-part="version"
            data-shown={shown === version.seq || undefined}
          >
            <span className={styles.when}>{whenOf(version)}</span>
            <span className={styles.who}>{whoOf(version.by, instances, t)}</span>
            <span className={styles.why} dir="auto">
              {whyOf(version)}
            </span>
            <span className={styles.acts}>
              {i === 0 ? (
                <span className={styles.current}>{t("page.current")}</span>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.act}
                    data-part="version-show"
                    aria-label={t("page.showLabel", { when: whenOf(version) })}
                    aria-pressed={shown === version.seq}
                    onClick={() => {
                      onShow(version);
                    }}
                  >
                    {t("page.show")}
                  </button>
                  <button
                    type="button"
                    className={styles.act}
                    data-part="version-restore"
                    aria-label={t("page.restoreLabel", { when: whenOf(version) })}
                    onClick={() => {
                      onRestore(version);
                    }}
                  >
                    {t("page.restore")}
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
      {list.cursor === undefined ? null : (
        <button type="button" className={styles.more} onClick={older}>
          {t("page.older")}
        </button>
      )}
    </div>
  );
}

export function PageScreen({ page: ref }: { readonly page: string }) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const state = useLive();
  const writes = useLibraryWrites();
  const changed = useChanged();
  const clock = useClock(true);
  const [read, setRead] = useState<Read | { inTrash: TrashedPage } | "gone" | "failed">();
  const [round, setRound] = useState(0);
  const [history, setHistory] = useState(0);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<{ readonly version: Version; readonly text: string }>();
  // In the Trash: the page itself (its Restore brings it back), or what holds it (a task in the
  // Trash hides its pages without writing them, and only that task's Restore brings them back).
  const [trashed, setTrashed] = useState<"page" | "owner" | undefined>(undefined);
  const banner = useRef<HTMLParagraphElement>(null);
  // A page the person just made opens with its body's pen, once.
  const fresh = useRouterState({ select: (s) => s.location.state.pen === "body" });
  const [opening, setOpening] = useState(fresh);
  const again = useCallback(() => {
    setRound((n) => n + 1);
    setHistory((n) => n + 1);
  }, []);
  useEffect(() => {
    let current = true;
    readPage(api.client, ref).then(
      (answer) => {
        if (current) setRead(answer);
      },
      (error: unknown) => {
        if (!current || live.failed(error)) return;
        if (codeOf(error) !== "not_found") {
          setRead("failed");
          return;
        }
        missing(api.client, ref).then(
          (found) => {
            if (current) setRead(found);
          },
          () => {
            if (current) setRead("gone");
          },
        );
      },
    );
    return () => {
      current = false;
    };
  }, [api, live, ref, round]);
  const page = typeof read === "object" && "page" in read ? read.page : undefined;
  const id = page?.id;
  // The Trash and back, from the feed: this tab's own and anyone's.
  useEffect(
    () =>
      live.onChanges(({ changes }) => {
        for (const change of changes) {
          if (change.type !== "page" || change.id !== id || change.after === undefined) continue;
          const after = change.after as PageRow;
          const before = change.before as PageRow | undefined;
          setTrashed(
            after.deleted_at === undefined
              ? undefined
              : before === undefined || after.version !== before.version
                ? "page"
                : "owner",
          );
        }
      }),
    [live, id],
  );
  useEffect(() => {
    if (shown !== undefined) banner.current?.focus({ preventScroll: false });
  }, [shown]);
  // The reader's place: a line that comes or goes above the words (a newer change, the Trash) while
  // the reader is down the page leaves the words where they were on the screen.
  const words = useRef<HTMLDivElement>(null);
  const row = id === undefined ? undefined : state.pages.get(id);
  const notices = `${String(row !== undefined && page !== undefined && row.version > page.version)}|${String(trashed)}`;
  // After a Restore, the words it brought back have the focus.
  const focusWords = useRef(false);
  const shownNotices = useRef(notices);
  const place = useRef<number | undefined>(undefined);
  if (notices !== shownNotices.current) {
    shownNotices.current = notices;
    if (window.scrollY > 0 && words.current !== null) {
      place.current = words.current.getBoundingClientRect().top;
    }
  }
  useLayoutEffect(() => {
    const kept = place.current;
    place.current = undefined;
    if (kept === undefined || words.current === null) return;
    const moved = words.current.getBoundingClientRect().top - kept;
    if (Math.abs(moved) > 0.5) window.scrollBy(0, moved);
  });
  useEffect(() => {
    if (!focusWords.current || typeof read !== "object") return;
    focusWords.current = false;
    words.current?.focus({ preventScroll: true });
  }, [read]);
  useTitle(page?.title ?? ref);
  if (read === undefined) return null;
  if (typeof read === "object" && "inTrash" in read) {
    const { inTrash } = read;
    return (
      <div className={styles.screen}>
        <p className={styles.notice} role="status" data-part="page-in-trash">
          <span dir="auto">
            {t("page.inTrashNamed", { ref: inTrash.ref, title: inTrash.title })}
          </span>
          {state.space?.read_only === undefined ? (
            <button
              type="button"
              className={styles.act}
              onClick={() => {
                writes.untrash(inTrash.ref).then(again, (error: unknown) => {
                  if (!live.failed(error)) say(refusalText(error, t("page.trashFailed")));
                });
              }}
            >
              {t("trash.restore")}
            </button>
          ) : null}
        </p>
      </div>
    );
  }
  if (read === "gone" || read === "failed") {
    return (
      <p className={styles.quiet} role="status" data-part="page-missing">
        {read === "gone" ? t("page.gone", { ref }) : t("page.failed")}
        {read === "failed" ? (
          <button type="button" className={styles.act} onClick={again}>
            {t("edit.tryAgain")}
          </button>
        ) : null}
      </p>
    );
  }
  const { page: view, body, whole } = read;
  const newer = row !== undefined && row.version > view.version ? row : undefined;
  const editable = state.space?.read_only === undefined && trashed === undefined;
  const base = view.as_of;
  const whenOf = (version: Version) => formatWhen(Date.parse(version.at), clock);
  const show = (version: Version) => {
    api.client.page.history({ target: view.ref, seq: version.seq }).then(
      (answer) => {
        if (answer.view === "version") setShown({ version, text: answer.text });
      },
      (error: unknown) => {
        if (!live.failed(error)) say(t("page.versionsFailed"));
      },
    );
  };
  const restore = (version: Version) => {
    writes.restore(view.ref, version.seq, whenOf(version), base).then(
      () => {
        setShown(undefined);
        focusWords.current = true;
        again();
      },
      (error: unknown) => {
        if (live.failed(error)) return;
        // Someone changed the body since: back to the current words, read anew, so the person sees
        // them before a Restore over them can be pressed again.
        const conflict = codeOf(error) === "conflict";
        say(
          conflict
            ? t("page.conflict", { ref: view.ref })
            : refusalText(error, t("page.restoreFailed")),
        );
        if (conflict) setShown(undefined);
        again();
      },
    );
  };
  const last = view.last;
  const meta = changed(last.by, Date.parse(last.at));
  return (
    <article className={styles.screen} data-part="page">
      <div className={styles.top}>
        <Back page={view} row={row} />
        <Crumb row={row} />
      </div>
      <header className={styles.head}>
        <Penned
          owner={view.id}
          part="title"
          label={t("page.title")}
          pen={t("page.titleEdit")}
          text={view.title}
          base={base}
          max={TITLE_MAX}
          line
          save={
            editable ? (words, from) => writes.page(view.ref, { title: words }, from) : undefined
          }
          onDone={again}
          view={(text, pen) => (
            <div className={styles.titleLine}>
              <h1 className={styles.pageTitle}>
                <span className={styles.ref}>{view.ref}</span>
                <span dir="auto">{text}</span>
              </h1>
              {pen}
            </div>
          )}
        />
        <Penned
          owner={view.id}
          part="brief"
          label={t("page.brief")}
          pen={t("page.briefEdit")}
          text={view.brief}
          base={base}
          max={BRIEF_MAX}
          line
          clears
          save={
            editable ? (words, from) => writes.page(view.ref, { brief: words }, from) : undefined
          }
          onDone={again}
          view={(text, pen) => (
            <p className={styles.brief} data-part="page-brief">
              {/* A person's page may have no brief: the pen stands where it would. */}
              {text === "" ? (
                <span className={styles.quiet}>{t("page.briefNone")}</span>
              ) : (
                <span dir="auto">{text}</span>
              )}
              {pen}
            </p>
          )}
        />
        <p className={styles.meta} data-part="page-changed" dir="auto">
          {last.why === undefined
            ? t("page.changed", { changed: meta })
            : t("page.changedWhy", { changed: meta, why: last.why })}
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.fold}
            data-part="versions-toggle"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {t("page.versions")}
          </button>
          {editable ? (
            <button
              type="button"
              className={styles.quietAct}
              data-part="page-trash"
              onClick={() => {
                writes.trash(view.ref).then(
                  () => {
                    setTrashed("page");
                  },
                  (error: unknown) => {
                    if (!live.failed(error)) say(refusalText(error, t("page.trashFailed")));
                  },
                );
              }}
            >
              {t("page.trash")}
            </button>
          ) : null}
        </div>
      </header>
      {open ? (
        <Versions
          page={view.ref}
          round={history}
          shown={shown?.version.seq}
          onShow={show}
          onRestore={restore}
        />
      ) : null}
      {trashed === "owner" ? (
        <p className={styles.notice} role="status" data-part="page-trashed">
          {t("page.ownerInTrash")}
        </p>
      ) : trashed === "page" ? (
        <p className={styles.notice} role="status" data-part="page-trashed">
          {t("page.inTrash")}
          <button
            type="button"
            className={styles.act}
            onClick={() => {
              writes.untrash(view.ref).then(
                () => {
                  setTrashed(undefined);
                },
                (error: unknown) => {
                  if (!live.failed(error)) say(refusalText(error, t("page.trashFailed")));
                },
              );
            }}
          >
            {t("trash.restore")}
          </button>
        </p>
      ) : null}
      {newer === undefined || trashed !== undefined ? null : (
        <p className={styles.notice} role="status" data-part="page-newer">
          {t("page.newer", { changed: changed(newer.by, newer.at) })}
          <button type="button" className={styles.act} onClick={again}>
            {t("page.showNewest")}
          </button>
        </p>
      )}
      <div ref={words} className={styles.words} tabIndex={-1} data-part="page-words">
        {shown === undefined ? (
          <Penned
            owner={view.id}
            part="body"
            label={t("page.body")}
            pen={t("page.bodyEdit")}
            text={body}
            base={base}
            max={TEXT_MAX}
            paragraphs
            clears
            partial={whole ? undefined : t("text.partial")}
            save={
              editable ? (words, from) => writes.page(view.ref, { body: words }, from) : undefined
            }
            onDone={() => {
              setOpening(false);
              again();
            }}
            opening={opening}
            view={(text, pen) => (
              <div className={styles.body} data-part="page-body">
                {text === "" ? (
                  <p className={styles.quiet}>{t("page.empty")}</p>
                ) : (
                  <Markdown text={text} className={styles.md} headings />
                )}
                {pen}
              </div>
            )}
          />
        ) : (
          <div className={styles.body} data-part="page-version">
            <p ref={banner} tabIndex={-1} className={styles.shown}>
              {t("page.versionOf", {
                when: whenOf(shown.version),
                who: whoOf(shown.version.by, state.instances, t),
              })}
              {editable ? (
                <button
                  type="button"
                  className={styles.act}
                  data-part="restore-shown"
                  onClick={() => {
                    restore(shown.version);
                  }}
                >
                  {t("page.restoreThis")}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.act}
                data-part="back-to-current"
                onClick={() => {
                  setShown(undefined);
                }}
              >
                {t("page.backToCurrent")}
              </button>
            </p>
            <Markdown text={shown.text} className={styles.md} headings />
          </div>
        )}
      </div>
    </article>
  );
}
