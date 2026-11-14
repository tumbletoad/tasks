// A space's projection (A1 3.13), in a worker thread of its own while the space is open as this
// machine's (projection-entry.ts): the main thread holds no SQLite connection (A1 3.9), and a
// batch writes up to 200 files. The worker reads the space through its own reader connection and
// asks this thread for the two writes it needs, which only the space's writer makes: marking a
// batch rendered (and the watermark back) and queueing every task for a rebuild. Everything that
// crosses is counts, codes and the batch's task IDs, never a path or a task's text.
//
// Stopping asks the worker to end after the batch in progress, and stops the thread when it has
// not ended within the bound: a batch cut off is a kill, which the next start recovers from
// (@tasks/projection).
import { Worker } from "node:worker_threads";
import type { StartReport, StepReport } from "@tasks/projection";
import type { ProjectedBatch, SpaceWriterHandle } from "@tasks/storage";
import { within } from "./wait.ts";

/** What a projection worker is given. */
export interface ProjectionJob {
  /** The space's folder: its database, and `exchange/rescued/` for rescued files. */
  readonly folder: string;
  /** The projection's folder, checked (projectionFolder). */
  readonly dir: string;
}

/** Worker to this thread. */
export type ProjectionMessage =
  | {
      readonly kind: "call";
      readonly id: number;
      readonly method: "projected";
      readonly batch: ProjectedBatch;
    }
  | { readonly kind: "call"; readonly id: number; readonly method: "queue" }
  | { readonly kind: "started"; readonly report: StartReport }
  | { readonly kind: "step"; readonly report: StepReport; readonly ms: number }
  | { readonly kind: "error"; readonly code: string };

/** This thread to the worker. */
export type ProjectionCommand =
  | { readonly kind: "reply"; readonly id: number; readonly ok: true; readonly value: number }
  | { readonly kind: "reply"; readonly id: number; readonly ok: false; readonly code: string }
  | { readonly kind: "stop" };

export interface ProjectionEvents {
  readonly started: (report: StartReport) => void;
  readonly step: (report: StepReport, ms: number) => void;
  readonly failed: (code: string | undefined) => void;
}

const ENTRY = new URL("./projection-entry.ts", import.meta.url);

const CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "STORAGE_WORKER_FAILED";
};

/** One space's projection worker. */
export class ProjectionRunner {
  readonly #worker: Worker;
  readonly #exited: Promise<void>;
  #stopping: Promise<void> | undefined;

  constructor(
    job: ProjectionJob,
    writer: Pick<SpaceWriterHandle, "projected" | "queueProjection">,
    events: ProjectionEvents,
  ) {
    this.#worker = new Worker(ENTRY, { workerData: job });
    this.#exited = new Promise((resolve) => {
      this.#worker.once("exit", () => {
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
              : writer.queueProjection();
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
        case "error":
          events.failed(message.code);
          return;
      }
    });
    this.#worker.on("error", () => {
      events.failed("STORAGE_WORKER_FAILED");
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
