// Stand-ins for what the service install touches, so no test reaches a real unit folder,
// LaunchAgents folder, Run key or service manager: a registry in memory, a recorder that plays
// systemctl, loginctl, launchctl, tasklist and explorer, a service that answers probes, and a
// file-level snapshot of a folder for the "no trace" diffs. Tests only.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import type { ServiceStatus } from "../src/hub/endpoint.ts";
import type { Identity } from "../src/hub/identity.ts";
import type { Layout } from "../src/hub/paths.ts";
import type {
  Probe,
  ServiceContext,
  ServiceRecord,
  ShutdownResult,
} from "../src/install/context.ts";
import type { RunOptions, Runner, RunResult } from "../src/install/process.ts";
import {
  regKey,
  type Registry,
  type RegReadOptions,
  type RegTree,
  type RegValue,
} from "../src/install/registry.ts";
import { serviceNames } from "../src/install/render.ts";

// ---------------------------------------------------------------------------------------------
// A registry in memory, with reg.exe's rules: names and keys compare without case

export class MemoryRegistry implements Registry {
  readonly keys = new Map<string, Map<string, RegValue>>();
  readonly writes: string[] = [];
  /** Runs at the start of every read, before it looks: another program acting meanwhile. */
  onRead: ((key: string) => void) | undefined;
  /** Runs at the start of every write or removal, before it applies. */
  beforeWrite: ((key: string) => void) | undefined;
  /** Runs right after every write or removal. */
  afterWrite: ((key: string) => void) | undefined;
  /** The bound each read was given. */
  readonly bounds: (number | undefined)[] = [];

  set(key: string, value: RegValue): void {
    const values = this.keys.get(regKey(key)) ?? new Map<string, RegValue>();
    values.set(value.name.toLowerCase(), value);
    this.keys.set(regKey(key), values);
  }

  /** Whether a key exists: set itself, or above one that was (reg add creates the keys above). */
  has(key: string): boolean {
    const at = regKey(key);
    return [...this.keys.keys()].some((path) => path === at || path.startsWith(`${at}\\`));
  }

  tree(key: string, options?: RegReadOptions): Promise<RegTree | undefined> {
    this.onRead?.(key);
    this.bounds.push(options?.timeoutMs);
    const prefix = regKey(key);
    if (!this.has(key)) return Promise.resolve(undefined);
    const tree: RegTree = new Map([[prefix, new Map(this.keys.get(prefix) ?? [])]]);
    for (const [path, values] of this.keys) {
      if (path.startsWith(`${prefix}\\`)) tree.set(path, new Map(values));
    }
    return Promise.resolve(tree);
  }

  async values(key: string, options?: RegReadOptions): Promise<Map<string, RegValue> | undefined> {
    return (await this.tree(key, options))?.get(regKey(key));
  }

  setString(key: string, name: string, data: string): Promise<void> {
    this.beforeWrite?.(key);
    this.writes.push(`set ${key} ${name}`);
    this.set(key, { name, kind: "REG_SZ", data });
    this.afterWrite?.(key);
    return Promise.resolve();
  }

  remove(key: string, name: string): Promise<void> {
    this.beforeWrite?.(key);
    this.writes.push(`remove ${key} ${name}`);
    const values = this.keys.get(regKey(key));
    if (values?.delete(name.toLowerCase()) !== true) {
      return Promise.reject(new Error("no such value"));
    }
    this.afterWrite?.(key);
    return Promise.resolve();
  }

  async removeEmptyKey(key: string): Promise<boolean> {
    const tree = await this.tree(key);
    if (tree === undefined || tree.size !== 1 || (tree.get(regKey(key))?.size ?? 0) > 0) {
      return false;
    }
    this.writes.push(`remove-key ${key}`);
    this.keys.delete(regKey(key));
    return true;
  }

  /** Everything, sorted, for a key-level diff: each key, empty or not, and each value. */
  dump(): string[] {
    return [...this.keys]
      .flatMap(([key, values]) => [
        `${key} |`,
        ...[...values.values()].map((v) => `${key} | ${v.name} | ${v.kind} | ${v.data}`),
      ])
      .sort();
  }
}

// ---------------------------------------------------------------------------------------------
// A service that answers probes

export class FakeService {
  running = false;
  manager = "manual";
  /** Probes after a start that find no endpoint yet (service.json says starting). */
  hiddenProbes = 0;
  /** Probes that see `starting` after a start, before `ready`. */
  startingProbes = 1;
  /** When false, a start never becomes ready. */
  becomesReady = true;
  /** Waits (ctx.sleep) a stopped service drains before its process ends. */
  drainTicks = 0;
  shutdownAnswer: ShutdownResult | undefined;
  /** How long one probe takes, in ms; a probe never takes longer than its budget. */
  probeMs = 0;
  readonly budgets: (number | undefined)[] = [];
  /** How old service.json is, as its file time says. */
  recordAgeMs = 0;
  installId = "";
  /** The UI listener as `service/status` reports it (M2.12). */
  http: NonNullable<ServiceStatus["http"]> | null = null;
  pid = 4120;
  instance = "9c4e1f07a2d35b8e6f10c2a94d7b3e51";
  /** The version it answers with. */
  version = "0.0.0-test";
  /** What `current` names: a start from now on runs that version. */
  current: string | undefined;
  /** The drain removes service.json before the process ends (A2 3.3.1 step 4): a probe then finds none. */
  recordGoesFirst = false;
  /** The OS gives process start times (Linux); off, processStart gives none (Windows, macOS). */
  startTimes = true;
  /** Runs at the start of every probe: another program acting meanwhile. */
  onProbe: (() => void) | undefined;
  /** Runs at every wait (ctx.sleep), after the drain's own tick. */
  onTick: (() => void) | undefined;
  #pending = 0;
  #hidden = 0;
  #draining = 0;
  #clock = 0;
  readonly #alive = new Map<number, string>();
  readonly events: string[] = [];

  start(manager: string): void {
    if (this.running || this.#draining > 0) return;
    this.running = true;
    this.manager = manager;
    if (this.current !== undefined) this.version = this.current;
    this.#pending = this.startingProbes;
    this.#hidden = this.hiddenProbes;
    this.pid += 1;
    this.instance = `${this.instance.slice(1)}${String(this.pid % 10)}`;
    this.#clock += 1;
    this.#alive.set(this.pid, `t${String(this.#clock)}`);
    this.events.push(`start ${manager}`);
  }

  /** A stop: the endpoint closes at once; the process ends after `drainTicks` waits. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.events.push("stop");
    this.#draining = this.drainTicks;
    if (this.#draining === 0) this.#alive.delete(this.pid);
  }

  /** One wait passes: a draining service gets closer to its end. */
  tick(): void {
    if (this.#draining > 0) {
      this.#draining -= 1;
      if (this.#draining === 0) this.#alive.delete(this.pid);
    }
    this.onTick?.();
  }

  /** The draining service's process ends, and another process gets its PID at once. */
  reusePid(): void {
    this.#draining = 0;
    this.#clock += 1;
    this.#alive.set(this.pid, `t${String(this.#clock)}`);
  }

  alive = (pid: number): boolean => this.#alive.has(pid);

  processStart = (pid: number): string | undefined =>
    this.startTimes ? this.#alive.get(pid) : undefined;

  /** service.json as the service would keep it. */
  record = (): ServiceRecord | undefined => {
    if (!this.running && (this.#draining === 0 || this.recordGoesFirst)) return undefined;
    const state = this.#draining > 0 ? "draining" : this.#hidden > 0 ? "starting" : "ready";
    return {
      pid: this.pid,
      instance: this.instance,
      state,
      installId: this.installId,
      endpoint: state === "starting" ? undefined : "\\\\.\\pipe\\test",
      ageMs: this.recordAgeMs,
    };
  };

  status(): ServiceStatus {
    const ready = this.becomesReady && this.#pending <= 0;
    return {
      state: ready ? "ready" : "starting",
      pid: this.pid,
      instance: this.instance,
      install_id: "",
      version: this.version,
      build: "test",
      uptime_ms: 90_000,
      manager: this.manager,
      protocol: { min: 1, max: 1 },
      endpoint: { kind: "pipe", path: "\\\\.\\pipe\\test" },
      spaces: [{ entry: 0, id: "sp_test", state: "open" }],
      http: this.http,
    };
  }

  probe = async (id: string, budgetMs?: number): Promise<Probe> => {
    this.budgets.push(budgetMs);
    this.onProbe?.();
    if (this.probeMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(this.probeMs, budgetMs ?? Infinity)),
      );
    }
    if (this.#draining > 0) {
      return { answers: false, reason: this.recordGoesFirst ? "not_running" : "stopping" };
    }
    if (!this.running) return { answers: false, reason: "not_running" };
    if (this.#hidden > 0) {
      this.#hidden -= 1;
      return { answers: false, reason: "starting" };
    }
    this.#pending -= 1;
    return { answers: true, status: { ...this.status(), install_id: id } };
  };

  shutdown = (budgetMs?: number): Promise<ShutdownResult> => {
    this.budgets.push(budgetMs);
    if (this.shutdownAnswer !== undefined) return Promise.resolve(this.shutdownAnswer);
    if (!this.running) return Promise.resolve("not_running");
    this.stop();
    return Promise.resolve("stopping");
  };
}

// ---------------------------------------------------------------------------------------------
// The OS's tools, played

export interface Call {
  readonly tool: string;
  readonly args: readonly string[];
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1, stdout = ""): RunResult => ({ code, stdout, stderr: "" });

export interface ToolOptions {
  /** systemctl --user reaches a user manager. */
  readonly userManager?: boolean;
  readonly linger?: "yes" | "no";
  /** tasklist shows Explorer in this process's session. */
  readonly explorer?: boolean;
  /** A tool that fails: `systemctl enable`, for example. */
  readonly failing?: string;
  /** How long each tool takes, in ms. */
  readonly delayMs?: number;
  /** Whether a slow tool ends at the timeout it was given (false: it ignores it). Default true. */
  readonly honorTimeouts?: boolean;
}

/**
 * systemctl, loginctl, launchctl, tasklist and explorer as one recorder. systemctl's enable and
 * disable make and remove the `default.target.wants` link as systemd does, so a file-level diff
 * sees what the real tool would leave.
 */
export class FakeTools {
  readonly calls: Call[] = [];
  readonly #service: FakeService;
  readonly #options: ToolOptions;
  readonly #unitDir: string;
  loaded = false;
  /**
   * What `systemctl --user is-active` says of the unit whatever runs, when set: a unit that systemd
   * started while a service by hand holds the lock is `activating` or `active` a moment before it
   * exits 73.
   */
  unitState: string | undefined;

  constructor(service: FakeService, unitDir: string, options: ToolOptions = {}) {
    this.#service = service;
    this.#unitDir = unitDir;
    this.#options = options;
  }

  /** The options of each call, in order. */
  readonly options: (RunOptions | undefined)[] = [];
  /** When each call started (Date.now()), in order. */
  readonly startedAt: number[] = [];
  /** Runs at the start of every call with its command line: another program acting meanwhile. */
  onCall: ((line: string) => void) | undefined;

  run: Runner = async (file, args, options) => {
    const tool = basename(file).toLowerCase();
    this.calls.push({ tool, args: [...args] });
    this.options.push(options);
    this.startedAt.push(Date.now());
    const line = [tool, ...args].join(" ");
    this.onCall?.(line);
    const delay = this.#options.delayMs ?? 0;
    if (delay > 0) {
      const timeout = this.#options.honorTimeouts === false ? undefined : options?.timeoutMs;
      if (timeout !== undefined && timeout < delay) {
        await new Promise((resolve) => setTimeout(resolve, timeout));
        return { code: null, stdout: "", stderr: "", failure: "ETIMEDOUT" };
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (this.#options.failing !== undefined && line.startsWith(this.#options.failing)) {
      return fail(1);
    }
    return this.#answer(tool, args);
  };

  /** The calls as command lines, without the probes that only read. */
  lines(): string[] {
    return this.calls.map((c) => [c.tool, ...c.args].join(" "));
  }

  #answer(tool: string, args: readonly string[]): RunResult {
    const service = this.#service;
    switch (tool) {
      case "systemctl": {
        if (this.#options.userManager === false) return fail(1);
        const [, verb, unit = ""] = args;
        const wants = join(this.#unitDir, "default.target.wants");
        switch (verb) {
          case "show":
            // The unit's main process: the service, when the unit runs it.
            if (args.includes("--property=MainPID")) {
              const runs = service.running && service.manager === "systemd";
              return ok(`${runs ? String(service.pid) : "0"}\n`);
            }
            return ok("Version=255\n");
          case "daemon-reload":
            return ok();
          case "enable":
            // As systemctl does, enabling an enabled unit leaves its link as it is.
            mkdirSync(wants, { recursive: true });
            rmSync(join(wants, unit), { force: true });
            symlinkSync(join("..", unit), join(wants, unit));
            return ok();
          case "disable":
            rmSync(join(wants, unit), { force: true });
            return ok();
          case "is-enabled":
            return existsSync(join(wants, unit)) ? ok("enabled\n") : fail(1, "disabled\n");
          case "is-active":
            if (this.unitState !== undefined) {
              return this.unitState === "active" ? ok("active\n") : fail(3, `${this.unitState}\n`);
            }
            return service.running && service.manager === "systemd"
              ? ok("active\n")
              : fail(3, "inactive\n");
          case "start":
            service.start("systemd");
            return ok();
          case "stop":
            if (service.manager === "systemd") service.stop();
            return ok();
          default:
            return fail(1);
        }
      }
      case "loginctl":
        return ok(`${this.#options.linger ?? "no"}\n`);
      case "launchctl": {
        const [verb] = args;
        switch (verb) {
          case "print":
            return this.loaded ? ok("state = running\n") : fail(113);
          case "bootstrap":
            this.loaded = true;
            service.start("launchd");
            return ok();
          case "bootout":
            this.loaded = false;
            if (service.manager === "launchd") service.stop();
            return ok();
          case "kickstart":
            if (!this.loaded) return fail(113);
            service.start("launchd");
            return ok();
          case "kill":
            if (service.manager === "launchd") service.stop();
            return this.loaded ? ok() : fail(113);
          default:
            return fail(1);
        }
      }
      case "tasklist.exe": {
        const filter = args.at(-1) ?? "";
        if (filter.startsWith("PID eq ")) {
          const pid = filter.slice("PID eq ".length);
          return ok(`"node.exe","${pid}","Console","1","50,000 K"\r\n`);
        }
        return this.#options.explorer === false
          ? ok("INFO: No tasks are running which match the specified criteria.\r\n")
          : ok('"explorer.exe","8104","Console","1","215,400 K"\r\n');
      }
      case "explorer.exe":
        service.start("tasksw");
        return fail(1); // explorer.exe exits 1 after it hands the start to the shell
      default:
        return fail(127);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Contexts

export const NOT_ELEVATED: Identity = { root: false, elevated: false, package: null };

/** The data folders of a layout whose data folder is `data`, joined with this OS's separators. */
function dataFolders(data: string) {
  const state = join(data, "state");
  return {
    data,
    config: join(data, "config"),
    state,
    cache: join(data, "cache"),
    logs: join(state, "logs"),
    crash: join(state, "crash"),
    tmp: join(state, "tmp"),
    workdirs: join(state, "workdirs"),
    spaces: join(data, "spaces"),
  };
}

/** A test install's layout (TASKS_HOME): program, command and data under `root`. */
export function testLayout(platform: NodeJS.Platform, root: string): Layout {
  return { platform, root, bin: join(root, "bin"), ...dataFolders(root), home: root };
}

/**
 * The daily install's layout for the home folder `home` (A2 3.2.1): the program in
 * `.local/share/tasks`, the command in `.local/bin`, the data in `.tasks`.
 */
export function dailyLayout(platform: NodeJS.Platform, home: string): Layout {
  return {
    platform,
    root: join(home, ".local", "share", "tasks"),
    bin: join(home, ".local", "bin"),
    ...dataFolders(join(home, ".tasks")),
    home: undefined,
  };
}

export interface FakeContextOptions {
  readonly platform: "linux" | "win32" | "darwin";
  /** A temporary folder: the user's home, the test install and the entry folders live in it. */
  readonly dir: string;
  readonly tools?: ToolOptions;
  readonly identity?: Identity;
  readonly registry?: Registry;
  readonly installId?: string;
  readonly registryRoot?: string;
  /** The command runs in an agent's shell. */
  readonly agentShell?: boolean;
  /** The daily install's layout under the fake home, instead of a test install's. */
  readonly daily?: boolean;
}

export interface FakeContext {
  readonly ctx: ServiceContext;
  readonly service: FakeService;
  readonly tools: FakeTools;
  readonly detached: Call[];
}

export const TEST_INSTALL_ID = "gz2r16ezc2";

/**
 * A context whose every place and tool is a stand-in under `dir`: home `dir/home`, the test
 * install `dir/tasks-test` (or with `daily`, the daily install's folders under the home) with its
 * program file, the unit and LaunchAgents folders under the home, the registry in memory unless
 * given.
 */
export function fakeContext(options: FakeContextOptions): FakeContext {
  const { platform, dir } = options;
  const home = join(dir, "home");
  const daily = options.daily ?? false;
  const layout = daily
    ? dailyLayout(platform, home)
    : testLayout(platform, join(dir, "tasks-test"));
  const program =
    platform === "win32"
      ? join(layout.bin, "tasksw.exe")
      : join(layout.root, "current", "bin", platform === "darwin" ? "tasks-launchd" : "tasks");
  mkdirSync(join(program, ".."), { recursive: true });
  writeFileSync(program, "stand-in launcher\n");
  mkdirSync(home, { recursive: true });
  const unitDir = join(home, ".config", "systemd", "user");
  const service = new FakeService();
  const tools = new FakeTools(service, unitDir, options.tools);
  const detached: Call[] = [];
  const id = options.installId ?? TEST_INSTALL_ID;
  service.installId = id;
  const ctx: ServiceContext = {
    platform,
    layout,
    installId: id,
    names: serviceNames(id, !daily),
    program,
    home,
    uid: 501,
    roots: {
      unitDir,
      launchAgentsDir: join(home, "Library", "LaunchAgents"),
      registryRoot: options.registryRoot ?? "HKCU\\Software\\tasks-test-memory",
    },
    run: tools.run,
    startDetached: (file, args) => {
      detached.push({ tool: file, args: [...args] });
      service.start("manual");
    },
    registry: options.registry ?? new MemoryRegistry(),
    windows:
      platform === "win32"
        ? { reg: "reg.exe", tasklist: "tasklist.exe", explorer: "explorer.exe" }
        : undefined,
    identity: () => options.identity ?? NOT_ELEVATED,
    agentShell: options.agentShell ?? false,
    record: service.record,
    alive: service.alive,
    processStart: service.processStart,
    probe: (budgetMs) => service.probe(id, budgetMs),
    shutdown: service.shutdown,
    sleep: () => {
      service.tick();
      return Promise.resolve();
    },
    readyTimeoutMs: 200,
    stopTimeoutMs: 200,
    pollMs: 1,
  };
  return { ctx, service, tools, detached };
}

/** What an entry printed, for assertions. */
export function captureIO(answer?: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    out,
    err,
    asked,
    io: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
      ask:
        answer === undefined
          ? undefined
          : (question: string) => {
              asked.push(question);
              return Promise.resolve(answer);
            },
    },
    text: () => out.join(""),
    errors: () => err.join(""),
  };
}

// ---------------------------------------------------------------------------------------------
// A file-level snapshot

/** Every entry under `dir`: its relative path and kind, a file's text, a link's target. */
export function snapshot(dir: string): string[] {
  const entries: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const rel = relative(dir, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) entries.push(`link ${rel} -> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) {
        entries.push(`dir ${rel}`);
        walk(path);
      } else entries.push(`file ${rel} ${readFileSync(path, "utf8")}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return entries.sort();
}
