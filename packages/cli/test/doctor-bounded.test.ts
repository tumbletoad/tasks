// The one way doctor starts a program (doctor-agents.ts `bounded`; A3 3.14, M4.05): a program it
// started ends when doctor itself exits, as Ctrl+C makes the CLI do (run.ts: process.exit(130)).
// The program leads its own process group on Linux and macOS, so the terminal's Ctrl+C does not
// reach it by itself. Doctor here is a Node process of the test's own; nothing real is run.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("[A3.3.14.doctor.live] a program doctor started does not outlive doctor", () => {
  test("doctor exiting (Ctrl+C) ends the program it is running, with its process group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-bounded-"));
    temps.push(dir);
    const pidFile = join(dir, "program.pid");
    const module = pathToFileURL(join(import.meta.dirname, "..", "src", "doctor-agents.ts")).href;
    const hang = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    // Stands for doctor: starts the program, then exits the way Ctrl+C makes the CLI exit.
    const doctor = [
      `import { existsSync } from "node:fs";`,
      `import { bounded } from ${JSON.stringify(module)};`,
      `bounded([process.execPath, "-e", ${JSON.stringify(hang)}], process.env, ${JSON.stringify(dir)}, false, 120000);`,
      `const until = Date.now() + 30000;`,
      `const wait = () => existsSync(${JSON.stringify(pidFile)}) || Date.now() > until ? process.exit(130) : setTimeout(wait, 50);`,
      `wait();`,
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", doctor], {
      stdio: "ignore",
      windowsHide: true,
    });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(130);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const until = Date.now() + 10_000;
    while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const survived = alive(pid);
    if (survived) process.kill(pid, "SIGKILL");
    expect(survived).toBe(false);
  }, 60_000);
});
