// The content of each route: Today's sections (views/Today.tsx), and for the views whose own step
// is still to come (A7 3.12) the grouped list filtered to what the view holds, or a plain line for
// a view that has no list yet. No view has a heading (U3); the sidebar's active item and the tab's
// title name it.
//
// A view holds its expanded task in the URL (`?task=<ref>`, A5 3.3): expanding a row writes it
// there without a new history entry, collapsing removes it, and a reload, Back and Forward expand
// the same task again. A task link (`/s/:space/task/:id`) resolves to its host view (host.ts) and
// lands there with the task expanded, so the host view's own list shows it, injected when the
// view's rows do not hold it (a completed task in Completed).
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import type { TaskFacts } from "../task/detail.ts";
import { useTitle, useToast } from "./frame.ts";
import { hostOf, type Host } from "./host.ts";
import css from "./pages.module.css";
import { areaFilter, LANDING, VIEW_LABEL, viewFilter, type View } from "./views.ts";
import { TaskList } from "../views/TaskList.tsx";
import { TodayPage } from "../views/Today.tsx";
import { classes } from "./css.ts";

const styles = classes(css, ["line"]);

function NotBuilt() {
  const t = useT();
  return <p className={styles.line}>{t("view.notBuilt")}</p>;
}

/**
 * Writes the expanded task into the view's URL. Expanding replaces the entry; collapsing pushes
 * the view's own route, so Back returns to the task (A5 3.3). A task that does not exist leaves
 * the URL without a step to come back to.
 */
function useExpandInUrl(): (task: TaskRow | undefined, gone?: boolean) => void {
  const navigate = useNavigate();
  return useCallback(
    (task: TaskRow | undefined, gone = false) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const rest = Object.fromEntries(Object.entries(prev).filter(([key]) => key !== "task"));
          return task === undefined ? rest : { ...rest, task: task.ref };
        },
        replace: task !== undefined || gone,
      });
    },
    [navigate],
  );
}

/** Writes Today's chosen day into the URL (`?day=`), or takes it out: a step Back undoes. */
function useDayInUrl(): (day: string | undefined) => void {
  const navigate = useNavigate();
  return useCallback(
    (day: string | undefined) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => {
          const rest = Object.fromEntries(Object.entries(prev).filter(([key]) => key !== "day"));
          return day === undefined ? rest : { ...rest, day };
        },
      });
    },
    [navigate],
  );
}

/** Completed lists nothing yet (M5.05): it holds only the task a link named. */
const NONE = () => false;

export function ViewPage({
  view,
  task,
  day,
}: {
  readonly view: View;
  readonly task?: string | undefined;
  /** Today's chosen day in the strip (`?day=`). */
  readonly day?: string | undefined;
}) {
  const t = useT();
  useTitle(t(VIEW_LABEL[view]));
  const onExpand = useExpandInUrl();
  const onDay = useDayInUrl();
  const filter = useMemo(() => viewFilter(view), [view]);
  if (view === "today") {
    return <TodayPage task={task} day={day} onExpand={onExpand} onDay={onDay} />;
  }
  if (view === "completed" && task !== undefined) {
    return (
      <TaskList
        key={view}
        view="open"
        filter={NONE}
        empty={t("view.notBuilt")}
        expand={task}
        onExpand={onExpand}
      />
    );
  }
  if (filter === undefined || view === "completed" || view === "agents") return <NotBuilt />;
  // Keyed by the view: another view starts at its top with nothing expanded.
  return (
    <TaskList
      key={view}
      view={view}
      filter={filter}
      empty={t("view.empty")}
      expand={task}
      onExpand={onExpand}
    />
  );
}

export function AreaPage({
  area,
  project,
  task,
}: {
  readonly area: string;
  readonly project?: string;
  readonly task?: string | undefined;
}) {
  const t = useT();
  const state = useLive();
  const onExpand = useExpandInUrl();
  const row = state.areas.get(area);
  const named = project === undefined ? row?.title : state.projects.get(project)?.title;
  useTitle(named ?? "");
  const filter = useMemo(() => areaFilter(area, project), [area, project]);
  if (row === undefined) return <p className={styles.line}>{t("view.noArea")}</p>;
  return (
    <TaskList
      key={`${area}/${project ?? ""}`}
      view="area"
      filter={filter}
      empty={t("view.empty")}
      expand={task}
      onExpand={onExpand}
    />
  );
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";

/**
 * A task link (U26): the task's host view, with the task expanded. A task in the live rows is
 * placed at once; another is read with `task.get` (a completed or archived task). One that is not
 * in the space (purged, or never was) lands on the space's landing view with a toast.
 */
export function TaskPage({ task }: { readonly task: string }) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const state = useLive();
  useTitle(t("nav.task"));
  /** What `task.get` said of a task the live rows do not hold, for this link's task. */
  const [read, setRead] = useState<
    { task: string; facts: TaskFacts } | { task: string; failed: "gone" | "error" } | undefined
  >(undefined);
  const asked = useRef<string | undefined>(undefined);

  const row = useMemo(
    () => [...state.tasks.values()].find((r) => r.ref === task || r.id === task),
    [state.tasks, task],
  );
  // The read depends on the task alone: a feed frame that changes the areas meanwhile does not
  // cancel it. The host is worked out at render, from the answer and the live areas.
  useEffect(() => {
    if (row !== undefined || state.phase !== "live" || asked.current === task) return;
    asked.current = task;
    let current = true;
    let answered = false;
    api.client.task
      .get({ task })
      .then((answer) => {
        answered = true;
        if (!current) return;
        setRead(answer.view === "digest" ? { task, facts: answer.task } : { task, failed: "gone" });
      })
      .catch((error: unknown) => {
        answered = true;
        if (!current || live.failed(error)) return;
        if (!isNotFound(error)) say(t("thread.failed"));
        setRead({ task, failed: isNotFound(error) ? "gone" : "error" });
      });
    return () => {
      current = false;
      // A read this render gave up on is asked again by the next one.
      if (!answered && asked.current === task) asked.current = undefined;
    };
  }, [row, state.phase, task, api, live, say, t]);

  const known = read?.task === task ? read : undefined;
  const resolved: Host | { readonly kind: "error" } | undefined =
    row !== undefined
      ? hostOf(row)
      : known === undefined
        ? undefined
        : "failed" in known
          ? known.failed === "gone"
            ? { kind: "gone" }
            : { kind: "error" }
          : hostOf({
              lifecycle: known.facts.lifecycle,
              inbox: known.facts.inbox,
              status: known.facts.status,
              area_id: [...state.areas.values()].find((a) => a.title === known.facts.area)?.id,
            });
  const space = state.space?.id;
  const ref = row?.ref ?? (known !== undefined && "facts" in known ? known.facts.ref : task);
  useEffect(() => {
    if (resolved?.kind === "gone") say(t("task.gone"));
    if (resolved?.kind === "trash") say(t("task.inTrash"));
  }, [resolved?.kind, say, t]);
  if (resolved === undefined || space === undefined) return null;
  switch (resolved.kind) {
    case "view":
      return (
        <Navigate
          to="/s/$space/$view"
          params={{ space, view: resolved.view }}
          search={{ task: ref }}
          replace
        />
      );
    case "area":
      return (
        <Navigate
          to="/s/$space/area/$area"
          params={{ space, area: resolved.area }}
          search={{ task: ref }}
          replace
        />
      );
    case "trash":
    case "gone":
    case "error":
      return <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />;
  }
}

export function SearchPage() {
  const t = useT();
  useTitle(t("nav.search"));
  return <NotBuilt />;
}
