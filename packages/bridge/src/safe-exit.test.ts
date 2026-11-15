// safe-exit.ts (A2 3.12.1): with it loaded, no Sparkplug batch is compiled on a V8 worker thread and
// no function is compiled by Maglev, so `process.exit` cannot meet a compile job that waits on a
// worker for a collection the main thread never makes. tests/runtime/safe-exit-entries.test.ts
// checks that every script that needs it loads it first.
//
// V8 traces each Sparkplug batch it hands to a worker thread (`--trace-baseline`) and each function
// it marks for an optimising tier (`--trace-opt`) when it does so, on the main thread, and tiering
// counts the work a function did, not time: the check does not depend on timing. The child's own
// functions carry a name of their own, so the check counts only what is compiled after the module
// ran: Node's own start-up compiles a few batches before any module runs.
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { SAFE_EXIT_FLAGS } from "./safe-exit.ts";

const MODULE = new URL("./safe-exit.ts", import.meta.url).href;

/**
 * Many small functions, each called often enough to be compiled by Sparkplug in batches and then
 * marked for an optimising tier.
 */
const WORKLOAD = [
  "const fns = [];",
  "for (let i = 0; i < 200; i++) {",
  "  fns.push(new Function(`return function safeExitWork${i}(a) { let s = ${i}; for (let j = 0; j < 20; j++) s += a[j] * ${i}; return s; };`)());",
  "}",
  "const a = Array.from({ length: 20 }, (_, i) => i);",
  "let t = 0;",
  "for (let r = 0; r < 3000; r++) for (const f of fns) t += f(a);",
  "if (!(t > 0)) throw new Error('no work done');",
].join("\n");

function node(args: readonly string[]) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The trace lines from the first of the workload's own functions on. */
function traceOfWorkload(script: string): string[] {
  const result = node([
    "--trace-baseline",
    "--trace-baseline-batch-compilation",
    "--trace-opt",
    "--input-type=module",
    "-e",
    script,
  ]);
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.split(/\r?\n/u);
  const first = lines.findIndex((line) => /Enqueued SFI safeExitWork\d/u.test(line));
  expect(first, "the workload's functions reached Sparkplug").toBeGreaterThanOrEqual(0);
  return lines.slice(first);
}

const count = (lines: readonly string[], pattern: RegExp) =>
  lines.filter((line) => pattern.test(line)).length;

const CONCURRENT = /\[Concurrent Sparkplug\] compiling/u;
const BATCH = /\[Baseline batch compilation\] Compiling current batch/u;
/** `--trace-opt` writes one marking over two lines: the function, then the tier on the next. */
const marked = (lines: readonly string[], tier: string) =>
  lines.filter(
    (line, i) =>
      /JSFunction safeExitWork\d/u.test(line) &&
      `${line} ${lines[i + 1] ?? ""}`.includes(`for optimization to ${tier}`),
  ).length;

describe("[A2.3.12.1.runtime.safe-exit] no compile job on a V8 worker that allocates on the heap", () => {
  test("the pinned runtime hands such jobs to a worker; with the module loaded first, none", () => {
    // Without the module the pinned Node hands Sparkplug batches to a worker thread and compiles hot
    // functions with Maglev. When this stops being so, re-check the module's reason before changing
    // or removing it.
    const bare = traceOfWorkload(WORKLOAD);
    expect(count(bare, BATCH)).toBeGreaterThan(0);
    expect(count(bare, CONCURRENT)).toBeGreaterThan(0);
    expect(marked(bare, "MAGLEV")).toBeGreaterThan(0);

    const guarded = traceOfWorkload(`import ${JSON.stringify(MODULE)};\n${WORKLOAD}`);
    // The same functions are still compiled in batches, only on the main thread, and hot ones still
    // reach an optimising tier, only TurboFan.
    expect(count(guarded, BATCH)).toBeGreaterThan(0);
    expect(count(guarded, CONCURRENT)).toBe(0);
    expect(marked(guarded, "MAGLEV")).toBe(0);
    expect(marked(guarded, "TURBOFAN")).toBeGreaterThan(0);
  }, 120_000);

  test("the pinned runtime knows every flag the module sets", () => {
    // setFlagsFromString ignores a flag V8 does not know; Node's command line refuses one.
    for (const flag of SAFE_EXIT_FLAGS) {
      const result = node([flag, "-e", "0"]);
      expect(result.status, `${flag}: ${result.stderr}`).toBe(0);
    }
    expect(node(["--no-safe-exit-unknown-flag", "-e", "0"]).status).not.toBe(0);
  });
});
