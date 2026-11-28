// When the readable files' passes run. The first runs right after the start. Then the loop reads
// the space's last commit every 100 ms, and a pass runs once it has stood still for 500 ms, or 5 s
// after the first commit it has not shown while commits keep coming. A pass that could not place
// everything runs again after a pause that doubles from 500 ms to 30 s, without waiting for a
// commit, so a file held open on Windows comes back soon and does not spin the worker. While
// nothing changes, every 10 s each folder is listed, and a file that went missing brings a pass.
// A rebuild (`ttasks view rebuild`) is a request to this loop: every file is read and a pass runs
// at once, the scheduled one, so it is retried as any other.
import type { FilesProjector, PassReport, StartReport } from "./pass.ts";

export const POLL_MS = 100;
export const QUIET_MS = 500;
export const MAX_WAIT_MS = 5_000;
export const SWEEP_MS = 10_000;
export const FIRST_PAUSE_MS = 500;
export const MAX_PAUSE_MS = 30_000;

export interface FilesLoopOptions {
  /** True once the loop should end. It ends after the pass in progress. */
  readonly stopped: () => boolean;
  readonly onStart?: (report: StartReport) => void;
  readonly onPass?: (report: PassReport, ms: number) => void;
  /** A start or a pass that threw. The loop goes on. */
  readonly onError?: (error: unknown) => void;
  /** Whether a rebuild was asked for (`ttasks view rebuild`) since it was last asked: taking it consumes it. */
  readonly takeRebuild?: () => boolean;
  /** A rebuild done: what its check found, then its pass, or what ended it. */
  readonly onRebuilt?: (rebuilt: Rebuilt) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What a rebuild found: files read, those changed or missing, and the pass that wrote them again. */
export interface Rebuilt {
  readonly checked: number;
  readonly suspect: number;
  readonly report?: PassReport;
  readonly error?: unknown;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs `projector` until `stopped()`: its start, then its passes as above. */
export async function runFiles(
  projector: FilesProjector,
  options: FilesLoopOptions,
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? wait;
  let failures = 0;
  const pause = (): number =>
    Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(failures - 1, 10));

  for (;;) {
    if (options.stopped()) return;
    try {
      const report = projector.start();
      options.onStart?.(report);
      failures = 0;
      break;
    } catch (error) {
      failures += 1;
      options.onError?.(error);
      await sleep(pause());
    }
  }

  /** The commit the files show, once a pass placed everything. */
  let shown = -1;
  let seen = -1;
  let lastChange = 0;
  let firstUnshown: number | undefined;
  /** A pass is owed without a new commit: one failed, or a file went missing. */
  let owed = true;
  let retryAt = 0;
  let sweepAt = now() + SWEEP_MS;
  /** A rebuild taken: its pass runs next, as any other, and is retried like one. */
  let rebuild: { checked: number; suspect: number } | undefined;
  while (!options.stopped()) {
    const t = now();
    let seq: number;
    try {
      seq = projector.seq();
    } catch (error) {
      failures += 1;
      options.onError?.(error);
      await sleep(pause());
      continue;
    }
    if (seq !== seen) {
      seen = seq;
      lastChange = t;
    }
    if (seq !== shown) firstUnshown ??= t;
    if (rebuild === undefined && options.takeRebuild?.() === true) {
      try {
        const suspect = projector.check();
        rebuild = { checked: projector.size, suspect };
        owed = true;
      } catch (error) {
        options.onRebuilt?.({ checked: 0, suspect: 0, error });
      }
    }
    if (seq === shown && !owed) {
      if (t >= sweepAt) {
        sweepAt = t + SWEEP_MS;
        try {
          if (projector.missing() > 0) owed = true;
        } catch (error) {
          options.onError?.(error);
        }
      }
      if (!owed) {
        await sleep(POLL_MS);
        continue;
      }
    }
    const settled =
      seq === shown || shown < 0
        ? t
        : Math.min(lastChange + QUIET_MS, (firstUnshown ?? t) + MAX_WAIT_MS);
    const at = rebuild === undefined ? Math.max(settled, retryAt) : t;
    if (t < at) {
      await sleep(Math.max(1, Math.min(POLL_MS, Math.ceil(at - t))));
      continue;
    }
    const t0 = now();
    try {
      const report = projector.pass();
      options.onPass?.(report, Math.round(now() - t0));
      if (rebuild !== undefined) options.onRebuilt?.({ ...rebuild, report });
      if (report.failed > 0) {
        failures += 1;
        owed = true;
      } else {
        failures = 0;
        owed = false;
        shown = report.seq;
        firstUnshown = undefined;
      }
    } catch (error) {
      failures += 1;
      owed = true;
      options.onError?.(error);
      if (rebuild !== undefined) options.onRebuilt?.({ ...rebuild, error });
    }
    rebuild = undefined;
    retryAt = failures > 0 ? now() + pause() : 0;
    sweepAt = now() + SWEEP_MS;
  }
}
