// The end-to-end service's storage worker when its world moves the clock (WorldOptions.clock): the
// product's worker with its tree spaces deciding by this machine's time plus the offset in the file
// E2E_CLOCK names, which the test moves on as the page's own clock moves. Tests only.
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { loadDriver } from "../../packages/storage/src/drivers.ts";
import { serve } from "../../packages/storage/src/worker/host.ts";
import type { WorkerConfig } from "../../packages/storage/src/worker/protocol.ts";

if (parentPort === null) throw new Error("This module runs only as a worker thread");
const file = process.env["E2E_CLOCK"];
if (file === undefined) throw new Error("This worker needs E2E_CLOCK");
const config = workerData as WorkerConfig;
serve(parentPort, () => loadDriver(config.driver), {
  clock: () => Date.now() + Number(readFileSync(file, "utf8")),
});
