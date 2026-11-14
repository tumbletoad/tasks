// Finding the service (A2 3.6.1): the install's state and cache folders by A2 3.2.1 and 3.2.2,
// then `<state>/service.json` for the endpoint and `<state>/ipc.key` for the key, read again for
// every connection so a restart or a key rotation needs nothing else. The folder rules are the
// hub's (packages/service/src/hub/paths.ts); a test checks that both give the same folders.
import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { posix, win32 } from "node:path";
import { parseKey } from "../protocol/index.ts";
import { HOME_VAR, INSTALL_NAME, KEY_FILE, SERVICE_FILE } from "./names.ts";
import { Unavailable } from "./unavailable.ts";

/** What the folders depend on. Read once from the process by `hostFacts()`. */
export interface HostFacts {
  readonly platform: NodeJS.Platform;
  /** Only USERPROFILE (Windows), HOME (a last resort) and TASKS_HOME are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The account's home folder from the OS user database, when it has one. */
  readonly accountHome: string | undefined;
}

export function hostFacts(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): HostFacts {
  let accountHome: string | undefined;
  try {
    accountHome = userInfo().homedir;
  } catch {
    // No entry in the user database (some containers): HOME is the last resort.
  }
  return { platform, env, accountHome };
}

export interface Folders {
  readonly state: string;
  readonly cache: string;
}

const text = (facts: HostFacts, name: string): string | undefined => {
  const value = facts.env[name];
  return value === undefined || value === "" ? undefined : value;
};

/**
 * The state and cache folders (A2 3.2.1): `state` and `cache` of the data folder,
 * which is TASKS_HOME for a separate install and `~/.tasks` otherwise, on every OS. The home
 * folder comes from the account (Linux, macOS) or USERPROFILE (Windows), never from XDG_*
 * variables. Throws when there is no home folder or TASKS_HOME is not absolute.
 */
export function installFolders(facts: HostFacts): Folders {
  const path = facts.platform === "win32" ? win32 : posix;
  const separate = text(facts, HOME_VAR);
  let data: string;
  if (separate !== undefined) {
    if (!path.isAbsolute(separate)) throw new Error("TASKS_HOME is not absolute");
    data = path.resolve(separate);
  } else {
    const candidates =
      facts.platform === "win32"
        ? [text(facts, "USERPROFILE"), facts.accountHome]
        : [facts.accountHome, text(facts, "HOME")];
    const found = candidates.find((value) => value !== undefined && path.isAbsolute(value));
    if (found === undefined) throw new Error("no home folder");
    data = path.join(path.resolve(found), `.${INSTALL_NAME}`);
  }
  return { state: path.join(data, "state"), cache: path.join(data, "cache") };
}

/** service.json is a few hundred bytes. A larger file is not the hub's. */
const SERVICE_FILE_MAX = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readSmall(path: string, max: number): string {
  if (statSync(path).size > max) throw Object.assign(new Error("too large"), { code: "EFBIG" });
  return readFileSync(path, "utf8");
}

/** A fixed word for an fs error, never its message (which names the path). */
function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "read_failed";
}

/**
 * The endpoint path from `<state>/service.json`. No file is `not_running`. A file without an
 * endpoint yet (the service is binding) is `starting`.
 */
export function readEndpoint(state: string, platform: NodeJS.Platform): string {
  const path = (platform === "win32" ? win32 : posix).join(state, SERVICE_FILE);
  let record: unknown;
  try {
    record = JSON.parse(readSmall(path, SERVICE_FILE_MAX));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Unavailable("not_running", "bad_service_file");
    const code = codeOf(error);
    if (code === "ENOENT") throw new Unavailable("not_running", "no_service_file");
    throw new Unavailable("unreachable", code);
  }
  if (!isObject(record)) throw new Unavailable("not_running", "bad_service_file");
  const endpoint = record["endpoint"];
  if (endpoint === null || endpoint === undefined || record["state"] === "starting") {
    throw new Unavailable("starting", "starting");
  }
  const where = isObject(endpoint) ? endpoint["path"] : undefined;
  const valid =
    typeof where === "string" &&
    (platform === "win32" ? /^\\\\[.?]\\pipe\\[^\\]+$/.test(where) : posix.isAbsolute(where));
  if (!valid) throw new Unavailable("unreachable", "bad_endpoint");
  return where;
}

/** The 32 bytes of `<state>/ipc.key`. A missing or bad key is a doctor-level problem (A2 3.6.1). */
export function readKey(state: string, platform: NodeJS.Platform): Buffer {
  const path = (platform === "win32" ? win32 : posix).join(state, KEY_FILE);
  try {
    return parseKey(readSmall(path, 1024));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Unavailable("unreachable", typeof code === "string" ? codeOf(error) : "bad_key");
  }
}
