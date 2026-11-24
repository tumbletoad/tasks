// The sidebar, top to bottom and without headings: the space switcher, the views, the areas after
// a gap, Archived when the space has archived groups, and Settings at the foot. Every view is always
// there, each in its fixed place, while the page loads, after an error, in an empty space and in the
// narrow drawer: people find these by position, so an entry that came and went with its content
// would break that. Counts sit at the inline end of Inbox, Open, Waiting, Review and Backlog, and
// nowhere else; a count is part of its link's name ("Waiting, 2 tasks"). A counted view that holds
// nothing shows no count and a quieter label, and its name says so ("Inbox, no tasks"). An area lists
// its projects beneath it unless the person folded it: projects that opened and closed with their
// area's view would move every entry below them, so only the person's own click on an area's fold
// button does. Areas and projects count the open tasks their view lists, quietly, and a folded area
// keeps its count. A name the sidebar cuts shows whole in a tip. New project sits in the foot beside
// Settings, and on each area while the pointer or focus is on it, in place of the area's count so
// nothing beside it moves; on a touch screen always, after the count. A project without an area is
// listed after the areas. An archived area or project leaves the areas for Archived, folded until
// the person opens it, where it keeps its count, so open work in it is never out of sight, and its
// page has the way back.
import { Link, useParams } from "@tanstack/react-router";
import { useId, useMemo, useState, type FocusEvent, type PointerEvent } from "react";
import { Button } from "react-aria-components";
import { useIntl } from "react-intl";
import { AddProject } from "../folder/AddProject.tsx";
import { sidebarAreas, type ListedArea, type ListedProject } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { ChevronIcon, PlusIcon, SettingsIcon, ViewIcon } from "./Icons.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Sidebar.module.css";
import { SpaceSwitcher } from "./SpaceSwitcher.tsx";
import { useMovedByOthers } from "../views/Trash.tsx";
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
  "shelf",
  "sidebar",
]);

/** A view stays the current item while it holds an expanded task (`?task=`, A5 3.3). */
const IGNORE_TASK = { includeSearch: false } as const;
const EXACT_IGNORE_TASK = { exact: true, includeSearch: false } as const;

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

function ProjectLink({
  space,
  area,
  project,
  label,
  counts,
}: {
  readonly space: string;
  /** None for a project without an area. */
  readonly area: string | undefined;
  readonly project: { readonly id: string; readonly title: string };
  /** The name shown, when it is not the project's alone. */
  readonly label?: string;
  readonly counts: ReadonlyMap<string, number> | undefined;
}) {
  const t = useT();
  const n = counts === undefined ? undefined : (counts.get(project.id) ?? 0);
  const name = label ?? project.title;
  return (
    <Link
      {...(area === undefined
        ? { to: "/s/$space/project/$project", params: { space, project: project.id } }
        : {
            to: "/s/$space/area/$area/project/$project",
            params: { space, area, project: project.id },
          })}
      className={styles.item}
      activeProps={{ "aria-current": "page" }}
      activeOptions={IGNORE_TASK}
      data-empty={n === 0 || undefined}
      onPointerOver={tipIfCut}
      onFocus={tipIfCut}
      {...(n === undefined ? {} : { "aria-label": t("nav.counted", { view: name, count: n }) })}
    >
      <span className={styles.label} data-label="" dir="auto">
        {name}
      </span>
      <Count n={n} />
    </Link>
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
  if (projects.length === 0) return null;
  return (
    <ul className={styles.projects} id={id}>
      {projects.map((project) => (
        <li key={project.id}>
          <ProjectLink space={space} area={area} project={project} counts={counts} />
        </li>
      ))}
    </ul>
  );
}

function AreaLink({
  space,
  area,
  n,
  within = false,
}: {
  readonly space: string;
  readonly area: { readonly id: string; readonly title: string };
  readonly n: number | undefined;
  /** Folded away, it holds the page on screen: the way back to it. */
  readonly within?: boolean;
}) {
  const t = useT();
  return (
    <Link
      to="/s/$space/area/$area"
      params={{ space, area: area.id }}
      className={styles.item}
      activeProps={{ "aria-current": "page" }}
      activeOptions={EXACT_IGNORE_TASK}
      data-empty={n === 0 || undefined}
      data-within={within || undefined}
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
  );
}

/**
 * A project listed on its own, beside the areas: one without an area (no colour), or under Archived
 * an archived one of a live area, named with its area and in its colour.
 */
function LooseProject({
  space,
  area,
  slot,
  project,
  counts,
}: {
  readonly space: string;
  readonly area?: { readonly id: string; readonly title: string } | undefined;
  readonly slot?: number | undefined;
  readonly project: { readonly id: string; readonly title: string };
  readonly counts: ReadonlyMap<string, number> | undefined;
}) {
  const t = useT();
  return (
    <div className={slot === undefined ? styles.area : `${styles.area} slot-${String(slot)}`}>
      <span className={styles.fold} aria-hidden="true">
        {area === undefined ? null : <span className={styles.dot} />}
      </span>
      <ProjectLink
        space={space}
        area={area?.id}
        project={project}
        {...(area === undefined
          ? {}
          : { label: t("fact.areaProject", { area: area.title, project: project.title }) })}
        counts={counts}
      />
    </div>
  );
}

/**
 * Archived: the archived areas with their projects, the archived projects of live areas, and the
 * archived projects without an area, each with its count and a link to its page. Nothing here takes
 * new work.
 */
function Shelf({
  id,
  space,
  groups,
  counts,
  open,
  onToggle,
  within,
}: {
  readonly id: string;
  readonly space: string;
  readonly groups: readonly (ListedArea | ListedProject)[];
  readonly counts: ReadonlyMap<string, number> | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The page on screen is an archived group's. */
  readonly within: boolean;
}) {
  const t = useT();
  return (
    <div className={styles.shelf} data-folded={!open || undefined}>
      <button
        type="button"
        className={styles.item}
        data-part="archived"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-within={(!open && within) || undefined}
        onClick={onToggle}
      >
        <ChevronIcon />
        <span className={styles.label}>{t("nav.archived")}</span>
      </button>
      {open ? (
        <ul className={styles.list} id={id}>
          {groups.map((group) =>
            group.kind === "area" ? (
              <li key={group.area.id} data-area={group.area.id}>
                <div className={`${styles.area} slot-${String(group.slot)}`}>
                  <span className={styles.fold} aria-hidden="true">
                    <span className={styles.dot} />
                  </span>
                  <AreaLink
                    space={space}
                    area={group.area}
                    n={counts === undefined ? undefined : (counts.get(group.area.id) ?? 0)}
                  />
                </div>
                <Projects
                  id={`${id}-${group.area.id}`}
                  space={space}
                  area={group.area.id}
                  projects={group.projects}
                  counts={counts}
                />
              </li>
            ) : (
              <li key={group.project.id}>
                <LooseProject
                  space={space}
                  area={group.area}
                  slot={group.slot}
                  project={group.project}
                  counts={counts}
                />
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function Sidebar({
  space,
  shelfOpen,
  onShelf,
}: {
  readonly space: string;
  /**
   * Archived is open: the page's, not the sidebar's, so the narrow drawer keeps it when it closes
   * and opens again. It starts folded in every tab and after a reload: out of the way until asked.
   */
  readonly shelfOpen: boolean;
  readonly onShelf: (open: boolean) => void;
}) {
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
  const groups = useMemo(
    () => sidebarAreas(state.areas.values(), state.projects.values()),
    [state.areas, state.projects],
  );
  const { folded, toggle } = useFolds(space);
  // The side menu and the drawer can both be in the page: each names its own lists.
  const menu = useId();
  // New project: open, and the area it goes in unless the person chooses another.
  const [adding, setAdding] = useState<{ area: string | undefined }>();
  const here = useParams({ strict: false });
  // A folded area holding the project on screen is marked as the way to it.
  const shownProject = "project" in here ? here.project : undefined;
  const shownArea = "area" in here ? here.area : undefined;
  const moved = useMovedByOthers("view" in here && here.view === "trash");

  return (
    <div className={styles.sidebar}>
      <SpaceSwitcher space={space} name={state.space?.name} />
      <ul className={styles.list}>
        {[...entries].map(([view, { count, empty }]) => {
          const label = t(VIEW_LABEL[view]);
          // The Trash counts only what agents moved there since the person last had it open.
          const mark = view === "trash" && moved > 0 ? moved : undefined;
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
                {...(mark !== undefined
                  ? { "aria-label": t("nav.trashMoved", { view: label, count: mark }) }
                  : count === undefined
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
                {mark === undefined ? null : (
                  <span className={styles.count} data-mark aria-hidden="true">
                    {intl.formatNumber(mark)}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {groups.live.length + groups.loose.length === 0 ? null : (
        <ul className={styles.list} data-group="areas">
          {groups.live.map(({ area, slot, projects: own }) => {
            const isFolded = folded.has(area.id);
            const n = counts === undefined ? undefined : (counts.get(area.id) ?? 0);
            const list = `${menu}-projects-${area.id}`;
            return (
              <li key={area.id} data-area={area.id} data-folded={isFolded || undefined}>
                {/* The area's colour is its fold button's, or its dot's when it has no projects. */}
                <div className={`${styles.area} slot-${String(slot)}`}>
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
                  <AreaLink
                    space={space}
                    area={area}
                    n={n}
                    within={isFolded && shownArea === area.id && shownProject !== undefined}
                  />
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
          {groups.loose.map((project) => (
            <li key={project.id}>
              <LooseProject space={space} project={project} counts={counts} />
            </li>
          ))}
        </ul>
      )}
      {groups.archived.length === 0 ? null : (
        <Shelf
          id={`${menu}-archived`}
          space={space}
          groups={groups.archived}
          counts={counts}
          open={shelfOpen}
          onToggle={() => {
            onShelf(!shelfOpen);
          }}
          within={groups.archived.some((g) =>
            g.kind === "area"
              ? g.area.id === shownArea
              : g.project.id === shownProject && g.area?.id === shownArea,
          )}
        />
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
