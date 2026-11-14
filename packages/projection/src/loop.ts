// When the projection runs a batch (A1 3.13 step 2): it waits 500 ms after the last change, at
// most 5 s while changes keep coming, and runs the next batch at once while a backlog waits. It
// looks at the outbox every 100 ms through its reader, so one task shows in the folder within 1 s
// of its commit (A1 3.20). A batch that fails, or leaves tasks it could not place, is tried again
// after a pause that doubles up to 30 s, so a file held open on Windows does not spin the worker.
import type { Projector, StartReport, StepReport } from "./projector.ts";

export const POLL_MS = 100;
export const QUIET_MS = 500;
export const MAX_WAIT_MS = 5_000;
export const MAX_PAUSE_MS = 30_000;

export interface LoopOptions {
  /** True once the loop should end. It ends after the batch in progress. */
  readonly stopped: () => boolean;
  readonly onStart?: (report: StartReport) => void;
  readonly onStep?: (report: StepReport, ms: number) => void;
  /** A start or a batch that threw. The loop goes on. */
  readonly onError?: (error: unknown) => void;
  readonly pollMs?: number;
  readonly quietMs?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs `projector` until `stopped()`: start, then batches as the schedule says. */
export async function runProjection(projector: Projector, options: LoopOptions): Promise<void> {
  const poll = options.pollMs ?? POLL_MS;
  const quiet = options.quietMs ?? QUIET_MS;
  const maxWait = options.maxWaitMs ?? MAX_WAIT_MS;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? wait;
  let failures = 0;
  const pauseAfter = (): number => Math.min(MAX_PAUSE_MS, 500 * 2 ** Math.min(failures - 1, 10));

  // Start, again after a pause when it fails (a folder that is not there yet, a busy writer).
  for (;;) {
    if (options.stopped()) return;
    try {
      // Not inside `onStart?.(…)`: an optional call skips its arguments when there is no callee.
      const report = await projector.start();
      options.onStart?.(report);
      failures = 0;
      break;
    } catch (error) {
      failures += 1;
      options.onError?.(error);
      await sleep(pauseAfter());
    }
  }

  let mark = "";
  let lastChange = 0;
  let firstDirty: number | undefined;
  let backlog = false;
  let retryAt = 0;
  while (!options.stopped()) {
    let pending: { dirty: boolean; mark: string };
    try {
      pending = projector.pending();
    } catch (error) {
      // A reader that cannot read pauses like a failing batch, so the log is not flooded.
      failures += 1;
      options.onError?.(error);
      await sleep(pauseAfter());
      continue;
    }
    const t = now();
    if (!pending.dirty) {
      firstDirty = undefined;
      mark = pending.mark;
      backlog = false;
      await sleep(poll);
      continue;
    }
    if (pending.mark !== mark) {
      mark = pending.mark;
      lastChange = t;
      firstDirty ??= t;
    }
    const dueAt = backlog ? t : Math.min(lastChange + quiet, (firstDirty ?? t) + maxWait);
    const at = Math.max(dueAt, retryAt);
    if (t < at) {
      await sleep(Math.max(1, Math.min(poll, Math.ceil(at - t))));
      continue;
    }
    const t0 = now();
    try {
      const report = await projector.step();
      options.onStep?.(report, Math.round(now() - t0));
      backlog = report.backlog;
      failures = report.failed > 0 ? failures + 1 : 0;
    } catch (error) {
      backlog = false;
      failures += 1;
      options.onError?.(error);
    }
    retryAt = failures > 0 ? now() + pauseAfter() : 0;
    // What the batch itself changed is no new change: the next one starts the quiet wait again.
    firstDirty = undefined;
    mark = "";
  }
}
