// Fake terminals, a fake systemd-run, a fake login shell and a fake interactive agent for the
// launch tests (A7 3.9 M2.09). Each is a small Node program; a test's spawner (FakeSpawner) stands
// in for the service's, records exactly what the service asked to start, and runs the fakes in
// place of the real programs. Nothing here starts a real terminal, agent or systemd-run, and every
// process it starts is recorded by PID with the start time first seen, so a test stops only its
// own. Fixture data and temporary folders only.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type { InteractiveAgentReport } from "./agent.ts";
export type { CliAgentReport } from "./cli-agent.ts";

const here = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));

/** The fake programs, run as `node <file>`. */
export const FAKE_TERMINAL = here("terminal.ts");
export const FAKE_SYSTEMD_RUN = here("systemd-run.ts");
export const FAKE_SHELL = here("shell.ts");
export const FAKE_AGENT = here("agent.ts");
/** A fake Claude Code or Codex CLI: any argv, steered by its environment (cli-agent.ts). */
export const FAKE_CLI_AGENT = here("cli-agent.ts");
/** A fake clipboard tool: what it reads on stdin goes to a file (clipboard.ts). */
export const FAKE_CLIPBOARD = here("clipboard.ts");

/** What the service asked a spawner to start, as the fake spawner recorded it. */
export interface SpawnRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly detached: boolean;
  readonly envNames: readonly string[];
  readonly pid: number | undefined;
}

/** A spawn request as the service's spawner gets it (launch's SpawnRequest, structurally). */
export interface FakeSpawnRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: boolean;
}

export interface FakeSpawnerOptions {
  /** Program paths the service may name, each mapped to the fake that runs in its place. */
  readonly programs: Readonly<Record<string, readonly string[]>>;
  /** Variables every fake gets on top of what the service passed: the fakes' controls. */
  readonly env?: Readonly<Record<string, string>>;
  /** Per program path, extra variables (a terminal's mode, for example). */
  readonly envFor?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Program paths whose start fails as the OS's would (ENOENT): nothing starts. */
  readonly missing?: readonly string[];
  /** The OS's start times, so a PID is stopped only while it names the process first seen. */
  readonly identify: (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>;
}

/** The service's spawner, faked: records each request and starts the mapped fake. */
export class FakeSpawner {
  readonly records: SpawnRecord[] = [];
  readonly #options: FakeSpawnerOptions;
  readonly #seen = new Map<number, Promise<string | undefined>>();
  readonly #exits = new Map<number, Promise<{ code: number | null; signal: string | null }>>();

  constructor(options: FakeSpawnerOptions) {
    this.#options = options;
  }

  /** Records a PID this test caused, with its start time read now. */
  track(pid: number): void {
    if (this.#seen.has(pid)) return;
    this.#seen.set(
      pid,
      this.#options
        .identify([pid])
        .then((times) => times.get(pid))
        .catch(() => undefined),
    );
  }

  readonly spawn = (
    request: FakeSpawnRequest,
  ): Promise<{
    pid: number;
    exited: Promise<{ code: number | null; signal: string | null }>;
    stop: () => void;
  }> => {
    const [program, ...rest] = request.argv;
    const record = (pid: number | undefined): void => {
      this.records.push({
        argv: [...request.argv],
        cwd: request.cwd,
        detached: request.detached,
        envNames: Object.keys(request.env).sort(),
        pid,
      });
    };
    if (program === undefined || this.#options.missing?.includes(program) === true) {
      record(undefined);
      const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      return Promise.reject(error);
    }
    const mapped = this.#options.programs[program];
    const argv = mapped === undefined ? [program, ...rest] : [...mapped, ...rest];
    // A program's controls apply wherever it is in the argv: a terminal inside a scope too.
    const controls: Record<string, string> = {};
    for (const [path, vars] of Object.entries(this.#options.envFor ?? {})) {
      if (request.argv.includes(path)) Object.assign(controls, vars);
    }
    const env = {
      ...request.env,
      ...this.#options.env,
      ...controls,
      FAKE_PROGRAMS: JSON.stringify(this.#options.programs),
    };
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0] ?? "", argv.slice(1), {
        cwd: request.cwd,
        env,
        // eslint-disable-next-line no-restricted-syntax -- the product's own choice, false on Windows.
        detached: request.detached,
        stdio: "ignore",
        windowsHide: true,
      });
      let ended = false;
      const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
        child.once("exit", (code, signal) => {
          ended = true;
          done({ code, signal });
        });
      });
      child.once("error", (error) => {
        record(undefined);
        reject(error);
      });
      child.once("spawn", () => {
        const pid = child.pid;
        record(pid);
        if (pid === undefined) {
          reject(new Error("no PID"));
          return;
        }
        this.track(pid);
        this.#exits.set(pid, exited);
        child.unref();
        // The fake itself, while it has not ended (its PID still names it).
        const stop = (): void => {
          if (!ended) child.kill("SIGKILL");
        };
        resolve({ pid, exited, stop });
      });
    });
  };

  /** Every PID in the fakes' logs (handoff servers, the commands they ran), tracked. */
  /** The exit of a fake this spawner started, as the service's spawner reports it. */
  exited(pid: number): Promise<{ code: number | null; signal: string | null }> {
    const exit = this.#exits.get(pid);
    if (exit === undefined) throw new Error(`no fake started with PID ${String(pid)}`);
    return exit;
  }

  trackLogs(logs: readonly string[]): void {
    for (const line of logs.flatMap(readJsonLines)) {
      const entry = line as { pid?: unknown; server?: unknown; child?: unknown };
      for (const pid of [entry.pid, entry.server, entry.child]) {
        if (typeof pid === "number") this.track(pid);
      }
    }
  }

  /** Stops every process it tracked, by PID, while the PID still names that process. */
  async stopAll(): Promise<void> {
    for (const [pid, seen] of this.#seen) {
      const first = await seen;
      if (first === undefined) continue;
      const now = await this.#options.identify([pid]).catch(() => new Map<number, string>());
      if (now.get(pid) !== first) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone meanwhile.
      }
    }
  }
}

/** The JSON lines of a fake's log, or none when it was never written. */
export function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** The fake interactive agent's argv: absolute Node first, then its options, `--`, the args. */
export function interactiveAgentArgv(options: {
  report: string;
  release?: string;
  holdMs?: number;
  maxMs?: number;
  exit?: number;
  argv?: readonly string[];
}): string[] {
  return [
    process.execPath,
    FAKE_AGENT,
    `--report=${options.report}`,
    ...(options.release === undefined ? [] : [`--release=${options.release}`]),
    `--hold-ms=${String(options.holdMs ?? 0)}`,
    `--max-ms=${String(options.maxMs ?? 120_000)}`,
    `--exit=${String(options.exit ?? 0)}`,
    "--",
    ...(options.argv ?? []),
  ];
}
