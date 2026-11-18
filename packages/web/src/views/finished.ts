// How many tasks were completed today and this week, for Today's numbers. The live store never
// holds a finished task, so they are read from the service's finished tasks, newest first, only as
// far back as the week's first day: a few small reads, never the whole history.
import { finishedDayOf } from "../row/model.ts";
import { taskRow } from "../store/rows.ts";
import type { FinishedRead } from "./completed.ts";

export interface FinishedCounts {
  readonly today: number;
  readonly week: number;
  /** More were completed this week than the reads went through: the week's count is a floor. */
  readonly more: boolean;
}

const PAGE = 200;
const PAGES = 5;

/**
 * Counts the tasks completed on `today` and since `since` (a `YYYY-MM-DD` on the viewer's
 * calendar). A dropped task is finished but not done: it counts for neither.
 */
export async function countFinished(
  read: FinishedRead,
  since: string,
  today: string,
  timeZone: string,
): Promise<FinishedCounts> {
  let onToday = 0;
  let inWeek = 0;
  let cursor: string | undefined;
  for (let page = 0; page < PAGES; page += 1) {
    const found = await read({ limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of found.rows) {
      const row = taskRow(item);
      if (row === undefined) continue;
      const day = finishedDayOf(row, timeZone);
      if (day === undefined) continue;
      // Newest first: the first one before the week ends the count.
      if (day < since) return { today: onToday, week: inWeek, more: false };
      if (row.lifecycle !== "completed") continue;
      inWeek += 1;
      if (day === today) onToday += 1;
    }
    if (found.cursor === undefined) return { today: onToday, week: inWeek, more: false };
    cursor = found.cursor;
  }
  return { today: onToday, week: inWeek, more: true };
}
