// Setup's record of what it did in each agent home (A3 3.13.1): `<state>/setup/agents.json`,
// 0600 in a 0700 folder, replaced atomically. Per home: the app, the home and each file setup wrote
// its entry into, the instance, account and space the entry names, the entry TTasks writes there,
// what each write made beside it (the file, the servers' table, the bytes around the entry), and
// the agent-home grant. A home's first file is kept where an earlier build reads it (`file`,
// `made`), so a rollback finds the home and takes the entry out of that file.
//
// No copy of a file and no other key's value: these files hold other servers' secrets, and A3 3.13.1
// step 5 forbids whole-file backups. What the record holds is TTasks's own entry as it intended to
// write it, which `--remove` compares with the file to take back only what is still exactly
// TTasks's. An earlier build's records (format 1) are read in place.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { envVar } from "@ttasks/brand";
import { atomicWrite, ensurePrivateDir } from "../hub/files.ts";

/**
 * The apps setup registers TTasks in, by the name the bridge's `--app` carries (A3 3.13.2-3.13.4).
 * The Codex app and T3 Code read these apps' homes, so they have no entry of their own.
 */
export const AGENT_APPS = ["claude-code", "codex", "claude-desktop"] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

export const isAgentApp = (value: unknown): value is AgentApp =>
  (AGENT_APPS as readonly unknown[]).includes(value);

export const SETUP_DIR = "setup";
export const SETUP_FILE = "agents.json";
export const SETUP_LOCK = "agents.lock";
export const SETUP_FORMAT = 2;

/** The record is read back whole; it holds a few entries, so this bound is generous. */
const MAX_STATE_BYTES = 4 * 1024 * 1024;

/** What a write made beside the entry in one file, which its removal gives back (entry.ts `Made`). */
export interface Made {
  /** TTasks created the file: it goes when nothing else is left in it. */
  readonly file: boolean;
  readonly parent: boolean;
  readonly spacing: string | null;
  readonly ended?: string;
}

export interface HomeRecord {
  readonly app: AgentApp;
  readonly home: string;
  /** The first file setup wrote the entry into: the one an earlier build knows. */
  readonly file: string;
  /** Whether `file` is the one Claude Code reads when started with no variable. */
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
  /** The entry TTasks writes there, as it intended it: never what it read back. */
  readonly entry: Readonly<Record<string, unknown>>;
  /** Other entries that are TTasks's own there: what an earlier build's writers left midway. */
  readonly also: readonly unknown[];
  /** What the write made beside the entry in `file`. */
  readonly made: Made;
  /**
   * The home's other files setup wrote the same entry into, each with what its write made there
   * (Claude Code's default folder has two). Absent in a record of one file, an earlier build's too.
   */
  readonly more?: readonly { readonly file: string; readonly made: Made }[];
  /** The agent-home row in the service's grants table (A2 3.2.5), when the service made one. */
  readonly grant: string | null;
  readonly at: string;
}

/** Every file a record names, the first one first, each with what its write made there. */
export const recordFiles = (
  record: HomeRecord,
): readonly { readonly file: string; readonly made: Made }[] => [
  { file: record.file, made: record.made },
  ...(record.more ?? []),
];

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

export const setupDir = (stateDir: string): string => join(stateDir, SETUP_DIR);
/** Setup's record of the agent homes: the file a person is told of when it cannot be read. */
export const recordFile = (stateDir: string): string => join(setupDir(stateDir), SETUP_FILE);

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

const isMade = (made: unknown): made is Made =>
  isObject(made) &&
  typeof made["file"] === "boolean" &&
  typeof made["parent"] === "boolean" &&
  (made["spacing"] === null || text(made["spacing"])) &&
  (made["ended"] === undefined || text(made["ended"]));

function isRecord(value: unknown): value is HomeRecord {
  if (!isObject(value) || !isHome(value)) return false;
  const more = value["more"];
  return (
    (value["state"] === "applying" ||
      value["state"] === "applied" ||
      value["state"] === "removing") &&
    isObject(value["entry"]) &&
    Array.isArray(value["also"]) &&
    isMade(value["made"]) &&
    (more === undefined ||
      (Array.isArray(more) &&
        more.every((m) => isObject(m) && text(m["file"]) && isMade(m["made"]))))
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
 * The records of every home setup changed, an earlier build's read in place. A missing file is
 * none; a damaged one throws.
 */
export function readRecords(stateDir: string): HomeRecord[] {
  const doc = readStateFile(recordFile(stateDir));
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
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw new SetupStateTooLarge();
  const dir = setupDir(stateDir);
  if (ensurePrivateDir(dir) !== undefined) throw new SetupStateUnsafe();
  atomicWrite(join(dir, file), text, 0o600);
}
