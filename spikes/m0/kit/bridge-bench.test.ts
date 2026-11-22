// Self-test of the bridge harness (A7 3.7, step M0.06): every row at a tiny size in a temporary
// folder, so CI shows the harness works on both runners. A tiny run proves the harness, not the
// machine: every row must come out "not judged".
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  across,
  readMemory,
  removeRunUserDir,
  runBridgeBench,
  summarize,
  type Hooks,
  type ProcessMemory,
} from "./bridge-bench.ts";
import { KitError } from "./wire.ts";

let work: string;

beforeAll(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-bridge-")));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("[A7.3.7.m0-bridge-bench.self-test] the M0 bridge harness", () => {
  test("nearest-rank percentiles", () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toMatchObject({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
    expect(summarize([])).toMatchObject({ count: 0, p95: 0 });
  });

  test("reads this process's memory from outside", () => {
    const [m] = readMemory([process.pid]);
    expect(m?.private).toBeGreaterThan(1024 * 1024);
    expect(m?.rss).toBeGreaterThan(1024 * 1024);
    // Windows starts Windows PowerShell for the reading: seconds under a parallel test run.
  }, 60_000);

  test("runs B01 to B05 at a tiny size and writes a result file per row, all not judged", async () => {
    const out = join(work, "results");
    const results = await runBridgeBench(
      ["B01", "B02", "B03", "B04"],
      {
        work: join(work, "w"),
        out,
        label: "tiny",
        role: "ci",
        calls: 2,
        idleMs: 100,
        bridges: 2,
        bridgeCalls: 3,
        directCalls: 4,
        quietMs: 100,
      },
      { runs: 2 },
    );
    expect(results.map((r) => r.row)).toEqual(["B01", "B06", "B07", "B02", "B03", "B05", "B04"]);
    for (const r of results) {
      expect(r.judged, r.row).toBe(false);
      expect(r.pass, r.row).toBeNull();
      const file = JSON.parse(readFileSync(join(out, `${r.row}-tiny.json`), "utf8")) as {
        row: string;
        machine: { role: string; node: string };
      };
      expect(file.row).toBe(r.row);
      expect(file.machine).toMatchObject({ role: "ci", node: process.version });
    }
    const b03 = results.find((r) => r.row === "B03")?.metrics as {
      handshakeFailures: number;
      callErrors: number;
      callMs: { count: number };
      addedPrivateMiB: number;
    };
    expect(b03.handshakeFailures).toBe(0);
    expect(b03.callErrors).toBe(0);
    expect(b03.callMs.count).toBe(6);
    expect(b03.addedPrivateMiB).toBeGreaterThan(0);
    const b05 = results.find((r) => r.row === "B05")?.metrics as { loopWindowMs: number };
    expect(b05.loopWindowMs).toBeGreaterThan(0);
    const b04 = results.find((r) => r.row === "B04")?.metrics as { bridgeMs: { count: number } };
    expect(b04.bridgeMs.count).toBe(4);
    // Nothing in a result file names a path of this machine.
    for (const name of readdirSync(out)) {
      expect(readFileSync(join(out, name), "utf8")).not.toContain(work.slice(0, 12));
    }
    // No per-user socket folder of any state folder the run used is left behind (Linux).
    const states = readdirSync(join(work, "w")).flatMap((name) =>
      name.startsWith("state-")
        ? [join(work, "w", name)]
        : name.startsWith("bench-")
          ? [join(work, "w", name, "state")]
          : [],
    );
    expect(states.length).toBe(4);
    const uid = process.getuid?.();
    if (process.platform === "linux" && uid !== undefined) {
      for (const state of states) {
        const install = createHash("sha256")
          .update(realpathSync.native(state), "utf8")
          .digest("hex")
          .slice(0, 16);
        expect(existsSync(`/run/user/${String(uid)}/ttasks-${install}`), state).toBe(false);
      }
    }
  }, 180_000);

  test("median and p95 across runs, judged on the p95 or on every run", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(across(values, { limit: 19, across: "p95" })).toMatchObject({
      median: 10,
      p95: 19,
      min: 1,
      max: 20,
      pass: true,
    });
    expect(across(values, { limit: 18, across: "p95" }).pass).toBe(false);
    expect(across([0, 0, 1], { limit: 0, across: "every" }).pass).toBe(false);
    expect(across([0, 0, 0], { limit: 0, across: "every" }).pass).toBe(true);
    expect(across([3, 1], null).pass).toBeNull();
  });

  test("--repeat writes one file per row with every run, the median and the p95", async () => {
    const out = join(work, "repeat");
    const results = await runBridgeBench(["B03", "B04"], {
      work: join(work, "r"),
      out,
      label: "rep",
      role: "ci",
      bridges: 2,
      bridgeCalls: 3,
      directCalls: 4,
      quietMs: 50,
      repeat: 3,
    });
    expect(results.map((r) => r.row)).toEqual(["B03", "B05", "B04"]);
    expect(readdirSync(out).sort()).toEqual(["B03-rep.json", "B04-rep.json", "B05-rep.json"]);
    for (const r of results) {
      // Three tiny runs: shown, never judged.
      expect(r.judged, r.row).toBe(false);
      const file = JSON.parse(readFileSync(join(out, `${r.row}-rep.json`), "utf8")) as {
        repeat: number;
        metrics: { across: Record<string, { values: number[]; median: number; p95: number }> };
        conditions: { name: string; actual: unknown }[];
      };
      expect(file.repeat).toBe(3);
      expect(file.conditions.find((c) => c.name === "runs")?.actual).toBe(3);
      for (const [name, s] of Object.entries(file.metrics.across)) {
        expect(s.values.length, `${r.row} ${name}`).toBe(3);
        expect(s.values.every(Number.isFinite), `${r.row} ${name}`).toBe(true);
        expect(s.p95).toBe(Math.max(...s.values));
      }
    }
    const b03 = JSON.parse(readFileSync(join(out, "B03-rep.json"), "utf8")) as {
      metrics: { across: Record<string, { bound: unknown; values: number[] }> };
    };
    expect(b03.metrics.across["addedPrivateMiB"]?.bound).toEqual({ limit: 300, across: "p95" });
    expect(b03.metrics.across["handshakeFailures"]?.values).toEqual([0, 0, 0]);
    const b05 = JSON.parse(readFileSync(join(out, "B05-rep.json"), "utf8")) as {
      metrics: { runs: { metrics: { monitorResolutionMs: number } }[] };
    };
    expect(b05.metrics.runs[0]?.metrics.monitorResolutionMs).toBe(10);
    // The windows-2025 runner once needed 192 s for it under a parallel run.
  }, 360_000);
});

/** True while a process with this ID exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("[A7.3.7.m0-bridge-bench.cleanup] the bridge harness leaves no process behind when a row fails", () => {
  const tiny = (name: string, hooks: Hooks) => ({
    work: join(work, `fail-${name}`),
    out: join(work, `fail-${name}-out`),
    label: name,
    role: "ci",
    calls: 1,
    idleMs: 50,
    bridges: 2,
    bridgeCalls: 2,
    directCalls: 2,
    quietMs: 50,
    hooks,
  });

  /** Runs one failing row, then checks every process it spawned is gone (and kills strays). */
  async function expectNoSurvivors(
    row: "B02" | "B03" | "B04",
    name: string,
    hooks: Hooks,
    code: string,
  ): Promise<void> {
    const spawned: { pid: number; what: string }[] = [];
    const options = tiny(name, {
      ...hooks,
      spawned: (pid, what) => spawned.push({ pid, what }),
    });
    try {
      await expect(runBridgeBench([row], options)).rejects.toMatchObject({ code });
      expect(spawned.length, "the run started processes").toBeGreaterThan(0);
      const survivors = spawned.filter((p) => alive(p.pid));
      expect(survivors).toEqual([]);
      // No per-user socket folder is left for the failed row's state folder (Linux).
      for (const entry of readdirSync(options.work).filter((n) => n.startsWith("state-"))) {
        expect(removeRunUserDir(join(options.work, entry))).toBe("none");
      }
    } finally {
      for (const p of spawned) if (alive(p.pid)) process.kill(p.pid);
    }
  }

  const failingMemory = (pids: number[]): ProcessMemory[] => {
    if (pids.length > 1) throw new KitError("memory_unreadable", "Injected memory failure.");
    return readMemory(pids);
  };

  test("B03: a memory reading that fails after the burst", async () => {
    await expectNoSurvivors("B03", "memory", { readMemory: failingMemory }, "memory_unreadable");
  }, 120_000);

  test("B03: the service fails during its start", async () => {
    await expectNoSurvivors(
      "B03",
      "service",
      {
        serviceUp: () => {
          throw new KitError("injected", "Injected service start failure.");
        },
      },
      "injected",
    );
  }, 120_000);

  test("B04: the direct client fails to connect", async () => {
    await expectNoSurvivors(
      "B04",
      "direct",
      {
        connectDirect: () => Promise.reject(new KitError("injected", "Injected client failure.")),
      },
      "injected",
    );
  }, 120_000);

  test("B02: a memory reading that fails", async () => {
    await expectNoSurvivors(
      "B02",
      "b02",
      {
        readMemory: () => {
          throw new KitError("memory_unreadable", "Injected memory failure.");
        },
      },
      "memory_unreadable",
    );
  }, 120_000);
});
