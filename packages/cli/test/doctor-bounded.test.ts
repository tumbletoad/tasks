// The helper runner (@ttasks/launch helpers.ts; A3 3.14, M4.05): every program doctor and setup
// start ends with what it started while it runs, at its deadline and when the process that started
// it exits, and a signal the host handles itself stays the host's.
// Each case starts a program that starts a descendant of its own, and checks both. On Windows the
// descendant leaves Node's kill-on-close job (`detached`), as one a native app starts is never in
// it, so only taskkill's tree finds it; on Linux and macOS it stays in the program's process group.
// "Doctor" is a Node process of the test's own, and nothing real is run. Only the PIDs the test's
// own programs wrote are looked at, and killed if a case fails.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { startHelper } from "@ttasks/launch";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const windows = process.platform === "win32";
/** How long a killed process may take to be gone, on a loaded machine. */
const GONE_MS = 30_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const RUNNER = pathToFileURL(
  join(import.meta.dirname, "..", "..", "launch", "src", "helpers.ts"),
).href;

interface Tree {
  readonly dir: string;
  /** The program's PID file and its descendant's. */
  readonly direct: string;
  readonly descendant: string;
  /** The program: writes its PID, starts the descendant, and runs until it is killed. */
  readonly argv: readonly string[];
}

function tree(label: string): Tree {
  const dir = mkdtempSync(join(tmpdir(), `ttasks-helpers-${label}-`));
  temps.push(dir);
  const direct = join(dir, "direct.pid");
  const descendant = join(dir, "descendant.pid");
  const hang = `require("node:fs").writeFileSync(${JSON.stringify(descendant)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const program = [
    `require("node:fs").writeFileSync(${JSON.stringify(direct)}, String(process.pid));`,
    `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(hang)}], { stdio: "ignore", windowsHide: true, detached: process.platform === "win32" });`,
    "c.unref();",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return { dir, direct, descendant, argv: [process.execPath, "-e", program] };
}

/** The PIDs a tree's programs wrote, once both are there. */
async function pids(t: Tree, untilMs = 60_000): Promise<number[]> {
  const until = Date.now() + untilMs;
  while (!(existsSync(t.direct) && existsSync(t.descendant)) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return [t.direct, t.descendant].map((file) => Number(readFileSync(file, "utf8")));
}

/** Which of the PIDs still run after a while; each survivor is killed so nothing is left. */
async function survivors(list: readonly number[]): Promise<boolean[]> {
  const until = Date.now() + GONE_MS;
  while (list.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const left = list.map(alive);
  for (const pid of list) if (alive(pid)) process.kill(pid, "SIGKILL");
  return left;
}

/** Runs a stand-in for doctor: a module that imports the runner and does `body` with it. */
function doctor(body: string): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `import { existsSync } from "node:fs";`,
        `import * as runner from ${JSON.stringify(RUNNER)};`,
        body,
      ].join("\n"),
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

/** Waits in the stand-in until both PID files are there, then does `then`. */
const whenReady = (t: Tree, then: string) =>
  `const until = Date.now() + 60000; const wait = () => (existsSync(${JSON.stringify(t.descendant)}) && existsSync(${JSON.stringify(t.direct)})) || Date.now() > until ? (${then}) : setTimeout(wait, 50); wait();`;

const exited = (child: ReturnType<typeof spawn>) =>
  new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });

describe("[A3.3.14.doctor.helpers] a running program doctor or setup started ends with what it started, at its deadline, on stop and when doctor ends", () => {
  test("doctor exiting (Ctrl+C exits 130) ends a running program and its descendant", async () => {
    const t = tree("exit");
    const stand = doctor(
      [
        `runner.startHelper(${JSON.stringify(t.argv)}, { env: process.env, cwd: ${JSON.stringify(t.dir)}, deadlineMs: 120000 });`,
        whenReady(t, "process.exit(130)"),
      ].join("\n"),
    );
    expect(await exited(stand)).toBe(130);
    expect(await survivors(await pids(t, 0))).toEqual([false, false]);
  }, 120_000);

  test("an app's own mcp get, read for its output, ends with its descendant when doctor exits", async () => {
    const t = tree("output");
    const stand = doctor(
      [
        `void runner.helperOutput(${JSON.stringify(t.argv)}, { env: process.env, cwd: ${JSON.stringify(t.dir)}, deadlineMs: 120000, maxChars: 4096 });`,
        whenReady(t, "process.exit(130)"),
      ].join("\n"),
    );
    expect(await exited(stand)).toBe(130);
    expect(await survivors(await pids(t, 0))).toEqual([false, false]);
  }, 120_000);

  test("stop, which the deadline calls, ends a program and its descendant; the deadline says so", async () => {
    const t = tree("deadline");
    const helper = startHelper(t.argv, { env: process.env, cwd: t.dir, deadlineMs: 120_000 });
    const list = await pids(t);
    // The deadline as it fires: the same stop, marked late. Started only once both run, so the
    // test assumes nothing about how fast a loaded machine starts them.
    const late = startHelper([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      env: process.env,
      cwd: t.dir,
      deadlineMs: 200,
    });
    expect(await late.ended).toBeNull();
    expect(late.timedOut()).toBe(true);
    helper.stop();
    expect(await helper.ended).toBeNull();
    expect(helper.timedOut()).toBe(false);
    expect(await survivors(list)).toEqual([false, false]);
  }, 120_000);

  test("a signal the host took first with a one-shot handler stays the host's: its own shutdown runs to the end", async () => {
    const t = tree("host-signal");
    // Node removes a `once` listener before it calls it, so at the runner's turn the host has no
    // listener left; the host's shutdown still has work to do, and ends with its own exit code.
    const stand = doctor(
      [
        `process.once("SIGHUP", () => { setTimeout(() => process.exit(7), 50); });`,
        `runner.startHelper(${JSON.stringify(t.argv)}, { env: process.env, cwd: ${JSON.stringify(t.dir)}, deadlineMs: 120000 });`,
        `setInterval(() => {}, 1000);`,
        // The signal as Node delivers it, on every OS: the same event to the same listeners.
        whenReady(t, `process.emit("SIGHUP", "SIGHUP")`),
      ].join("\n"),
    );
    expect(await exited(stand)).toBe(7);
    expect(await survivors(await pids(t, 0))).toEqual([false, false]);
  }, 120_000);

  test.skipIf(windows)(
    "SIGTERM to doctor ends its programs and their descendants before doctor ends",
    async () => {
      const t = tree("sigterm");
      const stand = doctor(
        [
          `runner.startHelper(${JSON.stringify(t.argv)}, { env: process.env, cwd: ${JSON.stringify(t.dir)}, deadlineMs: 120000 });`,
          `setInterval(() => {}, 1000);`,
        ].join("\n"),
      );
      const list = await pids(t);
      stand.kill("SIGTERM");
      expect(await exited(stand)).toBe(143);
      expect(await survivors(list)).toEqual([false, false]);
    },
    120_000,
  );
});
