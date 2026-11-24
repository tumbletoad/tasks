// What a question that waits for the person is, in SQL over a task `t`: one an agent logged, or
// the last words of a background run that ended asking, on a task that is not in the Trash (it
// waits again once the task is restored). The rows, their reads, Dismiss and the writer, which
// keeps with a new run the questions it replies to, share it.
import { OPEN_RUN_STATES } from "@ttasks/contracts/runs";

/** The run `r` may still hold processes (contracts' `isOpenRun`). */
const openRun = (r: string): string =>
  `(${r}.state IN (${OPEN_RUN_STATES.map((s) => `'${s}'`).join(", ")}) OR ` +
  `(${r}.state = 'unknown' AND ${r}.reason = 'stop_timed_out'))`;

/** A run that may still hold processes (contracts' `isOpenRun`). */
export const OPEN_RUN = openRun("r");

/**
 * Whether a question on the task `t` that arrived with the commit `asked` is still unanswered: the
 * task is not in the Trash, no note of the person's came after it, and it arrived after the
 * question the person last dismissed (`reviewed_at` holds that one's arrival, the service's
 * `readReviewedMark`) or after the dismissal itself. Arrival is the commit's time, which only moves
 * forward and can stand still, so a question committed after the dismissal waits by its place in
 * history whatever the clock said.
 */
const unanswered = (asked: string): string =>
  `t.deleted_at IS NULL AND (t.reviewed_at IS NULL OR ` +
  `(SELECT at FROM commits WHERE seq = ${asked}) > t.reviewed_at ` +
  `OR ${asked} > json_extract(t.fp, '$.reviewed_at')) ` +
  "AND NOT EXISTS (SELECT 1 FROM notes n JOIN actors na ON na.id = n.author_id WHERE " +
  "n.task_id = t.id AND n.deleted_at IS NULL AND na.kind = 'human' AND " +
  `n.created_seq > ${asked})`;

/**
 * Whether the log entry `q` is a question that waits for the person on the task `t`, whatever the
 * task's lifecycle: an agent or a routine asked it and it is `unanswered`. The entry's own
 * `created_at` may be dated back, so its commit decides.
 */
export const WAITS =
  "q.task_id = t.id AND q.kind = 'question' AND q.deleted_at IS NULL AND " +
  "(SELECT kind FROM actors WHERE id = q.author_id) IN ('agent', 'routine') AND " +
  unanswered("q.created_seq");

/** The commit that ended the run `r`: its state's. */
export const runAsked = (r: string): string =>
  `COALESCE(json_extract(${r}.fv, '$.state'), ${r}.version)`;

/**
 * Whether the run `r` ended with a question that waits for the person on the task `t`: it ended
 * needing the person, the question is `unanswered`, and no run of the task queued after it carries
 * a reply: one that works, or got as far as running. A reply that never ran (stopped while queued,
 * or never started) answers nothing.
 */
export const RUN_WAITS =
  "r.task_id = t.id AND r.state = 'failed' AND r.reason = 'needs_input' AND " +
  `${unanswered(runAsked("r"))} AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.task_id = t.id AND ` +
  `a.created_seq > ${runAsked("r")} AND (${openRun("a")} OR a.started_at IS NOT NULL))`;

/** The runs whose questions wait on the task `$task`, oldest question first: what a reply answers. */
export const REPLIED_SQL =
  `SELECT r.id AS id FROM tasks t JOIN runs r ON ${RUN_WAITS} WHERE t.id = $task ` +
  `ORDER BY ${runAsked("r")}, r.id`;
