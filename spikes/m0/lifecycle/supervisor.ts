// A stand-in for the supervisor loop of `tasksw.exe` (A2 3.3.2) for lab row S03 (M0.07). The
// spike's C launcher has no supervisor loop (M0.03 left it to M1), so in the lab release
// `tasksw.exe` with no arguments runs this loop in Node: it starts the service from
// `<root>\versions\<current>\` with no window, waits, and applies A2 3.3.1's exit-code table:
//   0, 64, 73   stop
//   75          start again at once, re-reading `current`
//   other       a crash: restart after 1, 2, 4, 8 s; the 5th crash within 10 minutes writes
//               `<state>\crash\supervisor-gave-up.json` and stops
// A2 lists the delays as "1, 2, 4, 8, 16 s" and also says "give up after 5 failures within 10
// minutes". Both cannot hold, because the 5th failure gives up before a 16 s wait. The lab follows
// the give-up rule (A7 row S03: "gives up after 5 crashes"), like systemd's StartLimitBurst=5, and
// A2 3.3.2 says so. It supervises only from the stable `bin\` folder.
//
// It writes one JSON line per event to `<state>\..\supervisor.jsonl`: kinds, exit codes, delays and
// process IDs, never paths or environment values.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A2 3.12.3's `current` rule: [0-9A-Za-z.+-], 1 to 64 characters, not only dots. */
const CURRENT = /^(?!\.+$)[0-9A-Za-z.+-]{1,64}$/;
export const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000];
export const GIVE_UP_FAILURES = 5;
export const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export type Decision =
  | { action: "stop"; reason: "clean" | "refused" | "locked" }
  | { action: "restart"; delayMs: number; reason: "requested" | "crash" }
  | { action: "give_up" };

/**
 * What the supervisor does after the service exits with `code` (null: killed without a code).
 * `failures` holds the times of earlier crashes and is updated in place.
 */
export function decide(code: number | null, failures: number[], now: number): Decision {
  if (code === 0) return { action: "stop", reason: "clean" };
  if (code === 64) return { action: "stop", reason: "refused" };
  if (code === 73) return { action: "stop", reason: "locked" };
  if (code === 75) return { action: "restart", delayMs: 0, reason: "requested" };
  const recent = failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.splice(0, failures.length, ...recent);
  if (recent.length >= GIVE_UP_FAILURES) return { action: "give_up" };
  const delay = RESTART_DELAYS_MS[recent.length - 1] ?? RESTART_DELAYS_MS.at(-1) ?? 16_000;
  return { action: "restart", delayMs: delay, reason: "crash" };
}

export interface SupervisorIO {
  /** Starts the service once and resolves with its exit code. */
  start(): { pid: number | undefined; exit: Promise<number | null> };
  sleep(ms: number): Promise<void>;
  now(): number;
  log(event: Record<string, string | number | boolean | null>): void;
  gaveUp(failures: number[]): void;
}

/** Runs the loop until a stop or a give-up. Resolves with the supervisor's own exit code, 0. */
export async function supervise(io: SupervisorIO): Promise<number> {
  const failures: number[] = [];
  for (;;) {
    const started = io.start();
    io.log({ kind: "start", pid: started.pid ?? null });
    const code = await started.exit;
    const decision = decide(code, failures, io.now());
    io.log({
      kind: "exit",
      code,
      action: decision.action,
      failures: failures.length,
      ...(decision.action === "restart" ? { delay_ms: decision.delayMs } : {}),
    });
    if (decision.action === "stop") return 0;
    if (decision.action === "give_up") {
      io.gaveUp(failures);
      return 0;
    }
    if (decision.delayMs > 0) await io.sleep(decision.delayMs);
  }
}

/** The real loop, for `tasksw.exe` with no arguments in the lab release. */
export async function runSupervisor(root: string, state: string): Promise<number> {
  const logFile = join(dirname(state), "supervisor.jsonl");
  mkdirSync(dirname(state), { recursive: true });
  const log = (event: Record<string, string | number | boolean | null>) => {
    appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
  };
  return supervise({
    start() {
      const current = readFileSync(join(root, "current"), "utf8");
      if (!CURRENT.test(current)) {
        log({ kind: "bad_current" });
        return { pid: undefined, exit: Promise.resolve(64) };
      }
      const version = join(root, "versions", current);
      const node = join(version, "runtime", process.platform === "win32" ? "node.exe" : "node");
      const stderr = openSync(join(dirname(state), "service-stderr.log"), "a");
      const child = spawn(
        node,
        ["--report-exclude-env", join(version, "lib", "tasks.mjs"), "service", "--state", state],
        {
          stdio: ["ignore", "ignore", stderr],
          windowsHide: true,
          shell: false,
          env: { ...process.env, TASKS_SERVICE_MANAGER: "tasksw-lab" },
        },
      );
      closeSync(stderr);
      const exit = new Promise<number | null>((resolve) => {
        child.once("error", () => {
          resolve(70);
        });
        child.once("exit", (code) => {
          resolve(code);
        });
      });
      return { pid: child.pid, exit };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log,
    gaveUp(failures) {
      const crash = join(state, "crash");
      mkdirSync(crash, { recursive: true });
      writeFileSync(
        join(crash, "supervisor-gave-up.json"),
        `${JSON.stringify({ at: new Date().toISOString(), failures: failures.length })}\n`,
      );
      log({ kind: "gave_up", failures: failures.length });
    },
  });
}
