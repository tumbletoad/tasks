// Machine-local locations (A2 3.2.1, 3.2.2) and the install ID that namespaces them (A2 S30).
//
// Two places per machine, the same on every OS (A2 3.2.1):
// - the person's data and configuration in `~/.tasks/` (`%USERPROFILE%\.tasks\`): `config/`,
//   `state/`, `cache/` and `spaces/`. Removing or updating the program never touches it.
// - the program in `~/.local/share/tasks/` (`versions/` and `current`), with the command in
//   `~/.local/bin/` (on Windows the same two under %USERPROFILE%).
//
// The rules that matter:
// - Home comes from the account, not the environment: the passwd entry on Linux and macOS, so a
//   snap or Flatpak parent that sets HOME to a private folder still finds the same state folder.
//   Windows uses %USERPROFILE%, which packaged processes see unchanged. AppData is never used.
// - XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_CACHE_HOME and XDG_RUNTIME_DIR are never read. The
//   runtime folder comes from the UID.
// - TASKS_HOME puts the whole install, program and data, under one folder (a test install, D18).
// - Every name derives from the product constants (packages/brand).
//
// The functions here are pure over HostFacts, so every OS's layout is testable on every OS: they
// join paths with the target OS's own rules (path.win32 or path.posix).
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { posix, win32 } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "@tasks/bridge/protocol";
import { DATA_FOLDER, envVar, PRODUCT_ID, SPACES_FOLDER } from "@tasks/brand";
/**
 * A1's ID alphabet (Crockford's base32, lower case): storage's ID_ALPHABET, which paths.test.ts
 * holds this equal to. Kept here so the CLI finds the service without loading storage.
 */
export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** The service's files in `<state>` that clients read (A2 3.2.3, 3.6.1). */
export const SERVICE_JSON = "service.json";
export const IPC_KEY = "ipc.key";

/** What the layout depends on. Read once from the process by hostFacts(). */
export interface HostFacts {
  readonly platform: NodeJS.Platform;
  /** The environment. Only USERPROFILE (Windows), HOME (a last resort) and TASKS_HOME are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The account's home folder from the OS user database (os.userInfo()), when it has one. */
  readonly accountHome: string | undefined;
  /** The user's UID on Linux and macOS. */
  readonly uid: number | undefined;
}

export function hostFacts(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): HostFacts {
  let accountHome: string | undefined;
  try {
    accountHome = userInfo().homedir;
  } catch {
    // No entry in the user database (some containers): HOME is the last resort below.
  }
  return { platform, env, accountHome, uid: process.getuid?.() };
}

/** The folders of one install (A2 3.2.1). All absolute. */
export interface Layout {
  readonly platform: NodeJS.Platform;
  /** `<root>`: the program's install root, with `versions/` and `current` (A2 3.12.2). */
  readonly root: string;
  /** The folder of the command: `tasks` (a link) on Linux and macOS, the stable launchers on Windows. */
  readonly bin: string;
  /** The person's data and configuration. No command removes anything in it unasked. */
  readonly data: string;
  readonly config: string;
  readonly state: string;
  readonly cache: string;
  readonly logs: string;
  readonly crash: string;
  readonly tmp: string;
  /** A4's Tasks-owned work folders. */
  readonly workdirs: string;
  /** The folder a new space goes into by default: `<data>/spaces/<slug>`. */
  readonly spaces: string;
  /** TASKS_HOME when this is a separate install, else undefined. */
  readonly home: string | undefined;
}

/** The file in a TASKS_HOME install's root that makes the launchers set TASKS_HOME (A2 3.12.3). */
export const HOME_MARKER = "home.marker";

/** A layout that cannot be resolved: no home folder, or a TASKS_HOME that is not absolute. */
export class LayoutError extends Error {
  override readonly name = "LayoutError";
}

export const TASKS_HOME = envVar("HOME");

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The text of an environment variable, or undefined when it is unset or empty. */
const envText = (facts: HostFacts, name: string): string | undefined => {
  const value = facts.env[name];
  return value === undefined || value === "" ? undefined : value;
};

/** The user's home folder by A2 3.2.2 rule 1. */
export function homeFolder(facts: HostFacts): string {
  const path = pathFor(facts.platform);
  const candidates =
    facts.platform === "win32"
      ? [envText(facts, "USERPROFILE"), facts.accountHome]
      : [facts.accountHome, envText(facts, "HOME")];
  const home = candidates.find((value) => value !== undefined && path.isAbsolute(value));
  if (home === undefined) throw new LayoutError("No home folder for this account");
  return path.resolve(home);
}

/**
 * The folders of this install (A2 3.2.1, 3.2.2 rule 3): the program in
 * `~/.local/share/tasks`, the command in `~/.local/bin`, the data in `~/.tasks`, on every OS. A
 * TASKS_HOME install keeps all three in its one root: `<root>/bin` and the data folders beside
 * `versions/` and `current`.
 */
export function resolveLayout(facts: HostFacts): Layout {
  const path = pathFor(facts.platform);
  const separate = envText(facts, TASKS_HOME);
  if (separate !== undefined && !path.isAbsolute(separate)) {
    throw new LayoutError(`${TASKS_HOME} must be an absolute path`);
  }
  let root: string;
  let bin: string;
  let data: string;
  if (separate !== undefined) {
    root = path.resolve(separate);
    bin = path.join(root, "bin");
    data = root;
  } else {
    const home = homeFolder(facts);
    root = path.join(home, ".local", "share", PRODUCT_ID);
    bin = path.join(home, ".local", "bin");
    data = path.join(home, DATA_FOLDER);
  }
  const state = path.join(data, "state");
  return {
    platform: facts.platform,
    root,
    bin,
    data,
    config: path.join(data, "config"),
    state,
    cache: path.join(data, "cache"),
    logs: path.join(state, "logs"),
    crash: path.join(state, "crash"),
    tmp: path.join(state, "tmp"),
    workdirs: path.join(state, "workdirs"),
    spaces: path.join(data, SPACES_FOLDER),
    home: separate === undefined ? undefined : root,
  };
}

/** Where a new space goes unless the person picks a folder: `<spaces>/<the name in lower case>`. */
export function defaultSpaceFolder(layout: Pick<Layout, "platform" | "spaces">, name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return pathFor(layout.platform).join(layout.spaces, slug === "" ? "space" : slug);
}

// ---------------------------------------------------------------------------------------------
// The install ID (A2 3.2.1, S30)

/** Characters in an install ID: 10 base32 characters, 50 bits of the hash. */
export const INSTALL_ID_LENGTH = 10;

const INSTALL_ID = new RegExp(`^[${ID_ALPHABET}]{${String(INSTALL_ID_LENGTH)}}$`);

export const isInstallId = (value: unknown): value is string =>
  typeof value === "string" && INSTALL_ID.test(value);

/**
 * The canonical form of a state path that the OS has already resolved (`fs.realpathSync.native`):
 * no trailing separator, and on Windows case-folded, so every spelling of one folder gives one ID.
 */
export function canonicalStatePath(resolved: string, platform: NodeJS.Platform): string {
  const path = pathFor(platform);
  let text = path.normalize(resolved);
  const root = path.parse(text).root;
  while (text.length > root.length && (text.endsWith(path.sep) || text.endsWith("/"))) {
    text = text.slice(0, -1);
  }
  return platform === "win32" ? text.toLowerCase() : text;
}

/**
 * The install ID: the first 10 characters of the lowercase, unpadded base32 of SHA-256 over
 * "tasks-install\n" and the canonical state path. The alphabet is A1's ID alphabet (Crockford's,
 * lowercase), which A2's example `q7mw2c4k9x` uses, so an install ID reads like Tasks's other IDs.
 */
export function installId(canonicalState: string): string {
  const digest = createHash("sha256").update(`${PRODUCT_ID}-install\n${canonicalState}`).digest();
  // The first 50 bits, most significant first: 7 bytes hold 56 of them.
  let bits = 0n;
  for (const byte of digest.subarray(0, 7)) bits = (bits << 8n) | BigInt(byte);
  bits >>= 6n;
  let id = "";
  for (let i = INSTALL_ID_LENGTH - 1; i >= 0; i -= 1) {
    id += ID_ALPHABET.charAt(Number((bits >> BigInt(5 * i)) & 31n));
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// Names the install ID gives: the runtime folder, the socket or pipe, the launch folders

/** The longest Unix socket path in bytes: tasks-local/1's bound, which its serve refuses past. */
export { MAX_SOCKET_PATH_BYTES };

export const SOCKET_FILE = `${PRODUCT_ID}.sock`;

export type UnixEndpointPlan = {
  readonly kind: "unix";
  /** The 0700 folder that holds the socket. */
  readonly dir: string;
  readonly path: string;
  /** `run-user`: the per-user runtime folder named with the install ID. `state`: `<state>/run/`. */
  readonly runtime: "run-user" | "state";
};

export type PipeEndpointPlan = {
  readonly kind: "pipe";
  /** `\\.\pipe\tasks-<install-id>-`: the instance ID, new at every start, completes the name. */
  readonly prefix: string;
};

export interface RuntimeNames {
  readonly endpoint: UnixEndpointPlan | PipeEndpointPlan;
  /** A4's launch folders. */
  readonly launch: string;
  /** Linux: `/run/user/<uid>/tasks-<install-id>/` when the per-user runtime folder is usable. */
  readonly runtimeDir: string | undefined;
}

/** The per-user runtime folders: `/run/user` (A2 3.2.1). Tests pass another. */
export const RUN_USER_BASE = "/run/user";

/**
 * The runtime names of one install (A2 3.2.1, 3.4). On Linux the per-user runtime folder is
 * `<base>/<uid>`, never XDG_RUNTIME_DIR, and it is used only when `usable` says it is a private
 * folder of this user. Otherwise the socket and the launch folders go under `<state>`.
 */
export function runtimeNames(
  layout: Layout,
  id: string,
  facts: Pick<HostFacts, "platform" | "uid">,
  usable: (dir: string) => boolean,
  runUserBase: string = RUN_USER_BASE,
): RuntimeNames {
  if (!isInstallId(id)) throw new LayoutError("Invalid install ID");
  if (facts.platform === "win32") {
    return {
      endpoint: { kind: "pipe", prefix: `\\\\.\\pipe\\${PRODUCT_ID}-${id}-` },
      launch: win32.join(layout.state, "launch"),
      runtimeDir: undefined,
    };
  }
  const userDir =
    facts.platform === "linux" && facts.uid !== undefined
      ? posix.join(runUserBase, String(facts.uid))
      : undefined;
  if (userDir !== undefined && usable(userDir)) {
    const runtimeDir = posix.join(userDir, `${PRODUCT_ID}-${id}`);
    return {
      endpoint: {
        kind: "unix",
        dir: runtimeDir,
        path: posix.join(runtimeDir, SOCKET_FILE),
        runtime: "run-user",
      },
      launch: posix.join(runtimeDir, "launch"),
      runtimeDir,
    };
  }
  const dir = posix.join(layout.state, "run");
  return {
    endpoint: { kind: "unix", dir, path: posix.join(dir, SOCKET_FILE), runtime: "state" },
    launch: posix.join(layout.state, "launch"),
    runtimeDir: undefined,
  };
}

/** The pipe name for one start: the install ID, then the instance ID (A2 3.2.3). */
export const pipeName = (plan: PipeEndpointPlan, instance: string): string =>
  `${plan.prefix}${instance}`;
