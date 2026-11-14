// What makes a version the install's one (A2 3.12.2, 3.12.4, 3.12.6), shared by the install
// scripts' hand-over (install.ts, `tasks install --finish`), the updater (update.ts) and the
// repair of an interrupted update (repair.ts), so all three switch the same way:
//   - `current`: a symbolic link to `versions/<v>` renamed over the old one (Linux, macOS), a text
//     file holding `<v>` replaced by rename (Windows);
//   - the stable command: `<root>/bin/tasks`, a link to `../current/bin/tasks` (Linux, macOS), or
//     copies of the version's `tasks.exe` and `tasksw.exe` in `<root>\bin\` (Windows), a changed
//     one renamed aside to `.old-<n>` first, which Windows allows while it runs (A2 3.12.6);
//   - `<state>/install.json`, the install receipt (A2 3.2.3).
// Every path of an install is computed here or in hub/paths.ts, so the rename step changes it once.
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PRODUCT_ID } from "@tasks/brand";
import { atomicWrite, makeDir } from "../hub/files.ts";
import { canonicalStatePath, HOME_MARKER, installId } from "../hub/paths.ts";
import { isVersionName, MANIFEST_FILE, sha256File } from "./folder.ts";

/** The file in a TASKS_HOME install's root: one constant, the layout's (hub/paths.ts). */
export { HOME_MARKER };

export const INSTALL_FILE = "install.json";
export const UPDATE_LOCK = "update.lock";
export const INSTALL_FORMAT = 1;
export const VERSIONS = "versions";

/** A refusal or failure of an install or update, with the exit code the CLI gives it (A2 3.10.3). */
export class InstallError extends Error {
  override readonly name = "InstallError";
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** A temporary name beside `path`, which nothing else uses. */
export const temp = (path: string): string =>
  join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`,
  );

// ---------------------------------------------------------------------------------------------
// current

/** What `current` holds: nothing, a link's target (Linux, macOS) or the text file's (Windows). */
export type CurrentValue =
  { readonly kind: "none" } | { readonly kind: "value"; readonly value: string };

/** Reads `current`, refusing anything that is not what an install writes. */
export function readCurrent(root: string, platform: NodeJS.Platform): CurrentValue {
  const current = join(root, "current");
  if (!exists(current)) return { kind: "none" };
  const stat = lstatSync(current);
  if (platform === "win32" ? !stat.isFile() : !stat.isSymbolicLink()) {
    throw new InstallError(
      `${current} is not the ${platform === "win32" ? "text file" : "link"} an install writes. It was left as it is; current was not changed.`,
      4,
    );
  }
  return {
    kind: "value",
    value: platform === "win32" ? readFileSync(current, "utf8") : readlinkSync(current),
  };
}

/** Writes `current`: a link renamed over the old one, or a text file replaced; or removes it. */
export function writeCurrent(root: string, value: CurrentValue, platform: NodeJS.Platform): void {
  const current = join(root, "current");
  if (value.kind === "none") {
    rmSync(current, { force: true });
    return;
  }
  if (platform === "win32") {
    atomicWrite(current, value.value, 0o644);
    return;
  }
  if (exists(current) && readlinkSync(current) === value.value) return;
  const link = temp(current);
  symlinkSync(value.value, link);
  try {
    renameSync(link, current);
  } catch (error) {
    rmSync(link, { force: true });
    throw error;
  }
}

/** What `current` holds once it names `version`. */
export const currentFor = (version: string, platform: NodeJS.Platform): CurrentValue => ({
  kind: "value",
  value: platform === "win32" ? version : `${VERSIONS}/${version}`,
});

/**
 * The version `current` names, or undefined when there is no current, it is not what an install
 * writes, or what it holds is no version name.
 */
export function currentVersion(root: string, platform: NodeJS.Platform): string | undefined {
  let value: CurrentValue;
  try {
    value = readCurrent(root, platform);
  } catch {
    return undefined;
  }
  if (value.kind === "none") return undefined;
  const name =
    platform === "win32"
      ? value.value
      : value.value.startsWith(`${VERSIONS}/`)
        ? value.value.slice(VERSIONS.length + 1)
        : "";
  return isVersionName(name) ? name : undefined;
}

/** Whether `versions/<version>` is there with a manifest: an installed version. */
export const isInstalled = (root: string, version: string): boolean =>
  isVersionName(version) && existsSync(join(root, VERSIONS, version, MANIFEST_FILE));

// ---------------------------------------------------------------------------------------------
// The stable command

/** One file of the stable command and what it must be. */
export interface StableStep {
  readonly path: string;
  /** Linux, macOS: a link with this target. */
  readonly link?: string;
  /** Windows: a copy of this launcher. */
  readonly copyOf?: string;
}

/** The stable launchers' names on Windows: `tasks.exe` first, then `tasksw.exe` (A2 3.12.6). */
export const WINDOWS_LAUNCHERS = [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`] as const;

/** The stable command's files and what each must be (A2 3.12.2). */
export function stablePlan(
  root: string,
  versionFolder: string,
  platform: NodeJS.Platform,
): StableStep[] {
  const bin = join(root, "bin");
  if (platform === "win32") {
    return WINDOWS_LAUNCHERS.map((exe) => ({
      path: join(bin, exe),
      copyOf: join(versionFolder, "bin", exe),
    }));
  }
  return [{ path: join(bin, PRODUCT_ID), link: `../current/bin/${PRODUCT_ID}` }];
}

/** Refuses a stable command that is not what an install writes, before anything changes. */
export function checkStable(plan: readonly StableStep[]): void {
  for (const step of plan) {
    if (!exists(step.path)) continue;
    const stat = lstatSync(step.path);
    const ours =
      step.link !== undefined
        ? stat.isSymbolicLink() && readlinkSync(step.path) === step.link
        : stat.isFile();
    if (!ours) {
      throw new InstallError(
        `${step.path} is not what an install writes. It was left as it is, and current was not changed.`,
        4,
      );
    }
  }
}

/** One change of the finish and what puts it back: `what` names it when that fails. */
export interface Undo {
  readonly what: string;
  readonly run: () => void;
}

/** The next free `<path>.old-<n>`: where a launcher is renamed aside (A2 3.12.6). */
export function asideName(path: string): string {
  let n = 1;
  while (exists(`${path}.old-${String(n)}`)) n += 1;
  return `${path}.old-${String(n)}`;
}

/**
 * Removes a launcher that was put in place. One that already runs (a client started it from bin)
 * cannot be deleted on Windows, but it can be renamed: it goes aside as `.old-<n>`, which the
 * clean-up removes later (cleanAsideLaunchers).
 */
export function removePlaced(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    renameSync(path, asideName(path));
  }
}

/**
 * Puts a copy of `source` at `path`: a copy beside it first, checked against `digest` (the
 * source's own SHA-256 when not given), then the file at `path`, if any, renamed aside to
 * `.old-<n>` (Windows allows that while it runs, A2 3.12.6) and the copy renamed into place.
 * At every moment the path holds the old launcher, nothing (between the two renames), or the new
 * one. Returns where the old one went, or undefined when there was none.
 */
export function placeLauncher(path: string, source: string, digest?: string): string | undefined {
  const want = digest ?? sha256File(source);
  const fresh = temp(path);
  copyFileSync(source, fresh);
  if (sha256File(fresh) !== want) {
    rmSync(fresh, { force: true });
    throw new InstallError(`The copy of ${basename(source)} into bin does not match.`);
  }
  let aside: string | undefined;
  if (exists(path)) {
    aside = asideName(path);
    try {
      renameSync(path, aside);
    } catch (error) {
      rmSync(fresh, { force: true });
      throw error;
    }
  }
  try {
    renameSync(fresh, path);
  } catch (error) {
    rmSync(fresh, { force: true });
    // The old one goes back to its name, so a failure here leaves the path as it was.
    if (aside !== undefined && !exists(path)) renameSync(aside, path);
    throw error;
  }
  return aside;
}

/**
 * Puts the stable command in place. Returns the root-relative paths it created. Pushes onto
 * `undo`, as it goes, what puts each change back, so a failure later in the finish leaves bin as
 * it was.
 */
export function placeStable(root: string, plan: readonly StableStep[], undo: Undo[]): string[] {
  const created: string[] = [];
  const bin = join(root, "bin");
  if (!exists(bin)) {
    makeDir(bin, 0o700, { recursive: false });
    created.push("bin");
    undo.push({
      what: "bin",
      run: () => {
        rmdirSync(bin);
      },
    });
  }
  for (const step of plan) {
    const rel = `bin/${basename(step.path)}`;
    if (step.link !== undefined) {
      if (exists(step.path)) continue;
      symlinkSync(step.link, step.path);
      created.push(rel);
      undo.push({
        what: rel,
        run: () => {
          rmSync(step.path, { force: true });
        },
      });
      continue;
    }
    const source = step.copyOf ?? "";
    const had = exists(step.path);
    if (had && sha256File(step.path) === sha256File(source)) continue;
    const aside = placeLauncher(step.path, source);
    if (aside !== undefined) {
      // The new copy goes (aside, if a client started it meanwhile); the old one, which may run,
      // is renamed back.
      undo.push({
        what: rel,
        run: () => {
          if (exists(step.path)) removePlaced(step.path);
          renameSync(aside, step.path);
        },
      });
    } else {
      created.push(rel);
      undo.push({
        what: rel,
        run: () => {
          if (exists(step.path)) removePlaced(step.path);
        },
      });
    }
  }
  return created;
}

/** The SHA-256 of a file, or null when there is none. */
export function digestOf(path: string): string | null {
  try {
    return lstatSync(path).isFile() ? sha256File(path) : null;
  } catch {
    return null;
  }
}

/**
 * Brings one stable launcher to `digest` from the first of `sources` that holds exactly it: does
 * nothing when it already does (a launcher already in place with the wanted hash counts as
 * swapped, A2 3.12.6), else places a copy (placeLauncher). Returns false when no source holds it.
 */
export function ensureLauncher(path: string, digest: string, sources: readonly string[]): boolean {
  if (digestOf(path) === digest) return true;
  for (const source of sources) {
    if (digestOf(source) !== digest) continue;
    placeLauncher(path, source, digest);
    return true;
  }
  return false;
}

/** Where an old launcher may be found again: the files it was renamed aside to, newest first. */
export function asideCopies(path: string): string[] {
  const dir = dirname(path);
  const prefix = `${basename(path)}.old-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
    .map((name) => join(dir, name));
}

/**
 * Deletes the launchers renamed aside (`bin/*.old-<n>`): single files that nothing starts by name.
 * Call it only with update.lock held and no journal naming them (A2 3.12.6 step
 * 14). A refused delete (one that still runs) leaves it for a later pass. Returns how many went.
 */
export function cleanAsideLaunchers(root: string): number {
  const bin = join(root, "bin");
  let names: string[];
  try {
    names = readdirSync(bin);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/\.old-\d+$/.test(name)) continue;
    const path = join(bin, name);
    try {
      if (!lstatSync(path).isFile()) continue;
      rmSync(path);
      removed += 1;
    } catch {
      // Still running, or gone already: a later pass tries again.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// install.json

/**
 * The last update's outcome, for doctor (A2 3.12.6 step 13): an update from an archive or a
 * `--rollback`, which either completed (current names `to`) or was reverted to `from`.
 */
export interface LastUpdate {
  readonly kind: "update" | "rollback";
  readonly outcome: "completed" | "reverted";
  readonly from: string;
  readonly to: string;
  readonly at: string;
  /** Why it was reverted: a word from a closed list (update.ts UPDATE_FAILURES). */
  readonly reason?: string;
}

/** `<state>/install.json`, the install receipt (A2 3.2.3). Paths in `created` are root-relative. */
export interface InstallRecord {
  readonly format: typeof INSTALL_FORMAT;
  readonly method: "script";
  /** Where the version came from: `local`, a folder of release files (no update channel yet). */
  readonly channel: "local";
  readonly root: string;
  readonly install_id: string;
  readonly versions: readonly string[];
  /**
   * What the installer created, relative to the root (`.` is the root itself): files, and folders
   * that an uninstall removes only when empty. Never something that was there before.
   */
  readonly created: readonly string[];
  /** The version `current` named before the last switch: `tasks update --rollback`'s target. */
  readonly previous?: string;
  readonly last_update?: LastUpdate;
}

/** install.json as an object, or undefined when it is missing or not one. */
export function readInstallRecord(state: string): Record<string, unknown> | undefined {
  try {
    const json = JSON.parse(readFileSync(join(state, INSTALL_FILE), "utf8")) as unknown;
    return typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const lastUpdateOf = (value: unknown): LastUpdate | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const { kind, outcome, from, to, at, reason } = v;
  if (
    (kind !== "update" && kind !== "rollback") ||
    (outcome !== "completed" && outcome !== "reverted") ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof at !== "string"
  ) {
    return undefined;
  }
  return { kind, outcome, from, to, at, ...(typeof reason === "string" ? { reason } : {}) };
};

/** What a write of install.json changes. Everything else is kept as it was. */
export interface RecordChange {
  /** A version now installed: added to `versions`. */
  readonly installed?: string;
  /** What this run created, merged into `created`. */
  readonly created?: readonly string[];
  /** The version current named before this switch (when it named another). */
  readonly previous?: string;
  readonly lastUpdate?: LastUpdate;
}

/** Writes install.json (atomic replace, 0600) with `change` applied to what it held. */
export function writeInstallRecord(
  state: string,
  root: string,
  platform: NodeJS.Platform,
  change: RecordChange,
): InstallRecord {
  const before = readInstallRecord(state);
  const id = installId(canonicalStatePath(realpathSync.native(state), platform));
  const versions = strings(before?.["versions"]);
  const previous =
    change.previous ?? (typeof before?.["previous"] === "string" ? before["previous"] : undefined);
  const lastUpdate = change.lastUpdate ?? lastUpdateOf(before?.["last_update"]);
  const record: InstallRecord = {
    format: INSTALL_FORMAT,
    method: "script",
    channel: "local",
    root,
    install_id: id,
    versions: [
      ...new Set([...versions, ...(change.installed === undefined ? [] : [change.installed])]),
    ],
    created: [...new Set([...strings(before?.["created"]), ...(change.created ?? [])])].sort(),
    ...(previous === undefined ? {} : { previous }),
    ...(lastUpdate === undefined ? {} : { last_update: lastUpdate }),
  };
  atomicWrite(join(state, INSTALL_FILE), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
}
