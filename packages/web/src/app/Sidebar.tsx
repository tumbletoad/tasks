// The sidebar, top to bottom and without headings: the space switcher, the views, the areas after
// a gap, and Settings at the foot. Every view is always there, each in its fixed place, while the
// page loads, after an error, in an empty space and in the narrow drawer: people find these by
// position, so an entry that came and went with its content would break that. Counts sit at the
// inline end of Inbox, Open, Waiting, Review and Backlog, and nowhere else; a count is part of its
// link's name ("Waiting, 2 tasks"). A counted view that holds nothing shows no count and a quieter
// label, and its name says so ("Inbox, no tasks"). An area lists its projects beneath it unless the
// person folded it: projects that opened and closed with their area's view would move every entry
// below them, so only the person's own click on an area's fold button does. Areas and projects
// count the open tasks their view lists, quietly, and a folded area keeps its count. A name the
// sidebar cuts shows whole in a tip. New project sits in the foot beside Settings, and on each area
// while the pointer or focus is on it, in place of the area's count so nothing beside it moves; on
// a touch screen always, after the count.
import { Link, useParams } from "@tanstack/react-router";
import { useId, useMemo, useState, type FocusEvent, type PointerEvent } from "react";
import { Button } from "react-aria-components";
import { useIntl } from "react-intl";
import { AddProject } from "../folder/AddProject.tsx";
import { slotOf } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { ChevronIcon, PlusIcon, SettingsIcon, ViewIcon } from "./Icons.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Sidebar.module.css";
import { SpaceSwitcher } from "./SpaceSwitcher.tsx";
import { useFolds } from "./folds.ts";
import { groupCounts, sidebarEntries, VIEW_LABEL, viewCounts } from "./views.ts";
import { classes } from "./css.ts";

const styles = classes(css, [
  "add",
  "area",
  "count",
  "dot",
  "fold",
  "foot",
  "gear",
  "item",
  "label",
  "list",
  "projects",
  "sidebar",
]);

/** A view stays the current item while it holds an expanded task (`?task=`, A5 3.3). */
const IGNORE_TASK = { includeSearch: false } as const;
const EXACT_IGNORE_TASK = { exact: true, includeSearch: false } as const;

const byPosition = (a: { position: string; id: string }, b: { position: string; id: string }) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;

/**
 * The item's whole name as its tip, only while the sidebar cuts it. Set before the page's tip
 * reads it: React's listeners run before the document's.
 */
function tipIfCut(event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>): void {
  const item = event.currentTarget;
  const label = item.querySelector<HTMLElement>("[data-label]");
  if (label !== null && label.scrollWidth > label.clientWidth) {
    item.dataset["tip"] = label.textContent;
  } else delete item.dataset["tip"];
}

/** A count beside an area or project: none while the rows are unknown or it holds nothing. */
function Count({ n }: { readonly n: number | undefined }) {
  const intl = useIntl();
  if (n === undefined || n === 0) return null;
  return (
    <span className={styles.count} aria-hidden="true">
      {intl.formatNumber(n)}
    </span>
  );
}

function Projects({
  id,
  space,
  area,
  projects,
  counts,
}: {
  readonly id: string;
  readonly space: string;
  readonly area: string;
  readonly projects: readonly { readonly id: string; readonly title: string }[];
  readonly counts: ReadonlyMap<string, number> | undefined;
}) {
  const t = useT();
  if (projects.length === 0) return null;
  return (
    <ul className={styles.projects} id={id}>
      {projects.map((project) => {
        const n = counts === undefined ? undefined : (counts.get(project.id) ?? 0);
        return (
          <li key={project.id}>
            <Link
              to="/s/$space/area/$area/project/$project"
              params={{ space, area, project: project.id }}
              className={styles.item}
              activeProps={{ "aria-current": "page" }}
              activeOptions={IGNORE_TASK}
              data-empty={n === 0 || undefined}
              onPointerOver={tipIfCut}
              onFocus={tipIfCut}
              {...(n === undefined
                ? {}
                : { "aria-label": t("nav.counted", { view: project.title, count: n }) })}
            >
              <span className={styles.label} data-label="" dir="auto">
                {project.title}
              </span>
              <Count n={n} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar({ space }: { readonly space: string }) {
  const t = useT();
  const intl = useIntl();
  const state = useLive();
  // The rows are known from the first snapshot on (an offline tab keeps them).
  const known = state.space !== undefined;
  const entries = useMemo(
    () => sidebarEntries(known ? viewCounts(state.tasks.values()) : undefined),
    [known, state.tasks],
  );
  const counts = useMemo(
    () => (known ? groupCounts(state.tasks.values()) : undefined),
    [known, state.tasks],
  );
  const areas = useMemo(() => [...state.areas.values()].sort(byPosition), [state.areas]);
  const projects = useMemo(() => [...state.projects.values()].sort(byPosition), [state.projects]);
  const { folded, toggle } = useFolds(space);
  // The side menu and the drawer can both be in the page: each names its own lists.
  const menu = useId();
  // New project: open, and the area it goes in unless the person chooses another.
  const [adding, setAdding] = useState<{ area: string | undefined }>();
  const here = useParams({ strict: false });
  // A folded area holding the project on screen is marked as the way to it.
  const shownProject = "project" in here ? here.project : undefined;
  const shownArea = "area" in here ? here.area : undefined;

  return (
    <div className={styles.sidebar}>
      <SpaceSwitcher space={space} name={state.space?.name} />
      <ul className={styles.list}>
        {[...entries].map(([view, { count, empty }]) => {
          const label = t(VIEW_LABEL[view]);
          return (
            <li key={view}>
              <Link
                to="/s/$space/$view"
                params={{ space, view }}
                className={styles.item}
                activeProps={{ "aria-current": "page" }}
                activeOptions={IGNORE_TASK}
                data-view={view}
                data-empty={empty || undefined}
                {...(count === undefined
                  ? {}
                  : { "aria-label": t("nav.counted", { view: label, count }) })}
              >
                <ViewIcon view={view} />
                <span className={styles.label}>{label}</span>
                {count === undefined || empty ? null : (
                  <span className={styles.count} aria-hidden="true">
                    {intl.formatNumber(count)}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {areas.length === 0 ? null : (
        <ul className={styles.list} data-group="areas">
          {areas.map((area, index) => {
            const own = projects.filter((project) => project.area_id === area.id);
            const isFolded = folded.has(area.id);
            const n = counts === undefined ? undefined : (counts.get(area.id) ?? 0);
            const list = `${menu}-projects-${area.id}`;
            return (
              <li key={area.id} data-area={area.id} data-folded={isFolded || undefined}>
                {/* The area's colour is its fold button's, or its dot's when it has no projects. */}
                <div className={`${styles.area} slot-${String(slotOf(area, index))}`}>
                  {own.length === 0 ? (
                    <span className={styles.fold} aria-hidden="true">
                      <span className={styles.dot} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.fold}
                      data-part="fold"
                      aria-expanded={!isFolded}
                      aria-controls={isFolded ? undefined : list}
                      aria-label={t(isFolded ? "nav.unfold" : "nav.fold", { area: area.title })}
                      data-tip={t(isFolded ? "nav.unfold" : "nav.fold", { area: area.title })}
                      onClick={() => {
                        toggle(area.id);
                      }}
                    >
                      <ChevronIcon />
                    </button>
                  )}
                  <Link
                    to="/s/$space/area/$area"
                    params={{ space, area: area.id }}
                    className={styles.item}
                    activeProps={{ "aria-current": "page" }}
                    activeOptions={EXACT_IGNORE_TASK}
                    data-empty={n === 0 || undefined}
                    data-within={
                      (isFolded && shownArea === area.id && shownProject !== undefined) || undefined
                    }
                    onPointerOver={tipIfCut}
                    onFocus={tipIfCut}
                    {...(n === undefined
                      ? {}
                      : { "aria-label": t("nav.counted", { view: area.title, count: n }) })}
                  >
                    <span className={styles.label} data-label="" dir="auto">
                      {area.title}
                    </span>
                    <Count n={n} />
                  </Link>
                  <Button
                    className={styles.add}
                    aria-label={t("project.newIn", { area: area.title })}
                    data-tip={t("project.newIn", { area: area.title })}
                    onPress={() => {
                      setAdding({ area: area.id });
                    }}
                  >
                    <PlusIcon />
                  </Button>
                </div>
                {isFolded ? null : (
                  <Projects id={list} space={space} area={area.id} projects={own} counts={counts} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.foot}>
        <Link
          to="/s/$space/settings"
          params={{ space }}
          className={styles.gear}
          activeProps={{ "aria-current": "page" }}
          aria-label={t("nav.settings")}
          data-tip={t("nav.settings")}
        >
          <SettingsIcon />
        </Link>
        <Button
          className={styles.gear}
          aria-label={t("project.new")}
          data-tip={t("project.new")}
          onPress={() => {
            setAdding({ area: here.area });
          }}
        >
          <PlusIcon />
        </Button>
      </div>
      {adding === undefined ? null : (
        <AddProject
          space={space}
          area={adding.area}
          onClose={() => {
            setAdding(undefined);
          }}
        />
      )}
    </div>
  );
}
