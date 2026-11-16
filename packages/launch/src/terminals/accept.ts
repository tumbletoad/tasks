// Starting a launch's terminal and the acceptance rule of each adapter (A4 3.6.2, SL-09). This is
// the terminal route's external step (LaunchSteps.dispatch), so it runs once per intent, after
// Dispatching is durable, and must not wait for a claim (the claim waits for this step).
//
// For each terminal of the chain, in order:
// - no command (commands.ts refused it) or no program to run: nothing started, try the next;
// - a spawn error (the process never existed): nothing started, try the next;
// - a handoff client: Dispatched once spawned, whatever the client's exit;
// - a direct terminal, or the console's starter on Windows: Dispatched when it still runs after
//   2 s, exited 0, or the ticket's shim role was spent (a claim). It exited non-zero within 2 s and
//   before any claim: its window went with it (the starter: the start failed), so the ticket is
//   revoked first (a late claim from that window is refused) and the next terminal gets a new one.
//   When the revoke finds the ticket spent, a claim came after all: Dispatched.
// Every other case counts as Dispatched and the full claim window decides. Once one terminal is
// Dispatched no other is tried: one launch never opens two windows. When no terminal could be
// started at all the launch is Failed `refused`.
import { spawn } from "node:child_process";
import type { DispatchOutcome } from "../machine.ts";
import {
  COMMAND_REFUSALS,
  type AdapterApp,
  type CommandRefusal,
  type TerminalCommand,
  type TerminalKind,
} from "./commands.ts";
import type { ChainEntry } from "./detect.ts";

/** A4 3.6.2: how long a direct terminal is watched for an early, non-zero exit. */
export const DIRECT_WATCH_MS = 2_000;

/** One process to start, exactly as built: argv[0] is the program. Never through a shell. */
export interface SpawnRequest {
  readonly argv: readonly string[];
  /** The resolved folder, as the OS call's working directory (never argv). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: boolean;
  /** Without a window of its own (Windows: the console's starter). Default: shown. */
  readonly hidden?: boolean;
}

export interface SpawnedProcess {
  readonly pid: number;
  /** Resolves when the process ends. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /**
   * Ends the process (with its process group when it leads one), unless it already ended. Only
   * for a helper the service runs for itself, such as the scope probe: never a terminal.
   */
  stop(): void;
}

/**
 * Starts a process: resolves once the OS created it, rejects when it never existed (ENOENT,
 * EACCES and the like). The service's is the OS's; tests record the argv and start fakes.
 */
export type Spawner = (request: SpawnRequest) => Promise<SpawnedProcess>;

/** A terminal's command as the step spawns it, with the terminal's own program. */
export type BuiltCommand = TerminalCommand & { readonly program: string };

/** What the step may do with the launch's ticket (host.ts). */
export interface TicketControl {
  /** The ticket the next terminal carries. */
  current(): string;
  /** Whether the current ticket's shim role was spent: a claim is under way or done. */
  claimed(): boolean;
  /**
   * Revokes the current ticket unless its shim role was spent, and issues the next one. Returns
   * the new ticket, or undefined when the old one was spent (a claim came).
   */
  replace(): string | undefined;
}

/** How one terminal of the chain went: the log's closed list. */
export const ATTEMPT_RESULTS = [
  "dispatched",
  "exited_early",
  "spawn_error",
  "no_program",
  "claimed_meanwhile",
  ...COMMAND_REFUSALS,
] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

/** What happened with one terminal of the chain, for the service's log. Codes only. */
export interface Attempt {
  readonly app: AdapterApp;
  readonly kind?: TerminalKind;
  readonly result: AttemptResult;
  /** A spawn error's code, such as ENOENT. */
  readonly error?: string;
  /** A direct terminal's early exit code. */
  readonly code?: number | null;
}

export interface AcceptInput {
  readonly chain: readonly ChainEntry[];
  /**
   * The command for one entry with a ticket: commands.ts's line, wrapped in a scope on Linux, with
   * the terminal's own program (inside any scope), which `ready` checks.
   */
  readonly build: (
    entry: ChainEntry,
    ticket: string,
    attempt: number,
  ) => BuiltCommand | { readonly refused: CommandRefusal };
  /**
   * Whether the terminal's program is there to run, right before the spawn: behind a scope a
   * missing program would show only as the scope's non-zero exit, which a handoff cannot tell from
   * an ambiguous one.
   */
  readonly ready: (program: string) => boolean | Promise<boolean>;
  readonly spawn: Spawner;
  readonly tickets: TicketControl;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly watchMs?: number;
  /** Waits `ms` (tests pass their clock's). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
};

/** Runs the chain by A4 3.6.2's acceptance rules (head of this file). */
export async function acceptTerminal(
  input: AcceptInput,
): Promise<{ outcome: DispatchOutcome; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  const sleep = input.sleep ?? wait;
  const watchMs = input.watchMs ?? DIRECT_WATCH_MS;
  let number = 0;
  for (const entry of input.chain) {
    number += 1;
    const command = input.build(entry, input.tickets.current(), number);
    if ("refused" in command) {
      attempts.push({ app: entry.app, result: command.refused });
      continue;
    }
    if (!(await input.ready(command.program))) {
      attempts.push({ app: entry.app, kind: command.kind, result: "no_program" });
      continue;
    }
    let started: SpawnedProcess;
    try {
      started = await input.spawn({
        argv: command.argv,
        cwd: input.cwd,
        env: command.env === undefined ? input.env : { ...input.env, ...command.env },
        detached: command.detached,
        ...(command.hidden === true ? { hidden: true } : {}),
      });
    } catch (error) {
      // The process never existed: no window can start the shim.
      attempts.push({
        app: entry.app,
        kind: command.kind,
        result: "spawn_error",
        error: codeOf(error),
      });
      continue;
    }
    if (command.kind === "handoff") {
      attempts.push({ app: entry.app, kind: command.kind, result: "dispatched" });
      return { outcome: { kind: "accepted" }, attempts };
    }
    // A direct terminal, or the console's starter: watched for an early, non-zero exit.
    const kind = command.kind;
    const early = await Promise.race([
      started.exited.then((exit) => exit),
      sleep(watchMs).then(() => undefined),
    ]);
    if (early === undefined || early.code === 0 || input.tickets.claimed()) {
      attempts.push({ app: entry.app, kind, result: "dispatched" });
      return { outcome: { kind: "accepted" }, attempts };
    }
    // Its window went with it, or the starter could not start the shim, before any claim: the
    // ticket first, then the next terminal.
    if (input.tickets.replace() === undefined) {
      attempts.push({ app: entry.app, kind, result: "claimed_meanwhile" });
      return { outcome: { kind: "accepted" }, attempts };
    }
    attempts.push({ app: entry.app, kind, result: "exited_early", code: early.code });
  }
  return { outcome: { kind: "refused", reason: "refused" }, attempts };
}

/**
 * The OS's spawner: no shell, stdio ignored (no pipe dangles after a restart, A4 3.7), shown (a
 * terminal is a window) unless the command is a hidden helper, and unreferenced, so the service
 * never waits for one.
 */
export const osSpawner: Spawner = (request) =>
  new Promise<SpawnedProcess>((resolve, reject) => {
    const [file, ...args] = request.argv;
    if (file === undefined) {
      reject(new Error("No program"));
      return;
    }
    const child = spawn(file, args, {
      cwd: request.cwd,
      env: { ...request.env },
      detached: request.detached,
      stdio: "ignore",
      shell: false,
      windowsHide: request.hidden === true,
    });
    let ended = false;
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
      child.once("exit", (code, signal) => {
        ended = true;
        done({ code, signal });
      });
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("spawn", () => {
      child.unref();
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error("No PID"));
        return;
      }
      const stop = (): void => {
        // While it has not ended, its PID (and its group's ID) still name it.
        if (ended) return;
        try {
          if (request.detached && process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Gone meanwhile.
        }
      };
      resolve({ pid, exited, stop });
    });
  });
