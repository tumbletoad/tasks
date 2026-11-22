// A process that looks for System32 again and again while worker threads run, start and end, as
// the service does when a space opens beside a synced-folder check. When it ran its time it writes
// the folder it found and how many workers ran to stderr and exits 0. A worker that fails ends it
// with 1. argv: how long to run, in ms. Tests only.
import "@ttasks/bridge/safe-exit";
import { Worker } from "node:worker_threads";
import { system32 } from "../src/hub/identity.ts";

const runMs = Number(process.argv[2] ?? "4000");
const WORKER =
  "require('node:worker_threads').parentPort.postMessage(0); setTimeout(() => process.exit(0), Math.random() * 30);";

let running = true;
let ran = 0;
const churn = async (): Promise<void> => {
  while (running) {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(WORKER, { eval: true });
      worker.once("message", () => (ran += 1));
      worker.once("error", reject);
      worker.once("exit", () => {
        resolve();
      });
    });
  }
};
const churned = Promise.all(Array.from({ length: 4 }, () => churn())).then(
  () => undefined,
  (error: unknown) => (error instanceof Error ? error.message : "unknown error"),
);
let found: string | undefined;
const until = Date.now() + runMs;
while (Date.now() < until) {
  found = system32();
  await new Promise((resolve) => setImmediate(resolve));
}
running = false;
const failed = await churned;
if (failed !== undefined) {
  process.stderr.write(`a worker failed: ${failed}\n`);
  process.exit(1);
}
process.stderr.write(`system32 ${String(found)}, ${ran > 0 ? "workers ran" : "no worker ran"}\n`);
process.exit(0);
