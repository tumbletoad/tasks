// Test helpers for the launch shim (A4 3.6.3): a service in this process with one space, one task
// and one root, a terminal that starts `ttasks shim <ticket>` directly as a real child process in
// the folder the service resolved (the seam M2.09's terminal adapters replace), a fake agent's
// spawn plan, and every process a test started, shims and agents, recorded by PID and stopped by
// that test. On Linux the service's per-user runtime folder is under a runtime base of the lab's
// own (harness.ts testRuntimeBase), and the lab's cleanup fails its test if anything is left there
// once the runtime folder the lab caused is removed. Fixture data and temporary folders only.
// Tests only.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRpc, type RpcSession } from "@ttasks/bridge/protocol";
import {
  FixedEnvironment,
  startTimes,
  type LaunchIntent,
  type PlanFolder,
  type SpawnPlan,
} from "@ttasks/launch";
import { fakeAgentCommand } from "@ttasks/runs/fake-agents";
import { layoutTestInstall, testEnv, type TestInstall } from "@ttasks/testkit";
import { startService, type RunningService, type StartOptions } from "../src/hub/service.ts";
import type { LaunchOptions, TerminalSeams } from "../src/launch/index.ts";
import {
  keyOf,
  registerSpaces,
  removeRuntimeDirOf,
  serviceEnv,
  tempRoot,
  testRuntimeBase,
  waitFor,
  within,
  type Exit,
} from "./harness.ts";
import { agentHomeOf, classSession } from "./ops-helpers.ts";

/** The CLI's entry: `ttasks shim <ticket>` from the source tree, as `pnpm ttasks` runs it. */
export const CLI_BIN = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));

/** Generous bounds: a loaded runner must not fail a test that is only slow. */
export const LONG_MS = 90_000;

/** A recording whose fake agent exits 0 once its stdin ends (packages/runs/test/fake-agents.ts). */
export const SUCCESS_FIXTURE = "claude-print/windows-success-tool-call.jsonl";

/** A child process of the test, with its output kept. */
export interface Child {
  readonly pid: number;
  readonly child: ChildProcess;
  readonly exit: Promise<Exit>;
  stdout(): string;
  stderr(): string;
  /** Ends its stdin, which the fake agent behind a shim reads to its end. */
  endInput(): void;
}

export function track(child: ChildProcess): Child {
  const pid = child.pid;
  if (pid === undefined) throw new Error("the process did not start");
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    err += chunk;
  });
  child.stdin?.on("error", () => undefined);
  const exit = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    // A start that failed: reported as an exit with no code, never as an uncaught error.
    child.once("error", () => {
      resolve({ code: null, signal: null });
    });
  });
  return {
    pid,
    child,
    exit,
    stdout: () => out,
    stderr: () => err,
    endInput: () => {
      child.stdin?.end();
    },
  };
}

/** Ends a process the test started, by its PID, if it still runs. */
export function stopPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** The environment of a shim under test: a test's clean one (testEnv), with TTASKS_HOME set. */
export function shimEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return testEnv({ TTASKS_HOME: home, ...extra });
}

/** A shim's rpc session with the service: the `shim` class, as `ttasks shim` connects. */
export function shimSession(home: string, path: string): Promise<RpcSession> {
  return within(
    openRpc({
      path,
      key: keyOf(home),
      client: {
        kind: "shim",
        version: "0.0.0-test",
        build: "test",
        pid: process.pid,
        package: null,
        tty: { stdin: false, stdout: false },
      },
      context: {},
    }),
    20_000,
    "the shim handshake",
  );
}

export interface LabOptions {
  /** Launch options for every start of the service (the clocks and the terminal are the lab's). */
  readonly launch?: Partial<LaunchOptions>;
  /** Extra variables for the shims the terminal starts. */
  readonly shimEnv?: Record<string, string>;
  /**
   * Runs as the terminal starts, after the service resolved the folder and issued the ticket and
   * before the shim starts in that folder: a test changes the tree there.
   */
  readonly beforeShim?: (folder: string) => void;
  /**
   * A built version folder (`pnpm accept --installed`): the lab's home is a test install of it, the
   * shim runs through its launcher, and the service is its own bundled hub (`startService`).
   */
  readonly installed?: { readonly versionFolder: string; readonly start: typeof startService };
  /**
   * The service's own terminal adapters (M2.09) with their seams (a fake spawner that records the
   * argv and runs testkit's fake terminals), in place of the lab's direct start of the shim.
   */
  readonly adapters?: TerminalSeams;
  /** Variables the service's own environment has on top of this process's. */
  readonly serviceEnv?: Record<string, string>;
  /** More of machine.toml: `[[instance]]` tables (harness.ts instanceToml), given the lab's root. */
  readonly toml?: (root: string) => string;
  /**
   * The service's UI listener on a free port, so its grants table is service.sqlite's as an
   * install's is: the agent homes registered before a restart are there at the next start.
   */
  readonly http?: boolean;
}

/**
 * A service of a temporary home with one space, a task in it, a folder (`work/portal`, the one its
 * plans name by default), and a terminal that starts each shim as a child of this test
 * in the folder the service resolved. The wall clock the service's launching reads is the real one
 * plus `skew`, which a test moves to pass a window.
 */
export class ShimLab {
  readonly root: string;
  readonly home: string;
  readonly spaceFolder: string;
  /** The folder that holds the default folder. */
  readonly work: string;
  /** The default folder, `<work>/portal`, as its real path. */
  readonly folder: string;
  /** The test install, when the lab runs a built version folder. */
  readonly install: TestInstall | undefined;
  /** Linux's runtime base of the lab's own, standing in for /run/user (A2 3.2.1). */
  readonly runtime: ReturnType<typeof testRuntimeBase>;
  readonly shims: Child[] = [];
  readonly tickets = new Map<string, string>();
  /** The folder each launch's terminal was started in, by launch ID. */
  readonly folders = new Map<string, string>();
  spaceId = "";
  taskId = "";
  skew = 0;
  service: RunningService | undefined;
  readonly #cleanup: () => void;
  readonly #options: LabOptions;
  /** Agents seen, by PID with the start time read when first seen, so cleanup stops only them. */
  readonly #agents = new Map<number, string | undefined>();
  /** The launches this lab opened: cleanup stops the shims that claimed them, wherever they run. */
  readonly #launches = new Set<string>();
  #requests = 0;
  #cleaned = false;

  private constructor(label: string, options: LabOptions) {
    const temp = tempRoot(label);
    this.root = temp.root;
    this.#cleanup = temp.cleanup;
    this.#options = options;
    this.runtime = testRuntimeBase(label);
    this.home = join(temp.root, "h");
    this.install =
      options.installed === undefined
        ? undefined
        : layoutTestInstall(options.installed.versionFolder, this.home);
    this.spaceFolder = join(temp.root, "spaces", "mira");
    this.work = join(temp.root, "work");
    mkdirSync(join(this.work, "portal"), { recursive: true });
    this.work = realpathSync.native(this.work);
    this.folder = realpathSync.native(join(this.work, "portal"));
    registerSpaces(this.home, [], options.toml?.(this.root));
  }

  /** The lab's default plan folder: `<work>/portal`, stored as its absolute path. */
  labFolder(): PlanFolder {
    return { stored: this.folder, path: this.folder };
  }

  /** A lab with its service started, a space created and registered, and one task. */
  static async create(label: string, options: LabOptions = {}): Promise<ShimLab> {
    const lab = new ShimLab(label, options);
    try {
      const service = await lab.start();
      const user = await classSession(lab.home, service.endpoint.path, "cli-interactive");
      try {
        const created = (await user.call(
          "space/create",
          { name: "Mira", path: lab.spaceFolder, ref_prefix: "M" },
          { timeoutMs: 60_000 },
        )) as { space: { id: string } };
        lab.spaceId = created.space.id;
        const added = (await user.call(
          "op/call",
          {
            op: "task.add",
            input: { tasks: [{ title: "Fixture task for the shim" }], request_id: lab.#rid() },
          },
          { timeoutMs: 60_000 },
        )) as { tasks: { id: string }[] };
        lab.taskId = added.tasks[0]?.id ?? "";
      } finally {
        user.close();
      }
      // The next start registers the space from machine.toml.
      registerSpaces(lab.home, [lab.spaceFolder], options.toml?.(lab.root));
      return lab;
    } catch (error) {
      await lab.cleanup();
      throw error;
    }
  }

  readonly now = (): number => Date.now() + this.skew;

  #rid(): string {
    this.#requests += 1;
    return `shim-lab-request-${String(this.#requests).padStart(6, "0")}`;
  }

  /** The product's command a terminal runs before `shim <ticket>`: the source entry, or the launcher. */
  get product(): readonly string[] {
    return this.install === undefined ? [process.execPath, CLI_BIN] : [this.install.launcher];
  }

  /** `ttasks shim <ticket>` as a terminal would run it: the source entry, or the build's launcher. */
  #shimCommand(ticket: string): [string, string[]] {
    const [file, ...rest] = this.product;
    return [file ?? "", [...rest, "shim", ticket]];
  }

  /**
   * Starts the service of this home, with the lab's clock, terminal and runtime base, and the
   * launch options of this start on top of the lab's.
   */
  async start(launch: Partial<LaunchOptions> = {}): Promise<RunningService> {
    const given = { ...this.#options.launch, ...launch };
    const adapters = this.#options.adapters;
    const env = serviceEnv(this.home, this.#options.serviceEnv);
    const options: StartOptions = {
      env,
      identity: () => ({ root: false, elevated: false, package: null }),
      maintenance: false,
      say: () => undefined,
      runUserBase: this.runtime.base,
      launch: {
        now: this.now,
        // Never the person's own profile or registry in a test: the service's environment, taken
        // through the allow-list, unless the test brings a base of its own.
        ...(given.baseEnv === undefined && given.environment === undefined
          ? { environment: new FixedEnvironment({ kind: "service", env }) }
          : {}),
        ...(adapters === undefined
          ? {
              terminal: ({ intent, ticket, folder }) => {
                this.tickets.set(intent.id, ticket);
                this.folders.set(intent.id, folder);
                this.#options.beforeShim?.(folder);
                // A terminal starts the shim in the folder the service resolved (A4 3.3):
                // the shim enters that very directory, checks it and starts the agent there.
                const [file, args] = this.#shimCommand(ticket);
                const child = spawn(file, args, {
                  cwd: folder,
                  env: shimEnv(this.home, this.#options.shimEnv),
                  stdio: ["pipe", "pipe", "pipe"],
                  windowsHide: true,
                });
                this.shims.push(track(child));
                return Promise.resolve({ kind: "accepted" });
              },
            }
          : { terminals: adapters, shimCommand: this.product }),
        ...given,
      },
      ...(this.#options.http === true ? { http: { ports: [0], persist: false } } : {}),
    };
    const service = await (this.#options.installed?.start ?? startService)(options);
    this.service = service;
    await service.spacesSettled;
    return service;
  }

  /**
   * Stops the service (a drain: the shims' connections close). A runtime folder that still holds
   * a launch folder stays, as it does for a real service: a restart reads it back.
   */
  async stopService(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    if (service !== undefined) await service.stop();
  }

  get running(): RunningService {
    if (this.service === undefined) throw new Error("the service is not running");
    return this.service;
  }

  /** A fake agent's plan: the recording, its report file, the instance's env and the folder. */
  plan(
    options: {
      report?: string;
      env?: Record<string, string>;
      afterExit?: SpawnPlan["afterExit"];
      folder?: PlanFolder | null;
    } = {},
  ): SpawnPlan {
    const { command, args } = fakeAgentCommand(SUCCESS_FIXTURE, {
      maxMs: 600_000,
      ...(options.report === undefined ? {} : { report: options.report }),
    });
    return {
      argv: [command, ...args],
      folder: options.folder === undefined ? this.labFolder() : options.folder,
      env: options.env ?? {},
      title: "Fixture launch",
      afterExit: options.afterExit ?? "close",
    };
  }

  /**
   * A click on the lab's task: the Prepared intent, with the instance's agent home recorded as a
   * real click records it (`agentHomeOf`: `grantHome` registers the same home). Each instance key
   * is its own launch: a second click with the same one while the first is still opening returns
   * the first.
   */
  async open(plan: SpawnPlan, instance = "fixture-agent"): Promise<LaunchIntent> {
    const intent = await this.running.launches.open(
      this.spaceId,
      {
        task: this.taskId,
        instance,
        route: "terminal",
        place: null,
        taskVersion: 1,
        briefHash: "b".repeat(64),
      },
      this.#rid(),
      plan,
      agentHomeOf(this.home, instance),
    );
    this.#launches.add(intent.id);
    return intent;
  }

  /** A click and its confirmation: a terminal launch of the lab's task, dispatched. */
  async launch(plan: SpawnPlan, instance?: string): Promise<LaunchIntent> {
    const intent = await this.open(plan, instance);
    const dispatched = await this.running.launches.dispatch(this.spaceId, intent.id);
    if (dispatched === undefined) throw new Error("the launch was not dispatched");
    return dispatched;
  }

  /** The intent once `ready` holds for it. Every agent PID it names is stopped at cleanup. */
  async waitIntent(
    id: string,
    ready: (intent: LaunchIntent) => boolean,
    what: string,
    ms = LONG_MS,
  ): Promise<LaunchIntent> {
    const deadline = Date.now() + ms;
    for (;;) {
      const service = this.service;
      const intent =
        service === undefined ? undefined : await service.launches.read(this.spaceId, id);
      const agent = intent?.evidence.pid;
      if (agent !== undefined && !this.#agents.has(agent)) {
        const seen = await startTimes([agent]).catch(() => new Map<number, string>());
        this.#agents.set(agent, seen.get(agent));
      }
      if (intent !== undefined && ready(intent)) return intent;
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits for a shim's exit, within a bound. */
  shimExit(shim: Child, ms = LONG_MS): Promise<Exit> {
    return within(shim.exit, ms, "the shim's exit");
  }

  /**
   * The shim of every launch of this lab that is still claimed, whichever terminal started it,
   * stopped by the PID and start time it claimed with, and awaited: a process holds its working
   * folder, the launch's, until it has ended, and Windows refuses to remove the folder until then.
   */
  async #stopClaimedShims(): Promise<void> {
    const host = this.service?.launches.host;
    if (host === undefined) return;
    const claimed = [...this.#launches].flatMap((id) => {
      const held = host.record(id)?.attachment;
      return held === undefined ? [] : [{ pid: held.pid, startTime: held.startTime }];
    });
    const startOf = async (pid: number) =>
      (await startTimes([pid]).catch(() => new Map<number, string>())).get(pid);
    const stopped: typeof claimed = [];
    for (const shim of claimed) {
      if ((await startOf(shim.pid)) !== shim.startTime) continue;
      stopPid(shim.pid);
      stopped.push(shim);
    }
    const deadline = Date.now() + 30_000;
    for (const shim of stopped) {
      while ((await startOf(shim.pid)) === shim.startTime) {
        if (Date.now() > deadline) throw new Error("a shim did not end");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  /**
   * Every shim and agent this lab started is stopped by PID, the service stopped, and the runtime
   * folder the lab caused removed by its full name, also after a test that failed halfway. Then
   * nothing may be left under the lab's runtime base: anything there fails the test. The folders
   * are removed whatever happens.
   */
  async cleanup(): Promise<void> {
    // Once: a test that cleans up itself registers its lab with afterEach too, in case it fails
    // before it gets there.
    if (this.#cleaned) return;
    this.#cleaned = true;
    let left: string[];
    try {
      for (const shim of this.shims) {
        if (shim.child.exitCode === null && shim.child.signalCode === null) {
          shim.child.kill("SIGKILL");
        }
      }
      // An agent is stopped only while its PID still names the process that was seen.
      for (const [pid, seen] of this.#agents) {
        if (seen === undefined) continue;
        const now = await startTimes([pid]).catch(() => new Map<number, string>());
        if (now.get(pid) === seen) stopPid(pid);
      }
      await Promise.all(this.shims.map((shim) => within(shim.exit, 30_000, "a shim's stop")));
      await this.#stopClaimedShims();
      await this.stopService().catch(() => undefined);
    } finally {
      removeRuntimeDirOf(this.home, this.runtime.base);
      left = this.runtime.leftovers();
      this.runtime.remove();
      this.#cleanup();
    }
    if (left.length > 0) {
      throw new Error(`a service test left ${left.join(", ")} under its runtime base`);
    }
  }
}
export { waitFor };

/** Removes a folder by its full name. */
export function removeFolder(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
