// The M0.07 lab harness: rows S04, S06, S07, S08, S09, S12 and E01 of A7 3.7, one command each.
// It runs from a built copy (`buildLab`, `<out>/lifecycle/lab.mjs`) on the packaged Node of the
// machine, and drives the kit's .mjs files or an installed lab release (`make-release.ts`).
//
//   node lab.mjs s06 --kit <kit dir> --work <dir> --out <file>
//   node lab.mjs s07 --kit <kit dir> --work <dir> --out <file> [--port 7713]
//   node lab.mjs s08 --root <install root> --old <v> --new <v> --out <file>
//   node lab.mjs s04 --root <install root> --work <dir> --out <file> [--terminal]   (Windows)
//   node lab.mjs s09 --daily <install root> --test <install root> --out <file>       (Linux)
//   node lab.mjs e01 --root <install root> --out <file> [--tool <chat tool>] [--start direct]
//   node lab.mjs accounts --kit <kit dir> --out <file>
// Pre-test helpers (the rows are lab session 3's work with the product install, A7 3.7):
//   node lab.mjs s01 --root <root> --unit <name> --state <dir> --out <file> [--terminal <exe>] [--transient]
//   node lab.mjs s03-crash --root <root> --out <file> [--kills 5] [--start explorer|direct]
//
// A result file holds numbers, yes or no answers, exit codes, version labels and tool names. Never
// user or account names, host names, UIDs, SIDs, paths, environment values or folder listings.
// Every process a command starts is stopped before it returns, also when it fails.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { release, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { otherAccounts } from "../kit/accounts.ts";
import { E01_TOOLS, resolveTool, snapshotDifferences } from "../kit/snapshot.ts";
import {
  LineReader,
  RpcClient,
  clientInfo,
  connect,
  option,
  parseObject,
  readKey,
  readServiceInfo,
  sha256Hex,
  verifyListener,
  type Json,
  type JsonObject,
  type ServiceInfo,
} from "../kit/wire.ts";

const WIN = process.platform === "win32";
const NODE = process.execPath;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();
const round = (n: number) => Math.round(n * 10) / 10;
const text = (value: Json | undefined): string => (typeof value === "string" ? value : "");

type Result = Record<string, Json>;

// ------------------------------------------------------------------------------------------
// Processes

interface Proc {
  child: ChildProcess;
  pid: number;
  out: () => string;
  exit: Promise<{ code: number | null; signal: string | null }>;
  exited: () => boolean;
}

/** Every process this command started and has not seen exit. Stopped in `finally`. */
const owned = new Set<Proc>();

function start(
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: boolean; detached?: boolean; cwd?: string } = {},
): Proc {
  const child = spawn(file, args, {
    stdio: [options.stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    detached: options.detached === true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (child.pid === undefined) throw new Error(`could not start ${basename(file)}`);
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  child.stderr?.on("data", () => undefined);
  let done = false;
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      done = true;
      resolve({ code, signal });
    });
    child.once("error", () => {
      done = true;
      resolve({ code: null, signal: null });
    });
  });
  const proc: Proc = { child, pid: child.pid, out: () => text, exit, exited: () => done };
  owned.add(proc);
  void exit.then(() => owned.delete(proc));
  return proc;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILL on Unix, TerminateProcess on Windows (Node's `kill` with SIGKILL). */
function hardKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitFor<T>(
  probe: () => T | undefined | false,
  ms: number,
  what: string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(50);
  return !alive(pid);
}

async function stopOwned(): Promise<void> {
  for (const proc of [...owned]) {
    proc.child.stdin?.end();
    hardKill(proc.pid);
    await Promise.race([proc.exit, sleep(5000)]);
  }
}

/** "ready" when the kit service printed its ready line, else the exit code. */
async function readyOrExit(proc: Proc, ms: number): Promise<"ready" | number | null | "timeout"> {
  const end = Date.now() + ms;
  for (;;) {
    if (/"ready": true/.test(proc.out())) return "ready";
    if (proc.exited()) return (await proc.exit).code;
    if (Date.now() > end) return "timeout";
    await sleep(20);
  }
}

/** Starts a kit service with `command` and waits until it is ready. */
async function startService(
  command: readonly string[],
  state: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ proc: Proc; info: ServiceInfo; ms: number }> {
  const [file, ...args] = command;
  if (file === undefined) throw new Error("no command");
  const t0 = now();
  const proc = start(file, args, options);
  const outcome = await readyOrExit(proc, 30_000);
  if (outcome !== "ready") throw new Error(`the service did not start: ${String(outcome)}`);
  return { proc, info: readServiceInfo(state), ms: round(now() - t0) };
}

async function rpc(state: string, method: string, params: JsonObject = {}): Promise<Json> {
  const client = new RpcClient(
    await connect(state, { mode: "rpc", client: clientInfo("cli"), context: {} }),
  );
  try {
    return await client.call(method, params);
  } finally {
    client.close();
  }
}

async function shutdown(state: string, proc: Proc | undefined): Promise<void> {
  try {
    await rpc(state, "service/shutdown");
  } catch {
    // Already down.
  }
  if (proc !== undefined) await Promise.race([proc.exit, sleep(10_000)]);
}

function events(state: string): JsonObject[] {
  const file = join(state, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      const msg = parseObject(line);
      return msg === undefined ? [] : [msg];
    });
}

function save(out: string, result: Result): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const header = (row: string): Result => ({
  row,
  date: new Date().toISOString().slice(0, 10),
  os: `${process.platform} ${release()}`,
  node: process.version,
});

/** A Windows PowerShell 5.1 command with an environment built from scratch (as perms.ts does). */
function windowsPowerShell(script: string): { ok: boolean; stdout: string } {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "USERPROFILE"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const result = spawnSync(
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", script],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 60_000, env },
  );
  return { ok: result.status === 0 && result.error === undefined, stdout: result.stdout };
}

interface WinProcess {
  pid: number;
  ppid: number;
  exe: string;
}

/** node.exe, ttasks.exe and ttasksw.exe processes with their parent and image (kept in memory). */
function windowsProcesses(): WinProcess[] {
  const r = windowsPowerShell(
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='ttasks.exe' or Name='ttasksw.exe' or Name='WindowsTerminal.exe' or Name='OpenConsole.exe'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath }",
  );
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [pid, ppid, exe] = l.split("|");
      return { pid: Number(pid), ppid: Number(ppid), exe: exe ?? "" };
    });
}

/** The process image of `pid`: Linux /proc, Windows CIM. */
function imageOf(pid: number, list?: WinProcess[]): string | undefined {
  if (!WIN) {
    try {
      return readlinkSync(`/proc/${String(pid)}/exe`);
    } catch {
      return undefined;
    }
  }
  return (list ?? windowsProcesses()).find((p) => p.pid === pid)?.exe;
}

/** Node, ttasks.exe and ttasksw.exe processes whose image is under `root`, except this harness. */
function underRoot(root: string): WinProcess[] {
  const prefix = `${root.toLowerCase().replace(/[\\/]+$/, "")}\\`;
  return windowsProcesses().filter(
    (p) => p.pid !== process.pid && p.exe.toLowerCase().startsWith(prefix),
  );
}

/**
 * Stops a service tree this command started through Explorer (Windows), which is not its child:
 * a shutdown call, up to 15 s for the supervisor and ttasksw.exe to end after the service's clean
 * exit, then the supervisor stand-in (a node.exe under ttasksw.exe) first so it cannot restart the
 * service, ttasksw.exe, and the rest, by PID. Only processes whose image is under `root`.
 */
async function stopUnderRoot(
  root: string,
  state: string,
): Promise<{ after_15s: number; after_cleanup: number }> {
  if (existsSync(join(state, "service.json"))) {
    await Promise.race([rpc(state, "service/shutdown").catch(() => undefined), sleep(10_000)]);
  }
  let left = underRoot(root);
  const graceful = Date.now() + 15_000;
  while (left.length > 0 && Date.now() < graceful) {
    await sleep(500);
    left = underRoot(root);
  }
  const after15 = left.length;
  for (let round = 0; round < 3 && left.length > 0; round++) {
    const launchers = new Set(left.filter((p) => /ttasksw\.exe$/i.test(p.exe)).map((p) => p.pid));
    const supervisors = left.filter((p) => launchers.has(p.ppid));
    for (const p of [...supervisors, ...left.filter((q) => launchers.has(q.pid)), ...left]) {
      hardKill(p.pid);
    }
    const end = Date.now() + 5_000;
    do {
      await sleep(250);
      left = underRoot(root);
    } while (left.length > 0 && Date.now() < end);
  }
  if (left.length > 0) {
    process.stderr.write(
      `lab: still running from the install: PIDs ${left.map((p) => p.pid).join(", ")}\n`,
    );
  }
  return { after_15s: after15, after_cleanup: left.length };
}

/** Starts `bin\ttasksw.exe` with no arguments: through Explorer as the Run value does, or directly. */
function startSupervisor(root: string, how: string): string {
  const ttasksw = join(root, "bin", "ttasksw.exe");
  if (how === "direct") {
    const child = spawn(ttasksw, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return "bin\\ttasksw.exe started directly (no arguments), the lab supervisor";
  }
  spawnSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "explorer.exe"), [ttasksw], {
    windowsHide: true,
    shell: false,
    timeout: 30_000,
  });
  return "explorer.exe bin\\ttasksw.exe (no arguments), the lab supervisor";
}

/** The version label in `<root>/versions/<label>/...`, never the path. */
function versionLabel(image: string | undefined): string | null {
  if (image === undefined) return null;
  const m = /[\\/]versions[\\/]([^\\/]+)[\\/]/.exec(image);
  return m?.[1] ?? "outside versions";
}

// ------------------------------------------------------------------------------------------
// The MCP client side of a bridge

class Bridge {
  readonly proc: Proc;
  #next = 1;
  readonly #pending = new Map<number, (msg: JsonObject) => void>();

  constructor(command: readonly string[]) {
    const [file, ...args] = command;
    if (file === undefined) throw new Error("no command");
    this.proc = start(file, args, { stdin: true });
    const stdout = this.proc.child.stdout;
    if (stdout === null) throw new Error("no stdout");
    new LineReader(stdout).pipe((line) => {
      const msg = parseObject(line);
      const id = msg?.["id"];
      if (msg === undefined || typeof id !== "number") return;
      this.#pending.get(id)?.(msg);
      this.#pending.delete(id);
    });
  }

  request(method: string, params: JsonObject = {}, ms = 15_000): Promise<JsonObject> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`no reply to ${method}`));
      }, ms);
      this.#pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  initialize(): Promise<JsonObject> {
    return this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ttasks-lab-m0.07", version: "1" },
    });
  }

  /** One `status` call: online with the service instance, or the kind of offline answer. */
  async status(): Promise<{
    kind: "online" | "offline" | "connection_lost" | "other";
    instance?: string;
  }> {
    let reply: JsonObject;
    try {
      reply = await this.request("tools/call", { name: "status", arguments: {} }, 15_000);
    } catch {
      return { kind: "other" };
    }
    const result = reply["result"] as JsonObject | undefined;
    const content = result?.["content"] as JsonObject[] | undefined;
    const text = typeof content?.[0]?.["text"] === "string" ? content[0]["text"] : "";
    const parsed = parseObject(text);
    if (parsed?.["service"] === "stand-in" && typeof parsed["instance"] === "string") {
      return { kind: "online", instance: parsed["instance"] };
    }
    if (result?.["isError"] === true && /not running/.test(text)) return { kind: "offline" };
    if (result?.["isError"] === true) return { kind: "connection_lost" };
    return { kind: "other" };
  }

  async close(): Promise<number | null> {
    this.proc.child.stdin?.end();
    const exit = await Promise.race([this.proc.exit, sleep(10_000).then(() => undefined)]);
    if (exit === undefined) hardKill(this.proc.pid);
    return exit?.code ?? null;
  }
}

// ------------------------------------------------------------------------------------------
// S06: 10 simultaneous starts, stale lock after a hard kill (A2 3.4)

async function s06(args: string[]): Promise<Result> {
  const kit = need(args, "--kit");
  const work = need(args, "--work");
  const count = Number(option(args, "--count") ?? "10");
  const cycles = Number(option(args, "--cycles") ?? "3");
  const kitMjs = join(kit, "kit.mjs");
  const result = header("S06");
  result["count"] = count;

  const race = async (state: string) => {
    const t0 = now();
    const procs = Array.from({ length: count }, () =>
      start(NODE, [kitMjs, "service", "--state", state]),
    );
    const outcomes = await Promise.all(procs.map((p) => readyOrExit(p, 60_000)));
    const ms = round(now() - t0);
    const ready = procs.filter((_p, i) => outcomes[i] === "ready");
    const codes: Record<string, number> = {};
    for (const o of outcomes) {
      if (o === "ready") continue;
      const key = String(o);
      codes[key] = (codes[key] ?? 0) + 1;
    }
    return { procs, ready, summary: { ready: ready.length, exits: codes, all_settled_ms: ms } };
  };

  // The row: a state folder that already exists (made by one start and a clean stop first).
  const state = join(work, "s06-state");
  const first = await startService([NODE, kitMjs, "service", "--state", state], state);
  await shutdown(state, first.proc);
  const main = await race(state);
  result["existing_folder"] = main.summary;

  // Stale lock after a hard kill, then a clean restart, `cycles` times.
  let holder = main.ready[0];
  const kills: Json[] = [];
  for (let i = 0; i < cycles && holder !== undefined; i++) {
    const before = readServiceInfo(state);
    hardKill(holder.pid);
    const ended = await holder.exit;
    const stale: JsonObject = {
      killed_exit_code: ended.code,
      killed_signal: ended.signal,
      service_json_left: existsSync(join(state, "service.json")),
      socket_file_left: before.endpoint.kind === "unix" ? existsSync(before.endpoint.path) : null,
      lock_file_left: existsSync(join(state, "service.lock")),
    };
    const t0 = now();
    const next = start(NODE, [kitMjs, "service", "--state", state]);
    const outcome = await readyOrExit(next, 30_000);
    stale["restart"] = outcome === "ready" ? "ready" : String(outcome);
    stale["restart_ms"] = round(now() - t0);
    if (outcome === "ready") {
      const status = (await rpc(state, "service/status")) as JsonObject;
      stale["new_instance"] = status["instance"] !== before.instance;
      stale["call_after_restart"] = typeof status["pid"] === "number";
    }
    kills.push(stale);
    holder = outcome === "ready" ? next : undefined;
  }
  result["hard_kill"] = WIN ? "TerminateProcess (process.kill SIGKILL)" : "SIGKILL";
  result["kill_cycles"] = kills;
  await shutdown(state, holder);

  // Extra: the same race on a state folder that does not exist yet (first-start race).
  const fresh = await race(join(work, "s06-fresh"));
  result["fresh_folder"] = fresh.summary;
  const freshReady = fresh.ready[0];
  if (freshReady !== undefined) await shutdown(join(work, "s06-fresh"), freshReady);
  return result;
}

// ------------------------------------------------------------------------------------------
// S07: port 7713 held by this user, the squatter, the port-owner query (A2 3.8.2, A6 M0-6)

const HOLDER =
  "const s=require('net').createServer(()=>{});s.listen(Number(process.argv[1]),'127.0.0.1',()=>process.stdout.write('listening\\n'))";

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Who owns the listener on `port`, by the OS's own query, without admin rights: whether each query
 * ran and names `expected`, the process that holds the port. PIDs are not recorded.
 */
function portOwner(port: number, expected: number): JsonObject {
  if (WIN) {
    const query = windowsPowerShell(
      `$c = Get-NetTCPConnection -LocalPort ${String(port)} -State Listen -ErrorAction Stop | Select-Object -First 1; ` +
        "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
        "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); " +
        "$sid = (Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid; " +
        "'{0}|{1}' -f $c.OwningProcess, ($sid -eq $me)",
    );
    const [pid, same] = query.stdout.trim().split("|");
    const netstat = spawnSync(
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "netstat.exe"),
      ["-ano", "-p", "TCP"],
      { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 },
    );
    const row = netstat.stdout
      .split(/\r?\n/)
      .find((l) => l.includes(`127.0.0.1:${String(port)} `) && /LISTENING/.test(l));
    return {
      get_net_tcp_connection: {
        ran: query.ok,
        names_holder: query.ok ? Number(pid) === expected : null,
        owner_is_me: same === "True",
      },
      netstat_ano: {
        ran: netstat.status === 0,
        names_holder:
          row === undefined ? null : Number(row.trim().split(/\s+/).at(-1)) === expected,
      },
    };
  }
  const ss = spawnSync("ss", ["-ltnpH", `sport = :${String(port)}`], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  const pid = /pid=(\d+)/.exec(ss.stdout)?.[1];
  let uidMatches: boolean | null;
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    const row = readFileSync("/proc/net/tcp", "utf8")
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .find((c) => c[1]?.endsWith(`:${hex}`) === true && c[3] === "0A");
    uidMatches = row === undefined ? null : Number(row[7]) === process.getuid?.();
  } catch {
    uidMatches = null;
  }
  return {
    ss_ltnp: {
      ran: ss.status === 0,
      names_holder: pid === undefined ? null : Number(pid) === expected,
    },
    proc_net_tcp: { listener_uid_is_mine: uidMatches },
  };
}

/** Windows: whether `port` lies in an excluded port range (read only). */
function excludedRange(port: number): boolean | null {
  const r = spawnSync(
    join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "netsh.exe"),
    ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 },
  );
  if (r.status !== 0) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m !== null && Number(m[1]) <= port && port <= Number(m[2])) return true;
  }
  return false;
}

/** Windows: firewall rules whose program lies under `dir`, counted (read only). */
function firewallRulesUnder(dir: string): number | null {
  const r = windowsPowerShell(
    `(Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object { $_.Program -like '${dir.replaceAll("'", "''")}*' } | Measure-Object).Count`,
  );
  return r.ok ? Number(r.stdout.trim()) : null;
}

async function s07(args: string[]): Promise<Result> {
  const kit = need(args, "--kit");
  const work = need(args, "--work");
  const port = Number(option(args, "--port") ?? "7713");
  const kitMjs = join(kit, "kit.mjs");
  const result = header("S07");
  result["port"] = port;
  result["port_free_before"] = await canBind(port);
  if (WIN) {
    result["port_in_excluded_range"] = excludedRange(port);
    result["firewall_rules_for_scratch_before"] = firewallRulesUnder(dirname(dirname(NODE)));
  }

  // Another process of this user holds the port before the service starts.
  const holder = start(NODE, ["-e", HOLDER, String(port)]);
  await waitFor(() => holder.out().includes("listening"), 10_000, "the port holder");
  result["owner_query_holder"] = portOwner(port, holder.pid);

  const state = join(work, "s07-state");
  const svc = await startService(
    [NODE, kitMjs, "service", "--state", state, "--port", String(port)],
    state,
  );
  result["service"] = {
    moved: svc.info.http.moved,
    port_differs: svc.info.http.port !== port,
  };
  const open = spawnSync(NODE, [kitMjs, "open", "--state", state], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
  });
  result["kit_open"] = {
    exit: open.status,
    url_on_moved_port: open.stdout.startsWith(`http://127.0.0.1:${String(svc.info.http.port)}/#k=`),
  };
  const key = readKey(state);
  const t0 = now();
  const real = await verifyListener(svc.info.http.port, key, svc.info.instance);
  result["probe_real_service"] = { accepted: real, ms: round(now() - t0) };
  const t1 = now();
  const silent = await verifyListener(port, key, svc.info.instance);
  result["probe_silent_squatter"] = { accepted: silent, ms: round(now() - t1) };

  const fake = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"proof":"not-tasks"}');
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const fakePort = (fake.address() as net.AddressInfo).port;
  const t2 = now();
  const wrong = await verifyListener(fakePort, key, svc.info.instance);
  result["probe_answering_squatter"] = { accepted: wrong, ms: round(now() - t2) };
  await new Promise((resolve) => fake.close(resolve));

  result["owner_query_service"] = portOwner(svc.info.http.port, svc.info.pid);
  result["other_user_case"] = "not applicable here: CI only (A7 3.7, A2 5)";

  await shutdown(state, svc.proc);
  hardKill(holder.pid);
  await holder.exit;
  if (WIN) result["firewall_rules_for_scratch_after"] = firewallRulesUnder(dirname(dirname(NODE)));
  result["port_free_after"] = await canBind(port);
  return result;
}

// ------------------------------------------------------------------------------------------
// S08: switch `current` under a running bridge, the launcher swap, the bridge reconnects

function readCurrent(root: string): string {
  return WIN
    ? readFileSync(join(root, "current"), "utf8")
    : basename(readlinkSync(join(root, "current")));
}

/** Points `current` at `version`: a text file replaced by rename (Windows), a symlink (Unix). */
function switchCurrent(root: string, version: string): boolean {
  const target = join(root, "current");
  const tmp = `${target}.tmp-lab`;
  try {
    if (WIN) writeFileSync(tmp, version);
    else symlinkSync(`versions/${version}`, tmp);
    renameSync(tmp, target);
    return readCurrent(root) === version;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/** Runs `launcher --replace <new> <target>`: its exit code and the Windows error number. */
function replace(launcher: string, from: string, to: string): JsonObject {
  const r = spawnSync(launcher, ["--replace", from, to], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
  });
  const error = /\(error (\d+)\)/.exec(r.stderr)?.[1];
  return { exit: r.status, windows_error: error === undefined ? null : Number(error) };
}

function tryRename(from: string, to: string): JsonObject {
  try {
    renameSync(from, to);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code ?? "error" };
  }
}

function tryDelete(file: string): JsonObject {
  try {
    unlinkSync(file);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code ?? "error" };
  }
}

/** The Node process behind a launcher: Windows `ttasks.exe`'s child, Linux the same PID (exec). */
function nodeBehind(launcherPid: number, list?: WinProcess[]): number | undefined {
  if (!WIN) return launcherPid;
  return (list ?? windowsProcesses()).find(
    (p) => p.ppid === launcherPid && /node\.exe$/i.test(p.exe),
  )?.pid;
}

/** Polls the bridge until it answers online from `instance`. */
async function untilOnline(bridge: Bridge, instance: string, ms: number) {
  const t0 = now();
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const answer = await bridge.status();
    if (answer.kind === "online" && answer.instance === instance) {
      return { reconnected: true, ms: round(now() - t0), answers_before: seen };
    }
    seen.push(answer.kind === "online" ? "online_old_instance" : answer.kind);
    await sleep(250);
  }
  return { reconnected: false, ms: round(now() - t0), answers_before: seen };
}

async function s08(args: string[]): Promise<Result> {
  const root = need(args, "--root");
  const oldV = need(args, "--old");
  const newV = need(args, "--new");
  const result = header("S08");
  const bin = join(root, "bin");
  const tasks = join(bin, WIN ? "ttasks.exe" : "ttasks");
  const ttasksw = WIN ? join(bin, "ttasksw.exe") : tasks;
  const state = join(root, "state", "s08");
  if (readCurrent(root) !== oldV) throw new Error("current must name the old version first");
  result["versions"] = { old: oldV, new: newV };
  result["service_launcher"] = WIN ? "bin\\ttasksw.exe" : "bin/ttasks";
  result["bridge_launcher"] = WIN
    ? "bin\\ttasks.exe mcp --reconnect"
    : "bin/ttasks mcp --reconnect";

  const steps: Record<string, Json> = {};
  result["steps"] = steps;
  let svc = await startService([ttasksw, "service", "--state", state], state);
  steps["1_service_old"] = { version: versionLabel(imageOf(svc.info.pid)) };

  const bridge = new Bridge([tasks, "mcp", "--state", state, "--reconnect"]);
  try {
    const init = await bridge.initialize();
    const first = await bridge.status();
    const bridgeNode = nodeBehind(bridge.proc.pid);
    const bridgeVersion = () =>
      versionLabel(bridgeNode === undefined ? undefined : imageOf(bridgeNode));
    steps["2_bridge"] = {
      initialized: init["result"] !== undefined,
      online: first.kind === "online" && first.instance === svc.info.instance,
      version: bridgeVersion(),
    };

    steps["3_switch_current"] = {
      switched: switchCurrent(root, newV),
      bridge_still_online: (await bridge.status()).kind === "online",
    };

    if (WIN) {
      const newBin = join(root, "versions", newV, "bin");
      const swap: Record<string, Json> = {};
      for (const name of ["ttasks.exe", "ttasksw.exe"]) {
        copyFileSync(join(newBin, name), join(bin, `${name}.new`));
        swap[`replace_running_${name}`] = replace(
          join(newBin, "ttasks.exe"),
          join(bin, `${name}.new`),
          join(bin, name),
        );
      }
      // Control: the same call against a copy that is not running.
      copyFileSync(join(newBin, "ttasks.exe"), join(bin, "control.exe"));
      copyFileSync(join(newBin, "ttasks.exe"), join(bin, "control.exe.new"));
      swap["replace_idle_copy"] = replace(
        join(newBin, "ttasks.exe"),
        join(bin, "control.exe.new"),
        join(bin, "control.exe"),
      );
      rmSync(join(bin, "control.exe"), { force: true });
      rmSync(join(bin, "control.exe.new"), { force: true });
      // The two-rename path of A2 3.12.6 step 10, one launcher at a time.
      for (const name of ["ttasks.exe", "ttasksw.exe"]) {
        swap[`rename_running_${name}_aside`] = tryRename(
          join(bin, name),
          join(bin, `${name}.old-1`),
        );
        swap[`rename_new_${name}_in`] = tryRename(join(bin, `${name}.new`), join(bin, name));
      }
      swap["delete_running_old_launcher"] = tryDelete(join(bin, "ttasks.exe.old-1"));
      // A2 3.12.6 step 14's old in-use test, a refused rename, on a folder that is in use. It is
      // an observation only: A2 3.12.6 retires versions under leases, never by such a probe.
      const gc = tryRename(join(root, "versions", oldV), join(root, "versions", `${oldV}.gc-test`));
      if (gc["ok"] === true)
        renameSync(join(root, "versions", `${oldV}.gc-test`), join(root, "versions", oldV));
      swap["rename_old_version_folder_in_use"] = gc;
      swap["bridge_still_online"] = (await bridge.status()).kind === "online";
      steps["4_launchers"] = swap;
    }

    // Restart the service from the new version; the old bridge reconnects.
    await shutdown(state, svc.proc);
    const during = await bridge.status();
    svc = await startService([ttasksw, "service", "--state", state], state);
    const back = await untilOnline(bridge, svc.info.instance, 60_000);
    steps["5_restart_new"] = {
      service_version: versionLabel(imageOf(svc.info.pid)),
      first_answer_while_down: during.kind,
      ...back,
      bridge_version: bridgeVersion(),
    };

    // Rollback: current back to the old version, launchers back, restart, reconnect again.
    const rollback: Record<string, Json> = { switched: switchCurrent(root, oldV) };
    if (WIN) {
      for (const name of ["ttasks.exe", "ttasksw.exe"]) {
        rollback[`rename_${name}_aside`] = tryRename(join(bin, name), join(bin, `${name}.old-2`));
        rollback[`rename_${name}_back`] = tryRename(join(bin, `${name}.old-1`), join(bin, name));
      }
    }
    await shutdown(state, svc.proc);
    svc = await startService([ttasksw, "service", "--state", state], state);
    const again = await untilOnline(bridge, svc.info.instance, 60_000);
    steps["6_rollback"] = {
      ...rollback,
      service_version: versionLabel(imageOf(svc.info.pid)),
      ...again,
      bridge_version: bridgeVersion(),
    };
  } finally {
    steps["7_bridge_exit_code"] = await bridge.close();
    await shutdown(state, svc.proc);
  }
  if (WIN) {
    for (const name of ["ttasks.exe", "ttasksw.exe"]) {
      steps[`8_delete_${name}.old-2`] = tryDelete(join(bin, `${name}.old-2`));
    }
  }
  return result;
}

// ------------------------------------------------------------------------------------------
// S04: a Windows Terminal tab and a detached run survive killing the service (Windows)

const TAB_TITLE = "TTasks lab M0.07 (closes by itself)";

async function s04(args: string[]): Promise<Result> {
  if (!WIN) throw new Error("S04 is the Windows row");
  const root = need(args, "--root");
  const work = need(args, "--work");
  const terminal = args.includes("--terminal");
  const result = header("S04");
  const bin = join(root, "bin");
  const tasks = join(bin, "ttasks.exe");
  const ttasksw = join(bin, "ttasksw.exe");
  const state = join(root, "state", "s04");
  const cwd = join(work, "s04-folder");
  mkdirSync(cwd, { recursive: true });
  const folder = realpathSync.native(cwd);
  const version = readCurrent(root);
  const node = join(root, "versions", version, "runtime", "node.exe");
  const wt = resolveTool("wt", process.env as Record<string, string>, "win32");
  result["windows_terminal_installed"] = wt !== undefined;

  let svc = await startService([ttasksw, "service", "--state", state], state);
  const pids: Record<string, number | undefined> = {};
  try {
    // The run: a run ticket, then the run shim started detached by the service, through ttasks.exe.
    const agent = "setTimeout(() => process.exit(0), 45000)";
    const runTicket = (await rpc(state, "spike.mint_ticket", {
      argv: [node, "-e", agent],
      cwd: folder,
      run: true,
      title: "M-7 Lab run",
      brief: "Fixture brief for row S04.",
    })) as JsonObject;
    await rpc(state, "spike.spawn", {
      argv: [tasks, "run-shim", "--state", state, text(runTicket["ticket"])],
      detached: true,
      hidden: true,
    });
    const runTag = text(runTicket["run"]);
    const runClaim = await waitFor(
      () => events(state).find((e) => e["kind"] === "claim" && e["ticket"] === runTag),
      20_000,
      "the run claim",
    );
    pids["run_shim"] = runClaim["pid"] as number;
    const meta = join(state, "runs", runTag, "meta.json");
    pids["run_agent"] = await waitFor(
      () =>
        existsSync(meta)
          ? ((JSON.parse(readFileSync(meta, "utf8")) as JsonObject)["agent_pid"] as number)
          : undefined,
      20_000,
      "the run's meta.json",
    );

    // The control: a child the service starts without `detached`.
    const control = (await rpc(state, "spike.spawn", {
      argv: [node, "-e", "setTimeout(() => {}, 120000)"],
      hidden: true,
    })) as JsonObject;
    pids["control"] = control["pid"] as number;

    // The terminal: a Windows Terminal tab running the interactive shim, closing by itself.
    if (terminal && wt !== undefined) {
      const tabAgent =
        "console.log('TTasks lab M0.07: fixture tab. It closes by itself within a minute.'); setTimeout(() => process.exit(0), 40000)";
      const tabTicket = (await rpc(state, "spike.mint_ticket", {
        argv: [node, "-e", tabAgent],
        cwd: folder,
        title: TAB_TITLE,
      })) as JsonObject;
      const tag = sha256Hex(text(tabTicket["ticket"])).slice(0, 12);
      await rpc(state, "spike.spawn", {
        argv: [
          wt,
          "-w",
          "new",
          "--title",
          TAB_TITLE,
          "-d",
          folder,
          tasks,
          "shim",
          "--state",
          state,
          text(tabTicket["ticket"]),
        ],
        detached: true,
      });
      const claim = await waitFor(
        () => events(state).find((e) => e["kind"] === "claim" && e["ticket"] === tag),
        30_000,
        "the tab's claim",
      );
      pids["tab_shim"] = claim["pid"] as number;
      const started = await waitFor(
        () => events(state).find((e) => e["kind"] === "launch.started"),
        20_000,
        "the tab's agent",
      );
      pids["tab_agent"] = started["pid"] as number;
    }
    await sleep(1000);
    const before = Object.fromEntries(
      Object.entries(pids).map(([k, p]) => [k, p !== undefined && alive(p)]),
    );

    // Kill the service hard (TerminateProcess), as a crash or `taskkill /F` would.
    hardKill(svc.info.pid);
    await Promise.race([svc.proc.exit, sleep(10_000)]);
    await sleep(2000);
    const after = Object.fromEntries(
      Object.entries(pids).map(([k, p]) => [k, p !== undefined && alive(p)]),
    );
    result["alive_before_kill"] = before;
    result["alive_2s_after_kill"] = after;

    // The next service: the run shim re-attaches.
    const attachesBefore = events(state).filter((e) => e["kind"] === "run.attach").length;
    svc = await startService([ttasksw, "service", "--state", state], state);
    const attached = await waitFor(
      () => events(state).filter((e) => e["kind"] === "run.attach").length > attachesBefore,
      15_000,
      "run.attach",
    ).catch(() => false);
    result["run_reattached"] = attached;
    const exited = await waitFor(
      () => events(state).some((e) => e["kind"] === "run.exited" && e["run"] === runTag),
      60_000,
      "run.exited",
    ).catch(() => false);
    result["run_exit_reported_to_new_service"] = exited;
    if (pids["tab_shim"] !== undefined) {
      result["tab_closed_by_itself"] = await waitGone(pids["tab_shim"], 60_000);
    }
  } finally {
    for (const pid of Object.values(pids)) if (pid !== undefined && alive(pid)) hardKill(pid);
    await shutdown(state, svc.proc);
  }
  return result;
}

// ------------------------------------------------------------------------------------------
// S09: a TTASKS_HOME test install beside a stand-in daily install (Linux, A2 M0-S14)

function installId(state: string): string {
  return sha256Hex(realpathSync.native(state)).slice(0, 16);
}

function systemdRun(unit: string, command: readonly string[]): number | null {
  const r = spawnSync(
    "systemd-run",
    ["--user", "--quiet", "--collect", `--unit=${unit}`, "-p", "KillMode=mixed", ...command],
    { encoding: "utf8", shell: false, timeout: 30_000 },
  );
  return r.status;
}

function stopUnit(unit: string): number | null {
  return spawnSync("systemctl", ["--user", "stop", `${unit}.service`], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  }).status;
}

/** A daily CLI call and a daily bridge call, both through the daily install's launcher. */
async function dailyCalls(daily: string, state: string, instance: string): Promise<JsonObject> {
  const launcher = join(daily, "bin", "ttasks");
  const cli = spawnSync(launcher, ["call", "--state", state, "service/status"], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  const status = parseObject(cli.stdout.replace(/\n/g, " "));
  const bridge = new Bridge([launcher, "mcp", "--state", state]);
  let online: boolean;
  try {
    await bridge.initialize();
    const answer = await bridge.status();
    online = answer.kind === "online" && answer.instance === instance;
  } finally {
    await bridge.close();
  }
  return {
    cli_ok: cli.status === 0 && status?.["instance"] === instance,
    bridge_ok: online,
  };
}

async function s09(args: string[]): Promise<Result> {
  if (WIN) throw new Error("S09 is the Linux row");
  const daily = need(args, "--daily");
  const test = need(args, "--test");
  const result = header("S09");
  const dailyState = join(daily, "state", "service");
  const testState = join(test, "state", "service");
  mkdirSync(dailyState, { recursive: true, mode: 0o700 });
  mkdirSync(testState, { recursive: true, mode: 0o700 });
  const dailyUnit = `ttasks-lab-${installId(dailyState)}`;
  const testUnit = `ttasks-lab-${installId(testState)}`;
  let testUp = false;
  let dailyUp = false;
  try {
    if (
      systemdRun(dailyUnit, [
        join(daily, "bin", "ttasks"),
        "service",
        "--state",
        dailyState,
        "--port",
        "7713",
      ]) !== 0
    ) {
      throw new Error("the daily unit did not start");
    }
    dailyUp = true;
    const d = await waitFor(
      () =>
        existsSync(join(dailyState, "service.json")) ? readServiceInfo(dailyState) : undefined,
      30_000,
      "the daily service",
    );
    const inode = () => statSync(d.endpoint.path).ino;
    const ino0 = inode();
    const points: Record<string, Json> = {};
    points["before_test_install"] = await dailyCalls(daily, dailyState, d.instance);

    // The test install, with TTASKS_HOME set the way its launcher sets it (home.marker).
    if (
      systemdRun(testUnit, [
        join(test, "bin", "ttasks"),
        "service",
        "--state",
        testState,
        "--port",
        "7714",
      ]) !== 0
    ) {
      throw new Error("the test unit did not start");
    }
    testUp = true;
    const t = await waitFor(
      () => (existsSync(join(testState, "service.json")) ? readServiceInfo(testState) : undefined),
      30_000,
      "the test service",
    );
    points["while_test_install_runs"] = await dailyCalls(daily, dailyState, d.instance);
    const testStatus = (await rpc(testState, "service/status")) as JsonObject;
    // The test install pointed at the daily state folder: the lock refuses it (A2 3.4).
    const intrude = spawnSync(join(test, "bin", "ttasks"), ["service", "--state", dailyState], {
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    });
    stopUnit(testUnit);
    testUp = false;
    await waitFor(
      () => !existsSync(join(testState, "service.json")),
      15_000,
      "the test service to stop",
    );
    points["after_test_install_stops"] = await dailyCalls(daily, dailyState, d.instance);
    const ino1 = inode();

    result["points"] = points;
    result["separation"] = {
      install_id_differs: d.install !== t.install,
      runtime_kind: { daily: d.runtime, test: t.runtime },
      runtime_folder_differs: dirname(d.endpoint.path) !== dirname(t.endpoint.path),
      socket_differs: d.endpoint.path !== t.endpoint.path,
      port_differs: d.http.port !== t.http.port,
      ports: { daily: d.http.port, test: t.http.port },
      unit_name_differs: dailyUnit !== testUnit,
      test_answers_as_itself: testStatus["instance"] === t.instance && t.instance !== d.instance,
    };
    result["daily_socket_kept_inode"] = ino0 === ino1;
    result["test_install_on_daily_state_exit"] = intrude.status;
    result["daily_spaces"] =
      "the spike has no spaces: the test install's service on the daily state folder exits 73 (service lock, A2 3.4); the space writer lock uses the same technique (S06)";
    result["launcher_sets_tasks_home"] = "both roots are install-script roots with home.marker";
  } finally {
    if (testUp) stopUnit(testUnit);
    if (dailyUp) stopUnit(dailyUnit);
  }
  return result;
}

// ------------------------------------------------------------------------------------------
// E01: the service's login-shell snapshot against a hand-opened shell

function compareShell(tools: readonly string[]): {
  ms: number;
  tools: Record<string, boolean>;
  ssh_agent: boolean;
  ran: boolean;
} {
  const t0 = now();
  let stdout = "";
  let ran = false;
  if (WIN) {
    const pwsh = resolveTool("pwsh", process.env as Record<string, string>, "win32");
    if (pwsh !== undefined) {
      const script =
        `foreach ($t in @(${tools.map((t) => `'${t}'`).join(",")})) { ` +
        "$c = Get-Command $t -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1; " +
        'if ($c) { "$t=1" } else { "$t=0" } }; ' +
        "if (Test-Path '\\\\.\\pipe\\openssh-ssh-agent') { 'ssh_agent=1' } else { 'ssh_agent=0' }";
      const r = spawnSync(pwsh, ["-NoLogo", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 60_000,
      });
      stdout = r.stdout;
      ran = r.status === 0;
    }
  } else {
    const script =
      `for t in ${tools.join(" ")}; do if command -v "$t" >/dev/null 2>&1; then echo "$t=1"; else echo "$t=0"; fi; done; ` +
      'if [ -S "$SSH_AUTH_SOCK" ]; then echo ssh_agent=1; else echo ssh_agent=0; fi';
    const r = spawnSync("bash", ["-lic", script], {
      encoding: "utf8",
      shell: false,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    stdout = r.stdout;
    ran = r.status === 0;
  }
  const found: Record<string, boolean> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9._-]+)=([01])$/.exec(line.trim());
    if (m?.[1] !== undefined) found[m[1]] = m[2] === "1";
  }
  const { ssh_agent: agent = false, ...rest } = found;
  return { ms: round(now() - t0), tools: rest, ssh_agent: agent, ran };
}

async function e01(args: string[]): Promise<Result> {
  const root = need(args, "--root");
  const extra = args.flatMap((a, i) => (args[i - 1] === "--tool" ? [a] : []));
  const tools = [...E01_TOOLS, ...extra];
  const result = header("E01");
  const state = join(root, "state", "service");
  let unit: string | undefined;
  let tree = false;
  try {
    if (WIN) {
      // The closest unattended parent to the Run value: Explorer starts ttasksw.exe with no
      // arguments, as `ttasks service start` does (A2 3.3.5). The lab entry then supervises.
      // `--start direct` (the self-test) starts it without Explorer. Owned from here on: the
      // finally below stops whatever runs from the install.
      tree = true;
      result["started_by"] = startSupervisor(root, option(args, "--start") ?? "explorer");
    } else {
      mkdirSync(state, { recursive: true, mode: 0o700 });
      unit = `ttasks-lab-${installId(state)}`;
      const code = systemdRun(unit, [join(root, "bin", "ttasks"), "service", "--state", state]);
      result["started_by"] = `systemd-run --user transient unit (exit ${String(code)})`;
    }
    const info = await waitFor(
      () => (existsSync(join(state, "service.json")) ? readServiceInfo(state) : undefined),
      30_000,
      "the service",
    );
    if (WIN) {
      const list = windowsProcesses();
      const parent = list.find((p) => p.pid === list.find((q) => q.pid === info.pid)?.ppid);
      const grand = list.find((p) => p.pid === parent?.ppid);
      result["service_parents"] = [parent, grand].map((p) =>
        p === undefined ? "gone or not node/tasks" : basename(p.exe),
      );
    }
    const snap = (await rpc(state, "spike.env_snapshot", { tools: extra })) as JsonObject;
    result["service_built"] = snap["built"] ?? null;
    result["service_inherited"] = snap["inherited"] ?? null;
    const hand = compareShell(tools);
    result["hand_shell"] = {
      how: WIN
        ? "a fresh pwsh -NoLogo -NonInteractive (profile loaded) from the agent's shell"
        : "bash -lic over SSH",
      ...hand,
    };
    // Every tool and the SSH agent whose found flag differs (the agent since the review of M0.07).
    result["differences"] = snapshotDifferences(
      tools,
      snap["built"] as Parameters<typeof snapshotDifferences>[1],
      hand,
    );
    await rpc(state, "service/shutdown");
    await waitFor(() => !existsSync(join(state, "service.json")), 15_000, "the service to stop");
  } finally {
    if (unit !== undefined) stopUnit(unit);
    if (tree) {
      // The supervisor and ttasksw.exe stop after the service's clean exit (code 0), and on a
      // failure they are stopped here. This harness may itself run on the install's node.exe, so
      // it is left out.
      const left = await stopUnderRoot(root, state);
      result["processes_left_after_15s"] = left.after_15s;
      result["processes_left_after_cleanup"] = left.after_cleanup;
    }
  }
  return result;
}

// ------------------------------------------------------------------------------------------
// Session 3 helpers. S01 (Linux): a terminal in a scope, a run in a transient unit and a control
// child without either, through a service restart and stop. S03 (Windows): the supervisor's
// restarts after a hard kill of the service and its give-up. Both rows are session work: these
// commands drive them, and a run outside the session only checks the helper.

function unitActive(unit: string): boolean {
  return (
    spawnSync("systemctl", ["--user", "is-active", "--quiet", `${unit}.service`], {
      shell: false,
      timeout: 10_000,
    }).status === 0
  );
}

function systemctl(verb: string, unit: string): number | null {
  return spawnSync("systemctl", ["--user", verb, unit], { shell: false, timeout: 60_000 }).status;
}

async function s01(args: string[]): Promise<Result> {
  if (WIN) throw new Error("S01 is the Linux row");
  const root = need(args, "--root");
  const unit = need(args, "--unit");
  const state = need(args, "--state");
  const transient = args.includes("--transient");
  const terminal = option(args, "--terminal");
  const result = header("S01");
  result["service_unit"] = transient ? "transient (helper check)" : "installed unit";
  result["terminal"] =
    terminal === undefined ? "none: the shim runs headless in its scope" : basename(terminal);
  const tasks = join(root, "bin", "ttasks");
  const node = join(realpathSync.native(join(root, "current")), "runtime", "node");
  const folder = join(root, "state", "s01-folder");
  mkdirSync(folder, { recursive: true });
  const tag = sha256Hex(String(Date.now())).slice(0, 8);
  const scopeUnit = `ttasks-lab-term-${tag}`;
  const pids: Record<string, number | undefined> = {};
  const alive2 = () =>
    Object.fromEntries(Object.entries(pids).map(([k, p]) => [k, p !== undefined && alive(p)]));
  let runUnit: string | undefined;
  try {
    if (transient) {
      mkdirSync(state, { recursive: true, mode: 0o700 });
      if (systemdRun(unit, [tasks, "service", "--state", state]) !== 0) throw new Error("unit");
    }
    await waitFor(
      () => unitActive(unit) && existsSync(join(state, "service.json")),
      30_000,
      "the service",
    );
    // The terminal: `systemd-run --user --scope` around the terminal (or the bare shim).
    const termTicket = (await rpc(state, "spike.mint_ticket", {
      argv: [node, "-e", "setTimeout(() => process.exit(0), 120000)"],
      cwd: realpathSync.native(folder),
      title: "TTasks lab S01 terminal",
    })) as JsonObject;
    const termTag = sha256Hex(text(termTicket["ticket"])).slice(0, 12);
    const inner = [tasks, "shim", "--state", state, text(termTicket["ticket"])];
    await rpc(state, "spike.spawn", {
      argv: [
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        `--unit=${scopeUnit}`,
        ...(terminal === undefined ? inner : [terminal, "-e", ...inner]),
      ],
    });
    pids["terminal_shim"] = (
      await waitFor(
        () => events(state).find((e) => e["kind"] === "claim" && e["ticket"] === termTag),
        30_000,
        "the terminal's claim",
      )
    )["pid"] as number;
    // The run: a transient unit whose agent leads its own process group (A4 L11).
    const runTicket = (await rpc(state, "spike.mint_ticket", {
      argv: [node, "-e", "setTimeout(() => process.exit(0), 120000)"],
      cwd: realpathSync.native(folder),
      run: true,
      title: "M-7 Lab run",
      brief: "Fixture brief for row S01.",
    })) as JsonObject;
    const runTag = text(runTicket["run"]);
    runUnit = `ttasks-lab-run-${runTag}`;
    await rpc(state, "spike.spawn", {
      argv: [
        "systemd-run",
        "--user",
        "--quiet",
        "--collect",
        `--unit=${runUnit}`,
        tasks,
        "run-shim",
        "--state",
        state,
        text(runTicket["ticket"]),
      ],
    });
    const runDir = join(state, "runs", runTag);
    const meta = await waitFor(
      () =>
        existsSync(join(runDir, "meta.json"))
          ? (JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as JsonObject)
          : undefined,
      30_000,
      "the run's meta.json",
    );
    pids["run_agent"] = meta["agent_pid"] as number;
    pids["run_shim"] = (events(state).find(
      (e) => e["kind"] === "claim" && e["ticket"] === runTag,
    ) ?? {})["pid"] as number | undefined;
    // The control: a child of the service without a scope.
    pids["control"] = (
      (await rpc(state, "spike.spawn", {
        argv: [node, "-e", "setTimeout(() => {}, 120000)"],
      })) as JsonObject
    )["pid"] as number;
    await sleep(1000);
    result["alive_before"] = alive2();

    const attaches = () => events(state).filter((e) => e["kind"] === "run.attach").length;
    const before = attaches();
    systemctl("restart", `${unit}.service`);
    await waitFor(
      () => unitActive(unit) && existsSync(join(state, "service.json")),
      30_000,
      "the restart",
    );
    await sleep(2000);
    result["alive_after_restart"] = alive2();
    result["run_reattached_after_restart"] = await waitFor(
      () => attaches() > before,
      15_000,
      "run.attach",
    ).catch(() => false);

    systemctl("stop", `${unit}.service`);
    await sleep(2000);
    result["alive_after_stop"] = alive2();
    if (transient) {
      if (systemdRun(unit, [tasks, "service", "--state", state]) !== 0) throw new Error("unit");
    } else systemctl("start", `${unit}.service`);
    await waitFor(
      () => unitActive(unit) && existsSync(join(state, "service.json")),
      30_000,
      "the start",
    );

    // SIGINT to the run's process group: it reaches the agent, never the run shim.
    const pgid = meta["pgid"] as number;
    try {
      process.kill(-pgid, "SIGINT");
    } catch {
      // The group is gone already.
    }
    const exited = await waitFor(
      () => events(state).some((e) => e["kind"] === "run.exited" && e["run"] === runTag),
      30_000,
      "run.exited",
    ).catch(() => false);
    result["sigint_to_run_group"] = {
      run_exit_reported: exited,
      shim_signals_log: existsSync(join(runDir, "shim-signals.log")),
      run_signal_event: events(state).some((e) => e["kind"] === "run.signal"),
    };
  } finally {
    for (const pid of Object.values(pids)) if (pid !== undefined && alive(pid)) hardKill(pid);
    systemctl("stop", `${scopeUnit}.scope`);
    if (runUnit !== undefined) systemctl("stop", `${runUnit}.service`);
    if (transient) systemctl("stop", `${unit}.service`);
  }
  return result;
}

async function s03Crash(args: string[]): Promise<Result> {
  if (!WIN) throw new Error("S03 is the Windows row");
  const root = need(args, "--root");
  const state = join(root, "state", "service");
  const log = join(root, "state", "supervisor.jsonl");
  const result = header("S03");
  const kills = Number(option(args, "--kills") ?? "5");
  const startBy = option(args, "--start");
  // Without --start the service is the session's own (started at sign-in) and stays its own.
  if (startBy === undefined) return crashes(state, log, kills, result);
  startSupervisor(root, startBy);
  try {
    return await crashes(state, log, kills, result);
  } finally {
    result["processes_left_after_cleanup"] = (await stopUnderRoot(root, state)).after_cleanup;
  }
}

async function crashes(state: string, log: string, kills: number, result: Result): Promise<Result> {
  const lines = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .flatMap((l) => {
            const m = parseObject(l);
            return m === undefined ? [] : [m];
          })
      : [];
  const startLine = lines().length;
  const seen = () => lines().slice(startLine);
  const crashes: Json[] = [];
  let pid = (
    await waitFor(
      () => (existsSync(join(state, "service.json")) ? readServiceInfo(state) : undefined),
      30_000,
      "the service",
    )
  ).pid;
  for (let i = 0; i < kills; i++) {
    // taskkill /F of the service's node.exe by PID, never by image name.
    const t0 = Date.now();
    spawnSync(
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/F", "/PID", String(pid)],
      {
        windowsHide: true,
        shell: false,
        timeout: 30_000,
      },
    );
    const next = await waitFor(
      () => {
        if (!existsSync(join(state, "service.json"))) return undefined;
        const info = readServiceInfo(state);
        return info.pid !== pid && alive(info.pid) ? info : undefined;
      },
      i < kills - 1 ? 40_000 : 25_000,
      "a restart",
    ).catch(() => undefined);
    crashes.push({
      restarted: next !== undefined,
      after_ms: next === undefined ? null : Date.now() - t0,
    });
    if (next === undefined) break;
    pid = next.pid;
  }
  await sleep(2000);
  result["crashes"] = crashes;
  result["supervisor_events"] = seen().map((e) => ({
    kind: e["kind"] ?? null,
    code: e["code"] ?? null,
    action: e["action"] ?? null,
    delay_ms: e["delay_ms"] ?? null,
  }));
  result["gave_up_file"] = existsSync(join(state, "crash", "supervisor-gave-up.json"));
  result["service_running_at_end"] =
    existsSync(join(state, "service.json")) && alive(readServiceInfo(state).pid);
  return result;
}
// ------------------------------------------------------------------------------------------
// S12: the kit's other-accounts check, as counts and kinds

function accountKinds(): JsonObject {
  if (WIN) {
    const r = windowsPowerShell(
      "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
        "$groups = @(Get-LocalGroup); " +
        "Get-LocalUser | Where-Object { $_.Enabled -and $_.SID.Value -ne $me } | ForEach-Object { $u = $_; " +
        "$in = @($groups | Where-Object { @(Get-LocalGroupMember -Group $_ -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $u.SID.Value }).Count -gt 0 } | ForEach-Object { $_.Name }); " +
        "$kind = if (@($in | Where-Object { $_ -like '*Sandbox*' }).Count -gt 0) { 'sandbox-group member' } elseif ($in -contains 'Administrators') { 'administrator' } elseif ($in -contains 'Users') { 'standard user' } else { 'no standard group' }; " +
        "'{0}|{1}' -f $kind, [bool]$u.LastLogon }",
    );
    const kinds: Record<string, number> = {};
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.includes("|")) continue;
      const [kind, logon] = line.trim().split("|");
      const key = `${kind ?? "?"}${logon === "True" ? ", has signed in" : ", never signed in"}`;
      kinds[key] = (kinds[key] ?? 0) + 1;
    }
    return { query_ran: r.ok, kinds };
  }
  const me = userInfo().username;
  const groups = readFileSync("/etc/group", "utf8").split("\n");
  const admins = new Set(
    groups
      .filter((g) => /^(sudo|admin|wheel):/.test(g))
      .flatMap((g) => (g.split(":")[3] ?? "").split(",")),
  );
  const kinds: Record<string, number> = {};
  for (const row of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [name, , uid, , , home, shell] = row.split(":");
    const id = Number(uid);
    if (name === undefined || shell === undefined || !Number.isInteger(id)) continue;
    if (id < 1000 || id === 65534 || /(nologin|false)$/.test(shell) || name === me) continue;
    const key = `login account (shell ${basename(shell)}, home ${home?.startsWith("/home/") === true ? "under /home" : "elsewhere"}${admins.has(name) ? ", in an admin group" : ""})`;
    kinds[key] = (kinds[key] ?? 0) + 1;
  }
  return { query_ran: true, kinds, source: "/etc/passwd (local accounts only)" };
}

function accounts(): Result {
  const result = header("S12");
  result["kit_other_accounts"] = otherAccounts().length;
  result["kinds"] = accountKinds();
  return result;
}

// ------------------------------------------------------------------------------------------

function need(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<Result> | Result> = {
  s04,
  s06,
  s07,
  s08,
  s09,
  e01,
  accounts,
  s01,
  "s03-crash": s03Crash,
};
const run = command === undefined ? undefined : commands[command];
if (run === undefined) {
  process.stderr.write(`usage: lab ${Object.keys(commands).join("|")} ...\n`);
  process.exitCode = 64;
} else {
  try {
    save(need(rest, "--out"), await run(rest));
  } catch (error) {
    process.stderr.write(
      `lab ${command ?? ""}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await stopOwned();
  }
}
