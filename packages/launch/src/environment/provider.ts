// Where the agent's environment comes from on this machine (A4 3.8): the service builds the base
// at each claim, and refreshes the Linux login-shell snapshot right before a terminal starts.
//
// - Linux and macOS: layer 1, the session, is read at each claim (`systemctl --user show-environment`,
//   3 s). Layer 2, the login-shell snapshot, is kept as `env-snapshot.json` (0600) in machine state,
//   never exported, and taken again before a launch when there is none, when the boot or the
//   session changed (a new login), or once it is a day old; doctor will refresh it too. A snapshot
//   has a hard deadline of 10 s; the shell runs in a minimal environment of the account's own
//   (never the service's), with TERM=dumb, the marker variable, stdin closed, the home folder as its
//   working folder, in a process group of its own that is killed at the deadline. When it times
//   out, fails, prints no markers or too much, the previous snapshot stays in use; with none at
//   all the base is the service's own environment through the allow-list (`service` kind).
// - Windows: the registry layers, read at each claim through Windows PowerShell 5.1 (5 s). When
//   they cannot be read, the base is the service's own environment through the allow-list.
//
// Nothing here logs a name or a value: the log gets the result word, a count and a time.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, posix } from "node:path";
import { powershellPath } from "../process.ts";
import type { AgentBase } from "../shim/environment.ts";
import { atomicWrite } from "@tasks/files";
import { captureOutput, type Capture } from "./capture.ts";
import {
  mergeLayers,
  newMarker,
  parseRegistryOutput,
  parseSessionEnvironment,
  parseSnapshot,
  REGISTRY_SCRIPT,
  registryEnvironment,
  RESOLVING,
  snapshotComplete,
  snapshotScript,
} from "./layers.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** A4 3.8: the snapshot's hard deadline. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;
/** The most a snapshot's shell may print. */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** The session layer's and the registry's deadlines. */
export const SESSION_TIMEOUT_MS = 3_000;
export const REGISTRY_TIMEOUT_MS = 5_000;
/** A snapshot is taken again once it is this old. */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
export const SNAPSHOT_FILE = "env-snapshot.json";

/** What a launch reads of the environment: the base at the claim, the session for a terminal. */
export interface EnvironmentSource {
  /** Before a terminal starts: bring the snapshot up to date when it is stale. Never throws. */
  prepare(): Promise<void>;
  /** At the claim: where the agent's environment starts. Never throws. */
  base(): Promise<AgentBase>;
  /**
   * `via_login_shell` (Linux), before a terminal starts: the person's environment as their login
   * shell gives it now, started in `folder` when it is still the directory of `identity` (held
   * open, `holdFolder`), over the session layer. Not stored. Undefined when none could be taken
   * (the base then applies). Never throws.
   */
  inFolder(folder: string, identity: FolderIdentityText): Promise<AgentBase | undefined>;
  /** The session layer now (Linux and macOS), for a terminal's own environment. Never throws. */
  session(): Promise<Record<string, string>>;
}

/** How one snapshot attempt ended, as the log and doctor say it. */
export const SNAPSHOT_OUTCOMES = [
  "ok",
  "timeout",
  "failed",
  "no_markers",
  "too_large",
  "no_shell",
] as const;
export type SnapshotOutcome = (typeof SNAPSHOT_OUTCOMES)[number];

export interface StoredSnapshot {
  readonly format: 1;
  /** Wall clock milliseconds. */
  readonly takenAt: number;
  /** Linux's boot ID when it was taken, or "" elsewhere. */
  readonly boot: string;
  /** SHA-256 of the session layer when it was taken: a new login changes it. */
  readonly session: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface UserEnvironmentOptions {
  readonly platform: NodeJS.Platform;
  /** The service's own environment: the account's names for the shell, and the fallback base. */
  readonly serviceEnv: Env;
  /** The install's machine state folder, which holds `env-snapshot.json`. */
  readonly stateDir: string;
  /** The account's home folder: the shell's working folder. */
  readonly home: string;
  /** The account's login shell, absolute. Default: SHELL, else the account's. */
  readonly loginShell?: string;
  /** Runs a helper. Tests pass a fake (a fake shell, a fake systemctl, a fake registry). */
  readonly capture?: Capture;
  /** `systemctl`, absolute, or undefined where there is none. Default: found on PATH. */
  readonly systemctl?: string | undefined;
  readonly now?: () => number;
  /** Linux's boot ID. Default: /proc/sys/kernel/random/boot_id. */
  readonly bootId?: () => string;
  readonly isSocket?: (path: string) => boolean;
  readonly log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  readonly snapshotTimeoutMs?: number;
  /** How `inFolder` holds the launch's folder for the shell. Default: `holdFolder`. Tests pass one. */
  readonly holdFolder?: (folder: string, identity: FolderIdentityText) => HeldFolder | undefined;
}

/** A folder's identity as a launch's check carries it (places.ts FolderCheck): decimal text. */
export interface FolderIdentityText {
  readonly dev: string;
  readonly ino: string;
}

/** A folder held open for a helper: the working folder to start it with, and the release. */
export interface HeldFolder {
  readonly cwd: string;
  close(): void;
}

/**
 * Linux: the launch's very folder, held open by a descriptor whose identity is the one the launch
 * resolved, given to the helper as `/proc/self/fd/<n>`. The child enters that path after the fork,
 * where it names the directory the descriptor holds, so a path swapped after the launch resolved it
 * never decides where the person's profile runs. The last component is opened without following a
 * link. Undefined when the folder is not that directory any more, or where there is no `/proc`.
 */
export function holdFolder(folder: string, identity: FolderIdentityText): HeldFolder | undefined {
  // Windows has neither flag; this is for Linux (and its kin) only.
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fsConstants as Partial<typeof fsConstants>;
  if (O_RDONLY === undefined || O_DIRECTORY === undefined || O_NOFOLLOW === undefined) {
    return undefined;
  }
  let fd: number;
  try {
    fd = openSync(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const found = fstatSync(fd, { bigint: true });
    const same =
      found.isDirectory() &&
      found.dev.toString() === identity.dev &&
      found.ino.toString() === identity.ino;
    const through = `/proc/self/fd/${String(fd)}`;
    if (same && statSync(through).isDirectory()) {
      return {
        cwd: through,
        close: () => {
          closeSync(fd);
        },
      };
    }
  } catch {
    // No /proc, or the descriptor cannot be read: not held.
  }
  closeSync(fd);
  return undefined;
}

const isSocketPath = (path: string): boolean => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};

const readBootId = (): string => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
};

/** The first executable named `name` in a POSIX PATH, or undefined. */
export function findOnPosixPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(":")) {
    if (!posix.isAbsolute(dir)) continue;
    const file = posix.join(dir, name);
    try {
      const found = statSync(file);
      if (found.isFile() && (found.mode & 0o111) !== 0) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The account's login shell: SHELL when absolute, else the account's entry, else /bin/sh. */
export function loginShellOf(env: Env): string {
  const fromEnv = env["SHELL"];
  if (fromEnv !== undefined && posix.isAbsolute(fromEnv)) return fromEnv;
  try {
    const shell = userInfo().shell;
    if (shell !== null && posix.isAbsolute(shell)) return shell;
  } catch {
    // No entry in the user database.
  }
  return "/bin/sh";
}

const hashOf = (env: Readonly<Record<string, string>>): string =>
  createHash("sha256")
    .update(
      Object.entries(env)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join("\0"),
    )
    .digest("hex");

/** A stored snapshot, checked; undefined when the file is missing, damaged or too large. */
export function readStoredSnapshot(path: string): StoredSnapshot | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    if (size > SNAPSHOT_MAX_BYTES * 2) return undefined;
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    const value = JSON.parse(buffer.subarray(0, read).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const { format, takenAt, boot, session, env } = value as Record<string, unknown>;
    if (format !== 1 || typeof takenAt !== "number" || !Number.isSafeInteger(takenAt)) {
      return undefined;
    }
    if (typeof boot !== "string" || typeof session !== "string") return undefined;
    if (typeof env !== "object" || env === null || Array.isArray(env)) return undefined;
    const entries = Object.entries(env as Record<string, unknown>);
    if (!entries.every(([, v]) => typeof v === "string")) return undefined;
    return { format: 1, takenAt, boot, session, env: env as Record<string, string> };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The environment of this machine's account, as A4 3.8 builds it. */
export class UserEnvironment implements EnvironmentSource {
  readonly #o: UserEnvironmentOptions;
  readonly #capture: Capture;
  readonly #now: () => number;
  readonly #file: string;
  #snapshot: StoredSnapshot | undefined;
  #loaded = false;
  #refreshing: Promise<void> | undefined;

  constructor(options: UserEnvironmentOptions) {
    this.#o = options;
    this.#capture = options.capture ?? captureOutput;
    this.#now = options.now ?? Date.now;
    this.#file = join(options.stateDir, SNAPSHOT_FILE);
  }

  get #posix(): boolean {
    return this.#o.platform !== "win32";
  }

  /** The snapshot in use, for doctor and tests. Holds values: never logged. */
  snapshot(): StoredSnapshot | undefined {
    this.#load();
    return this.#snapshot;
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#snapshot = readStoredSnapshot(this.#file);
  }

  async session(): Promise<Record<string, string>> {
    if (!this.#posix) return {};
    const systemctl =
      "systemctl" in this.#o
        ? this.#o.systemctl
        : findOnPosixPath("systemctl", this.#o.serviceEnv["PATH"]);
    if (systemctl === undefined) return {};
    const result = await this.#capture({
      argv: [systemctl, "--user", "show-environment"],
      env: this.#minimalEnv({}),
      timeoutMs: SESSION_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
    }).catch(() => undefined);
    if (result?.kind !== "done" || result.code !== 0) return {};
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.output);
    } catch {
      return {};
    }
    return parseSessionEnvironment(text);
  }

  async prepare(): Promise<void> {
    if (!this.#posix) return;
    // One refresh at a time: a second launch meanwhile waits for the same one.
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    await this.#refreshing;
  }

  async #refresh(): Promise<void> {
    try {
      this.#load();
      const session = await this.session();
      const boot = (this.#o.bootId ?? readBootId)();
      const key = hashOf(session);
      const old = this.#snapshot;
      const fresh =
        old !== undefined &&
        old.boot === boot &&
        old.session === key &&
        Math.abs(this.#now() - old.takenAt) < SNAPSHOT_MAX_AGE_MS;
      if (fresh) return;
      const taken = await this.take(session);
      this.#o.log?.("launch.env_snapshot", {
        result: taken.outcome,
        ms: taken.ms,
        variables: taken.env === undefined ? 0 : Object.keys(taken.env).length,
        previous: old !== undefined,
      });
      if (taken.env === undefined) return; // The previous snapshot, if any, stays in use.
      const stored: StoredSnapshot = {
        format: 1,
        takenAt: this.#now(),
        boot,
        session: key,
        env: taken.env,
      };
      try {
        atomicWrite(this.#file, `${JSON.stringify(stored)}\n`);
      } catch {
        this.#o.log?.("launch.env_snapshot", { result: "not_stored", ms: 0, variables: 0 });
      }
      this.#snapshot = stored;
    } catch {
      // Never a reason to fail a launch: the base falls back below.
    }
  }

  async inFolder(folder: string, identity: FolderIdentityText): Promise<AgentBase | undefined> {
    if (!this.#posix) return undefined;
    try {
      const session = await this.session();
      // The profile runs only in the very folder the launch resolved (A4 3.3's rule for
      // the agent, applied to the shell): held open and checked first, else no snapshot at all.
      const held = (this.#o.holdFolder ?? holdFolder)(folder, identity);
      if (held === undefined) {
        this.#o.log?.("launch.env_snapshot", {
          result: "folder_changed",
          ms: 0,
          variables: 0,
          in_folder: true,
        });
        return undefined;
      }
      let taken: Awaited<ReturnType<UserEnvironment["take"]>>;
      try {
        taken = await this.take(session, held.cwd);
      } finally {
        held.close();
      }
      this.#o.log?.("launch.env_snapshot", {
        result: taken.outcome,
        ms: taken.ms,
        variables: taken.env === undefined ? 0 : Object.keys(taken.env).length,
        in_folder: true,
      });
      if (taken.env === undefined) return undefined;
      return {
        kind: "user",
        env: mergeLayers(session, taken.env, this.#o.isSocket ?? isSocketPath),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * One login-shell snapshot (A4 3.8 layer 2): `$SHELL -lic` with the fixed script, in the
   * account's minimal environment plus the session layer, with `cwd` (default: the home folder)
   * as its working folder.
   */
  async take(
    session: Readonly<Record<string, string>> = {},
    cwd: string = this.#o.home,
  ): Promise<{ outcome: SnapshotOutcome; ms: number; env?: Record<string, string> }> {
    const shell = this.#o.loginShell ?? loginShellOf(this.#o.serviceEnv);
    if (!posix.isAbsolute(shell)) return { outcome: "no_shell", ms: 0 };
    const marker = newMarker();
    const result = await this.#capture({
      argv: [shell, "-lic", snapshotScript(marker)],
      env: this.#minimalEnv({ ...session, SHELL: shell, TERM: "dumb", [RESOLVING]: "1" }),
      cwd,
      timeoutMs: this.#o.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS,
      maxBytes: SNAPSHOT_MAX_BYTES,
      complete: (output) => snapshotComplete(output, marker),
    }).catch(() => ({ kind: "failed" as const, ms: 0 }));
    if (result.kind !== "done") return { outcome: result.kind, ms: result.ms };
    const env = parseSnapshot(result.output, marker);
    if (env === undefined) {
      return { outcome: result.code === 0 ? "no_markers" : "failed", ms: result.ms };
    }
    return { outcome: "ok", ms: result.ms, env };
  }

  /**
   * The account's own names for a helper: home, user, the service's PATH and locale, and the
   * account's runtime folder and user bus (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`), without
   * which `systemctl --user` cannot reach the user manager. The service's other variables never
   * reach a helper, so none reaches the snapshot either.
   */
  #minimalEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
    const env: Record<string, string> = {};
    const from = this.#o.serviceEnv;
    let account: { username: string } | undefined;
    try {
      account = userInfo();
    } catch {
      account = undefined;
    }
    env["HOME"] = this.#o.home;
    const user = from["USER"] ?? account?.username;
    if (user !== undefined) {
      env["USER"] = user;
      env["LOGNAME"] = from["LOGNAME"] ?? user;
    }
    env["PATH"] = from["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
    for (const [name, value] of Object.entries(from)) {
      if (value === undefined) continue;
      if (/^(LANG|LANGUAGE|LC_[A-Z]+|TZ|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/.test(name)) {
        env[name] = value;
      }
    }
    return { ...env, ...extra };
  }

  async base(): Promise<AgentBase> {
    if (!this.#posix) return this.#registryBase();
    this.#load();
    const session = await this.session();
    const snapshot = this.#snapshot;
    if (snapshot === undefined) {
      return { kind: "service", env: { ...this.#o.serviceEnv, ...session } };
    }
    return {
      kind: "user",
      env: mergeLayers(session, snapshot.env, this.#o.isSocket ?? isSocketPath),
    };
  }

  async #registryBase(): Promise<AgentBase> {
    const result = await this.#capture({
      argv: [
        powershellPath(this.#o.serviceEnv),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        REGISTRY_SCRIPT,
      ],
      env: windowsHelperEnv(this.#o.serviceEnv),
      timeoutMs: REGISTRY_TIMEOUT_MS,
      maxBytes: SNAPSHOT_MAX_BYTES,
    }).catch(() => undefined);
    const parsed =
      result?.kind === "done" && result.code === 0
        ? parseRegistryOutput(result.output.toString("ascii"))
        : undefined;
    if (parsed === undefined) {
      this.#o.log?.("launch.env_registry", {
        result: result?.kind ?? "failed",
        ms: result?.ms ?? 0,
      });
      return { kind: "service", env: this.#o.serviceEnv };
    }
    return {
      kind: "user",
      env: registryEnvironment(parsed.system, parsed.user, this.#o.serviceEnv),
    };
  }
}

/** What Windows PowerShell needs to start: the system's names, nothing of the person's. */
function windowsHelperEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  const wanted =
    /^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP|USERPROFILE|USERNAME|PATH|PATHEXT|COMSPEC)$/i;
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && wanted.test(name)) out[name] = value;
  }
  return out;
}

/** A fixed base for tests and for a service started without one: never a real profile. */
export class FixedEnvironment implements EnvironmentSource {
  readonly #base: AgentBase;
  readonly #session: Record<string, string>;
  prepared = 0;
  constructor(base: AgentBase, session: Record<string, string> = {}) {
    this.#base = base;
    this.#session = session;
  }
  prepare(): Promise<void> {
    this.prepared += 1;
    return Promise.resolve();
  }
  base(): Promise<AgentBase> {
    return Promise.resolve(this.#base);
  }
  /** Never a person's shell in a test: no snapshot in the folder, so the fixed base applies. */
  inFolder(): Promise<AgentBase | undefined> {
    return Promise.resolve(undefined);
  }
  session(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.#session });
  }
}
