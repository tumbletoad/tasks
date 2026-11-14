// Lets a process end through `process.exit` without hanging in it (A2 3.12.1). Every script that
// ends through `process.exit` and runs the product's code imports this module before any other:
// the CLI's entries (bin.ts, the build's lib/tasks.mjs), the bridge's and the service's script
// entries, and the test scripts that run the product's code. tests/runtime/safe-exit-entries.test.ts
// finds them and checks the order.
//
// The pinned Node lets V8 compile code on its worker threads, and some of those jobs allocate on
// the heap there. When the heap needs a collection first, such a job waits for the main thread to
// collect. `process.exit` never collects again: it joins the V8 worker threads before the isolate is
// torn down, and the isolate's teardown is what would release the waiting job. So an exit that
// meets such a job waits forever, with only the main thread, the job's thread and the inspector's
// signal thread left. A process that ends at the end of its event loop tears down the isolate first
// and does not hang.
//
// The flags below stop the two such jobs that run on every compile:
// - A concurrent Sparkplug batch builds its bytecode offset table on the heap (the observed hang).
//   With the flag off, Sparkplug compiles its batches on the main thread.
// - A concurrent Maglev job builds its code object and deoptimization data on the heap. Maglev is
//   turned off as a whole: its own flags for building those on the main thread are read again when
//   a job finishes, so turning them off while a job runs would finish it inconsistently. Hot code
//   goes from Sparkplug to TurboFan instead, which builds its code object on the main thread.
// V8 reads both flags each time it starts such a job, so turning them off here stops every later
// one. Worker threads share the flags.
//
// What a run-time flag cannot reach (A2 3.12.1): a TurboFan job can still allocate on its worker
// when it folds a constant string, and TurboFan's concurrency is fixed when the isolate starts; a
// job started before this module ran, during Node's start-up and the loading of the entry's
// modules, is not stopped. Both are rarer than the Sparkplug and Maglev jobs and were not seen to
// hang. Launch flags would close them (not built). A new Node pin re-checks the list.
//
// This module imports one Node built-in and nothing else, so the bridge may load it.
import { setFlagsFromString } from "node:v8";

/** The V8 flags this module sets, for the tests that check they exist and take effect. */
export const SAFE_EXIT_FLAGS: readonly string[] = ["--no-concurrent-sparkplug", "--no-maglev"];

for (const flag of SAFE_EXIT_FLAGS) setFlagsFromString(flag);
