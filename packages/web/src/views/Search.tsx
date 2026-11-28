// The search results (search.ts has the pure parts): what the top field's search finds, in the one
// list, so every row expands, edits and checks off as in any view. The results are frozen: a
// change that could alter what matches shows "Results changed" with Refresh instead of moving
// rows, and an expired cursor starts the search again by itself. A space without the word index
// (an older space this build could not update) says so and searches its filters alone.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { askField, isWanted, onWantResults, wantResults } from "../app/field.ts";
import { classes } from "../app/css.ts";
import { useTitle } from "../app/frame.ts";
import { Session } from "../context.ts";
import { useEditState } from "../edit/useEdits.ts";
import { useT } from "../i18n/intl.tsx";
import { pageDay, useClock } from "../row/useClock.ts";
import { useLive, usePagedQuery } from "../store/hooks.ts";
import type { TaskRow } from "@ttasks/client/store";
import {
  filtersOnly,
  hasWords,
  isExpired,
  isUnindexed,
  rowOfFound,
  searchFields,
  searchGroups,
  searchSource,
  sortsByEffort,
  type Found,
  type SearchRow,
  wordsOf,
} from "./search.ts";
import css from "./Search.module.css";
import { TaskList, type GroupsOf } from "./TaskList.tsx";

const styles = classes(css, ["line", "status", "action", "foot", "offer"]);

/** Spaces this tab found without the word index: their searches leave the words out at once. */
const unindexedSpaces = new Set<string>();

export interface SearchPageProps {
  /** The search as the URL holds it. */
  readonly q: string;
  readonly task?: string | undefined;
  readonly onExpand: (task: TaskRow | undefined, gone?: boolean) => void;
}

export function SearchPage({ q, task, onExpand }: SearchPageProps) {
  const t = useT();
  const space = useLive().space?.id ?? "";
  useTitle(t("nav.search"));
  const [unindexed, setUnindexed] = useState(() => unindexedSpaces.has(space));
  const query = q.trim();
  const words = hasWords(query);
  const title = wordsOf(query);
  const onUnindexed = useCallback(() => {
    unindexedSpaces.add(space);
    setUnindexed(true);
  }, [space]);
  if (query === "") return <p className={styles.line}>{t("search.hint")}</p>;
  const asked = unindexed ? filtersOnly(query) : query;
  return (
    <>
      {/* First, so that nothing the search answers later moves it from under the pointer. */}
      {title === "" ? null : (
        <p className={styles.offer}>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              askField({ kind: "add", text: title });
            }}
          >
            <span dir="auto">{t("search.addInstead", { text: title })}</span>
          </button>
        </p>
      )}
      {unindexed && words ? (
        <p className={styles.line} role="status">
          {asked === "" ? t("search.noIndex") : t("search.noIndexFilters", { filters: asked })}
        </p>
      ) : null}
      {asked === "" ? null : (
        <Results
          key={asked}
          q={asked}
          typed={query}
          task={task}
          onExpand={onExpand}
          onUnindexed={onUnindexed}
        />
      )}
    </>
  );
}

interface ResultsProps extends SearchPageProps {
  /** The search as the person typed it, trimmed: what Enter in the field asks focus for. */
  readonly typed: string;
  readonly onUnindexed: () => void;
}

/** The first result's title, the one in the list's tab order. */
function firstResult(): HTMLElement | null {
  return (
    document
      .getElementById("main")
      ?.querySelector<HTMLElement>('li[data-current="true"] [data-part="title"]') ?? null
  );
}

/** How many frames the results wait for their first row to be drawn before giving up focus. */
const FOCUS_FRAMES = 10;

function Results({ q, typed, task, onExpand, onUnindexed }: ResultsProps) {
  const t = useT();
  const { api, live } = useContext(Session);
  const state = useLive();
  // Read once per mount: a new search is a new key.
  const [def] = useState(() => ({ kind: "search" as const, fields: searchFields(q) }));
  const [sources] = useState(() => {
    // A search counts `today` in the page's zone, as the views do; its next pages keep that zone.
    const search = (input: Parameters<typeof api.client.task.search>[0]) =>
      api.client.task.search(
        input.cursor === undefined ? { ...input, time_zone: pageDay().timeZone } : input,
      );
    const rowOf = (row: SearchRow, found: Found, read: number) => {
      return rowOfFound(row, found, live.getState().nodes, read);
    };
    return {
      open: searchSource({ search, q, found: "open", rowOf, all: true }),
      finished: searchSource({ search, q, found: "finished", rowOf }),
    };
  });
  const options = useMemo(() => ({ expired: isExpired }), []);
  const open = usePagedQuery(def, sources.open, options);
  const done = usePagedQuery(def, sources.finished, options);

  const failed = [open.state, done.state].find((s) => s.phase === "failed");
  const noIndex = failed !== undefined && isUnindexed(failed.error);
  useEffect(() => {
    if (noIndex) onUnindexed();
  }, [noIndex, onUnindexed]);

  // The rows the list may hold: agents' changes to them are announced, a check-off by someone
  // else holds, and nothing else of the space's joins.
  const shown = useRef(new Set<string>());
  shown.current = new Set([...open.state.rows, ...done.state.rows].map((row) => row.id));
  const filter = useCallback((row: TaskRow) => shown.current.has(row.id), []);
  // A task this tab checked off or moved to the Trash shows as that leaves it, not as found.
  const { finishing } = useEditState();
  const rows = useMemo(
    () => (finishing.size === 0 ? state.tasks : new Map([...state.tasks, ...finishing])),
    [state.tasks, finishing],
  );
  const groups = useCallback<GroupsOf>(
    (_tasks, held) => searchGroups(open.state.rows, done.state.rows, rows, held, sortsByEffort(q)),
    [open.state.rows, done.state.rows, rows, q],
  );

  // A task read again is shown as the read found it, where the search found it, also once its card
  // closes.
  const onRead = useCallback(
    (row: TaskRow) => {
      open.query.take(row);
      done.query.take(row);
    },
    [open.query, done.query],
  );

  // What a search finds can depend on the day (due:today, a star, created:-7d, the ranking's
  // stars): on the page's next day it is read again, where the reader is. The answer shown is the
  // new day's only once a read of it succeeded: one that failed is read again when the feed is
  // back, as the service answers again.
  const { today, timeZone } = useClock(false);
  const day = `${today} ${timeZone}`;
  const answered = useRef(day);
  const asked = useRef(day);
  const ready = open.state.phase === "ready" && done.state.phase === "ready";
  useEffect(() => {
    if (ready) answered.current = asked.current;
  }, [ready, open.state, done.state]);
  useEffect(() => {
    const catchUp = () => {
      if (answered.current === day) return;
      const reading = [open.query, done.query].some((q) => q.getState().phase === "loading");
      if (asked.current === day && reading) return;
      asked.current = day;
      void open.query.refresh();
      void done.query.refresh();
    };
    catchUp();
    return live.onBack(catchUp);
  }, [day, live, open.query, done.query]);

  const changed = open.state.changed || done.state.changed;
  const refresh = () => {
    void open.query.refresh();
    void done.query.refresh();
  };
  const invalid =
    failed !== undefined &&
    (failed.error as { code?: unknown } | undefined)?.code === "invalid_input"
      ? (failed.error as { message?: unknown; hint?: unknown })
      : undefined;

  const openIds = new Set(open.state.rows.map((row) => row.id));
  const doneCount = done.state.rows.filter((row) => !openIds.has(row.id)).length;
  const nothing = open.state.rows.length + doneCount === 0;

  // Enter in the field asked for this search's first result: focus it once it is drawn.
  const [asks, setAsks] = useState(0);
  useEffect(
    () =>
      onWantResults(() => {
        setAsks((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let frames = 0;
    const attempt = () => {
      if (!isWanted(typed)) return;
      const title = firstResult();
      if (title !== null) {
        wantResults(undefined);
        title.focus();
      } else if (nothing || frames >= FOCUS_FRAMES) {
        wantResults(undefined);
      } else {
        frames += 1;
        frame = requestAnimationFrame(attempt);
      }
    };
    attempt();
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [ready, nothing, typed, asks]);

  return (
    <>
      {/* One line that is always there, so "Results changed" never moves the rows under it. */}
      <p className={styles.status} role="status">
        {changed ? (
          <>
            {t("search.changed")}
            <button type="button" className={styles.action} onClick={refresh}>
              {t("search.refresh")}
            </button>
          </>
        ) : ready && !nothing ? (
          t("search.count", {
            open: open.state.rows.length,
            done: doneCount,
            more: done.state.more ? "yes" : "no",
          })
        ) : null}
      </p>
      {failed !== undefined && !noIndex ? (
        <p className={styles.line} role="status">
          {invalid === undefined ? (
            <>
              {t("search.failed")}
              <button type="button" className={styles.action} onClick={refresh}>
                {t("edit.tryAgain")}
              </button>
            </>
          ) : (
            t("search.invalid", {
              message: [invalid.message, invalid.hint]
                .filter((s) => typeof s === "string")
                .join(" "),
            })
          )}
        </p>
      ) : null}
      {failed !== undefined && nothing ? null : (
        <TaskList
          key="search"
          view="today"
          grouping="flat"
          filter={filter}
          groups={groups}
          empty={ready ? t("search.none") : undefined}
          keepsFinished
          expand={task}
          onExpand={onExpand}
          onRead={onRead}
        />
      )}
      {done.state.more && done.state.phase !== "failed" ? (
        <p className={styles.foot}>
          <button
            type="button"
            className={styles.action}
            aria-disabled={done.state.phase === "loading" || undefined}
            onClick={() => {
              void done.query.more();
            }}
          >
            {t("search.more")}
          </button>
        </p>
      ) : null}
    </>
  );
}
