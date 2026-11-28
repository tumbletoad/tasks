// The views of the sidebar as pure functions of the live rows, so membership and
// the counts are unit tests. Today's numbers are `dayNumbersOf`, its sections `todayOf`; each status
// view's grouping is `VIEW_LIST`.
//
// - Status views are disjoint (U5): Inbox holds the tasks with the inbox flag, and Open, Waiting,
//   Review and Backlog hold the other active tasks by status (Open also a status with no view of
//   its own). So the counts add up, and every open task is in one view.
// - Counts appear on Inbox, Open, Waiting, Review and Backlog only (U2), and only in the sidebar.
// - Every view is always in the sidebar, in its fixed place, whatever it holds.
// - Completed, Agents, Activity and the Trash read data the live store does not hold (completed and
//   removed tasks are never in it): Completed and the Trash are paged queries, Agents the tab's
//   change log, Activity the service's lines of what agents did.
//
// A view's name, a Today section's heading and a view's empty line are keys, never words: each app
// maps them to its own.
import type { AgentChange, TaskRow } from "../store/rows.ts";
import { isUnder, trail, type Nodes } from "../store/tree.ts";
import { flatGroups, groupTasks, personGroups, type GroupTasks } from "./groups.ts";
import {
  byDue,
  byText,
  countedStatus,
  dateOf,
  dayNumber,
  dayOf,
  dueDayOf,
  dueKey,
  localDate,
  priorityOf,
} from "@ttasks/contracts/day";
import type { Clock } from "./dates.ts";

export const VIEWS = [
  "today",
  "inbox",
  "open",
  "waiting",
  "review",
  "backlog",
  "completed",
  "agents",
  "activity",
  "library",
  "trash",
] as const;
export type View = (typeof VIEWS)[number];

/** The landing view of a space: Today, a preference later. */
export const LANDING: View = "today";

export const COUNTED = ["inbox", "open", "waiting", "review", "backlog"] as const;
export type CountedView = (typeof COUNTED)[number];

export const VIEW_LABEL: { readonly [V in View]: `nav.${V}` } = {
  today: "nav.today",
  inbox: "nav.inbox",
  open: "nav.open",
  waiting: "nav.waiting",
  review: "nav.review",
  backlog: "nav.backlog",
  completed: "nav.completed",
  agents: "nav.agents",
  activity: "nav.activity",
  library: "nav.library",
  trash: "nav.trash",
};

export const isView = (value: string): value is View =>
  (VIEWS as readonly string[]).includes(value);

export const isCounted = (view: View): view is CountedView =>
  (COUNTED as readonly string[]).includes(view);

/**
 * The counted view a task belongs to: Inbox by its flag, else its status. A status of the space's
 * own that has no view of its own is listed and counted in Open, so no open task is in no view.
 */
export function countedViewOf(task: TaskRow): CountedView {
  const status = countedStatus(task);
  return status === null ? "inbox" : (STATUS_VIEWS.find((view) => view === status) ?? "open");
}

/** The views of the default statuses (A1 `tasks.statuses`: open, waiting, review, backlog). */
const STATUS_VIEWS = ["open", "waiting", "review", "backlog"] as const;

/** The sidebar's counts, from the open tasks. */
export function viewCounts(tasks: Iterable<TaskRow>): Readonly<Record<CountedView, number>> {
  const counts: Record<CountedView, number> = {
    inbox: 0,
    open: 0,
    waiting: 0,
    review: 0,
    backlog: 0,
  };
  for (const task of tasks) {
    counts[countedViewOf(task)] += 1;
  }
  return counts;
}

/**
 * What a status view's content area lists: the tasks it holds. Undefined for a view whose list is
 * not a filter of the open tasks: Today has sections (`todayOf`), Completed and Agents read data
 * the live store does not hold.
 */
export function viewFilter(view: View): ((task: TaskRow) => boolean) | undefined {
  if (isCounted(view)) return (task) => countedViewOf(task) === view;
  return undefined;
}

/**
 * The open tasks under each area and each project, by ID: what their views list (`underFilter`).
 * An area's count holds its projects' tasks.
 */
export function groupCounts(tasks: Iterable<TaskRow>, nodes: Nodes): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const node of trail(nodes, task.parent))
      counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  }
  return counts;
}

/** What a view's sidebar entry shows besides its name and icon. */
export interface SidebarEntry {
  /** Counted views only, and only once the rows are known. */
  readonly count?: number;
  /** Shown quieter, without a count: it holds nothing. */
  readonly empty: boolean;
}

/**
 * Every view's entry, always all of them in `VIEWS` order: people find these by position, so no
 * state adds, removes or moves one. Without counts (no snapshot yet) no entry claims a number or
 * emptiness it does not know.
 */
export function sidebarEntries(
  counts: Readonly<Record<CountedView, number>> | undefined,
): ReadonlyMap<View, SidebarEntry> {
  return new Map(
    VIEWS.map((view): [View, SidebarEntry] => {
      if (counts === undefined || !isCounted(view)) return [view, { empty: false }];
      const count = counts[view];
      return [view, { count, empty: count === 0 }];
    }),
  );
}

/** How a list groups its rows: each grouping states some facts in its headings. */
export type Grouping =
  /** One flat list, or Today's sections: no fact is stated. */
  | "flat"
  /** Area headings, then project labels (Open, Backlog, the skeleton's lists). */
  | "area"
  /** Project labels inside one area (the area view). */
  | "project"
  /** Person labels (Waiting). */
  | "person";

/** How a status view lists what it holds, and the line it shows when it holds nothing. */
export interface ViewList {
  /** What the grouping states, so the rows leave it out. */
  readonly grouping: Grouping;
  readonly group: GroupTasks;
  /** The empty line's key. */
  readonly empty: `view.empty.${CountedView}`;
}

export const VIEW_LIST: Readonly<Record<CountedView, ViewList>> = {
  // Flat, newest first: quick captures wait here for triage.
  inbox: { grouping: "flat", group: flatGroups, empty: "view.empty.inbox" },
  // Area headings, then project labels.
  open: { grouping: "area", group: groupTasks, empty: "view.empty.open" },
  // By the person waited on, who is the group's heading.
  waiting: { grouping: "person", group: personGroups, empty: "view.empty.waiting" },
  // Flat, newest first.
  review: { grouping: "flat", group: flatGroups, empty: "view.empty.review" },
  backlog: { grouping: "area", group: groupTasks, empty: "view.empty.backlog" },
};

/**
 * An area's or a project's view: every open task under it, its projects' included, whatever area
 * its address names.
 */
export function underFilter(nodes: Nodes, node: string): (task: TaskRow) => boolean {
  return (task) => isUnder(nodes, task.parent, node);
}

// ---------------------------------------------------------------------------------------------
// Today: a few numbers about the day, then Focus, This week, Next and Changes. A task appears in the
// first section that selects it and in no other, so the sections are disjoint by construction:
// each section takes only what the sections before it left. Computed from the task rows in the
// client, never by a model: Today reads what the space holds (a star is `focus_on`, a plan is
// `planned_for`) and decides nothing about it. Focus and This week are day.ts's Today and week,
// the rule an agent's status follows too.

export const TODAY_SECTIONS = ["focus", "week", "next", "changes"] as const;
export type TodaySection = (typeof TODAY_SECTIONS)[number];

export const TODAY_LABEL: { readonly [S in TodaySection]: `today.${S}` } = {
  focus: "today.focus",
  week: "today.week",
  next: "today.next",
  changes: "today.changes",
};

export const isTodaySection = (value: string): value is TodaySection =>
  (TODAY_SECTIONS as readonly string[]).includes(value);

/** Next's length until the preference `today.next_limit` reaches the page (A5 open item 5). */
export const NEXT_LIMIT = 3;
/** Changes shows at most this many lines. */
export const CHANGES_LIMIT = 5;
/** A change older than this drops off Changes. */
export const CHANGES_DAYS = 7;

const DAY_MS = 86_400_000;

/** An agent's change to a task, as far as the page knows it. */
export type TaskChange = AgentChange;

export interface TodayOptions {
  /** Next's length (`today.next_limit`). */
  readonly nextLimit?: number;
  /** Agents' changes, newest first: Changes lists the tasks no section above holds. */
  readonly changes?: readonly TaskChange[];
}

export interface TodaySectionRows {
  readonly key: TodaySection;
  readonly tasks: readonly TaskRow[];
}

export interface Today {
  /** The sections that have rows, in order. */
  readonly sections: readonly TodaySectionRows[];
}

type Order = (a: TaskRow, b: TaskRow) => number;

/** Next selects it (when no section above does): open, not in the Inbox. */
export const inNext = (task: TaskRow): boolean =>
  task.lifecycle === "active" && task.status === "open" && !task.inbox;

/** Next: priority, then due date (undated last), then the space's order, then age. */
const nextOrder =
  (clock: Clock): Order =>
  (a, b) =>
    priorityOf(a) - priorityOf(b) ||
    byDue(dueKey(a, clock), dueKey(b, clock)) ||
    byText(a.position, b.position) ||
    a.created_at - b.created_at ||
    byText(a.id, b.id);

/**
 * The first `n` of a list in an order, in that order: one pass that keeps the best `n`, so Next
 * costs a scan of the open tasks, not a sort of them.
 */
function first(list: readonly TaskRow[], n: number, order: Order): TaskRow[] {
  const best: TaskRow[] = [];
  if (n <= 0) return best;
  for (const task of list) {
    const last = best.at(-1);
    if (best.length === n && last !== undefined && order(task, last) >= 0) continue;
    let at = best.length;
    while (at > 0) {
      const before = best[at - 1];
      if (before === undefined || order(task, before) >= 0) break;
      at -= 1;
    }
    best.splice(at, 0, task);
    if (best.length > n) best.pop();
  }
  return best;
}

/** Today's numbers that the open tasks give: each counts what the page it links to lists. */
export interface DayNumbers {
  /** Due before today: what `is:overdue` finds. */
  readonly late: number;
  /** Due today, at any time of it: what `due:today` finds open. */
  readonly dueToday: number;
  /** What the Waiting view lists. */
  readonly waiting: number;
}

export function dayNumbersOf(tasks: Iterable<TaskRow>, clock: Clock): DayNumbers {
  let late = 0;
  let dueToday = 0;
  let waiting = 0;
  for (const task of tasks) {
    if (task.lifecycle !== "active") continue;
    const due = dueDayOf(task, clock);
    if (due !== undefined && due < clock.today) late += 1;
    else if (due === clock.today) dueToday += 1;
    if (countedViewOf(task) === "waiting") waiting += 1;
  }
  return { late, dueToday, waiting };
}

/** The first day of the week `today` is in: Monday. */
export function weekStartOf(today: string): string {
  const day = dayNumber(today) ?? 0;
  // Day 0 (1970-01-01) was a Thursday: Monday is 3 days after it in the cycle.
  return dateOf(day - ((day + 3) % 7));
}

/**
 * Today from the open tasks: Focus, This week, then the first `nextLimit` open tasks left as Next,
 * and Changes, the tasks agents changed that no section above holds, newest first.
 */
export function todayOf(tasks: Iterable<TaskRow>, clock: Clock, options: TodayOptions = {}): Today {
  const nextLimit = options.nextLimit ?? NEXT_LIMIT;
  const all = new Map<string, TaskRow>();
  for (const task of tasks) if (task.lifecycle === "active") all.set(task.id, task);
  const { today: focus, week } = dayOf(all.values(), clock);
  const dated = new Set([...focus, ...week]);
  const open = [...all.values()].filter((task) => !dated.has(task) && inNext(task));

  // A task keeps its one section: Next's candidates are the open tasks outside the Inbox that
  // neither section above selected, and Changes takes none of the sections above.
  const next = first(open, nextLimit, nextOrder(clock));
  const above = new Set([...focus, ...week, ...next].map((t) => t.id));
  const since = clock.now - CHANGES_DAYS * DAY_MS;
  const changed: TaskRow[] = [];
  for (const change of options.changes ?? []) {
    if (changed.length >= CHANGES_LIMIT) break;
    if (change.at < since || above.has(change.task)) continue;
    const task = all.get(change.task);
    if (task === undefined) continue;
    above.add(change.task);
    changed.push(task);
  }

  const sections: TodaySectionRows[] = [];
  const add = (key: TodaySection, rows: readonly TaskRow[]) => {
    if (rows.length > 0) sections.push({ key, tasks: rows });
  };
  add("focus", focus);
  add("week", week);
  add("next", next);
  add("changes", changed);
  return { sections };
}

// ---------------------------------------------------------------------------------------------
// Agents' "Recent": the tasks an agent or a routine changed in the last seven days (the change log
// Today's Changes reads), newest first, one group per day of the change. A task the agent
// finished stays, with the newest row the page has of it; a deleted one leaves.

export interface RecentDay {
  /** `YYYY-MM-DD` on the viewer's calendar. */
  readonly date: string;
  readonly tasks: readonly TaskRow[];
}

/** The changed tasks, by the day of their newest change, newest first. */
export function recentOf(
  changes: readonly TaskChange[],
  tasks: ReadonlyMap<string, TaskRow>,
  timeZone: string,
): RecentDay[] {
  const days: { date: string; tasks: TaskRow[] }[] = [];
  for (const change of changes) {
    const task = tasks.get(change.task) ?? change.row;
    if (task === undefined || task.deleted_at !== undefined) continue;
    const date = localDate(change.at, timeZone);
    const last = days.at(-1);
    if (last?.date === date) last.tasks.push(task);
    else days.push({ date, tasks: [task] });
  }
  return days;
}

/** The expanded task as the list last showed it: its section and its place there. */
export interface HeldTask {
  readonly task: TaskRow;
  readonly section?: TodaySection;
  readonly index?: number;
}

/**
 * Today's sections with the expanded task kept where it was shown (nothing moves
 * under focus). An update that moves the expanded task inside its section, to another section,
 * or off Today, leaves it at its place in the section it was in until it is collapsed, with its
 * latest data. An expanded task Today has not shown (a link or a reload names it) sits at the top
 * of Focus. Still disjoint: the held task leaves the place the update put it in.
 */
export function holdExpanded(
  sections: readonly TodaySectionRows[],
  held: HeldTask | undefined,
): readonly TodaySectionRows[] {
  if (held === undefined) return sections;
  const id = held.task.id;
  const now = sections.find((s) => s.tasks.some((t) => t.id === id));
  if (now !== undefined && held.section === undefined) return sections;
  if (now !== undefined && now.key === held.section) {
    const at = now.tasks.findIndex((t) => t.id === id);
    if (held.index === undefined || at === Math.min(held.index, now.tasks.length - 1)) {
      return sections;
    }
  }
  const target: TodaySection = held.section ?? "focus";
  const out: TodaySectionRows[] = [];
  for (const key of TODAY_SECTIONS) {
    const tasks = [...(sections.find((s) => s.key === key)?.tasks ?? [])].filter(
      (t) => t.id !== id,
    );
    if (key === target) {
      const at = held.section === undefined ? 0 : Math.min(held.index ?? 0, tasks.length);
      tasks.splice(at, 0, held.task);
    }
    if (tasks.length > 0) out.push({ key, tasks });
  }
  return out;
}
