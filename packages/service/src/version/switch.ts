// What makes a version the install's one (A2 3.12.2, 3.12.4, 3.12.6), shared by the install
// scripts' hand-over (install.ts, `ttasks install --finish`), the updater (update.ts) and the
// repair of an interrupted update (repair.ts), so all three switch the same way:
//   - `current`: a symbolic link to `versions/<v>` renamed over the old one (Linux, macOS), a text
//     file holding `<v>` replaced by rename (Windows);
//   - the stable command: `<root>/bin/ttasks`, a link to `../current/bin/ttasks` (Linux, macOS), or
//     copies of the version's `ttasks.exe` and `ttasksw.exe` in `<root>\bin\` (Windows). A changed
//     one is replaced by one rename where Windows allows it (the launcher is not running, and the
//     one it replaces can be found again in a version folder), so the stable path never goes
//     missing; a running one is renamed aside to `.old-<n>` first, which Windows allows, and the
//     new one renamed in (A2 3.12.6). An update stages each new launcher as `<name>.new`
//     before current changes (A2 3.12.6 step 8);
//   - `<state>/install.json`, the install receipt (A2 3.2.3).
// Every path of an install is computed here or in hub/paths.ts, so the rename step changes it once.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PRODUCT_ID } from "@ttasks/brand";
import { atomicWrite, createFile, makeDir, removeStaleTemps } from "../hub/files.ts";
import { canonicalStatePath, HOME_MARKER, installId } from "../hub/paths.ts";
import { isVersionName, MANIFEST_FILE, readVersionManifest, sha256File } from "./folder.ts";
import type { LauncherChange } from "./journal.ts";

/** The file in a TTASKS_HOME install's root: one constant, the layout's (hub/paths.ts). */
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

/** The stable launchers' names on Windows: `ttasks.exe` first, then `ttasksw.exe` (A2 3.12.6). */
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
 * clean-up removes later (cleanLaunchers).
 */
export function removePlaced(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    renameSync(path, asideName(path));
  }
}

/** Where an update stages a stable launcher before the switch: `bin\<name>.new` (A2 3.12.6 step 8). */
export const stagedPath = (path: string): string => `${path}.new`;

/** Whether `source` is `path`'s own staged copy or one of its aside copies: a file in bin. */
const besidePath = (source: string, path: string): boolean => {
  if (dirname(source) !== dirname(path)) return false;
  const name = basename(source);
  const aside = `${basename(path)}.old-`;
  return (
    name === basename(stagedPath(path)) ||
    (name.startsWith(aside) && /^\d+$/.test(name.slice(aside.length)))
  );
};

/**
 * A new file beside `near` holding the bytes of `source`, hashed while they are copied, so what is
 * written is what was checked, and flushed. Returns its path, or undefined (nothing left behind)
 * when the bytes are not `digest`. Windows sets no mode; elsewhere 0755, as a launcher.
 */
function checkedCopy(source: string, near: string, digest: string): string | undefined {
  const fresh = temp(near);
  const hash = createHash("sha256");
  const input = openSync(source, "r");
  let output: number | undefined;
  try {
    output = createFile(fresh, 0o755);
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(input, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      for (let at = 0; at < n;) at += writeSync(output, buffer, at, n - at);
    }
    fsyncSync(output);
  } catch (error) {
    if (output !== undefined) closeSync(output);
    closeSync(input);
    rmSync(fresh, { force: true });
    throw error;
  }
  closeSync(output);
  closeSync(input);
  if (hash.digest("hex") !== digest) {
    rmSync(fresh, { force: true });
    return undefined;
  }
  return fresh;
}

/**
 * Stages a stable launcher for an update (A2 3.12.6 step 8): a checked, flushed copy of `source`
 * at `<path>.new`, before current changes. One already there with `digest` is kept.
 */
export function stageLauncher(path: string, source: string, digest: string): void {
  const staged = stagedPath(path);
  if (digestOf(staged) === digest) return;
  const fresh = checkedCopy(source, path, digest);
  if (fresh === undefined) {
    throw new InstallError(`${basename(source)} does not match the version's manifest.`);
  }
  try {
    renameSync(fresh, staged);
  } catch (error) {
    rmSync(fresh, { force: true });
    throw error;
  }
}

/** Where a launcher swap can be cut off, for the crash tests (tests/update/). Off in the product. */
export type SwapPoint = "aside" | "placed";
/** A launcher's steps in an update: staged before the switch, then its swap. */
export type LauncherPoint = "staged" | SwapPoint;

export interface PlaceOptions {
  /**
   * Files where the launcher now at `path` can be found again (a version folder's own copy). When
   * one of them holds its SHA-256, it may be replaced by one rename; otherwise it is kept aside as
   * `.old-<n>`, for a rollback or an undo that needs it back.
   */
  readonly keptIn?: readonly string[];
  readonly at?: (point: SwapPoint) => void;
}

/** A refusal Windows gives to replacing or deleting a running program (A2 3.12.6). */
const isBusy = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
};

/**
 * Puts the launcher with SHA-256 `digest` (the source's own when not given) at `path`, from
 * `source`: its own staged copy (`<path>.new`) or an aside copy (`<path>.old-<n>`) is renamed into
 * place, anything else is copied beside it first (checked and flushed). Then:
 *   - no launcher at `path`: the new one is renamed in;
 *   - one that `keptIn` holds and Windows lets go (it is not running): one rename replaces it, so
 *     the stable path is never missing (A2 3.12.6 step 10, where the OS allows it);
 *   - otherwise (it runs, or nothing else holds it): it is renamed aside to `.old-<n>`, which
 *     Windows allows while it runs, and the new one renamed in. Only between these two renames is
 *     the path empty; a launcher's sibling repair or the next repair fills it.
 * A launcher's sibling repair may put the wanted launcher there between the two renames: a path
 * that holds `digest` afterwards counts as done. A failure otherwise puts the old one back.
 * Returns where the old one went, or undefined when it was replaced or there was none.
 */
export function placeLauncher(
  path: string,
  source: string,
  digest?: string,
  options: PlaceOptions = {},
): string | undefined {
  const want = digest ?? sha256File(source);
  if (exists(path) && !lstatSync(path).isFile()) {
    throw new InstallError(`${path} is not what an install writes. It was left as it is.`, 4);
  }
  const movable = besidePath(source, path);
  let fresh: string | undefined;
  if (movable) {
    if (digestOf(source) === want) fresh = source;
  } else {
    fresh = checkedCopy(source, path, want);
  }
  if (fresh === undefined) {
    throw new InstallError(`The copy of ${basename(source)} into bin does not match.`);
  }
  const replacement = fresh;
  /** A copy made here goes; a staged or aside copy stays where it is for a later try. */
  const drop = () => {
    if (!movable) rmSync(replacement, { force: true });
  };
  const old = digestOf(path);
  const placedHere = (error: unknown): void => {
    // A launcher's sibling repair put the wanted one there first: done.
    if (digestOf(path) === want) {
      drop();
      return;
    }
    drop();
    throw error;
  };
  if (old === want) {
    // Already in place (A2 3.12.6: a launcher with the wanted hash counts as swapped).
    drop();
    options.at?.("placed");
    return undefined;
  }
  if (old === null) {
    try {
      renameSync(replacement, path);
    } catch (error) {
      placedHere(error);
    }
    options.at?.("placed");
    return undefined;
  }
  if (options.keptIn?.some((file) => digestOf(file) === old) === true) {
    try {
      renameSync(replacement, path);
      options.at?.("placed");
      return undefined;
    } catch (error) {
      // Running: Windows refuses to replace it (A2 3.12.6). Two renames below.
      if (!isBusy(error)) {
        drop();
        throw error;
      }
    }
  }
  const aside = asideName(path);
  try {
    renameSync(path, aside);
  } catch (error) {
    drop();
    throw error;
  }
  options.at?.("aside");
  try {
    renameSync(replacement, path);
  } catch (error) {
    try {
      placedHere(error);
    } catch (failed) {
      // The old one goes back to its name, so a failure here leaves the path as it was.
      if (!exists(path)) renameSync(aside, path);
      throw failed;
    }
  }
  options.at?.("placed");
  return aside;
}

export interface StableOptions {
  /**
   * The stable command's files that were there before current changed (stableFiles). A launcher
   * that is there now but was not then was put there by a stable launcher's sibling repair, from
   * the version current now names (launcher.c, while a stuck update's journal is there): it is
   * this install's, recorded as created and undone, before anything about it can fail. Without
   * it, what is there when each one is placed counts as there.
   */
  readonly before?: ReadonlySet<string>;
  /** Tests only: after each launcher is in place (install.ts FinishOptions.afterStep). */
  readonly afterStep?: () => void;
}

/** The stable command's files that are there now, for StableOptions.before. */
export const stableFiles = (plan: readonly StableStep[]): ReadonlySet<string> =>
  new Set(plan.map((step) => step.path).filter((path) => exists(path)));

/**
 * Puts the stable command in place. Returns the root-relative paths it created. Pushes onto
 * `undo`, as it goes, what puts each change back, so a failure later in the finish leaves bin as
 * it was.
 */
export function placeStable(
  root: string,
  plan: readonly StableStep[],
  undo: Undo[],
  options: StableOptions = {},
): string[] {
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
    const removeIt: Undo = {
      what: rel,
      run: () => {
        if (exists(step.path)) removePlaced(step.path);
      },
    };
    // A launcher's sibling repair put one here after the switch: it is this install's, recorded
    // and undone before the hashing below can fail.
    const appeared =
      options.before !== undefined && !options.before.has(step.path) && exists(step.path);
    if (appeared) {
      created.push(rel);
      undo.push(removeIt);
    }
    if (exists(step.path) && sha256File(step.path) === sha256File(source)) {
      options.afterStep?.();
      continue;
    }
    const aside = placeLauncher(step.path, source);
    if (aside !== undefined) {
      // The new copy goes (aside, if a client started it meanwhile); the old one, which may run,
      // is renamed back (and, when it had appeared, goes by the undo pushed above, which runs
      // after this one).
      undo.push({
        what: rel,
        run: () => {
          if (exists(step.path)) removePlaced(step.path);
          renameSync(aside, step.path);
        },
      });
    } else if (!appeared) {
      created.push(rel);
      undo.push(removeIt);
    }
    options.afterStep?.();
  }
  return created;
}

/** The launchers the switch to `target` changes (Windows), with their old and new SHA-256. */
export function launcherChanges(
  root: string,
  target: string,
  platform: NodeJS.Platform,
): LauncherChange[] {
  if (platform !== "win32") return [];
  const changes: LauncherChange[] = [];
  for (const name of WINDOWS_LAUNCHERS) {
    const next = digestOf(join(target, "bin", name));
    if (next === null) throw new InstallError(`The new version has no bin/${name}.`, 1);
    const old = digestOf(join(root, "bin", name));
    if (old !== next) changes.push({ name, old, new: next });
  }
  return changes;
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
 * swapped, A2 3.12.6), else places it (placeLauncher). Returns false when no source holds it.
 */
export function ensureLauncher(
  path: string,
  digest: string,
  sources: readonly string[],
  options: PlaceOptions = {},
): boolean {
  if (digestOf(path) === digest) return true;
  for (const source of sources) {
    if (digestOf(source) !== digest) continue;
    placeLauncher(path, source, digest, options);
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
 * Deletes what a launcher swap leaves in bin once it is over (A2 3.12.6 step 14):
 * the launchers renamed aside (`<name>.old-<n>`), staged copies (`<name>.new`) and the temporary
 * copies of a swap or of a launcher's sibling repair that a kill left (`.<name>.….tmp`), for the
 * stable launchers' names only. Call it only with update.lock held and no journal, so none of them
 * is named by one. An aside launcher is a single file that nothing starts by name; one that still
 * runs cannot be deleted on Windows, and a refused delete leaves it for a later pass. One with
 * another hard link is kept: Windows refuses to delete a running program only through its last
 * link, so its delete would prove nothing. Returns how many went.
 */
export function cleanLaunchers(root: string): number {
  const bin = join(root, "bin");
  let names: string[];
  try {
    names = readdirSync(bin);
  } catch {
    return 0;
  }
  let removed = removeStaleTemps(bin, WINDOWS_LAUNCHERS);
  for (const name of names) {
    const path = join(bin, name);
    const own = WINDOWS_LAUNCHERS.some((launcher) => besidePath(path, join(bin, launcher)));
    if (!own) continue;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1) continue;
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
  /**
   * `ttasks update --rollback`'s target: the version `current` named before the last switch, when
   * it is known to have worked; otherwise the target before that switch is kept, so a version that
   * never ran (an install cut off, then installed over; a service that exits at every start) is
   * never the way back.
   */
  readonly previous?: string;
  /**
   * The versions a service of this install was seen ready on: recorded by the service at its
   * start, and by an install or update that found it running or brought it back. A version whose
   * build does not record it (its manifest has no `notes_seen_working`) counts as seen.
   */
  readonly seen_working?: readonly string[];
  readonly last_update?: LastUpdate;
  /** Versions kept whatever else is installed: nothing writes this list yet (retire.ts). */
  readonly pinned?: readonly string[];
  /** A version folder being removed: renamed to `versions/<folder>`, then deleted (retire.ts). */
  readonly retiring?: Retiring;
}

/** The rename of a version folder that a removal makes, recorded before it is made. */
export interface Retiring {
  readonly version: string;
  readonly folder: string;
}

/** The name a version folder is renamed to before it is deleted: no launcher starts it. */
export const retiringName = (version: string, hex: string): string => `.retiring-${version}-${hex}`;

const retiringOf = (value: unknown): Retiring | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, folder } = value as Record<string, unknown>;
  return typeof version === "string" &&
    isVersionName(version) &&
    typeof folder === "string" &&
    folder.startsWith(retiringName(version, "")) &&
    /^[0-9a-f]{16}$/.test(folder.slice(retiringName(version, "").length))
    ? { version, folder }
    : undefined;
};

/** install.json's pending removal, when it names one this build would make. */
export const pendingRetiring = (
  record: Record<string, unknown> | undefined,
): Retiring | undefined => retiringOf(record?.["retiring"]);

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
  /** A switch that completed, from the version current named to another: `previous` follows. */
  readonly switched?: { readonly from: string; readonly to: string };
  /** Versions a service of this install was seen ready on: added to `seen_working`. */
  readonly seen?: readonly (string | undefined)[];
  readonly lastUpdate?: LastUpdate;
  /** A version folder about to be renamed and deleted, or null once that is over. */
  readonly retiring?: Retiring | null;
  /** A version whose folder is gone: out of `versions`, and its folder out of `created`. */
  readonly retired?: string;
}

/**
 * The way back after a switch from `from` to `to`: `from` when a service of it was seen working,
 * or when its build does not note that (a version from before the note, which the person was
 * using). Otherwise `from` never ran, and the way back stays the one it had, while that is
 * installed and is not `to`.
 */
function wayBack(
  root: string,
  from: string,
  to: string,
  seen: readonly string[],
  had: string | undefined,
): string {
  if (seen.includes(from) || !notesSeen(root, from)) return from;
  return had !== undefined && had !== to && isInstalled(root, had) ? had : from;
}

/**
 * Whether the build of `version`, by its own manifest, notes when it is seen working. A manifest
 * that does not read says nothing: the version is not taken for one from before the note, so a
 * way back that is known to work is not given up for it.
 */
function notesSeen(root: string, version: string): boolean {
  try {
    return readVersionManifest(join(root, VERSIONS, version)).notes_seen_working === true;
  } catch {
    return true;
  }
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
  const had = typeof before?.["previous"] === "string" ? before["previous"] : undefined;
  const newly = (change.seen ?? []).filter(
    (v): v is string => v !== undefined && isInstalled(root, v),
  );
  const seen =
    Array.isArray(before?.["seen_working"]) || newly.length > 0
      ? [...new Set([...strings(before?.["seen_working"]), ...newly])]
      : undefined;
  const previous =
    change.switched === undefined
      ? had
      : wayBack(root, change.switched.from, change.switched.to, seen ?? [], had);
  const lastUpdate = change.lastUpdate ?? lastUpdateOf(before?.["last_update"]);
  const retiring =
    change.retiring === undefined
      ? retiringOf(before?.["retiring"])
      : (change.retiring ?? undefined);
  const pinned = Array.isArray(before?.["pinned"]) ? strings(before["pinned"]) : undefined;
  const gone = (entry: string) =>
    change.retired !== undefined &&
    (entry === change.retired || entry === `${VERSIONS}/${change.retired}`);
  const record: InstallRecord = {
    format: INSTALL_FORMAT,
    method: "script",
    channel: "local",
    root,
    install_id: id,
    versions: [
      ...new Set([...versions, ...(change.installed === undefined ? [] : [change.installed])]),
    ].filter((v) => !gone(v)),
    created: [...new Set([...strings(before?.["created"]), ...(change.created ?? [])])]
      .filter((path) => !gone(path))
      .sort(),
    ...(previous === undefined ? {} : { previous }),
    ...(seen === undefined ? {} : { seen_working: seen }),
    ...(lastUpdate === undefined ? {} : { last_update: lastUpdate }),
    ...(pinned === undefined ? {} : { pinned }),
    ...(retiring === undefined ? {} : { retiring }),
  };
  atomicWrite(join(state, INSTALL_FILE), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
}
