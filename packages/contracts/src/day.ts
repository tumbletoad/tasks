// What belongs to a day: the one rule for the page's Today and counts and for an agent's `status`
// and digest, so the person and an agent are told the same work. No dependencies, so the page can
// import it. Due dates and plans are calendar dates ("2026-11-14"); a due time is an instant, read
// on the viewer's calendar, which the clock names.

/** The viewer's calendar: today's date, the instant and its time zone. */
export interface DayClock {
  /** Today on the viewer's calendar, `YYYY-MM-DD`. */
  readonly today: string;
  /** Now, milliseconds since 1970. */
  readonly now: number;
  /** An IANA time zone ("Europe/Amsterdam"). */
  readonly timeZone: string;
}

/** What the rules read of a task. Absent and null both mean the task has none. */
export interface DayTask {
  readonly id: string;
  readonly lifecycle: string;
  readonly status: string;
  readonly inbox: boolean;
  /** 1 to 3; anything else is none. */
  readonly priority?: number | null | undefined;
  readonly due_date?: string | null | undefined;
  /** A due time, milliseconds since 1970. */
  readonly due_at?: number | null | undefined;
  readonly planned_for?: string | null | undefined;
  /** The day the task was starred. */
  readonly focus_on?: string | null | undefined;
  readonly created_at: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a calendar date, or undefined for a value that is none. */
export function dayNumber(date: string): number | undefined {
  const match = DATE.exec(date);
  if (match === null) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : undefined;
}

/** The calendar date of a day number. */
export function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The form of an IANA time zone name: a bare offset is none. */
export const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

/** Whether `name` is an IANA time zone this runtime knows. */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 64 || !TIME_ZONE.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Building a formatter is the costly part of reading a date: one per time zone. */
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date of an instant in a time zone. */
export function localDate(ms: number, timeZone: string): string {
  let format = dateFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    });
    dateFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(ms);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A date that is a calendar date, else undefined. */
const dateIn = (value: string | null | undefined): string | undefined =>
  typeof value === "string" && dayNumber(value) !== undefined ? value : undefined;

/**
 * The day of each task's due time, by time zone: a task is a new object whenever it changes, so
 * each is read through `Intl` once.
 */
const dueDays = new WeakMap<DayTask, { readonly zone: string; readonly day: string }>();

/** A task's due day on the viewer's calendar: its date, or the day of its due time. */
export function dueDayOf(task: DayTask, clock: DayClock): string | undefined {
  if (typeof task.due_at === "number") {
    const known = dueDays.get(task);
    if (known?.zone === clock.timeZone) return known.day;
    const day = localDate(task.due_at, clock.timeZone);
    dueDays.set(task, { zone: clock.timeZone, day });
    return day;
  }
  return dateIn(task.due_date);
}

/** Starred: `focus_on` today or earlier. A star carries over until it is cleared. */
export const isStarred = (task: Pick<DayTask, "focus_on">, today: string): boolean =>
  typeof task.focus_on === "string" && task.focus_on <= today;

/** Late: its due time has passed, or its due date is before today. */
export function isLate(task: DayTask, clock: DayClock): boolean {
  if (typeof task.due_at === "number") return task.due_at < clock.now;
  const due = dueDayOf(task, clock);
  return due !== undefined && due < clock.today;
}

/**
 * Today (the page's Focus, an agent's `today`) holds an active task that is starred, or that is
 * not in the backlog and is due today or late, or planned for today or earlier. The backlog is
 * work put aside: only a star brings it into the day.
 */
export function inToday(task: DayTask, clock: DayClock): boolean {
  if (task.lifecycle !== "active") return false;
  if (isStarred(task, clock.today)) return true;
  if (task.status === "backlog") return false;
  const due = dueDayOf(task, clock);
  const planned = dateIn(task.planned_for);
  return (
    (due !== undefined && due <= clock.today) || (planned !== undefined && planned <= clock.today)
  );
}

/** This week's six days after today, worked out once per clock. */
const windows = new WeakMap<DayClock, { readonly first: string; readonly last: string }>();
function windowOf(clock: DayClock): { readonly first: string; readonly last: string } {
  let found = windows.get(clock);
  if (found === undefined) {
    const today = dayNumber(clock.today) ?? 0;
    found = { first: dateOf(today + 1), last: dateOf(today + 6) };
    windows.set(clock, found);
  }
  return found;
}

/** The last day of the week after today: what a reader of the week's candidates reads up to. */
export const weekLastDay = (clock: DayClock): string => windowOf(clock).last;

/** The day that brings a task into the week: the earlier of its due and planned days there. */
function weekDay(task: DayTask, clock: DayClock): string | undefined {
  if (task.lifecycle !== "active" || task.status === "backlog") return undefined;
  const { first, last } = windowOf(clock);
  const inside = (d: string | undefined) => d !== undefined && d >= first && d <= last;
  const due = dueDayOf(task, clock);
  const planned = dateIn(task.planned_for);
  if (inside(due) && (!inside(planned) || (due ?? "") <= (planned ?? ""))) return due;
  return inside(planned) ? planned : undefined;
}

/**
 * The week (the page's This week, an agent's `week`) holds an active task Today does not, not in
 * the backlog, due or planned in the six days after today.
 */
export const inWeek = (task: DayTask, clock: DayClock): boolean =>
  !inToday(task, clock) && weekDay(task, clock) !== undefined;

/** Priority 1 to 3 first; none (4, the default) last. */
export const priorityOf = (task: DayTask): number =>
  typeof task.priority === "number" && task.priority >= 1 && task.priority <= 3 ? task.priority : 4;

/** A due as a sortable number (undated: none): its instant, or its day's start. */
export function dueKey(task: DayTask, clock: DayClock): number | undefined {
  if (typeof task.due_at === "number") return task.due_at;
  const day = dueDayOf(task, clock);
  return day === undefined ? undefined : (dayNumber(day) ?? 0) * DAY_MS;
}

/** Undated last. */
export const byDue = (a: number | undefined, b: number | undefined): number =>
  a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a - b;

export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What the orders read of a task, worked out once per `dayOf`: sorts compare these only. */
interface Keys {
  /** 0 late, 1 due today, 2 any other (Today's tiers). */
  readonly tier: number;
  readonly due: number | undefined;
  readonly priority: number;
  /** The day that selects it for the week. */
  readonly week: string;
}

/** Today's order: late first (oldest due first), then due today, then priority, due date and age. */
const todayOrder = (a: DayTask, ka: Keys, b: DayTask, kb: Keys): number =>
  ka.tier - kb.tier ||
  (ka.tier === 0 ? byDue(ka.due, kb.due) : 0) ||
  ka.priority - kb.priority ||
  byDue(ka.due, kb.due) ||
  a.created_at - b.created_at ||
  byText(a.id, b.id);

/** The week's order: by the day that selects it, then priority, due date and age. */
const weekOrder = (a: DayTask, ka: Keys, b: DayTask, kb: Keys): number =>
  byText(ka.week, kb.week) ||
  ka.priority - kb.priority ||
  byDue(ka.due, kb.due) ||
  a.created_at - b.created_at ||
  byText(a.id, b.id);

/** A day's two calendar sections, disjoint, each in its order. */
export interface DaySections<T extends DayTask> {
  readonly today: readonly T[];
  readonly week: readonly T[];
}

/** Today and the week from the tasks, in the order the page lists them. */
export function dayOf<T extends DayTask>(tasks: Iterable<T>, clock: DayClock): DaySections<T> {
  const today: { task: T; keys: Keys }[] = [];
  const week: { task: T; keys: Keys }[] = [];
  for (const task of tasks) {
    const into = inToday(task, clock) ? today : weekDay(task, clock) !== undefined ? week : null;
    if (into === null) continue;
    const due = dueDayOf(task, clock);
    into.push({
      task,
      keys: {
        tier: isLate(task, clock) ? 0 : due === clock.today ? 1 : 2,
        due: dueKey(task, clock),
        priority: priorityOf(task),
        week: weekDay(task, clock) ?? "",
      },
    });
  }
  today.sort((a, b) => todayOrder(a.task, a.keys, b.task, b.keys));
  week.sort((a, b) => weekOrder(a.task, a.keys, b.task, b.keys));
  return { today: today.map((e) => e.task), week: week.map((e) => e.task) };
}

/**
 * The status a task counts toward, or null for a task in the Inbox, which counts toward the Inbox
 * by its flag whatever its status is named. A task counts once, so the counts add up.
 */
export const countedStatus = (task: DayTask): string | null => (task.inbox ? null : task.status);
