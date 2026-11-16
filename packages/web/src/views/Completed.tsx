// Completed: "Checked off", then one group per month, read in pages (completed.ts) because the
// live store never holds finished tasks. The paged query reads again whenever the feed could change
// which tasks it holds or their order (queries.ts: a lifecycle, wrap or deletion change), so a task
// finished while the view is open appears in it; the one list keeps focus and scroll on the same
// task across the read.
import { useCallback, useContext, useMemo } from "react";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useClock } from "../row/useClock.ts";
import { usePagedQuery } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import { completedGroups, completedSource } from "./completed.ts";
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
  const { api } = useContext(Session);
  const clock = useClock(false);
  const source = useMemo(() => completedSource((input) => api.client.task.finished(input)), [api]);
  const { state, query } = usePagedQuery(QUERY, source);
  const groups = useCallback<GroupsOf>(
    (_tasks, held) => completedGroups(state.rows, clock, held),
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
