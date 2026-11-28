// Removing old version folders (A2 3.12.6). A version folder goes only when the pass can show it
// is the installer's and that nothing needs it; where it cannot, the folder stays whole and doctor
// says why. Spaces, backups and every file outside `versions/` are never looked at.
//
// Kept: the version current names, the rollback target (install.json `previous`), any version
// newer than current (after a downgrade it may be the only one that reads a newer backup), and any
// version install.json `pinned` names. Every other version install.json `versions` names goes,
// once its folder is a plain folder that matches its own manifest with nothing else in it, and no
// process runs a program of it.
//
// A removal is recorded in install.json (`retiring`) before the folder is renamed to
// `.retiring-<v>-<hex>`, which no launcher starts, and cleared once that folder is deleted, its
// manifest.json last. The next pass finishes one that was cut off, once what is left in the
// folder is still only that manifest's files. A folder with that prefix that install.json does not
// name is never touched. Not update.json: its presence means an update was cut off, to the
// launchers, doctor and the service of an older version.
import { randomBytes } from "node:crypto";
import {
  type Stats,
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compareAppVersions, isAppVersion } from "@ttasks/storage";
import { acquireLock, LockBusy } from "../hub/lock.ts";
import { canonicalStatePath, installId } from "../hub/paths.ts";
import {
  checkVersionFolder,
  listFolder,
  MANIFEST_FILE,
  readVersionManifest,
  sha256File,
} from "./folder.ts";
import { journalPresent } from "./journal.ts";
import {
  currentVersion,
  exists,
  pendingRetiring,
  readInstallRecord,
  retiringName,
  strings,
  UPDATE_LOCK,
  VERSIONS,
  writeInstallRecord,
  type Retiring,
} from "./switch.ts";

export type KeptFor = "current" | "rollback" | "newer" | "pinned";

/** What a pass makes of one version install.json names. */
export type VersionVerdict =
  | { readonly version: string; readonly kind: "kept"; readonly why: KeptFor }
  | { readonly version: string; readonly kind: "in_use" }
  /** The folder is not as the installer left it, or cannot be read: `problem` says how. */
  | { readonly version: string; readonly kind: "foreign"; readonly problem: string }
  | { readonly version: string; readonly kind: "retire" };

export interface RetirePlan {
  readonly verdicts: readonly VersionVerdict[];
  /** A removal that was cut off, and why its folder is left as it is, when it is. */
  readonly pending?: Retiring & { readonly problem?: string };
}

/** Whether a process may run a program of the version folder. Any doubt is true. */
export type InUse = (folder: string, platform: NodeJS.Platform) => boolean;

export interface RetireOptions {
  readonly root: string;
  readonly state: string;
  readonly platform: NodeJS.Platform;
  readonly inUse?: InUse;
  /** Tests only: how recovery looks at a folder (lstatSync). */
  readonly lookAt?: (path: string) => Stats;
}

const isDir = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

const codeOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "error";
};

/**
 * Opens each program of the version for writing and closes it, changing nothing: Windows refuses
 * that for a running program or a loaded library (EBUSY), Linux for a running program (ETXTBSY),
 * both measured. The programs are the `.exe`, `.dll` and `.node` files on Windows, the files with
 * an execute bit elsewhere.
 */
export const osInUse: InUse = (folder, platform) => {
  if (platform !== "win32" && platform !== "linux") return true;
  try {
    for (const path of Object.keys(readVersionManifest(folder).files)) {
      const file = join(folder, ...path.split("/"));
      const program =
        platform === "win32"
          ? /\.(?:exe|dll|node)$/i.test(path)
          : (statSync(file).mode & 0o111) !== 0;
      if (program) closeSync(openSync(file, "r+"));
    }
    return false;
  } catch {
    return true;
  }
};

interface Owned {
  readonly record: Record<string, unknown>;
  readonly current: string;
  readonly versions: string;
}

/**
 * The install, when it is provably this one: install.json's root and install ID, a plain
 * `versions` folder, a readable current, and no journal.
 */
function owned({ root, state, platform }: RetireOptions): Owned | undefined {
  const canon = (path: string) => canonicalStatePath(path, platform);
  try {
    const record = readInstallRecord(state);
    const current = currentVersion(root, platform);
    const versions = join(root, VERSIONS);
    return !journalPresent(state) &&
      record?.["method"] === "script" &&
      typeof record["root"] === "string" &&
      canon(record["root"]) === canon(root) &&
      record["install_id"] === installId(canon(realpathSync.native(state))) &&
      isDir(versions) &&
      current !== undefined
      ? { record, current, versions }
      : undefined;
  } catch {
    return undefined;
  }
}

/** One version's verdict, its use checked last. A folder that cannot be read stays. */
function judge(
  options: RetireOptions,
  install: Owned,
  version: string,
): VersionVerdict | undefined {
  const { record, current } = install;
  // Windows does not tell `0.4.0-RC1` from `0.4.0-rc1`: one folder.
  const same = (b: unknown) =>
    typeof b === "string" &&
    (options.platform === "win32" ? version.toLowerCase() === b.toLowerCase() : version === b);
  const why: KeptFor | undefined = same(current)
    ? "current"
    : same(record["previous"])
      ? "rollback"
      : strings(record["pinned"]).some(same)
        ? "pinned"
        : isAppVersion(version) && isAppVersion(current) && compareAppVersions(version, current) > 0
          ? "newer"
          : undefined;
  if (why !== undefined) return { version, kind: "kept", why };
  const folder = join(install.versions, version);
  if (!exists(folder)) return undefined;
  const foreign = (problem: string): VersionVerdict => ({ version, kind: "foreign", problem });
  try {
    if (!isDir(folder)) return foreign("it is a link, not a folder");
    if (!isAppVersion(version)) return foreign("its name is no release version");
    if (readVersionManifest(folder).version !== version) {
      return foreign("its manifest names another version");
    }
    const problem = checkVersionFolder(folder)[0];
    if (problem !== undefined) return foreign(problem);
    return (options.inUse ?? osInUse)(folder, options.platform)
      ? { version, kind: "in_use" }
      : { version, kind: "retire" };
  } catch (error) {
    return foreign(`it cannot be read (${codeOf(error)})`);
  }
}

/**
 * Why the folder of a removal that was cut off may hold what is not the version's; undefined when
 * what is left is that version's manifest and files it lists, or nothing but empty folders.
 */
function leftoverProblem(folder: string, version: string): string | undefined {
  try {
    const listing = listFolder(folder);
    if (listing.problems[0] !== undefined) return listing.problems[0];
    if (!listing.files.includes(MANIFEST_FILE)) {
      return listing.files.length === 0 ? undefined : "it holds files but no manifest.json";
    }
    const manifest = readVersionManifest(folder);
    if (manifest.version !== version) return "its manifest names another version";
    for (const path of listing.files) {
      if (path === MANIFEST_FILE) continue;
      if (!Object.hasOwn(manifest.files, path)) return `not in manifest.json: ${path}`;
      if (sha256File(join(folder, ...path.split("/"))) !== manifest.files[path]) {
        return `changed: ${path}`;
      }
    }
    return undefined;
  } catch (error) {
    return `it cannot be read (${codeOf(error)})`;
  }
}

/** What a cut-off removal comes to, decided once: its record cleared, its folder deleted, or both kept. */
type Recovery =
  | { readonly pending: Retiring; readonly act: "clear"; readonly retired: boolean }
  | { readonly pending: Retiring; readonly act: "delete" }
  | { readonly pending: Retiring; readonly act: "keep"; readonly problem: string };

/**
 * A removal that was cut off, from lookups that all answered: only ENOENT is "not there", any
 * other error keeps both folders. A version still under its own name was never renamed, so a
 * folder at the recorded name is not the removal's; one renamed is deleted only once what is left
 * in it is that version's.
 */
function recoveryOf(options: RetireOptions, install: Owned): Recovery | undefined {
  const pending = pendingRetiring(install.record);
  if (pending === undefined) return undefined;
  const look = options.lookAt ?? lstatSync;
  const kind = (path: string): "absent" | "folder" | "other" | { code: string } => {
    try {
      const stat = look(path);
      return stat.isDirectory() && !stat.isSymbolicLink() ? "folder" : "other";
    } catch (error) {
      return codeOf(error) === "ENOENT" ? "absent" : { code: codeOf(error) };
    }
  };
  const original = kind(join(install.versions, pending.version));
  const left = kind(join(install.versions, pending.folder));
  const unknown = [original, left].find((k) => typeof k === "object");
  if (typeof unknown === "object") {
    return { pending, act: "keep", problem: `it cannot be looked at (${unknown.code})` };
  }
  if (original !== "absent") return { pending, act: "clear", retired: false };
  if (left === "absent") return { pending, act: "clear", retired: true };
  if (left === "other") return { pending, act: "keep", problem: "it is a link, not a folder" };
  const problem = leftoverProblem(join(install.versions, pending.folder), pending.version);
  return problem === undefined ? { pending, act: "delete" } : { pending, act: "keep", problem };
}

/** What a pass would do, changing nothing, for doctor: undefined when the install is not provably this one. */
export function planRetirement(options: RetireOptions): RetirePlan | undefined {
  const install = owned(options);
  if (install === undefined) return undefined;
  const verdicts = [...new Set(strings(install.record["versions"]))].flatMap(
    (version) => judge(options, install, version) ?? [],
  );
  const cut = recoveryOf(options, install);
  return {
    verdicts,
    ...(cut === undefined
      ? {}
      : { pending: { ...cut.pending, ...(cut.act === "keep" ? { problem: cut.problem } : {}) } }),
  };
}

export interface Retired {
  readonly removed: readonly string[];
  /** The error code of the step that stopped the pass: what is left waits for the next one. */
  readonly failed?: string;
}

/** Deletes a version folder, its manifest.json last, so what is left can still be proved. */
async function removeVersion(folder: string): Promise<void> {
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  for (const name of readdirSync(folder)) {
    if (name !== MANIFEST_FILE) await rm(join(folder, name), options);
  }
  await rm(folder, options);
}

/** Lets the service answer between one folder's checks and the next. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One pass, with update.lock held. Each version is checked, its use last, right before its rename.
 * It never throws: a failure stops it and is returned.
 */
export async function retireLocked(options: RetireOptions): Promise<Retired> {
  const { root, state, platform } = options;
  const removed: string[] = [];
  const record = (change: Parameters<typeof writeInstallRecord>[3]) =>
    writeInstallRecord(state, root, platform, change);
  try {
    const install = owned(options);
    if (install === undefined) return { removed };
    const cut = recoveryOf(options, install);
    // Left as it is while what is in it cannot be proved the version's: doctor names it.
    if (cut?.act === "keep") return { removed };
    if (cut?.act === "delete") await removeVersion(join(install.versions, cut.pending.folder));
    if (cut !== undefined) {
      const retired = cut.act === "delete" || cut.retired;
      record({ retiring: null, ...(retired ? { retired: cut.pending.version } : {}) });
      if (retired) removed.push(cut.pending.version);
    }
    for (const version of new Set(strings(install.record["versions"]))) {
      await turn();
      if (judge(options, install, version)?.kind !== "retire") continue;
      const retiring = { version, folder: retiringName(version, randomBytes(8).toString("hex")) };
      record({ retiring });
      try {
        renameSync(join(install.versions, version), join(install.versions, retiring.folder));
      } catch (error) {
        record({ retiring: null });
        throw error;
      }
      await removeVersion(join(install.versions, retiring.folder));
      record({ retiring: null, retired: version });
      removed.push(version);
    }
    return { removed };
  } catch (error) {
    return { removed, failed: codeOf(error) };
  }
}

/** A pass that takes update.lock without waiting: undefined when an update or install holds it. */
export async function retireWhenIdle(options: RetireOptions): Promise<Retired | undefined> {
  let lock;
  try {
    lock = await acquireLock(join(options.state, UPDATE_LOCK));
  } catch (error) {
    if (error instanceof LockBusy) return undefined;
    return { removed: [], failed: codeOf(error) };
  }
  try {
    return await retireLocked(options);
  } finally {
    lock.release();
  }
}
