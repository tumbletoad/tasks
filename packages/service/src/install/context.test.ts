// Whether the service's process still runs, as `tasks service stop` and `start` wait for it.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { processAlive } from "./context.ts";

const state = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
};

describe("[A2.3.3.service-stop.alive] whether the service's process runs", () => {
  test("a running process runs, and one that ended does not", async () => {
    expect(processAlive(process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    expect(processAlive(child.pid ?? 0)).toBe(false);
  });

  test.skipIf(process.platform !== "linux")(
    "on Linux a process that exited before its parent collected it does not run",
    async () => {
      // The shell's background child exits; the program the shell becomes never collects it.
      const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 60"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      try {
        const [line] = (await once(parent.stdout, "data")) as [Buffer];
        const pid = Number(line.toString().trim());
        while (state(pid) !== "Z") await sleep(20);
        expect(processAlive(pid)).toBe(false);
        expect(processAlive(parent.pid ?? 0)).toBe(true);
      } finally {
        parent.kill();
      }
    },
  );
});
