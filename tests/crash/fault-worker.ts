// The crash harness's storage worker entry: the product's worker (worker/host.ts serve) with the
// fault seams of the write path, the migration and its barrier backup, and a restore in place
// installed (ServeOptions.faults), and the harness's schema steps. The product's own entry passes
// no faults. The arm comes from the environment, which a worker thread copies from its process.
import { parentPort, workerData } from "node:worker_threads";
import { loadDriver } from "../../packages/storage/src/drivers.ts";
import { serve } from "../../packages/storage/src/worker/host.ts";
import type { WorkerConfig } from "../../packages/storage/src/worker/protocol.ts";
import { armFromEnvironment, faultSeam, reduce } from "./protocol.ts";
import { HARNESS_STEPS } from "./steps.ts";

if (parentPort === null) throw new Error("This module runs only as a worker thread");
const arm = armFromEnvironment();
const config = workerData as WorkerConfig;
const write = faultSeam("write", arm);
const migrate = faultSeam("migrate", arm);
const barrier = faultSeam("barrier", arm);
const restore = faultSeam("restore", arm);
serve(parentPort, () => loadDriver(config.driver), {
  steps: HARNESS_STEPS,
  faults: {
    // A write point reports the request's decision with the point (protocol.ts, ledger.ts).
    write: (point, { request, result }) => {
      write(point, () => ({
        key: `${request.actor.scope_id} ${request.request_id}`,
        result: reduce(result),
      }));
    },
    migrate: (point) => {
      migrate(point);
    },
    barrier: (point) => {
      barrier(point);
    },
    restore: (point) => {
      restore(point);
    },
  },
});
