// readUmask's child path in a process of its own, for umask-read.test.ts, which starts this under a
// chosen umask. Linux and macOS only. Tests only. The path to /proc/self/status is replaced by one
// that does not exist, so on Linux too the umask is read the way it is where /proc is missing.
//
// argv: <root> <mode>
//   say    Prints what readUmask read, and the mask Linux records for this process before and after.
//   race   A worker thread creates files with mode 0666 while this thread keeps reading the umask.
//          Prints how many files got a bit the umask takes away: a read that sets the process-wide
//          mask, even for a moment, would let the worker's files through unmasked.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "@tasks/bridge/safe-exit";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { readUmask } from "../src/hub/umask.ts";

const [root, mode] = process.argv.slice(2);
if (root === undefined || (mode !== "say" && mode !== "race")) {
  throw new Error("usage: umask-read-entry.ts <root> say|race");
}
const sources = { status: join(root, "no-status") };

/** The mask Linux records for this process, or null. */
function recorded(): number | null {
  try {
    const line = /^Umask:\s*([0-7]+)\s*$/mu.exec(readFileSync("/proc/self/status", "utf8"));
    return line?.[1] === undefined ? null : Number.parseInt(line[1], 8);
  } catch {
    return null;
  }
}

if (mode === "say") {
  const before = recorded();
  const read = readUmask("linux", sources);
  const after = recorded();
  process.stdout.write(`${JSON.stringify({ read, before, after })}\n`);
  process.exit(0);
}

// The worker creates COUNT files; flags[1] says it started, flags[0] that it finished.
const COUNT = 4000;
const files = join(root, "files");
const shared = new SharedArrayBuffer(8);
const flags = new Int32Array(shared);
const worker = new Worker(
  `const { workerData } = require("node:worker_threads");
   const { closeSync, mkdirSync, openSync } = require("node:fs");
   const { join } = require("node:path");
   const flags = new Int32Array(workerData.shared);
   mkdirSync(workerData.files);
   Atomics.store(flags, 1, 1);
   Atomics.notify(flags, 1);
   for (let i = 0; i < workerData.count; i += 1) {
     closeSync(openSync(join(workerData.files, String(i)), "wx", 0o666));
   }
   Atomics.store(flags, 0, 1);`,
  { eval: true, workerData: { shared, files, count: COUNT } },
);
const exited = new Promise((resolve) => worker.once("exit", resolve));
Atomics.wait(flags, 1, 0, 10_000);
let reads = 0;
const answers = new Set<string>();
// This thread does nothing but read the umask until the worker is done.
while (Atomics.load(flags, 0) === 0) {
  answers.add(JSON.stringify(readUmask("linux", sources) ?? null));
  reads += 1;
}
await exited;
const mask = recorded() ?? 0;
const made = readdirSync(files);
const widened = made.filter((name) => (statSync(join(files, name)).mode & mask) !== 0).length;
process.stdout.write(
  `${JSON.stringify({ files: made.length, widened, reads, answers: [...answers] })}\n`,
);
process.exit(0);
