// Test helpers for the hub: services as real child processes, each PID recorded and stopped by
// the test that started it, temporary install homes under the OS temporary folder, readers for
// service.json and the log, and rpc sessions with a running service. Tests only.
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_ID } from "@tasks/brand";
import { openRpc, parseKey, type RpcSession } from "@tasks/bridge/protocol";
import type { TerminalHost } from "@tasks/launch";
import { newId, readManifest } from "@tasks/storage";
import { applyEdits, type Edit } from "../src/config/edit.ts";
import { canonicalStatePath, installId, RUN_USER_BASE } from "../src/hub/paths.ts";

export const MAIN = fileURLToPath(new URL("../src/hub/main.ts", import.meta.url));
export const ENTRY = fileURLToPath(new URL("./serve-entry.ts", import.meta.url));

/** Generous bounds: a loaded runner must not fail a test that is only slow. */
export const READY_MS = 60_000;
export const EXIT_MS = 60_000;

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface Proc {
  readonly pid: number;
  readonly child: ChildProcess;
  readonly exit: Promise<Exit>;
  /** stderr so far. */
  stderr(): string;
  /** Sends one line to the test entry's stdin. */
  send(line: string): void;
}

/**
 * The environment of a service under test: this process's, without any Tasks variable or agent
 * marker that would change the service, and with TASKS_HOME set.
 */
export function serviceEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase().startsWith("TASKS_")) continue;
    env[name] = value;
  }
  return { ...env, TASKS_HOME: home, ...extra };
}

/** Starts and stops services, and stops every one it started that still runs. */
export class Services {
  readonly #started: Proc[] = [];

  /**
   * Starts a service of `home`; `spaces` are registered in its machine.toml first. `command`
   * starts another program instead of Node with a script: a built version's launcher with
   * `serve`, for the acceptance against a build (`pnpm accept --installed`).
   */
  start(
    home: string,
    options: {
      spaces?: string[];
      env?: Record<string, string>;
      script?: string;
      command?: readonly [string, ...string[]];
    } = {},
  ): Proc {
    const [file, ...args] = options.command ?? [process.execPath, options.script ?? ENTRY];
    if (options.spaces !== undefined) registerSpaces(home, options.spaces);
    const child = spawn(file, args, {
      env: serviceEnv(home, options.env),
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("the service did not start");
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.stdin.on("error", () => undefined);
    const exit = new Promise<Exit>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const proc: Proc = {
      pid,
      child,
      exit,
      stderr: () => err,
      send: (line) => {
        child.stdin.write(`${line}\n`);
      },
    };
    this.#started.push(proc);
    return proc;
  }

  /** Hard-kills one process (SIGKILL, or TerminateProcess on Windows) and waits for its exit. */
  async kill(proc: Proc): Promise<Exit> {
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
    return within(proc.exit, EXIT_MS, "the killed service did not exit");
  }

  /** Kills every process this object started that still runs, and waits for each. */
  async stopAll(): Promise<void> {
    await Promise.all(this.#started.map((proc) => this.kill(proc)));
    this.#started.length = 0;
  }
}

/** `promise`, or a rejection naming `what` after `ms`. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out: ${what}`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls `check` until it returns a value other than undefined, or fails after `ms`. */
export async function waitFor<T>(
  check: () => T | undefined,
  ms: number,
  what: string,
  every = 25,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** A temporary folder of this test, removed by its full name. Short, for Unix socket paths. */
export function tempRoot(label: string): { root: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `kh-${label}-`)));
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export interface ServiceJson {
  readonly instance: string;
  readonly install_id: string;
  readonly pid: number;
  readonly state: string;
  readonly endpoint: { readonly kind: "unix" | "pipe"; readonly path: string } | null;
  readonly [field: string]: unknown;
}

export const stateOf = (home: string): string => join(home, "state");
export const configOf = (home: string): string => join(home, "config");

/**
 * Registers `spaces` as the spaces of `home`'s service: machine.toml's `[[spaces]]`, written
 * through the config module's editor, replacing any machine.toml there. An entry given as a path
 * gets the ID in its folder's space.json, or a new one when the folder has none or another entry
 * took it (tests that register one space under two names): the hub opens such a folder only as
 * the space it names, so a space the folder does not hold yet needs its ID given.
 */
export function registerSpaces(
  home: string,
  spaces: readonly (string | { readonly path: string; readonly id: string })[],
  /** `[roots.<id>]` tables to write beside them: root ID to folder. */
  roots: Readonly<Record<string, string>> = {},
  /** More of machine.toml, written after them as it is (`[[instance]]` tables, instanceToml). */
  extra = "",
): void {
  const taken = new Set<string>();
  const edits: Edit[] = spaces.map((space) => {
    const path = typeof space === "string" ? space : space.path;
    let id: string | undefined = typeof space === "string" ? undefined : space.id;
    if (id === undefined) {
      try {
        const read = readManifest(path);
        id = read.state === "present" ? read.safety.space_id : undefined;
      } catch {
        id = undefined;
      }
    }
    if (id === undefined || taken.has(id)) id = newId("sp");
    taken.add(id);
    return { op: "append", array: "spaces", entries: { id, path } };
  });
  for (const [id, path] of Object.entries(roots)) {
    edits.push({ op: "add_table", table: ["roots", id], entries: { path } });
  }
  const result = applyEdits("", edits);
  if (!result.ok) throw new Error(`machine.toml not written: ${result.reason}`);
  mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(configOf(home), "machine.toml"), `${result.text}${extra}`, { mode: 0o600 });
}

/** One `[[instance]]` table of machine.toml (A4 3.2), its values written as TOML basic strings. */
export function instanceToml(
  fields: Readonly<
    Record<string, string | boolean | readonly string[] | Readonly<Record<string, string>>>
  >,
): string {
  const value = (v: string | boolean | readonly string[] | Readonly<Record<string, string>>) =>
    typeof v === "boolean"
      ? String(v)
      : typeof v === "string"
        ? JSON.stringify(v)
        : Array.isArray(v)
          ? `[${v.map((item) => JSON.stringify(item)).join(", ")}]`
          : `{ ${Object.entries(v)
              .map(([k, item]) => `${k} = ${JSON.stringify(item)}`)
              .join(", ")} }`;
  const lines = Object.entries(fields).map(([k, v]) => `${k} = ${value(v)}`);
  return `\n[[instance]]\n${lines.join("\n")}\n`;
}

/**
 * A Linux desktop where Ghostty and kitty are installed and no default names a terminal, the same
 * on every OS the tests run on: `auto` opens Ghostty, the first of Tasks' own order. Detection
 * only: nothing it names is ever started.
 */
export function twoTerminalsHost(): TerminalHost {
  const programs = ["/usr/bin/ghostty", "/usr/bin/kitty"];
  return {
    platform: "linux",
    path: ["/usr/bin"],
    terminalVar: undefined,
    home: "/home/mira",
    windowsApps: undefined,
    executable: (path) => programs.includes(path),
    readText: () => undefined,
    realpath: () => undefined,
  };
}

export function readServiceJson(home: string): ServiceJson | undefined {
  try {
    return JSON.parse(readFileSync(join(stateOf(home), "service.json"), "utf8")) as ServiceJson;
  } catch {
    return undefined;
  }
}

/** Waits until service.json says `ready` for `pid`. */
export const waitReady = (home: string, pid: number, ms = READY_MS): Promise<ServiceJson> =>
  waitFor(
    () => {
      const json = readServiceJson(home);
      return json?.state === "ready" && json.pid === pid ? json : undefined;
    },
    ms,
    `service ${String(pid)} ready`,
  );

/** The log's events, parsed. A line the service is still writing has no line end yet: it is left out. */
export function readLog(home: string): Record<string, unknown>[] {
  const path = join(stateOf(home), "logs", "service.log");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every file under `<state>/logs` and `<state>/crash`, as text. */
export function diagnostics(home: string): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = [];
  for (const folder of ["logs", "crash"]) {
    const dir = join(stateOf(home), folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      files.push({ file: `${folder}/${name}`, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return files;
}

/** The key a service of this install uses, as every client reads it: per connection. */
export const keyOf = (home: string): Buffer =>
  parseKey(readFileSync(join(stateOf(home), "ipc.key"), "utf8"));

/**
 * A CLI's rpc session with the service of `home` at `path`: a full tasks-local/1 handshake with
 * the key from ipc.key (M1.09's client). Not a TTY and no agent marker: the `cli-script` class.
 */
export function openSession(home: string, path: string, ms = 10_000): Promise<RpcSession> {
  return within(
    openRpc({
      path,
      key: keyOf(home),
      client: {
        kind: "cli",
        version: "0.0.0-test",
        build: "test",
        pid: process.pid,
        package: null,
        tty: { stdin: false, stdout: false },
      },
      context: { env: {} },
    }),
    ms,
    "the handshake",
  );
}

/**
 * The instance ID of the service that answers at `path`: from a full handshake, whose proofs the
 * client verified with the install's key, so only that install's running service can answer.
 */
export async function endpointInstance(home: string, path: string): Promise<string> {
  const session = await openSession(home, path);
  try {
    const status = (await session.call("service/status", {}, { timeoutMs: 10_000 })) as {
      instance?: string;
    };
    if (status.instance !== session.bound.service.instance) {
      throw new Error("the status names another instance than the handshake");
    }
    return session.bound.service.instance;
  } finally {
    session.close();
  }
}

/**
 * Linux: the per-user runtime folder a service of this install made, `/run/user/<uid>/tasks-<id>`,
 * removed by its full name. Under the fallback (`<state>/run/`) there is none outside the home.
 */
export function removeRuntimeDir(
  service:
    { readonly endpoint: { readonly kind: string; readonly path: string } | null } | undefined,
): void {
  const path = service?.endpoint?.path;
  if (path === undefined || service?.endpoint?.kind !== "unix") return;
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (/^\/run\/user\/\d+\/tasks-[0-9a-z]{10}$/.test(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Linux: the per-user runtime folder of the install whose home is `home`, under `base` (A2 3.2.1:
 * `<base>/<uid>/tasks-<install ID>`), by its full name, whether or not a service of it ran or still
 * has its service.json. Undefined on other systems and for a home without a state folder.
 */
export function runtimeDirOf(home: string, base: string = RUN_USER_BASE): string | undefined {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) return undefined;
  let state: string;
  try {
    state = realpathSync.native(stateOf(home));
  } catch {
    return undefined;
  }
  const id = installId(canonicalStatePath(state, "linux"));
  return posix.join(base, String(uid), `${PRODUCT_ID}-${id}`);
}

/**
 * Removes the runtime folder a service of `home` caused under `base`, by its full name: for a
 * test's cleanup, also after a test that failed or a service that was killed.
 */
export function removeRuntimeDirOf(home: string, base: string = RUN_USER_BASE): void {
  const dir = runtimeDirOf(home, base);
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * A runtime base of the test's own that stands in for `/run/user` (A2 3.2.1), given to a service
 * through its `runUserBase` start option: `<temp>/<uid>/` is made 0700, so on Linux the service
 * takes its per-user runtime folder there, in WSL and on CI too. Elsewhere the base is never used
 * (Windows has a pipe, macOS the state folder). `leftovers()` lists what is under `<base>/<uid>`;
 * `remove()` removes the base by its full name.
 */
export function testRuntimeBase(label: string): {
  readonly base: string;
  leftovers(): string[];
  remove(): void;
} {
  const temp = tempRoot(`run-${label}`);
  const uid = process.getuid?.();
  const user = uid === undefined ? undefined : join(temp.root, String(uid));
  if (user !== undefined) {
    mkdirSync(user, { mode: 0o700 });
    chmodSync(user, 0o700);
  }
  return {
    base: temp.root,
    leftovers: () => (user === undefined || !existsSync(user) ? [] : readdirSync(user).sort()),
    remove: temp.cleanup,
  };
}
