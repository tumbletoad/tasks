// The sidebar, top to bottom and without headings: the space switcher, the views, the projects
// after a gap, Archived when the space has archived projects, and Settings at the foot. Every view
// is always there, each in its fixed place, while the page loads, after an error, in an empty space
// and in the narrow drawer: people find these by position, so an entry that came and went with its
// content would break that. Counts sit at the inline end of Inbox, Open, Waiting, Review and
// Backlog; a count is part of its link's name ("Waiting, 2 tasks"). A counted view that holds
// nothing shows no count and a quieter label, and its name says so ("Inbox, no tasks").
//
// The projects are the space's tree, at whatever depth it has. Each lists the projects beneath it
// unless it is folded: projects that opened and closed with a page would move every entry below
// them, so only the person's own click on a fold button does. Three levels are laid out; below
// that a project starts folded. Each project counts the open tasks of everything under it, quietly,
// and a folded one keeps its count. A name the sidebar cuts shows whole in a tip. New project sits
// in the foot beside Settings, and on each project at the top while the pointer or focus is on it,
// in place of its count so nothing beside it moves; on a touch screen always, after the count. An
// archived project leaves the tree for Archived, folded until the person opens it, named with the
// projects above it and with all it holds, where it keeps its count, so open work in it is never
// out of sight, and its page has the way back.
import { Link, useParams } from "@tanstack/react-router";
import { useId, useMemo, useState, type FocusEvent, type PointerEvent } from "react";
import { Button } from "react-aria-components";
import { useIntl } from "react-intl";
import { AddProject } from "../folder/AddProject.tsx";
import {
  groupCounts,
  sidebarEntries,
  sidebarTree,
  VIEW_LABEL,
  viewCounts,
  type ShelvedEntry,
  type TreeEntry,
} from "@ttasks/client/today";
import { isUnder, projectWithoutArea, trail } from "@ttasks/client/store";
import { useT } from "../i18n/intl.tsx";
import { ChevronIcon, PlusIcon, SettingsIcon, ViewIcon } from "./Icons.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Sidebar.module.css";
import { SpaceSwitcher } from "./SpaceSwitcher.tsx";
import { useMovedByOthers } from "../views/Trash.tsx";
import { useFolds } from "./folds.ts";
import { classes } from "./css.ts";

const styles = classes(css, [
  "add",
  "area",
  "children",
  "count",
  "dot",
  "fold",
  "foot",
  "gear",
  "item",
  "label",
  "list",
  "shelf",
  "sidebar",
]);

/** A view stays the current item while it holds an expanded task (`?task=`). */
const IGNORE_TASK = { includeSearch: false } as const;

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

/** A count beside a project: none while the rows are unknown or it holds nothing. */
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
  project,
  label,
  n,
  within = false,
}: {
  readonly space: string;
  readonly project: { readonly id: string; readonly title: string };
  /** The name shown, when it is not the project's alone. */
  readonly label?: string | undefined;
  readonly n: number | undefined;
  /** Folded away, it holds the page on screen: the way back to it. */
  readonly within?: boolean;
}) {
  const t = useT();
  const name = label ?? project.title;
  return (
    <Link
      to="/s/$space/project/$project"
      params={{ space, project: project.id }}
      className={styles.item}
      activeProps={{ "aria-current": "page" }}
      activeOptions={IGNORE_TASK}
      data-empty={n === 0 || undefined}
      data-within={within || undefined}
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

/** What every line of the tree reads. */
interface TreeProps {
  readonly space: string;
  /** Names the lists of this menu: the side menu and the drawer can both be in the page. */
  readonly menu: string;
  readonly counts: ReadonlyMap<string, number> | undefined;
  readonly folded: (node: string, depth: number) => boolean;
  readonly onToggle: (node: string) => void;
  /** The project on screen. */
  readonly shown: string | undefined;
  /** New project in a project at the top; none under Archived. */
  readonly onAdd?: ((area: string) => void) | undefined;
}

/**
 * A project's line and, unless folded, the projects under it. `level` is its place in this list
 * (1 for a line of its own, as under Archived); its depth in the tree decides how it starts.
 */
function Branch({
  entry,
  level,
  label,
  tree,
}: {
  readonly entry: TreeEntry;
  readonly level: number;
  readonly label?: string;
  readonly tree: TreeProps;
}) {
  const t = useT();
  const { nodes } = useLive();
  const { node, children } = entry;
  const isFolded = children.length > 0 && tree.folded(node.id, entry.depth);
  const n = tree.counts === undefined ? undefined : (tree.counts.get(node.id) ?? 0);
  const list = `${tree.menu}-${node.id}`;
  const name = label ?? node.title;
  const within =
    isFolded &&
    tree.shown !== undefined &&
    tree.shown !== node.id &&
    isUnder(nodes, tree.shown, node.id);
  const add =
    level === 1 && entry.depth === 1 && !projectWithoutArea(node.id) ? tree.onAdd : undefined;
  return (
    <li data-node={node.id} data-depth={level} data-folded={isFolded || undefined}>
      {/* A line of its own takes its project's colour: on its fold button, or its dot. */}
      <div className={level === 1 ? `${styles.area} slot-${String(entry.slot)}` : styles.area}>
        {children.length > 0 ? (
          <button
            type="button"
            className={styles.fold}
            data-part="fold"
            aria-expanded={!isFolded}
            aria-controls={isFolded ? undefined : list}
            aria-label={t(isFolded ? "nav.unfold" : "nav.fold", { area: name })}
            data-tip={t(isFolded ? "nav.unfold" : "nav.fold", { area: name })}
            onClick={() => {
              tree.onToggle(node.id);
            }}
          >
            <ChevronIcon />
          </button>
        ) : (
          <span className={styles.fold} aria-hidden="true">
            {level === 1 ? <span className={styles.dot} /> : null}
          </span>
        )}
        <ProjectLink space={tree.space} project={node} label={label} n={n} within={within} />
        {add === undefined ? null : (
          <Button
            className={styles.add}
            aria-label={t("project.newIn", { area: node.title })}
            data-tip={t("project.newIn", { area: node.title })}
            onPress={() => {
              add(node.id);
            }}
          >
            <PlusIcon />
          </Button>
        )}
      </div>
      {isFolded || children.length === 0 ? null : (
        <ul className={styles.children} id={list}>
          {children.map((child) => (
            <Branch key={child.node.id} entry={child} level={level + 1} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Archived: each archived project, named with the projects above it, with everything under it,
 * each with its count and a link to its page. Nothing here takes new work.
 */
function Shelf({
  id,
  entries,
  tree,
  open,
  onToggle,
}: {
  readonly id: string;
  readonly entries: readonly ShelvedEntry[];
  readonly tree: TreeProps;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const t = useT();
  const { nodes } = useLive();
  const shown = tree.shown;
  const within =
    shown !== undefined && entries.some((entry) => isUnder(nodes, shown, entry.node.id));
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
          {entries.map((entry) => (
            <Branch
              key={entry.node.id}
              entry={entry}
              level={1}
              label={[...entry.above, entry.node].reduce(
                (named, n) =>
                  named === "" ? n.title : t("fact.areaProject", { area: named, project: n.title }),
                "",
              )}
              tree={tree}
            />
          ))}
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
    () => (known ? groupCounts(state.tasks.values(), state.nodes) : undefined),
    [known, state.tasks, state.nodes],
  );
  const groups = useMemo(() => sidebarTree(state.nodes), [state.nodes]);
  const { folded, toggle } = useFolds(space);
  // The side menu and the drawer can both be in the page: each names its own lists.
  const menu = useId();
  // New project: open, and the area it goes in unless the person chooses another.
  const [adding, setAdding] = useState<{ area: string | undefined }>();
  const here = useParams({ strict: false });
  const shown = "project" in here ? here.project : undefined;
  const moved = useMovedByOthers("view" in here && here.view === "trash");
  const tree: TreeProps = {
    space,
    menu,
    counts,
    folded,
    onToggle: toggle,
    shown,
    onAdd: (area) => {
      setAdding({ area });
    },
  };

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
      {groups.live.length === 0 ? null : (
        <ul className={styles.list} data-group="projects">
          {groups.live.map((entry) => (
            <Branch key={entry.node.id} entry={entry} level={1} tree={tree} />
          ))}
        </ul>
      )}
      {groups.archived.length === 0 ? null : (
        <Shelf
          id={`${menu}-archived`}
          entries={groups.archived}
          tree={{ ...tree, onAdd: undefined }}
          open={shelfOpen}
          onToggle={() => {
            onShelf(!shelfOpen);
          }}
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
            setAdding({ area: shown === undefined ? undefined : trail(state.nodes, shown)[0]?.id });
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
