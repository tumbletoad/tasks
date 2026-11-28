// The content of each route: Today's sections (views/Today.tsx), each status view's list grouped
// by `VIEW_LIST`, Completed (views/Completed.tsx),
// Agents (views/Agents.tsx) and Activity (views/Activity.tsx). No view has a heading (U3); the
// sidebar's active item and the tab's title name it.
//
// A view holds its expanded task in the URL (`?task=<ref>`): expanding a row writes it
// there without a new history entry, collapsing removes it, and a reload, Back and Forward expand
// the same task again. A task link (`/s/:space/task/:id`) resolves to its host view (host.ts) and
// lands there with the task expanded, so the host view's own list shows it, injected when the
// view's rows do not hold it (a completed task in Completed). A project's screen is
// ProjectScreen.tsx.
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import { nodeNamed, type Nodes, type TaskRow } from "@ttasks/client/store";
import type { TaskFacts } from "../task/detail.ts";
import { useTitle, useToast } from "./frame.ts";
import { hostOf, type Host } from "./host.ts";
import {
  isCounted,
  LANDING,
  VIEW_LABEL,
  VIEW_LIST,
  viewFilter,
  type View,
} from "@ttasks/client/today";
import { ActivityPage } from "../views/Activity.tsx";
import { AgentsPage } from "../views/Agents.tsx";
import { CompletedPage } from "../views/Completed.tsx";
import { TaskList } from "../views/TaskList.tsx";
import { TodayPage } from "../views/Today.tsx";
import { TrashPage } from "../views/Trash.tsx";
import { SearchPage as SearchResults } from "../views/Search.tsx";
import { NodeLibrary } from "../library/Library.tsx";

/**
 * Writes the expanded task into the view's URL. Expanding replaces the entry; collapsing pushes
 * the view's own route, so Back returns to the task. A task that does not exist leaves
 * the URL without a step to come back to.
 */
export function useExpandInUrl(): (task: TaskRow | undefined, gone?: boolean) => void {
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

/** The project a read names by its area's and its project's names; none for the space. */
function projectNamed(nodes: Nodes, area?: string, project?: string): string | undefined {
  const id = nodeNamed(nodes, area, project);
  return nodes.get(id)?.kind === "project" ? id : undefined;
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
      ? hostOf({
          ...row,
          project: state.nodes.get(row.parent)?.kind === "project" ? row.parent : undefined,
        })
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
              project: projectNamed(state.nodes, known.facts.area, known.facts.project),
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
    case "project":
      return (
        <Navigate
          to="/s/$space/project/$project"
          params={{ space, project: resolved.project }}
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
