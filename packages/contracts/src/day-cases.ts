// The cases of day.ts's rule that the page's Today and an agent's `status` are both tested
// against, so the two cannot drift apart. Tests only. The clock's zone is ahead of UTC, so a due
// time whose UTC date is today can fall on tomorrow.
import type { DayClock } from "./day.ts";

/** Friday 2026-11-20, 10:00 in Auckland (UTC+13). */
export const DAY_CLOCK: DayClock = {
  today: "2026-11-20",
  now: Date.UTC(2026, 10, 19, 21, 0, 0),
  timeZone: "Pacific/Auckland",
};

/** A task of the table: its own fields; every one is active. */
export interface DayCase {
  readonly name: string;
  /** `inbox` is a status the space defines itself, not the Inbox. */
  readonly status: "open" | "waiting" | "review" | "backlog" | "inbox";
  readonly inbox?: true;
  readonly priority?: 1 | 2 | 3;
  readonly due_date?: string;
  readonly due_at?: number;
  readonly planned_for?: string;
  readonly focus_on?: string;
}

/** In this order, each created after the one before it. */
export const DAY_CASES: readonly DayCase[] = [
  { name: "late", status: "open", priority: 2, due_date: "2026-11-18" },
  { name: "due today", status: "open", priority: 3, due_date: "2026-11-20" },
  { name: "due today in the backlog", status: "backlog", due_date: "2026-11-20" },
  { name: "due tonight", status: "open", priority: 1, due_at: Date.UTC(2026, 10, 20, 7) },
  { name: "due this morning", status: "open", due_at: Date.UTC(2026, 10, 19, 19) },
  {
    name: "in the Inbox, due today",
    status: "open",
    inbox: true,
    priority: 2,
    due_date: "2026-11-20",
  },
  { name: "waiting, due today", status: "waiting", due_date: "2026-11-20" },
  { name: "starred today in the backlog", status: "backlog", focus_on: "2026-11-20" },
  { name: "starred yesterday", status: "open", focus_on: "2026-11-19" },
  { name: "planned for today", status: "open", priority: 1, planned_for: "2026-11-20" },
  { name: "due in six days", status: "open", due_date: "2026-11-26" },
  { name: "due in seven days", status: "open", due_date: "2026-11-27" },
  { name: "planned in three days", status: "open", priority: 2, planned_for: "2026-11-23" },
  {
    name: "due at a time whose UTC date is today",
    status: "open",
    due_at: Date.UTC(2026, 10, 20, 20),
  },
  { name: "due tomorrow in the backlog", status: "backlog", due_date: "2026-11-21" },
  { name: "undated", status: "open" },
  { name: "of a status the space named inbox", status: "inbox" },
];

/** Today, in its order. */
export const DAY_TODAY = [
  "late",
  "due this morning",
  "due tonight",
  "in the Inbox, due today",
  "due today",
  "waiting, due today",
  "planned for today",
  "starred today in the backlog",
  "starred yesterday",
] as const;

/** The week, in its order. */
export const DAY_WEEK = [
  "due at a time whose UTC date is today",
  "planned in three days",
  "due in six days",
] as const;

/** The starred tasks. */
export const DAY_STARRED = ["starred today in the backlog", "starred yesterday"] as const;

/** The statuses the space defines for the table: the defaults and one named like the Inbox. */
export const DAY_STATUSES = ["open", "waiting", "review", "backlog", "inbox"] as const;

/** What the active tasks count toward: the Inbox by its flag, else their status. */
export const DAY_COUNTS = {
  inbox: 1,
  statuses: { open: 11, waiting: 1, review: 0, backlog: 3, inbox: 1 },
} as const;
