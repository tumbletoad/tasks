// Lets a process end through `process.exit` without hanging in it (A2 3.12.1). Every entry of the
// product's processes imports this module before any other: the CLI's entries (bin.ts, the build's
// lib/tasks.mjs) and the bridge's script entry. Test scripts that run the product's code and end
// through `process.exit` import it first too.
//
// The pinned Node compiles Sparkplug baseline code on a V8 worker thread (concurrent Sparkplug,
// on by default). Such a job allocates on the heap, and when the heap needs a collection first it
// waits for the main thread to collect. `process.exit` never collects again: it joins the V8 worker
// threads before the isolate is torn down, and the isolate's teardown is what would release the
// waiting job. So an exit that meets such a job waits forever, with only the main thread, the job's
// thread and the inspector's signal thread left. A process that ends at the end of its event loop
// tears down the isolate first and does not hang. With concurrent Sparkplug off, Sparkplug compiles
// on the main thread, and no V8 worker waits for it.
//
// V8 reads the flag at every batch it compiles, so turning it off here, before the process has run
// enough code to compile a batch, covers the whole process. Worker threads share it. This module
// imports one Node built-in and nothing else, so the bridge may load it.
import { setFlagsFromString } from "node:v8";

/** The V8 flag this module sets, for the test that checks it takes effect. */
export const SAFE_EXIT_FLAG = "--no-concurrent-sparkplug";

setFlagsFromString(SAFE_EXIT_FLAG);
