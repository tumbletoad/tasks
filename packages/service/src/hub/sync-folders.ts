// Synced folders and network file systems (A1 3.2). A sync client can copy space.db without its
// -wal, or replace it mid-transaction, and SQLite's WAL needs shared memory on one host, so the
// service checks a space's folder and every folder above it at create and open, and decides how
// the space is served (spaces.ts):
//
//   synced    read-only until the person confirms the folder is excluded from sync (per machine and
//             per path, "It is excluded, open anyway"), with A1's words
//   network   never writable
//
// Either way the person can take the space out of the folder with a backup restored into a new
// local folder (`tasks space backup`, `tasks space restore --to`, then `tasks space claim`); the
// old folder stays where it is (A1 3.2).
//
// The signals, one per row of A1 3.2's table (A1 3.2 names where Windows keeps them):
// - Syncthing: `.stfolder` in an ancestor.
// - Dropbox: `.dropbox` in an ancestor, or a root listed in `~/.dropbox/info.json`.
// - OneDrive: under `%OneDrive%`, `%OneDriveConsumer%` or `%OneDriveCommercial%` (a stale one still
//   counts), or under a `UserFolder` of `HKCU\Software\Microsoft\OneDrive\Accounts\*`.
// - Google Drive: under a mirror root in `HKCU\Software\Google\DriveFS\Share\SyncTargets` (paths in
//   UTF-8 or UTF-16 inside the value), or on a volume labelled "Google Drive".
// - Cloud Files (Windows): under a sync root registered for this user in SyncRootManager.
// - iCloud and macOS cloud folders: under `~/Library/Mobile Documents/` or `~/Library/CloudStorage/`.
// - Nextcloud, ownCloud: `.owncloudsync.log` or `.sync_*.db` in an ancestor.
// - Git: `.git` in an ancestor (a commit would copy a live database).
// - Network: Linux, `fs.statfs`'s type is NFS, SMB, CIFS, 9p, AFS (and Ceph, Coda, NCP), or FUSE with
//   a network subtype in the mount table; macOS, the mount table's type; Windows, a UNC real path
//   (a mapped drive's real path is its UNC path) or a drive Windows reports as a network drive.
// - Conflict copies: `space.sync-conflict-*.db` or `space (… conflicted copy …).db` beside space.db.
//
// Every fact comes through a SyncHost, so tests run every row on fixture trees with captured statfs
// samples, and never read this machine's sync folders or mounts. A folder that does not exist yet
// (a new space's folder) is judged from its nearest existing ancestor. The path is checked as
// given and as its real path, so a link into a synced folder counts.
//
// LOCAL ONLY FROM POSITIVE EVIDENCE (A1 3.2 lists the chain of steps on each platform). The check
// runs as a fixed list of steps (CHECK_STEPS), each through `Evidence.run`: a step is done only
// when its body returned. Every look of the host throws when it fails and answers "nothing there"
// only for a name that is not there, so a look that failed, a step that stopped because it cannot
// see (`unseen()`), a step that never ran, a time-out and a fault all leave a step not done, and a
// folder with any step not done is `unchecked`: served as a synced folder is, read-only until the
// person confirms it is local and excluded from sync. A step never catches a look's failure and
// never falls back to the path as given or to "none": a new step either completes on what it read
// or leaves the folder unchecked. Signals found before a step stopped still count.
//
// The runner proves completion, not that what a step read was whole and current, so three rules
// hold for that (A1 3.2, "How the code holds it"):
// - A decoder answers only from input it read whole, never from the part before a point it could
//   not read. The SyncTargets value is judged by its bytes: every path in them must be a field the
//   walk read.
// - A kept fact counts only for what it was read from: the Windows drive facts for the volumes
//   they read at the drives' roots.
// - A look is made at where the folder and each root lead now (the real path, with the names below
//   it not there yet), and on Linux not through a bind mount's other name.
import { basename, dirname, join, posix, resolve } from "node:path";

/** The sync clients and folder kinds A1 3.2 names. */
export const SYNC_PROVIDERS = [
  "syncthing",
  "dropbox",
  "onedrive",
  "google_drive",
  "icloud",
  "nextcloud",
  "cloud_files",
  "git",
] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

/** How a signal was found. */
export const SYNC_RULES = [
  "marker",
  "provider_root",
  "volume_label",
  "cloud_folder",
  "conflict_copy",
  "network_volume",
  /** A step of the check did not complete: served as a synced folder. */
  "unchecked",
] as const;
export type SyncRule = (typeof SYNC_RULES)[number];

/**
 * The steps of the check, in order (A1 3.2 says what each one reads and when it cannot see). A
 * folder is local only when every one of them completed and no signal was found. `check` is the
 * run as a whole, within its bound.
 */
export const CHECK_STEPS = [
  "folder",
  "real_path",
  "windows_facts",
  "sync_clients",
  "markers",
  "conflicts",
  "volume",
  "check",
] as const;
export type CheckStep = (typeof CHECK_STEPS)[number];

export interface SyncSignal {
  readonly kind: "synced" | "network";
  readonly rule: SyncRule;
  /** The sync client, for a synced signal (a conflict copy names none). */
  readonly provider?: SyncProvider;
  /** The network file system, for a network signal, as a word: `nfs`, `cifs`, `unc` … */
  readonly fs?: string;
  /** The step that did not complete, for an `unchecked` signal. */
  readonly step?: CheckStep;
  /** 0 is the folder itself, 1 its parent, and so on. */
  readonly depth: number;
}

/** What the check found for one folder. */
export interface FolderCheck {
  readonly verdict: "local" | "synced" | "network";
  /** The nearest sync client, when one is known. */
  readonly provider?: SyncProvider;
  /** The network file system, when the verdict is `network`. */
  readonly fs?: string;
  /** Conflict copies of space.db beside it, by file name, for the person. */
  readonly conflicts: readonly string[];
  readonly signals: readonly SyncSignal[];
  /** Whether the folder exists; a missing one was judged from its nearest existing ancestor. */
  readonly exists: boolean;
}

/** What Windows keeps about sync clients and drives (A1 3.2), read in one go. */
export interface WindowsSyncFacts {
  /** `UserFolder` of each account under HKCU\Software\Microsoft\OneDrive\Accounts. */
  readonly oneDriveAccounts: readonly string[];
  /** The Cloud Files sync roots registered for this user: the SyncRootManager key and the path. */
  readonly syncRoots: readonly { readonly id: string; readonly path: string }[];
  /** Drive for desktop's SyncTargets value, base64 ("" when there is none). */
  readonly driveFsTargets: string;
  /** Each drive: its root (`G:\`), its type (`Fixed`, `Network` …), its label and format. */
  readonly drives: readonly {
    readonly root: string;
    readonly type: string;
    readonly label: string;
    readonly format: string;
    /**
     * The identity of the volume at the drive's root when the facts were read (SyncHost.volumeOf),
     * so the facts count only for that volume. Never for a network drive; absent when it could not
     * be read, and a folder on such a drive is unchecked.
     */
    readonly volume?: string;
  }[];
}

/** What is at a path, a link followed: a folder, something else (a file, a link to nothing), nothing. */
export type PathKind = "directory" | "other" | "absent";

/**
 * Where the check reads its facts. The real one is sync-host.ts; tests pass fixtures. Every look
 * throws when it fails: "nothing there" (`absent`, false, undefined, an empty listing) is an answer
 * only for a name that is not there, never for a look that could not be made.
 */
export interface SyncHost {
  readonly platform: NodeJS.Platform;
  /** The account's home folder (A2 3.2.2 rule 1). */
  readonly home: string;
  /** The environment values the check reads: OneDrive's three variables. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** What is at `path`, a link followed; `absent` only when no name is there at all. */
  kind(path: string): Promise<PathKind>;
  /** Whether a name exists at `path`, a link included (not followed); false only when none is. */
  exists(path: string): Promise<boolean>;
  /** The real path of `path`, or undefined when nothing is there. */
  realpath(path: string): Promise<string | undefined>;
  /** The names in a folder. */
  list(dir: string): Promise<readonly string[]>;
  /**
   * A small UTF-8 text file, or undefined when it is not there. Throws when it cannot be read, is
   * not UTF-8 or is larger than `maxBytes`.
   */
  readText(path: string, maxBytes: number): Promise<string | undefined>;
  /** Windows: the identity of the volume that holds `path` (its serial number). */
  volumeOf(path: string): Promise<string>;
  /**
   * Windows: the registry's and the drives' facts, each local drive with its volume's identity read
   * right after them, or undefined when the run gave none (never "no facts there"). Undefined
   * elsewhere. An answer may be kept for a while; `fresh` asks for a new one.
   */
  windowsFacts(fresh?: boolean): Promise<WindowsSyncFacts | undefined>;
  /** Linux: `fs.statfs`'s type of the file system that holds `path`. */
  statfsType(path: string): Promise<number>;
  /** Linux: /proc/self/mountinfo; macOS: the output of /sbin/mount. */
  mountTable(): Promise<string>;
}

// ---------------------------------------------------------------------------------------------
// Paths

function fold(platform: NodeJS.Platform, path: string): string {
  const trimmed = path.length > 3 ? path.replace(/[\\/]+$/, "") : path;
  if (platform === "win32") return trimmed.replaceAll("/", "\\").toLowerCase();
  // macOS volumes ignore case and Unicode normalization (é as one character or as e and an accent).
  return platform === "darwin" ? trimmed.normalize("NFC").toLowerCase() : trimmed;
}

/**
 * Whether `path` is `root` or inside it, by its text (case-insensitive on Windows and macOS, and
 * normalization-insensitive on macOS).
 */
export function isInside(platform: NodeJS.Platform, path: string, root: string): boolean {
  const separator = platform === "win32" ? "\\" : "/";
  const p = fold(platform, path);
  const r = fold(platform, root);
  if (r === "") return false;
  return p === r || p.startsWith(r.endsWith(separator) ? r : r + separator);
}

/** The path and its ancestors, the path first. */
export function ancestors(path: string): string[] {
  const list = [path];
  for (let d = dirname(path); d !== list[list.length - 1]; d = dirname(d)) list.push(d);
  return list;
}

/** How many levels `path` lies below `root` (0 when it is the root). */
function depthBelow(platform: NodeJS.Platform, path: string, root: string): number {
  const separator = /[\\/]+/;
  const p = fold(platform, path)
    .split(separator)
    .filter((s) => s !== "");
  const r = fold(platform, root)
    .split(separator)
    .filter((s) => s !== "");
  return Math.max(0, p.length - r.length);
}

// ---------------------------------------------------------------------------------------------
// Provider roots

interface Root {
  readonly provider: SyncProvider;
  readonly root: string;
  readonly rule: SyncRule;
}

/** OneDrive's environment variables (A1 3.2). A stale one still counts (A6 3.16.6). */
export const ONEDRIVE_VARIABLES = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] as const;

/** The provider a Cloud Files sync root's key names (`OneDrive!S-1-5-…!Personal|…`). */
export function cloudFilesProvider(id: string): SyncProvider {
  const name = (id.split("!")[0] ?? "").toLowerCase();
  if (name.startsWith("onedrive")) return "onedrive";
  if (name.startsWith("icloud")) return "icloud";
  if (name.startsWith("dropbox")) return "dropbox";
  if (name.startsWith("google")) return "google_drive";
  if (name.startsWith("nextcloud") || name.startsWith("owncloud")) return "nextcloud";
  return "cloud_files";
}

/** A path character: none of `"*<>?|`, no control character and no replacement character. */
const PATH_CHAR = String.raw`[^"*<>?|\p{Cc}\uFFFD]`;
/** A whole drive path (a drive's root included) or UNC path, up to Windows's longest path. */
const WHOLE_PATH = new RegExp(
  String.raw`^(?:[A-Za-z]:\\${PATH_CHAR}{0,32767}|\\\\${PATH_CHAR}{1,32767})$`,
  "u",
);
/** Drive and UNC paths inside other text. */
const PATHS_IN_TEXT = new RegExp(
  String.raw`[A-Za-z]:\\${PATH_CHAR}{0,32767}|\\\\${PATH_CHAR}{1,32767}`,
  "gu",
);
/** The fields a SyncTargets value is parsed into at most, scalars and nested ones included. */
const MAX_FIELDS = 100_000;
/** The levels of nested messages the walk reads. */
const MAX_DEPTH = 8;

/** A path without its trailing separators, a drive's root (`Q:\`) kept whole. */
function trimSeparators(path: string): string {
  const trimmed = path.replace(/\\+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

/**
 * A varint at `at`: its value and the next offset, or undefined when it runs past the end or is
 * not a uint64 (more than ten bytes, or a tenth byte above 1). The value is exact up to 2^53, which
 * is all a key or a length can be.
 */
function varint(bytes: Uint8Array, at: number): [number, number] | undefined {
  let value = 0;
  for (let i = 0; i < 10; i += 1) {
    const byte = bytes[at + i];
    if (byte === undefined || (i === 9 && byte > 1)) return undefined;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  return undefined;
}

/**
 * The length-delimited payloads of `message` when it is one protobuf message read whole: every
 * field has a field number, a known wire type and its full length, and the last one ends exactly
 * at the message's end. Undefined otherwise: bytes that are not a message (a string), a message
 * that cannot be read to its end, or a field past the budget, which every field read takes one of.
 */
function messageFields(message: Uint8Array, budget: { left: number }): Uint8Array[] | undefined {
  const payloads: Uint8Array[] = [];
  let at = 0;
  while (at < message.length) {
    if (budget.left <= 0) return undefined;
    budget.left -= 1;
    const key = varint(message, at);
    // Field numbers run from 1 to 2^29 - 1.
    if (key === undefined || key[0] < 8 || key[0] >= 2 ** 32) return undefined;
    at = key[1];
    const wire = key[0] % 8;
    if (wire === 0) {
      const skipped = varint(message, at);
      if (skipped === undefined) return undefined;
      at = skipped[1];
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = varint(message, at);
      if (length === undefined || length[1] + length[0] > message.length) return undefined;
      payloads.push(message.subarray(length[1], length[1] + length[0]));
      at = length[1] + length[0];
    } else return undefined;
  }
  return at === message.length ? payloads : undefined;
}

/**
 * The length-delimited fields of a protobuf message and of the messages inside it, down to
 * MAX_DEPTH levels, within MAX_FIELDS fields read. A payload that is itself a message read whole is
 * walked; any other payload is a leaf. Whether the walk found every root is not its own answer:
 * readDriveFs checks it against the bytes. Iterative, so no value's shape can exhaust the stack.
 */
function protoFields(bytes: Uint8Array): Uint8Array[] {
  const budget = { left: MAX_FIELDS };
  const fields: Uint8Array[] = [];
  const pending = (messageFields(bytes, budget) ?? []).map((b) => ({ bytes: b, depth: 1 }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    fields.push(next.bytes);
    if (next.depth >= MAX_DEPTH) continue;
    for (const b of messageFields(next.bytes, budget) ?? []) {
      pending.push({ bytes: b, depth: next.depth + 1 });
    }
  }
  return fields;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf16 = new TextDecoder("utf-16le", { fatal: true });

/** A field's bytes as a path, in UTF-8 or UTF-16, or undefined. */
function pathOf(field: Uint8Array): string | undefined {
  for (const decoder of [utf8, ...(field.length % 2 === 0 ? [utf16] : [])]) {
    try {
      const text = decoder.decode(field);
      if (WHOLE_PATH.test(text)) return trimSeparators(text);
    } catch {
      // Not text in this encoding.
    }
  }
  return undefined;
}

const isLetter = (b: number | undefined): boolean =>
  b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a));
/** A character that may follow a UNC path's `\\`: none of a control character, a space or `\`. */
const uncNext = (code: number): boolean => code > 0x20 && code !== 0x5c;

/**
 * Every offset in `bytes` where a drive path (`X:\`) or a UNC path (`\\` and a name) starts, in
 * UTF-8 or in UTF-16LE, at any offset: wherever a root may lie, whatever the bytes around it are.
 */
function pathStarts(bytes: Uint8Array): number[] {
  const starts: number[] = [];
  // A byte past the end reads as -1, which matches nothing.
  const at = (i: number): number => bytes[i] ?? -1;
  for (let i = 0; i < bytes.length; i += 1) {
    const utf8Drive = isLetter(at(i)) && at(i + 1) === 0x3a && at(i + 2) === 0x5c;
    const utf8Unc = at(i) === 0x5c && at(i + 1) === 0x5c && uncNext(at(i + 2));
    const utf16Drive =
      isLetter(at(i)) &&
      at(i + 1) === 0 &&
      at(i + 2) === 0x3a &&
      at(i + 3) === 0 &&
      at(i + 4) === 0x5c &&
      at(i + 5) === 0;
    const utf16Unc =
      at(i) === 0x5c &&
      at(i + 1) === 0 &&
      at(i + 2) === 0x5c &&
      at(i + 3) === 0 &&
      at(i + 5) >= 0 &&
      uncNext(at(i + 4) | (at(i + 5) << 8));
    if (utf8Drive || utf8Unc || utf16Drive || utf16Unc) starts.push(i);
  }
  return starts;
}

/**
 * The folders inside Drive for desktop's SyncTargets value (A1 3.2). In the Windows 11 capture
 * it is a protobuf message: each target holds the account, the virtual drive's letter and
 * the mirror root as length-delimited fields, so each field is read on its own, as UTF-8 or
 * UTF-16. Only drive and UNC paths count.
 *
 * `complete`: whether the value was read whole, decided by its bytes, not by the walk's shape:
 * every place in the value where a drive or UNC path starts, in UTF-8 or UTF-16 at any offset,
 * lies in a field the walk read as a whole path. A root inside bytes the walk could not read (a
 * malformed message, one nested too deep, one past the field budget, a value of another shape)
 * makes it false, so a folder judged by the value is unchecked, never local (A1 3.2: a decoder
 * answers only from input it read whole). A value not read whole is also searched as UTF-8 text,
 * so a root found there still counts as a signal.
 */
export function readDriveFs(base64: string): { paths: string[]; complete: boolean } {
  if (base64 === "") return { paths: [], complete: true };
  const bytes = Buffer.from(base64, "base64");
  const found = new Set<string>();
  const read = new Uint8Array(bytes.length);
  for (const field of protoFields(bytes)) {
    const path = pathOf(field);
    if (path === undefined) continue;
    found.add(path);
    const start = field.byteOffset - bytes.byteOffset;
    read.fill(1, start, start + field.length);
  }
  const complete = pathStarts(bytes).every((at) => read[at] === 1);
  if (found.size === 0 || !complete) {
    for (const m of bytes.toString("utf8").matchAll(PATHS_IN_TEXT)) {
      found.add(trimSeparators(m[0]));
    }
  }
  return { paths: [...found], complete };
}

/** The folders readDriveFs finds in a SyncTargets value. */
export function driveFsPaths(base64: string): string[] {
  return readDriveFs(base64).paths;
}

/**
 * The roots `~/.dropbox/info.json` lists (`{"personal": {"path": …}, "business": …}`), or
 * undefined when the text is not that: not JSON, not an object, or an entry without a path. A file
 * that cannot be read whole may hide a root, so it leaves the folder unchecked, never "no roots".
 */
export function dropboxRoots(text: string): string[] | undefined {
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof info !== "object" || info === null || Array.isArray(info)) return undefined;
  const roots: string[] = [];
  for (const entry of Object.values(info as Record<string, unknown>)) {
    const path = (entry as { path?: unknown } | null)?.path;
    if (typeof entry !== "object" || typeof path !== "string" || path === "") return undefined;
    roots.push(path);
  }
  return roots;
}

const INFO_MAX_BYTES = 64 * 1024;

/**
 * The sync clients' roots on this machine. Throws (unseen) when a fact behind them was not read
 * whole: a SyncTargets value the walk cut short, a Dropbox info.json that is not what Dropbox
 * writes.
 */
async function providerRoots(
  host: SyncHost,
  windows: WindowsSyncFacts | undefined,
): Promise<Root[]> {
  const roots: Root[] = [];
  for (const name of ONEDRIVE_VARIABLES) {
    const value = host.env[name];
    if (value !== undefined && value !== "") {
      roots.push({ provider: "onedrive", root: value, rule: "provider_root" });
    }
  }
  if (windows !== undefined) {
    for (const root of windows.oneDriveAccounts) {
      roots.push({ provider: "onedrive", root, rule: "provider_root" });
    }
    for (const { id, path } of windows.syncRoots) {
      roots.push({ provider: cloudFilesProvider(id), root: path, rule: "provider_root" });
    }
    const driveFs = readDriveFs(windows.driveFsTargets);
    // A value read only in part may hide a root the folder is under, and a value that holds no
    // path the check can read is of a shape it does not know.
    if (!driveFs.complete) unseen();
    if (windows.driveFsTargets !== "" && driveFs.paths.length === 0) unseen();
    for (const root of driveFs.paths) {
      roots.push({ provider: "google_drive", root, rule: "provider_root" });
    }
    for (const drive of windows.drives) {
      if (drive.label === "Google Drive") {
        roots.push({ provider: "google_drive", root: drive.root, rule: "volume_label" });
      }
    }
  }
  const info = await host.readText(join(host.home, ".dropbox", "info.json"), INFO_MAX_BYTES);
  if (info !== undefined) {
    for (const root of dropboxRoots(info) ?? unseen()) {
      roots.push({ provider: "dropbox", root, rule: "provider_root" });
    }
  }
  return roots;
}

/** macOS's cloud folders under the home folder (A1 3.2): iCloud Drive, and File Provider roots. */
function macCloudFolder(host: SyncHost, path: string): SyncSignal | undefined {
  if (host.platform !== "darwin") return undefined;
  const mobile = join(host.home, "Library", "Mobile Documents");
  if (isInside("darwin", path, mobile)) {
    return {
      kind: "synced",
      provider: "icloud",
      rule: "cloud_folder",
      depth: depthBelow("darwin", path, mobile),
    };
  }
  const storage = join(host.home, "Library", "CloudStorage");
  if (!isInside("darwin", path, storage)) return undefined;
  const below =
    fold("darwin", path)
      .slice(fold("darwin", storage).length + 1)
      .split("/")[0] ?? "";
  const provider: SyncProvider = below.startsWith("dropbox")
    ? "dropbox"
    : below.startsWith("googledrive")
      ? "google_drive"
      : below.startsWith("onedrive")
        ? "onedrive"
        : below.startsWith("icloud")
          ? "icloud"
          : "cloud_files";
  return {
    kind: "synced",
    provider,
    rule: "cloud_folder",
    depth: depthBelow("darwin", path, storage),
  };
}

// ---------------------------------------------------------------------------------------------
// Markers and conflict copies

/**
 * Fixed marker names, one stat each in the folder and every ancestor. `file`: only a file counts.
 * Dropbox's marker is the `.dropbox` file in its root; `~/.dropbox` is its settings folder, which
 * would otherwise mark every folder under the home folder.
 */
export const MARKERS: readonly {
  readonly name: string;
  readonly provider: SyncProvider;
  readonly file?: true;
}[] = [
  { name: ".stfolder", provider: "syncthing" },
  { name: ".dropbox", provider: "dropbox", file: true },
  { name: ".owncloudsync.log", provider: "nextcloud" },
  { name: ".git", provider: "git" },
];

/** Nextcloud's and ownCloud's journal, `.sync_<hash>.db` (older clients: `._sync_<hash>.db`). */
const NEXTCLOUD_JOURNAL = /^\._?sync_[^/\\]*\.db$/;

/** Conflict copies of space.db: Syncthing's, and Dropbox's and Nextcloud's "conflicted copy". */
const CONFLICT_COPIES = [/^space\.sync-conflict-.*\.db$/i, /^space \(.*conflicted copy.*\)\.db$/i];

export const isConflictCopy = (name: string): boolean => CONFLICT_COPIES.some((p) => p.test(name));

// ---------------------------------------------------------------------------------------------
// Volumes: what holds the folder

/**
 * What the check knows of the volume that holds a path: a local one (positive evidence of its
 * kind), a network one, or one it does not know, which leaves the folder unchecked.
 */
export type Volume =
  | { readonly kind: "local" }
  | { readonly kind: "network"; readonly fs: string }
  | { readonly kind: "unknown" };

const LOCAL: Volume = { kind: "local" };
const UNKNOWN: Volume = { kind: "unknown" };
const network = (fs: string): Volume => ({ kind: "network", fs });

/**
 * Linux `statfs` types of network file systems (include/uapi/linux/magic.h and the file systems'
 * own sources), by the word the check reports.
 */
export const NETWORK_MAGIC: ReadonlyMap<number, string> = new Map([
  [0x6969, "nfs"],
  [0x517b, "smb"],
  [0xff534d42, "cifs"],
  [0xfe534d42, "smb2"],
  [0x01021997, "9p"],
  [0x5346414f, "afs"],
  [0x6b414653, "afs"],
  [0x00c36400, "ceph"],
  [0x73757245, "coda"],
  [0x564c, "ncp"],
]);

/**
 * Linux `statfs` types of file systems that keep their files on this machine (magic.h and the file
 * systems' own sources). Any other type, a stacked one such as eCryptfs included, is not known to
 * be local. overlayfs counts: every write goes to its upper layer, and it refuses a network or FUSE
 * file system there (one whose names need revalidation).
 */
export const LOCAL_MAGIC: ReadonlyMap<number, string> = new Map([
  [0xef53, "ext4"], // ext2, ext3 and ext4
  [0x58465342, "xfs"],
  [0x9123683e, "btrfs"],
  [0x2fc12fc1, "zfs"],
  [0xf2f52010, "f2fs"],
  [0xca451a4e, "bcachefs"],
  [0x3153464a, "jfs"],
  [0x52654973, "reiserfs"],
  [0x3434, "nilfs2"],
  [0x4d44, "vfat"], // msdos and vfat
  [0x2011bab0, "exfat"],
  [0x5346544e, "ntfs"],
  [0x7366746e, "ntfs3"],
  [0x482b, "hfsplus"],
  [0x01021994, "tmpfs"], // tmpfs, and rootfs and devtmpfs on it
  [0x858458f6, "ramfs"],
  [0x794c7630, "overlay"],
  [0x73717368, "squashfs"],
  [0xe0f5e1e2, "erofs"],
  [0x9660, "iso9660"],
  [0x15013346, "udf"],
]);

/** FUSE's `statfs` type: the mount table's entry says what it is. */
export const FUSE_MAGIC = 0x65735546;

/** FUSE file systems that reach another host (the subtype after `fuse.` in the mount table). */
export const NETWORK_FUSE: ReadonlySet<string> = new Set([
  "sshfs",
  "rclone",
  "gvfsd-fuse",
  "s3fs",
  "gcsfuse",
  "onedriver",
  "google-drive-ocamlfuse",
  "glusterfs",
  "ceph-fuse",
  "davfs2",
  "curlftpfs",
  "smbnetfs",
  "juicefs",
]);

export interface MountEntry {
  readonly mountPoint: string;
  readonly type: string;
  /** What is mounted (macOS): a device, `//user@server/share`, `user@host:/path` … */
  readonly source?: string;
  /** Linux: the folder of its file system the mount shows (`/` for the whole file system). */
  readonly root?: string;
  /** Linux: the file system's device (`major:minor`), the same for every mount of it. */
  readonly device?: string;
}

const unescapeMount = (s: string): string =>
  s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));

/**
 * /proc/self/mountinfo: each line's device, root, mount point and type (`fuse.sshfs` for a FUSE
 * subtype), or undefined when a line is not of the shape the kernel writes (`<id> <parent>
 * <major:minor> <root> <mount point> <options> [optional fields] - <type> <source> <super
 * options>`): a table not read whole may lack the mount that holds a path, which would then be
 * judged by the mount above it.
 */
export function parseMountinfo(text: string): MountEntry[] | undefined {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const [left, right, ...more] = line.split(" - ");
    const head = left?.split(" ") ?? [];
    const tail = right?.split(" ") ?? [];
    const [, , device = "", root, mountPoint] = head;
    const [type = ""] = tail;
    if (
      more.length > 0 ||
      head.length < 6 ||
      tail.length !== 3 ||
      !/^\d+:\d+$/.test(device) ||
      root === undefined ||
      mountPoint === undefined ||
      type === ""
    ) {
      return undefined;
    }
    entries.push({
      mountPoint: unescapeMount(mountPoint),
      type,
      root: unescapeMount(root),
      device,
    });
  }
  return entries;
}

/**
 * macOS `mount` output: `<source> on <mount point> (<type>, <options>)`, or undefined when a line
 * is not of that shape, its closing parenthesis included (parseMountinfo says why).
 */
export function parseMacMounts(text: string): MountEntry[] | undefined {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^(.*) on (\/.*) \(([^,()]+)(?:, [^()]*)?\)$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined;
    entries.push({ source: m[1], mountPoint: m[2], type: m[3].trim() });
  }
  return entries;
}

/**
 * The mount that holds `path`: the longest mount point that is the path or an ancestor. On Linux
 * the last of equal mount points is the one on top. macOS folds case and Unicode normalization, as
 * its volumes do by default, so a path spelled otherwise than the mount table is still under its
 * mount; of mount points that differ only in that spelling (possible on a case-sensitive volume),
 * the one spelled as the path is wins, then a network one, so a local mount never stands in for a
 * network one it may hide.
 */
export function mountOf(
  entries: readonly MountEntry[],
  path: string,
  platform: "linux" | "darwin" = "linux",
): MountEntry | undefined {
  let longest = -1;
  let tied: MountEntry[] = [];
  for (const e of entries) {
    if (!isInside(platform, path, e.mountPoint)) continue;
    const length = fold(platform, e.mountPoint).length;
    if (length > longest) {
      longest = length;
      tied = [e];
    } else if (length === longest) tied.push(e);
  }
  if (platform === "linux") return tied.at(-1);
  return (
    tied.findLast((e) => isInside("linux", path, e.mountPoint)) ??
    tied.findLast((e) => macNetwork(e) !== undefined) ??
    tied.at(-1)
  );
}

/**
 * Whether the Linux real path `path` lies on a mount that shows a folder of a file system which
 * another mount shows higher up under another name: a bind mount of `~/Dropbox/sub` at `/srv/x`.
 * The markers and sync roots above that folder apply to it, and this path does not pass them, so
 * the folder is unchecked. A mount that shows its file system's root has every folder above the
 * path on the path. A bind of a folder onto itself (as systemd makes for ReadWritePaths) has no
 * other name. A path the table holds no mount for cannot be told.
 */
export function boundElsewhere(entries: readonly MountEntry[], path: string): boolean {
  const own = mountOf(entries, path);
  if (own?.root === undefined || own.device === undefined) return true;
  if (own.root === "/") return false;
  const shown = own.root;
  return entries.some(
    (e) =>
      e !== own &&
      e.device === own.device &&
      e.root !== undefined &&
      isInside("linux", shown, e.root) &&
      posix.join(e.mountPoint, posix.relative(e.root, shown)) !== own.mountPoint,
  );
}

/**
 * The volume a Linux real path is on, from its statfs type: a network type is network, a known
 * local type is local. FUSE says nothing about what serves it, so the mount table's entry for the
 * path decides: a network subtype is network, `fuseblk` (a local block device: ntfs-3g, exfat-fuse)
 * is local, and anything else, a FUSE mount the table does not list included, is unknown. So is
 * every other type.
 */
export function linuxVolume(type: number, mounts: string | undefined, path: string): Volume {
  // The magic numbers are 32-bit: a build whose f_type is a signed 32-bit word gives CIFS's
  // 0xFF534D42 as a negative number, the same type.
  const statfsType = Number.isInteger(type) && type < 0 && type >= -(2 ** 31) ? type >>> 0 : type;
  const named = NETWORK_MAGIC.get(statfsType);
  if (named !== undefined) return network(named);
  if (statfsType === FUSE_MAGIC) {
    const entries = mounts === undefined ? undefined : parseMountinfo(mounts);
    const type = entries === undefined ? undefined : mountOf(entries, path)?.type;
    if (type === "fuseblk") return LOCAL;
    const subtype = type?.startsWith("fuse.") === true ? type.slice(5) : undefined;
    return subtype !== undefined && NETWORK_FUSE.has(subtype)
      ? network(`fuse.${subtype}`)
      : UNKNOWN;
  }
  return LOCAL_MAGIC.has(statfsType) ? LOCAL : UNKNOWN;
}

/** macOS mount types that reach another host. */
const MAC_NETWORK: ReadonlySet<string> = new Set([
  "smbfs",
  "nfs",
  "afpfs",
  "webdav",
  "ftp",
  "cifs",
]);

/** macOS mount types of file systems that keep their files on this machine. */
const MAC_LOCAL: ReadonlySet<string> = new Set([
  "apfs",
  "hfs",
  "msdos",
  "exfat",
  "ntfs",
  "cd9660",
  "udf",
]);

/**
 * The network file system a macOS mount is, by its type, or undefined. A macFUSE mount reaches
 * another host when its source names one (sshfs: `user@host:/path`).
 */
function macNetwork(entry: MountEntry): string | undefined {
  if (MAC_NETWORK.has(entry.type)) return entry.type;
  const fuse = entry.type.startsWith("macfuse") || entry.type.startsWith("osxfuse");
  return fuse && /^(?:\/\/|[^/\s]+:)/.test(entry.source ?? "") ? entry.type : undefined;
}

/** The volume a macOS real path is on, from the mount table's entry that holds it. */
export function macVolume(mounts: string, path: string): Volume {
  const entries = parseMacMounts(mounts);
  const entry = entries === undefined ? undefined : mountOf(entries, path, "darwin");
  if (entry === undefined) return UNKNOWN;
  const fs = macNetwork(entry);
  if (fs !== undefined) return network(fs);
  return MAC_LOCAL.has(entry.type) ? LOCAL : UNKNOWN;
}

/** Whether a Windows real path is a UNC path, which reaches another host. */
export const isUncPath = (path: string): boolean => /^[\\/]{2}[^\\/?.]/.test(path);

/** Windows drive types whose volume is on this machine (.NET's `DriveType`). */
export const LOCAL_DRIVE_TYPES: ReadonlySet<string> = new Set([
  "Fixed",
  "Removable",
  "CDRom",
  "Ram",
]);

/** File systems Windows keeps a local volume in (.NET's `DriveFormat`). */
export const LOCAL_DRIVE_FORMATS: ReadonlySet<string> = new Set([
  "NTFS",
  "ReFS",
  "exFAT",
  "FAT32",
  "FAT",
  "UDF",
  "CDFS",
]);

/** The drive letter of a Windows drive path (`C:\…`), upper case, or undefined. */
const letterOf = (path: string): string | undefined =>
  /^([A-Za-z]):\\/.exec(path)?.[1]?.toUpperCase();

/** The facts' drive whose root is `X:\`. */
const driveOf = (windows: WindowsSyncFacts, letter: string) =>
  windows.drives.find((d) => /^[A-Za-z]:\\$/.test(d.root) && d.root[0]?.toUpperCase() === letter);

/**
 * Whether a Windows real path is on a drive letter the facts do not list. The facts list every
 * network drive and every other drive that was ready and of a local type when they were read, so
 * such a drive came later, was not ready or could not be classified: its type and label were not
 * seen (A1 3.2).
 */
export function unlistedDrive(path: string, windows: WindowsSyncFacts): boolean {
  const letter = letterOf(path);
  return letter !== undefined && driveOf(windows, letter) === undefined;
}

/**
 * Whether a volume identity names a volume: libuv answers 0 for a file system that does not report
 * its serial number, and 0 is then no identity.
 */
const isVolumeId = (id: string | undefined): id is string =>
  id !== undefined && id !== "" && id !== "0";

/**
 * Whether the facts do not describe the volume that holds the Windows real path `real` now: its
 * drive is not listed, or is listed for another volume than the one that holds the folder (a
 * volume that took the letter since the facts were read, or another volume mounted in a folder of
 * the drive), or without one. A network drive's volume is never read, and its type decides.
 */
async function describesOther(
  host: SyncHost,
  real: string,
  windows: WindowsSyncFacts,
): Promise<boolean> {
  const letter = letterOf(real);
  if (letter === undefined) return false;
  const drive = driveOf(windows, letter);
  if (drive === undefined) return true;
  if (drive.type === "Network") return false;
  return !isVolumeId(drive.volume) || drive.volume !== (await host.volumeOf(real));
}

/**
 * The volume a Windows path is on, by the facts: a UNC path or a drive of type Network is network;
 * a listed drive of a local type and a local format is local. Anything else is unknown: a drive
 * the facts do not list, a type the system could not determine, a file system the check does not
 * know, a path that is neither a drive path nor a UNC path (a device or volume path).
 */
export function windowsVolume(path: string, windows: WindowsSyncFacts): Volume {
  if (isUncPath(path)) return network("unc");
  const letter = letterOf(path);
  const drive = letter === undefined ? undefined : driveOf(windows, letter);
  if (drive === undefined) return UNKNOWN;
  if (drive.type === "Network") return network("remote_drive");
  return LOCAL_DRIVE_TYPES.has(drive.type) && LOCAL_DRIVE_FORMATS.has(drive.format)
    ? LOCAL
    : UNKNOWN;
}

// ---------------------------------------------------------------------------------------------
// The check

/** The whole check's bound: a look that hangs (a network folder that does not answer) ends here. */
export const CHECK_TIMEOUT_MS = 60_000;

/** Thrown by a step that cannot see what it needs. */
class Unseen extends Error {}

/** Ends a step without its evidence: the folder is unchecked. */
function unseen(): never {
  throw new Unseen("unseen");
}

/**
 * What the steps found. Every step starts not done, and `run` marks one done only when its body
 * returned: a look that threw, a step that called `unseen()`, a step that never ran and a step a
 * time-out cut short all leave it not done. A step that runs more than once (one per folder) is
 * done only when every run returned.
 */
class Evidence {
  readonly signals: SyncSignal[] = [];
  conflicts: readonly string[] = [];
  /** The depth of the folder the check is judged from, once the `folder` step found it. */
  judgedFrom: number | undefined;
  readonly #done = new Map<CheckStep, boolean>();

  /** Runs one step: its value when it completed, undefined when it did not. */
  async run<T>(step: CheckStep, body: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await body();
      if (!this.#done.has(step)) this.#done.set(step, true);
      return value;
    } catch {
      this.#done.set(step, false);
      return undefined;
    }
  }

  /** The steps that are not done. */
  missing(): CheckStep[] {
    return CHECK_STEPS.filter((step) => this.#done.get(step) !== true);
  }

  /** The answer: local only with no signal at all, so only when every step is done. */
  result(): FolderCheck {
    const depth = this.judgedFrom ?? 0;
    const found = [...this.signals].sort((a, b) => a.depth - b.depth);
    const unchecked = this.missing().map((step): SyncSignal => ({
      kind: "synced",
      rule: "unchecked",
      step,
      depth,
    }));
    const signals = [...found, ...unchecked];
    const net = signals.find((s) => s.kind === "network");
    const synced = signals.filter((s) => s.kind === "synced");
    const provider = synced.find((s) => s.provider !== undefined)?.provider;
    return {
      verdict: net !== undefined ? "network" : synced.length > 0 ? "synced" : "local",
      ...(provider === undefined ? {} : { provider }),
      ...(net?.fs === undefined ? {} : { fs: net.fs }),
      conflicts: [...this.conflicts],
      signals,
      exists: this.judgedFrom === 0,
    };
  }
}

/** The check's answer when it could not look at all: unchecked, so served as a synced folder. */
export const UNCHECKED: FolderCheck = {
  verdict: "synced",
  conflicts: [],
  signals: [{ kind: "synced", rule: "unchecked", step: "check", depth: 0 }],
  exists: true,
};

/** `work`, or a rejection once `ms` passed. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Unseen("time"));
    }, ms);
    timer.unref();
  });
  return Promise.race([work, bound]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Checks the folder `target` and every folder above it (see the top of this file), within
 * `timeoutMs`. Never throws: a fault anywhere in it, or a look that hangs past the bound, gives an
 * unchecked folder, never a local one.
 */
export async function checkFolder(
  target: string,
  host: SyncHost,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<FolderCheck> {
  try {
    const evidence = new Evidence();
    await evidence.run("check", () => within(check(target, host, evidence), timeoutMs));
    return evidence.result();
  } catch {
    return UNCHECKED;
  }
}

/**
 * The Windows facts for a check whose folder's real path is `real`. A kept answer may be a minute
 * old: it may not list a drive that came since, or describe a volume that has since given its
 * letter to another. So a folder on a drive it does not list, or on another volume than the one it
 * read for that drive, gets one fresh run. Elsewhere only a fixture gives facts.
 */
async function windowsFactsFor(
  host: SyncHost,
  real: string | undefined,
): Promise<WindowsSyncFacts | undefined> {
  const facts = await host.windowsFacts();
  if (host.platform !== "win32") return facts;
  if (facts === undefined) return unseen();
  if (real !== undefined && (await describesOther(host, real, facts))) {
    return (await host.windowsFacts(true)) ?? unseen();
  }
  return facts;
}

/**
 * Where `chain[0]` leads when `chain[found]` (one of its ancestors) has the real path `real`: that
 * real path with the names below it, which are not there yet.
 */
function below(real: string, chain: readonly string[], found: number): string {
  const names = chain
    .slice(0, found)
    .reverse()
    .map((p) => basename(p));
  return names.length === 0 ? real : join(real, ...names);
}

/**
 * Where `path` leads: its real path, or when it is not there, its nearest existing ancestor's real
 * path with the names below it. Undefined when nothing above it is there either. A real path that
 * fails throws.
 */
async function whereItLeads(host: SyncHost, path: string): Promise<string | undefined> {
  const chain = ancestors(path);
  for (let i = 0; i < chain.length; i += 1) {
    const real = await host.realpath(chain[i] ?? "");
    if (real !== undefined) return below(real, chain, i);
  }
  return undefined;
}

async function check(target: string, host: SyncHost, evidence: Evidence): Promise<void> {
  const path = resolve(target);
  const chain = ancestors(path);
  const signal = (s: SyncSignal): void => {
    evidence.signals.push(s);
  };

  // 1. The folder, or the nearest folder above it that exists (a new space's folder is judged from
  //    it). A name that is there but is no folder (a file, a link to nothing) leads somewhere the
  //    check cannot see.
  const found = await evidence.run("folder", async () => {
    for (let i = 0; i < chain.length; i += 1) {
      const kind = await host.kind(chain[i] ?? "");
      if (kind === "directory") return i;
      if (kind !== "absent") unseen();
    }
    return unseen();
  });
  evidence.judgedFrom = found;
  const existing = found === undefined ? undefined : chain[found];
  const depth = found ?? 0;

  // 2. Its real path. Never replaced by the path as given: a link whose target cannot be resolved
  //    may lead anywhere, a network share included.
  const real =
    existing === undefined
      ? undefined
      : await evidence.run("real_path", async () => (await host.realpath(existing)) ?? unseen());

  // 3. Windows: the registry's and the drives' facts, all or none.
  const windows = await evidence.run("windows_facts", () => windowsFactsFor(host, real));

  // 4. The sync clients' roots: the path as given and where it leads, under each root as given and
  //    where it leads. A path or a root that is not there (a new space's folder, a stale
  //    %OneDrive%) leads where its nearest existing folder's real path and the names below it do.
  const realTarget =
    real === undefined || found === undefined ? undefined : below(real, chain, found);
  const paths = realTarget === undefined ? [path] : [path, realTarget];
  await evidence.run("sync_clients", async () => {
    if (host.platform === "win32" && windows === undefined) unseen();
    for (const r of await providerRoots(host, windows)) {
      const realRoot = await whereItLeads(host, r.root);
      for (const root of realRoot === undefined ? [r.root] : [r.root, realRoot]) {
        if (!paths.some((p) => isInside(host.platform, p, root))) continue;
        signal({
          kind: "synced",
          provider: r.provider,
          rule: r.rule,
          depth: depthBelow(host.platform, path, root),
        });
        break;
      }
    }
    const cloud = paths.map((p) => macCloudFolder(host, p)).find((s) => s !== undefined);
    if (cloud !== undefined) signal(cloud);
  });

  // 5. Markers in every existing folder, as given and as its real path: one look per marker, and a
  //    listing for Nextcloud's journal.
  if (found !== undefined) {
    const looks = new Map<string, number>();
    chain.slice(found).forEach((dir, i) => looks.set(dir, found + i));
    if (real !== undefined) {
      ancestors(real).forEach((dir, i) => {
        if (!looks.has(dir)) looks.set(dir, found + i);
      });
    }
    for (const [dir, at] of looks) {
      await evidence.run("markers", async () => {
        for (const marker of MARKERS) {
          const name = join(dir, marker.name);
          if (!(await host.exists(name))) continue;
          if (marker.file === true && (await host.kind(name)) === "directory") continue;
          signal({ kind: "synced", provider: marker.provider, rule: "marker", depth: at });
        }
        if ((await host.list(dir)).some((n) => NEXTCLOUD_JOURNAL.test(n))) {
          signal({ kind: "synced", provider: "nextcloud", rule: "marker", depth: at });
        }
      });
    }

    // 6. Conflict copies beside space.db (a folder not made yet holds none).
    const conflicts = await evidence.run("conflicts", async () =>
      found === 0 ? (await host.list(path)).filter(isConflictCopy).sort() : [],
    );
    if (conflicts !== undefined && conflicts.length > 0) {
      evidence.conflicts = conflicts;
      signal({ kind: "synced", rule: "conflict_copy", depth: 0 });
    }
  }

  // 7. The volume that holds the folder's real path.
  const net = (fs: string): void => {
    signal({ kind: "network", fs, rule: "network_volume", depth });
  };
  await evidence.run("volume", async () => {
    let volume: Volume;
    if (host.platform === "win32") {
      // The path as given reaches another host when it is a UNC path or on a network drive,
      // whatever its real path is.
      if (isUncPath(path)) net("unc");
      else if (windows !== undefined) {
        const given = windowsVolume(path, windows);
        if (given.kind === "network") net(given.fs);
      }
      if (real === undefined || windows === undefined) return unseen();
      volume = windowsVolume(real, windows);
      if (volume.kind === "local") {
        // The drive's facts are those of the volume they read at its root. Another volume mounted
        // in a folder of the drive, or one that took the drive's letter since, has its own type,
        // format and label, which the facts do not hold.
        const read = driveOf(windows, letterOf(real) ?? "")?.volume;
        const holder = await host.volumeOf(real);
        if (!isVolumeId(read) || holder !== read) unseen();
      }
    } else if (host.platform === "linux") {
      if (real === undefined) return unseen();
      const type = await host.statfsType(real);
      const named = linuxVolume(type, undefined, real);
      if (named.kind === "network") volume = named;
      else {
        // FUSE is decided by the table, and a local folder must not be on a bind mount whose
        // other name passes markers and roots this path does not.
        const table = await host.mountTable();
        const entries = parseMountinfo(table);
        volume = linuxVolume(type, table, real);
        if (volume.kind === "local" && (entries === undefined || boundElsewhere(entries, real))) {
          volume = UNKNOWN;
        }
      }
    } else if (host.platform === "darwin") {
      if (real === undefined) return unseen();
      volume = macVolume(await host.mountTable(), real);
    } else {
      // No volume step on this platform: nothing says its folders are local.
      return unseen();
    }
    if (volume.kind === "network") net(volume.fs);
    else if (volume.kind !== "local") unseen();
  });
}

// ---------------------------------------------------------------------------------------------
// What a person reads (A1 3.2)

const WHERE: Readonly<Record<SyncProvider, string>> = {
  syncthing: "a Syncthing folder",
  dropbox: "a Dropbox folder",
  onedrive: "a OneDrive folder",
  google_drive: "a Google Drive folder",
  icloud: "an iCloud Drive folder",
  nextcloud: "a Nextcloud or ownCloud folder",
  cloud_files: "a cloud sync folder",
  git: "a Git working tree",
};

/** Whether the check found nothing but could not read every fact: unchecked, and nothing else. */
export const isUnchecked = (check: FolderCheck): boolean =>
  check.verdict === "synced" &&
  check.provider === undefined &&
  check.conflicts.length === 0 &&
  check.signals.some((s) => s.rule === "unchecked");

const CORRUPTED = "A live database there can be corrupted.";
const ACTIONS = "Move it, or confirm that this folder is excluded from sync.";
/** Why a space in an unchecked folder is read-only (A1 3.2's words, for a folder it cannot see). */
const UNCHECKED_WORDS =
  "This space's folder could not be checked for sync clients and network drives. A live database in a synced folder or on a network drive can be corrupted. Move it, or confirm that this folder is local and excluded from sync.";

/**
 * Why a space in this folder is read-only, in A1 3.2's words: "This space is inside a Syncthing
 * folder. A live database there can be corrupted. Move it, or confirm that this folder is excluded
 * from sync." Conflict copies are named. Undefined for a local folder.
 */
export function folderMessage(check: FolderCheck): string | undefined {
  if (check.verdict === "network") {
    return `This space is on a network file system. ${CORRUPTED} It is never written there. Move it to a local folder.`;
  }
  if (check.verdict !== "synced") return undefined;
  if (isUnchecked(check)) return UNCHECKED_WORDS;
  const copies =
    check.conflicts.length === 0
      ? ""
      : ` Its folder holds a sync conflict copy of the database: ${check.conflicts.join(", ")}.`;
  if (check.provider === undefined) {
    return `This space's folder is synced: it holds a sync conflict copy of the database (${check.conflicts.join(", ")}). ${CORRUPTED} ${ACTIONS}`;
  }
  return `This space is inside ${WHERE[check.provider]}. ${CORRUPTED} ${ACTIONS}${copies}`;
}
