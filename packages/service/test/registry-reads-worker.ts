// A worker thread that reads one key's tree through RegExe again and again and posts each result:
// the tree, or the error's message. Threads start reg.exe at the same moment, which one thread's
// awaited reads never do. workerData: regExe, scratch, key, rounds. Tests only.
import { parentPort, workerData } from "node:worker_threads";
import { runProcess } from "../src/install/process.ts";
import { RegExe } from "../src/install/registry.ts";

const { regExe, scratch, key, rounds } = workerData as {
  regExe: string;
  scratch: string;
  key: string;
  rounds: number;
};
const registry = new RegExe({ regExe, scratch, run: runProcess });
for (let round = 0; round < rounds; round += 1) {
  try {
    parentPort?.postMessage({ tree: await registry.tree(key) });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}
