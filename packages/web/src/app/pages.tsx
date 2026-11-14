// The content of each route until its own step builds it (A7 3.12): the skeleton's grouped list,
// filtered to what the view holds, and a plain line for a view that has no list yet. No view has a
// heading (U3); the sidebar's active item and the tab's title name it.
import { useMemo } from "react";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import { useTitle } from "./frame.ts";
import css from "./pages.module.css";
import { areaFilter, VIEW_LABEL, viewFilter, type View } from "./views.ts";
import { TaskList } from "../views/TaskList.tsx";
import { classes } from "./css.ts";

const styles = classes(css, ["line"]);

function NotBuilt() {
  const t = useT();
  return <p className={styles.line}>{t("view.notBuilt")}</p>;
}

export function ViewPage({ view }: { readonly view: View }) {
  const t = useT();
  useTitle(t(VIEW_LABEL[view]));
  const filter = useMemo(() => viewFilter(view), [view]);
  if (filter === undefined || view === "completed" || view === "agents") return <NotBuilt />;
  // Keyed by the view: another view starts at its top with nothing expanded.
  return (
    <TaskList
      key={view}
      view={view}
      filter={filter}
      empty={t(view === "today" ? "view.nothingOpen" : "view.empty")}
    />
  );
}

export function AreaPage({ area, project }: { readonly area: string; readonly project?: string }) {
  const t = useT();
  const state = useLive();
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
    />
  );
}

const ALL = () => true;

/** A task link (U26): the task expanded in the space's list. Its host view is M5.06's. */
export function TaskPage({ task }: { readonly task: string }) {
  const t = useT();
  useTitle(t("nav.task"));
  // Keyed by the task: a route to another task (Back and Forward too) expands that one.
  return (
    <TaskList key={task} view="today" filter={ALL} empty={t("view.nothingOpen")} expand={task} />
  );
}

export function SearchPage() {
  const t = useT();
  useTitle(t("nav.search"));
  return <NotBuilt />;
}
