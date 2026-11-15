// The child of the import's crash test (import-crash.test.ts): one apply of a dry run on a real
// space folder, as the service runs it (import-harness.ts), stopped for real at one named point.
// At the armed point it prints `at <point>` and blocks its thread, inside the barrier backup or the
// writer's transaction, until the parent kills the process. Without an armed point, or when the
// apply never reaches it, it prints the outcome and ends. Tests only.
//
// The parent passes the run as JSON in TASKS_IMPORT_CRASH: the space's folder and machine, this
// machine's roots, the run, its token and the point.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "@tasks/bridge/safe-exit";
import { writeSync } from "node:fs";
import type { Id } from "@tasks/storage";
import { attachWorld } from "./import-harness.ts";

/** A line to the parent, written before the thread blocks: a pipe's own write could wait. */
const say = (line: string): void => {
  writeSync(1, `${line}\n`);
};

interface Arm {
  readonly folder: string;
  readonly machine: Id<"m">;
  readonly roots: readonly { id: string; path: string }[];
  readonly run: string;
  readonly token: string;
  readonly point: string;
}

const arm = JSON.parse(process.env["TASKS_IMPORT_CRASH"] ?? "{}") as Arm;

/** Blocks this thread until the parent's kill: the transaction or the backup stays where it is. */
function stopHere(point: string): void {
  if (point !== arm.point) return;
  say(`at ${point}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
  say("not killed");
  process.exit(3);
}

const world = await attachWorld(arm.folder, arm.machine, {
  roots: arm.roots,
  barrier: { at: stopHere },
  write: { at: stopHere },
});
try {
  const result = await world.apply(arm.run, arm.token);
  say(`done ${result.status}`);
} finally {
  world.close();
}
process.exit(0);
