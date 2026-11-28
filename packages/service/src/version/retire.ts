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
// `.retiring-<v>-<hex>`, which no launcher starts, and cleared once that folder is deleted; the
// next pass finishes one that was cut off. A folder with that prefix that install.json does not
// name is never touched. Not update.json: its presence means an update was cut off, to the
// launchers, doctor and the service of an older version.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { compareAppVersions, isAppVersion } from "@ttasks/storage";
import { acquireLock, LockBusy } from "../hub/lock.ts";
import { canonicalStatePath, installId } from "../hub/paths.ts";
import { checkVersionFolder, readVersionManifest } from "./folder.ts";
import { journalPresent } from "./journal.ts";
import {
  currentVersion,
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
  /** The folder is not as the installer left it: `problem` says how. */
  | { readonly version: string; readonly kind: "foreign"; readonly problem: string }
  | { readonly version: string; readonly kind: "retire" };

export interface RetirePlan {
  readonly verdicts: readonly VersionVerdict[];
  readonly pending?: Retiring;
}

/** Whether a process may run a program of the version folder. Any doubt is true. */
export type InUse = (folder: string, platform: NodeJS.Platform) => boolean;

export interface RetireOptions {
  readonly root: string;
  readonly state: string;
  readonly platform: NodeJS.Platform;
  readonly inUse?: InUse;
}

const isDir = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Windows refuses to open a running program, or a library a process has loaded, for writing
 * (measured on Windows 11). Opening one for writing changes nothing in it.
 */
function inUseWindows(folder: string): boolean {
  const files = Object.keys(readVersionManifest(folder).files);
  for (const path of files.filter((p) => /\.(?:exe|dll|node)$/i.test(p))) {
    try {
      closeSync(openSync(join(folder, ...path.split("/")), "r+"));
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Linux: a process whose program is one of the version's files (its runtime, in a release), by
 * device and inode, so another path to the same file matches too.
 */
function inUseLinux(folder: string): boolean {
  const files = new Set(
    Object.keys(readVersionManifest(folder).files).map((path) => {
      const { dev, ino } = statSync(join(folder, ...path.split("/")));
      return `${String(dev)}:${String(ino)}`;
    }),
  );
  const uid = process.getuid?.();
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const exe = statSync(`/proc/${pid}/exe`);
      if (files.has(`${String(exe.dev)}:${String(exe.ino)}`)) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      // One of the person's own processes that cannot be looked at: it might run this version.
      try {
        if (statSync(`/proc/${pid}`).uid === uid) return true;
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return false;
}

export const osInUse: InUse = (folder, platform) => {
  try {
    if (platform === "win32") return inUseWindows(folder);
    if (platform === "linux") return inUseLinux(folder);
  } catch {
    // What cannot be looked at counts as in use.
  }
  return true;
};

/**
 * What a pass would do, changing nothing: undefined when the install is not provably this one
 * (install.json's root and install ID, a plain `versions` folder, a readable current) or a journal
 * is there. Doctor shows it; retireLocked acts on it.
 */
export function planRetirement(options: RetireOptions): RetirePlan | undefined {
  const { root, state, platform } = options;
  const inUse = options.inUse ?? osInUse;
  const record = readInstallRecord(state);
  const canon = (path: string) => canonicalStatePath(path, platform);
  let id: string;
  try {
    id = installId(canon(realpathSync.native(state)));
  } catch {
    return undefined;
  }
  const current = currentVersion(root, platform);
  if (
    journalPresent(state) ||
    record?.["method"] !== "script" ||
    typeof record["root"] !== "string" ||
    canon(record["root"]) !== canon(root) ||
    record["install_id"] !== id ||
    !isDir(join(root, VERSIONS)) ||
    current === undefined
  ) {
    return undefined;
  }
  // Windows does not tell `0.4.0-RC1` from `0.4.0-rc1`: one folder.
  const same = (a: string, b: unknown) =>
    typeof b === "string" && (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const pinned = strings(record["pinned"]);
  const verdicts: VersionVerdict[] = [];
  for (const version of new Set(strings(record["versions"]))) {
    const folder = join(root, VERSIONS, version);
    const keep: KeptFor | undefined = same(version, current)
      ? "current"
      : same(version, record["previous"])
        ? "rollback"
        : pinned.some((p) => same(version, p))
          ? "pinned"
          : isAppVersion(version) &&
              isAppVersion(current) &&
              compareAppVersions(version, current) > 0
            ? "newer"
            : undefined;
    let problem: string | undefined;
    if (keep !== undefined) {
      verdicts.push({ version, kind: "kept", why: keep });
      continue;
    }
    try {
      lstatSync(folder);
    } catch {
      continue;
    }
    if (!isDir(folder)) problem = "it is a link, not a folder";
    else if (!isAppVersion(version)) problem = "its name is no release version";
    else {
      let named: string | undefined;
      try {
        named = readVersionManifest(folder).version;
      } catch {
        named = undefined;
      }
      const found =
        named === version ? checkVersionFolder(folder) : ["its manifest names another version"];
      problem = found[0];
    }
    if (problem !== undefined) verdicts.push({ version, kind: "foreign", problem });
    else if (inUse(folder, platform)) verdicts.push({ version, kind: "in_use" });
    else verdicts.push({ version, kind: "retire" });
  }
  const pending = pendingRetiring(record);
  return { verdicts, ...(pending === undefined ? {} : { pending }) };
}

export interface Retired {
  readonly removed: readonly string[];
  /** The error code of the step that stopped the pass: what is left waits for the next one. */
  readonly failed?: string;
}

const codeOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "error";
};

const removeFolder = (path: string): void => {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

/** One pass, with update.lock held. It never throws: a failure stops it and is returned. */
export function retireLocked(options: RetireOptions): Retired {
  const { root, state, platform } = options;
  const removed: string[] = [];
  const record = (change: Parameters<typeof writeInstallRecord>[3]) =>
    writeInstallRecord(state, root, platform, change);
  try {
    const plan = planRetirement(options);
    if (plan === undefined) return { removed };
    const versions = join(root, VERSIONS);
    if (plan.pending !== undefined) {
      const { version, folder } = plan.pending;
      if (isDir(join(versions, folder))) removeFolder(join(versions, folder));
      // The rename never happened when the version is still under its own name.
      const renamed = !isDir(join(versions, version));
      record({ retiring: null, ...(renamed ? { retired: version } : {}) });
      if (renamed) removed.push(version);
    }
    for (const verdict of plan.verdicts) {
      if (verdict.kind !== "retire") continue;
      const retiring = {
        version: verdict.version,
        folder: retiringName(verdict.version, randomBytes(8).toString("hex")),
      };
      record({ retiring });
      try {
        renameSync(join(versions, verdict.version), join(versions, retiring.folder));
      } catch (error) {
        record({ retiring: null });
        throw error;
      }
      removeFolder(join(versions, retiring.folder));
      record({ retiring: null, retired: verdict.version });
      removed.push(verdict.version);
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
    return retireLocked(options);
  } finally {
    lock.release();
  }
}
