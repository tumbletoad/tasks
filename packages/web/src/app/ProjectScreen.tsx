// A project's screen, for a project at any depth: where it sits (its breadcrumbs, each crumb to that
// project), how it stands (its status line, from its open tasks and everything below it), and its
// tabs, Tasks and Library. Under Tasks its own tasks come first, then each project below it as a
// headed group with its own short status line, which folds. An archived project's screen begins
// with the way back. At a narrow width the breadcrumbs keep the last two levels.
import { Link } from "@tanstack/react-router";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  childrenOf,
  isUnder,
  projectWithoutArea,
  trail,
  type NodeRow,
  type TaskRow,
} from "@ttasks/client/store";
import { subtreeGroups, underFilter, type Clock, type GroupTasks } from "@ttasks/client/today";
import type { EffortLevel } from "@ttasks/contracts/preferences";
import { projectStatus, type StatusPart } from "@ttasks/contracts/project-status";
import { ProjectFolder } from "../folder/ProjectFolder.tsx";
import { useT, type Translate } from "../i18n/intl.tsx";
import { LibraryLink, NodeLibrary } from "../library/Library.tsx";
import { listsOf } from "../library/lists.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { shortDate } from "../task/Facts.tsx";
import { TaskList } from "../views/TaskList.tsx";
import { useRoutineActions } from "../routine/actions.ts";
import { RoutineItem } from "../routine/Routine.tsx";
import { ArchivedLine } from "./Archived.tsx";
import { classes } from "./css.ts";
import { useTitle } from "./frame.ts";
import { useExpandInUrl } from "./pages.tsx";
import css from "./ProjectScreen.module.css";

const styles = classes(css, [
  "head",
  "crumbs",
  "far",
  "gap",
  "status",
  "tabs",
  "tab",
  "count",
  "line",
  "routines",
]);

/** A tab is current only on its own address: the task list's is not current under `/library`. */
const EXACT = { exact: true, includeSearch: false } as const;

/** The status line's words: each part that is there, in its order. */
export function statusWords(parts: readonly StatusPart[], clock: Clock, t: Translate): string[] {
  return parts.map((part) => {
    switch (part.kind) {
      case "open":
        return t("project.status.open", { count: part.count });
      case "waiting":
        return t("project.status.waiting", { count: part.count });
      case "effort":
        return part.minutes < 60
          ? t("project.status.minutes", { count: part.minutes })
          : t("project.status.hours", { count: Math.round(part.minutes / 60) });
      case "unsized":
        return t("project.status.unsized", { count: part.count });
      case "due":
        return t(part.late ? "project.status.late" : "project.status.due", {
          date: shortDate(part.date, clock, t),
        });
    }
  });
}

/** The trail from the top down to the project, each crumb to that project's same tab. */
function Crumbs({ path, tab }: { readonly path: readonly NodeRow[]; readonly tab: Tab }) {
  const t = useT();
  const { space } = useLive();
  const last = path.length - 1;
  return (
    <nav className={styles.crumbs} aria-label={t("project.crumbs")} data-part="crumbs">
      <ol>
        {path.map((node, i) => (
          <Fragment key={node.id}>
            {/* At a narrow width the levels above the last two step aside for this. */}
            {i === last - 1 && i > 0 ? (
              <li className={styles.gap} aria-hidden="true">
                {t("project.crumbsAbove")}
              </li>
            ) : null}
            <li className={i < last - 1 ? styles.far : undefined}>
              {i === last ? (
                <span aria-current="page" dir="auto">
                  {node.title}
                </span>
              ) : tab === "library" ? (
                <LibraryLink node={{ kind: "project", id: node.id }}>{node.title}</LibraryLink>
              ) : (
                <Link
                  to="/s/$space/project/$project"
                  params={{ space: space?.id ?? "", project: node.id }}
                  dir="auto"
                >
                  {node.title}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

type Tab = "tasks" | "library";

/** Tasks and Library, each with its count. */
function Tabs({
  project,
  tasks,
}: {
  readonly project: string;
  /** Its open tasks, as the side menu counts them. */
  readonly tasks: number | undefined;
}) {
  const t = useT();
  const intl = useIntl();
  const state = useLive();
  const pages = useMemo(() => {
    const lists = listsOf({ kind: "project", id: project }, state.pages.values(), "", state.nodes);
    return lists.own.length + lists.tasks.length;
  }, [project, state.pages, state.nodes]);
  const count = (n: number | undefined) =>
    n === undefined || n === 0 ? null : (
      <span className={styles.count} aria-hidden="true">
        {intl.formatNumber(n)}
      </span>
    );
  return (
    <nav className={styles.tabs} aria-label={t("library.tabs")} data-part="node-tabs">
      <Link
        to="/s/$space/project/$project"
        params={{ space: state.space?.id ?? "", project }}
        className={styles.tab}
        activeOptions={EXACT}
      >
        {t("library.tasksTab")}
        {count(tasks)}
      </Link>
      <LibraryLink node={{ kind: "project", id: project }} className={styles.tab}>
        {t("library.libraryTab")}
        {count(pages)}
      </LibraryLink>
    </nav>
  );
}

/**
 * The project's groups with each subproject's heading as the screen shows it: its short status
 * line, from the same live open tasks the screen's own line counts (a row kept on screen for
 * reading, such as a finished task's open card, counts for nothing), and its tasks out of sight
 * while the person has it folded. A heading with nothing beneath it has neither.
 */
function useGroups(
  project: string,
  open: readonly TaskRow[],
  efforts: readonly EffortLevel[],
  clock: Clock,
): GroupTasks {
  const t = useT();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((key: string) => {
    setFolded((before) => {
      const next = new Set(before);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  return useMemo(() => {
    const grouped = subtreeGroups(project);
    return (tasks, nodes) =>
      grouped(tasks, nodes).map((group) => {
        const node = group.node;
        if (node === undefined) return group;
        const parts = projectStatus(
          open.filter((task) => isUnder(nodes, task.parent, node)),
          efforts,
          clock,
        ).filter((part) => part.kind === "open" || part.kind === "due");
        const line = statusWords(parts, clock, t).join(t("project.status.between"));
        if (group.sections.length === 0) return { ...group, line };
        const shown = !folded.has(group.key);
        return {
          ...group,
          line,
          fold: {
            open: shown,
            toggle: () => {
              toggle(group.key);
            },
          },
          sections: shown ? group.sections : [],
        };
      });
  }, [project, open, folded, toggle, efforts, clock, t]);
}

export function ProjectScreen({
  project,
  task,
  tab = "tasks",
}: {
  readonly project: string;
  readonly task?: string | undefined;
  readonly tab?: Tab;
}) {
  const t = useT();
  const state = useLive();
  const onExpand = useExpandInUrl();
  const path = useMemo(() => trail(state.nodes, project), [state.nodes, project]);
  const row = path.at(-1);
  useTitle(row?.title ?? "");
  const filter = useMemo(() => underFilter(state.nodes, project), [state.nodes, project]);
  const efforts = state.scales.efforts;
  const open = useMemo(
    (): TaskRow[] => [...state.tasks.values()].filter(filter),
    [state.tasks, filter],
  );
  // A due time turns late at its minute, as its row does: then the line reads the minute's clock.
  const clock = useClock(open.some((task) => task.due_at !== undefined));
  const status = useMemo(
    () => statusWords(projectStatus(open, efforts, clock), clock, t),
    [open, efforts, clock, t],
  );
  const group = useGroups(project, open, efforts, clock);
  // The rows are known from the first snapshot on (an offline tab keeps them).
  const count = state.space === undefined ? undefined : open.length;
  if (row === undefined) return <p className={styles.line}>{t("view.noProject")}</p>;
  const below = childrenOf(state.nodes, project).some((node) => node.state !== "archived");
  // What today's operations take as a project keeps its folder on this machine.
  const folder = path.length > 1 || projectWithoutArea(project);
  return (
    <>
      <ArchivedLine project={project} />
      <div className={styles.head}>
        <Crumbs path={path} tab={tab} />
        {status.length === 0 ? null : (
          <p className={styles.status} data-part="project-status">
            {status.map((words, i) => (
              <Fragment key={i}>
                {i === 0 ? null : t("project.status.between")}
                <span>{words}</span>
              </Fragment>
            ))}
          </p>
        )}
        <Tabs project={project} tasks={count} />
      </div>
      {tab === "library" ? (
        <NodeLibrary node={{ kind: "project", id: project }} />
      ) : (
        <>
          {folder ? <ProjectFolder project={project} /> : null}
          <TaskList
            view="area"
            grouping="project"
            group={group}
            filter={filter}
            // A folded group hides its rows, not the project's tasks, and a project below is a
            // heading with nothing open too: the line says only when there is neither.
            empty={count === 0 && !below ? t("view.empty") : undefined}
            expand={task}
            onExpand={onExpand}
          />
          <ProjectRoutines project={project} clock={clock} />
        </>
      )}
    </>
  );
}

/** The project's routines, after its open tasks under a quiet line: they count in none of its views. */
function ProjectRoutines({ project, clock }: { readonly project: string; readonly clock: Clock }) {
  const t = useT();
  const state = useLive();
  const actions = useRoutineActions();
  const routines = [...state.routines.values()]
    .filter((r) => r.parent === project && r.lifecycle === "active" && r.deleted_at === undefined)
    .sort((a, b) => a.position.localeCompare(b.position));
  if (routines.length === 0) return null;
  return (
    <section data-part="project-routines">
      <h2 className={styles.routines}>{t("project.routines")}</h2>
      {routines.map((routine) => (
        <RoutineItem key={routine.id} routine={routine} clock={clock} actions={actions} />
      ))}
    </section>
  );
}
