// The bridge rows of the M0 lab (A7 3.7 B01-B07, A2 3.7.7), lab step M0.06. Node built-ins only.
//
//   B02  memory of one forwarder after the handshake, 10 calls and 60 s idle
//   B03  10 forwarders at once, 100 read calls each: added private memory, call p95, failures
//   B04  forwarding overhead: the same call through a forwarder and through a direct socket client
//   B05  the stand-in service during B03: RSS growth, event-loop stalls (its `service/status`)
//   B01, B06, B07  the kit's bench (bench.ts), written as result files with their thresholds
//
// The stand-in service runs as its own process (`kit.mjs service`), started from the same built
// kit as the forwarders and on the same Node, so the timed and measured processes are the shape
// the product runs: `node lib/bridge.mjs` against a separate service. Memory is read from outside
// the measured process: Linux from /proc/<pid>/smaps_rollup (USS = Private_Clean + Private_Dirty,
// PSS, RSS), Windows through .NET in Windows PowerShell (Private Bytes, Working Set and the
// private working set from the "Process V2" counter), without admin rights.
//
// Each row prints its numbers with the row's threshold and writes <out>/<row>[-<label>].json:
// numbers, counts and machine facts only, never paths or host names. A verdict is given only when
// the run meets the row's prescribed counts; a smaller run is indicative (pass null).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { runBench, type Metric, type Stats } from "./bench.ts";
import { buildKit, checkBuiltKit } from "./build.ts";
import {
  KitError,
  LineReader,
  RpcClient,
  SPACE_ID,
  asObject,
  clientInfo,
  connect,
  parseObject,
  readServiceInfo,
  type Connection,
  type Json,
  type JsonObject,
  type ServiceInfo,
} from "./wire.ts";

export const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const mib = (bytes: number) => round(bytes / MiB, 1);
const mib2 = (bytes: number) => round(bytes / MiB, 2);

// ---------------------------------------------------------------------------------------------
// Numbers

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentiles, in the unit of the samples. */
export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const at = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: n,
    p50: round(at(0.5), 3),
    p95: round(at(0.95), 3),
    p99: round(at(0.99), 3),
    max: round(sorted[n - 1] ?? 0, 3),
    mean: round(sum / n, 3),
  };
}

export interface Condition {
  name: string;
  required: string;
  actual: number | string | boolean;
  met: boolean;
}

const condition = (
  name: string,
  required: string,
  actual: number | string | boolean,
  met: boolean,
): Condition => ({ name, required, actual, met });

export interface Machine {
  role: string;
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  cpu: string;
  cpus: number;
  memoryGiB: number;
  node: string;
}

export function machine(role: string): Machine {
  return {
    role,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cpus: os.availableParallelism(),
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
  };
}

export interface Quiet {
  /** Share of all CPU time that was busy over the window, in percent. */
  busyPercent: number;
  windowMs: number;
  /** Linux only: the 1, 5 and 15 minute load averages. */
  loadavg: number[] | null;
}

/** How busy the machine is right before a timed run, from os.cpus() over `ms`. */
export async function quiet(ms = 3_000): Promise<Quiet> {
  const before = os.cpus();
  await sleep(ms);
  const after = os.cpus();
  const sum = (t: os.CpuInfo["times"]) => t.user + t.nice + t.sys + t.irq + t.idle;
  let idle = 0;
  let total = 0;
  after.forEach((cpu, i) => {
    const prev = before[i];
    if (prev === undefined) return;
    idle += cpu.times.idle - prev.times.idle;
    total += sum(cpu.times) - sum(prev.times);
  });
  return {
    busyPercent: total > 0 ? round(100 * (1 - idle / total), 1) : 0,
    windowMs: ms,
    loadavg: process.platform === "win32" ? null : os.loadavg().map((l) => round(l, 2)),
  };
}

// ---------------------------------------------------------------------------------------------
// Memory of another process, without admin rights

export interface ProcessMemory {
  /** USS on Linux (Private_Clean + Private_Dirty), Private Bytes on Windows. Bytes. */
  private: number;
  /** RSS on Linux, Working Set on Windows. Bytes. */
  rss: number;
  /** Linux only: PSS. */
  pss: number | null;
  /** Windows only: the private working set ("Process V2" counter), when readable. */
  privateWorkingSet: number | null;
}

/** What `private` means on this OS, for the reports. */
export const PRIVATE_KIND = process.platform === "win32" ? "Private Bytes" : "USS";

function linuxMemory(pid: number): ProcessMemory {
  const fields = new Map<string, number>();
  for (const line of readFileSync(`/proc/${String(pid)}/smaps_rollup`, "utf8").split("\n")) {
    const match = /^(\w+):\s+(\d+) kB$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields.set(match[1], Number(match[2]) * 1024);
    }
  }
  const kb = (name: string) => fields.get(name) ?? 0;
  return {
    private: kb("Private_Clean") + kb("Private_Dirty"),
    rss: kb("Rss"),
    pss: kb("Pss"),
    privateWorkingSet: null,
  };
}

/**
 * .NET only, no cmdlet module, the process IDs in an environment variable (never in the script
 * text). One line per ID: "<pid> <private bytes> <working set> <private working set or -1>".
 */
const WINDOWS_MEMORY =
  "foreach ($id in $env:TTASKS_M0_PIDS.Split(',')) { try { " +
  "$p=[Diagnostics.Process]::GetProcessById([int]$id); $pws=-1; " +
  "try { $c=New-Object Diagnostics.PerformanceCounter('Process V2','Working Set - Private'," +
  "('{0}:{1}' -f $p.ProcessName,$p.Id),$true); $pws=[int64]$c.RawValue } catch {}; " +
  "[Console]::Out.WriteLine(('{0} {1} {2} {3}' -f $p.Id,$p.PrivateMemorySize64,$p.WorkingSet64,$pws)) " +
  "} catch { [Console]::Out.WriteLine(('{0} gone' -f $id)) } }";

function windowsMemory(pids: number[]): Map<number, ProcessMemory> {
  const env: NodeJS.ProcessEnv = { TTASKS_M0_PIDS: pids.join(",") };
  for (const name of ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const exe = join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    exe,
    ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", WINDOWS_MEMORY],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      env,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new KitError("memory_unreadable", "Windows PowerShell could not read process memory.");
  }
  const found = new Map<number, ProcessMemory>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pid, priv, ws, pws] = line.trim().split(" ").map(Number);
    if (pid === undefined || priv === undefined || ws === undefined || !Number.isFinite(priv)) {
      continue;
    }
    found.set(pid, {
      private: priv,
      rss: ws,
      pss: null,
      privateWorkingSet: pws === undefined || pws < 0 ? null : pws,
    });
  }
  return found;
}

/** The memory of each process, read from outside it. Throws when a process is gone. */
export function readMemory(pids: number[]): ProcessMemory[] {
  if (process.platform === "linux") return pids.map(linuxMemory);
  if (process.platform === "win32") {
    const found = windowsMemory(pids);
    return pids.map((pid) => {
      const m = found.get(pid);
      if (m === undefined)
        throw new KitError("memory_unreadable", `Process ${String(pid)} is gone.`);
      return m;
    });
  }
  throw new KitError("unsupported", "Memory is read on Linux and Windows only.");
}

const memoryMiB = (m: ProcessMemory) => ({
  private: mib(m.private),
  rss: mib(m.rss),
  pss: m.pss === null ? null : mib(m.pss),
  privateWorkingSet: m.privateWorkingSet === null ? null : mib(m.privateWorkingSet),
});

// ---------------------------------------------------------------------------------------------
// MCP over lines: a forwarder's stdio or a direct socket

interface Reply {
  msg: JsonObject;
  ms: number;
}

class McpPeer {
  readonly #write: (line: string) => void;
  readonly #pending = new Map<number, (reply: JsonObject | null) => void>();
  #next = 1;
  #ended = false;

  constructor(write: (line: string) => void, reader: LineReader) {
    this.#write = write;
    reader.pipe(
      (line) => {
        const msg = parseObject(line);
        const id = msg?.["id"];
        if (msg === undefined || typeof id !== "number") return;
        const resolve = this.#pending.get(id);
        this.#pending.delete(id);
        resolve?.(msg);
      },
      () => {
        this.#ended = true;
        for (const resolve of this.#pending.values()) resolve(null);
        this.#pending.clear();
      },
    );
  }

  request(method: string, params: JsonObject, timeoutMs = 10_000): Promise<Reply> {
    if (this.#ended) return Promise.reject(new KitError("connection_lost"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new KitError("rpc_timeout", `No reply to ${method} in ${String(timeoutMs)} ms.`));
      }, timeoutMs);
      const started = performance.now();
      this.#pending.set(id, (msg) => {
        const ms = performance.now() - started;
        clearTimeout(timer);
        if (msg === null) reject(new KitError("connection_lost"));
        else resolve({ msg, ms });
      });
      this.#write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string): void {
    if (!this.#ended) this.#write(JSON.stringify({ jsonrpc: "2.0", method }));
  }

  /** `initialize` (2025-11-25) and `notifications/initialized`. True when the service answered. */
  async initialize(): Promise<boolean> {
    const { msg } = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "kit-bridge-bench", version: "1" },
    });
    this.notify("notifications/initialized");
    const info = asObject(asObject(msg["result"])?.["serverInfo"]);
    // The live stub is "ttasks-stand-in"; the forwarder's offline responder is "ttasks".
    return info?.["name"] === "ttasks-stand-in";
  }

  /** One read call: the stub's `status` tool. */
  async status(): Promise<number> {
    const { msg, ms } = await this.request("tools/call", { name: "status", arguments: {} });
    const result = asObject(msg["result"]);
    if (result === undefined || result["isError"] === true) {
      throw new KitError("call_failed", "The status call failed.");
    }
    return ms;
  }
}

/** Test hooks: inject failures and see every process the harness starts. The CLI never sets them. */
export interface Hooks {
  /** Every child process the harness spawns, as soon as it exists. */
  spawned?: (pid: number, what: "service" | "forwarder") => void;
  /** Replaces readMemory. */
  readMemory?: (pids: number[]) => ProcessMemory[];
  /** Runs once the service process is up, before the harness connects to it. A throw fails the start. */
  serviceUp?: () => void | Promise<void>;
  /** Replaces B04's direct socket client connect. */
  connectDirect?: typeof connect;
}

export interface BridgeOptions {
  /** The built kit the forwarder comes from. */
  js: string;
  state: string;
  /** Node flags for the bridge only (A2 3.7.7 rule 2). */
  nodeArgs: readonly string[];
  /** Extra environment for the bridge only, such as NODE_COMPILE_CACHE. */
  env: Readonly<Record<string, string>>;
  hooks?: Hooks;
}

/** Tracks a child's exit: settles on "exit", or on "error" when the process never started. */
interface Exit {
  done: () => boolean;
  exited: Promise<void>;
}

function exitOf(child: ChildProcess): Exit {
  let done = child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise<void>((resolve) => {
    const settle = () => {
      done = true;
      resolve();
    };
    if (done) settle();
    child.once("exit", settle);
    child.once("error", () => {
      if (child.pid === undefined) settle();
    });
  });
  return { done: () => done, exited };
}

/**
 * Waits up to `graceMs` for the child to exit by itself, then terminates it, and kills it 5 s
 * later. Resolves only once it has exited, so nothing the harness started outlives the call.
 */
async function stopChild(child: ChildProcess, exit: Exit, graceMs: number): Promise<void> {
  if (exit.done()) return;
  const term = setTimeout(() => child.kill(), graceMs);
  const kill = setTimeout(() => child.kill("SIGKILL"), graceMs + 5_000);
  try {
    await exit.exited;
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
}

class Bridge {
  readonly child: ChildProcess;
  readonly peer: McpPeer;
  readonly #exit: Exit;

  constructor(options: BridgeOptions) {
    this.child = spawn(
      process.execPath,
      [...options.nodeArgs, join(options.js, "forwarder.mjs"), "--state", options.state],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...options.env },
      },
    );
    // From here the process exists: track its exit before anything else can throw.
    this.#exit = exitOf(this.child);
    if (this.child.pid !== undefined) options.hooks?.spawned?.(this.child.pid, "forwarder");
    const { stdin, stdout } = this.child;
    if (stdin === null || stdout === null) {
      this.child.kill("SIGKILL");
      throw new KitError("spawn_failed");
    }
    stdin.on("error", () => undefined);
    this.peer = new McpPeer((line) => stdin.write(`${line}\n`), new LineReader(stdout));
  }

  get pid(): number {
    if (this.child.pid === undefined) throw new KitError("spawn_failed");
    return this.child.pid;
  }

  /** Closes stdin (the forwarder exits on EOF), terminates it after 3 s. Never rejects. */
  async close(): Promise<void> {
    this.child.stdin?.end();
    await stopChild(this.child, this.#exit, 3_000);
  }
}

/** Closes every bridge, also when one of them fails to close. */
async function closeAll(fleet: readonly Bridge[]): Promise<void> {
  await Promise.allSettled(fleet.map((b) => b.close()));
}

// ---------------------------------------------------------------------------------------------
// The stand-in service as its own process

/** The per-user runtime folder the service may have created for `state` (Linux only). */
function runUserDir(state: string): string | undefined {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) return undefined;
  const install = createHash("sha256")
    .update(realpathSync.native(state), "utf8")
    .digest("hex")
    .slice(0, 16);
  return join("/run/user", String(uid), `ttasks-${install}`);
}

/**
 * Removes the empty per-user socket folder a stopped service leaves for `state` (the kit's service
 * removes its socket, not the folder). Never recursive: a folder that is not empty stays.
 * Returns what happened, for the lab record.
 */
export function removeRunUserDir(state: string): "removed" | "none" | "not empty" {
  const dir = existsSync(state) ? runUserDir(state) : undefined;
  if (dir === undefined || !existsSync(dir)) return "none";
  try {
    rmdirSync(dir);
    return "removed";
  } catch {
    return "not empty";
  }
}

export interface ServiceProcess {
  pid: number;
  info: ServiceInfo;
  rpc: RpcClient;
  stop(): Promise<void>;
}

export async function startServiceProcess(
  js: string,
  state: string,
  hooks: Hooks = {},
): Promise<ServiceProcess> {
  if (existsSync(state)) {
    throw new KitError(
      "usage",
      "The service's state folder must not exist yet: the kit creates it.",
    );
  }
  const child = spawn(process.execPath, [join(js, "kit.mjs"), "service", "--state", state], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    shell: false,
  });
  // From here the process exists: every failure below stops it before the error leaves.
  const exit = exitOf(child);
  let rpc: RpcClient | undefined;
  try {
    if (child.pid !== undefined) hooks.spawned?.(child.pid, "service");
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const deadline = Date.now() + 60_000;
    let info: ServiceInfo | undefined;
    while (info === undefined) {
      if (exit.done()) {
        throw new KitError("service_failed", `The stand-in service exited: ${stderr.trim()}`);
      }
      if (Date.now() > deadline) {
        throw new KitError("service_failed", "The stand-in service did not get ready in 60 s.");
      }
      try {
        info = readServiceInfo(state);
      } catch {
        await sleep(50);
      }
    }
    await hooks.serviceUp?.();
    rpc = new RpcClient(
      await connect(state, { mode: "rpc", client: clientInfo("cli"), context: {} }),
    );
    const client = rpc;
    return {
      pid: info.pid,
      info,
      rpc: client,
      async stop() {
        await client.call("service/shutdown", {}, 5_000).catch(() => undefined);
        client.close();
        await stopChild(child, exit, 10_000);
      },
    };
  } catch (error) {
    rpc?.close();
    await stopChild(child, exit, 0);
    throw error;
  }
}

interface ServiceStatus {
  rss: number;
  loop: {
    since_ms: number;
    samples: number;
    max_ms: number;
    p99_ms: number;
    mean_ms: number;
    cpu_ms: number;
    resolution_ms: number;
  };
}

async function serviceStatus(rpc: RpcClient): Promise<ServiceStatus> {
  const status = asObject(await rpc.call("service/status", {}, 10_000)) ?? {};
  const memory = asObject(status["memory"]) ?? {};
  const loop = asObject(status["loop"]) ?? {};
  const num = (v: Json | undefined) => (typeof v === "number" ? v : 0);
  return {
    rss: num(memory["rss"]),
    loop: {
      since_ms: num(loop["since_ms"]),
      samples: num(loop["samples"]),
      max_ms: num(loop["max_ms"]),
      p99_ms: num(loop["p99_ms"]),
      mean_ms: num(loop["mean_ms"]),
      cpu_ms: num(loop["cpu_ms"]),
      resolution_ms: num(loop["resolution_ms"]),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Rows

export interface BridgeBenchOptions {
  /** Scratch folder: the built kit (from .ts sources) and one new state folder per row. */
  work: string;
  /** Results folder. */
  out: string;
  /** A prebuilt kit to run the service and forwarders from. Default: this kit. */
  kit?: string;
  /** Suffix for the result files, such as run1. */
  label?: string;
  /** A label for the result files, such as windows or linux. */
  role?: string;
  /** B02: calls after the handshake (10) and idle time before the reading (60 s). */
  calls?: number;
  idleMs?: number;
  /** B03 and B05: bridges at once (10) and read calls each (100). */
  bridges?: number;
  bridgeCalls?: number;
  /** B04: calls per path (500; the verdict needs 100). */
  directCalls?: number;
  /** A2 3.7.7 rule 2: Node flags and environment for the bridge only. */
  nodeArgs?: string[];
  bridgeEnv?: Record<string, string>;
  /** Milliseconds of CPU sampling before each row, recorded with it (3 s). */
  quietMs?: number;
  /**
   * A2 3.7.7's "20 runs per metric": B02, B03 (with B05) and B04 each run this many times, and one
   * file per row holds every run's values with their median and p95 across runs (1: one run, its
   * own file). B01, B06 and B07 already take 20 starts per metric in one set, so they run once.
   */
  repeat?: number;
  /** Test hooks only. */
  hooks?: Hooks;
}

/** An upper bound on one value of a row, and how a repeated row is judged against it. */
export interface Bound {
  limit: number;
  /** p95: the p95 across runs must be at most the limit. every: every run must be. */
  across: "p95" | "every";
}

export interface RowResult {
  row: string;
  title: string;
  threshold: string;
  judged: boolean;
  pass: boolean | null;
  conditions: Condition[];
  metrics: Record<string, unknown>;
  /** CPU use right before the run. */
  quiet?: Quiet;
  /** The row's numbers as plain values, for the median and p95 across repeated runs. */
  values?: Record<string, number>;
  /** The row's thresholds on `values`. Values without a bound are reported, not judged. */
  bounds?: Record<string, Bound>;
}

interface Context {
  js: string;
  work: string;
  out: string;
  label: string;
  role: string;
  quietMs: number;
  /** False inside a repeated row: the runs print a line and the row writes one file. */
  write: boolean;
  hooks: Hooks;
  readMemory: (pids: number[]) => ProcessMemory[];
  connectDirect: typeof connect;
  bridge: Omit<BridgeOptions, "state">;
}

function verdict(conditions: Condition[], pass: () => boolean) {
  const judged = conditions.every((c) => c.met);
  return { judged, pass: judged ? pass() : null, conditions };
}

function report(ctx: Context, result: RowResult, extra: Record<string, unknown> = {}): void {
  if (!ctx.write) {
    console.log(`${result.row} ${ctx.label}: ${JSON.stringify(result.values ?? result.metrics)}`);
    return;
  }
  const text = result.judged
    ? result.pass === true
      ? "PASS"
      : "FAIL"
    : `not judged, indicative only: ${result.conditions
        .filter((c) => !c.met)
        .map((c) => `${c.name} ${String(c.actual)} (needs ${c.required})`)
        .join("; ")}`;
  console.log(`${result.row} ${result.title}`);
  console.log(`${result.row} ${JSON.stringify(result.metrics)}`);
  console.log(`${result.row} threshold: ${result.threshold} -> ${text}`);
  mkdirSync(ctx.out, { recursive: true });
  const name = ctx.label === "" ? result.row : `${result.row}-${ctx.label}`;
  writeFileSync(
    join(ctx.out, `${name}.json`),
    `${JSON.stringify(
      {
        ...result,
        label: ctx.label,
        machine: machine(ctx.role),
        nodeArgs: ctx.bridge.nodeArgs,
        bridgeEnv: Object.keys(ctx.bridge.env),
        ...extra,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

const newState = (ctx: Context, row: string) =>
  join(ctx.work, `state-${row.toLowerCase()}-${ctx.label || "x"}-${String(Date.now())}`);

async function withService<T>(
  ctx: Context,
  row: string,
  body: (service: ServiceProcess, state: string) => Promise<T>,
): Promise<T> {
  const state = newState(ctx, row);
  try {
    const service = await startServiceProcess(ctx.js, state, ctx.hooks);
    try {
      return await body(service, state);
    } finally {
      await service.stop();
    }
  } finally {
    removeRunUserDir(state);
  }
}

export async function rowB02(ctx: Context, calls: number, idleMs: number): Promise<RowResult> {
  const q = await quiet(ctx.quietMs);
  return withService(ctx, "B02", async (_service, state) => {
    const bridge = new Bridge({ ...ctx.bridge, state });
    try {
      const online = await bridge.peer.initialize();
      const times: number[] = [];
      for (let i = 0; i < calls; i++) times.push(await bridge.peer.status());
      const [afterCalls] = ctx.readMemory([bridge.pid]);
      await sleep(idleMs);
      const [afterIdle] = ctx.readMemory([bridge.pid]);
      if (afterCalls === undefined || afterIdle === undefined)
        throw new KitError("memory_unreadable");
      const result: RowResult = {
        row: "B02",
        title: "Memory per bridge after the handshake, 10 calls and 60 s idle",
        threshold: `${PRIVATE_KIND} <= 30 MiB, RSS <= 60 MiB`,
        ...verdict(
          [
            condition("online", "true", online, online),
            condition("calls", ">= 10", calls, calls >= 10),
            condition("idle_ms", ">= 60000", idleMs, idleMs >= 60_000),
          ],
          () => afterIdle.private <= 30 * MiB && afterIdle.rss <= 60 * MiB,
        ),
        metrics: {
          privateKind: PRIVATE_KIND,
          afterIdleMiB: memoryMiB(afterIdle),
          afterCallsMiB: memoryMiB(afterCalls),
          callMs: summarize(times),
        },
        quiet: q,
        values: {
          privateMiB: mib2(afterIdle.private),
          rssMiB: mib2(afterIdle.rss),
          ...(afterIdle.pss === null ? {} : { pssMiB: mib2(afterIdle.pss) }),
          ...(afterIdle.privateWorkingSet === null
            ? {}
            : { privateWorkingSetMiB: mib2(afterIdle.privateWorkingSet) }),
          callP95Ms: summarize(times).p95,
        },
        bounds: {
          privateMiB: { limit: 30, across: "p95" },
          rssMiB: { limit: 60, across: "p95" },
        },
      };
      report(ctx, result);
      return result;
    } finally {
      await bridge.close();
    }
  });
}

/** B03 and B05 in one burst: 10 bridges at once against one service process. */
export async function rowB03B05(
  ctx: Context,
  bridges: number,
  callsEach: number,
): Promise<[RowResult, RowResult]> {
  const q = await quiet(ctx.quietMs);
  return withService(ctx, "B03", async (service, state) => {
    await sleep(1_000);
    const [serviceBefore] = ctx.readMemory([service.pid]);
    const baseline = await serviceStatus(service.rpc);
    await service.rpc.call("spike.loop_reset", {}, 10_000);
    let rssMax = baseline.rss;
    const fleet: Bridge[] = [];
    const callTimes: number[] = [];
    const handshakeMs: number[] = [];
    let failures = 0;
    let callErrors = 0;
    let burstMs: number;
    let after: ServiceStatus;
    let memories: ProcessMemory[];
    // The poller and every forwarder are stopped in `finally`, whatever fails in between.
    const burst: { polling: boolean; error: Error | undefined } = {
      polling: true,
      error: undefined,
    };
    const poller = (async () => {
      try {
        while (burst.polling) {
          const status = await serviceStatus(service.rpc);
          rssMax = Math.max(rssMax, status.rss);
          await sleep(200);
        }
      } catch (error) {
        burst.error = error instanceof Error ? error : new Error(String(error));
      }
    })();
    try {
      const started = performance.now();
      for (let i = 0; i < bridges; i++) fleet.push(new Bridge({ ...ctx.bridge, state }));
      await Promise.all(
        fleet.map(async (bridge) => {
          try {
            const t0 = performance.now();
            const online = await bridge.peer.initialize();
            handshakeMs.push(performance.now() - t0);
            if (!online) failures++;
          } catch {
            failures++;
            return;
          }
          for (let c = 0; c < callsEach; c++) {
            try {
              callTimes.push(await bridge.peer.status());
            } catch {
              callErrors++;
            }
          }
        }),
      );
      burstMs = performance.now() - started;
      burst.polling = false;
      await poller;
      if (burst.error !== undefined) throw burst.error;
      after = await serviceStatus(service.rpc);
      rssMax = Math.max(rssMax, after.rss);
      // Read while the forwarders still run: their memory is the measurement.
      memories = ctx.readMemory([...fleet.map((b) => b.pid), service.pid]);
    } finally {
      burst.polling = false;
      await poller;
      await closeAll(fleet);
    }
    const serviceAfter = memories.pop();
    if (serviceBefore === undefined || serviceAfter === undefined) {
      throw new KitError("memory_unreadable");
    }
    const bridgesPrivate = memories.reduce((a, m) => a + m.private, 0);
    const serviceGrowth = Math.max(0, serviceAfter.private - serviceBefore.private);
    const added = bridgesPrivate + serviceGrowth;
    const calls = summarize(callTimes);
    const counts = [
      condition("bridges", ">= 10", bridges, bridges >= 10),
      condition("calls_each", ">= 100", callsEach, callsEach >= 100),
    ];
    const b03: RowResult = {
      row: "B03",
      title: "10 bridges at once, 100 read calls each",
      threshold: "added private memory <= 300 MiB, call p95 <= 50 ms, no handshake failure",
      ...verdict(
        counts,
        () => added <= 300 * MiB && calls.p95 <= 50 && failures === 0 && callErrors === 0,
      ),
      metrics: {
        privateKind: PRIVATE_KIND,
        addedPrivateMiB: mib(added),
        bridgesPrivateMiB: mib(bridgesPrivate),
        serviceGrowthPrivateMiB: mib(serviceGrowth),
        perBridgeMiB: memories.map(memoryMiB),
        callMs: calls,
        handshakeFailures: failures,
        callErrors,
        initializeMs: summarize(handshakeMs),
        burstMs: Math.round(burstMs),
      },
      quiet: q,
      values: {
        addedPrivateMiB: mib2(added),
        callP95Ms: calls.p95,
        handshakeFailures: failures,
        callErrors,
        callP50Ms: calls.p50,
        bridgesPrivateMiB: mib2(bridgesPrivate),
        serviceGrowthPrivateMiB: mib2(serviceGrowth),
        initializeP95Ms: round(summarize(handshakeMs).p95, 1),
        burstMs: Math.round(burstMs),
      },
      bounds: {
        addedPrivateMiB: { limit: 300, across: "p95" },
        callP95Ms: { limit: 50, across: "p95" },
        handshakeFailures: { limit: 0, across: "every" },
        callErrors: { limit: 0, across: "every" },
      },
    };
    const growth = rssMax - baseline.rss;
    const b05: RowResult = {
      row: "B05",
      title: "Stand-in service during B03",
      threshold: "RSS growth <= 30 MiB, no event-loop stall over 100 ms",
      ...verdict(counts, () => growth <= 30 * MiB && after.loop.max_ms <= 100),
      metrics: {
        rssBeforeMiB: mib(baseline.rss),
        rssMaxMiB: mib(rssMax),
        rssGrowthMiB: mib(growth),
        rssPollMs: 200,
        // The raw histogram maximum of monitorEventLoopDelay: it includes the monitor's resolution,
        // so an idle loop reads about the resolution. It is not corrected.
        loopMaxMs: after.loop.max_ms,
        loopP99Ms: after.loop.p99_ms,
        loopMeanMs: after.loop.mean_ms,
        monitorResolutionMs: after.loop.resolution_ms,
        loopWindowMs: after.loop.since_ms,
        cpuMsInWindow: after.loop.cpu_ms,
        serviceMemoryBeforeMiB: memoryMiB(serviceBefore),
        serviceMemoryAfterMiB: memoryMiB(serviceAfter),
      },
      quiet: q,
      values: {
        rssGrowthMiB: mib2(growth),
        loopMaxMs: after.loop.max_ms,
        loopP99Ms: after.loop.p99_ms,
        loopMeanMs: after.loop.mean_ms,
        cpuMsInWindow: after.loop.cpu_ms,
        loopWindowMs: after.loop.since_ms,
      },
      bounds: {
        rssGrowthMiB: { limit: 30, across: "p95" },
        loopMaxMs: { limit: 100, across: "p95" },
      },
    };
    report(ctx, b03);
    report(ctx, b05);
    return [b03, b05];
  });
}

export async function rowB04(ctx: Context, callsEach: number): Promise<RowResult> {
  const q = await quiet(ctx.quietMs);
  return withService(ctx, "B04", async (_service, state) => {
    const bridge = new Bridge({ ...ctx.bridge, state });
    let connection: Connection | undefined;
    try {
      connection = await ctx.connectDirect(state, {
        mode: "mcp",
        client: clientInfo("forwarder"),
        context: { space: SPACE_ID, cwd: process.cwd(), env: {}, parent: { pid: process.pid } },
      });
      const { socket, reader } = connection;
      const direct = new McpPeer((line) => socket.write(`${line}\n`), reader);
      const online = (await bridge.peer.initialize()) && (await direct.initialize());
      for (let i = 0; i < 20; i++) {
        await bridge.peer.status();
        await direct.status();
      }
      const viaBridge: number[] = [];
      const viaSocket: number[] = [];
      for (let i = 0; i < callsEach; i++) {
        // Alternate which path goes first, so drift and caching fall on both alike.
        if (i % 2 === 0) {
          viaBridge.push(await bridge.peer.status());
          viaSocket.push(await direct.status());
        } else {
          viaSocket.push(await direct.status());
          viaBridge.push(await bridge.peer.status());
        }
      }
      const b = summarize(viaBridge);
      const d = summarize(viaSocket);
      const diff = round(b.p95 - d.p95, 3);
      const result: RowResult = {
        row: "B04",
        title: "Forwarding overhead against a direct socket client",
        threshold: "p95 difference <= 5 ms",
        ...verdict(
          [
            condition("online", "true", online, online),
            condition("calls_each", ">= 100", callsEach, callsEach >= 100),
          ],
          () => diff <= 5,
        ),
        metrics: {
          bridgeMs: b,
          directMs: d,
          p95DifferenceMs: diff,
          p50DifferenceMs: round(b.p50 - d.p50, 3),
        },
        quiet: q,
        values: {
          p95DifferenceMs: diff,
          p50DifferenceMs: round(b.p50 - d.p50, 3),
          bridgeP95Ms: b.p95,
          directP95Ms: d.p95,
        },
        bounds: { p95DifferenceMs: { limit: 5, across: "p95" } },
      };
      report(ctx, result);
      return result;
    } finally {
      connection?.socket.end();
      connection?.socket.destroy();
      await bridge.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// B01, B06 and B07 from the kit's bench

const START_LIMIT = process.platform === "win32" ? 600 : 250;

export interface StartOptions {
  runs: number;
  /** One metric, once, from a separate prebuilt kit (bench.ts `--cold`). */
  cold?: { metric: Metric; kit: string };
}

/**
 * Runs the kit's bench and writes its rows. Warm: B01 (online and offline p95), B06 (the slowest
 * start against 2 s) and B07 (shim to claim p95). Cold: one first-run file for the metric, labelled
 * "first run, not after reboot" unless the caller labels it otherwise.
 */
export async function startRows(ctx: Context, options: StartOptions): Promise<RowResult[]> {
  const q = await quiet(ctx.quietMs);
  const work = join(ctx.work, `bench-${ctx.label || "x"}-${String(Date.now())}`);
  const bench = await runBench({
    work,
    runs: options.runs,
    kit: options.cold?.kit ?? ctx.js,
    ...(options.cold === undefined ? {} : { cold: true, metric: options.cold.metric }),
  });
  removeRunUserDir(join(work, "state"));
  const ms = (s: Stats | undefined) => s ?? { runs: 0, median: 0, p95: 0, max: 0 };
  if (options.cold !== undefined) {
    const s = ms(bench[options.cold.metric]);
    const result: RowResult = {
      row: `first-${options.cold.metric}`,
      title: `One ${options.cold.metric} run from a kit copy this process has not loaded`,
      threshold:
        options.cold.metric === "shim_claim"
          ? "B07 <= 300 ms"
          : `B01 <= ${String(START_LIMIT)} ms (reported apart), B06 <= 2000 ms`,
      judged: false,
      pass: null,
      conditions: [condition("after_reboot", "true", false, false)],
      metrics: { ms: s.max },
    };
    report(ctx, result, { quiet: q, kind: "first run, not after reboot" });
    return [result];
  }
  const online = ms(bench.forwarder_online);
  const offline = ms(bench.forwarder_offline);
  const claim = ms(bench.shim_claim);
  const runs = (s: Stats) => condition("runs", ">= 20", s.runs, s.runs >= 20);
  const b01: RowResult = {
    row: "B01",
    title: "Forwarder spawn to the first byte of the initialize reply, service running and stopped",
    threshold: `p95 <= ${String(START_LIMIT)} ms (${process.platform})`,
    ...verdict(
      [runs(online), runs(offline)],
      () => online.p95 <= START_LIMIT && offline.p95 <= START_LIMIT,
    ),
    metrics: { onlineMs: online, offlineMs: offline },
  };
  const slowest = Math.max(online.max, offline.max);
  const b06: RowResult = {
    row: "B06",
    title:
      "Bridge start against Codex's 10 s startup_timeout_sec (warm runs; cold after reboot apart)",
    threshold: "<= 2000 ms",
    ...verdict([runs(online), runs(offline)], () => slowest <= 2000),
    metrics: { slowestStartMs: slowest },
  };
  const b07: RowResult = {
    row: "B07",
    title: "Shim spawn to its claim",
    threshold: "p95 <= 300 ms",
    ...verdict([runs(claim)], () => claim.p95 <= 300),
    metrics: { claimMs: claim },
  };
  for (const r of [b01, b06, b07]) report(ctx, r, { quiet: q });
  return [b01, b06, b07];
}

// ---------------------------------------------------------------------------------------------
// Entry

export type RowName = "B01" | "B02" | "B03" | "B04";

export async function runBridgeBench(
  rows: readonly RowName[],
  options: BridgeBenchOptions,
  start: StartOptions = { runs: 20 },
): Promise<RowResult[]> {
  mkdirSync(options.work, { recursive: true });
  const js =
    options.kit === undefined
      ? buildKit(join(options.work, "kit-js"))
      : realpathSync.native(checkBuiltKit(options.kit));
  const hooks = options.hooks ?? {};
  const ctx: Context = {
    js,
    work: options.work,
    out: options.out,
    label: options.label ?? "",
    role: options.role ?? "unknown",
    quietMs: options.quietMs ?? 3_000,
    write: true,
    hooks,
    readMemory: hooks.readMemory ?? readMemory,
    connectDirect: hooks.connectDirect ?? connect,
    bridge: { js, nodeArgs: options.nodeArgs ?? [], env: options.bridgeEnv ?? {}, hooks },
  };
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new KitError("usage", "--repeat is a whole number of runs, at least 1.");
  }
  const results: RowResult[] = [];
  for (const row of rows) {
    if (row === "B01") {
      // A2's 20 runs per metric are the 20 starts of one set: B01, B06 and B07 run once.
      results.push(...(await startRows(ctx, start)));
      continue;
    }
    const once = async (c: Context): Promise<RowResult[]> => {
      if (row === "B02") return [await rowB02(c, options.calls ?? 10, options.idleMs ?? 60_000)];
      if (row === "B03") return rowB03B05(c, options.bridges ?? 10, options.bridgeCalls ?? 100);
      return [await rowB04(c, options.directCalls ?? 500)];
    };
    results.push(...(repeat === 1 ? await once(ctx) : await repeated(ctx, repeat, once)));
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Repeated rows (A2 3.7.7: 20 runs per metric, median and p95)

/** Nearest-rank median and p95 of each value across runs, with the bounds applied. */
export interface Across {
  values: number[];
  median: number;
  p95: number;
  min: number;
  max: number;
  bound: Bound | null;
  pass: boolean | null;
}

export function across(values: number[], bound: Bound | null): Across {
  // A value a run could not read (NaN) is kept in `values` and left out of the numbers.
  const finite = values.filter(Number.isFinite);
  const s = summarize(finite);
  const sorted = [...finite].sort((a, b) => a - b);
  const judged = bound === null ? null : bound.across === "p95" ? s.p95 : s.max;
  return {
    values,
    median: s.p50,
    p95: s.p95,
    min: sorted[0] ?? 0,
    max: s.max,
    bound,
    pass: bound === null || judged === null ? null : judged <= bound.limit,
  };
}

/**
 * Runs a row `n` times with fresh state folders and writes one file per row: every run's values,
 * their median and p95 across runs, and a verdict from the p95 across runs against each bound
 * ("every" bounds, such as no handshake failure, hold in every run). Judged only when every run
 * met the row's counts and there are at least 20 runs.
 */
export async function repeated(
  ctx: Context,
  n: number,
  once: (ctx: Context) => Promise<RowResult[]>,
): Promise<RowResult[]> {
  const startedAt = new Date().toISOString();
  const runs: RowResult[][] = [];
  for (let i = 0; i < n; i++) {
    runs.push(await once({ ...ctx, label: `${ctx.label || "x"}-${String(i + 1)}`, write: false }));
  }
  const rows = runs[0]?.map((r) => r.row) ?? [];
  return rows.map((row) => {
    const results = runs
      .map((run) => run.find((r) => r.row === row))
      .filter((r) => r !== undefined);
    const first = results[0];
    if (first === undefined) throw new KitError("no_runs");
    const bounds = first.bounds ?? {};
    const names = Object.keys(first.values ?? {});
    const stats: Record<string, Across> = {};
    for (const name of names) {
      stats[name] = across(
        results.map((r) => r.values?.[name] ?? Number.NaN),
        bounds[name] ?? null,
      );
    }
    const counted = results.every((r) => r.judged);
    const result: RowResult = {
      row,
      title: first.title,
      threshold: first.threshold,
      ...verdict(
        [
          condition("runs", ">= 20", results.length, results.length >= 20),
          condition("every_run_met_its_counts", "true", counted, counted),
        ],
        () => Object.values(stats).every((s) => s.pass !== false),
      ),
      metrics: {
        method:
          "Nearest-rank median and p95 across runs of each run's value. A bound marked p95 is " +
          "judged on the p95 across runs, a bound marked every on every run.",
        across: stats,
        runs: results.map((r) => ({ quiet: r.quiet, metrics: r.metrics })),
      },
    };
    const busy = results.map((r) => r.quiet?.busyPercent ?? 0);
    report(ctx, result, {
      repeat: n,
      quietBusyPercent: { min: Math.min(...busy), max: Math.max(...busy) },
      startedAt,
    });
    return result;
  });
}
