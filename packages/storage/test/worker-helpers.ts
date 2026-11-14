// Shared helpers for the storage worker tests: a rejection's StorageError, a worker held still,
// and a hook on the client's next request of a kind.
import { join } from "node:path";
import { expect } from "vitest";
import { StorageError } from "../src/errors.ts";
import { StorageWorker } from "../src/worker/client.ts";
import type { Kind } from "../src/worker/protocol.ts";
import { checkedDriver } from "./space-helpers.ts";
import { STEP_SET_VARIABLE, type StepSet } from "./stand-in-steps.ts";

/**
 * Starts a storage worker whose build registers the stand-in steps `set` after 0.1
 * (stand-in-steps-worker.ts). The caller closes it.
 */
export async function workerWithSteps(set: StepSet): Promise<StorageWorker> {
  process.env[STEP_SET_VARIABLE] = set;
  try {
    // The worker thread copies the environment when it is created, inside start().
    return await StorageWorker.start({
      driver: "node:sqlite",
      entry: new URL("./stand-in-steps-worker.ts", import.meta.url),
    });
  } finally {
    Reflect.deleteProperty(process.env, STEP_SET_VARIABLE);
  }
}

/** The StorageError a promise rejects with. Fails when it resolves or rejects with anything else. */
export async function rejection(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    return error as StorageError;
  }
  throw new Error("expected a rejection");
}

/**
 * Holds a worker still until `release()`: its connection to a scratch database waits in SQLite's
 * busy handler for a write lock this thread holds, so requests sent to the worker meanwhile wait.
 */
export async function blocked(
  worker: StorageWorker,
  dir: string,
): Promise<{ release: () => Promise<void> }> {
  const file = join(dir, "lock.db");
  const conn = await worker.open(file, "writer", { create: true, busyTimeoutMs: 30_000 });
  const holder = (await checkedDriver()).driver.open(file, { readOnly: false, busyTimeoutMs: 0 });
  holder.exec("BEGIN IMMEDIATE");
  const waiting = conn.exec("BEGIN IMMEDIATE");
  return {
    release: async () => {
      holder.exec("COMMIT");
      holder.close();
      await waiting;
      await conn.exec("COMMIT");
    },
  };
}

/** Resolves once the worker's client sends its next request of `kind`. */
export function sent(worker: StorageWorker, kind: Kind): Promise<void> {
  return new Promise((resolve) => {
    const call = worker.call.bind(worker);
    worker.call = (k, args) => {
      if (k === kind) {
        worker.call = call;
        resolve();
      }
      return call(k, args);
    };
  });
}
