// The shim's machine state: one folder per launch
// under the install's launch folders, `<launch root>/<launch ID>/`, 0700, holding
// - `launch.json` (0600, replaced atomically, written by the service): the spawn plan (argv, the
//   folder or none, the instance's environment, the title), from dispatch the folder resolved right
//   before the launch with the check the shim runs there, the ticket's hash and whether its shim
//   role is spent, and once claimed the attachment credential's hash with the shim's PID and start
//   time;
// - `exit.json` (written atomically by the shim when the service cannot be reached).
// The folder goes with the launch's end, and nothing of the launch stays. None of this enters a space: a space holds IDs and codes only. The launch root is
// on Linux `/run/user/<uid>/ttasks-<install>/launch/` (tmpfs, gone at logout, when no shim
// can be left either), Windows `<state>\launch\`.
//
// Folders are named after the launch ID, not its reference: a reference is unique within one space
// only, and one machine's launch root holds the launches of all its spaces.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, makeDir } from "@ttasks/files";
import { isBuiltInTarget, type BuiltInTargetId } from "../catalogue.ts";
import { isLaunchRef } from "../intents.ts";
import { RESOLVE_REASONS, type FolderCheck, type ResolveReason } from "../places.ts";
import { LAUNCH_ID, SESSION_ID, SESSION_UUID, TASK_ID } from "../store.ts";
import { isHash } from "./secrets.ts";
import {
  AFTER_EXIT_MODES,
  checkFolderCheck,
  AGENT_ENV_NAME,
  FAILED_REASONS,
  isBoundedText,
  isPid,
  NOTICES,
  REPLY_BOUNDS,
  START_TIME,
  type AfterExit,
  type ExitFile,
  type FailedReason,
  type Notice,
} from "./wire.ts";

/** A plan's folder: the task's or its project's folder on this machine. */
export interface PlanFolder {
  /** As the space stores it, the home as `~`: what the person is shown. */
  readonly stored: string;
  /** The absolute path this machine opens, `~` expanded. */
  readonly path: string;
  /**
   * The directory whose marker the click checked (identityKey): the launch opens nothing in
   * another one found at the path later. Absent: no marker was checked.
   */
  readonly at?: string;
}

/** An identityKey: `<volume>:<file number>`. */
const IDENTITY_KEY = /^[0-9]{1,20}:[0-9]{1,20}$/u;

/** What the claim's reply hands the shim to start, kept from the click. */
export interface SpawnPlan {
  /** The absolute executable first: the route's argv. */
  readonly argv: readonly string[];
  /**
   * Where the agent works: the task's or its project's folder on this machine, or null for the
   * space's work folder (folder.ts). Resolved right before the launch, never at the click only:
   * the folder is a fact of this machine's tree at that moment.
   */
  readonly folder: PlanFolder | null;
  /** The instance's `env` (layer 3 of the agent's environment). */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The app whose home the instance has of its own: the person's variables that say which account
   * it uses are not given (agentSetup). Absent: the default home, which gets them all.
   */
  readonly ownHome?: BuiltInTargetId;
  /** For the terminal title and the announce line. */
  readonly title: string;
  readonly afterExit: AfterExit;
  /**
   * The instance's `via_login_shell` (Linux and macOS): the agent's environment starts
   * from a login-shell snapshot the service takes in the task's folder right before the launch,
   * not from the stored one. The agent itself still starts directly. Absent: false.
   */
  readonly loginShell?: boolean;
  /**
   * The argv elements the resolved folder fills at the claim (`{cwd}`, Codex's `-C`):
   * the folder is resolved right before the launch, after the plan was written, so those elements
   * are empty here. Absent: none.
   */
  readonly folderArgs?: readonly number[];
  /**
   * Codex's reference match: the home whose session files the service reads for this
   * launch's thread ID, after the agent started. Absent: no match.
   */
  readonly match?: { readonly home: string };
  /** A fixed line the shim prints under its announce line (wire.ts NOTICES). Absent: none. */
  readonly notice?: Notice;
}

/** One launch's machine state. */
export interface LaunchFile {
  readonly format: 1;
  readonly space: string;
  readonly launch: string;
  readonly reference: string;
  readonly task: string | null;
  /** When the plan was written, wall clock milliseconds. */
  readonly createdAt: number;
  readonly plan: SpawnPlan;
  /**
   * The folder resolved at dispatch, right before the terminal started in it, with what the shim
   * checks there: written with the ticket, so a claim always has the check its terminal's folder
   * was resolved with.
   */
  readonly folder?: { readonly path: string; readonly check: FolderCheck };
  /** Issued at dispatch, when the ticket first leaves the service. */
  readonly ticket?: {
    readonly hash: string;
    readonly issuedAt: number;
    readonly shimUsed: boolean;
  };
  /** Issued inside the claim, before its reply leaves. */
  readonly attachment?: { readonly hash: string; readonly pid: number; readonly startTime: string };
  /** The agent, as `launch.started` reported it. */
  readonly agent?: { readonly pid: number; readonly startedAt: number };
  /** The agent's app at the click, by the name its entry's `--app` carries. */
  readonly app?: string;
  /** The home folder the agent is started on, as setup names that home. */
  readonly home?: string;
  /** The session this launch is (`ShimHost.prepare`). */
  readonly session?: string;
  /** The session ID the click preset for the agent (Claude Code's `--session-id`). */
  readonly preset?: string;
  /**
   * The copy of the space the click was made in (the service's copy token): the launch's session
   * and reports belong to that copy only.
   */
  readonly copy?: string;
}

/** The shim's machine state, as the host reads and writes it. */
export interface RecordStore {
  list(): readonly LaunchFile[];
  get(launch: string): LaunchFile | undefined;
  /** Durable when it returns. */
  put(file: LaunchFile): void;
  /** The launch's folder and everything in it. */
  remove(launch: string): void;
  /** The shim's `exit.json` for the launch, when there is a valid one. */
  readExit(launch: string): ExitFile | undefined;
  /** Where the shim writes `exit.json`. */
  exitPath(launch: string): string;
}

/** The largest launch file read back, and so the largest written. */
const MAX_FILE = 1024 * 1024;
/**
 * The largest plan, as UTF-8 JSON: a quarter of a launch file, so a plan accepted at the click
 * always fits with its ticket, attachment and agent, and is always read back after a restart.
 */
export const PLAN_MAX_BYTES = 256 * 1024;
const INSTANT_MAX = 253_402_300_799_999;
/** A space's ID. */
export const SPACE_ID = /^sp_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= INSTANT_MAX;
const isText = isBoundedText;
/** The instance's `env`: at most half of the names the reply may carry, the rest is the base's. */
const isEnv = (value: unknown): value is Record<string, string> =>
  isObject(value) &&
  Object.keys(value).length <= REPLY_BOUNDS.env / 2 &&
  Object.entries(value).every(
    ([name, v]) => AGENT_ENV_NAME.test(name) && isText(v, REPLY_BOUNDS.value),
  );

// eslint-disable-next-line no-control-regex -- the controls are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** A path a plan's folder holds: text without a control character, at most 4,096 characters. */
const isFolderText = (value: unknown): value is string =>
  isText(value, REPLY_BOUNDS.path) && value !== "" && !CONTROL.test(value);

/**
 * A plan's folder, checked as text, or null. Whether the path is a folder of this machine is the
 * resolve's to say, right before the launch.
 */
export function checkPlanFolder(value: unknown): PlanFolder | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { stored, path, at, ...rest } = value;
  if (Object.keys(rest).length > 0 || !isFolderText(stored) || !isFolderText(path)) {
    return undefined;
  }
  if (at === undefined) return { stored, path };
  return typeof at === "string" && IDENTITY_KEY.test(at) ? { stored, path, at } : undefined;
}

/** The plan, checked: a plan that is not one starts nothing. */
export function checkPlan(value: unknown): SpawnPlan | undefined {
  if (!isObject(value)) return undefined;
  const { argv, env, title, afterExit, loginShell, folderArgs, match, ownHome, notice } = value;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > REPLY_BOUNDS.argv) {
    return undefined;
  }
  if (!argv.every((a): a is string => isText(a, REPLY_BOUNDS.arg))) return undefined;
  const folder = checkPlanFolder(value["folder"]);
  if (folder === undefined || !isEnv(env) || !isText(title, REPLY_BOUNDS.title)) return undefined;
  if (!(AFTER_EXIT_MODES as readonly unknown[]).includes(afterExit)) return undefined;
  if (loginShell !== undefined && typeof loginShell !== "boolean") return undefined;
  if (ownHome !== undefined && (typeof ownHome !== "string" || !isBuiltInTarget(ownHome))) {
    return undefined;
  }
  if (notice !== undefined && !(NOTICES as readonly unknown[]).includes(notice)) return undefined;
  // The folder's elements: distinct indices of empty elements after the executable.
  if (folderArgs !== undefined) {
    if (!Array.isArray(folderArgs) || folderArgs.length > 16) return undefined;
    const seen = new Set<number>();
    for (const index of folderArgs as unknown[]) {
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 1) return undefined;
      if (index >= argv.length || argv[index] !== "" || seen.has(index)) return undefined;
      seen.add(index);
    }
  }
  if (match !== undefined) {
    if (!isObject(match) || Object.keys(match).length !== 1) return undefined;
    const home = match["home"];
    if (!isText(home, REPLY_BOUNDS.path) || home === "") return undefined;
  }
  const plan: SpawnPlan = {
    argv,
    folder,
    env,
    title,
    afterExit: afterExit as AfterExit,
    ...(loginShell === true ? { loginShell } : {}),
    ...(folderArgs === undefined || (folderArgs as unknown[]).length === 0
      ? {}
      : { folderArgs: folderArgs as number[] }),
    ...(match === undefined ? {} : { match: { home: (match as { home: string }).home } }),
    ...(ownHome === undefined ? {} : { ownHome }),
    ...(notice === undefined ? {} : { notice: notice as Notice }),
  };
  return Buffer.byteLength(JSON.stringify(plan), "utf8") <= PLAN_MAX_BYTES ? plan : undefined;
}

/** A launch file as read from disk, checked field by field; undefined when it is not one. */
export function checkLaunchFile(value: unknown): LaunchFile | undefined {
  if (!isObject(value) || value["format"] !== 1) return undefined;
  const { space, launch, reference, task, createdAt, folder, ticket, attachment, agent } = value;
  const plan = checkPlan(value["plan"]);
  if (plan === undefined) return undefined;
  if (typeof space !== "string" || !SPACE_ID.test(space)) return undefined;
  if (typeof launch !== "string" || !LAUNCH_ID.test(launch) || !isLaunchRef(reference)) {
    return undefined;
  }
  if (task !== null && (typeof task !== "string" || !TASK_ID.test(task))) return undefined;
  if (!isInstant(createdAt)) return undefined;
  const file: LaunchFile = { format: 1, space, launch, reference, task, createdAt, plan };
  let out: LaunchFile = file;
  if (folder !== undefined) {
    if (!isObject(folder) || !isText(folder["path"], 4096) || folder["path"] === "") {
      return undefined;
    }
    const check = checkFolderCheck(folder["check"]);
    if (check === undefined) return undefined;
    out = { ...out, folder: { path: folder["path"], check } };
  }
  if (ticket !== undefined) {
    if (!isObject(ticket) || !isHash(ticket["hash"]) || !isInstant(ticket["issuedAt"])) {
      return undefined;
    }
    if (typeof ticket["shimUsed"] !== "boolean") return undefined;
    out = {
      ...out,
      ticket: { hash: ticket["hash"], issuedAt: ticket["issuedAt"], shimUsed: ticket["shimUsed"] },
    };
  }
  if (attachment !== undefined) {
    if (!isObject(attachment) || !isHash(attachment["hash"]) || !isPid(attachment["pid"])) {
      return undefined;
    }
    const startTime = attachment["startTime"];
    if (typeof startTime !== "string" || !START_TIME.test(startTime)) return undefined;
    out = { ...out, attachment: { hash: attachment["hash"], pid: attachment["pid"], startTime } };
  }
  if (agent !== undefined) {
    if (!isObject(agent) || !isPid(agent["pid"]) || !isInstant(agent["startedAt"])) {
      return undefined;
    }
    out = { ...out, agent: { pid: agent["pid"], startedAt: agent["startedAt"] } };
  }
  const app = value["app"];
  if (app !== undefined) {
    if (typeof app !== "string" || !APP_NAME.test(app)) return undefined;
    out = { ...out, app };
  }
  const given = checkGiven(value);
  return given === undefined ? undefined : { ...out, ...given };
}

/** An app's name as an entry's `--app` carries it. */
const APP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A copy of a space as the service names it (its copy token). */
export const COPY_TOKEN = /^[0-9a-f]{24}$/;

/** What the click knows of the agent it starts and of the copy it was made in (`ShimHost.prepare`). */
export interface ClickGiven {
  readonly app?: string;
  readonly home?: string;
  readonly preset?: string;
  readonly copy?: string;
}

/** Each of the click's values a launch file's reader takes, so none makes the file unreadable. */
export function keptGiven(given: ClickGiven): ClickGiven {
  const { app, home, preset, copy } = given;
  return {
    ...(app !== undefined && APP_NAME.test(app) ? { app } : {}),
    ...(home !== undefined && isFolderText(home) ? { home } : {}),
    ...(preset !== undefined && SESSION_UUID.test(preset) ? { preset } : {}),
    ...(copy !== undefined && COPY_TOKEN.test(copy) ? { copy } : {}),
  };
}

/** The home, session, preset and copy a launch record holds, each when present. */
function checkGiven(
  value: Record<string, unknown>,
): Pick<LaunchFile, "home" | "session" | "preset" | "copy"> | undefined {
  const { home, session, preset, copy } = value;
  if (home !== undefined && !isFolderText(home)) return undefined;
  if (session !== undefined && (typeof session !== "string" || !SESSION_ID.test(session))) {
    return undefined;
  }
  if (preset !== undefined && (typeof preset !== "string" || !SESSION_UUID.test(preset))) {
    return undefined;
  }
  if (copy !== undefined && (typeof copy !== "string" || !COPY_TOKEN.test(copy))) return undefined;
  return {
    ...(home === undefined ? {} : { home }),
    ...(session === undefined ? {} : { session }),
    ...(preset === undefined ? {} : { preset }),
    ...(copy === undefined ? {} : { copy }),
  };
}

/** An `exit.json`, checked; undefined when it is not one or names another launch. */
export function checkExitFile(value: unknown, launch: string): ExitFile | undefined {
  if (!isObject(value) || value["format"] !== 1 || value["launch"] !== launch) return undefined;
  const { spawned, settled, code, signal, ran_ms: ran, failed, folder } = value;
  if (typeof spawned !== "boolean" || typeof settled !== "boolean") return undefined;
  if (code !== null && (typeof code !== "number" || !Number.isSafeInteger(code))) return undefined;
  if (signal !== null && (typeof signal !== "string" || !/^[A-Z0-9]{1,16}$/.test(signal))) {
    return undefined;
  }
  if (!isInstant(ran)) return undefined;
  if (failed !== undefined && !(FAILED_REASONS as readonly unknown[]).includes(failed)) {
    return undefined;
  }
  if (folder !== undefined && !isFolderReason(folder)) return undefined;
  return {
    format: 1,
    launch,
    spawned,
    settled,
    code,
    signal,
    ran_ms: ran,
    ...(failed === undefined ? {} : { failed: failed as FailedReason }),
    ...(folder === undefined ? {} : { folder }),
  };
}

/** A reason of the shim's folder check (places.ts RESOLVE_REASONS). */
export const isFolderReason = (value: unknown): value is ResolveReason =>
  (RESOLVE_REASONS as readonly unknown[]).includes(value);

function readBounded(path: string): unknown {
  const read = readOnce(path);
  return read.kind === "read" ? read.value : undefined;
}

/**
 * A file's parsed JSON, or the code of the error that kept it from being read. A file that is not
 * there, too large or not JSON reads as undefined.
 */
function readOnce(
  path: string,
): { kind: "read"; value: unknown } | { kind: "failed"; code: string } {
  let text: string;
  try {
    if (statSync(path).size > MAX_FILE) return { kind: "read", value: undefined };
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return code === "ENOENT" ? { kind: "read", value: undefined } : { kind: "failed", code };
  }
  try {
    return { kind: "read", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "read", value: undefined };
  }
}

/**
 * The waits between the tries of a launch file another program holds for a moment (a scanner, a
 * backup, a sharing violation): about three seconds in all, once, as the service starts.
 */
export const HELD_FILE_WAITS_MS: readonly number[] = [250, 750, 2_000];

/** The read errors that can pass. Any other (a folder in the file's place, a loop) does not. */
const PASSING = new Set(["EACCES", "EPERM", "EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);

export interface FolderRecordsOptions {
  /** Blocks for `ms` milliseconds between tries. */
  readonly wait?: (ms: number) => void;
  /** A launch file left out because it could not be read: the launch's ID and the error code. */
  readonly unreadable?: (launch: string, code: string) => void;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const LAUNCH_FILE = "launch.json";
export const EXIT_FILE = "exit.json";

/**
 * The launch root and each launch folder, and the files in them: set on each
 * new folder and file through @ttasks/files, so no umask decides them. On Windows the folder's ACL
 * decides.
 */
export const LAUNCH_FOLDER_MODE = 0o700;
export const LAUNCH_FILE_MODE = 0o600;

/** The machine state in folders under the install's launch root. */
export class FolderRecords implements RecordStore {
  readonly root: string;
  readonly #files = new Map<string, LaunchFile>();

  /**
   * Creates the root (0700, and any missing folder above it) and reads every launch file in it.
   * These are the only reads of the launch files: from here the records in memory are the
   * truth. A file that cannot be read for a moment is read again over
   * `HELD_FILE_WAITS_MS`; one that still cannot is left out, as a damaged one is. The service
   * judges the root before (hub/service.ts): it holds the commands a launch runs.
   */
  constructor(root: string, options: FolderRecordsOptions = {}) {
    this.root = root;
    makeDir(root, LAUNCH_FOLDER_MODE);
    const failed = new Map<string, string>();
    for (const name of readdirSync(root)) {
      if (LAUNCH_ID.test(name)) this.#load(name, failed);
    }
    for (const ms of HELD_FILE_WAITS_MS) {
      const passing = [...failed].filter(([, code]) => PASSING.has(code));
      if (passing.length === 0) break;
      (options.wait ?? pause)(ms);
      for (const [name] of passing) this.#load(name, failed);
    }
    for (const [name, code] of failed) options.unreadable?.(name, code);
  }

  /** Reads a launch's file into the records, or notes the error that kept it from being read. */
  #load(name: string, failed: Map<string, string>): void {
    const read = readOnce(join(this.root, name, LAUNCH_FILE));
    if (read.kind === "failed") {
      failed.set(name, read.code);
      return;
    }
    failed.delete(name);
    const file = checkLaunchFile(read.value);
    if (file?.launch === name) this.#files.set(name, file);
  }

  list(): readonly LaunchFile[] {
    return [...this.#files.values()];
  }

  get(launch: string): LaunchFile | undefined {
    return this.#files.get(launch);
  }

  put(file: LaunchFile): void {
    if (!LAUNCH_ID.test(file.launch)) throw new Error("Not a launch ID");
    const text = `${JSON.stringify(file)}
`;
    // Never a file the reader would leave out after a restart.
    if (Buffer.byteLength(text, "utf8") > MAX_FILE) throw new Error("The launch file is too large");
    const folder = join(this.root, file.launch);
    makeDir(folder, LAUNCH_FOLDER_MODE);
    atomicWrite(join(folder, LAUNCH_FILE), text, LAUNCH_FILE_MODE);
    this.#files.set(file.launch, file);
  }

  remove(launch: string): void {
    if (!LAUNCH_ID.test(launch)) return;
    this.#files.delete(launch);
    rmSync(join(this.root, launch), { recursive: true, force: true, maxRetries: 5 });
  }

  readExit(launch: string): ExitFile | undefined {
    if (!LAUNCH_ID.test(launch)) return undefined;
    return checkExitFile(readBounded(join(this.root, launch, EXIT_FILE)), launch);
  }

  exitPath(launch: string): string {
    return join(this.root, launch, EXIT_FILE);
  }
}

/** The machine state in memory: tests, and the property model, whose restarts keep the object. */
export class MemoryRecords implements RecordStore {
  readonly #files = new Map<string, LaunchFile>();
  readonly exits = new Map<string, ExitFile>();
  /** Called before each write takes effect: the model kills the service there. */
  beforePut: ((file: LaunchFile) => void) | undefined;

  list(): readonly LaunchFile[] {
    return [...this.#files.values()];
  }

  get(launch: string): LaunchFile | undefined {
    return this.#files.get(launch);
  }

  put(file: LaunchFile): void {
    this.beforePut?.(file);
    this.#files.set(file.launch, structuredClone(file));
  }

  remove(launch: string): void {
    this.#files.delete(launch);
    this.exits.delete(launch);
  }

  readExit(launch: string): ExitFile | undefined {
    return this.exits.get(launch);
  }

  exitPath(launch: string): string {
    return `memory:${launch}/${EXIT_FILE}`;
  }
}
