// Places (A1 3.15, A4 3.3, R11): a place is a root ID and a relative path. Roots are this
// machine's own (machine.toml `[roots]`), so a space holds no absolute path. This module turns a
// place into the folder it names on this machine, or a reason, and an absolute folder into a
// place, or a reason; and it holds the check the process that works in a place's folder runs there.
//
// What it promises, and what it does not (A1 3.15). A path cannot be checked and used
// at one moment from Node: every look at a path resolves it again, so the tree may change between
// two looks. What can be exact is the identity of a directory a process is in. So the guarantee is
// in two parts:
// - `resolvePlace` reads the tree once, in one pass, without retries. At one moment during the
//   call (one stat of the place's path through the root as configured) the place named a
//   directory (a file, for a file place) with the identity it returns. Its other checks (kind,
//   inside the root, the remote)
//   were each true when they were read, in the same pass. It does not promise that the path still
//   names that directory afterwards, nor that the checks held at one and the same moment.
// - `checkWorkingFolder` runs in the process that will work in the folder, after it made the
//   folder its working directory and before it starts anything: it compares the identity of that
//   directory, the root's directory at the depth `resolvePlace` found and the Git remote, each read
//   through `.`, with what `resolvePlace` returned. On Linux and macOS `.` is the directory the
//   process holds, so a process that passed it is in the directory that was resolved, whatever
//   happened to the path. On Windows Node reads `.` through the working-folder path; the directory
//   a process is in, and its ancestors, cannot be renamed or removed while it is there, which ties
//   the path to it, except for the residual cases A1 3.15 names. The remote is read
//   step by step: it is an observation of which repository is there, not part of the identity.
//
// The rules for the place's path (`isPlacePath`): `/`-separated, no empty, `.` or `..` segment, no
// control, bidirectional or zero-width character, no backslash, no drive in front, NFC, at most
// 1,024 characters (A1 3.15); on Windows also no segment Win32 would read as
// another name (a trailing dot or space, `<>:"|?*`, a device name) and no short name (8.3).
// Identity is a directory's volume and file number; a volume that gives no file number (0) gives
// no identity, and then nothing resolves there (`identity_unavailable`), by design.
//
// Errors and results never carry a path out of this machine: a reason names the root ID only.
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { BigIntStats } from "node:fs";
import { readGitRemote, type GitRemote } from "./git-remote.ts";

type PlatformPath = typeof posix;

/** Why a place does not resolve to a folder, or a working folder fails its check. A closed list. */
export const RESOLVE_REASONS = [
  /** The relative path is not a place's path (A1 3.15). */
  "invalid_path",
  /** This machine has no root with the place's root ID. */
  "root_missing",
  /** The root's folder is not there, is not a folder or cannot be reached. */
  "root_unavailable",
  /** The place's folder is not there or cannot be reached (a dangling link included). */
  "path_missing",
  /** The place is a folder and a file is there (through a link to a file included). */
  "not_a_directory",
  /** The place is a file and something else is there. */
  "not_a_file",
  /** The path leads outside the root's folder, through a link or a junction. */
  "escapes_root",
  /** The folder holds another repository than the one the place recorded, or none it can read. */
  "identity_mismatch",
  /** The volume gives no file number (0), so the folder has no identity to check: never guessed. */
  "identity_unavailable",
  /**
   * The working folder is not the directory `resolvePlace` found, or no longer lies at the depth
   * it found below the root's directory: the tree changed in between.
   */
  "folder_changed",
  /**
   * A folder Tasks makes and owns (the space's work folder, A4 3.3) is not one it may work
   * in: a link, a junction or another reparse point, another user's, open to other users (POSIX),
   * or not inside its parent by identity.
   */
  "unsafe_folder",
  /** The folder's drive or share did not answer in time: nothing was started. */
  "not_answering",
] as const;
export type ResolveReason = (typeof RESOLVE_REASONS)[number];

/** Why an absolute folder does not become a place on this machine. A closed list. */
export const BIND_REASONS = [
  /** Not an absolute path on this machine's OS (a drive or UNC path on Windows). */
  "not_absolute",
  /** A `.` or `..` segment, a device path, or a folder whose name a place cannot hold exactly. */
  "invalid_path",
  /** The folder is not there or cannot be reached. */
  "path_missing",
  /** A file is there, not a folder. */
  "not_a_directory",
  /** No root of this machine holds the folder (A1 3.15 `PLACE_OUTSIDE_ROOTS`). */
  "outside_roots",
  /** Two roots name the same folder, so the folder has no one place. */
  "ambiguous_root",
  /** The volume gives no file number, so the folder has no identity to check. */
  "identity_unavailable",
] as const;
export type BindReason = (typeof BIND_REASONS)[number];

/** A root as places need it: its ID and its folder as machine.toml spells it. */
export interface RootFolder {
  readonly id: string;
  readonly path: string;
}

/** A place as a space stores it, on this machine. */
export interface PlaceRef {
  readonly root: string;
  /** `/`-separated, relative to the root; `""` is the root itself. */
  readonly path: string;
  /** Default `folder`. */
  readonly kind?: "folder" | "file";
  /** The repository's remote recorded at bind time (`identity.git_remote`). */
  readonly gitRemote?: string;
}

/** A file's identity on this machine: its volume and its file number, from one stat. */
export interface FolderIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * What the process that works in a place's folder checks there (`checkWorkingFolder`), as plain
 * data that can travel to that process: numbers as decimal text.
 */
export interface FolderCheck {
  /** The folder's identity: its volume and file number. */
  readonly dev: string;
  readonly ino: string;
  /** The identity of the root's directory. */
  readonly rootDev: string;
  readonly rootIno: string;
  /** How many levels the folder lies below the root's directory (0: the root itself). */
  readonly depth: number;
  /** The remote the place recorded, to be found again; absent when it recorded none. */
  readonly gitRemote?: string;
}

export type Resolution =
  | {
      readonly status: "ok";
      readonly root: string;
      /** The folder's real path, read in the same pass: where to start the process. */
      readonly folder: string;
      /** The identity of the directory the place named at one moment during the call. */
      readonly identity: FolderIdentity;
      /** For `checkWorkingFolder`, in the process that works in the folder. */
      readonly check: FolderCheck;
      /** The folder's Git remote as read during the call (`none` for a file place). */
      readonly remote: GitRemote;
    }
  | { readonly status: "failed"; readonly reason: ResolveReason; readonly root: string };

export type Binding =
  | {
      readonly status: "ok";
      readonly root: string;
      readonly path: string;
      /** The folder's real path: for this machine only, never stored. */
      readonly folder: string;
      readonly identity: FolderIdentity;
      /** The folder's Git remote, read when the place was resolved back. */
      readonly remote: GitRemote;
    }
  | {
      readonly status: "failed";
      readonly reason: BindReason;
      /** For `outside_roots`, every root ID; for `ambiguous_root`, the roots that tie. */
      readonly roots?: readonly string[];
    };

export interface PlaceOptions {
  /** The OS whose path rules apply. Default: this process's. The file system is always real. */
  readonly platform?: NodeJS.Platform;
}

const pathOf = (platform: NodeJS.Platform): PlatformPath => (platform === "win32" ? win32 : posix);

/**
 * A name with each letter lowercased on its own, closer to NTFS's table: one character for one, with
 * no rule that looks at its neighbours (JavaScript's `toLowerCase` makes a final `Σ` a `ς`, which
 * NTFS keeps apart from `σ`) and none that turns one character into two (`İ`). Used only to refuse
 * a name that is not the folder's own (A1 3.15): the file system has already found the folder.
 */
function letterFold(name: string): string {
  let out = "";
  for (const c of name) {
    const lower = c.toLowerCase();
    out += Array.from(lower).length === 1 ? lower : c;
  }
  return out;
}

/** Whether names that differ only in case usually name one file there. */
const foldsCase = (platform: NodeJS.Platform): boolean =>
  platform === "win32" || platform === "darwin";

// ---------------------------------------------------------------------------------------------
// The relative path as text

/** A place's path holds at most this many characters (A1 3.15). */
export const MAX_PLACE_PATH = 1024;

// Characters a place path never holds (A1 3.15, as storage's writer refuses them): C0 and C1
// controls, DEL, bidirectional controls, zero-width characters and the backslash. Built from
// escapes, so the source holds no invisible character.
const PATH_FORBIDDEN = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" +
    "\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069" +
    "\\u200b-\\u200d\\u2060\\ufeff" +
    "\\\\" +
    "]",
  "u",
);
/** A segment that starts with a drive letter and a colon, which Windows reads as a drive. */
const DRIVE = /^[A-Za-z]:/u;
/** Characters Win32 does not allow in a name; a colon names an alternate data stream. */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/u;
/** Win32's device names, with or without an extension: `NUL` and `nul.txt` open the device. */
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu;

/** Whether one segment of a path is a name Win32 opens as that very name. */
function windowsName(segment: string): boolean {
  return (
    !WINDOWS_RESERVED_CHARS.test(segment) &&
    !/[. ]$/u.test(segment) &&
    !WINDOWS_DEVICE.test(segment.replace(/ +(?=\.|$)/u, ""))
  );
}

/**
 * Whether `path` is a place's relative path on `platform` (A1 3.15): `""` for the
 * root itself, else segments joined by `/`, none empty, `.` or `..`, no forbidden character, no
 * drive in front, in NFC and well formed, at most 1,024 characters. On Windows each segment is
 * also a name Win32 opens as written.
 */
export function isPlacePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (path === "") return true;
  if (Array.from(path).length > MAX_PLACE_PATH) return false;
  if (PATH_FORBIDDEN.test(path) || DRIVE.test(path)) return false;
  if (!path.isWellFormed() || path.normalize("NFC") !== path) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        (platform !== "win32" || windowsName(segment)),
    );
}

/**
 * An absolute path given for this machine, made ready for `realpath`, or the reason it is not one:
 * on Windows a drive path (`C:\x`, `C:/x`), a UNC path (`\\server\share\x`) or either in the
 * extended form (`\\?\C:\x`, `\\?\UNC\server\share\x`); elsewhere a path from `/`. A `.` or `..`
 * segment is refused rather than read, so no reading of `..` (lexical or through a link) decides
 * the folder; so is a device path (`\\.\`), and on Windows a segment Win32 would read as another
 * name.
 */
export function absoluteFolder(
  given: string,
  platform: NodeJS.Platform = process.platform,
): AbsoluteFolder {
  return absoluteWith(given, platform, PATH_FORBIDDEN);
}

type AbsoluteFolder =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: BindReason };

// C0 and C1 controls and DEL, which the folders a person binds never hold. Built from escapes, so
// the source holds no invisible character.
// eslint-disable-next-line no-control-regex -- the controls are what this refuses.
const CONTROLS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "u");

/**
 * A person's folder as the space stores it, made ready for `realpath` as `absoluteFolder` makes a
 * root, but with the characters any folder name may hold: a zero-width joiner in an emoji or in
 * Persian text, or a bidirectional mark, is part of a real folder's name.
 */
export function folderPath(
  given: string,
  platform: NodeJS.Platform = process.platform,
): AbsoluteFolder {
  return absoluteWith(given, platform, CONTROLS);
}

function absoluteWith(given: string, platform: NodeJS.Platform, forbidden: RegExp): AbsoluteFolder {
  if (given === "" || given.includes("\u0000") || given.length > 4096) {
    return { ok: false, reason: "not_absolute" };
  }
  // A lone surrogate is not text: Node would replace it (with U+FFFD) before the file system saw
  // it, so it would name another folder.
  if (!given.isWellFormed() || forbidden.test(given.replaceAll("\\", "/"))) {
    return { ok: false, reason: "invalid_path" };
  }
  let path = given;
  let segments: string[];
  if (platform === "win32") {
    if (/^[\\/]{2}\?[\\/]UNC[\\/]/iu.test(path)) path = `\\\\${path.slice(8)}`;
    else if (/^[\\/]{2}\?[\\/][A-Za-z]:[\\/]/u.test(path)) path = path.slice(4);
    else if (/^[\\/]{2}[?.][\\/]/u.test(path)) return { ok: false, reason: "invalid_path" };
    if (/^[A-Za-z]:[\\/]/u.test(path)) segments = path.slice(3).split(/[\\/]/u);
    else if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/u.test(path)) segments = path.slice(2).split(/[\\/]/u);
    else return { ok: false, reason: "not_absolute" };
  } else {
    if (!path.startsWith("/")) return { ok: false, reason: "not_absolute" };
    segments = path.slice(1).split("/");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") return { ok: false, reason: "invalid_path" };
    if (platform === "win32" && segment !== "" && !windowsName(segment)) {
      return { ok: false, reason: "invalid_path" };
    }
  }
  return { ok: true, path };
}

// ---------------------------------------------------------------------------------------------
// Identities

const bigStat = (path: string): Promise<BigIntStats> => stat(path, { bigint: true });

/** The most links a chain may hold, as Linux follows them (MAXSYMLINKS): one more is a loop. */
const MAX_LINKS = 40;

/**
 * Why a path whose stat failed names no folder (A1 3.15). Linux and macOS follow a link to a file,
 * so their stat already says `not_a_directory`, and a failed stat there is `path_missing`. Windows
 * cannot follow a junction or a directory link to a file, and its stat says the path is missing:
 * there the link's own chain is read with lstat and readlink, at most 40 links as Linux follows
 * them. A relative target is taken from the real folder the link lies in, never by spelling, so a
 * link reached through another link leads where the file system takes it. A chain that ends at
 * something that is not a folder is `not_a_directory`, anything else `path_missing`. Read only after
 * the stat failed, so it decides which refusal is given and never that a place resolves.
 */
async function missingReason(
  path: string,
  P: PlatformPath,
): Promise<"path_missing" | "not_a_directory"> {
  if (process.platform !== "win32") return "path_missing";
  let at = path;
  for (let links = 0; ; links += 1) {
    try {
      const entry = await lstat(at);
      if (!entry.isSymbolicLink()) return entry.isDirectory() ? "path_missing" : "not_a_directory";
      if (links === MAX_LINKS) return "path_missing";
      at = P.resolve(await realpath(P.dirname(at)), await readlink(at));
    } catch {
      return "path_missing";
    }
  }
}

/** The largest file number, which Windows gives when a file's ID does not fit (ReFS). */
const NO_FILE_ID = 2n ** 64n - 1n;

/**
 * A stat's identity, or undefined when the volume gives none: a file number of 0 (some network
 * shares and file systems) or of all ones. Then nothing can tell two of its files apart, so no
 * check compares them: they fail closed, never fall back to comparing paths.
 */
export function identityOf(found: Pick<BigIntStats, "dev" | "ino">): FolderIdentity | undefined {
  if (found.ino === 0n || found.ino === NO_FILE_ID) return undefined;
  return { dev: found.dev, ino: found.ino };
}

/** A folder's identity as one evidence ID, `<volume>:<file number>` (A4 3.9's `folder_id`). */
export const identityKey = (identity: FolderIdentity): string =>
  `${identity.dev.toString()}:${identity.ino.toString()}`;

/**
 * The identity key of a folder now, by one stat: undefined when the path is not absolute, not a
 * directory, cannot be read, or its volume gives no identity. A best-effort app's binding compares
 * the bridge's working folder with the launch's this way (A4 3.4.4), never by spelling.
 */
export async function folderKeyOf(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (!pathOf(platform).isAbsolute(folder)) return undefined;
  try {
    const found = await bigStat(folder);
    if (!found.isDirectory()) return undefined;
    const identity = identityOf(found);
    return identity === undefined ? undefined : identityKey(identity);
  } catch {
    return undefined;
  }
}

/** Whether two stats are one file: both have an identity, and it is the same. */
export function sameIdentity(
  a: Pick<BigIntStats, "dev" | "ino">,
  b: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  const x = identityOf(a);
  const y = identityOf(b);
  return x !== undefined && y !== undefined && x.dev === y.dev && x.ino === y.ino;
}

/** A real path as its root and its segments, by the platform's rules. */
function partsOf(real: string, P: PlatformPath): { root: string; segments: string[] } {
  const root = P.parse(real).root;
  const segments = real
    .slice(root.length)
    .split(P.sep)
    .filter((s) => s !== "");
  return { root, segments };
}

/**
 * The relative path of `real` under the root whose real path is `rootReal` (`""` for the root
 * itself), or undefined when `real` is not at or below it. Both are real paths. Segment by segment,
 * case-folded where the platform usually ignores case, and confirmed by identity: the folder of
 * `real` at the root's depth must be the root's folder.
 */
async function below(
  rootReal: string,
  rootIdentity: FolderIdentity,
  real: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const P = pathOf(platform);
  const fold = (s: string) => (foldsCase(platform) ? s.toLowerCase() : s);
  const root = partsOf(rootReal, P);
  const target = partsOf(real, P);
  if (fold(root.root) !== fold(target.root)) return undefined;
  if (target.segments.length < root.segments.length) return undefined;
  for (let i = 0; i < root.segments.length; i += 1) {
    if (fold(root.segments[i] ?? "") !== fold(target.segments[i] ?? "")) return undefined;
  }
  const atDepth = target.root + target.segments.slice(0, root.segments.length).join(P.sep);
  try {
    if (!sameIdentity(await bigStat(atDepth), rootIdentity)) return undefined;
  } catch {
    return undefined;
  }
  return target.segments.slice(root.segments.length).join("/");
}

/** A root's folder as configured (made ready for the file system), its identity and real path. */
type RootRead =
  | { readonly given: string; readonly identity: FolderIdentity; readonly real: string }
  | "unavailable"
  | "no_identity";

async function readRoot(root: RootFolder, platform: NodeJS.Platform): Promise<RootRead> {
  const ready = absoluteFolder(root.path, platform);
  if (!ready.ok) return "unavailable";
  try {
    const found = await bigStat(ready.path);
    if (!found.isDirectory()) return "unavailable";
    const identity = identityOf(found);
    if (identity === undefined) return "no_identity";
    return { given: ready.path, identity, real: await realpath(ready.path) };
  } catch {
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------------------------
// resolve: a place to its folder

/**
 * The folder `place` names on this machine, given this machine's roots, or the reason it names
 * none (A1 3.15 `exact`, A4 3.3 steps 2 and 3). Never another folder: no parent, no sibling, no
 * fallback. One pass, no retries: the text, the root (its identity, then its real path), on
 * Windows each segment's own name, then the place read through the root as configured in one stat
 * (its kind and identity), its real path, which must lie at or below the root's real path with the
 * root's identity at the root's depth, and its Git remote, which must be the one the place
 * recorded. At one moment during the call, the place named a directory (a file, for a file place)
 * with the identity this returns; each other check held when it was read. Whether the path still names that directory
 * afterwards is for `checkWorkingFolder` to find out, in the process that works there.
 */
export async function resolvePlace(
  place: PlaceRef,
  roots: readonly RootFolder[],
  options: PlaceOptions = {},
): Promise<Resolution> {
  const platform = options.platform ?? process.platform;
  const P = pathOf(platform);
  const failed = (reason: ResolveReason): Resolution => ({
    status: "failed",
    reason,
    root: place.root,
  });
  if (!isPlacePath(place.path, platform)) return failed("invalid_path");
  const root = roots.find((r) => r.id === place.root);
  if (root === undefined) return failed("root_missing");
  const base = await readRoot(root, platform);
  if (base === "unavailable") return failed("root_unavailable");
  if (base === "no_identity") return failed("identity_unavailable");

  const segments = place.path === "" ? [] : place.path.split("/");
  // Windows: every segment that is not a link must be the folder's own name. A short name (8.3)
  // is an alias that may name another folder tomorrow.
  if (platform === "win32") {
    let at = base.real;
    for (const segment of segments) {
      at = P.join(at, segment);
      try {
        if ((await lstat(at)).isSymbolicLink()) continue;
        const own = P.basename(await realpath(at));
        if (letterFold(own) !== letterFold(segment)) return failed("invalid_path");
      } catch {
        break; // Missing: the stat below says so.
      }
    }
  }
  // The place through the root as configured, in one stat: what it names at this moment.
  const named = segments.length === 0 ? base.given : P.join(base.given, ...segments);
  const kind = place.kind ?? "folder";
  let found: BigIntStats;
  try {
    found = await bigStat(named);
  } catch {
    return failed(kind === "folder" ? await missingReason(named, P) : "path_missing");
  }
  if (kind === "folder" ? !found.isDirectory() : !found.isFile()) {
    return failed(kind === "file" ? "not_a_file" : "not_a_directory");
  }
  const identity = identityOf(found);
  if (identity === undefined) return failed("identity_unavailable");
  let real: string;
  try {
    real = await realpath(named);
  } catch {
    return failed("path_missing");
  }
  const rel = await below(base.real, base.identity, real, platform);
  if (rel === undefined) return failed("escapes_root");
  const remote: GitRemote = kind === "folder" ? await readGitRemote(real) : { status: "none" };
  if (place.gitRemote !== undefined && !sameRemote(remote, place.gitRemote)) {
    return failed("identity_mismatch");
  }
  return {
    status: "ok",
    root: place.root,
    folder: real,
    identity,
    check: {
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      rootDev: base.identity.dev.toString(),
      rootIno: base.identity.ino.toString(),
      depth: rel === "" ? 0 : rel.split("/").length,
      ...(place.gitRemote === undefined ? {} : { gitRemote: place.gitRemote }),
    },
    remote,
  };
}

const sameRemote = (found: GitRemote, recorded: string): boolean =>
  found.status === "remote" && found.url === recorded;

/** A folder a launch works in, resolved now: where it starts and what the shim checks there. */
export type FolderResolution =
  | {
      readonly status: "ok";
      /** The folder's real path, read in the same pass. */
      readonly folder: string;
      readonly identity: FolderIdentity;
      readonly check: FolderCheck;
    }
  | { readonly status: "failed"; readonly reason: ResolveReason };

/**
 * The folder at the absolute path `given` on this machine, read once as `resolvePlace` reads a
 * place: it must be there and be a directory with an identity, a link to one included. The check
 * the shim runs in it is the directory's identity alone, so the folder has no root to stay under.
 */
export async function resolveFolder(
  given: string,
  options: PlaceOptions = {},
): Promise<FolderResolution> {
  const platform = options.platform ?? process.platform;
  const failed = (reason: ResolveReason): FolderResolution => ({ status: "failed", reason });
  const ready = folderPath(given, platform);
  if (!ready.ok) return failed("invalid_path");
  let found: BigIntStats;
  try {
    found = await bigStat(ready.path);
  } catch {
    return failed(await missingReason(ready.path, pathOf(platform)));
  }
  if (!found.isDirectory()) return failed("not_a_directory");
  const identity = identityOf(found);
  if (identity === undefined) return failed("identity_unavailable");
  let real: string;
  try {
    real = await realpath(ready.path);
  } catch {
    return failed("path_missing");
  }
  const dev = identity.dev.toString();
  const ino = identity.ino.toString();
  return {
    status: "ok",
    folder: real,
    identity,
    check: { dev, ino, rootDev: dev, rootIno: ino, depth: 0 },
  };
}

// ---------------------------------------------------------------------------------------------
// The check in the folder

/** The result of `checkWorkingFolder`. */
export type WorkingFolderCheck =
  { readonly status: "ok" } | { readonly status: "failed"; readonly reason: ResolveReason };

/** A stat's identity as decimal text against a check's, or false when either has none. */
function matches(found: BigIntStats, dev: string, ino: string): boolean {
  const own = identityOf(found);
  return own !== undefined && own.dev.toString() === dev && own.ino.toString() === ino;
}

/**
 * The in-folder check (A1 3.15; A4 3.3 step 4: "the shim sets the process cwd and
 * re-checks it"). Called by the process that will work in a place's folder, after it made the
 * folder its working directory (it was started there, or changed to it) and before it starts the
 * agent or does any other work there; on a refusal it starts nothing and reports the reason.
 * Everything is read through `.`, never through the folder's path:
 * - the identity of `.` must be the one `resolvePlace` returned (`folder_changed` otherwise; a
 *   directory that was removed meanwhile is `path_missing`);
 * - `..` taken `depth` times from `.` must be the root's directory (`folder_changed`): the
 *   directory still lies where it was found below the root, so a link that led outside the root
 *   while `resolvePlace` read it cannot carry the process out of the root;
 * - when the place recorded a remote, the repository in `.` must name it (`identity_mismatch`):
 *   read step by step (`.git`, a git folder, `commondir`, the config), so it catches another
 *   repository that stays there, not one changed while it is read.
 * On Linux and macOS `.` is the directory the process holds, so a process that passed this is in
 * the directory that was resolved, whatever happened to the path. On Windows Node reads `.`
 * through the working-folder path: see A1 3.15 for what that leaves.
 */
export async function checkWorkingFolder(
  check: FolderCheck,
  platform: NodeJS.Platform = process.platform,
): Promise<WorkingFolderCheck> {
  const P = pathOf(platform);
  const failed = (reason: ResolveReason): WorkingFolderCheck => ({ status: "failed", reason });
  let here: BigIntStats;
  try {
    here = await bigStat(".");
  } catch {
    return failed("path_missing");
  }
  if (!here.isDirectory()) return failed("not_a_directory");
  if (identityOf(here) === undefined) return failed("identity_unavailable");
  if (!matches(here, check.dev, check.ino)) return failed("folder_changed");
  // A directory removed while a process is in it has no links left (Linux and macOS).
  if (here.nlink === 0n) return failed("path_missing");
  if (!Number.isSafeInteger(check.depth) || check.depth < 0) return failed("folder_changed");
  const up = check.depth === 0 ? "." : Array.from({ length: check.depth }, () => "..").join(P.sep);
  try {
    if (!matches(await bigStat(up), check.rootDev, check.rootIno)) return failed("folder_changed");
  } catch {
    return failed("folder_changed");
  }
  if (check.gitRemote !== undefined) {
    if (!sameRemote(await readGitRemote("."), check.gitRemote)) {
      return failed("identity_mismatch");
    }
  }
  return { status: "ok" };
}

// ---------------------------------------------------------------------------------------------
// The inverse: an absolute folder to a place

/**
 * The place an absolute folder on this machine is (A1 3.15): the root whose real folder holds it
 * most closely (a root nested in another wins) and the relative path below it, or the reason it is
 * none. The folder must exist, be a folder and have an identity. The result resolves back to the
 * same directory, by identity: that is checked before it is returned, so a folder whose name a
 * place cannot hold exactly (a name that is not NFC, a backslash in a name on Linux) is
 * `invalid_path`, never a near miss. One pass, as `resolvePlace`.
 */
export async function placeOf(
  given: string,
  roots: readonly RootFolder[],
  options: PlaceOptions = {},
): Promise<Binding> {
  const platform = options.platform ?? process.platform;
  const P = pathOf(platform);
  const failed = (reason: BindReason, ids?: readonly string[]): Binding => ({
    status: "failed",
    reason,
    ...(ids === undefined ? {} : { roots: ids }),
  });
  const ready = absoluteFolder(given, platform);
  if (!ready.ok) return failed(ready.reason);
  let found: BigIntStats;
  let real: string;
  try {
    found = await bigStat(ready.path);
  } catch {
    return failed(await missingReason(ready.path, P));
  }
  if (!found.isDirectory()) return failed("not_a_directory");
  try {
    real = await realpath(ready.path);
  } catch {
    return failed("path_missing");
  }
  const identity = identityOf(found);
  if (identity === undefined) return failed("identity_unavailable");

  const read: { id: string; identity: FolderIdentity }[] = [];
  const holders: { id: string; identity: FolderIdentity; depth: number; rel: string }[] = [];
  for (const root of roots) {
    const base = await readRoot(root, platform);
    if (typeof base === "string") continue;
    read.push({ id: root.id, identity: base.identity });
    const rel = await below(base.real, base.identity, real, platform);
    if (rel !== undefined) {
      holders.push({
        id: root.id,
        identity: base.identity,
        depth: partsOf(base.real, P).segments.length,
        rel,
      });
    }
  }
  if (holders.length === 0) return failed("outside_roots", roots.map((r) => r.id).sort());
  const deepest = Math.max(...holders.map((h) => h.depth));
  const [best, ...others] = holders.filter((h) => h.depth === deepest);
  if (best === undefined) return failed("invalid_path");
  // Roots whose folder is the closest root's folder, by identity: one folder under two spellings,
  // whether or not their real paths say so (a bind mount, or a case-folding folder whose realpath
  // keeps the spelling it was given). Two holders at one depth are always one folder.
  const same = read.filter(
    (r) => r.identity.dev === best.identity.dev && r.identity.ino === best.identity.ino,
  );
  if (same.length > 1 || others.length > 0) {
    const ids = new Set([...same.map((r) => r.id), best.id, ...others.map((h) => h.id)]);
    return failed("ambiguous_root", [...ids].sort());
  }
  if (!isPlacePath(best.rel, platform)) return failed("invalid_path");
  const back = await resolvePlace({ root: best.id, path: best.rel }, roots, { platform });
  if (back.status !== "ok") {
    return failed(back.reason === "identity_unavailable" ? back.reason : "invalid_path");
  }
  if (back.identity.dev !== identity.dev || back.identity.ino !== identity.ino) {
    return failed("invalid_path");
  }
  return {
    status: "ok",
    root: best.id,
    path: best.rel,
    folder: real,
    identity,
    remote: back.remote,
  };
}

/** Whether a folder may become a root, as far as the other roots go (`rootNaming`). */
export type RootNaming =
  /** No root among the others names the folder. */
  | { readonly status: "free" }
  /** The root with this ID names the same directory. */
  | { readonly status: "named"; readonly root: string }
  /** The folder has no identity to compare (and no place under it could resolve). */
  | { readonly status: "identity_unavailable" }
  /** The folder is not a reachable folder. */
  | { readonly status: "unavailable" };

/**
 * Two roots that name one folder (by identity), for `tasks roots add`: whether a root among
 * `roots` names the directory `folder` names.
 */
export async function rootNaming(
  folder: string,
  roots: readonly RootFolder[],
  options: PlaceOptions = {},
): Promise<RootNaming> {
  const platform = options.platform ?? process.platform;
  const own = await readRoot({ id: "", path: folder }, platform);
  if (own === "no_identity") return { status: "identity_unavailable" };
  if (own === "unavailable") return { status: "unavailable" };
  for (const root of roots) {
    const base = await readRoot(root, platform);
    if (
      typeof base !== "string" &&
      base.identity.dev === own.identity.dev &&
      base.identity.ino === own.identity.ino
    ) {
      return { status: "named", root: root.id };
    }
  }
  return { status: "free" };
}
