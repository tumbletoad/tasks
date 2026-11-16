// The search results (search.ts has the pure parts): what the top field's search finds, in the one
// list, so every row expands, edits and checks off as in any view. The results are frozen: a
// change that could alter what matches shows "Results changed" with Refresh instead of moving
// rows, and an expired cursor starts the search again by itself. A space without the word index
// (an older space this build could not update) says so and searches its filters alone.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { askField } from "../app/field.ts";
import { classes } from "../app/css.ts";
import { useTitle } from "../app/frame.ts";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive, usePagedQuery } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import {
  filtersOnly,
  hasWords,
  isExpired,
  isUnindexed,
  rowOfFound,
  searchFields,
  searchGroups,
  searchSource,
  type Found,
  type SearchRow,
} from "./search.ts";
import css from "./Search.module.css";
import { TaskList, type GroupsOf } from "./TaskList.tsx";

const styles = classes(css, ["line", "status", "action", "foot"]);

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
  const onUnindexed = useCallback(() => {
    unindexedSpaces.add(space);
    setUnindexed(true);
  }, [space]);
  if (query === "") return <p className={styles.line}>{t("search.hint")}</p>;
  const asked = unindexed ? filtersOnly(query) : query;
  return (
    <>
      {unindexed && words ? (
        <p className={styles.line} role="status">
          {asked === "" ? t("search.noIndex") : t("search.noIndexFilters", { filters: asked })}
        </p>
      ) : null}
      {asked === "" ? null : (
        <Results key={asked} q={asked} task={task} onExpand={onExpand} onUnindexed={onUnindexed} />
      )}
      {words ? (
        <p className={styles.foot}>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              askField({ kind: "add", text: query });
            }}
          >
            <span dir="auto">{t("search.addInstead", { text: query })}</span>
          </button>
        </p>
      ) : null}
    </>
  );
}

interface ResultsProps extends SearchPageProps {
  readonly onUnindexed: () => void;
}

function Results({ q, task, onExpand, onUnindexed }: ResultsProps) {
  const t = useT();
  const { api, live } = useContext(Session);
  const state = useLive();
  // Read once per mount: a new search is a new key.
  const [def] = useState(() => ({ kind: "search" as const, fields: searchFields(q) }));
  const [sources] = useState(() => {
    const search = (input: Parameters<typeof api.client.task.search>[0]) =>
      api.client.task.search(input);
    const rowOf = (row: SearchRow, found: Found) => {
      const { areas, projects } = live.getState();
      return rowOfFound(row, found, areas, projects);
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
  const groups = useCallback<GroupsOf>(
    (_tasks, held) => searchGroups(open.state.rows, done.state.rows, state.tasks, held),
    [open.state.rows, done.state.rows, state.tasks],
  );

  const ready = open.state.phase === "ready" && done.state.phase === "ready";
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

  const nothing = open.state.rows.length + done.state.rows.length === 0;

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
            done: done.state.rows.length,
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
