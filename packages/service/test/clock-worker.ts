// A storage worker for the service's tests whose tree spaces decide by a clock the test moves: the
// product's worker (worker/host.ts serve) with ServeOptions.clock read from the shared buffer the
// test passed (StartOptions.clock). Tests only.
import { parentPort, workerData } from "node:worker_threads";
import { loadDriver } from "../../storage/src/drivers.ts";
import { serve } from "../../storage/src/worker/host.ts";
import type { WorkerConfig } from "../../storage/src/worker/protocol.ts";

if (parentPort === null) throw new Error("This module runs only as a worker thread");
const config = workerData as WorkerConfig;
if (config.clock === undefined) throw new Error("This worker needs a clock");
const now = new Float64Array(config.clock);
serve(parentPort, () => loadDriver(config.driver), { clock: () => now[0] ?? Date.now() });
