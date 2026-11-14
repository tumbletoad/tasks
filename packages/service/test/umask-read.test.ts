// How the umask is read (A2 3.2.2 rule 5): never by setting it. Node's
// process.umask() without an argument sets the mask to 0 and back, so a file a worker thread creates
// in between gets its whole requested mode; the product never calls it (a lint rule refuses it,
// scripts/lint-rules.test.ts). Linux reads /proc/self/status. Where that is missing, a short-lived
// child that inherits the mask says it, within a deadline, and a mask that cannot be read is never
// guessed: the start refuses and says what could not be read.
//
// umask-read-entry.ts runs the child's path in a process of its own under a pinned umask, with the
// /proc path replaced by one that does not exist, so the path runs on Linux too.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { ServiceExit } from "../src/hub/exit.ts";
import { startService } from "../src/hub/service.ts";
import { readUmask, umaskRefusal, UMASK_CHILD_MS } from "../src/hub/umask.ts";
import { serviceEnv, tempRoot } from "./harness.ts";

const ENTRY = fileURLToPath(new URL("./umask-read-entry.ts", import.meta.url));
const linux = process.platform === "linux";
const posix = process.platform !== "win32";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function temp(label: string): string {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  return root;
}

/** Runs the entry under `umask` and returns its one JSON line. */
function underUmask(umask: string, mode: "say" | "race"): Record<string, unknown> {
  const root = temp("ur");
  const ran = spawnSync(
    "/bin/sh",
    ["-c", `umask ${umask} && exec "$0" "$@"`, process.execPath, ENTRY, root, mode],
    { encoding: "utf8", timeout: 120_000, env: process.env },
  );
  if (ran.status !== 0) throw new Error(`the entry failed under umask ${umask}: ${ran.stderr}`);
  return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
}

/** The mask Linux records for this process. */
function recorded(): number {
  const line = /^Umask:\s*([0-7]+)\s*$/mu.exec(readFileSync("/proc/self/status", "utf8"));
  return Number.parseInt(line?.[1] ?? "", 8);
}

describe("[A2.3.2.2.permissions.umask] the umask is read without setting it", () => {
  test.skipIf(!linux)(
    "without /proc a child says the mask it inherited, and this process's own mask never changes",
    () => {
      for (const [umask, mask] of [
        ["027", 0o027],
        ["077", 0o077],
        ["002", 0o002],
        ["0", 0o000],
      ] as const) {
        expect(underUmask(umask, "say"), umask).toEqual({ read: mask, before: mask, after: mask });
      }
    },
    60_000,
  );

  test.skipIf(!linux)(
    "reading it over and over while a worker creates files lets no file through unmasked",
    () => {
      // Under 077 every file the worker creates with 0666 must be 0600. The old read, which set
      // the mask to 0 and back, let thousands through as 0666 in this same setup.
      const report = underUmask("077", "race");
      expect(report["files"]).toBe(4000);
      expect(report["reads"]).toBeGreaterThan(0);
      expect(report["answers"]).toEqual([String(0o077)]);
      expect(report["widened"]).toBe(0);
    },
    120_000,
  );

  test.skipIf(!posix)(
    "a child that does not answer in time, or fails, gives no mask: the read says why",
    () => {
      const root = temp("uc");
      const status = join(root, "no-status");
      expect(existsSync(status)).toBe(false);
      // A shell that never answers: the deadline ends it.
      const slow = join(root, "slow-sh");
      writeFileSync(slow, "#!/bin/sh\nsleep 30\n");
      chmodSync(slow, 0o700);
      const started = performance.now();
      expect(readUmask("linux", { status, sh: slow, timeoutMs: 300 })).toEqual({
        unreadable: "timeout",
      });
      expect(performance.now() - started).toBeLessThan(10_000);
      // A shell that exits with an error, one that prints something else, one that is not there.
      const wrong = join(root, "wrong-sh");
      writeFileSync(wrong, "#!/bin/sh\necho 'not a mask'\n");
      chmodSync(wrong, 0o700);
      for (const sh of ["/bin/false", wrong, join(root, "missing-sh")]) {
        expect(readUmask("linux", { status, sh }), sh).toEqual({ unreadable: "failed" });
      }
      // The real shell, in this process: the same mask Linux records (or, elsewhere, a mask).
      const read = readUmask("linux", { status });
      expect(typeof read).toBe("number");
      if (linux) expect(read).toBe(recorded());
    },
    30_000,
  );

  test("a mask that cannot be read is never guessed: the line says what could not be read", () => {
    expect(umaskRefusal({ unreadable: "timeout" }, "it stops")).toBe(
      `Your umask could not be read (/bin/sh did not say it within ${String(UMASK_CHILD_MS / 1000)} s), so it stops: TT Tasks does not guess which of your own bits it takes away from new files and folders. Try again; if it keeps failing, check that /bin/sh runs.`,
    );
    expect(umaskRefusal({ unreadable: "failed" }, "it stops")).toContain(
      "Your umask could not be read (/bin/sh could not say it), so it stops",
    );
    expect(readUmask("win32")).toBeUndefined();
  });

  test("the service refuses to start with 64 when the umask cannot be read, before it makes anything", async () => {
    const h = join(temp("us"), "h");
    const lines: string[] = [];
    const error = await startService({
      env: serviceEnv(h),
      identity: () => ({ root: false, elevated: false, package: null }),
      umask: () => ({ unreadable: "timeout" }),
      say: (line) => lines.push(line),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceExit);
    expect(error).toMatchObject({ code: 64, refusal: "unsafe_umask" });
    expect(lines).toEqual([expect.stringContaining("Your umask could not be read")]);
    expect(existsSync(h)).toBe(false);
  });
});
