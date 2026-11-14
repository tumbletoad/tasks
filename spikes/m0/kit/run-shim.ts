// Stand-in for the run shim `tasks shim --run <ticket>` (A4 3.11.3, 3.11.8, 3.11.9) at spike
// level, for rows S01, S04 and N01-N04:
//   node run-shim.mjs --state <state> [--run-dir <dir>] [--grace <ms>] [--report-window <ms>] <ticket>
//   node kit.mjs run-shim --state <state> ... <ticket>          (the same)
// It claims a run ticket (`kit ticket --run`), then starts the agent as the leader of its own
// process group: `detached` on every OS, so on Unix the agent calls setsid and its group ID is its
// PID, and on Windows it gets its own process group and no console. The brief goes to the agent's
// stdin, which is then closed. The agent's stdout goes through the shim to `stdout.jsonl` and its
// stderr straight to `stderr.log` in the run folder (default `<state>/runs/<run>/`, 0700, files
// 0600). The shim reports run.started and run.exited and writes `meta.json` and `exit.json`.
//
// A `cancel` from the service (`kit call spike.cancel_run`) becomes SIGINT to the agent's group
// on Unix (`kill(-pgid, SIGINT)`) and `taskkill /PID <pid> /T` without /F on Windows, then the
// forced stop after `--grace` ms (SIGKILL to the group, `taskkill /T /F`). The shim stays outside
// the agent's group. A signal that reaches the shim itself is recorded in `shim-signals.log` and as
// run.signal, so row S01 can show that a SIGINT to the run's group never reached it. SIGTERM to
// the shim runs the cancel sequence (A4 3.11.8 step 6).
//
// When the service goes away, the agent keeps running and the shim reconnects every second with
// `run.attach` (S04). The service accepts that without a credential at spike level. Every report
// and every attach is bounded (3 s). After the agent exits, the shim writes `exit.json` and waits
// up to `--report-window` ms (default 10 s) for a connection, old or newly attached, to take
// run.exited. Then it aborts every reconnect still in flight, closes every client it did not
// adopt and exits 0, with exit.json as the record when no service took the report.
// Not in the spike: the attachment credential check, the event journal and checkpoints, raw-log
// caps, timeouts, the descendant sweep and the Windows job object.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  RpcClient,
  asObject,
  clientInfo,
  connect,
  connectWithRetry,
  option,
  textOf,
  type Connection,
  type JsonObject,
} from "./wire.ts";

const TICKET = /^kt_[A-Za-z0-9_-]{32}$/;
const RUN = /^[0-9a-f]{12}$/;
const USAGE =
  "Usage: run-shim --state <state> [--run-dir <dir>] [--grace <ms>] [--report-window <ms>] <ticket>";
/** How long the shim waits after the agent's exit for a service to take run.exited. */
const REPORT_WINDOW_MS = 10_000;
/** The bound on every report and on run.attach: a service that does not answer is not adopted. */
const ATTACH_MS = 3_000;

const say = (line: string) => process.stderr.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeJsonAtomic(path: string, value: JsonObject): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

const taskkill = () => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");

export async function runShim(args: string[]): Promise<number> {
  const state = option(args, "--state");
  const ticket = args.at(-1) ?? "";
  const grace = Number(option(args, "--grace") ?? "10000");
  const reportWindow = Number(option(args, "--report-window") ?? String(REPORT_WINDOW_MS));
  if (
    state === undefined ||
    !TICKET.test(ticket) ||
    !Number.isFinite(grace) ||
    grace < 0 ||
    !Number.isFinite(reportWindow) ||
    reportWindow < 0
  ) {
    say(USAGE);
    return 64;
  }
  process.title = "tasks shim --run";
  const startTime = Math.round(Date.now() - process.uptime() * 1000);

  let first: Connection | undefined;
  try {
    first = await connectWithRetry(state, "shim", 30_000);
  } catch (error) {
    say(error instanceof Error ? error.message : "The connection failed.");
    return 69;
  }
  if (first === undefined) {
    say("The Tasks service is not running.");
    return 69;
  }
  const claimer = new RpcClient(first);
  // The current service connection. A holder, because closures replace it after a restart.
  const link: { rpc: RpcClient | undefined } = { rpc: claimer };

  let claim: JsonObject;
  try {
    claim =
      asObject(
        await claimer.call("launch.claim", {
          ticket,
          role: "run",
          pid: process.pid,
          start_time: startTime,
        }),
      ) ?? {};
  } catch (error) {
    say(error instanceof Error ? error.message : "The claim failed.");
    claimer.close();
    return 75;
  }

  const run = claim["run"];
  const argv = claim["argv"];
  const cwd = claim["cwd"];
  const env = asObject(claim["env"]) ?? {};
  const brief = typeof claim["brief"] === "string" ? claim["brief"] : "";
  const fail = async (reason: string, text: string) => {
    await claimer.call("launch.failed", { reason }).catch(() => undefined);
    claimer.close();
    say(text);
    return 70;
  };
  if (
    typeof run !== "string" ||
    !RUN.test(run) ||
    !Array.isArray(argv) ||
    !argv.every((a) => typeof a === "string") ||
    typeof cwd !== "string"
  ) {
    return fail("bad_claim", "The service sent an incomplete run.");
  }
  if (!existsSync(cwd) || realpathSync.native(cwd) !== cwd) {
    return fail("cwd_mismatch", "The run folder does not exist or has moved.");
  }
  const [file, ...rest] = argv;
  if (file === undefined || !existsSync(file) || /\.(cmd|bat)$/i.test(file)) {
    return fail("bad_executable", "The agent's executable is missing or is a batch file.");
  }

  const ref: string = run;
  const runDir = option(args, "--run-dir") ?? join(state, "runs", ref);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith("TASKS_")) childEnv[name] = value;
  }
  for (const [name, value] of Object.entries(env)) childEnv[name] = textOf(value);

  // --- Spawn the agent as its own group's leader (A4 3.11.3, 3.11.8 step 2)
  const outFd = openSync(join(runDir, "stdout.jsonl"), "a", 0o600);
  const errFd = openSync(join(runDir, "stderr.log"), "a", 0o600);
  const started = Date.now();
  const child = spawn(file, rest, {
    cwd,
    env: childEnv,
    detached: true,
    stdio: ["pipe", "pipe", errFd],
    windowsHide: true,
    shell: false,
  });
  closeSync(errFd); // the agent holds its own copy
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) throw new Error("spawn gave no stdio pipes");
  let lines = 0;
  stdout.on("data", (chunk: Buffer) => {
    writeSync(outFd, chunk);
    for (const byte of chunk) if (byte === 10) lines++;
  });
  stdin.on("error", () => undefined);
  stdin.end(brief);
  let reaped = false;
  child.once("exit", () => {
    reaped = true;
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", () => {
      reaped = true;
      resolve({ code: null, signal: null });
    });
  });
  const pid = child.pid;
  const pgid = process.platform === "win32" || pid === undefined ? null : pid;
  writeJsonAtomic(join(runDir, "meta.json"), {
    shim_pid: process.pid,
    agent_pid: pid ?? null,
    pgid,
    started,
  });

  // --- The service connection: reports, cancel, and re-attaching after a restart (A4 3.11.9)
  // `finished` turns true when the reporting window after the agent's exit closes. From then on
  // nothing is adopted: every reconnect still in flight is aborted and its client closed, so a
  // late `run.attach` reply cannot keep the shim alive (review round 2, finding D).
  // One object, because closures change these while the main flow awaits.
  const flow: {
    finished: boolean;
    reconnecting: boolean;
    /** Set when the agent has exited and exit.json is written. */
    exitReport: JsonObject | undefined;
    exitReported: boolean;
  } = { finished: false, reconnecting: false, exitReport: undefined, exitReported: false };
  /** A function, so a check after an await reads the current state, not a narrowed one. */
  const done = (): boolean => flow.finished;
  const giveUp = new AbortController();
  const pending = new Set<RpcClient>();
  const report = (method: string, params: JsonObject = {}): Promise<boolean> =>
    link.rpc === undefined
      ? Promise.resolve(false)
      : link.rpc.call(method, { run: ref, ...params }, ATTACH_MS).then(
          () => true,
          () => false,
        );
  /** Sends run.exited through `client` once, unless it was already delivered. */
  const deliverExit = async (client: RpcClient): Promise<void> => {
    if (flow.exitReport === undefined || flow.exitReported || flow.finished) return;
    try {
      await client.call("run.exited", { run: ref, ...flow.exitReport }, ATTACH_MS);
      flow.exitReported = true;
    } catch {
      // The connection went away again. A later attach retries while the window is open.
    }
  };
  const adopt = (client: RpcClient): boolean => {
    if (flow.finished) {
      client.close();
      return false;
    }
    link.rpc = client;
    client.onNotification = (method) => {
      if (method === "cancel") cancel();
    };
    client.onClose = () => {
      if (link.rpc === client) link.rpc = undefined;
      if (!flow.finished) void reconnect();
    };
    void deliverExit(client);
    return true;
  };
  async function reconnect(): Promise<void> {
    if (flow.reconnecting) return;
    flow.reconnecting = true;
    while (link.rpc === undefined && !flow.finished) {
      await sleep(1000);
      if (done()) break;
      let client: RpcClient | undefined;
      try {
        client = new RpcClient(
          await connect(
            state ?? "",
            { mode: "rpc", client: clientInfo("shim"), context: {} },
            { signal: giveUp.signal },
          ),
        );
        pending.add(client);
        if (done()) throw new Error("finished");
        await client.call("run.attach", { run: ref, pid: pid ?? null }, ATTACH_MS);
        pending.delete(client);
        if (!adopt(client)) break;
      } catch {
        // Not back yet, too slow, or finished. The agent keeps running.
        if (client !== undefined) {
          pending.delete(client);
          client.close();
        }
      }
    }
    flow.reconnecting = false;
  }
  adopt(claimer);

  // --- Cancel (A4 3.11.8 steps 3 and 5)
  let cancelled = false;
  function cancel(): void {
    if (cancelled || reaped || pid === undefined) return;
    cancelled = true;
    let method: string;
    let status: string;
    if (process.platform === "win32") {
      const result = spawnSync(taskkill(), ["/PID", String(pid), "/T"], {
        windowsHide: true,
        timeout: 10_000,
      });
      method = "taskkill /T";
      status = String(result.status);
    } else {
      method = "SIGINT to group";
      try {
        process.kill(-pid, "SIGINT");
        status = "sent";
      } catch (error) {
        status = (error as NodeJS.ErrnoException).code ?? "error";
      }
    }
    void report("run.cancel", { method, status });
    const force = setTimeout(() => {
      if (reaped) return;
      if (process.platform === "win32") {
        const result = spawnSync(taskkill(), ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 10_000,
        });
        void report("run.cancel", { method: "taskkill /T /F", status: String(result.status) });
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        void report("run.cancel", { method: "SIGKILL to group", status: "sent" });
      }
    }, grace);
    force.unref();
  }

  // --- Signals that reach the shim itself (S01: a group SIGINT must not)
  const ownSignal = (signal: string) => {
    appendFileSync(join(runDir, "shim-signals.log"), `${signal}\n`, { mode: 0o600 });
    void report("run.signal", { signal });
  };
  process.on("SIGINT", () => {
    ownSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    ownSignal("SIGTERM");
    cancel();
  });
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {
      ownSignal("SIGHUP");
    });
    process.on("SIGQUIT", () => {
      ownSignal("SIGQUIT");
    });
  }

  await report("run.started", { pid: pid ?? null, pgid });
  const { code, signal } = await exited;
  closeSync(outFd);
  const outcome: JsonObject = {
    code,
    signal,
    duration_ms: Date.now() - started,
    stdout_lines: lines,
    cancelled,
  };
  writeJsonAtomic(join(runDir, "exit.json"), outcome);
  // Report the outcome through the current connection, or through any client that attaches within
  // the reporting window (a service that is restarting). After the window exit.json is the record.
  flow.exitReport = outcome;
  if (link.rpc !== undefined) await deliverExit(link.rpc);
  const windowEnd = Date.now() + reportWindow;
  while (!flow.exitReported && Date.now() < windowEnd) await sleep(50);
  flow.finished = true;
  giveUp.abort();
  for (const client of pending) client.close();
  pending.clear();
  link.rpc?.close();
  link.rpc = undefined;
  if (!flow.exitReported) say("The service did not take the exit report. exit.json holds it.");
  return 0;
}

if (import.meta.main) process.exitCode = await runShim(process.argv.slice(2));
