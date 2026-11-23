// Calendar days on this machine's clock, which the page and the service count days, weeks and
// months by, and a step whose expectations depend on the day. Tests only.

/** A local calendar day: its first moment, its date and the names the page shows for it. */
export interface Day {
  readonly start: number;
  /** YYYY-MM-DD. */
  readonly iso: string;
  /** As Today shows the date: "Thursday 12 November". */
  readonly full: string;
  /** As a row or a fact shows it: "12 Nov". */
  readonly short: string;
}

/** The local calendar day `days` after the day `from` is in (default: now). */
export function day(days: number, from: number = Date.now()): Day {
  const date = new Date(from);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString("en", options);
  return {
    start: date.getTime(),
    iso: `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    full: `${name({ weekday: "long" })} ${String(date.getDate())} ${name({ month: "long" })}`,
    short: `${String(date.getDate())} ${name({ month: "short" })}`,
  };
}

/** The first moment of the week `of` is in: Monday, as the page counts weeks. */
export function weekOf(of: Day): number {
  const monday = new Date(of.start);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday.getTime();
}

/** The local calendar month `at` is in, as Completed groups by it. */
export function monthOf(at: number): number {
  const date = new Date(at);
  return date.getFullYear() * 12 + date.getMonth();
}

/** The page's own clock moves about 50 ms after midnight (packages/web/src/row/useClock.ts). */
const PAGE_LAG_MS = 2_000;

/**
 * Runs `step` with today as this machine's calendar has it; the step expects exactly what that
 * day makes true. Midnight during a step changes what a correct page and service show, so a step
 * that failed while the day changed, or that began while the page could still show the day
 * before, runs again from its start on the new day. Any other failure is the step's. A step
 * therefore makes its own tasks: it may run twice. `attempt` counts from 1.
 */
export async function onOneDay<T>(step: (today: Day, attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const began = Date.now();
    const today = day(0, began);
    try {
      return await step(today, attempt);
    } catch (error) {
      if (day(0).iso === today.iso && began - today.start >= PAGE_LAG_MS) throw error;
    }
  }
}
