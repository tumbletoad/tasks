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
// The checks, one per row of A1 3.2's table (A1 3.2 names where Windows keeps them):
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
// A look at one file that finds nothing is "not there" (a marker, a listing). A fact about the
// whole machine that cannot be read at all (Windows's registry and drives, Linux's statfs and mount
// table, macOS's mount table), or a fault in the check itself, leaves the folder `unchecked`: it
// is served as a synced folder is, read-only until the person confirms it is local and excluded
// from sync. So is a folder on a Windows drive letter the facts do not list, after one fresh run.
// A check that cannot see never makes a space writable.
import { dirname, join, resolve } from "node:path";

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
  /** A fact the check needs could not be read: served as a synced folder. */
  "unchecked",
] as const;
export type SyncRule = (typeof SYNC_RULES)[number];

export interface SyncSignal {
  readonly kind: "synced" | "network";
  readonly rule: SyncRule;
  /** The sync client, for a synced signal (a conflict copy names none). */
  readonly provider?: SyncProvider;
  /** The network file system, for a network signal, as a word: `nfs`, `cifs`, `unc` … */
  readonly fs?: string;
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
  }[];
}

/** Where the check reads its facts. The real one is sync-host.ts; tests pass fixtures. */
export interface SyncHost {
  readonly platform: NodeJS.Platform;
  /** The account's home folder (A2 3.2.2 rule 1). */
  readonly home: string;
  /** The environment values the check reads: OneDrive's three variables. */
  readonly env: Readonly<Record<string, string | undefined>>;
  isDirectory(path: string): Promise<boolean>;
  /** Whether a name exists at `path`, a link included (not followed). */
  exists(path: string): Promise<boolean>;
  /** The real path of an existing path, or undefined. */
  realpath(path: string): Promise<string | undefined>;
  /** The names in a folder, or undefined when it cannot be listed. */
  list(dir: string): Promise<readonly string[] | undefined>;
  /** A small text file, or undefined when it is missing, unreadable or larger than `maxBytes`. */
  readText(path: string, maxBytes: number): Promise<string | undefined>;
  /**
   * Windows: the registry's and the drives' facts. Undefined elsewhere or when unreadable. An
   * answer may be kept for a while; `fresh` asks for a new one.
   */
  windowsFacts(fresh?: boolean): Promise<WindowsSyncFacts | undefined>;
  /** Linux: `fs.statfs`'s type of the file system that holds `path`. */
  statfsType(path: string): Promise<number | undefined>;
  /** Linux: /proc/self/mountinfo; macOS: the output of /sbin/mount. Undefined elsewhere. */
  mountTable(): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------------------------
// Paths

function fold(platform: NodeJS.Platform, path: string): string {
  const trimmed = path.length > 3 ? path.replace(/[\\/]+$/, "") : path;
  if (platform === "win32") return trimmed.replaceAll("/", "\\").toLowerCase();
  return platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}

/** Whether `path` is `root` or inside it, by its text (case-insensitive on Windows and macOS). */
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

/** A whole drive or UNC path, as a path field holds it, up to Windows's longest path. */
const WHOLE_PATH = /^(?:[A-Za-z]:\\|\\\\)[^"*<>?|\p{Cc}\uFFFD]{1,32767}$/u;
/** Drive and UNC paths inside other text. */
const PATHS_IN_TEXT = /(?:[A-Za-z]:\\|\\\\)[^"*<>?|\p{Cc}\uFFFD]{1,32767}/gu;
/** The fields read from a SyncTargets value at most, nested ones included. */
const MAX_FIELDS = 100_000;

/** A varint at `at`: its value and the next offset, or undefined when it runs past the end. */
function varint(bytes: Uint8Array, at: number): [number, number] | undefined {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = bytes[at + i];
    if (byte === undefined) return undefined;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  return undefined;
}

/**
 * Every length-delimited field of a protobuf-shaped message and of the messages inside it, down to
 * 8 levels, at most MAX_FIELDS of them (`complete` false when that cut the walk short). Iterative,
 * so no value's shape can exhaust the stack. A malformed message ends its own walk with what was
 * read.
 */
function protoFields(bytes: Uint8Array): { fields: Uint8Array[]; complete: boolean } {
  const fields: Uint8Array[] = [];
  const messages: { bytes: Uint8Array; depth: number }[] = [{ bytes, depth: 0 }];
  let complete = true;
  for (let next = messages.pop(); next !== undefined; next = messages.pop()) {
    const { bytes: message, depth } = next;
    let at = 0;
    while (at < message.length) {
      const key = varint(message, at);
      if (key === undefined) break;
      at = key[1];
      const wire = key[0] & 7;
      if (wire === 0) {
        const skipped = varint(message, at);
        if (skipped === undefined) break;
        at = skipped[1];
      } else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else if (wire === 2) {
        const length = varint(message, at);
        if (length === undefined || length[1] + length[0] > message.length) break;
        const payload = message.subarray(length[1], length[1] + length[0]);
        if (fields.length >= MAX_FIELDS) return { fields, complete: false };
        fields.push(payload);
        // Deeper than 8 levels the payload is read as a field only, not walked: not complete.
        if (depth < 8) messages.push({ bytes: payload, depth: depth + 1 });
        else complete = false;
        at = length[1] + length[0];
      } else break;
    }
  }
  return { fields, complete };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf16 = new TextDecoder("utf-16le", { fatal: true });

/** A field's bytes as a path, in UTF-8 or UTF-16, or undefined. */
function pathOf(field: Uint8Array): string | undefined {
  for (const decoder of [utf8, ...(field.length % 2 === 0 ? [utf16] : [])]) {
    try {
      const text = decoder.decode(field);
      if (WHOLE_PATH.test(text)) return text.replace(/\\+$/, "");
    } catch {
      // Not text in this encoding.
    }
  }
  return undefined;
}

/**
 * The folders inside Drive for desktop's SyncTargets value (A1 3.2). On the Windows reference machine it is a
 * protobuf message: each target holds the account, the virtual drive's letter and the mirror root
 * as length-delimited fields, so each field is read on its own, as UTF-8 or UTF-16, wherever it
 * starts. A value of another shape, or one the walk cut short, is searched as UTF-8 text too. Only
 * drive and UNC paths count. `complete` is false when the walk ran out of depth or of its field
 * budget: a UTF-16 root below that is not found by the text search, so the value was not read
 * whole, and a folder judged by it is unchecked, never local (A1 3.2's rule for a fact the check
 * cannot read).
 */
export function readDriveFs(base64: string): { paths: string[]; complete: boolean } {
  if (base64 === "") return { paths: [], complete: true };
  const bytes = Buffer.from(base64, "base64");
  const found = new Set<string>();
  const { fields, complete } = protoFields(bytes);
  for (const field of fields) {
    const path = pathOf(field);
    if (path !== undefined) found.add(path);
  }
  if (found.size === 0 || !complete) {
    for (const m of bytes.toString("utf8").matchAll(PATHS_IN_TEXT)) {
      found.add(m[0].replace(/\\+$/, ""));
    }
  }
  return { paths: [...found], complete };
}

/** The folders readDriveFs finds in a SyncTargets value. */
export function driveFsPaths(base64: string): string[] {
  return readDriveFs(base64).paths;
}

/** The roots `~/.dropbox/info.json` lists (`{"personal": {"path": …}, "business": …}`). */
export function dropboxRoots(text: string | undefined): string[] {
  if (text === undefined) return [];
  try {
    const info = JSON.parse(text) as unknown;
    if (typeof info !== "object" || info === null) return [];
    return Object.values(info as Record<string, unknown>).flatMap((v) => {
      const path = (v as { path?: unknown } | null)?.path;
      return typeof path === "string" && path !== "" ? [path] : [];
    });
  } catch {
    return [];
  }
}

const INFO_MAX_BYTES = 64 * 1024;

/**
 * The sync clients' roots on this machine. `complete` is false when a fact behind them was not read
 * whole (a SyncTargets value the walk cut short): the folder is then unchecked.
 */
async function providerRoots(
  host: SyncHost,
  windows: WindowsSyncFacts | undefined,
): Promise<{ roots: Root[]; complete: boolean }> {
  const roots: Root[] = [];
  let complete = true;
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
    if (!driveFs.complete) complete = false;
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
  for (const root of dropboxRoots(info))
    roots.push({ provider: "dropbox", root, rule: "provider_root" });
  return { roots, complete };
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
// Network file systems

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

/** FUSE's `statfs` type: the mount table's subtype says what it is. */
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

/** Linux mount table types of network file systems, for when `statfs` gives no answer. */
const NETWORK_TYPES: ReadonlyMap<string, string> = new Map([
  ["nfs", "nfs"],
  ["nfs4", "nfs"],
  ["cifs", "cifs"],
  ["smb3", "cifs"],
  ["smbfs", "smb"],
  ["9p", "9p"],
  ["afs", "afs"],
  ["ceph", "ceph"],
  ["coda", "coda"],
  ["ncpfs", "ncp"],
  ["davfs", "davfs"],
]);

export interface MountEntry {
  readonly mountPoint: string;
  readonly type: string;
  /** What is mounted (macOS): a device, `//user@server/share`, `user@host:/path` … */
  readonly source?: string;
}

const unescapeMount = (s: string): string =>
  s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));

/** /proc/self/mountinfo: each line's mount point and type (`fuse.sshfs` for a FUSE subtype). */
export function parseMountinfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const [left, right] = line.split(" - ");
    const mountPoint = left?.split(" ")[4];
    const type = right?.split(" ")[0];
    if (mountPoint === undefined || type === undefined || type === "") continue;
    entries.push({ mountPoint: unescapeMount(mountPoint), type });
  }
  return entries;
}

/** macOS `mount` output: `<source> on <mount point> (<type>, <options>)`. */
export function parseMacMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^(.*) on (\/.*) \(([^,)]+)[,)]/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      entries.push({ source: m[1], mountPoint: m[2], type: m[3].trim() });
    }
  }
  return entries;
}

/** The mount that holds `path`: the longest mount point that is the path or an ancestor. */
export function mountOf(entries: readonly MountEntry[], path: string): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const e of entries) {
    if (!isInside("linux", path, e.mountPoint)) continue;
    if (best === undefined || e.mountPoint.length >= best.mountPoint.length) best = e;
  }
  return best;
}

/** Whether the mount table names the FUSE mount that holds `path` (its subtype says what it is). */
function isFuseMount(mounts: string, path: string): boolean {
  return mountOf(parseMountinfo(mounts), path)?.type.startsWith("fuse") === true;
}

/** The network file system a Linux path is on, from its statfs type and the mount table. */
export function linuxNetwork(
  statfsType: number | undefined,
  mounts: string | undefined,
  path: string,
): string | undefined {
  const entry = mounts === undefined ? undefined : mountOf(parseMountinfo(mounts), path);
  if (statfsType !== undefined) {
    const named = NETWORK_MAGIC.get(statfsType);
    if (named !== undefined) return named;
    if (statfsType !== FUSE_MAGIC) return undefined;
    const subtype = entry?.type.startsWith("fuse.") === true ? entry.type.slice(5) : undefined;
    return subtype !== undefined && NETWORK_FUSE.has(subtype) ? `fuse.${subtype}` : undefined;
  }
  if (entry === undefined) return undefined;
  const named = NETWORK_TYPES.get(entry.type);
  if (named !== undefined) return named;
  const subtype = entry.type.startsWith("fuse.") ? entry.type.slice(5) : undefined;
  return subtype !== undefined && NETWORK_FUSE.has(subtype) ? entry.type : undefined;
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

/** The network file system a macOS path is on, from the mount table. */
export function macNetwork(mounts: string | undefined, path: string): string | undefined {
  if (mounts === undefined) return undefined;
  const entry = mountOf(parseMacMounts(mounts), path);
  if (entry === undefined) return undefined;
  if (MAC_NETWORK.has(entry.type)) return entry.type;
  // A macFUSE mount reaches another host when its source names one (sshfs: `user@host:/path`).
  const fuse = entry.type.startsWith("macfuse") || entry.type.startsWith("osxfuse");
  return fuse && /^(?:\/\/|[^/\s]+:)/.test(entry.source ?? "") ? entry.type : undefined;
}

/** Whether a Windows real path is a UNC path, which reaches another host. */
export const isUncPath = (path: string): boolean => /^[\\/]{2}[^\\/?.]/.test(path);

/**
 * Whether a Windows real path is on a drive letter the facts do not list. The facts list every
 * network drive and every other drive that was ready when they were read, so such a drive came
 * later or was not ready: its type and label were not seen (A1 3.2).
 */
export function unlistedDrive(path: string, windows: WindowsSyncFacts): boolean {
  const letter = /^([A-Za-z]):/.exec(path)?.[1]?.toUpperCase();
  return (
    letter !== undefined && !windows.drives.some((d) => d.root.slice(0, 1).toUpperCase() === letter)
  );
}

/** The network file system of a Windows real path: a UNC path, or a drive of type Network. */
export function windowsNetwork(
  path: string,
  windows: WindowsSyncFacts | undefined,
): string | undefined {
  if (isUncPath(path)) return "unc";
  const letter = /^([A-Za-z]):/.exec(path)?.[1]?.toUpperCase();
  if (letter === undefined || windows === undefined) return undefined;
  const drive = windows.drives.find((d) => d.root.slice(0, 1).toUpperCase() === letter);
  return drive?.type === "Network" ? "remote_drive" : undefined;
}

// ---------------------------------------------------------------------------------------------
// The check

/** The check's answer when it could not look at all: unchecked, so served as a synced folder. */
export const UNCHECKED: FolderCheck = {
  verdict: "synced",
  conflicts: [],
  signals: [{ kind: "synced", rule: "unchecked", depth: 0 }],
  exists: true,
};

/**
 * Checks the folder `target` and every folder above it (see the top of this file). Never throws:
 * a fault anywhere in it gives an unchecked folder, never a local one.
 */
export async function checkFolder(target: string, host: SyncHost): Promise<FolderCheck> {
  try {
    return await check(target, host);
  } catch {
    return UNCHECKED;
  }
}

async function check(target: string, host: SyncHost): Promise<FolderCheck> {
  const path = resolve(target);
  const chain = ancestors(path);
  let judgedFrom = chain.length - 1;
  for (let i = 0; i < chain.length; i += 1) {
    if (await host.isDirectory(chain[i] ?? "")) {
      judgedFrom = i;
      break;
    }
  }
  const existing = chain[judgedFrom] ?? path;
  const real = (await host.realpath(existing)) ?? existing;
  // Every existing folder to look in, with its depth below `path`: as given and as its real path.
  const looks = new Map<string, number>();
  chain.slice(judgedFrom).forEach((dir, i) => looks.set(dir, judgedFrom + i));
  ancestors(real).forEach((dir, i) => {
    if (!looks.has(dir)) looks.set(dir, judgedFrom + i);
  });
  const signals: SyncSignal[] = [];
  // Each kind of fact on its own: one that fails leaves the folder unchecked, and the others still
  // count (a marker still names its provider).
  const seen = { unchecked: false };
  const guarded = async <T>(look: () => Promise<T>, otherwise: T): Promise<T> => {
    try {
      return await look();
    } catch {
      seen.unchecked = true;
      return otherwise;
    }
  };

  const windows = await guarded(async () => {
    let facts = await host.windowsFacts();
    // An answer may be a minute old: a drive it does not list may have come since, so the folder
    // gets one fresh run before it is judged.
    if (host.platform === "win32" && facts !== undefined && unlistedDrive(real, facts)) {
      facts = await host.windowsFacts(true);
    }
    if (host.platform === "win32" && facts === undefined) seen.unchecked = true;
    return facts;
  }, undefined);
  await guarded(async () => {
    const { roots, complete } = await providerRoots(host, windows);
    // A fact read only in part may hide a root the folder is under: unchecked, never local.
    if (!complete) seen.unchecked = true;
    for (const r of roots) {
      const realRoot = (await host.realpath(r.root)) ?? r.root;
      const hit = [path, real].find(
        (p) => isInside(host.platform, p, r.root) || isInside(host.platform, p, realRoot),
      );
      if (hit === undefined) continue;
      const root = isInside(host.platform, hit, r.root) ? r.root : realRoot;
      signals.push({
        kind: "synced",
        provider: r.provider,
        rule: r.rule,
        depth: depthBelow(host.platform, path, root),
      });
    }
  }, undefined);
  for (const p of [path, real]) {
    const cloud = macCloudFolder(host, p);
    if (cloud !== undefined) {
      signals.push(cloud);
      break;
    }
  }

  for (const [dir, depth] of looks) {
    for (const marker of MARKERS) {
      const at = join(dir, marker.name);
      const found = await guarded(
        async () =>
          (await host.exists(at)) && (marker.file !== true || !(await host.isDirectory(at))),
        false,
      );
      if (found) signals.push({ kind: "synced", provider: marker.provider, rule: "marker", depth });
    }
    const names = await guarded(() => host.list(dir), undefined);
    if (names?.some((n) => NEXTCLOUD_JOURNAL.test(n)) === true) {
      signals.push({ kind: "synced", provider: "nextcloud", rule: "marker", depth });
    }
  }

  const conflicts = await guarded(
    async () =>
      judgedFrom === 0 ? ((await host.list(path)) ?? []).filter(isConflictCopy).sort() : [],
    [],
  );
  if (conflicts.length > 0) signals.push({ kind: "synced", rule: "conflict_copy", depth: 0 });

  const fs = await guarded(async (): Promise<string | undefined> => {
    if (host.platform === "win32") {
      // A drive the facts do not list, even after a fresh run, was not seen: unchecked.
      if (windows !== undefined && unlistedDrive(real, windows)) seen.unchecked = true;
      return windowsNetwork(real, windows);
    }
    if (host.platform === "linux") {
      const type = await host.statfsType(real);
      const mounts = await host.mountTable();
      // Neither fact, or FUSE without the mount table that names what it is: unknown.
      if (type === undefined && mounts === undefined) seen.unchecked = true;
      if (type === FUSE_MAGIC && (mounts === undefined || !isFuseMount(mounts, real))) {
        seen.unchecked = true;
      }
      return linuxNetwork(type, mounts, real);
    }
    if (host.platform === "darwin") {
      const mounts = await host.mountTable();
      if (mounts === undefined) seen.unchecked = true;
      return macNetwork(mounts, real);
    }
    return undefined;
  }, undefined);
  if (fs !== undefined) {
    signals.push({ kind: "network", fs, rule: "network_volume", depth: judgedFrom });
  }
  if (seen.unchecked) signals.push({ kind: "synced", rule: "unchecked", depth: judgedFrom });

  signals.sort((a, b) => a.depth - b.depth);
  const network = signals.find((s) => s.kind === "network");
  const synced = signals.filter((s) => s.kind === "synced");
  const provider = synced.find((s) => s.provider !== undefined)?.provider;
  return {
    verdict: network !== undefined ? "network" : synced.length > 0 ? "synced" : "local",
    ...(provider === undefined ? {} : { provider }),
    ...(network?.fs === undefined ? {} : { fs: network.fs }),
    conflicts,
    signals,
    exists: judgedFrom === 0,
  };
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
