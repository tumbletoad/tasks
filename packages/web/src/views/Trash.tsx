// The Trash: what was moved there on purpose, one group per change, newest first, read in pages
// (trash.ts) because the live store never holds removed tasks. A change of several tasks is headed
// by who moved them and when, with "Restore these"; every row says where its task was and has its
// own Restore. One field finds an old one by reference or title words across every page. The page
// reads again whenever the feed restores or removes a task (queries.ts). At its foot: the unsent
// words of tasks in the Trash or that this space does not have now, with Copy and Discard, and
// what the Trash promises.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { Session } from "../context.ts";
import { readOnlyReason, readOnlyWhy } from "../edit/read-only.ts";
import { useEdits } from "../edit/useEdits.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { formatInstant, type Clock } from "../row/dates.ts";
import { sayMsg } from "../row/say.ts";
import { useClock } from "../row/useClock.ts";
import { useLive, usePagedQuery } from "../store/hooks.ts";
import { affects } from "../store/queries.ts";
import type { TaskRow } from "../store/rows.ts";
import { letGo, useUnsent } from "../unsent.ts";
import { TaskList, type GroupsOf } from "./TaskList.tsx";
import { trashGroups, trashSource, type Removal, type TrashedRow } from "./trash.ts";
import css from "./Trash.module.css";
import listCss from "./TaskList.module.css";

const styles = classes(css, [
  "page",
  "find",
  "where",
  "restore",
  "unsent",
  "word",
  "text",
  "kind",
  "act",
  "foot",
]);
const list = classes(listCss, ["line", "more"]);

/** No open task belongs to the Trash: its rows are the query's. */
const NONE = (): boolean => false;
const QUERY = { kind: "trash" } as const;
/** How far below the screen the list's end starts the next page: one screen ahead. */
const AHEAD = "0px 0px 100% 0px";
/** Typing in the find field reads once the person pauses this long. */
const FIND_MS = 250;

export interface TrashProps {
  /** The task the URL holds expanded. */
  readonly task?: string | undefined;
  readonly onExpand: (task: TaskRow | undefined, gone?: boolean) => void;
}

export function TrashPage({ task, onExpand }: TrashProps) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(typed.trim());
    }, FIND_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [typed]);
  return (
    <div className={styles.page}>
      <input
        type="search"
        className={styles.find}
        data-part="trash-find"
        aria-label={t("trash.find")}
        placeholder={t("trash.find")}
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
      />
      {/* Another search is another query: it starts at its top. */}
      <TrashList key={q} q={q} task={task} onExpand={onExpand} />
      <UnsentWords />
      <p className={styles.foot}>{t("trash.footer")}</p>
    </div>
  );
}

/** "14:02" today, "23 Nov, 14:02" another day: when a change moved its tasks. */
function whenOf(at: string, clock: Clock): string {
  const ms = Date.parse(at);
  const time = formatInstant(ms, clock, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = formatInstant(ms, clock, { year: "numeric", month: "2-digit", day: "2-digit" });
  const today = formatInstant(Date.now(), clock, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (day === today) return time;
  return `${formatInstant(ms, clock, { day: "numeric", month: "short" })}, ${time}`;
}

/** A change's heading: who moved how many tasks there, when, and why when it was given. */
function changeTitle(removal: Removal, clock: Clock, t: Translate): string {
  const values = {
    who: removal.by === "user" ? "user" : "other",
    by: removal.by,
    count: removal.count,
    when: whenOf(removal.at, clock),
  };
  return removal.reason === undefined
    ? t("trash.change", values)
    : t("trash.changeWhy", { ...values, why: removal.reason });
}

/** Where a task in the Trash was: its area and project, else the list it was in. */
function whereOf(row: TrashedRow, t: Translate): string {
  const group = [row.area, row.project].filter((name) => name !== undefined).join(" / ");
  if (group !== "") return group;
  if (row.lifecycle !== "active") return t("nav.completed");
  return row.inbox ? t("nav.inbox") : t("nav.open");
}

function TrashList({ q, task, onExpand }: TrashProps & { readonly q: string }) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const edits = useEdits();
  const clock = useClock(false);
  const source = useMemo(() => trashSource((input) => api.client.task.trash(input), q), [api, q]);
  const { state, query } = usePagedQuery(QUERY, source);
  // "Restore these": the change's tasks still in the Trash, as one change with its own Undo.
  const restoreChange = useCallback(
    (removal: Removal) => {
      edits
        .write(
          (request) =>
            api.client.task.delete({ restore: true, change: removal.id, request_id: request }),
          (value) => {
            if (!("moved" in value)) return { id: "toast.restoredSome" };
            const already = value.already?.length ?? 0;
            const later = value.later?.length ?? 0;
            return value.moved.length === 0
              ? undefined
              : {
                  id: "toast.restoredChange",
                  values: { count: value.moved.length, already, later },
                };
          },
        )
        .then(
          (value) => {
            if (!("moved" in value) || value.moved.length > 0) return;
            const already = value.already?.length ?? 0;
            const later = value.later?.length ?? 0;
            say(t("toast.restoredNone", { already, later }));
          },
          (error: unknown) => {
            if (live.failed(error)) return;
            const readOnly = readOnlyReason(error);
            if (readOnly !== undefined) {
              say(t("edit.notSavedReadOnly", { why: sayMsg(t, readOnlyWhy(readOnly)) }));
              return;
            }
            const reason = (error as { data?: { reason?: unknown } }).data?.reason;
            say(
              t(reason === "change_gone" ? "toast.restoreChangeGone" : "toast.restoreChangeFailed"),
            );
          },
        );
    },
    [api, edits, live, say, t],
  );
  const face = useMemo(
    () => ({
      title: (removal: Removal) => changeTitle(removal, clock, t),
      restore: (removal: Removal) => ({
        label: t("trash.restoreThese", { count: removal.count }),
        run: () => {
          restoreChange(removal);
        },
      }),
    }),
    [clock, t, restoreChange],
  );
  const groups = useCallback<GroupsOf>(
    (_tasks, held) => trashGroups(state.rows, face, held),
    [state.rows, face],
  );
  const beneath = useCallback(
    (row: TaskRow) =>
      row.deleted_at === undefined ? undefined : (
        <Where
          row={row as TrashedRow}
          onRestore={() => {
            edits.restore(row);
          }}
        />
      ),
    [edits],
  );
  const more = useRef<HTMLButtonElement>(null);
  const [holding, setHolding] = useState(false);
  const next = state.phase === "ready" && state.more;
  useEffect(() => {
    const button = more.current;
    if (!next || button === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void query.more();
      },
      { rootMargin: AHEAD },
    );
    observer.observe(button);
    return () => {
      observer.disconnect();
    };
  }, [next, state.rows, query]);
  return (
    <>
      <TaskList
        key="trash"
        view="trash"
        grouping="area"
        filter={NONE}
        groups={groups}
        clock={clock}
        empty={
          state.phase !== "ready" ? undefined : t(q === "" ? "view.empty.trash" : "trash.noMatch")
        }
        expand={task}
        onExpand={onExpand}
        beneath={beneath}
      />
      {state.phase === "failed" ? (
        <p className={list.line} role="status">
          {t("trash.failed")}
          <button
            type="button"
            className={list.more}
            onClick={() => {
              void query.refresh();
            }}
          >
            {t("edit.tryAgain")}
          </button>
        </p>
      ) : null}
      {(state.more && state.phase !== "failed") || holding ? (
        <button
          ref={more}
          type="button"
          className={list.more}
          aria-disabled={state.phase === "loading" || !state.more || undefined}
          onFocus={() => {
            setHolding(true);
          }}
          onBlur={() => {
            setHolding(false);
          }}
          onClick={() => {
            void query.more();
          }}
        >
          {t(state.more ? "completed.more" : "completed.all")}
        </button>
      ) : null}
    </>
  );
}

/**
 * After a Restore, focus moves to the next row, or else the previous one, or else the view, as after
 * a check-off: a row keeps its place while it holds focus, and the restored task leaves the list.
 */
function focusAfter(from: HTMLElement): void {
  const rows = [
    ...(from.closest("[data-list]")?.querySelectorAll<HTMLElement>("li[data-task]") ?? []),
  ];
  const own = from.closest<HTMLElement>("li[data-task]");
  const at = own === null ? -1 : rows.indexOf(own);
  const next = rows[at + 1] ?? (at > 0 ? rows[at - 1] : undefined);
  (
    next?.querySelector<HTMLElement>('[data-part="title"]') ?? document.getElementById("main")
  )?.focus({
    preventScroll: true,
  });
}

/** Beneath a row of the Trash: where its task was, and its own Restore. */
function Where({ row, onRestore }: { readonly row: TrashedRow; readonly onRestore: () => void }) {
  const t = useT();
  return (
    <span className={styles.where} data-part="trash-where">
      <span dir="auto">{whereOf(row, t)}</span>
      <button
        type="button"
        className={styles.restore}
        data-part="restore"
        aria-label={t("trash.restoreLabel", { ref: row.ref })}
        onClick={(event) => {
          focusAfter(event.currentTarget);
          onRestore();
        }}
      >
        {t("trash.restore")}
      </button>
    </span>
  );
}

/** A task ID as the service gives one: what is kept under another name is not asked about. */
const TASK_ID = /^t_[0-9a-hjkmnp-tv-z]{26}$/u;
/** Tasks per read of the Trash by task. */
const PAGE = 200;
/** Reads of a task's digest at once, for the words of tasks neither listed nor in the Trash. */
const AT_ONCE = 8;

const isGone = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";

/**
 * Of `tasks`, none of them in the live store: those in the Trash, with their reference, and those
 * the space does not have now (null). Every one is asked about. A task the space has outside the
 * Trash (a finished one) is neither: its words are its card's.
 */
async function whereAre(
  client: Client,
  tasks: readonly string[],
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  for (let at = 0; at < tasks.length; at += PAGE) {
    const page = await client.task.trash({ tasks: tasks.slice(at, at + PAGE), limit: PAGE });
    for (const row of page.rows) found.set(row.id, row.ref);
  }
  const rest = tasks.filter((task) => !found.has(task));
  for (let at = 0; at < rest.length; at += AT_ONCE) {
    await Promise.all(
      rest.slice(at, at + AT_ONCE).map((task) =>
        client.task.get({ task }).then(
          () => undefined,
          (error: unknown) => {
            if (isGone(error)) found.set(task, null);
          },
        ),
      ),
    );
  }
  return found;
}

/**
 * The words this browser holds for a task in the Trash or one the space does not have now (a
 * backup restored over it, or a creation undone), of every kind, from any tab (unsent.ts). Each
 * stays, with Copy and Discard, until the person discards it; Discard removes the value shown and
 * nothing else, so a newer one typed in another tab stays. Where each task is comes from the
 * service, asked again whenever a task is removed or restored or a snapshot replaces what the page
 * knew: a task that is live again leaves at once, and its words are its card's.
 */
function UnsentWords() {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const { tasks: known } = useLive();
  const space = live.spaceId ?? "";
  const words = useUnsent(space).filter((word) => TASK_ID.test(word.task));
  const [where, setWhere] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [round, setRound] = useState(0);
  useEffect(
    () =>
      live.onChanges(({ changes, reset }) => {
        const moved = changes.filter((change) => affects(QUERY, change));
        const back = moved
          .filter((change) => (change.after as TaskRow | undefined)?.deleted_at === undefined)
          .map((change) => change.id);
        if (back.length > 0) {
          setWhere((now) => new Map([...now].filter(([task]) => !back.includes(task))));
        }
        if (reset || moved.length > 0) setRound((n) => n + 1);
      }),
    [live],
  );
  const asked = [...new Set(words.map((word) => word.task))]
    .filter((task) => !known.has(task))
    .sort()
    .join(" ");
  useEffect(() => {
    if (asked === "") return;
    let current = true;
    whereAre(api.client, asked.split(" ")).then(
      (found) => {
        if (current) setWhere(found);
      },
      (error: unknown) => {
        live.failed(error);
      },
    );
    return () => {
      current = false;
    };
  }, [api, live, asked, round]);
  const shown = words.filter((word) => where.has(word.task) && !known.has(word.task));
  if (shown.length === 0) return null;
  const textOf = (word: (typeof shown)[number]): string =>
    word.kind !== "edit"
      ? word.text
      : typeof word.shown === "string"
        ? word.shown
        : sayMsg(t, word.shown);
  return (
    <section className={styles.unsent} aria-label={t("trash.unsent")}>
      <h2 className={list.line}>{t("trash.unsent")}</h2>
      <ul>
        {shown.map((word) => (
          <li key={word.key} className={styles.word} data-part="unsent-words" data-kind={word.kind}>
            <span>
              {where.get(word.task) ??
                (word.kind === "edit" ? word.ref : undefined) ??
                t("trash.unsentNoTask")}
            </span>
            <span className={styles.kind}>{t("trash.unsentKind", { kind: word.kind })}</span>
            <span className={styles.text} dir="auto">
              {textOf(word)}
            </span>
            <button
              type="button"
              className={styles.act}
              onClick={() => {
                navigator.clipboard.writeText(textOf(word)).then(
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
            <button
              type="button"
              className={styles.act}
              onClick={() => {
                letGo(space, word);
              }}
            >
              {t("edit.discard")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
