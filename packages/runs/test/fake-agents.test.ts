// Fake agents replay a recording as the real child process did (M6.05, A4 5.1 "Fake agents").
// Stdout is compared as bytes and parsed into shapes and counts; nothing of it is printed.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { parseStream } from "../src/index.ts";
import {
  FAKE_AGENT_GUARD_EXIT,
  fakeAgentCommand,
  replayPlan,
  type FakeAgentOptions,
  type FakeAgentReport,
} from "./fake-agents.ts";
import { fixtureBytes, fixtureEntry, fixtureFiles } from "./fixtures.ts";

const WINDOWS = process.platform === "win32";
const BRIEF = "Fixture brief: call the probe, then reply.\n";

// Made in beforeAll, not at import: collecting this file (the manifest check lists every test)
// must not leave a folder behind.
let tempRoot = "";
beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "ttasks-m6-05-fake-agents-"));
});
afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Fakes still running: a test that failed while one held is followed by its kill. */
const live = new Set<Fake>();
afterEach(async () => {
  const left = [...live];
  live.clear();
  for (const fake of left) fake.child.kill("SIGKILL");
  await Promise.all(left.map((fake) => fake.exited));
});

interface Fake {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  /** Resolves once stdout holds at least `n` bytes; rejects if the fake ends first. */
  bytes(n: number): Promise<void>;
  /** Stdout so far. */
  stdout(): Buffer;
  /** Resolves with the exit once the process ended and its pipes closed. */
  exited: Promise<{ code: number | null; signal: string | null; stdout: Buffer; stderr: string }>;
  chunks(): number;
}

function startFake(
  fixture: string,
  options: FakeAgentOptions = {},
  brief = BRIEF,
  env: NodeJS.ProcessEnv = process.env,
): Fake {
  const { command, args } = fakeAgentCommand(fixture, options);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
  const out: Buffer[] = [];
  let size = 0;
  let waiters: { n: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  let closed = false;
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    out.push(d);
    size += d.length;
    waiters = waiters.filter((w) => {
      if (size < w.n) return true;
      w.resolve();
      return false;
    });
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin.end(brief);
  const exited = new Promise<{
    code: number | null;
    signal: string | null;
    stdout: Buffer;
    stderr: string;
  }>((resolve) => {
    const settle = (code: number | null, signal: string | null): void => {
      if (closed) return;
      closed = true;
      live.delete(fake);
      for (const w of waiters) w.reject(new Error("the fake ended before writing enough bytes"));
      waiters = [];
      resolve({ code, signal, stdout: Buffer.concat(out), stderr });
    };
    child.on("close", settle);
    // A failed spawn reports an error; settle on it too, once.
    child.on("error", () => {
      settle(null, null);
    });
  });
  const fake: Fake = {
    child,
    bytes: (n) =>
      new Promise((resolve, reject) => {
        if (size >= n) resolve();
        else if (closed) reject(new Error("the fake ended before writing enough bytes"));
        else waiters.push({ n, resolve, reject });
      }),
    stdout: () => Buffer.concat(out),
    exited,
    chunks: () => out.length,
  };
  live.add(fake);
  return fake;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const joined = (lines: readonly Uint8Array[]): Buffer => Buffer.concat(lines);
const plain = fixtureFiles().filter((f) => fixtureEntry(f).cancel === null);
const killed = fixtureFiles().filter((f) => {
  const e = fixtureEntry(f);
  return e.cancel !== null && replayPlan(e, fixtureBytes(f)).graceful === null;
});

describe("[A4.5.fake-agents.replay] fake agents replay the recordings", () => {
  test("the replay plan holds where each cancel came and keeps what followed it", () => {
    const tail = (file: string) => {
      const p = replayPlan(fixtureEntry(file), fixtureBytes(file));
      return { hold: p.holdAt, after: p.lines.length - (p.holdAt ?? p.lines.length), p };
    };
    // Claude on Ctrl+C: the tool-result errors and the result came after the cancel.
    const c = tail("claude-print/windows-cancel-ctrl-c.jsonl");
    expect([c.after, c.p.graceful, c.p.exitCode]).toEqual([3, "SIGINT", 0]);
    expect(tail("claude-print/windows-cancel-ctrl-c-early.jsonl").after).toBe(2);
    const b = tail("claude-print/windows-cancel-ctrl-break.jsonl");
    expect([b.after, b.p.graceful, b.p.exitCode]).toEqual([1, "SIGBREAK", 0]);
    // Killed runs write everything and wait for the kill.
    for (const f of killed) {
      const k = tail(f);
      expect([k.after, k.p.graceful, k.p.exitCode]).toEqual([0, null, null]);
    }
    // Runs without a cancel write everything and exit as recorded.
    for (const f of plain) {
      const p = replayPlan(fixtureEntry(f), fixtureBytes(f));
      expect([p.holdAt, p.exitCode]).toEqual([null, fixtureEntry(f).exit]);
      expect(same(joined(p.lines), fixtureBytes(f))).toBe(true);
    }
  });

  test("a run without a cancel gives the recorded bytes and exit code", async () => {
    const results = await Promise.all(
      plain.map(async (file) => ({ file, r: await startFake(file).exited })),
    );
    expect(plain.length).toBeGreaterThanOrEqual(5);
    for (const { file, r } of results) {
      const entry = fixtureEntry(file);
      expect([file, r.code, r.signal]).toEqual([file, entry.exit, null]);
      expect(same(r.stdout, fixtureBytes(file))).toBe(true);
      // The stderr line names the class only.
      expect(r.stderr).toBe(
        entry.stderr_class === "none" ? "" : `fake-agent: ${entry.stderr_class}\n`,
      );
      // Parsed from the pipe, the outcome is the recording's.
      const exit = { code: r.code, signal: r.signal };
      const fromPipe = parseStream(entry.cli, r.stdout, exit).outcome;
      expect(fromPipe).toEqual(parseStream(entry.cli, fixtureBytes(file), exit).outcome);
    }
  });

  test("the report holds argv, cwd, environment names and the brief's size and hash", async () => {
    const report = join(tempRoot, "report.json");
    const argv = ["-p", "--output-format", "stream-json", "a b; & | \" ' $ % ! ^ `", "Café"];
    const brief = "Mira's R&D; tests (v2)/Café ‮​\n";
    const env = { ...process.env, FAKE_AGENT_TEST_MARKER: "value-not-reported" };
    const r = await startFake(
      "claude-print/windows-success-tool-call.jsonl",
      { report, argv },
      brief,
      env,
    ).exited;
    expect(r.code).toBe(0);
    const text = readFileSync(report, "utf8");
    expect(text.includes("value-not-reported")).toBe(false);
    const got = JSON.parse(text) as FakeAgentReport;
    expect(got.argv).toEqual(argv);
    expect(got.cwd).toBe(process.cwd());
    const here = statSync(".", { bigint: true });
    expect(got.cwdId).toBe(`${here.dev.toString()}:${here.ino.toString()}`);
    expect(got.envNames).toContain("FAKE_AGENT_TEST_MARKER");
    const bytes = Buffer.from(brief, "utf8");
    expect(got.stdinBytes).toBe(bytes.length);
    expect(got.stdinSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("a killed run writes its stream, cut line included, holds, and ends by the kill", async () => {
    for (const file of killed) {
      const want = fixtureBytes(file);
      const fake = startFake(file);
      await fake.bytes(want.length);
      // It holds: still running once the stream is out.
      expect(fake.child.exitCode).toBeNull();
      fake.child.kill();
      const r = await fake.exited;
      expect([file, r.code, r.signal]).toEqual([file, null, "SIGTERM"]);
      expect(same(r.stdout, want)).toBe(true);
    }
  });

  test.skipIf(WINDOWS)(
    "a graceful cancel releases what the CLI wrote after it, and the recorded exit",
    async () => {
      for (const file of [
        "claude-print/windows-cancel-ctrl-c.jsonl",
        "claude-print/windows-cancel-ctrl-c-early.jsonl",
      ]) {
        const entry = fixtureEntry(file);
        const plan = replayPlan(entry, fixtureBytes(file));
        const before = joined(plan.lines.slice(0, plan.holdAt ?? 0));
        const fake = startFake(file);
        await fake.bytes(before.length);
        // Nothing past the hold point comes before the signal.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(fake.stdout().length).toBe(before.length);
        fake.child.kill("SIGINT");
        const r = await fake.exited;
        expect([file, r.code, r.signal]).toEqual([file, entry.exit, null]);
        expect(same(r.stdout, fixtureBytes(file))).toBe(true);
      }
    },
  );

  test("a wait for more bytes than the fake writes fails once it ends", async () => {
    const file = "claude-print/windows-resume.jsonl";
    const fake = startFake(file);
    await expect(fake.bytes(fixtureBytes(file).length + 1)).rejects.toThrow(/ended before/);
    expect((await fake.exited).code).toBe(fixtureEntry(file).exit);
    await expect(fake.bytes(1)).resolves.toBeUndefined();
  });

  test("a holding fake ends itself after --max-ms", async () => {
    const r = await startFake("claude-print/windows-cancel-terminate.jsonl", { maxMs: 300 }).exited;
    expect([r.code, r.signal]).toEqual([FAKE_AGENT_GUARD_EXIT, null]);
  });

  test("a line delay spreads the stream over time", async () => {
    const file = "claude-print/windows-success-tool-call.jsonl";
    const lines = replayPlan(fixtureEntry(file), fixtureBytes(file)).lines.length;
    const started = performance.now();
    const fake = startFake(file, { lineDelayMs: 40 });
    const r = await fake.exited;
    expect(performance.now() - started).toBeGreaterThanOrEqual((lines - 1) * 40);
    expect(fake.chunks()).toBeGreaterThan(1);
    expect(same(r.stdout, fixtureBytes(file))).toBe(true);
  });

  test("a wrong fixture name or option exits 2 with a fixed message", async () => {
    const bad = await startFake("claude-print/../../../package.json").exited;
    expect([bad.code, bad.stderr]).toEqual([2, "fake-agent: unknown fixture\n"]);
    const delay = await startFake("claude-print/windows-resume.jsonl", { lineDelayMs: -1 }).exited;
    expect(delay.code).toBe(2);
  });
});
