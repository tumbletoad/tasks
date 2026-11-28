// The content of each route: Today's sections (views/Today.tsx), each status view's list grouped
// as A5 3.5 says (`VIEW_LIST`), the area and project views, Completed (views/Completed.tsx),
// Agents (views/Agents.tsx) and Activity (views/Activity.tsx). No view has a heading (U3); the
// sidebar's active item and the tab's title name it.
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
import { topLevel, trail, type TaskRow } from "@ttasks/client/store";
import type { TaskFacts } from "../task/detail.ts";
import { ArchivedLine } from "./Archived.tsx";
import { useTitle, useToast } from "./frame.ts";
import { hostOf, type Host } from "./host.ts";
import css from "./pages.module.css";
import {
  groupCounts,
  isCounted,
  LANDING,
  underFilter,
  VIEW_LABEL,
  VIEW_LIST,
  viewFilter,
  type View,
  areaGroups,
  projectGroups,
} from "@ttasks/client/today";
import { ProjectFolder } from "../folder/ProjectFolder.tsx";
import { ActivityPage } from "../views/Activity.tsx";
import { AgentsPage } from "../views/Agents.tsx";
import { CompletedPage } from "../views/Completed.tsx";
import { TaskList } from "../views/TaskList.tsx";
import { TodayPage } from "../views/Today.tsx";
import { TrashPage } from "../views/Trash.tsx";
import { classes } from "./css.ts";
import { SearchPage as SearchResults } from "../views/Search.tsx";
import { NodeLibrary, NodeTabs } from "../library/Library.tsx";

const styles = classes(css, ["line"]);

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
        // A search keeps its query in the history entry (route.ts).
        state: true,
      });
    },
    [navigate],
  );
}

export function ViewPage({
  view,
  task,
}: {
  readonly view: View;
  readonly task?: string | undefined;
}) {
  const t = useT();
  useTitle(t(VIEW_LABEL[view]));
  const onExpand = useExpandInUrl();
  const filter = useMemo(() => viewFilter(view), [view]);
  if (view === "today") {
    return <TodayPage task={task} onExpand={onExpand} />;
  }
  if (view === "completed") return <CompletedPage task={task} onExpand={onExpand} />;
  if (view === "agents") return <AgentsPage task={task} onExpand={onExpand} />;
  if (view === "activity") return <ActivityPage />;
  if (view === "trash") return <TrashPage task={task} onExpand={onExpand} />;
  if (view === "library") return <NodeLibrary node={SPACE_NODE} />;
  if (filter === undefined || !isCounted(view)) return null;
  const list = VIEW_LIST[view];
  // Keyed by the view: another view starts at its top with nothing expanded.
  return (
    <TaskList
      key={view}
      view={view}
      grouping={list.grouping}
      group={list.group}
      filter={filter}
      empty={t(list.empty)}
      expand={task}
      onExpand={onExpand}
    />
  );
}

const SPACE_NODE = { kind: "space" } as const;

/** The open tasks a group's view lists, as the side menu counts them; unknown before the rows. */
function useTaskCount(group: string): number | undefined {
  const state = useLive();
  const known = state.space !== undefined;
  return useMemo(
    () => (known ? (groupCounts(state.tasks.values(), state.nodes).get(group) ?? 0) : undefined),
    [known, state.tasks, state.nodes, group],
  );
}

/** An area's page: its tasks, its projects' included, or its Library. */
export function AreaPage({
  area,
  task,
  tab = "tasks",
}: {
  readonly area: string;
  readonly task?: string | undefined;
  readonly tab?: "tasks" | "library";
}) {
  const t = useT();
  const state = useLive();
  const onExpand = useExpandInUrl();
  const [row, below] = trail(state.nodes, area);
  const node = useMemo(() => ({ kind: "area", id: area }) as const, [area]);
  const count = useTaskCount(area);
  useTitle(row?.title ?? "");
  const filter = useMemo(() => underFilter(state.nodes, area), [state.nodes, area]);
  const space = state.space?.id;
  if (row === undefined || space === undefined) {
    return <p className={styles.line}>{t("view.noArea")}</p>;
  }
  // A project made without an area, moved into one since: its page is the project's now.
  if (below !== undefined) {
    const params = { space, area: row.id, project: below.id };
    return tab === "library" ? (
      <Navigate to="/s/$space/area/$area/project/$project/library" params={params} replace />
    ) : (
      <Navigate
        to="/s/$space/area/$area/project/$project"
        params={params}
        search={task === undefined ? {} : { task }}
        replace
      />
    );
  }
  // An archived area's view begins with the way back.
  return (
    <>
      <ArchivedLine area={area} />
      <NodeTabs node={node} tab={tab} tasks={count} />
      {tab === "library" ? (
        <NodeLibrary key={area} node={node} />
      ) : (
        <TaskList
          key={area}
          view="area"
          grouping="project"
          group={areaGroups}
          filter={filter}
          empty={t("view.empty")}
          expand={task}
          onExpand={onExpand}
        />
      )}
    </>
  );
}

/**
 * A project's page, by its ID alone: its tasks, its archived line and its folder are the project's
 * as it is now. Its address names its area; an address whose area part no longer fits (the project
 * moved, or the move was undone) is replaced by the present one, and a project at the top opens as
 * an area.
 */
export function ProjectPage({
  space,
  project,
  area: addressed,
  task,
  tab = "tasks",
}: {
  readonly space: string;
  readonly project: string;
  /** The area the address names. */
  readonly area?: string;
  readonly task?: string | undefined;
  readonly tab?: "tasks" | "library";
}) {
  const t = useT();
  const state = useLive();
  const onExpand = useExpandInUrl();
  const [top, row] = trail(state.nodes, project);
  const node = useMemo(() => ({ kind: "project", id: project }) as const, [project]);
  const count = useTaskCount(project);
  useTitle(row?.title ?? "");
  const filter = useMemo(() => underFilter(state.nodes, project), [state.nodes, project]);
  if (top === undefined) return <p className={styles.line}>{t("view.noProject")}</p>;
  const search = task === undefined ? {} : { task };
  if (row === undefined) {
    return tab === "library" ? (
      <Navigate to="/s/$space/area/$area/library" params={{ space, area: top.id }} replace />
    ) : (
      <Navigate
        to="/s/$space/area/$area"
        params={{ space, area: top.id }}
        search={search}
        replace
      />
    );
  }
  const area = top.id;
  if (area !== addressed) {
    if (tab === "library") {
      return (
        <Navigate
          to="/s/$space/area/$area/project/$project/library"
          params={{ space, area, project }}
          replace
        />
      );
    }
    return (
      <Navigate
        to="/s/$space/area/$area/project/$project"
        params={{ space, area, project }}
        search={search}
        replace
      />
    );
  }
  // An archived project's view begins with the way back, then its folder on this machine.
  return (
    <>
      <ArchivedLine area={area} project={project} />
      <NodeTabs node={node} tab={tab} tasks={count} />
      {tab === "library" ? (
        <NodeLibrary key={project} node={node} />
      ) : (
        <>
          <ProjectFolder key={project} project={project} />
          <TaskList
            key={`list/${project}`}
            view="area"
            grouping="project"
            group={projectGroups}
            filter={filter}
            empty={t("view.empty")}
            expand={task}
            onExpand={onExpand}
          />
        </>
      )}
    </>
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
      ? hostOf({ ...row, area: trail(state.nodes, row.parent)[0]?.id })
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
              area: topLevel(state.nodes).find((a) => a.title === known.facts.area)?.id,
              deleted: known.facts.deleted !== undefined,
            });
  const space = state.space?.id;
  const ref = row?.ref ?? (known !== undefined && "facts" in known ? known.facts.ref : task);
  useEffect(() => {
    if (resolved?.kind === "gone") say(t("task.gone"));
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
      // In the Trash: there, expanded, with Restore.
      return (
        <Navigate
          to="/s/$space/$view"
          params={{ space, view: "trash" }}
          search={{ task: ref }}
          replace
        />
      );
    case "gone":
    case "error":
      return <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />;
  }
}

/** The search route: the top field's search, its expanded result in the URL as in a view. */
export function SearchPage({
  q,
  task,
}: {
  readonly q?: string | undefined;
  readonly task?: string | undefined;
}) {
  const onExpand = useExpandInUrl();
  return <SearchResults q={q ?? ""} task={task} onExpand={onExpand} />;
}
