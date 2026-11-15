// The sidebar (A5 3.3), top to bottom and without headings: the space switcher, the views, the
// areas after a gap, and Settings at the foot. Every view is always there, each in its fixed
// place, whatever it holds: navigation a person uses often never moves (A5 3.3). Counts sit at the
// inline end of Inbox, Open, Waiting, Review and Backlog, and nowhere else (U2); a count is part of
// its link's name ("Waiting, 2 tasks"). A counted view that holds nothing shows no count and a
// quieter label, and its name says so ("Inbox, no tasks"). An area lists its projects beneath it
// while its view is open. Areas show no counts.
import { Link, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import { slotOf } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { SettingsIcon, ViewIcon } from "./Icons.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Sidebar.module.css";
import { SpaceSwitcher } from "./SpaceSwitcher.tsx";
import { COUNTED, VIEW_LABEL, VIEWS, viewCounts, type CountedView, type View } from "./views.ts";
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

const isCounted = (view: View): view is CountedView =>
  (COUNTED as readonly string[]).includes(view);

const byPosition = (a: { position: string; id: string }, b: { position: string; id: string }) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;

export function Sidebar({ space }: { readonly space: string }) {
  const t = useT();
  const intl = useIntl();
  const state = useLive();
  const params: { area?: string; project?: string } = useParams({ strict: false });
  const counts = useMemo(() => viewCounts(state.tasks.values()), [state.tasks]);
  const areas = useMemo(() => [...state.areas.values()].sort(byPosition), [state.areas]);
  const projects = useMemo(() => [...state.projects.values()].sort(byPosition), [state.projects]);

  return (
    <div className={styles.sidebar}>
      <SpaceSwitcher space={space} name={state.space?.name} />
      <ul className={styles.list}>
        {VIEWS.map((view) => {
          const label = t(VIEW_LABEL[view]);
          const count = isCounted(view) ? counts[view] : undefined;
          return (
            <li key={view}>
              <Link
                to="/s/$space/$view"
                params={{ space, view }}
                className={styles.item}
                activeProps={{ "aria-current": "page" }}
                activeOptions={IGNORE_TASK}
                data-view={view}
                data-empty={count === 0 || undefined}
                {...(count === undefined
                  ? {}
                  : { "aria-label": t("nav.counted", { view: label, count }) })}
              >
                <ViewIcon view={view} />
                <span className={styles.label}>{label}</span>
                {count === undefined || count === 0 ? null : (
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
              {params.area === area.id ? (
                <ul className={styles.projects}>
                  {projects
                    .filter((project) => project.area_id === area.id)
                    .map((project) => (
                      <li key={project.id}>
                        <Link
                          to="/s/$space/area/$area/project/$project"
                          params={{ space, area: area.id, project: project.id }}
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
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className={styles.foot}>
        <Link
          to="/s/$space/settings/$section"
          params={{ space, section: "appearance" }}
          className={styles.gear}
          activeProps={{ "aria-current": "page" }}
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
        >
          <SettingsIcon />
        </Link>
      </div>
    </div>
  );
}
