// The Verify line of M0.04 (A7 3.7): "Runs at 1 % scale in CI". The whole bench runs as the lab
// runs it, as a child process of the pinned Node, in a temporary folder. The test then checks that
// every result file is complete and that the seeded generator is deterministic, also across
// operating systems (fixed digests). Further tests cover the fixes of the first review: failures
// release their connections and keep the original error, verdicts only under the prescribed
// conditions, A1-shaped timed writes and the projection's bookkeeping. Those of the second review
// cover R02's start-up race, R04's senders after a failure and the refusal of a used --out.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { describeError, inRunFolder } from "./cleanup.ts";
import { corpusDigest, generateSpace, type SpaceOptions } from "./fixture.ts";
import { r02 } from "./r02.ts";
import { r03 } from "./r03.ts";
import { r04 } from "./r04.ts";
import { r05 } from "./r05.ts";
import { r06 } from "./r06.ts";
import { condition, type Context, machine, verdict } from "./results.ts";
import { SCHEMA } from "./schema.ts";
import { openWriter, SpaceWriter } from "./space.ts";
import { BenchWorker } from "./threads.ts";

const RUN = fileURLToPath(new URL("./run.ts", import.meta.url));
const SCALE = 0.01;
// The whole run must fit well inside the CI job. At 1 % it takes a few seconds on the Windows lab machine.
const BUDGET_MS = 90_000;
const ROWS = ["R02", "R03", "R04", "R05", "R06"] as const;
/** Repeated starts for the start-up race of the second review (5 of 15 starts failed). */
const STARTS = 20;
// The tests below with a 180 s limit take a few seconds on a developer machine. A loaded Windows
// CI runner needed more than 60 s for two of them (2026-11-12). A real hang still fails.

// Digests of the default text profile. They are the same on every OS and must not change, so
// earlier numbers stay comparable. A generator change that moves them is stated in A1 3.20.
const TINY_DIGEST = "4bbab0522683c0e208b05b549433c7649ac24a90e7f7538cdb646dfd9da128de";
const ONE_PERCENT_DIGESTS = [
  "4c653798aa61c853e965c34105ada1f71c6c0664a7c51df562d267f8427ed9ef",
  "fc30660a0ab344324fc034b72aa90748a5c7eab969916d91ef7ac480be1c644f",
  "fbfe67576fdd5d878f914236dd2a9cdf911e33b19f4efae6b7943b74bdc0bf2c",
];

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(os.tmpdir(), "tasks-storage-bench-"));
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

interface Child {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** The deadline passed and the child was killed. */
  timedOut: boolean;
}

/** Runs the pinned Node with `args`. At the deadline the child is killed and its close awaited. */
function runNode(args: readonly string[], deadlineMs: number): Promise<Child> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, deadlineMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - started, timedOut });
    });
  });
}

const runBench = (args: readonly string[], deadlineMs = BUDGET_MS): Promise<Child> =>
  runNode([RUN, ...args], deadlineMs);

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const latencyKeys = ["count", "p50", "p95", "p99", "max", "mean"];

function expectLatency(value: unknown): void {
  expect(value).toBeTypeOf("object");
  const l = value as Record<string, unknown>;
  for (const key of latencyKeys) {
    expect(l[key], key).toBeTypeOf("number");
    expect(Number.isFinite(l[key]), key).toBe(true);
  }
  expect(l["count"] as number).toBeGreaterThan(0);
  expect(l["p50"] as number).toBeLessThanOrEqual(l["p95"] as number);
  expect(l["p95"] as number).toBeLessThanOrEqual(l["p99"] as number);
}

const space = (
  seed: string,
  open: number,
  completed: number,
  extra: Partial<SpaceOptions> = {},
): SpaceOptions => ({ seed, open, completed, history: true, name: "Mira", prefix: "M", ...extra });

/** A context that claims full scale, so only the rows' own counts can make a run indicative. */
const fullScaleContext = (out: string): Context => ({
  scale: 1,
  seed: "mira-ci",
  text: "default",
  machine: machine("desktop"),
  out,
});

describe("[A7.3.7.storage-bench.one-percent] the storage bench runs at 1 % scale", () => {
  test(
    "generators and every benchmark finish in the CI budget and write complete results",
    async () => {
      const out = join(root, "results");
      const work = join(root, "work");
      mkdirSync(work);
      const child = await runBench([
        "--scale",
        String(SCALE),
        "--out",
        out,
        "--work",
        work,
        "--seed",
        "mira-ci",
        "--layout",
      ]);
      expect(child.timedOut).toBe(false);
      expect(child.stderr).toBe("");
      expect(child.code).toBe(0);
      expect(child.ms).toBeLessThan(BUDGET_MS);

      // Every row prints its percentiles and its pass threshold, and says why it is not judged.
      for (const row of ROWS) {
        expect(child.stdout).toMatch(new RegExp(`${row} .*p50 .*p95 .*p99 `));
        expect(child.stdout).toMatch(
          new RegExp(
            `${row} threshold: .* -> not judged, indicative only: scale 0.01 \\(needs 1\\)`,
          ),
        );
      }

      // The temporary database folder is gone and nothing else was written into the work folder.
      expect(readdirSync(work)).toEqual([]);

      const files = readdirSync(out).sort();
      expect(files).toEqual([
        "R02.json",
        "R03.json",
        "R04.json",
        "R05.json",
        "R06.json",
        "corpus.json",
        "history-layout.json",
        "summary.json",
      ]);

      const corpus = readJson(join(out, "corpus.json"));
      expect(corpus["complete"]).toBe(true);
      expect(corpus["scale"]).toBe(SCALE);
      expect(corpus["seed"]).toBe("mira-ci");
      expect(corpus["textProfile"]).toBe("default");
      const spaces = corpus["spaces"] as Record<string, unknown>[];
      expect(spaces.map((s) => s["role"])).toEqual(["primary", "second", "stress"]);
      expect(spaces.map((s) => [s["open"], s["completed"]])).toEqual([
        [50, 500],
        [50, 500],
        [100, 1000],
      ]);
      // The same corpus on every OS: Windows and Ubuntu CI check the same fixed digests.
      expect(spaces.map((s) => s["digest"])).toEqual(ONE_PERCENT_DIGESTS);
      for (const s of spaces) {
        expect(s["bytes"] as number).toBeGreaterThan(0);
        // Text distributions per kind: count, median, p95 and total bytes.
        const text = s["text"] as Record<string, Record<string, number>>;
        expect(Object.keys(text)).toEqual([
          "title",
          "summary",
          "context",
          "outcome",
          "note",
          "log",
        ]);
        for (const [kind, d] of Object.entries(text)) {
          expect(d["count"], kind).toBeGreaterThan(0);
          expect(d["median"], kind).toBeGreaterThan(0);
          expect(d["median"], kind).toBeLessThanOrEqual(d["p95"] as number);
          expect(d["totalBytes"], kind).toBeGreaterThanOrEqual(d["count"] as number);
        }
        expect(text["context"]?.["count"]).toBe((s["open"] as number) + (s["completed"] as number));
      }

      for (const row of ROWS) {
        const r = readJson(join(out, `${row}.json`));
        expect(r["row"], row).toBe(row);
        expect(r["complete"], row).toBe(true);
        expect(r["scale"], row).toBe(SCALE);
        expect(r["text"], row).toBe("default");
        expect(r["threshold"], row).toBeTypeOf("string");
        // Thresholds are judged only under the row's prescribed conditions.
        expect(r["judged"], row).toBe(false);
        expect(r["indicative"], row).toBe(true);
        expect(r["pass"], row).toBeNull();
        const conditions = r["conditions"] as Record<string, unknown>[];
        expect(conditions[0], row).toEqual({
          name: "scale",
          required: "1",
          actual: SCALE,
          met: false,
        });
        expectLatency(r["latency"]);
        expect(r["machine"], row).toMatchObject({ node: process.version, sqlite: "3.54.1" });
      }

      const r02m = readJson(join(out, "R02.json"))["metrics"] as Record<string, unknown>;
      expect(r02m).toMatchObject({ integrity: "ok", consistencyErrors: 0, backupSteps: 1 });
      expect(r02m["readerQueries"] as number).toBeGreaterThan(0);
      expect(r02m["writerCommits"] as number).toBeGreaterThan(0);

      const r03 = readJson(join(out, "R03.json"));
      expect(r03["metrics"]).toMatchObject({ patches: 50, synchronous: "FULL" });
      expectLatency((r03["metrics"] as Record<string, unknown>)["receiptOnly"]);

      const r04 = readJson(join(out, "R04.json"));
      expect(r04["metrics"]).toMatchObject({
        writers: 10,
        sessions: 10,
        overloaded: 0,
        seconds: 3,
      });

      const r05m = readJson(join(out, "R05.json"))["metrics"] as Record<string, unknown>;
      expect(r05m["tasks"]).toBe(550);
      expect(r05m["trigramPresent"]).toBe(true);
      expectLatency(r05m["trigram"]);
      expectLatency(r05m["stress"]);
      // Three size readings of the trigram index, reported apart.
      const ratio = r05m["trigramRatio"] as number;
      expect(ratio).toBeGreaterThan(0);
      expect(r05m["trigramIndexRatio"] as number).toBeGreaterThan(0);
      expect(r05m["combinedRatio"] as number).toBeCloseTo(1 + ratio, 2);
      // Broad, selective and no-hit queries, each with its own percentiles.
      for (const key of ["groups", "stressGroups"]) {
        const groups = r05m[key] as Record<string, Record<string, unknown>>;
        expect(Object.keys(groups)).toEqual(["broad", "selective", "noHit"]);
        for (const g of Object.values(groups)) {
          expect(g["queries"]).toBe(50);
          expectLatency(g["latency"]);
        }
        const matches = (g: string): Record<string, number> =>
          groups[g]?.["matches"] as Record<string, number>;
        expect(groups["broad"]?.["hits"] as number).toBeGreaterThan(0);
        expect(groups["selective"]?.["hits"] as number).toBeGreaterThan(0);
        expect(matches("selective")["median"]).toBeLessThan(matches("broad")["median"] as number);
        expect(groups["noHit"]?.["hits"]).toBe(0);
        expect(matches("noHit")["max"]).toBe(0);
      }
      expect((r05m["groups"] as Record<string, unknown>)["broad"]).toMatchObject({
        latency: readJson(join(out, "R05.json"))["latency"],
      });

      const r06m = readJson(join(out, "R06.json"))["metrics"] as Record<string, unknown>;
      expect(r06m).toMatchObject({ files: 550, projectionFiles: 550 });
      // R02 to R04 left projection outbox rows. The rebuild acknowledged them.
      expect(r06m["outboxAcknowledged"] as number).toBeGreaterThan(0);
      expectLatency(r06m["bookkeeping"]);
      expect(r06m["omitted"]).toBeInstanceOf(Array);

      const layout = readJson(join(out, "history-layout.json"));
      expect(layout["complete"]).toBe(true);
      expect(layout["pageSize"]).toBe(4096);
      expect(layout["maxLocalPayload"]).toEqual({ withoutRowid: 1002, rowid: 4061 });
      const withoutRowid = layout["withoutRowid"] as Record<string, Record<string, unknown>>;
      const rowid = layout["rowid"] as Record<string, Record<string, unknown>>;
      const inPlace = layout["inPlace"] as Record<string, unknown>;
      expect(layout["rows"] as number).toBeGreaterThan(0);
      expect(withoutRowid["rows"]).toBe(layout["rows"]);
      expect(rowid["rows"]).toBe(layout["rows"]);
      // The primary's own table also holds the benchmarks' change rows. The copies do not.
      expect(inPlace["rows"] as number).toBeGreaterThan(layout["rows"] as number);
      expect(Object.keys(withoutRowid["indexes"] as object).sort()).toEqual([
        "changes_entity",
        "changes_task",
      ]);
      expect(Object.keys(rowid["indexes"] as object).sort()).toEqual([
        "changes_entity",
        "changes_task",
        "sqlite_autoindex_changes_1",
      ]);
      // Both copies hold the same rows. The payload of the table is the same either way.
      expect(withoutRowid["table"]?.["overflowPages"] as number).toBeGreaterThan(0);
      for (const l of [withoutRowid, rowid]) {
        expect(l["totalBytes"] as unknown as number).toBeGreaterThan(0);
        expect(l["fileBytes"] as unknown as number).toBeGreaterThan(0);
      }

      const summary = readJson(join(out, "summary.json"));
      expect(summary["complete"]).toBe(true);
      const rows = summary["rows"] as Record<string, unknown>[];
      expect(rows.map((r) => r["row"])).toEqual([...ROWS]);
      for (const r of rows) {
        expect(r["indicative"]).toBe(true);
        expect((r["unmet"] as string[])[0]).toBe("scale 0.01 (needs 1)");
      }
    },
    BUDGET_MS + 30_000,
  );

  // Second review: R02 started its writer and readers at once, and journal_mode = WAL ran before
  // busy_timeout, so about one start in three failed with "database is locked".
  test("a writer and two readers that open one database at the same moment all get ready", async () => {
    const dir = join(root, "concurrent-open");
    mkdirSync(dir);
    for (let i = 0; i < STARTS; i++) {
      const path = join(dir, `space-${String(i)}.db`);
      generateSpace(path, space(`mira-ci/open-${String(i)}`, 3, 12));
      const worker = (role: "writer" | "reader", name: string): BenchWorker =>
        new BenchWorker({ role, name: `${name}-${String(i)}`, paths: [path], seed: "open" });
      const workers = [
        worker("writer", "open-writer"),
        worker("reader", "open-reader-1"),
        worker("reader", "open-reader-2"),
      ];
      try {
        await Promise.all(workers.map((w) => w.next("ready")));
        // Stop before start: each role closes its connection and reports empty stats.
        for (const w of workers) w.send({ type: "stop" });
        await workers[0]?.next("writer-stats");
        await Promise.all(workers.slice(1).map((w) => w.next("reader-stats")));
      } finally {
        await Promise.all(workers.map((w) => w.terminate()));
      }
    }
  }, 180_000);

  test("R02 starts and finishes cleanly many times in a row at a tiny scale", async () => {
    const dir = join(root, "r02-starts");
    mkdirSync(dir);
    for (let i = 0; i < STARTS; i++) {
      const run = join(dir, String(i));
      mkdirSync(run);
      const primary = join(run, "primary.db");
      const second = join(run, "second.db");
      generateSpace(primary, space(`mira-ci/r02-${String(i)}`, 3, 12));
      generateSpace(second, space(`mira-ci/r02-second-${String(i)}`, 3, 12, { history: false }));
      const result = await r02(
        { ...fullScaleContext(run), scale: SCALE },
        { primary, second, backupTarget: join(run, "backup.db"), seconds: 0.2 },
      );
      expect(result.metrics).toMatchObject({ works: true, integrity: "ok" });
    }
  }, 180_000);

  test("a stuck child is killed at the deadline and its close awaited", async () => {
    const child = await runNode(["-e", "setInterval(() => {}, 1000)"], 500);
    expect(child.timedOut).toBe(true);
    expect(child.code).not.toBe(0);
    expect(child.ms).toBeLessThan(15_000);
  });
});

describe("[A7.3.7.storage-bench.seeded-generator] the fixture generator is deterministic", () => {
  test("one seed gives the same corpus twice, another seed a different one", () => {
    const dir = join(root, "determinism");
    mkdirSync(dir);
    const options = { open: 20, completed: 200, history: true, name: "Mira", prefix: "M" };
    const a = generateSpace(join(dir, "a.db"), { ...options, seed: "mira-ci" });
    const b = generateSpace(join(dir, "b.db"), { ...options, seed: "mira-ci" });
    const c = generateSpace(join(dir, "c.db"), { ...options, seed: "mira-other" });
    expect(corpusDigest(join(dir, "a.db"))).toBe(corpusDigest(join(dir, "b.db")));
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
    expect(a.tasks).toBe(220);
  });

  test("a tiny fixed seed and scale give a fixed digest on every OS", () => {
    const dir = join(root, "fixed");
    mkdirSync(dir);
    const tiny = generateSpace(join(dir, "tiny.db"), space("mira-ci", 3, 12));
    expect(tiny.digest).toBe(TINY_DIGEST);
    expect(tiny.tasks).toBe(15);
  });

  test("the heavy text profile is deterministic and leaves the default profile unchanged", () => {
    const dir = join(root, "heavy");
    mkdirSync(dir);
    const heavy = (name: string) =>
      generateSpace(join(dir, `${name}.db`), space("mira-ci", 3, 12, { text: "heavy" }));
    const a = heavy("a");
    const b = heavy("b");
    const plain = generateSpace(
      join(dir, "default.db"),
      space("mira-ci", 3, 12, { text: "default" }),
    );
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(TINY_DIGEST);
    expect(plain.digest).toBe(TINY_DIGEST);
    expect(a.notes + a.logEntries).toBeGreaterThan(plain.notes + plain.logEntries);
  });

  test("the bench run's primary space matches an in-process generation of the same seed", () => {
    const corpus = readJson(join(root, "results", "corpus.json"));
    const primary = (corpus["spaces"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const dir = join(root, "cross-process");
    mkdirSync(dir);
    const again = generateSpace(join(dir, "primary.db"), space("mira-ci/primary", 50, 500));
    expect(again.digest).toBe(primary["digest"]);
  });
});

describe("[A7.3.7.storage-bench.failure-cleanup] failures release connections, remove the run folder and keep the original error", () => {
  test("a generator that fails closes its connection, so the folder can be removed", () => {
    // A schema that already exists makes the generator fail right after it opened the database.
    const dir = join(root, "fail-schema");
    mkdirSync(dir);
    const path = join(dir, "space.db");
    const pre = new DatabaseSync(path);
    pre.exec(SCHEMA);
    pre.close();
    expect(() => generateSpace(path, space("x", 1, 1))).toThrow(/already exists/);
    // On Windows an open handle makes this fail with EPERM.
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  test("a failure inside the open generation transaction rolls back and closes", () => {
    const dir = join(root, "fail-begin");
    mkdirSync(dir);
    const path = join(dir, "space.db");
    expect(() => generateSpace(path, space("x", 2, 2, { faultAt: 0 }))).toThrow(
      "injected fault: generation stopped before task 0",
    );
    // Nothing of the failed transaction was kept.
    const db = new DatabaseSync(path, { readOnly: true });
    expect((db.prepare("SELECT count(*) AS n FROM actors").get() as { n: number }).n).toBe(0);
    db.close();
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  test("the bench removes its run folder after a failure and reports the injected error", async () => {
    const out = join(root, "fail-run");
    const work = join(root, "fail-work");
    mkdirSync(work);
    const child = await runBench(
      ["--scale", String(SCALE), "--out", out, "--work", work, "--inject-fault", "generate"],
      60_000,
    );
    expect(child.timedOut).toBe(false);
    expect(child.code).toBe(1);
    expect(child.stderr).toContain("storage bench failed: Error: injected fault");
    expect(child.stderr).not.toContain("could not be removed");
    expect(readdirSync(work)).toEqual([]);
  });

  // Second review: a failed rerun into the same --out left the earlier summary.json, complete: true.
  test("the bench refuses an --out folder that already holds files, and accepts an empty one", async () => {
    const out = join(root, "used-out");
    mkdirSync(out);
    const stale = `${JSON.stringify({ complete: true, rows: [] })}\n`;
    writeFileSync(join(out, "summary.json"), stale);
    const refused = await runBench(
      ["--scale", String(SCALE), "--out", out, "--inject-fault", "generate"],
      60_000,
    );
    expect(refused.timedOut).toBe(false);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--out must be a new or empty folder");
    expect(refused.stdout).toBe("");
    // Nothing was written or removed.
    expect(readdirSync(out)).toEqual(["summary.json"]);
    expect(readFileSync(join(out, "summary.json"), "utf8")).toBe(stale);

    // An existing empty folder is a new run's folder. The injected fault then stops the run.
    const empty = join(root, "empty-out");
    mkdirSync(empty);
    const accepted = await runBench(
      ["--scale", String(SCALE), "--out", empty, "--inject-fault", "generate"],
      60_000,
    );
    expect(accepted.code).toBe(1);
    expect(accepted.stderr).toContain("storage bench failed: Error: injected fault");
    expect(readdirSync(empty)).toEqual([]);
  }, 130_000);

  // Second review: after a queue failure R04 rejected at once, but its send timers kept the process
  // alive for the rest of the run. The child below exits only when nothing is left pending.
  test("a failed R04 run stops its senders, so the process exits right after the failure", async () => {
    const dir = join(root, "r04-failure");
    mkdirSync(dir);
    const primary = join(dir, "space.db");
    generateSpace(primary, space("mira-ci/r04-failure", 3, 12));
    // Every patch now fails inside the queue worker, after it reported ready.
    const db = new DatabaseSync(primary);
    db.exec(`CREATE TRIGGER fail BEFORE UPDATE ON tasks
      BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END`);
    db.close();
    const module = (name: string): string => JSON.stringify(new URL(name, import.meta.url).href);
    const script = `
      const { r04 } = await import(${module("./r04.ts")});
      const { machine } = await import(${module("./results.ts")});
      const ctx = { scale: 0.01, seed: "r04-failure", text: "default",
        machine: machine("desktop"), out: ${JSON.stringify(dir)} };
      await r04(ctx, { primary: ${JSON.stringify(primary)}, writers: 10, seconds: 60 }).then(
        () => console.log("no failure"),
        (error) => console.log(String(error)),
      );`;
    // No --input-type: worker threads inherit the flags and refuse it for a file entry point.
    // Node detects the module syntax of the script itself.
    const child = await runNode(["-e", script], 30_000);
    expect(child.timedOut).toBe(false);
    expect(child.stderr).toBe("");
    expect(child.stdout).toContain("r04-queue worker: injected queue failure");
    // The run asked for 60 s. Start-up and the failure take well under a second on the Windows lab machine.
    expect(child.ms).toBeLessThan(10_000);
  }, 40_000);

  test("when the folder cannot be removed either, both errors are reported, the original first", async () => {
    const original = new Error("generation failed");
    const removal = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    const removed: string[] = [];
    const failing = (dir: string): void => {
      removed.push(dir);
      throw removal;
    };
    const both = await inRunFolder("run-dir", false, () => Promise.reject(original), failing).catch(
      (e: unknown) => e,
    );
    expect(removed).toEqual(["run-dir"]);
    expect(both).toBeInstanceOf(AggregateError);
    expect((both as AggregateError).errors).toEqual([original, removal]);
    const text = describeError(both);
    expect(text).toContain("could not be removed: run-dir");
    expect(text.indexOf("generation failed")).toBeLessThan(text.indexOf("EPERM"));

    // A failed run whose folder is removed reports its own error unchanged.
    const alone = await inRunFolder(
      "run-dir",
      false,
      () => Promise.reject(original),
      () => undefined,
    ).catch((e: unknown) => e);
    expect(alone).toBe(original);

    // A successful run whose folder cannot be removed fails, naming the folder.
    const after = await inRunFolder("run-dir", false, () => Promise.resolve(1), failing).catch(
      (e: unknown) => e,
    );
    expect(after).toBeInstanceOf(Error);
    expect((after as Error).cause).toBe(removal);
    expect(describeError(after)).toContain("caused by: Error: EPERM");

    // --keep never removes.
    removed.length = 0;
    await expect(inRunFolder("run-dir", true, () => Promise.resolve(2), failing)).resolves.toBe(2);
    expect(removed).toEqual([]);
  });
});

describe("[A7.3.7.storage-bench.verdict-conditions] a verdict only under the row's prescribed conditions", () => {
  test("verdict() judges only when every condition holds", () => {
    const met = condition("seconds", ">= 300", 300, true);
    const short = condition("seconds", ">= 300", 1, false);
    expect(verdict([met], () => true)).toMatchObject({ judged: true, pass: true });
    expect(verdict([met], () => false)).toMatchObject({ judged: true, pass: false });
    let asked = false;
    const indicative = verdict([met, short], () => (asked = true));
    expect(indicative).toMatchObject({ judged: false, pass: null });
    expect(asked).toBe(false);
  });

  test("rows run at scale 1 with shortened counts or durations are indicative", async () => {
    const dir = join(root, "conditions");
    mkdirSync(dir);
    const primary = join(dir, "space.db");
    const stress = join(dir, "stress.db");
    generateSpace(primary, space("mira-ci/primary", 20, 80));
    generateSpace(stress, space("mira-ci/stress", 20, 80, { history: false }));
    const ctx = fullScaleContext(dir);
    const unmetNames = (r: { conditions: { name: string; met: boolean }[] }): string[] =>
      r.conditions.filter((c) => !c.met).map((c) => c.name);

    const a = await r02(ctx, {
      primary,
      second: stress,
      backupTarget: join(dir, "backup.db"),
      seconds: 1,
    });
    expect(a).toMatchObject({ judged: false, pass: null });
    expect(unmetNames(a)).toEqual(["seconds"]);

    const b = r03(ctx, { primary, patches: 20 });
    expect(b).toMatchObject({ judged: false, pass: null });
    expect(unmetNames(b)).toEqual(["patches"]);

    // The reviewer's case: a one-second R04 at scale 1 returned judged: true, pass: true.
    const c = await r04(ctx, { primary, writers: 10, seconds: 1 });
    expect(c).toMatchObject({ judged: false, pass: null });
    expect(unmetNames(c)).toEqual(["seconds"]);
    expect(c.metrics["requests"]).toBe(10);

    const d = r05(ctx, { primary, stress, queries: 10 });
    expect(d).toMatchObject({ judged: false, pass: null });
    expect(unmetNames(d)).toEqual(["tasks", "broad queries"]);

    const e = r06(ctx, { primary, spaceDir: dir });
    expect(e).toMatchObject({ judged: false, pass: null });
    expect(unmetNames(e)).toEqual(["files"]);
  }, 180_000);
});

describe("[A7.3.7.storage-bench.write-shape] timed writes and the projection rebuild write what A1 says", () => {
  test("timed patches carry random A1 commit IDs, request IDs and agent sessions", () => {
    const dir = join(root, "write-shape");
    mkdirSync(dir);
    const primary = join(dir, "space.db");
    const info = generateSpace(primary, space("mira-ci/primary", 20, 80));
    const db = openWriter(primary);
    try {
      const writer = new SpaceWriter(db, "shape", 3);
      expect(writer.sessions).toHaveLength(3);
      for (const s of writer.sessions) expect(s).toMatch(/^se_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
      for (let i = 0; i < 30; i++) {
        writer.patchSummary(
          writer.openRefs[i % writer.openRefs.length] as number,
          `Summary ${String(i)}`,
          i % 3,
        );
      }
      const commits = db
        .prepare(
          "SELECT id, session_id, scope_id, request_id FROM commits WHERE seq > ? ORDER BY seq",
        )
        .all(info.lastSeq) as Record<string, string>[];
      expect(commits).toHaveLength(30);
      for (const c of commits) {
        expect(c["id"]).toMatch(/^op_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
        expect(c["request_id"]).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
        expect(writer.sessions).toContain(c["session_id"]);
        expect(c["scope_id"]).toBe(c["session_id"]);
      }
      // Random IDs: not in insertion order, and every session has its share.
      const ids = commits.map((c) => c["id"] as string);
      expect([...ids].sort()).not.toEqual(ids);
      expect(new Set(commits.map((c) => c["session_id"])).size).toBe(3);
      // The commits_session index sees these rows.
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT seq FROM commits WHERE session_id = ? ORDER BY seq")
        .all(writer.sessions[0] as string) as { detail: string }[];
      expect(plan.map((p) => p.detail).join(" ")).toContain("commits_session");
      const n = db
        .prepare("SELECT count(*) AS n FROM commits WHERE session_id = ?")
        .get(writer.sessions[1] as string) as { n: number };
      expect(n.n).toBe(10);
    } finally {
      db.close();
    }
  });

  test("the projection rebuild records projection_files and acknowledges the outbox", () => {
    const dir = join(root, "write-shape");
    const primary = join(dir, "space.db");
    const before = new DatabaseSync(primary, { readOnly: true });
    const pending = (
      before.prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'projection'").get() as {
        n: number;
      }
    ).n;
    before.close();
    expect(pending).toBeGreaterThan(0);

    const result = r06(fullScaleContext(dir), { primary, spaceDir: dir });
    expect(result.metrics).toMatchObject({
      files: 100,
      projectionFiles: 100,
      outboxAcknowledged: pending,
    });

    const db = new DatabaseSync(primary, { readOnly: true });
    try {
      expect(
        (
          db.prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'projection'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      const files = db
        .prepare("SELECT path, task_id, sha256, seq, entry FROM projection_files ORDER BY path")
        .all() as Record<string, unknown>[];
      expect(files).toHaveLength(100);
      const lastSeq = (db.prepare("SELECT last_seq AS s FROM space").get() as { s: number }).s;
      for (const f of files.slice(0, 10)) {
        const text = readFileSync(join(dir, "view", f["path"] as string), "utf8");
        expect(createHash("sha256").update(text).digest("hex")).toBe(f["sha256"]);
        expect(f["seq"]).toBe(lastSeq);
        expect(JSON.parse(f["entry"] as string)).toMatchObject({
          id: f["task_id"],
          path: f["path"],
        });
      }
      // The catalogue is assembled from projection_files, with the watermark in its header.
      const catalog = readFileSync(join(dir, "view", "catalog.jsonl"), "utf8")
        .trimEnd()
        .split("\n");
      expect(catalog).toHaveLength(101);
      expect(JSON.parse(catalog[0] as string)).toMatchObject({ kind: "header", seq: lastSeq });
      expect(result.metrics["watermark"]).toBe(lastSeq);
      expect(readJson(join(dir, "view", ".projection.json"))).toMatchObject({
        seq: lastSeq,
        format: 1,
      });
    } finally {
      db.close();
    }
  });
});
