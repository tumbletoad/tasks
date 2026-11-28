// A project's screen, for a project at any depth: where it sits (its breadcrumbs, each crumb to that
// project), how it stands (its status line, from its open tasks and everything below it), and its
// tabs, Tasks and Library. Under Tasks its own tasks come first, then each project below it as a
// headed group with its own short status line, which folds. An archived project's screen begins
// with the way back. At a narrow width the breadcrumbs keep the last two levels.
import { Link } from "@tanstack/react-router";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { projectWithoutArea, trail, type NodeRow, type TaskRow } from "@ttasks/client/store";
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
 * line, and its tasks out of sight while the person has it folded.
 */
function useGroups(project: string, efforts: readonly EffortLevel[], clock: Clock): GroupTasks {
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
        if (group.kind !== "project") return group;
        const open = !folded.has(group.key);
        const parts = projectStatus(
          group.sections.flatMap((section) => section.tasks),
          efforts,
          clock,
        ).filter((part) => part.kind === "open" || part.kind === "due");
        return {
          ...group,
          line: statusWords(parts, clock, t).join(t("project.status.between")),
          fold: {
            open,
            toggle: () => {
              toggle(group.key);
            },
          },
          sections: open ? group.sections : [],
        };
      });
  }, [project, folded, toggle, efforts, clock, t]);
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
  const clock = useClock(false);
  const path = useMemo(() => trail(state.nodes, project), [state.nodes, project]);
  const row = path.at(-1);
  useTitle(row?.title ?? "");
  const filter = useMemo(() => underFilter(state.nodes, project), [state.nodes, project]);
  const efforts = state.scales.efforts;
  const open = useMemo(
    (): TaskRow[] => [...state.tasks.values()].filter(filter),
    [state.tasks, filter],
  );
  const status = useMemo(
    () => statusWords(projectStatus(open, efforts, clock), clock, t),
    [open, efforts, clock, t],
  );
  const group = useGroups(project, efforts, clock);
  // The rows are known from the first snapshot on (an offline tab keeps them).
  const count = state.space === undefined ? undefined : open.length;
  if (row === undefined) return <p className={styles.line}>{t("view.noProject")}</p>;
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
            // A folded group hides its rows, not the project's tasks: the line says only when
            // there are none.
            empty={count === 0 ? t("view.empty") : undefined}
            expand={task}
            onExpand={onExpand}
          />
        </>
      )}
    </>
  );
}
