// A process's identity as the OS records it (A4 3.1, 3.6.3): the start time read for a real child
// process, the same on every read, another for another process, and none once it has ended. The
// Linux reader also runs on every OS against a fake /proc.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  linuxStartTime,
  ownStartTime,
  powershellPath,
  ProcessCheckFailed,
  startTimes,
} from "../src/process.ts";
import { START_TIME } from "../src/shim/wire.ts";
import { tempFolder } from "./stores.ts";

const REAL = process.platform === "linux" || process.platform === "win32";
const temps: { remove: () => void }[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) t.remove();
});

describe("[A4.5.shim.process-identity] start times as the OS records them", () => {
  test.skipIf(!REAL)(
    "the same process reads the same, another process another, an ended one none",
    { timeout: 120_000 },
    async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      try {
        const pid = child.pid ?? 0;
        const first = (await startTimes([pid, process.pid])).get(pid);
        expect(first).toMatch(START_TIME);
        expect((await startTimes([pid])).get(pid)).toBe(first);
        const own = await ownStartTime();
        expect(own).toMatch(START_TIME);
        expect(own).not.toBe(first);
        expect((await startTimes([process.pid])).get(process.pid)).toBe(own);
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      expect((await startTimes([child.pid ?? 0])).has(child.pid ?? 0)).toBe(false);
    },
  );

  test("Linux: field 22 after the command name, with the boot's ID; a zombie has ended", () => {
    const temp = tempFolder();
    temps.push(temp);
    const proc = temp.path;
    mkdirSync(join(proc, "sys", "kernel", "random"), { recursive: true });
    writeFileSync(
      join(proc, "sys", "kernel", "random", "boot_id"),
      "0f0e0d0c-0b0a-4908-8706-050403020100\n",
    );
    const stat = (pid: number, comm: string, state: string): void => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      const fields = [state, ...Array.from({ length: 18 }, (_, i) => String(i + 4)), "98765", "x"];
      writeFileSync(
        join(proc, String(pid), "stat"),
        `${String(pid)} (${comm}) ${fields.join(" ")}\n`,
      );
    };
    stat(10, "tasks shim", "S");
    stat(11, "a) (b", "R");
    stat(12, "ended", "Z");
    expect(linuxStartTime(10, proc)).toBe("linux:0f0e0d0c-0b0a-4908-8706-050403020100:98765");
    expect(linuxStartTime(11, proc)).toBe("linux:0f0e0d0c-0b0a-4908-8706-050403020100:98765");
    expect(linuxStartTime(12, proc)).toBeUndefined();
    expect(linuxStartTime(13, proc)).toBeUndefined();
  });

  test("an OS without an exact check says so, and is never read as a gone process", async () => {
    await expect(startTimes([1], "darwin")).rejects.toBeInstanceOf(ProcessCheckFailed);
    expect(powershellPath({ systemroot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(powershellPath({ SystemRoot: "relative" })).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});
