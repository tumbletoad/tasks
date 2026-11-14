// Starts a bench worker and waits for its replies by type.
import { Worker } from "node:worker_threads";
import type { Command, Reply, WorkerConfig } from "./worker.ts";

const WORKER = new URL("./worker.ts", import.meta.url);

export class BenchWorker {
  readonly #worker: Worker;
  readonly #replies: Reply[] = [];
  readonly #waiting: { type: Reply["type"]; resolve: (r: Reply) => void }[] = [];
  #failure: Error | undefined;
  /** Called for every reply of type "patched", which R04 handles as a stream. */
  onPatched: ((reply: Extract<Reply, { type: "patched" }>) => void) | undefined;

  constructor(config: WorkerConfig) {
    // Callers that never race against `failed` still see the error through next().
    this.failed.catch(() => undefined);
    this.#worker = new Worker(WORKER, { workerData: config });
    this.#worker.on("message", (reply: Reply) => {
      if (reply.type === "error") {
        this.#fail(new Error(`${config.name} worker: ${reply.message}`));
        return;
      }
      if (reply.type === "patched" && this.onPatched !== undefined) {
        this.onPatched(reply);
        return;
      }
      const i = this.#waiting.findIndex((w) => w.type === reply.type);
      const waiter = i >= 0 ? this.#waiting.splice(i, 1)[0] : undefined;
      if (waiter === undefined) this.#replies.push(reply);
      else waiter.resolve(reply);
    });
    this.#worker.on("error", (error: unknown) => {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.#worker.on("exit", (code) => {
      if (code !== 0) this.#fail(new Error(`${config.name} worker exited with ${String(code)}`));
    });
  }

  #rejecters: ((e: Error) => void)[] = [];
  #rejectFailed: (e: Error) => void = () => undefined;
  /** Rejects when the worker reports an error or crashes. */
  readonly failed: Promise<never> = new Promise<never>((_, reject) => {
    this.#rejectFailed = reject;
  });

  #fail(error: Error): void {
    this.#failure = error;
    this.#rejectFailed(error);
    for (const reject of this.#rejecters) reject(error);
    this.#rejecters = [];
  }

  send(command: Command): void {
    this.#worker.postMessage(command);
  }

  /** Waits for the next reply of this type. */
  next<T extends Reply["type"]>(type: T): Promise<Extract<Reply, { type: T }>> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    const i = this.#replies.findIndex((r) => r.type === type);
    if (i >= 0)
      return Promise.resolve(this.#replies.splice(i, 1)[0] as Extract<Reply, { type: T }>);
    return new Promise((resolve, reject) => {
      this.#rejecters.push(reject);
      this.#waiting.push({ type, resolve: resolve as (r: Reply) => void });
    });
  }

  terminate(): Promise<number> {
    return this.#worker.terminate();
  }
}
