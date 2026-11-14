// safe-exit.ts (A2 3.12.1): with it loaded, no Sparkplug batch is compiled on a V8 worker thread,
// so `process.exit` cannot meet such a job waiting for a collection the main thread never makes;
// and every entry of the product's processes loads it before anything else.
//
// V8 traces each batch it hands to a worker thread (`--trace-baseline`) when it hands it over, on
// the main thread, so the check does not depend on timing. The child's own functions carry a name
// of their own, so the check counts only what is compiled after the module ran: Node's own
// start-up compiles a few batches before any module runs.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const MODULE = new URL("./safe-exit.ts", import.meta.url).href;
const REPO = new URL("../../../", import.meta.url);

/** Many small functions, each called often enough to be compiled by Sparkplug in batches. */
const WORKLOAD = [
  "const fns = [];",
  "for (let i = 0; i < 400; i++) {",
  "  fns.push(new Function(`return function safeExitWork${i}(a) { let s = ${i}; for (let j = 0; j < 20; j++) s += a[j] * ${i}; return s; };`)());",
  "}",
  "const a = Array.from({ length: 20 }, (_, i) => i);",
  "let t = 0;",
  "for (let r = 0; r < 300; r++) for (const f of fns) t += f(a);",
  "if (!(t > 0)) throw new Error('no work done');",
].join("\n");

/** The trace lines from the first of the workload's own functions on. */
function traceOfWorkload(script: string): string[] {
  const result = spawnSync(
    process.execPath,
    ["--trace-baseline", "--trace-baseline-batch-compilation", "--input-type=module", "-e", script],
    { encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.split(/\r?\n/u);
  const first = lines.findIndex((line) => /Enqueued SFI safeExitWork\d/u.test(line));
  expect(first, "the workload's functions reached Sparkplug").toBeGreaterThanOrEqual(0);
  return lines.slice(first);
}

const count = (lines: readonly string[], text: string) =>
  lines.filter((line) => line.includes(text)).length;

const CONCURRENT = "[Concurrent Sparkplug] compiling";
const BATCH = "[Baseline batch compilation] Compiling current batch";

describe("[A2.3.12.1.runtime.safe-exit] no Sparkplug batch on a V8 worker when a process exits", () => {
  test("the pinned runtime compiles batches on a worker; with the module loaded first, none", () => {
    // Without the module the pinned Node hands batches to a worker thread. When this stops being
    // so, the runtime no longer needs safe-exit.ts: re-check its reason before removing it.
    const bare = traceOfWorkload(WORKLOAD);
    expect(count(bare, BATCH)).toBeGreaterThan(0);
    expect(count(bare, CONCURRENT)).toBeGreaterThan(0);

    const guarded = traceOfWorkload(`import ${JSON.stringify(MODULE)};\n${WORKLOAD}`);
    // The same functions are still compiled in batches, only on the main thread.
    expect(count(guarded, BATCH)).toBeGreaterThan(0);
    expect(count(guarded, CONCURRENT)).toBe(0);
  }, 120_000);

  test("every entry of the product's processes imports it before any other module", () => {
    for (const [file, specifier] of [
      ["packages/cli/src/bin.ts", "@tasks/bridge/safe-exit"],
      ["packages/cli/src/entry.ts", "@tasks/bridge/safe-exit"],
      ["packages/bridge/src/mcp/main.ts", "../safe-exit.ts"],
    ] as const) {
      const source = readFileSync(new URL(file, REPO), "utf8");
      const first = /^\s*import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/mu.exec(source);
      expect(first?.[1], file).toBe(specifier);
    }
  });
});
