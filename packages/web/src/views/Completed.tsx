// Completed: finished tasks in "Checked off" and one group per completion month, read in
// pages (completed.ts) because the live store never holds them. The paged query restarts
// whenever the feed could change which tasks it holds or their order (queries.ts: a lifecycle,
// wrap or deletion change), so a task that is completed while the view is open appears in it; the
// one list keeps focus and scroll on the same task across the restart.
import { useCallback, useContext, useMemo, useRef } from "react";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useClock } from "../row/useClock.ts";
import { usePagedQuery } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import { completedGroups, completedSource, rowOfSearch } from "./completed.ts";
import css from "./TaskList.module.css";
import { TaskList, type GroupsOf } from "./TaskList.tsx";

const styles = classes(css, ["line", "more"]);

/** No open task belongs to Completed: its rows are the query's. */
const NONE = (): boolean => false;
const QUERY = { kind: "completed" } as const;

export interface CompletedProps {
  /** The task the URL holds expanded. */
  readonly task?: string | undefined;
  readonly onExpand: (task: TaskRow | undefined, gone?: boolean) => void;
}

export function CompletedPage({ task, onExpand }: CompletedProps) {
  const t = useT();
  const { api, live } = useContext(Session);
  const clock = useClock(false);
  const now = useRef(clock);
  now.current = clock;
  // Read once per mount (usePagedQuery): the clock and the live areas are read when a page is.
  const source = useMemo(
    () =>
      completedSource({
        search: (input) => api.client.task.search(input),
        clock: () => now.current,
        rowOf: (row, checkedOff) => {
          const { areas, projects } = live.getState();
          return rowOfSearch(row, areas, projects, checkedOff);
        },
      }),
    [api, live],
  );
  const { state, query } = usePagedQuery(QUERY, source);
  const groups = useCallback<GroupsOf>(
    (_tasks, held) => completedGroups(state.rows, clock, held?.task),
    [state.rows, clock],
  );
  return (
    <>
      <TaskList
        key="completed"
        view="completed"
        grouping="flat"
        filter={NONE}
        groups={groups}
        clock={clock}
        empty={state.phase === "ready" ? t("view.empty.completed") : undefined}
        expand={task}
        onExpand={onExpand}
      />
      {state.phase === "failed" ? (
        <p className={styles.line} role="status">
          {t("completed.failed")}
          <button
            type="button"
            className={styles.more}
            onClick={() => {
              void query.refresh();
            }}
          >
            {t("edit.tryAgain")}
          </button>
        </p>
      ) : null}
      {state.more && state.phase !== "failed" ? (
        <button
          type="button"
          className={styles.more}
          aria-disabled={state.phase === "loading" || undefined}
          onClick={() => {
            void query.more();
          }}
        >
          {t("completed.more")}
        </button>
      ) : null}
    </>
  );
}
