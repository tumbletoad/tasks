// Doctor's check of the agent's environment (A4 3.8; A3 3.14 `launch.env`; A7 3.11 M4.05b): the
// last snapshot attempt's outcome and the age of the one in use, and with `take` (`doctor --live`)
// a login-shell snapshot taken now, fresh or not, and kept when it succeeds; on Windows whether
// the registry could be read. Testkit's fake login shell stands in for a person's profile, and a fake
// capture for Windows PowerShell: no real profile or registry is read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FAKE_SHELL, readJsonLines } from "@ttasks/testkit";
import { captureOutput, UserEnvironment, type Capture } from "../src/index.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ttasks-env-check-"));
  temps.push(dir);
  return dir;
};

/** A capture that runs the fake login shell in `mode`, logging each run to `log`. */
function fakeShell(mode: string, log: string, exports: Record<string, string> = {}): Capture {
  return (request) =>
    request.argv[0] === "/bin/fake-login-shell"
      ? captureOutput({
          ...request,
          argv: [process.execPath, FAKE_SHELL, ...request.argv.slice(1)],
          env: {
            ...request.env,
            FAKE_SHELL_MODE: mode,
            FAKE_SHELL_LOG: log,
            FAKE_SHELL_EXPORTS: JSON.stringify(exports),
          },
        })
      : Promise.resolve({ kind: "failed", ms: 0 });
}

function linux(capture: Capture, state: string, now: () => number): UserEnvironment {
  return new UserEnvironment({
    platform: "linux",
    serviceEnv: { PATH: "/usr/bin:/bin", HOME: "/home/mira" },
    stateDir: state,
    home: state,
    loginShell: "/bin/fake-login-shell",
    capture,
    systemctl: undefined,
    now,
    bootId: () => "boot-1",
    snapshotTimeoutMs: 20_000,
  });
}

describe("[A4.5.environment.doctor] doctor's check of the agent's environment", () => {
  test(
    "without take nothing runs and the last attempt is reported; with take a snapshot is taken now, fresh or not, and a failure keeps the previous one",
    { timeout: 60_000 },
    async () => {
      const state = temp();
      const log = join(state, "shell.jsonl");
      let now = Date.UTC(2026, 10, 14, 8);
      const first = linux(fakeShell("ok", log, { FROM: "first" }), state, () => now);
      // Nothing attempted and nothing stored: nothing to say, and no shell ran.
      expect(await first.check(false)).toEqual({ kind: "snapshot" });
      expect(readJsonLines(log)).toHaveLength(0);
      await first.prepare();
      const firstAt = now;
      expect(await first.check(false)).toEqual({
        kind: "snapshot",
        outcome: "ok",
        attemptedAt: firstAt,
        takenAt: firstAt,
      });
      expect(readJsonLines(log)).toHaveLength(1);

      // An hour later the snapshot is fresh, and a launch would not take it again; --live does.
      now += 3_600_000;
      expect(await first.check(true)).toEqual({
        kind: "snapshot",
        outcome: "ok",
        attemptedAt: now,
        takenAt: now,
      });
      expect(readJsonLines(log)).toHaveLength(2);
      expect(first.snapshot()?.takenAt).toBe(now);

      // The profile breaks: the outcome says how, and the snapshot taken an hour ago stays.
      const taken = now;
      now += 3_600_000;
      const broken = linux(fakeShell("fail", log), state, () => now);
      // A new start has attempted nothing yet: only the stored snapshot's time.
      expect(await broken.check(false)).toEqual({ kind: "snapshot", takenAt: taken });
      expect(await broken.check(true)).toEqual({
        kind: "snapshot",
        outcome: "failed",
        attemptedAt: now,
        takenAt: taken,
      });
      expect((await broken.base()).env).toMatchObject({ FROM: "first" });
      // With none at all, there is no snapshot time to give.
      const none = linux(fakeShell("noise", join(temp(), "log.jsonl")), temp(), () => now);
      expect(await none.check(true)).toEqual({
        kind: "snapshot",
        outcome: "no_markers",
        attemptedAt: now,
      });
    },
  );

  test(
    "one snapshot at a time: doctor waits for a launch's refresh, and a launch joins doctor's",
    { timeout: 60_000 },
    async () => {
      const state = temp();
      const log = join(state, "shell.jsonl");
      const env = linux(fakeShell("ok", log, { FROM: "x" }), state, Date.now);
      // A launch's refresh under way: doctor takes its own after it.
      const [, checked] = await Promise.all([env.prepare(), env.check(true)]);
      expect(checked).toMatchObject({ kind: "snapshot", outcome: "ok" });
      expect(readJsonLines(log)).toHaveLength(2);
      // Doctor's under way: a launch waits for it and takes none of its own.
      await Promise.all([env.check(true), env.prepare()]);
      expect(readJsonLines(log)).toHaveLength(3);
    },
  );

  test("Windows: whether the registry could be read now", async () => {
    const windows = (capture: Capture) =>
      new UserEnvironment({
        platform: "win32",
        serviceEnv: { SystemRoot: "C:\\Windows" },
        stateDir: temp(),
        home: temp(),
        capture,
      });
    const failed: Capture = () => Promise.resolve({ kind: "timeout", ms: 5_000 });
    expect(await windows(failed).check(false)).toEqual({ kind: "registry", read: false });
    const thrown: Capture = () => Promise.reject(new Error("spawn failed"));
    expect(await windows(thrown).check(true)).toEqual({ kind: "registry", read: false });
  });
});
