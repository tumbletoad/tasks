// The views of the sidebar (A5 3.3, 3.5) as pure functions of the live rows, so membership and the
// counts are unit tests. The views themselves are later steps (M5.04 Today, M5.05 the rest); until
// then each shows the open tasks it holds through the skeleton's grouped list.
//
// - Status views are disjoint (U5): Inbox holds the tasks with the inbox flag, and Open, Waiting,
//   Review and Backlog hold the other active tasks by status. So the counts add up.
// - Counts appear on Inbox, Open, Waiting, Review and Backlog only (U2), and only in the sidebar.
// - Inbox and Backlog are shown only when they hold a task, in fixed places (A5 3.3).
// - Completed and Agents read data the live store does not hold (A5 3.25: completed tasks are never
//   in it), so they have no list here yet.
import type { MessageId } from "../i18n/intl.tsx";
import type { TaskRow } from "../live.ts";

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

/** The landing view of a space (A5 3.3: Today, a preference later). */
export const LANDING: View = "today";

export const COUNTED = ["inbox", "open", "waiting", "review", "backlog"] as const;
export type CountedView = (typeof COUNTED)[number];

/** Shown only when not empty, each at its own fixed place. */
export const SHOWN_WHEN_NOT_EMPTY: readonly View[] = ["inbox", "backlog"];

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

const isCounted = (view: View): view is CountedView =>
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

/** What a view's content area lists: the tasks it holds, or undefined when it has no list yet. */
export function viewFilter(view: View): ((task: TaskRow) => boolean) | undefined {
  if (view === "today") return () => true;
  if (isCounted(view)) return (task) => countedViewOf(task) === view;
  return undefined;
}

/** An area view: every open task of the area (A5 3.5), or of one of its projects. */
export function areaFilter(area: string, project?: string): (task: TaskRow) => boolean {
  return (task) => task.area_id === area && (project === undefined || task.project_id === project);
}
