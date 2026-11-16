// Starts the stand-in service (harness.ts) where a real container can be made, and talks to it.
//
// Windows: a plain child of the test, with tasks-run.exe built from packages/launcher-win.
// Linux: the main process of a transient systemd user unit with Delegate=yes, as the real
// service runs. Such a unit is made only where the machine's user manager is disposable: CI says
// so with TASKS_TEST_USER_UNITS=1 after it started one. A person's own session never gets a test
// unit. Every unit is named `tasks-test-container-<token>.service`, so `systemctl --user stop
// 'tasks-test-container-*'` removes any a broken run left.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const HARNESS = join(import.meta.dirname, "harness.ts");

/** The opt-in that says this machine's systemd user manager is CI's own. */
export const USER_UNITS_VARIABLE = "TASKS_TEST_USER_UNITS";
export const UNIT_PREFIX = "tasks-test-container-";

/** Where a real container can be made, or why not. */
export type Where = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const SYSTEMD_RUN = ["/usr/bin/systemd-run", "/bin/systemd-run"];
const SYSTEMCTL = ["/usr/bin/systemctl", "/bin/systemctl"];
const found = (paths: readonly string[]) => paths.find((path) => existsSync(path));

function runtimeDir(): string {
  return `/run/user/${String(process.getuid?.() ?? -1)}`;
}

/** The environment for systemctl and systemd-run to reach the user manager. */
function managerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir(),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir()}/bus`,
  };
}

/**
 * Linux: whether this machine's user manager may get test units. Opted in but unreachable is an
 * error, so CI cannot pass by silently skipping.
 */
export function userUnits(): Where {
  if (process.platform !== "linux") return { ok: false, reason: "not Linux" };
  if (process.env[USER_UNITS_VARIABLE] !== "1") {
    return {
      ok: false,
      reason: `real cgroup containers need a disposable systemd user manager, which CI provides with ${USER_UNITS_VARIABLE}=1; none is made in a person's own session`,
    };
  }
  if (found(SYSTEMD_RUN) === undefined || found(SYSTEMCTL) === undefined) {
    throw new Error(`${USER_UNITS_VARIABLE}=1, but systemd-run or systemctl is missing`);
  }
  if (!existsSync(join(runtimeDir(), "systemd", "private"))) {
    throw new Error(`${USER_UNITS_VARIABLE}=1, but no user manager runs for this user`);
  }
  return { ok: true };
}

/** Runs `systemctl --user <args>` and returns its trimmed stdout. */
export function systemctl(...args: string[]): string {
  const result = spawnSync(found(SYSTEMCTL) ?? "systemctl", ["--user", ...args], {
    env: managerEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.stdout.trim();
}

/** Stops every unit the container tests made, by their name pattern. */
export function stopTestUnits(): void {
  systemctl("stop", `${UNIT_PREFIX}*`);
  systemctl("reset-failed", `${UNIT_PREFIX}*`);
}

/** Waits until a unit is unloaded, so its name can start again. */
export async function waitUnitGone(unit: string, ms = 20_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (systemctl("show", "--property=LoadState", "--value", "--", unit) !== "not-found") {
    if (performance.now() >= deadline) throw new Error(`unit ${unit} is still loaded`);
    await sleep(50);
  }
}

interface Answer {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

/** A running stand-in service. */
export class Service {
  private readonly answers: ((answer: Answer) => void)[] = [];
  private readonly closed: Promise<void>;
  private readonly child: ChildProcess;
  pid = 0;

  private constructor(child: ChildProcess) {
    this.child = child;
    const { stdout } = child;
    if (stdout === null) throw new Error("no stdout");
    createInterface({ input: stdout, crlfDelay: Infinity }).on("line", (line) => {
      this.answers.shift()?.(JSON.parse(line) as Answer);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    this.closed = new Promise((resolve) => {
      child.once("close", () => {
        for (const answer of this.answers.splice(0)) answer({ ok: false, error: "closed" });
        resolve();
      });
    });
  }

  /** Windows: the service as a plain child of the test. */
  static async plain(helper: string): Promise<Service> {
    const child = spawn(process.execPath, [HARNESS, helper], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return Service.ready(child);
  }

  /** Linux: the service as the main process of the transient user unit `unit`. */
  static async inUnit(unit: string, cwd: string): Promise<Service> {
    const child = spawn(
      found(SYSTEMD_RUN) ?? "systemd-run",
      [
        "--user",
        `--unit=${unit}`,
        "--collect",
        "--pipe",
        "--quiet",
        `--working-directory=${cwd}`,
        "--property=Type=exec",
        "--property=Delegate=yes",
        "--property=KillMode=mixed",
        "--property=TimeoutStopSec=15",
        "--",
        process.execPath,
        HARNESS,
      ],
      { env: managerEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );
    return Service.ready(child);
  }

  private static async ready(child: ChildProcess): Promise<Service> {
    const service = new Service(child);
    const hello = await service.request<{ pid: number }>("hello");
    service.pid = hello.pid;
    return service;
  }

  /** Sends one request and returns its result; throws with the service's error. */
  async request<T>(op: string, args: Record<string, unknown> = {}, ms = 60_000): Promise<T> {
    const answer = new Promise<Answer>((resolve) => {
      this.answers.push(resolve);
    });
    this.child.stdin?.write(`${JSON.stringify({ op, ...args })}\n`);
    const got = await Promise.race([
      answer,
      sleep(ms).then((): Answer => ({
        ok: false,
        error: `no answer to ${op} in ${String(ms)} ms`,
      })),
    ]);
    if (!got.ok) {
      throw Object.assign(new Error(got.error ?? "failed"), { code: got.code });
    }
    return got.result as T;
  }

  /** Kills the service process by force, as a crash would, and waits until it is gone. */
  async crash(): Promise<void> {
    process.kill(this.pid, "SIGKILL");
    await this.closed;
  }

  /** Ends the service: it exits when its stdin closes. */
  async close(): Promise<void> {
    this.child.stdin?.end();
    await Promise.race([this.closed, sleep(15_000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}
