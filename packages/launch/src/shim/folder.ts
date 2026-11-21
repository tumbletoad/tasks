// The folder a terminal launch works in: resolved by the service right before the launch, checked
// by the shim inside it.
//
// A plan names a folder (the task's or its project's on this machine) or none. A folder resolves
// as the absolute path it is, and never falls back to anything else: a folder that is missing or
// is a file fails the launch with its reason. A plan with no folder works in the space's TTasks work
// folder on this machine, `<machine state>/workdirs/space-<space ID>/`, created on first use, empty
// and user-only, and resolved as a place under the machine state folder. So every launch has a
// folder check, and the shim runs the same check for both. Telling `none` from `other_machine` is
// the caller's: a task whose folder is only on another machine never reaches a plan here.
//
// The work folder is TTasks's own, so it is held to more than a person's folder: before anything is
// made in it or below it,
// `workdirs` and then the space's folder must each be a real folder (not a link, a junction or any
// other reparse point: on Windows a directory entry reports every reparse point as a link), this
// user's (POSIX: its owner; Node reads no owner on Windows, where the state folder's ACL admits
// only this user, SYSTEM and administrators), user-only on POSIX (no bit for the group or others:
// a mode is never changed, a folder with another one is refused), and inside its parent by
// identity, not by its path's text (POSIX: the identity of `<folder>/..`, which the kernel reads
// from the folder itself; Windows: the identity of its real path's parent). A missing folder is
// made, 0700, only in a parent that has just passed, and checked again once made. Anything else is
// refused with `unsafe_folder` (or `not_a_directory`), nothing is made through a link, and only
// then is the work folder resolved like a place.
//
// What remains: a folder can still change between its check and the next call that names it by
// path, because Node has no `mkdirat` or `openat`. A link put in place of a checked `workdirs`
// before the space's folder is made makes that one empty folder (0700) where the link leads; the
// check after it refuses the launch, so nothing is started or written there. Only this user (or an
// administrator) can do that: the machine state folder is the user's own and user-only (A2 3.2.2),
// so the window gives no one anything they could not already do.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { join, posix, win32 } from "node:path";
import { makeDir } from "@ttasks/files";
import {
  identityOf,
  resolveFolder,
  resolvePlace,
  type FolderIdentity,
  type FolderResolution,
  type ResolveReason,
} from "../places.ts";
import type { PlanFolder } from "./records.ts";

/**
 * The root ID the work folder resolves under, in a list of its own: the machine state folder.
 * No machine.toml root can have it (sections.ts ROOT_ID has no `<`).
 */
export const WORK_ROOT = "<state>";

/** The work folder's path below the machine state folder. */
export const workFolderPath = (space: string): string => `workdirs/space-${space}`;

export interface LaunchFolderOptions {
  /** The install's machine state folder (A2 3.2.1 `<state>`), which holds the work folders. */
  readonly stateDir: string;
  readonly platform?: NodeJS.Platform;
}

/** Whether the work folder may be used: made when missing, and checked. */
export type WorkFolderCheck =
  { readonly status: "ok" } | { readonly status: "failed"; readonly reason: ResolveReason };

/** One folder of the work folder's path as it is now. */
type Look =
  | { readonly status: "ok"; readonly identity: FolderIdentity }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly reason: ResolveReason };

const failed = (reason: ResolveReason): { status: "failed"; reason: ResolveReason } => ({
  status: "failed",
  reason,
});

const sameAs = (found: BigIntStats, identity: FolderIdentity): boolean => {
  const own = identityOf(found);
  return own !== undefined && own.dev === identity.dev && own.ino === identity.ino;
};

/**
 * The folder `name` in `parent` (whose identity is `parentId`), checked as the head of this file
 * says, without following anything: its directory entry, its own lstat, and its parent by identity.
 */
function look(
  parent: string,
  parentId: FolderIdentity,
  name: string,
  platform: NodeJS.Platform,
): Look {
  const path = join(parent, name);
  const fold = (s: string): string =>
    platform === "win32" || platform === "darwin" ? s.toLowerCase() : s;
  // The entry's own type: a reparse point of any kind is a link here on Windows (libuv's scandir
  // reads its attribute), where lstat sees only symbolic links and junctions.
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return failed("path_missing");
  }
  const entry = entries.find((e) => fold(e.name) === fold(name));
  if (entry === undefined) return { status: "missing" };
  if (entry.isSymbolicLink()) return failed("unsafe_folder");
  if (!entry.isDirectory()) return failed("not_a_directory");
  let found: BigIntStats;
  try {
    found = lstatSync(path, { bigint: true });
  } catch {
    return failed("path_missing");
  }
  if (found.isSymbolicLink()) return failed("unsafe_folder");
  if (!found.isDirectory()) return failed("not_a_directory");
  const identity = identityOf(found);
  if (identity === undefined) return failed("identity_unavailable");
  if (platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || found.uid !== BigInt(uid)) return failed("unsafe_folder");
    if ((found.mode & 0o077n) !== 0n) return failed("unsafe_folder");
  }
  // Inside its parent by identity: the directory above this very folder is the checked parent.
  try {
    let above: BigIntStats;
    if (platform === "win32") {
      // Windows folds `..` in a path as text, so the parent is read from the real path.
      const real = realpathSync.native(path);
      if (fold(win32.basename(real)) !== fold(name)) return failed("unsafe_folder");
      above = statSync(win32.dirname(real), { bigint: true });
      if (!sameAs(statSync(real, { bigint: true }), identity)) return failed("unsafe_folder");
    } else {
      // `..` from the folder itself, which the kernel resolves from the directory, not the text.
      above = statSync(`${path}${posix.sep}..`, { bigint: true });
    }
    if (!sameAs(above, parentId)) return failed("unsafe_folder");
  } catch {
    return failed("path_missing");
  }
  return { status: "ok", identity };
}

/**
 * Makes `<state>/workdirs/space-<space>/` when it is not there and checks every folder of it before
 * anything is made in it or below it, as the head of this file says. Each folder it makes is 0700,
 * set on the folder itself so the umask cannot loosen it; on Windows the state folder's user-only
 * ACL is inherited (A2 3.2.1). A folder that is there is never changed: it passes or is refused.
 */
export function ensureWorkFolder(stateDir: string, space: string): WorkFolderCheck {
  // The file system's own rules, whatever OS's path rules a caller resolves places with.
  const platform = process.platform;
  let parentId: FolderIdentity | undefined;
  try {
    const state = statSync(stateDir, { bigint: true });
    if (!state.isDirectory()) return failed("root_unavailable");
    parentId = identityOf(state);
  } catch {
    return failed("root_unavailable");
  }
  if (parentId === undefined) return failed("identity_unavailable");
  let parent = stateDir;
  for (const name of workFolderPath(space).split("/")) {
    let found = look(parent, parentId, name, platform);
    if (found.status === "missing") {
      // Made only in `parent`, which has just passed (or is the state folder itself), and never
      // above it: exactly 0700, set on the folder this mkdir made through a descriptor that
      // follows no link (@ttasks/files), never by its path.
      const path = join(parent, name);
      try {
        makeDir(path, 0o700, { recursive: false });
      } catch (error) {
        // Made meanwhile, or a link put there: the look below decides.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return failed("path_missing");
      }
      found = look(parent, parentId, name, platform);
    }
    if (found.status === "missing") return failed("path_missing");
    if (found.status === "failed") return found;
    parent = join(parent, name);
    parentId = found.identity;
  }
  return { status: "ok" };
}

/**
 * The folder a launch of `space` works in, resolved now: the plan's folder, or for none the space's
 * work folder (made on first use, and checked as TTasks's own) under the machine state folder. On
 * `ok`, `folder` is where the shim's terminal starts and `check` is what the shim checks there.
 */
export async function resolveLaunchFolder(
  folder: PlanFolder | null,
  space: string,
  options: LaunchFolderOptions,
): Promise<FolderResolution> {
  const platform = options.platform ?? process.platform;
  if (folder !== null) return resolveFolder(folder.path, { platform });
  const made = ensureWorkFolder(options.stateDir, space);
  if (made.status === "failed") return { status: "failed", reason: made.reason };
  const found = await resolvePlace(
    { root: WORK_ROOT, path: workFolderPath(space), kind: "folder" },
    [{ id: WORK_ROOT, path: options.stateDir }],
    { platform },
  );
  return found.status === "ok"
    ? { status: "ok", folder: found.folder, identity: found.identity, check: found.check }
    : { status: "failed", reason: found.reason };
}
