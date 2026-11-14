// The open tasks by area and project (A5 3.5's area view, for the whole space): a pure function of
// the live rows, so every order is a unit test.
//
// - Inbox first: quick captures and tasks without an area that wait for triage, newest first.
// - Then each area with open tasks, in the space's order, with its colour slot (A5 3.19: a stored
//   slot when the area has one, else its place in the order, so a theme switch keeps the mapping).
//   Inside an area, the tasks without a project, then each project in order.
// - Then tasks with no area that are not in the Inbox.
// - Inside a group: open first, then the other statuses, backlog last (A5 3.5), then position.
// Each task appears exactly once.
import type { AreaRow, ProjectRow, TaskRow } from "./live.ts";

export interface Section {
  readonly key: string;
  /** The project's title; none for an area's tasks without a project. */
  readonly title?: string;
  readonly tasks: readonly TaskRow[];
}

export interface Group {
  readonly key: string;
  readonly kind: "inbox" | "area" | "loose";
  /** The area's title (inbox and loose groups take theirs from the messages). */
  readonly title?: string;
  /** The area's colour slot, 1 to 8. */
  readonly slot?: number;
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

const newestFirst = (a: TaskRow, b: TaskRow) => b.created_at - a.created_at || byPosition(a, b);

/** An area's slot: the stored one (1 to 8), else its place in the order, wrapping after 8. */
export function slotOf(area: AreaRow, index: number): number {
  const stored = typeof area.color === "number" ? area.color : Number(area.color);
  return Number.isInteger(stored) && stored >= 1 && stored <= 8 ? stored : (index % 8) + 1;
}

/** Every live area's slot, by its ID (the same slots the area headings use). */
export function areaSlots(areas: Iterable<AreaRow>): ReadonlyMap<string, number> {
  return new Map([...areas].sort(byPosition).map((area, i) => [area.id, slotOf(area, i)]));
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
