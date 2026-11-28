// A tree space's readable files, in a worker thread of their own while the space is open as this
// machine's (view-files-entry.ts): the main thread holds no SQLite connection. Unlike today's projection
// the worker writes nothing to the space, so nothing crosses but counts and codes.
//
// `ttasks view rebuild` reads every file and runs a pass at once; its answer has the shape of
// today's (`Reconciled`), so the verb and the command line serve both. Stopping asks the worker to
// end after the pass in progress, and stops the thread when it has not ended within the bound: a
// pass cut off is a kill, which the next start recovers from (@ttasks/projection).
import { Worker } from "node:worker_threads";
import type { FilesStartReport, PassReport, Reconciled } from "@ttasks/projection";
import { ProjectionGone } from "./projection.ts";
import { within } from "./wait.ts";

export interface FilesJob {
  /** The space's folder: its database, its `view/`, and `rescued/`. */
  readonly folder: string;
  /** This machine: its folders are the ones the files show. */
  readonly machine: string;
  /** The files' record, in the machine state (space-settings.ts). */
  readonly record: string;
}

export type FilesMessage =
  | { readonly kind: "started"; readonly report: FilesStartReport }
  | { readonly kind: "pass"; readonly report: PassReport; readonly ms: number }
  | { readonly kind: "rebuilt"; readonly checked: number; readonly suspect: number }
  | { readonly kind: "error"; readonly code: string };

export type FilesCommand = { readonly kind: "rebuild" } | { readonly kind: "stop" };

export interface FilesEvents {
  readonly started: (report: FilesStartReport) => void;
  readonly pass: (report: PassReport, ms: number) => void;
  readonly failed: (code: string | undefined) => void;
}

const ENTRY = new URL("./view-files-entry.ts", import.meta.url);

/** One tree space's readable files worker. */
export class FilesRunner {
  readonly #worker: Worker;
  readonly #exited: Promise<void>;
  #stopping: Promise<void> | undefined;
  #ended = false;
  #rebuilds: { resolve: (r: Reconciled) => void; reject: (e: Error) => void }[] = [];

  constructor(job: FilesJob, events: FilesEvents) {
    this.#worker = new Worker(ENTRY, { workerData: job });
    this.#exited = new Promise((resolve) => {
      this.#worker.once("exit", () => {
        this.#ended = true;
        for (const waiting of this.#rebuilds.splice(0)) {
          waiting.reject(new ProjectionGone("The readable files ended before their rebuild ran"));
        }
        resolve();
      });
    });
    this.#worker.on("message", (message: FilesMessage) => {
      switch (message.kind) {
        case "started":
          events.started(message.report);
          return;
        case "pass":
          events.pass(message.report, message.ms);
          return;
        case "rebuilt": {
          const answer: Reconciled = {
            full: true,
            checked: message.checked,
            queued: message.suspect,
            forgotten: 0,
          };
          for (const waiting of this.#rebuilds.splice(0)) waiting.resolve(answer);
          return;
        }
        case "error":
          events.failed(message.code);
          return;
      }
    });
    this.#worker.on("error", () => {
      events.failed("STORAGE_WORKER_FAILED");
    });
  }

  /** `ttasks view rebuild`: every file read and a pass run. Resolves with what it found. */
  rebuild(): Promise<Reconciled> {
    if (this.#ended || this.#stopping !== undefined) {
      return Promise.reject(new ProjectionGone("The readable files are not running"));
    }
    return new Promise((resolve, reject) => {
      this.#rebuilds.push({ resolve, reject });
      try {
        this.#worker.postMessage({ kind: "rebuild" } satisfies FilesCommand);
      } catch {
        // The exit handler answers it.
      }
    });
  }

  /** Ends the worker: after its pass in progress, or at once after `ms`. */
  stop(ms: number): Promise<void> {
    this.#stopping ??= (async () => {
      try {
        this.#worker.postMessage({ kind: "stop" } satisfies FilesCommand);
      } catch {
        // Ended already.
      }
      if (!(await within(this.#exited, ms))) await this.#worker.terminate();
    })();
    return this.#stopping;
  }
}
