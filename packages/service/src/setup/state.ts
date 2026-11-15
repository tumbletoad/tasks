// Setup's record of what it did in each agent home (A3 3.13.1): `<state>/setup/agents.json`,
// 0600 in a 0700 folder, replaced atomically. Per home: the app, the home and its file, the
// instance, account and space the entry names, the app's command and its undo (arguments only: the
// app's executable is found again when it runs), the variables they ran with, whether the file and
// its servers' table existed, the file's hash before and after, the entry as written, Tasks's
// single-key patches with their before and after values, and the agent-home grant.
//
// No copy of a file and no other key's value: these files hold other servers' secrets, and A3 3.13.1
// step 5 forbids whole-file backups. What the record holds is Tasks's own entry, which `--remove`
// compares with the file to take back only what is still exactly Tasks's.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, ensurePrivateDir } from "../hub/files.ts";

/**
 * The apps setup registers Tasks in, by the name the bridge's `--app` carries (A3 3.13.2-3.13.4).
 * The Codex app and T3 Code read these apps' homes, so they have no entry of their own.
 */
export const AGENT_APPS = ["claude-code", "codex", "claude-desktop"] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

export const isAgentApp = (value: unknown): value is AgentApp =>
  (AGENT_APPS as readonly unknown[]).includes(value);

export const SETUP_DIR = "setup";
export const SETUP_FILE = "agents.json";
export const SETUP_LOCK = "agents.lock";
export const SETUP_FORMAT = 1;

/** The record is read back whole; it holds a few entries, so this bound is generous. */
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export interface HomeRecord {
  readonly app: AgentApp;
  readonly home: string;
  readonly file: string;
  readonly is_default: boolean;
  readonly instance: string;
  readonly account: string;
  readonly space: string;
  /** `applying` is written before the app's command runs, `applied` once the entry is in place. */
  readonly state: "applying" | "applied";
  readonly file_existed: boolean;
  readonly parent_existed: boolean;
  readonly sha256_before: string | null;
  readonly sha256_after: string | null;
  /** The app's command (`mcp add …`) and its undo (`mcp remove …`), after the executable. */
  readonly args: readonly string[];
  readonly undo: readonly string[];
  /** The argv the entry runs: Tasks's command and the bridge's arguments. */
  readonly entry_argv: readonly string[];
  /** The variables set for both commands (the home's own variable). */
  readonly env: Readonly<Record<string, string>>;
  /** The entry as written; null while applying. */
  readonly entry: unknown;
  readonly patches: readonly {
    readonly key: string;
    readonly before: unknown;
    readonly after: unknown;
  }[];
  /** The agent-home row in the service's grants table (A2 3.2.5), when the service made one. */
  readonly grant: string | null;
  readonly at: string;
}

/** Setup's record cannot be read: nothing is changed until it can. */
export class SetupStateInvalid extends Error {
  override readonly name = "SetupStateInvalid";
  constructor() {
    super("Setup's record of the agent homes cannot be read");
  }
}

/** The folder for setup's record can be changed by other users: nothing is written into it. */
export class SetupStateUnsafe extends Error {
  override readonly name = "SetupStateUnsafe";
  constructor() {
    super("Setup's folder can be changed by other users");
  }
}

export const setupDir = (stateDir: string): string => join(stateDir, SETUP_DIR);

const text = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

function isRecord(value: unknown): value is HomeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    isAgentApp(r["app"]) &&
    text(r["home"]) &&
    text(r["file"]) &&
    typeof r["is_default"] === "boolean" &&
    text(r["instance"]) &&
    text(r["account"]) &&
    text(r["space"]) &&
    (r["state"] === "applying" || r["state"] === "applied") &&
    typeof r["file_existed"] === "boolean" &&
    typeof r["parent_existed"] === "boolean" &&
    (r["sha256_before"] === null || text(r["sha256_before"])) &&
    (r["sha256_after"] === null || text(r["sha256_after"])) &&
    strings(r["args"]) &&
    strings(r["undo"]) &&
    strings(r["entry_argv"]) &&
    typeof r["env"] === "object" &&
    r["env"] !== null &&
    Array.isArray(r["patches"]) &&
    (r["grant"] === null || text(r["grant"])) &&
    text(r["at"])
  );
}

/** The records of every home setup changed. A missing file is none; a damaged one throws. */
export function readRecords(stateDir: string): HomeRecord[] {
  const doc = readStateFile(join(setupDir(stateDir), SETUP_FILE));
  if (doc === undefined) return [];
  const homes = stateField(doc, "homes");
  if (stateField(doc, "format") !== SETUP_FORMAT || !Array.isArray(homes)) {
    throw new SetupStateInvalid();
  }
  if (!homes.every(isRecord)) throw new SetupStateInvalid();
  return homes;
}

/** A top-level field of a record file's document, or undefined. */
export function stateField(doc: unknown, key: string): unknown {
  return typeof doc === "object" && doc !== null && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)[key]
    : undefined;
}

/**
 * One of setup's record files, parsed: undefined when it is not there. One that cannot be read,
 * is too large or is not JSON throws SetupStateInvalid: setup then changes nothing.
 */
export function readStateFile(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SetupStateInvalid();
  }
  let raw: string;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new SetupStateInvalid();
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    raw = buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SetupStateInvalid();
  }
}

/** Replaces setup's record. The folder is made user-only, and one others can change is refused. */
export function writeRecords(stateDir: string, records: readonly HomeRecord[]): void {
  writeStateFile(stateDir, SETUP_FILE, { format: SETUP_FORMAT, homes: records });
}

/** Replaces one of setup's record files, 0600 in its user-only folder. */
export function writeStateFile(stateDir: string, file: string, doc: unknown): void {
  const dir = setupDir(stateDir);
  if (ensurePrivateDir(dir) !== undefined) throw new SetupStateUnsafe();
  atomicWrite(join(dir, file), `${JSON.stringify(doc, null, 2)}\n`, 0o600);
}
