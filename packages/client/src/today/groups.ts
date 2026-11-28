// The open tasks by area and project (the area view's grouping, for the whole space): a pure function of
// the live rows, so every order is a unit test.
//
// - Inbox first: quick captures and tasks without an area that wait for triage, newest first.
// - Then each area with open tasks, in the space's order, with its colour slot (a stored
//   slot when the area has one, else its place in the order, so a theme switch keeps the mapping).
//   Inside an area, the tasks without a project, then each project in order.
// - Then tasks with no area that are not in the Inbox.
// - Inside a group: open first, then the other statuses, backlog last, then position.
// Each task appears exactly once.
import type { AreaRow, ProjectRow, TaskRow } from "../store/rows.ts";

export interface Section {
  readonly key: string;
  /** The project's title; none for an area's tasks without a project. */
  readonly title?: string;
  readonly tasks: readonly TaskRow[];
}

/** The key of the one heading these groupings name: each app maps it to its own words. */
export type GroupLabel = "group.nobody";

/** A list's group. `Label` is the keys its heading may take: an app's own groups add theirs. */
export interface Group<Label extends string = GroupLabel> {
  readonly key: string;
  /**
   * `section`: one of Today's sections, a small muted heading and no dot. `label`: the
   * same small heading with its own text (a person in Waiting, a month in Completed). `flat`: no
   * heading at all (Inbox, Review, the area view, whose sidebar item names it).
   */
  readonly kind: "inbox" | "area" | "loose" | "section" | "label" | "flat";
  /** The area's title (inbox and loose groups take theirs from the messages). */
  readonly title?: string;
  /** A section's heading, by its key. */
  readonly label?: Label;
  /** The heading's values, such as the effort a search's group holds. */
  readonly labelValues?: Readonly<Record<string, string>>;
  /** The area's colour slot, 1 to 8. */
  readonly slot?: number;
  /** Its rows are drawn as Completed draws them, whatever the list's view: a search's Completed. */
  readonly finished?: boolean;
  /** The heading's one action, such as the Trash's `"Restore these`" for its change. */
  readonly action?: { readonly label: string; readonly run: () => void };
  readonly sections: readonly Section[];
}

const STATUS_RANK: Readonly<Record<string, number>> = { open: 0, waiting: 1, review: 2 };
const rank = (status: string): number => (status === "backlog" ? 9 : (STATUS_RANK[status] ?? 5));

const byPosition = (a: { position: string; id: string }, b: { position: string; id: string }) =>
  a.position < b.position
    ? -1
    : a.position > b.position
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

const byStatusThenPosition = (a: TaskRow, b: TaskRow) =>
  rank(a.status) - rank(b.status) || byPosition(a, b);

export const newestFirst = (a: TaskRow, b: TaskRow) =>
  b.created_at - a.created_at || byPosition(a, b);

/** An area's slot: the stored one (1 to 8), else its place in the order, wrapping after 8. */
export function slotOf(area: AreaRow, index: number): number {
  const stored = typeof area.color === "number" ? area.color : Number(area.color);
  return Number.isInteger(stored) && stored >= 1 && stored <= 8 ? stored : (index % 8) + 1;
}

/** Every live area's slot, by its ID (the same slots the area headings use). */
export function areaSlots(areas: Iterable<AreaRow>): ReadonlyMap<string, number> {
  return new Map([...areas].sort(byPosition).map((area, i) => [area.id, slotOf(area, i)]));
}

/** An archived area or project: kept, with its tasks, but out of the places work is filed into. */
const archived = (group: { readonly lifecycle?: string }): boolean =>
  group.lifecycle === "archived";

/**
 * The group that keeps an area's or project's page archived: the project itself, else its area.
 * None while both are live.
 */
export function archivedGroup(
  area: AreaRow | undefined,
  project?: ProjectRow,
):
  | { readonly kind: "area"; readonly row: AreaRow }
  | { readonly kind: "project"; readonly row: ProjectRow }
  | undefined {
  if (project !== undefined && archived(project)) return { kind: "project", row: project };
  if (area !== undefined && archived(area)) return { kind: "area", row: area };
  return undefined;
}

/** The areas and projects new work can be filed into: live ones, and no project of an archived area. */
export function liveGroups(
  areas: Iterable<AreaRow>,
  projects: Iterable<ProjectRow>,
): { readonly areas: AreaRow[]; readonly projects: ProjectRow[] } {
  const live = [...areas].filter((a) => !archived(a));
  const ids = new Set(live.map((a) => a.id));
  return {
    areas: live,
    projects: [...projects].filter(
      (p) => !archived(p) && (p.area_id === undefined || ids.has(p.area_id)),
    ),
  };
}

/** An area as the sidebar lists it, with its colour among all areas and the projects beneath it. */
export interface ListedArea {
  readonly kind: "area";
  readonly area: AreaRow;
  readonly slot: number;
  readonly projects: readonly ProjectRow[];
}

/** An archived project listed on its own under Archived: of a live area, or of none. */
export interface ListedProject {
  readonly kind: "project";
  readonly area?: AreaRow | undefined;
  readonly slot?: number | undefined;
  readonly project: ProjectRow;
}

/**
 * The sidebar's groups, in the space's order: each live area with its live projects, then the live
 * projects without an area; under Archived each archived area with all its projects, each archived
 * project of a live area, then the archived projects without an area. An area keeps the colour it
 * has among all areas, so archiving one recolours no other.
 */
export function sidebarAreas(
  areas: Iterable<AreaRow>,
  projects: Iterable<ProjectRow>,
): {
  readonly live: readonly ListedArea[];
  readonly loose: readonly ProjectRow[];
  readonly archived: readonly (ListedArea | ListedProject)[];
} {
  const all = [...areas].sort(byPosition);
  const projectList = [...projects].sort(byPosition);
  const live: ListedArea[] = [];
  const shelved: (ListedArea | ListedProject)[] = [];
  all.forEach((area, index) => {
    const slot = slotOf(area, index);
    const own = projectList.filter((p) => p.area_id === area.id);
    if (archived(area)) {
      shelved.push({ kind: "area", area, slot, projects: own });
      return;
    }
    live.push({ kind: "area", area, slot, projects: own.filter((p) => !archived(p)) });
    for (const project of own) {
      if (archived(project)) shelved.push({ kind: "project", area, slot, project });
    }
  });
  const areaIds = new Set(all.map((a) => a.id));
  const without = projectList.filter((p) => p.area_id === undefined || !areaIds.has(p.area_id));
  for (const project of without) {
    if (archived(project)) shelved.push({ kind: "project", project });
  }
  return { live, loose: without.filter((p) => !archived(p)), archived: shelved };
}

export function groupTasks(
  tasks: Iterable<TaskRow>,
  areas: Iterable<AreaRow>,
  projects: Iterable<ProjectRow>,
): Group[] {
  const areaList = [...areas].sort(byPosition);
  const areaIds = new Set(areaList.map((a) => a.id));
  const projectList = [...projects].sort(byPosition);
  const projectIds = new Set(projectList.map((p) => p.id));
  const inbox: TaskRow[] = [];
  const loose: TaskRow[] = [];
  const inArea = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const area = task.area_id !== undefined && areaIds.has(task.area_id) ? task.area_id : undefined;
    if (area === undefined) {
      (task.inbox ? inbox : loose).push(task);
      continue;
    }
    const list = inArea.get(area) ?? [];
    list.push(task);
    inArea.set(area, list);
  }
  const groups: Group[] = [];
  if (inbox.length > 0) {
    groups.push({
      key: "inbox",
      kind: "inbox",
      sections: [{ key: "inbox", tasks: inbox.sort(newestFirst) }],
    });
  }
  areaList.forEach((area, index) => {
    const list = inArea.get(area.id);
    if (list === undefined) return;
    const sections: Section[] = [];
    const without = list.filter((t) => t.project_id === undefined || !projectIds.has(t.project_id));
    if (without.length > 0) {
      sections.push({ key: `${area.id}:none`, tasks: without.sort(byStatusThenPosition) });
    }
    for (const project of projectList) {
      if (project.area_id !== area.id) continue;
      const inProject = list.filter((t) => t.project_id === project.id);
      if (inProject.length === 0) continue;
      sections.push({
        key: project.id,
        title: project.title,
        tasks: inProject.sort(byStatusThenPosition),
      });
    }
    // A task whose project belongs to another area still shows, with the area's other tasks.
    const shown = new Set(sections.flatMap((s) => s.tasks.map((t) => t.id)));
    const rest = list.filter((t) => !shown.has(t.id));
    if (rest.length > 0) {
      sections.push({ key: `${area.id}:other`, tasks: rest.sort(byStatusThenPosition) });
    }
    groups.push({
      key: area.id,
      kind: "area",
      title: area.title,
      slot: slotOf(area, index),
      sections,
    });
  });
  if (loose.length > 0) {
    groups.push({
      key: "loose",
      kind: "loose",
      sections: [{ key: "loose", tasks: loose.sort(byStatusThenPosition) }],
    });
  }
  return groups;
}

/** How a view groups the tasks it holds: the list hands it the view's rows, areas and projects. */
export type GroupTasks = (
  tasks: Iterable<TaskRow>,
  areas: Iterable<AreaRow>,
  projects: Iterable<ProjectRow>,
) => Group[];

/** One list without a heading, newest first (Inbox and Review). */
export const flatGroups: GroupTasks = (tasks) => {
  const list = [...tasks].sort(newestFirst);
  return list.length === 0
    ? []
    : [{ key: "flat", kind: "flat", sections: [{ key: "flat", tasks: list }] }];
};

/** A person's name as a group's key: the same person whatever the case or the spaces around it. */
const personKey = (name: string): string => name.trim().toLocaleLowerCase();

/** A follow-up day as a sortable value: undated last. */
const followUp = (task: TaskRow): string => task.planned_for ?? "￿";

const names = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * Waiting: one group per person waited on, the person as its heading, in the order of
 * their names; then the tasks that name no one. Inside a group: the follow-up day (`planned_for`),
 * undated last, then the space's order.
 */
export const personGroups: GroupTasks = (tasks) => {
  const people = new Map<string, { title: string; tasks: TaskRow[] }>();
  const nobody: TaskRow[] = [];
  for (const task of tasks) {
    const name = task.waiting_on?.trim() ?? "";
    if (name === "") {
      nobody.push(task);
      continue;
    }
    const key = personKey(name);
    const known = people.get(key);
    if (known === undefined) people.set(key, { title: name, tasks: [task] });
    else known.tasks.push(task);
  }
  const order = (a: TaskRow, b: TaskRow) =>
    followUp(a) < followUp(b) ? -1 : followUp(a) > followUp(b) ? 1 : byPosition(a, b);
  const groups: Group[] = [...people]
    .sort(([ka, a], [kb, b]) => names.compare(a.title, b.title) || (ka < kb ? -1 : 1))
    .map(([key, person]) => ({
      key: `p:${key}`,
      kind: "label",
      title: person.title,
      sections: [{ key: `p:${key}`, tasks: person.tasks.sort(order) }],
    }));
  if (nobody.length > 0) {
    groups.push({
      key: "p:",
      kind: "label",
      label: "group.nobody",
      sections: [{ key: "p:", tasks: nobody.sort(order) }],
    });
  }
  return groups;
};

/**
 * The area view: every unfinished status of one area, grouped by project under project
 * labels, with no area heading, because the sidebar's item names the area. Tasks without a project
 * come first; backlog rows sort last in their group.
 */
export const areaGroups: GroupTasks = (tasks, areas, projects) =>
  groupTasks(tasks, areas, projects).map((group) =>
    group.kind === "area" ? { ...group, kind: "flat" } : group,
  );

/**
 * A project's view: its tasks in one list under no label, because the sidebar's item names the
 * project, whether or not it has an area.
 */
export const projectGroups: GroupTasks = (tasks) => {
  const list = [...tasks].sort(byStatusThenPosition);
  return list.length === 0
    ? []
    : [{ key: "project", kind: "flat", sections: [{ key: "project", tasks: list }] }];
};
