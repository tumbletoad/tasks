// The views of the sidebar as pure functions of the live rows, so membership and
// the counts are unit tests. Today's sections and week strip are `todayOf`; each status
// view's grouping is `VIEW_LIST`.
//
// - Status views are disjoint (U5): Inbox holds the tasks with the inbox flag, and Open, Waiting,
//   Review and Backlog hold the other active tasks by status. So the counts add up.
// - Counts appear on Inbox, Open, Waiting, Review and Backlog only (U2), and only in the sidebar.
// - Every view is always in the sidebar, in its fixed place, whatever it holds.
// - Completed and Agents read data the live store does not hold (completed tasks are never
//   in it): Completed is a paged query (views/Completed.tsx), Agents the tab's change log.
import { flatGroups, groupTasks, personGroups, type GroupTasks } from "../groups.ts";
import type { MessageId } from "../i18n/intl.tsx";
import type { TaskRow } from "../live.ts";
import { dateOf, dayNumber, localDate, type Clock } from "../row/dates.ts";
import type { Grouping } from "../row/model.ts";

export const VIEWS = [
  "today",
  "inbox",
  "open",
  "waiting",
  "review",
  "backlog",
  "completed",
  "agents",
] as const;
export type View = (typeof VIEWS)[number];

/** The landing view of a space: Today, a preference later. */
export const LANDING: View = "today";

export const COUNTED = ["inbox", "open", "waiting", "review", "backlog"] as const;
export type CountedView = (typeof COUNTED)[number];

export const VIEW_LABEL: Readonly<Record<View, MessageId>> = {
  today: "nav.today",
  inbox: "nav.inbox",
  open: "nav.open",
  waiting: "nav.waiting",
  review: "nav.review",
  backlog: "nav.backlog",
  completed: "nav.completed",
  agents: "nav.agents",
};

export const isView = (value: string): value is View =>
  (VIEWS as readonly string[]).includes(value);

export const isCounted = (view: View): view is CountedView =>
  (COUNTED as readonly string[]).includes(view);

/** The counted view a task belongs to: Inbox by its flag, else its status; none for another. */
export function countedViewOf(task: TaskRow): CountedView | undefined {
  if (task.inbox) return "inbox";
  return STATUS_VIEWS.find((view) => view === task.status);
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
    const view = countedViewOf(task);
    if (view !== undefined) counts[view] += 1;
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

/** How a status view lists what it holds, and the line it shows when it holds nothing. */
export interface ViewList {
  /** What the grouping states, so the rows leave it out. */
  readonly grouping: Grouping;
  readonly group: GroupTasks;
  /** The empty line. */
  readonly empty: MessageId;
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

/** An area view: every open task of the area, or of one of its projects. */
export function areaFilter(area: string, project?: string): (task: TaskRow) => boolean {
  return (task) => task.area_id === area && (project === undefined || task.project_id === project);
}

// ---------------------------------------------------------------------------------------------
// Today: the week strip, then Focus, This week, Next and Changes. A task appears in the
// first section that selects it and in no other, so the sections are disjoint by construction:
// each section takes only what the sections before it left. Computed from the task rows in the
// client, never by a model: Today reads what the space holds (a star is `focus_on`, a plan is
// `planned_for`) and decides nothing about it.

export const TODAY_SECTIONS = ["focus", "week", "next", "changes"] as const;
export type TodaySection = (typeof TODAY_SECTIONS)[number];

export const TODAY_LABEL: Readonly<Record<TodaySection, MessageId>> = {
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
/** The strip draws this many marks under a day, then a plus. */
export const STRIP_MARKS = 4;

const DAY_MS = 86_400_000;

/** An agent's change to a task, as far as the page knows it. */
export interface TaskChange {
  readonly task: string;
  /** The actor's label ("Codex"). */
  readonly actor: string;
  /** When the page saw it, in milliseconds since 1970. */
  readonly at: number;
}

export interface TodayOptions {
  /** Next's length (`today.next_limit`). */
  readonly nextLimit?: number;
  /** The strip's chosen day: Focus and This week show only that day's tasks. */
  readonly day?: string | undefined;
  /** Agents' changes, newest first: Changes lists the tasks no section above holds. */
  readonly changes?: readonly TaskChange[];
  /** Each area's colour slot, for the strip's marks. */
  readonly slots?: ReadonlyMap<string, number>;
}

/** One mark under a day of the strip: a task due or planned that day. */
export interface StripMark {
  readonly task: string;
  readonly title: string;
  /** The task's area slot; none for a task without an area (a muted mark). */
  readonly slot?: number;
  /** A hollow ring: a waiting task's follow-up day (its `planned_for`). */
  readonly ring: boolean;
}

export interface StripDay {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly today: boolean;
  /** Every task due or planned that day, in section order; the strip draws the first four. */
  readonly marks: readonly StripMark[];
}

export interface TodaySectionRows {
  readonly key: TodaySection;
  readonly tasks: readonly TaskRow[];
}

export interface Today {
  /** Seven days, today first. */
  readonly strip: readonly StripDay[];
  /** The sections that have rows, in order. */
  readonly sections: readonly TodaySectionRows[];
}

/**
 * The day of each row's due time, by time zone: reading a calendar date through `Intl` is the
 * costly part of Today, and a row is a new object whenever it changes, so each is read once.
 */
const dueDays = new WeakMap<TaskRow, { readonly zone: string; readonly day: string }>();

/** A task's due day on the viewer's calendar: its date, or the day of its due time. */
export function dueDayOf(task: TaskRow, clock: Clock): string | undefined {
  if (task.due_at !== undefined) {
    const known = dueDays.get(task);
    if (known?.zone === clock.timeZone) return known.day;
    const day = localDate(task.due_at, clock.timeZone);
    dueDays.set(task, { zone: clock.timeZone, day });
    return day;
  }
  if (task.due_date !== undefined && dayNumber(task.due_date) !== undefined) return task.due_date;
  return undefined;
}

const plannedOf = (task: TaskRow): string | undefined =>
  task.planned_for !== undefined && dayNumber(task.planned_for) !== undefined
    ? task.planned_for
    : undefined;

/** Starred: `focus_on` today or earlier. The star carries over until it is cleared. */
export const isStarred = (task: TaskRow, today: string): boolean =>
  task.focus_on !== undefined && task.focus_on <= today;

const isLate = (task: TaskRow, clock: Clock): boolean => {
  if (task.due_at !== undefined) return task.due_at < clock.now;
  const due = dueDayOf(task, clock);
  return due !== undefined && due < clock.today;
};

/** Focus selects it: starred, or (not backlog) due today or late, or planned today or earlier. */
export function inFocus(task: TaskRow, clock: Clock): boolean {
  if (task.lifecycle !== "active") return false;
  if (isStarred(task, clock.today)) return true;
  if (task.status === "backlog") return false;
  const due = dueDayOf(task, clock);
  const planned = plannedOf(task);
  return (
    (due !== undefined && due <= clock.today) || (planned !== undefined && planned <= clock.today)
  );
}

/** This week's six days after today, worked out once per clock. */
const windows = new WeakMap<Clock, { readonly first: string; readonly last: string }>();
function windowOf(clock: Clock): { readonly first: string; readonly last: string } {
  let found = windows.get(clock);
  if (found === undefined) {
    const today = dayNumber(clock.today) ?? 0;
    found = { first: dateOf(today + 1), last: dateOf(today + 6) };
    windows.set(clock, found);
  }
  return found;
}

/** The day that brings a task into This week: the earlier of its due and planned days there. */
function weekDay(task: TaskRow, clock: Clock): string | undefined {
  if (task.lifecycle !== "active" || task.status === "backlog") return undefined;
  const { first, last } = windowOf(clock);
  const inside = (d: string | undefined) => d !== undefined && d >= first && d <= last;
  const due = dueDayOf(task, clock);
  const planned = plannedOf(task);
  if (inside(due) && (!inside(planned) || (due ?? "") <= (planned ?? ""))) return due;
  return inside(planned) ? planned : undefined;
}

/** This week selects it (when Focus does not): not backlog, due or planned in the next six days. */
export const inWeek = (task: TaskRow, clock: Clock): boolean => weekDay(task, clock) !== undefined;

/** Next selects it (when no section above does): open, not in the Inbox. */
export const inNext = (task: TaskRow): boolean =>
  task.lifecycle === "active" && task.status === "open" && !task.inbox;

/** Priority 1 to 3 first; none (4, the default) last. */
const priorityOf = (task: TaskRow): number =>
  task.priority !== undefined && task.priority >= 1 && task.priority <= 3 ? task.priority : 4;

/** A due as a sortable number (undated: none): its instant, or its day's start. */
function dueKey(task: TaskRow, clock: Clock): number | undefined {
  if (task.due_at !== undefined) return task.due_at;
  const day = dueDayOf(task, clock);
  return day === undefined ? undefined : (dayNumber(day) ?? 0) * DAY_MS;
}

/** Undated last. */
const byDue = (a: number | undefined, b: number | undefined): number =>
  a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a - b;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What the orders read of a task, worked out once per `todayOf`: sorts compare these only. */
interface Keys {
  /** 0 late, 1 due today, 2 any other (Focus's tiers). */
  readonly tier: number;
  readonly due: number | undefined;
  readonly priority: number;
  /** The day that selects it for This week. */
  readonly week: string;
}

function keysOf(task: TaskRow, clock: Clock): Keys {
  return {
    tier: isLate(task, clock) ? 0 : dueDayOf(task, clock) === clock.today ? 1 : 2,
    due: dueKey(task, clock),
    priority: priorityOf(task),
    week: weekDay(task, clock) ?? "",
  };
}

type Order = (a: TaskRow, b: TaskRow) => number;

/** Focus: late first (oldest due first), then due today, then priority, due date and age. */
const focusOrder =
  (k: (task: TaskRow) => Keys): Order =>
  (a, b) => {
    const ka = k(a);
    const kb = k(b);
    return (
      ka.tier - kb.tier ||
      (ka.tier === 0 ? byDue(ka.due, kb.due) : 0) ||
      ka.priority - kb.priority ||
      byDue(ka.due, kb.due) ||
      a.created_at - b.created_at ||
      byText(a.id, b.id)
    );
  };

/** This week: by the day that selects it, then priority. */
const weekOrder =
  (k: (task: TaskRow) => Keys): Order =>
  (a, b) => {
    const ka = k(a);
    const kb = k(b);
    return (
      byText(ka.week, kb.week) ||
      ka.priority - kb.priority ||
      byDue(ka.due, kb.due) ||
      a.created_at - b.created_at ||
      byText(a.id, b.id)
    );
  };

/** Next: priority, then due date (undated last), then the space's order, then age. */
const nextOrder =
  (clock: Clock): Order =>
  (a, b) =>
    priorityOf(a) - priorityOf(b) ||
    byDue(dueKey(a, clock), dueKey(b, clock)) ||
    byText(a.position, b.position) ||
    a.created_at - b.created_at ||
    byText(a.id, b.id);

/** Whether a day is a task's due or planned day. */
export const onDay = (task: TaskRow, day: string, clock: Clock): boolean =>
  dueDayOf(task, clock) === day || plannedOf(task) === day;

/** The strip's days: today and the six after it. */
export function stripDays(clock: Clock): string[] {
  const today = dayNumber(clock.today) ?? 0;
  return Array.from({ length: 7 }, (_, i) => dateOf(today + i));
}

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

/**
 * Today from the open tasks. Focus and This week are what the strip marks; the strip's chosen day
 * narrows what they show to that day. Next takes the first `nextLimit` open tasks left. Changes
 * lists the tasks agents changed that no section above holds, newest first.
 */
export function todayOf(tasks: Iterable<TaskRow>, clock: Clock, options: TodayOptions = {}): Today {
  const nextLimit = options.nextLimit ?? NEXT_LIMIT;
  const focus: TaskRow[] = [];
  const week: TaskRow[] = [];
  const open: TaskRow[] = [];
  const all = new Map<string, TaskRow>();
  for (const task of tasks) {
    if (task.lifecycle !== "active") continue;
    all.set(task.id, task);
    if (inFocus(task, clock)) focus.push(task);
    else if (inWeek(task, clock)) week.push(task);
    else if (inNext(task)) open.push(task);
  }
  const keys = new Map<TaskRow, Keys>();
  const k = (task: TaskRow): Keys => {
    let found = keys.get(task);
    if (found === undefined) {
      found = keysOf(task, clock);
      keys.set(task, found);
    }
    return found;
  };
  focus.sort(focusOrder(k));
  week.sort(weekOrder(k));

  // The strip marks the days of the tasks Focus and This week hold, before the day filter.
  const days = stripDays(clock);
  const marks = new Map<string, StripMark[]>(days.map((d) => [d, []]));
  for (const task of [...focus, ...week]) {
    const due = dueDayOf(task, clock);
    const planned = plannedOf(task);
    const slot = task.area_id === undefined ? undefined : options.slots?.get(task.area_id);
    const mark = (ring: boolean): StripMark => ({
      task: task.id,
      title: task.title,
      ...(slot === undefined ? {} : { slot }),
      ring,
    });
    if (due !== undefined) marks.get(due)?.push(mark(false));
    if (planned !== undefined && planned !== due) {
      marks.get(planned)?.push(mark(task.status === "waiting"));
    }
  }
  const strip = days.map((date) => ({
    date,
    today: date === clock.today,
    marks: marks.get(date) ?? [],
  }));

  const day = options.day;
  const shownFocus = day === undefined ? focus : focus.filter((t) => onDay(t, day, clock));
  const shownWeek = day === undefined ? week : week.filter((t) => onDay(t, day, clock));
  // Next and Changes never take a task Focus or This week selected, shown or filtered out: a task
  // keeps its one section, and the day filter only narrows what that section shows. Next's
  // candidates are the open tasks outside the Inbox that neither section above selected.
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
  add("focus", shownFocus);
  add("week", shownWeek);
  add("next", next);
  add("changes", changed);
  return { strip, sections };
}

// ---------------------------------------------------------------------------------------------
// Agents until the service has a read of sessions, runs and routines: "Recent", the
// tasks an agent or a routine changed while this tab followed the space (the change log Today's
// Changes reads), newest first, one group per day of the change.

export interface RecentDay {
  /** `YYYY-MM-DD` on the viewer's calendar. */
  readonly date: string;
  readonly tasks: readonly TaskRow[];
}

/** The changed tasks the rows still hold, by the day of their newest change, newest first. */
export function recentOf(
  changes: readonly TaskChange[],
  tasks: ReadonlyMap<string, TaskRow>,
  timeZone: string,
): RecentDay[] {
  const days: { date: string; tasks: TaskRow[] }[] = [];
  for (const change of changes) {
    const task = tasks.get(change.task);
    if (task === undefined) continue;
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
