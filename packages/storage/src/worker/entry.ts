// The storage worker's entry module: loads the driver named in workerData and serves the protocol.
import { parentPort, workerData } from "node:worker_threads";
import { loadDriver } from "../drivers.ts";
import { serve } from "./host.ts";
import type { WorkerConfig } from "./protocol.ts";

if (parentPort === null) throw new Error("The storage worker runs only as a worker thread");
const config = workerData as WorkerConfig;
serve(parentPort, () => loadDriver(config.driver));
