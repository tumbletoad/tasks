// Setup's record of what it did in each agent home (A3 3.13.1): `<state>/setup/agents.json`,
// 0600 in a 0700 folder, replaced atomically. Per home: the app, the home and its file, the
// instance, account and space the entry names, the entry TTasks writes there, what its write made
// beside it (the file, the servers' table, the bytes around the entry), and the agent-home grant.
// A home's further settings file (Claude Code's default folder has two) has a record of the same
// shape in `agents-further.json`, which no earlier build opens: an earlier build rewrites
// `agents.json` with what it knows, and finds there the one file it knows of each home. The two
// files are this module's own: setupRecords reads both, saveRecord and dropRecord put a record in
// its place, and nothing else opens them (a test holds every other source file to that).
//
// No copy of a file and no other key's value: these files hold other servers' secrets, and A3 3.13.1
// step 5 forbids whole-file backups. What the record holds is TTasks's own entry as it intended to
// write it, which `--remove` compares with the file to take back only what is still exactly
// TTasks's. An earlier build's records (format 1) are read in place.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { envVar } from "@ttasks/brand";
import { atomicWrite, ensurePrivateDir, type Judged } from "../hub/files.ts";

/**
 * The apps setup registers TTasks in, by the name the bridge's `--app` carries (A3 3.13.2-3.13.4).
 * The Codex app and T3 Code read these apps' homes, so they have no entry of their own.
 */
export const AGENT_APPS = ["claude-code", "codex", "claude-desktop"] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

export const isAgentApp = (value: unknown): value is AgentApp =>
  (AGENT_APPS as readonly unknown[]).includes(value);

export const SETUP_DIR = "setup";
/** The record files: the one an earlier build reads, and the further settings files' records. */
const SETUP_FILE = "agents.json";
const FURTHER_FILE = "agents-further.json";
export const SETUP_LOCK = "agents.lock";
export const SETUP_FORMAT = 2;

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
  /**
   * `applying`: written before anything changes in the home. `applied`: the entry was found in
   * place, then the home got its access (`grant`). `removing`: setup decided to take it back (the
   * person turned it off, or an apply failed), and the entry may still wait to come out. A record
   * that is not `applied` when setup takes its lock was left by a run that ended midway, and is
   * finished as a removal.
   */
  readonly state: "applying" | "applied" | "removing";
  /**
   * Whether this record may take the home's access back, once, when its apply fails or a run that
   * ended midway is settled. `true`: its apply found the access off and asks for it. `false`: its
   * apply attached to access that was there, or its one revoke is done; it takes nothing back.
   * Absent: an earlier build's record, which is settled as that build settles it, with the revoke.
   */
  readonly gives_access?: boolean;
  /** The entry TTasks writes there, as it intended it: never what it read back. */
  readonly entry: Readonly<Record<string, unknown>>;
  /** Other entries that are TTasks's own there: what an earlier build's writers left midway. */
  readonly also: readonly unknown[];
  /** What the write made beside the entry, which its removal gives back (entry.ts `Made`). */
  readonly made: {
    /** TTasks created the file: it goes when nothing else is left in it. */
    readonly file: boolean;
    readonly parent: boolean;
    readonly spacing: string | null;
    readonly ended?: string;
  };
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

/** A record that setup could not read back is never written: the one before it stays. */
export class SetupStateTooLarge extends Error {
  override readonly name = "SetupStateTooLarge";
  constructor() {
    super("Setup's record of the agent homes would be larger than it can read back");
  }
}

/** The folder for setup's record can be changed by other users: nothing is written into it. */
export class SetupStateUnsafe extends Error {
  override readonly name = "SetupStateUnsafe";
  constructor() {
    super("Setup's folder can be changed by other users");
  }
}

/**
 * A file in setup's folder could not be written: the file, its folder or the temporary file beside
 * it is read-only, held, or the disk is full. `file` says which file setup was writing.
 */
export class SetupStateUnwritable extends Error {
  override readonly name = "SetupStateUnwritable";
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(`Setup's file ${file} could not be written`, { cause });
    this.file = file;
  }
}

export const setupDir = (stateDir: string): string => join(stateDir, SETUP_DIR);

/**
 * Setup's folder, made when it is missing and judged on Linux and macOS before `file` is written
 * there: one other users can change throws SetupStateUnsafe, and one this user cannot make or
 * write in throws SetupStateUnwritable for `file`.
 */
export function setupFolder(stateDir: string, file: string): string {
  const dir = setupDir(stateDir);
  let judged: Judged | undefined;
  try {
    judged = ensurePrivateDir(dir);
  } catch (error) {
    throw new SetupStateUnwritable(join(dir, file), error);
  }
  if (judged?.problem === "no_access") throw new SetupStateUnwritable(join(dir, file), judged);
  if (judged !== undefined) throw new SetupStateUnsafe();
  return dir;
}

const text = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields every format's record has. */
function isHome(r: Record<string, unknown>): boolean {
  return (
    isAgentApp(r["app"]) &&
    text(r["home"]) &&
    text(r["file"]) &&
    typeof r["is_default"] === "boolean" &&
    text(r["instance"]) &&
    text(r["account"]) &&
    text(r["space"]) &&
    (r["grant"] === null || text(r["grant"])) &&
    text(r["at"])
  );
}

function isRecord(value: unknown): value is HomeRecord {
  if (!isObject(value) || !isHome(value)) return false;
  const made = value["made"];
  return (
    (value["state"] === "applying" ||
      value["state"] === "applied" ||
      value["state"] === "removing") &&
    isObject(value["entry"]) &&
    Array.isArray(value["also"]) &&
    isObject(made) &&
    typeof made["file"] === "boolean" &&
    typeof made["parent"] === "boolean" &&
    (made["spacing"] === null || text(made["spacing"])) &&
    (made["ended"] === undefined || text(made["ended"])) &&
    (value["gives_access"] === undefined || typeof value["gives_access"] === "boolean")
  );
}

/**
 * A record of the earlier build (format 1), as this one reads it. That build ran Claude Code's and
 * Codex's own `mcp add` and recorded what it read back: here its entry is what those writers left
 * (Claude Code's `type` and empty `env`, Codex's table with TTasks's two keys), and an apply it left
 * midway also owns Codex's table before those keys. Its bytes around the entry are not known.
 */
function fromFormat1(value: unknown): HomeRecord | undefined {
  if (!isObject(value) || !isHome(value)) return undefined;
  const r = value;
  const argv = r["entry_argv"];
  const patches = r["patches"];
  if (
    (r["state"] !== "applying" && r["state"] !== "applied" && r["state"] !== "removing") ||
    !strings(argv) ||
    typeof r["file_existed"] !== "boolean" ||
    typeof r["parent_existed"] !== "boolean" ||
    !Array.isArray(patches)
  ) {
    return undefined;
  }
  const app = r["app"] as AgentApp;
  const ran = { command: argv[0] ?? "", args: argv.slice(1) };
  const patched = patches.filter(isObject).filter((p) => text(p["key"]));
  const codexKeys =
    patched.length > 0
      ? Object.fromEntries(patched.map((p) => [p["key"] as string, p["after"]]))
      : // The two keys that build patched in, as it wrote them.
        { env_vars: [envVar("TICKET")], startup_timeout_sec: 20 };
  const entry =
    app === "claude-code"
      ? { type: "stdio", ...ran, env: {} }
      : app === "codex"
        ? { ...ran, ...codexKeys }
        : ran;
  return {
    app,
    home: r["home"] as string,
    file: r["file"] as string,
    is_default: r["is_default"] as boolean,
    instance: r["instance"] as string,
    account: r["account"] as string,
    space: r["space"] as string,
    state: r["state"],
    entry,
    also: app === "codex" && r["state"] !== "applied" ? [ran] : [],
    made: { file: !r["file_existed"], parent: !r["parent_existed"], spacing: null },
    grant: r["grant"] as string | null,
    at: r["at"] as string,
  };
}

/**
 * The records of one record file, an earlier build's read in place. A missing file is none; a
 * damaged one throws.
 */
function readStore(stateDir: string, file: string): HomeRecord[] {
  const doc = readStateFile(join(setupDir(stateDir), file));
  if (doc === undefined) return [];
  const homes = stateField(doc, "homes");
  const format = stateField(doc, "format");
  if (!Array.isArray(homes)) throw new SetupStateInvalid();
  if (format === 1) {
    const read = homes.map(fromFormat1);
    if (!read.every((r): r is HomeRecord => r !== undefined)) throw new SetupStateInvalid();
    return read;
  }
  if (format !== SETUP_FORMAT || !homes.every(isRecord)) throw new SetupStateInvalid();
  return homes;
}

/** A record file's records, or undefined when it cannot be read. */
function tryStore(stateDir: string, file: string): HomeRecord[] | undefined {
  try {
    return readStore(stateDir, file);
  } catch (error) {
    if (error instanceof SetupStateInvalid) return undefined;
    throw error;
  }
}

/** Every record setup keeps, as one read found them: the only way to read them. */
export interface SetupRecords {
  /** Every record of both files, `agents.json`'s first. */
  readonly all: readonly HomeRecord[];
  /** The records an earlier build reads too: one per home, the file it knows. */
  readonly first: readonly HomeRecord[];
  /** `agents.json` cannot be read: no record is known, and nothing but the access may change. */
  readonly blind: boolean;
  /** The further files' records cannot be read: only the homes that can have one are concerned. */
  readonly furtherUnknown: boolean;
  /** Each record file that is there and cannot be read, by its full path. */
  readonly unreadable: readonly string[];
}

/** Reads both record files. */
export function setupRecords(stateDir: string): SetupRecords {
  const first = tryStore(stateDir, SETUP_FILE);
  const further = tryStore(stateDir, FURTHER_FILE);
  const unreadable = [
    ...(first === undefined ? [SETUP_FILE] : []),
    ...(further === undefined ? [FURTHER_FILE] : []),
  ].map((file) => join(setupDir(stateDir), file));
  if (first === undefined) {
    return { all: [], first: [], blind: true, furtherUnknown: true, unreadable };
  }
  return {
    all: [...first, ...(further ?? [])],
    first,
    blind: false,
    furtherUnknown: further === undefined,
    unreadable,
  };
}

/** Where a record goes: its home, its file, and whether that is a further file of its home. */
export interface RecordPlace {
  readonly sameHome: (record: HomeRecord) => boolean;
  readonly sameFile: (record: HomeRecord) => boolean;
  /** The file is a further settings file of its home (homeFiles). */
  readonly further: boolean;
  /** The home can have a further file: only then is `agents-further.json` read or written. */
  readonly twoFiled: boolean;
}

/**
 * Puts a file's record in place of the one it has. `agents.json` keeps one record per home, its
 * file's, which an earlier build reads, while that record is there; a home's other file has its
 * record in `agents-further.json`. A file that cannot be read throws SetupStateInvalid: nothing is
 * written into it.
 */
export function saveRecord(stateDir: string, record: HomeRecord, place: RecordPlace): void {
  const first = readStore(stateDir, SETUP_FILE);
  const held = first.find(place.sameHome);
  const here = () => {
    writeStore(stateDir, [...first.filter((r) => !place.sameHome(r)), record], SETUP_FILE);
  };
  if (held !== undefined && place.sameFile(held)) {
    here();
    return;
  }
  const further = place.twoFiled ? readStore(stateDir, FURTHER_FILE) : [];
  if (held === undefined && !place.further && !further.some(place.sameFile)) {
    here();
    return;
  }
  writeStore(stateDir, [...further.filter((r) => !place.sameFile(r)), record], FURTHER_FILE);
}

/**
 * Drops a file's record from wherever it is. A record file that cannot be read is left as it is;
 * one that cannot be written throws SetupStateUnwritable.
 */
export function dropRecord(
  stateDir: string,
  place: Omit<RecordPlace, "further" | "sameHome">,
): void {
  for (const file of place.twoFiled ? [SETUP_FILE, FURTHER_FILE] : [SETUP_FILE]) {
    const records = tryStore(stateDir, file);
    if (records === undefined) continue;
    const kept = records.filter((r) => !place.sameFile(r));
    if (kept.length !== records.length) writeStore(stateDir, kept, file);
  }
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

/** Replaces one record file's records. */
function writeStore(stateDir: string, records: readonly HomeRecord[], file: string): void {
  writeStateFile(stateDir, file, { format: SETUP_FORMAT, homes: records });
}

/**
 * Replaces one of setup's record files, 0600 in its user-only folder. Whatever keeps it from being
 * written throws SetupStateUnwritable naming it, but a folder other users can change
 * (SetupStateUnsafe) and a record too large to read back (SetupStateTooLarge).
 */
export function writeStateFile(stateDir: string, file: string, doc: unknown): void {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw new SetupStateTooLarge();
  const path = join(setupFolder(stateDir, file), file);
  try {
    atomicWrite(path, text, 0o600);
  } catch (error) {
    throw new SetupStateUnwritable(path, error);
  }
}
