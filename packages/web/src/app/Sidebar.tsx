// The sidebar, top to bottom and without headings: the space switcher, the views, the areas after
// a gap, and Settings at the foot. Every view is always there, each in its fixed place, while the
// page loads, after an error, in an empty space and in the narrow drawer: people find these by
// position, so an entry that came and went with its content would break that. Counts sit at the
// inline end of Inbox, Open, Waiting, Review and Backlog, and nowhere else; a count is part of its
// link's name ("Waiting, 2 tasks"). A counted view that holds nothing shows no count and a quieter
// label, and its name says so ("Inbox, no tasks"). An area lists its projects beneath it, always:
// projects that opened and closed with their area's view would move every entry below them.
// Areas show no counts.
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import { slotOf } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { SettingsIcon, ViewIcon } from "./Icons.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Sidebar.module.css";
import { SpaceSwitcher } from "./SpaceSwitcher.tsx";
import { sidebarEntries, VIEW_LABEL, viewCounts } from "./views.ts";
import { classes } from "./css.ts";

const styles = classes(css, [
  "count",
  "dot",
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

function Projects({
  space,
  area,
  projects,
}: {
  readonly space: string;
  readonly area: string;
  readonly projects: readonly { readonly id: string; readonly title: string }[];
}) {
  if (projects.length === 0) return null;
  return (
    <ul className={styles.projects}>
      {projects.map((project) => (
        <li key={project.id}>
          <Link
            to="/s/$space/area/$area/project/$project"
            params={{ space, area, project: project.id }}
            className={styles.item}
            activeProps={{ "aria-current": "page" }}
            activeOptions={IGNORE_TASK}
          >
            <span className={styles.label} dir="auto">
              {project.title}
            </span>
          </Link>
        </li>
      ))}
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
  const areas = useMemo(() => [...state.areas.values()].sort(byPosition), [state.areas]);
  const projects = useMemo(() => [...state.projects.values()].sort(byPosition), [state.projects]);

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
          {areas.map((area, index) => (
            <li key={area.id}>
              <Link
                to="/s/$space/area/$area"
                params={{ space, area: area.id }}
                className={styles.item}
                activeProps={{ "aria-current": "page" }}
                activeOptions={EXACT_IGNORE_TASK}
              >
                <span
                  className={`${styles.dot} slot-${String(slotOf(area, index))}`}
                  aria-hidden="true"
                />
                <span className={styles.label} dir="auto">
                  {area.title}
                </span>
              </Link>
              <Projects
                space={space}
                area={area.id}
                projects={projects.filter((project) => project.area_id === area.id)}
              />
            </li>
          ))}
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
      </div>
    </div>
  );
}
