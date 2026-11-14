// A space's backup upkeep (A1 3.18), in a worker thread of its own for each run
// (maintenance-entry.ts): the main thread holds no SQLite connection (A1 3.9), and a backup of a
// large space takes a while. A run removes backup leftovers, takes the daily backup when one is
// due and applies retention, in that order (A1 3.18).
//
// Leftovers are removed only in a backups folder this service alone writes (A1 3.18): a
// leftover looks exactly like the files of a backup in progress, and only one cleaner per folder
// closes the window the age rule leaves. That is the space's own `backups/`, while this service
// holds the space's writer.lock: every backup of the space is taken by its writer's service (a
// migration's barrier, the daily one, a manual one through the service). A machine-local
// `backup.dir` can be shared with other spaces, state folders and machines, so it is listed and
// kept by retention, never cleaned automatically.
import { Worker } from "node:worker_threads";
import type { Id } from "@tasks/storage";

/** What one run does. Content-free: a folder, an ID, numbers. */
export interface MaintenanceJob {
  readonly folder: string;
  readonly spaceId: Id<"sp">;
  /** The machine-local `backup.dir`, when set. Default: the space's own `backups/`. */
  readonly backupDir?: string;
  /** Remove leftovers: only in a folder this service alone writes (above). */
  readonly cleanup: boolean;
  /** The service's start: a daily backup over 24 hours old is due at once (A1 3.18). */
  readonly atStart: boolean;
  readonly now: number;
  /** Minutes east of UTC at `now`. */
  readonly utcOffsetMinutes: number;
}

export interface MaintenanceReport {
  readonly leftovers: number;
  readonly backup: "taken" | "not_due";
  readonly removed: number;
  readonly unverified: number;
}

export type MaintenanceReply =
  | { readonly ok: true; readonly report: MaintenanceReport }
  | { readonly ok: false; readonly code?: string };

/** A failed run: only its code, which the log takes from a closed list. */
export class MaintenanceFailed extends Error {
  override readonly name = "MaintenanceFailed";
  readonly code: string | undefined;
  /** The runner was stopped (the service drains): not a failure of the space. */
  readonly stopped: boolean;
  constructor(code: string | undefined, stopped = false) {
    super("The space's maintenance failed");
    this.code = code;
    this.stopped = stopped;
  }
}

const ENTRY = new URL("./maintenance-entry.ts", import.meta.url);

/** Runs maintenance jobs, each in its own worker thread, and stops those still running. */
export class Maintenance {
  readonly #running = new Set<Worker>();
  #stopped = false;

  /** One run. Rejects with MaintenanceFailed, or when the runner is stopped meanwhile. */
  run(job: MaintenanceJob): Promise<MaintenanceReport> {
    if (this.#stopped) return Promise.reject(new MaintenanceFailed(undefined, true));
    const worker = new Worker(ENTRY, { workerData: job });
    this.#running.add(worker);
    return new Promise<MaintenanceReport>((resolve, reject) => {
      let settled = false;
      const settle = (): void => {
        settled = true;
        this.#running.delete(worker);
      };
      worker.once("message", (reply: MaintenanceReply) => {
        settle();
        if (reply.ok) resolve(reply.report);
        else reject(new MaintenanceFailed(reply.code));
        void worker.terminate();
      });
      worker.once("error", () => {
        if (settled) return;
        settle();
        reject(new MaintenanceFailed("STORAGE_WORKER_FAILED"));
      });
      worker.once("exit", () => {
        if (settled) return;
        settle();
        reject(new MaintenanceFailed(undefined, this.#stopped));
      });
    });
  }

  /**
   * Ends every run still going. A backup cut off leaves temporary files, which the next run's
   * leftover removal takes once they are an hour old (A1 3.18).
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.all([...this.#running].map((worker) => worker.terminate()));
    this.#running.clear();
  }
}
