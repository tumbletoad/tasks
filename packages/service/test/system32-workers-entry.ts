// A process that looks for System32 again and again while worker threads start and end, as the
// service does when a space opens beside a synced-folder check. When it ran its time it writes
// the folder it found to stderr and exits 0. argv: how long to run, in ms. Tests only.
import "@tasks/bridge/safe-exit";
import { Worker } from "node:worker_threads";
import { system32 } from "../src/hub/identity.ts";

const runMs = Number(process.argv[2] ?? "4000");
const WORKER =
  "require('node:worker_threads').parentPort.postMessage(0); setTimeout(() => process.exit(0), Math.random() * 30);";

let running = true;
const churn = async (): Promise<void> => {
  while (running) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(WORKER, { eval: true });
      worker.once("error", () => {
        resolve();
      });
      worker.once("exit", () => {
        resolve();
      });
    });
  }
};
const churners = Array.from({ length: 4 }, () => churn());
let found: string | undefined;
const until = Date.now() + runMs;
while (Date.now() < until) {
  found = system32();
  await new Promise((resolve) => setImmediate(resolve));
}
running = false;
await Promise.all(churners);
process.stderr.write(`system32 ${String(found)}\n`);
process.exit(0);
