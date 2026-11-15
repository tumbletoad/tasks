// A space's projection (A1 3.13), in a worker thread of its own while the space is open as this
// machine's (projection-entry.ts): the main thread holds no SQLite connection (A1 3.9), and a
// batch writes up to 200 files. The worker reads the space through its own reader connection and
// asks this thread for the two writes it needs, which only the space's writer makes: marking a
// batch rendered (and the watermark back) and queueing tasks to render again. Everything that
// crosses is counts, codes and task IDs, never a task's text.
//
// `tasks view rebuild` asks the worker for a full reconciliation (rebuild): the answer is what the
// reconciliation found, as soon as it ran (before the worker's next batch), whatever that batch
// does next.
//
// Stopping asks the worker to end after the batch in progress, and stops the thread when it has
// not ended within the bound: a batch cut off is a kill, which the next start recovers from
// (@tasks/projection). A rebuild still waiting then fails with `STORAGE_WORKER_FAILED`.
import { Worker } from "node:worker_threads";
import type { Reconciled, Rescued, StartReport, StepReport } from "@tasks/projection";
import type { ProjectedBatch, SpaceWriterHandle } from "@tasks/storage";
import { within } from "./wait.ts";

/** What a projection worker is given. */
export interface ProjectionJob {
  /** The space's folder: its database, its `view/`, and `exchange/rescued/` for rescues. */
  readonly folder: string;
  /** The projection's trusted record and journal, in the machine state (space-settings.ts). */
  readonly record: string;
  readonly journal: string;
}

/** Worker to this thread. */
export type ProjectionMessage =
  | {
      readonly kind: "call";
      readonly id: number;
      readonly method: "projected";
      readonly batch: ProjectedBatch;
    }
  | {
      readonly kind: "call";
      readonly id: number;
      readonly method: "queue";
      readonly keys?: readonly string[];
    }
  | { readonly kind: "started"; readonly report: StartReport }
  | { readonly kind: "step"; readonly report: StepReport; readonly ms: number }
  | { readonly kind: "reconciled"; readonly reconciled: Reconciled }
  | { readonly kind: "rescued"; readonly rescued: Rescued }
  | { readonly kind: "error"; readonly code: string };

/** This thread to the worker. */
export type ProjectionCommand =
  | { readonly kind: "reply"; readonly id: number; readonly ok: true; readonly value: number }
  | { readonly kind: "reply"; readonly id: number; readonly ok: false; readonly code: string }
  | { readonly kind: "rebuild" }
  | { readonly kind: "stop" };

export interface ProjectionEvents {
  readonly started: (report: StartReport) => void;
  readonly step: (report: StepReport, ms: number) => void;
  readonly reconciled: (reconciled: Reconciled) => void;
  /** A batch moved entries aside: once per batch, also one that failed or was killed. */
  readonly rescued: (rescued: Rescued) => void;
  readonly failed: (code: string | undefined) => void;
}

const ENTRY = new URL("./projection-entry.ts", import.meta.url);

const CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "STORAGE_WORKER_FAILED";
};

/** A rebuild that could not be answered: the worker ended first. */
export class ProjectionGone extends Error {
  override readonly name = "ProjectionGone";
  readonly code = "STORAGE_WORKER_FAILED";
}

/** One space's projection worker. */
export class ProjectionRunner {
  readonly #worker: Worker;
  readonly #exited: Promise<void>;
  #stopping: Promise<void> | undefined;
  #ended = false;
  /** Rebuilds asked for, answered by the next full reconciliation the worker reports. */
  #rebuilds: { resolve: (r: Reconciled) => void; reject: (e: Error) => void }[] = [];

  constructor(
    job: ProjectionJob,
    writer: Pick<SpaceWriterHandle, "projected" | "queueProjection">,
    events: ProjectionEvents,
  ) {
    this.#worker = new Worker(ENTRY, { workerData: job });
    this.#exited = new Promise((resolve) => {
      this.#worker.once("exit", () => {
        this.#ended = true;
        for (const waiting of this.#rebuilds.splice(0)) {
          waiting.reject(new ProjectionGone("The projection ended before its rebuild ran"));
        }
        resolve();
      });
    });
    const reply = (command: ProjectionCommand): void => {
      try {
        this.#worker.postMessage(command);
      } catch {
        // The worker has ended.
      }
    };
    this.#worker.on("message", (message: ProjectionMessage) => {
      switch (message.kind) {
        case "call": {
          const work =
            message.method === "projected"
              ? writer.projected(message.batch)
              : writer.queueProjection(message.keys);
          work.then(
            (value) => {
              reply({ kind: "reply", id: message.id, ok: true, value });
            },
            (error: unknown) => {
              reply({ kind: "reply", id: message.id, ok: false, code: codeOf(error) });
            },
          );
          return;
        }
        case "started":
          events.started(message.report);
          return;
        case "step":
          events.step(message.report, message.ms);
          return;
        case "reconciled":
          if (message.reconciled.full) {
            for (const waiting of this.#rebuilds.splice(0)) waiting.resolve(message.reconciled);
          }
          events.reconciled(message.reconciled);
          return;
        case "rescued":
          events.rescued(message.rescued);
          return;
        case "error":
          events.failed(message.code);
          return;
      }
    });
    this.#worker.on("error", () => {
      events.failed("STORAGE_WORKER_FAILED");
    });
  }

  /**
   * A full rebuild (`tasks view rebuild`, A1 3.13 rule 5): every file of the record is looked at,
   * and every task queued. Resolves with what the reconciliation found.
   */
  rebuild(): Promise<Reconciled> {
    if (this.#ended || this.#stopping !== undefined) {
      return Promise.reject(new ProjectionGone("The projection is not running"));
    }
    return new Promise((resolve, reject) => {
      this.#rebuilds.push({ resolve, reject });
      try {
        this.#worker.postMessage({ kind: "rebuild" } satisfies ProjectionCommand);
      } catch {
        // The exit handler answers it.
      }
    });
  }

  /** Ends the worker: after its batch in progress, or at once after `ms`. */
  stop(ms: number): Promise<void> {
    this.#stopping ??= (async () => {
      try {
        this.#worker.postMessage({ kind: "stop" } satisfies ProjectionCommand);
      } catch {
        // Ended already.
      }
      if (!(await within(this.#exited, ms))) await this.#worker.terminate();
    })();
    return this.#stopping;
  }
}
