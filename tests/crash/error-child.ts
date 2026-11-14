// A stand-in for child.ts in the harness's own test (crash.test.ts, A1.5.crash.reports): it does
// no work, reports an error from one thread and then the armed point from another, as a backup that
// fails a moment before the writer reaches its point would, and waits there to be killed. The
// harness must report the error although it killed the child at the point.
//
// Run by harness.ts only, with the plan on stdin and the arm in the environment.
import { armFromEnvironment, emit, KILL_WAIT_MS } from "./protocol.ts";

// The plan, which this stand-in does not use: read to its end, as child.ts reads it.
const plan: unknown[] = [];
for await (const chunk of process.stdin) plan.push(chunk);
const arm = armFromEnvironment();
emit({ t: "error", during: "backup", code: "BACKUP_FAILED" });
if (arm !== null) emit({ t: "at", where: arm.where, point: arm.point, nth: arm.nth });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KILL_WAIT_MS);
process.exit(1);
