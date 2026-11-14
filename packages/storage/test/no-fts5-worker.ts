// A storage worker entry whose driver behaves like a SQLite build without FTS5. The start-up check
// must refuse it before the worker serves anything (A1 3.19, A1 5).
import { parentPort, workerData } from "node:worker_threads";
import { loadDriver } from "../src/drivers.ts";
import { serve } from "../src/worker/host.ts";
import type { WorkerConfig } from "../src/worker/protocol.ts";
import { simulateBuild } from "./simulated-builds.ts";

if (parentPort === null) throw new Error("This module runs only as a worker thread");
const config = workerData as WorkerConfig;
serve(parentPort, async () => simulateBuild(await loadDriver(config.driver), "fts5"));
