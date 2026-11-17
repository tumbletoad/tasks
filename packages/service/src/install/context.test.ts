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
      // The shell's background child waits for a byte on stdin, so it exits only after the shell
      // has become a program that never collects it. A background job's own stdin is /dev/null,
      // so it reads a copy taken first.
      const script = "exec 3<&0; head -c 1 <&3 >/dev/null & echo $!; exec sleep 60 3<&-";
      const parent = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "ignore"] });
      try {
        const [line] = (await once(parent.stdout, "data")) as [Buffer];
        const pid = Number(line.toString().trim());
        const comm = `/proc/${String(parent.pid ?? 0)}/comm`;
        while (readFileSync(comm, "utf8").trim() !== "sleep") await sleep(20);
        parent.stdin.end("x");
        while (state(pid) !== "Z") {
          expect(state(pid)).toBeDefined();
          await sleep(20);
        }
        expect(processAlive(pid)).toBe(false);
        expect(processAlive(parent.pid ?? 0)).toBe(true);
      } finally {
        parent.kill();
      }
    },
  );
});
