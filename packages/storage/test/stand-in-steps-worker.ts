// A storage worker entry that registers stand-in schema steps after 0.1 (stand-in-steps.ts), so the
// tests can run the storage worker's migration on open. The step list is named by an environment
// variable, which a worker thread copies from its parent when it starts. A "slow-…" list also
// holds its barrier backup still for SLOW_BARRIER_MS once the snapshot is checked, as a large
// space's would take long, through the worker's fault seams (host.ts WorkerFaults).
import { parentPort, workerData } from "node:worker_threads";
import { loadDriver } from "../src/drivers.ts";
import { serve, type WorkerFaults } from "../src/worker/host.ts";
import type { WorkerConfig } from "../src/worker/protocol.ts";
import { SLOW_BARRIER_MS, STEP_SET_VARIABLE, STEP_SETS, type StepSet } from "./stand-in-steps.ts";

if (parentPort === null) throw new Error("This module runs only as a worker thread");
const name = process.env[STEP_SET_VARIABLE];
if (name === undefined || !Object.hasOwn(STEP_SETS, name)) {
  throw new Error("The test worker needs a step list");
}
const config = workerData as WorkerConfig;
const faults: WorkerFaults = name.startsWith("slow-")
  ? {
      barrier: (point) => {
        if (point === "checked") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_BARRIER_MS);
        }
      },
    }
  : {};
serve(parentPort, () => loadDriver(config.driver), { steps: STEP_SETS[name as StepSet], faults });
