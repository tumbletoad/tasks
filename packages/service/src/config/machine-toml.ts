// machine.toml (A2 3.2.4): one machine-local file, `<config>/machine.toml`, never synced or exported.
// It is the person's file. TTasks reads it strictly into typed values and content-free problems
// (the key and a fixed code, never the value), never rewrites it on its own, and changes it only
// through edit.ts, which keeps every other byte.
//
// Sections have owners. This appendix (A2) owns `[service]`, `[http]`, `[ui]`, `[updates]`, `[log]`
// and `[[spaces]]`, checked here. A4 owns `[terminal]`, `[[instance]]` and `[approvals]`:
// @ttasks/launch checks those. `[runs]`, background runs' guidelines, is checked here. A1 owns
// `[preferences]` (3.16), checked here with the preferences registry of @ttasks/contracts.
// `[[custom_target]]`, `[override.*]` (A4) and `[remote]`,
// `[security]` (A6) are reserved: the steps that use them check them, and until then they are
// passed by without a problem. `[roots]` is retired: a project's folder took its place, and its
// lines are left as they are with one `retired` warning. Any other top-level key is an
// `unknown_key` warning.
//
// A bad entry is dropped with its problem, and the rest of its section stays. Problems in the file
// itself and in `[[spaces]]` are fatal for the service (fatalProblems below): hosting a different
// set of spaces than the person wrote is worse than not starting.
import { lstatSync, type Stats } from "node:fs";
import { join, posix, win32 } from "node:path";
import {
  DEFAULT_TERMINAL,
  entryKey,
  isAbsoluteFor,
  isTable,
  keyPath,
  keyUnder,
  Problems,
  readApprovals,
  readInstances,
  readTerminal,
  TableReader,
  type ConfigProblem,
  type Instance,
  type TerminalSettings,
  type Verdict,
} from "@ttasks/launch";
import { fitsShape, LATER_PREFERENCES, preferenceSpec, type PrefValue } from "@ttasks/contracts";
import { QUEUE_LIMITS, type QueueLimits } from "@ttasks/contracts/runs";
import { isId, type Id } from "@ttasks/storage";
import {
  currentPerson,
  factsFrom,
  factsOf,
  problemOf,
  type PathFacts,
  type Person,
  type Unsafe,
} from "../hub/permissions.ts";
import type { Level } from "../hub/log.ts";
import { SECTIONS, type Section } from "./section-names.ts";
import { decodeConfig, parseToml, readConfigFile, type TomlDocument } from "./toml.ts";

export const MACHINE_TOML = "machine.toml";

export { SECTIONS, type Section };

/** Sections later steps read. This build accepts them as they are. */
export const RESERVED_SECTIONS: readonly Section[] = [
  "custom_target",
  "override",
  "remote",
  "security",
];

export const LOG_LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

export interface SpaceRegistration {
  /** A1's immutable space ID. */
  readonly id: Id<"sp">;
  readonly path: string;
  readonly enabled: boolean;
}

export interface MachineConfig {
  readonly service: { readonly defaultSpace: Id<"sp"> | undefined };
  readonly http: { readonly port: number | undefined };
  readonly ui: { readonly openMode: "tab" | "app" };
  readonly updates: {
    readonly channel: "stable" | "nightly";
    readonly check: boolean;
    readonly auto: boolean;
  };
  readonly log: { readonly level: Level };
  readonly spaces: readonly SpaceRegistration[];
  readonly terminal: TerminalSettings;
  readonly instances: readonly Instance[];
  /** `[approvals]`: approval hash to verdict (A4 3.2). */
  readonly approvals: ReadonlyMap<string, Verdict>;
  /**
   * `[setup.managed] paths` (A3 3.12 rule 4): files, or folders of files, that another source
   * generates. Setup writes nothing there and prints the change instead.
   */
  readonly setup: { readonly managedPaths: readonly string[] };
  /**
   * `[preferences]` (A1 3.16): this machine's preferences that are set, by their whole name, each
   * a value of its declared shape. A key not here takes the registry's default.
   */
  readonly preferences: ReadonlyMap<string, PrefValue>;
  /** `[runs]`: background runs' guidelines (RunSettings). */
  readonly runs: RunSettings;
}

/**
 * `[runs]`: how many background runs run at once (`at_once`, `per_instance`, `per_task`), and
 * how long a run may take in total and without output (`max_minutes`, `max_quiet_minutes`), for
 * the runs queued after a change. Guidelines a person sets: a lower limit stops nothing that runs.
 * Without a time limit set, none ends a run.
 */
export interface RunSettings {
  readonly limits: QueueLimits;
  readonly wallMs?: number;
  readonly idleMs?: number;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = { limits: QUEUE_LIMITS };

/** `[runs]`. A bad value drops itself with its problem, and its default applies. */
function readRuns(doc: TomlDocument, problems: Problems): RunSettings {
  const runs = tableOf(doc, "runs", problems);
  if (runs === undefined) return DEFAULT_RUN_SETTINGS;
  const d = DEFAULT_RUN_SETTINGS;
  const count = (name: string, fallback: number) =>
    runs.int(name, { min: 1, max: 100 }) ?? fallback;
  const minutes = (name: string): number | undefined => {
    const value = runs.int(name, { min: 1, max: 24 * 60 });
    return value === undefined ? undefined : value * 60_000;
  };
  const limits: QueueLimits = {
    runs: count("at_once", d.limits.runs),
    perInstance: count("per_instance", d.limits.perInstance),
    perTask: count("per_task", d.limits.perTask),
  };
  const wallMs = minutes("max_minutes");
  const idleMs = minutes("max_quiet_minutes");
  const settings: RunSettings = {
    limits,
    ...(wallMs === undefined ? {} : { wallMs }),
    ...(idleMs === undefined ? {} : { idleMs }),
  };
  runs.done();
  return settings;
}

/** The configuration of a machine without machine.toml. */
export const DEFAULT_CONFIG: MachineConfig = {
  service: { defaultSpace: undefined },
  http: { port: undefined },
  ui: { openMode: "tab" },
  updates: { channel: "stable", check: true, auto: false },
  log: { level: "info" },
  spaces: [],
  terminal: DEFAULT_TERMINAL,
  instances: [],
  approvals: new Map(),
  setup: { managedPaths: [] },
  preferences: new Map(),
  runs: DEFAULT_RUN_SETTINGS,
};

/**
 * `[preferences]` (A1 3.16): each key is a machine preference's whole name, quoted
 * (`"projection.dir" = "/srv/ttasks-view"`), checked by the registry as the writer checks a space
 * preference, and by this platform's rule for a path. A bad entry drops itself; a name the
 * registry does not know is a warning, as a newer build may know it, and so is a key this build
 * does not read yet.
 */
function readMachinePreferences(
  doc: TomlDocument,
  platform: NodeJS.Platform,
  problems: Problems,
): Map<string, PrefValue> {
  const out = new Map<string, PrefValue>();
  const table = doc["preferences"];
  if (table === undefined) return out;
  if (!isTable(table)) {
    problems.error("preferences", "wrong_type");
    return out;
  }
  for (const [name, value] of Object.entries(table)) {
    const key = keyPath("preferences", name);
    const spec = preferenceSpec(name);
    if (spec === undefined) {
      problems.warn(key, "unknown_key");
      continue;
    }
    if (spec.scope !== "machine") {
      // A space preference lives in the space, where it travels with backups and exports.
      problems.error(key, "invalid_value");
      continue;
    }
    if (
      spec.shape.type === "path" &&
      typeof value === "string" &&
      !isAbsoluteFor(platform, value)
    ) {
      problems.error(key, "not_absolute");
      continue;
    }
    if (!fitsShape(spec.shape, value)) {
      problems.error(key, "invalid_value");
      continue;
    }
    if (LATER_PREFERENCES.some((later) => later.key === name)) problems.warn(key, "not_read");
    out.set(name, value as PrefValue);
  }
  return out;
}

/** `[setup]` (A3 3.12): `[setup.managed] paths`, each an absolute path. A bad path drops itself. */
function readSetup(doc: TomlDocument, platform: NodeJS.Platform, problems: Problems): string[] {
  const setup = tableOf(doc, "setup", problems);
  if (setup === undefined) return [];
  const managed = setup.raw("managed");
  setup.done();
  if (managed === undefined) return [];
  if (!isTable(managed)) {
    setup.error("managed", "wrong_type");
    return [];
  }
  const table = new TableReader(managed, "setup.managed", problems);
  const listed = table.strings("paths") ?? [];
  table.done();
  const paths: string[] = [];
  for (const [i, path] of listed.entries()) {
    if (isAbsoluteFor(platform, path)) paths.push(path);
    else problems.error(entryKey("setup.managed.paths", i), "not_absolute");
  }
  return paths;
}

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** A table section, or undefined with a problem when the key holds something else. */
function tableOf(doc: TomlDocument, name: string, problems: Problems): TableReader | undefined {
  const value = doc[name];
  if (value === undefined) return undefined;
  if (!isTable(value)) {
    problems.error(name, "wrong_type");
    return undefined;
  }
  return new TableReader(value, name, problems);
}

function readSpaces(
  value: unknown,
  platform: NodeJS.Platform,
  problems: Problems,
): SpaceRegistration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.error("spaces", "wrong_type");
    return [];
  }
  const p = pathOf(platform);
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const spaces: SpaceRegistration[] = [];
  for (const [i, entry] of (value as unknown[]).entries()) {
    const key = entryKey("spaces", i);
    if (!isTable(entry)) {
      problems.error(key, "wrong_type");
      continue;
    }
    const r = new TableReader(entry, key, problems);
    const idText = r.string("id", { required: true });
    let id: Id<"sp"> | undefined;
    if (idText !== undefined) {
      if (isId(idText, "sp")) id = idText;
      else r.error("id", "invalid_value");
    }
    const path = r.path("path", platform, { required: true });
    const enabled = r.bool("enabled", true);
    r.done();
    if (r.failed || id === undefined || path === undefined) continue;
    // Copies of one space share its ID (a restored copy and its original, a claimed copy and the
    // closed original), so an ID may repeat: one of them is served at a time (hub/spaces.ts). A
    // folder holds one space, so a folder may not.
    if (spaces.some((s) => fold(p.resolve(s.path)) === fold(p.resolve(path)))) {
      problems.error(keyPath(key, "path"), "duplicate");
      continue;
    }
    spaces.push({ id, path, enabled });
  }
  return spaces;
}

/** Checks a parsed machine.toml into its typed configuration and problems. */
export function checkMachineConfig(
  doc: TomlDocument,
  platform: NodeJS.Platform,
): { config: MachineConfig; problems: ConfigProblem[] } {
  const problems = new Problems();

  for (const name of Object.keys(doc)) {
    if (!(SECTIONS as readonly string[]).includes(name)) problems.warn(name, "unknown_key");
  }
  if (doc["roots"] !== undefined) problems.warn("roots", "retired");

  const service = tableOf(doc, "service", problems);
  const defaultText = service?.string("default_space");
  let defaultSpace: Id<"sp"> | undefined;
  if (defaultText !== undefined) {
    if (isId(defaultText, "sp")) defaultSpace = defaultText;
    else service?.error("default_space", "invalid_value");
  }
  service?.done();

  const http = tableOf(doc, "http", problems);
  const port = http?.int("port", { min: 1024, max: 65535 });
  http?.done();

  const ui = tableOf(doc, "ui", problems);
  const openMode = ui?.oneOf("open_mode", ["tab", "app"], "tab") ?? "tab";
  ui?.done();

  const updates = tableOf(doc, "updates", problems);
  const channel = updates?.oneOf("channel", ["stable", "nightly"], "stable") ?? "stable";
  const check = updates?.bool("check", true) ?? true;
  const auto = updates?.bool("auto", false) ?? false;
  updates?.done();

  const log = tableOf(doc, "log", problems);
  const level = log?.oneOf("level", LOG_LEVELS, "info") ?? "info";
  log?.done();

  const config: MachineConfig = {
    service: { defaultSpace },
    http: { port },
    ui: { openMode },
    updates: { channel, check, auto },
    log: { level },
    spaces: readSpaces(doc["spaces"], platform, problems),
    terminal: readTerminal(doc["terminal"], platform, problems),
    instances: readInstances(doc["instance"], platform, problems),
    approvals: readApprovals(doc["approvals"], problems),
    setup: { managedPaths: readSetup(doc, platform, problems) },
    preferences: readMachinePreferences(doc, platform, problems),
    runs: readRuns(doc, problems),
  };
  return { config, problems: problems.list };
}

/** Parses and checks machine.toml's text. A file that is not TOML gives the defaults. */
export function parseMachineConfig(
  text: string,
  platform: NodeJS.Platform,
): { config: MachineConfig; problems: ConfigProblem[] } {
  const parsed = parseToml(text);
  if (!parsed.ok) return { config: DEFAULT_CONFIG, problems: [parsed.problem] };
  return checkMachineConfig(parsed.doc, platform);
}

export interface LoadedMachineConfig {
  /** Whether the file exists. A missing file is no problem: the defaults apply. */
  readonly present: boolean;
  readonly config: MachineConfig;
  readonly problems: readonly ConfigProblem[];
  /**
   * With an `unsafe_permissions` problem: the folder and the file that fail the rule, and why,
   * folder first. For the person's own eyes (stderr, doctor), never for a log: it holds paths.
   */
  readonly unsafe?: UnsafeConfig;
}

/** The config folder or machine.toml itself, and why it fails the rule (permissions.ts). */
export interface UnsafePart {
  readonly what: "folder" | "file";
  readonly path: string;
  readonly problem: Unsafe;
  readonly facts: PathFacts;
  /** The folder: machine.toml inside it could not be seen, because this user cannot look in. */
  readonly hides?: true;
}

/** What failed the rule: one part or both, never none. */
export type UnsafeConfig = readonly [UnsafePart, ...UnsafePart[]];

const unreadable = (present: boolean): LoadedMachineConfig => ({
  present,
  config: DEFAULT_CONFIG,
  problems: [{ key: "", code: "unreadable", severity: "error" }],
});

const unsafeConfig = (parts: UnsafeConfig, present = true): LoadedMachineConfig => ({
  present,
  config: DEFAULT_CONFIG,
  problems: [{ key: "", code: "unsafe_permissions", severity: "error" }],
  unsafe: parts,
});

/** A part for `facts` when they fail the rule, or undefined. */
function partOf(
  what: UnsafePart["what"],
  facts: PathFacts,
  person: Person,
): UnsafePart | undefined {
  const problem = problemOf(facts, person);
  return problem === undefined ? undefined : { what, path: facts.path, problem, facts };
}

/**
 * The part for a link at `path`, judged by no owner: what Windows gets, where the rule is the
 * ACL's, so that it says it is a link and to what, as Linux and macOS do.
 */
function linkPart(what: UnsafePart["what"], path: string): UnsafePart | undefined {
  const facts = factsOf(path, what, { followLink: false });
  return typeof facts === "object" && facts.link !== undefined
    ? { what, path, problem: "link", facts }
    : undefined;
}

/** The lstat of `path`, or the error's code. */
function lstatOrCode(path: string): Stats | string {
  try {
    return lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "EIO";
  }
}

const sameObject = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;

/**
 * Reads `<config>/machine.toml`. Never writes, never creates it.
 *
 * Linux and macOS (A2 3.2.2 rule 5, permissions.ts): the config folder and the file must each be a
 * real folder and a real file (configuration is never read through a link), belong to this user,
 * and be writable by no one else (the person's own private group counts as no one else). The file
 * names commands TTasks runs as this user, so a file that
 * fails is not used. The folder is judged first and on every path, the missing file's included:
 * the answer is the same before machine.toml exists and after TTasks has written one into it. Within
 * a folder that fails nothing is read; the file's own facts are still judged when they can be seen,
 * so that one command fixes both. Windows: a link in either place is not followed either, and is
 * named as a link with its target; the profile's ACL is doctor's to check.
 */
export function loadMachineConfig(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): LoadedMachineConfig {
  const path = join(configDir, MACHINE_TOML);
  // Undefined on Windows, where the rule is the ACL's (doctor).
  const person = currentPerson();

  // The folder, before anything else.
  const folder = lstatOrCode(configDir);
  if (typeof folder === "string") {
    // Nothing there: the file is missing too, unless a file on the way makes it unreadable.
    if (folder !== "ENOENT") return unreadable(true);
  } else if (folder.isSymbolicLink()) {
    if (person === undefined) {
      const part = linkPart("folder", configDir);
      return part === undefined ? unreadable(true) : unsafeConfig([part]);
    }
    const facts = factsOf(configDir, "folder", { followLink: false });
    const part = typeof facts === "object" ? partOf("folder", facts, person) : undefined;
    return part === undefined ? unreadable(true) : unsafeConfig([part]);
  } else if (!folder.isDirectory()) {
    // A file where the folder belongs is a configuration that cannot be read, not one to chmod.
    return unreadable(true);
  } else if (person !== undefined) {
    const part = partOf("folder", factsFrom(configDir, "folder", folder), person);
    if (part !== undefined) {
      const file = factsOf(path, "file", { followLink: false });
      if (file === "unseen") return unsafeConfig([{ ...part, hides: true }]);
      const present = file !== "missing";
      const own =
        file !== "missing" && (file.kind === "file" || file.link !== undefined)
          ? partOf("file", file, person)
          : undefined;
      return unsafeConfig(own === undefined ? [part] : [part, own], present);
    }
  }

  // One descriptor: its facts (a regular file, its size, owner and mode) are checked before any
  // byte is read, and the read is bounded. It never follows a link.
  const read = readConfigFile(path);
  if (read.kind === "missing") return { present: false, config: DEFAULT_CONFIG, problems: [] };
  if (read.kind === "problem") {
    // The open or the read failed. When the file fails the rule (a link, another owner, no read
    // for its owner), that is what the person must fix, and its message names the path and the
    // command. A folder or a FIFO in its place stays `unreadable`: no command fixes those.
    if (person !== undefined) {
      const file = factsOf(path, "file", { followLink: false });
      if (typeof file === "object" && (file.kind === "file" || file.link !== undefined)) {
        const part = partOf("file", file, person);
        if (part !== undefined) return unsafeConfig([part]);
      }
    } else {
      const part = linkPart("file", path);
      if (part !== undefined) return unsafeConfig([part]);
    }
    return { present: true, config: DEFAULT_CONFIG, problems: [read.problem] };
  }
  if (person !== undefined) {
    // The descriptor's facts decide. The folder must still be the one judged above.
    const now = lstatOrCode(configDir);
    if (typeof folder === "string" || typeof now === "string" || !sameObject(folder, now)) {
      return unreadable(true);
    }
    const part = partOf("file", factsFrom(path, "file", read.stat), person);
    if (part !== undefined) return unsafeConfig([part]);
  }
  const decoded = decodeConfig(read.bytes);
  if (!decoded.ok) return { present: true, config: DEFAULT_CONFIG, problems: [decoded.problem] };
  return { present: true, ...parseMachineConfig(decoded.text, platform) };
}

/** The section a problem belongs to, for logs: a listed section, the file itself, or `other`. */
export function sectionOf(problem: ConfigProblem): Section | "file" | "other" {
  if (problem.key === "") return "file";
  const first = /^[^.[]*/u.exec(problem.key)?.[0] ?? "";
  return (SECTIONS as readonly string[]).includes(first) ? (first as Section) : "other";
}

/**
 * The problems that stop the service (exit 64): the file cannot be read or parsed, or `[[spaces]]`
 * holds an error. Every other problem drops only its entry and is logged.
 */
export function fatalProblems(problems: readonly ConfigProblem[]): ConfigProblem[] {
  return problems.filter(
    (p) => p.severity === "error" && (p.key === "" || keyUnder(p.key, "spaces")),
  );
}
