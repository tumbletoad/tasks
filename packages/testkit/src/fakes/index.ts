// Fake terminals, a fake systemd-run, a fake login shell and a fake interactive agent for the
// launch tests (A7 3.9 M2.09). Each is a small Node program; a test's spawner (FakeSpawner) stands
// in for the service's, records exactly what the service asked to start, and runs the fakes in
// place of the real programs. Nothing here starts a real terminal, agent or systemd-run, and every
// process it starts is recorded by PID with the start time first seen, so a test stops only its
// own. Fixture data and temporary folders only.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
/** A fake `ttam query` that replays one of TTAM's recorded conversations (ttam.ts). */
export const FAKE_TTAM = here("ttam.ts");

/** TTAM's recorded conversations: with usage queries on, and with them off in its configuration. */
export const TTAM_CONVERSATIONS = {
  on: fileURLToPath(new URL("../../../../fixtures/ttam/query-usage-on.jsonl", import.meta.url)),
  off: fileURLToPath(new URL("../../../../fixtures/ttam/query-usage-off.jsonl", import.meta.url)),
} as const;

/** The fake `ttam`'s program and arguments, `query` left for the caller to add. */
export function fakeTtam(options: {
  readonly conversation?: keyof typeof TTAM_CONVERSATIONS;
  readonly mode?: string;
  /** A file that holds the mode, read again for each request (ttam.ts). */
  readonly control?: string;
  readonly log?: string;
  /** A file of more homes and agents, read again for each request (ttam.ts `--agents`). */
  readonly agents?: string;
  /** How long it may live at most. Default 120 s. */
  readonly maxMs?: number;
}): { readonly file: string; readonly args: readonly string[] } {
  return {
    file: process.execPath,
    args: [
      FAKE_TTAM,
      `--conversation=${TTAM_CONVERSATIONS[options.conversation ?? "on"]}`,
      ...(options.mode === undefined ? [] : [`--mode=${options.mode}`]),
      ...(options.control === undefined ? [] : [`--control=${options.control}`]),
      ...(options.maxMs === undefined ? [] : [`--max-ms=${String(options.maxMs)}`]),
      ...(options.log === undefined ? [] : [`--log=${options.log}`]),
      ...(options.agents === undefined ? [] : [`--agents=${options.agents}`]),
    ],
  };
}

/** An agent as TTAM's snapshot holds one, for the fake's `--agents` file. Invented data only. */
export function ttamAgent(agent: {
  readonly row: string;
  readonly parent?: string;
  readonly kind?: "session" | "subagent";
  readonly provider: string;
  readonly home: string;
  readonly session: string;
  readonly name: string;
  readonly activity: string;
  readonly folder?: string;
}): Record<string, unknown> {
  return {
    row_id: agent.row,
    parent_row_id: agent.parent ?? null,
    kind: agent.kind ?? "session",
    provider: agent.provider,
    home_id: agent.home,
    profile: agent.provider,
    conversation: { provider: agent.provider, home_id: agent.home, session_id: agent.session },
    child_id: agent.kind === "subagent" ? `${agent.row}-child` : null,
    liveness: "confirmed",
    name: agent.name,
    project: agent.folder ?? null,
    activity: agent.activity,
    started_at_ms: null,
    last_activity_ms: null,
  };
}

/** `path` as TTAM reports a home's: the folder it really is when it exists, else as given. */
export function ttamPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** A home as TTAM's snapshot holds one, for the fake's `--agents` file. */
export function ttamHome(home: {
  readonly id: string;
  readonly provider: string;
  readonly path: string;
}): Record<string, unknown> {
  return {
    id: home.id,
    provider: home.provider,
    label: home.provider,
    path: ttamPath(home.path),
    present: true,
  };
}

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

  /**
   * Stops every process it tracked, by PID, while the PID still names that process, and resolves
   * once each is gone: a process holds its working folder until it has ended, so a folder removed
   * before then is refused on Windows.
   */
  async stopAll(): Promise<void> {
    const stopped: { readonly pid: number; readonly first: string }[] = [];
    for (const [pid, seen] of this.#seen) {
      const first = await seen;
      if (first === undefined) continue;
      if ((await this.#startOf(pid)) !== first) continue;
      try {
        process.kill(pid, "SIGKILL");
        stopped.push({ pid, first });
      } catch {
        // Gone meanwhile.
      }
    }
    const deadline = Date.now() + 30_000;
    for (const { pid, first } of stopped) {
      while ((await this.#startOf(pid)) === first) {
        if (Date.now() > deadline) throw new Error(`process ${String(pid)} did not end`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  /** The start time the PID names now, or none when it names no process. */
  async #startOf(pid: number): Promise<string | undefined> {
    const now = await this.#options.identify([pid]).catch(() => new Map<number, string>());
    return now.get(pid);
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
