// Lab row R07 (A7 3.7): the sync detector at spike level, after A1 3.2 and A6 3.16.6.
//
//   node spikes/m0/checks/sync-detect.ts --out <folder> [--defaults] [--provider-roots]
//     [--target <label>=<path>]... [--no-list]
//
// --defaults        ~/Tasks and the A2 3.2.1 folders of this OS (computed, never created)
// --provider-roots  every sync root found in the environment, the registry and the clients' own
//                   files (OneDrive, Google Drive, Dropbox, iCloud, Cloud Files sync roots)
// --no-list         never read a folder's entries. Without it, ancestors are listed only to find
//                   the name patterns of A1 3.2 (`.sync_*.db`, conflict copies).
//
// The detector checks the path and every ancestor: the provider roots it knows, fixed marker names
// (a stat of one name each, never a listing), and the volume the nearest existing ancestor sits
// on (network, removable). A missing path is judged from its nearest existing ancestor. Results
// name each target by its label only, never by its path.
import { existsSync, readFileSync, readdirSync, realpathSync, statfsSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { machineFacts, powershellJson, writeResult } from "./common.ts";

export type Kind = "synced" | "network" | "removable";
export type Verdict = "local" | Kind;

export interface Root {
  provider: string;
  root: string;
  /** Where the root came from, for the record: "env OneDrive", "registry …", "info.json". */
  source: string;
}

export interface Volume {
  kind: "local" | "network" | "removable" | "unknown";
  fsType: string;
  /** A signal from the volume itself, such as the Google Drive virtual drive's label. */
  provider?: string;
}

export interface Signal {
  kind: Kind;
  provider: string;
  rule: string;
  /** 0 is the path itself, 1 its parent, and so on. */
  depth: number;
}

export interface Context {
  platform: NodeJS.Platform;
  home: string;
  roots: readonly Root[];
  exists(path: string): boolean;
  /** Names in a folder, or undefined when listing is not allowed. */
  list(dir: string): readonly string[] | undefined;
  volume(existingPath: string): Volume;
}

export interface Detection {
  exists: boolean;
  /** Levels from the path up to the nearest existing ancestor, which the volume check used. */
  judgedFrom: number;
  verdict: Verdict;
  providers: string[];
  signals: Signal[];
  volume: Volume;
}

/** Fixed marker names, checked in the path and every ancestor (A1 3.2, A6 3.16.6). */
export const MARKERS: readonly { name: string; provider: string }[] = [
  { name: ".stfolder", provider: "syncthing" },
  { name: ".dropbox", provider: "dropbox" },
  { name: ".owncloudsync.log", provider: "nextcloud" },
  { name: ".git", provider: "git" },
];

/** Name patterns that need a folder listing (A1 3.2). */
export const PATTERNS: readonly { pattern: RegExp; provider: string; rule: string }[] = [
  { pattern: /^\.sync_.*\.db$/, provider: "nextcloud", rule: "marker .sync_*.db" },
  { pattern: /\.sync-conflict-/, provider: "syncthing", rule: "conflict copy" },
  { pattern: /\(conflicted copy/, provider: "dropbox", rule: "conflict copy" },
];

/** Linux filesystem types that are network mounts (A2 3.2.2 rule 6, A1 3.2). */
export const NETWORK_FS: ReadonlySet<string> = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "9p",
  "afs",
  "ceph",
  "glusterfs",
  "davfs",
  "fuse.sshfs",
  "fuse.rclone",
  "fuse.gvfsd-fuse",
  "fuse.davfs2",
  "fuse.s3fs",
  "fuse.gcsfuse",
  "fuse.onedriver",
  "fuse.google-drive-ocamlfuse",
]);

/** Linux statfs magic numbers of network filesystems, for when /proc is not readable. */
export const NETWORK_MAGIC: ReadonlyMap<number, string> = new Map([
  [0x6969, "nfs"],
  [0x517b, "smbfs"],
  [0xff534d42, "cifs"],
  [0xfe534d42, "smb2"],
  [0x01021997, "9p"],
  [0x5346414f, "afs"],
  [0x00c36400, "ceph"],
]);

function fold(platform: NodeJS.Platform, p: string): string {
  const trimmed = p.length > 3 ? p.replace(/[\\/]+$/, "") : p;
  return platform === "win32" ? trimmed.toLowerCase().replaceAll("/", "\\") : trimmed;
}

/** Whether `path` is `root` or inside it, by path text (case-insensitive on Windows). */
export function isInside(platform: NodeJS.Platform, path: string, root: string): boolean {
  const separator = platform === "win32" ? "\\" : "/";
  const p = fold(platform, path);
  const r = fold(platform, root);
  if (p === r) return true;
  return p.startsWith(r.endsWith(separator) ? r : r + separator);
}

/** The path and its ancestors, the path first. */
export function ancestors(path: string): string[] {
  const list = [path];
  for (let d = dirname(path); d !== list[list.length - 1]; d = dirname(d)) list.push(d);
  return list;
}

export function detect(target: string, ctx: Context): Detection {
  const path = resolve(target);
  const chain = ancestors(path);
  const signals: Signal[] = [];
  let judgedFrom = chain.findIndex((d) => ctx.exists(d));
  if (judgedFrom < 0) judgedFrom = chain.length - 1;

  for (const r of ctx.roots) {
    if (!isInside(ctx.platform, path, r.root)) continue;
    const depth = chain.findIndex((d) => fold(ctx.platform, d) === fold(ctx.platform, r.root));
    signals.push({
      kind: "synced",
      provider: r.provider,
      rule: r.source,
      depth: Math.max(depth, 0),
    });
  }
  if (ctx.platform === "darwin") {
    for (const sub of ["Library/Mobile Documents", "Library/CloudStorage"]) {
      if (isInside(ctx.platform, path, join(ctx.home, sub)))
        signals.push({ kind: "synced", provider: "icloud", rule: `under ~/${sub}`, depth: 0 });
    }
  }
  chain.forEach((dir, depth) => {
    if (depth < judgedFrom) return;
    for (const m of MARKERS) {
      if (ctx.exists(join(dir, m.name)))
        signals.push({ kind: "synced", provider: m.provider, rule: `marker ${m.name}`, depth });
    }
    const names = ctx.list(dir);
    if (names === undefined) return;
    for (const p of PATTERNS) {
      // Conflict copies count only next to the path itself, where a space's files would be.
      if (p.rule === "conflict copy" && depth !== 0) continue;
      if (names.some((n) => p.pattern.test(n)))
        signals.push({ kind: "synced", provider: p.provider, rule: p.rule, depth });
    }
  });

  const volume = ctx.volume(chain[judgedFrom] ?? path);
  if (volume.kind === "network" || volume.kind === "removable") {
    signals.push({ kind: volume.kind, provider: volume.fsType, rule: "volume", depth: judgedFrom });
  }
  if (volume.provider !== undefined) {
    signals.push({ kind: "synced", provider: volume.provider, rule: "volume", depth: judgedFrom });
  }

  const has = (k: Kind) => signals.some((s) => s.kind === k);
  const verdict: Verdict = has("network")
    ? "network"
    : has("synced")
      ? "synced"
      : has("removable")
        ? "removable"
        : "local";
  const providers = [...new Set(signals.filter((s) => s.kind === "synced").map((s) => s.provider))];
  return { exists: judgedFrom === 0, judgedFrom, verdict, providers, signals, volume };
}

// ---------------------------------------------------------------------------------------------
// The real machine.

interface MountEntry {
  mountPoint: string;
  fsType: string;
  source: string;
}

function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
}

/** Parses /proc/self/mountinfo. */
export function parseMountinfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const [left, right] = line.split(" - ");
    if (left === undefined || right === undefined) continue;
    const mountPoint = left.split(" ")[4];
    const [fsType, source] = right.split(" ");
    if (mountPoint === undefined || fsType === undefined) continue;
    entries.push({ mountPoint: unescapeMount(mountPoint), fsType, source: source ?? "" });
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

export function classifyLinuxMount(entry: MountEntry | undefined, removableFlag: boolean): Volume {
  if (entry === undefined) return { kind: "unknown", fsType: "unknown" };
  if (NETWORK_FS.has(entry.fsType) || entry.fsType.startsWith("nfs"))
    return { kind: "network", fsType: entry.fsType };
  if (
    removableFlag ||
    entry.mountPoint.startsWith("/media/") ||
    entry.mountPoint.startsWith("/run/media/")
  )
    return { kind: "removable", fsType: entry.fsType };
  return { kind: "local", fsType: entry.fsType };
}

function linuxVolume(path: string): Volume {
  let entries: MountEntry[];
  try {
    entries = parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    const magic = statfsSync(path).type;
    const net = NETWORK_MAGIC.get(magic);
    return net === undefined
      ? { kind: "unknown", fsType: `0x${magic.toString(16)}` }
      : { kind: "network", fsType: net };
  }
  const entry = mountOf(entries, realpathSync(path));
  let removable = false;
  const dev = /^\/dev\/(sd[a-z]+|mmcblk\d+|nvme\d+n\d+)/.exec(entry?.source ?? "")?.[1];
  if (dev !== undefined) {
    try {
      removable = readFileSync(`/sys/class/block/${dev}/removable`, "utf8").trim() === "1";
    } catch {
      removable = false;
    }
  }
  return classifyLinuxMount(entry, removable);
}

interface WindowsFacts {
  drives: { name: string; type: string; format: string; label: string }[];
  oneDriveAccounts: string[];
  syncRoots: { provider: string; path: string }[];
  driveFsTargets: string;
}

/** Read-only queries: drives, OneDrive accounts, Cloud Files sync roots, Drive for desktop. */
function windowsFacts(): WindowsFacts {
  const script = `
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$drives = @(foreach ($d in [IO.DriveInfo]::GetDrives()) {
  $f = ''; $l = ''
  if ($d.IsReady) { $f = $d.DriveFormat; $l = $d.VolumeLabel }
  @{ name = $d.Name; type = $d.DriveType.ToString(); format = $f; label = $l }
})
$accounts = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\OneDrive\\Accounts' -ErrorAction SilentlyContinue |
  ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).UserFolder } |
  Where-Object { $_ })
$roots = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $u = Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'UserSyncRoots') -ErrorAction SilentlyContinue
    if ($u -and $u.PSObject.Properties[$sid]) { @{ provider = ($_.PSChildName -split '!')[0]; path = [string]$u.$sid } }
  })
$targets = ''
$share = Get-ItemProperty 'HKCU:\\Software\\Google\\DriveFS\\Share' -ErrorAction SilentlyContinue
if ($share -and $share.PSObject.Properties['SyncTargets']) { $targets = [Convert]::ToBase64String([byte[]]$share.SyncTargets) }
@{ drives = $drives; oneDriveAccounts = $accounts; syncRoots = $roots; driveFsTargets = $targets }`;
  return powershellJson(script) as WindowsFacts;
}

/** Paths inside Drive for desktop's SyncTargets value (a binary blob holding UTF-8 or UTF-16 paths). */
export function driveFsPaths(base64: string): string[] {
  const bytes = Buffer.from(base64, "base64");
  const found = new Set<string>();
  // UTF-16 text may start at an odd offset inside the blob, so both alignments are decoded.
  const texts = [
    bytes.toString("utf8"),
    bytes.toString("utf16le"),
    bytes.subarray(1).toString("utf16le"),
  ];
  for (const text of texts) {
    for (const m of text.matchAll(/(?:[A-Za-z]:\\|\\\\)[^"*<>?|\p{Cc}]{1,240}/gu)) {
      found.add(m[0].replace(/[\\]+$/, ""));
    }
  }
  return [...found];
}

function dropboxRoots(files: readonly string[], exists: (p: string) => boolean): Root[] {
  const roots: Root[] = [];
  for (const f of files) {
    if (!exists(f)) continue;
    try {
      const info = JSON.parse(readFileSync(f, "utf8")) as Record<string, { path?: string }>;
      for (const [kind, v] of Object.entries(info)) {
        if (typeof v.path === "string")
          roots.push({ provider: "dropbox", root: v.path, source: `info.json ${kind}` });
      }
    } catch {
      // An unreadable info.json is no root.
    }
  }
  return roots;
}

export function realContext(allowList: boolean): Context {
  const platform = process.platform;
  const exists = (p: string) => existsSync(p);
  const list = (dir: string) => {
    if (!allowList) return undefined;
    try {
      return readdirSync(dir);
    } catch {
      return undefined;
    }
  };
  if (platform === "win32") {
    const home = process.env.USERPROFILE ?? os.homedir();
    const facts = windowsFacts();
    const roots: Root[] = [];
    for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const v = process.env[name];
      if (v !== undefined && v !== "")
        roots.push({ provider: "onedrive", root: v, source: `env ${name}` });
    }
    for (const r of facts.oneDriveAccounts)
      roots.push({ provider: "onedrive", root: r, source: "registry OneDrive account" });
    for (const r of facts.syncRoots)
      roots.push({ provider: r.provider, root: r.path, source: "registry Cloud Files sync root" });
    for (const r of driveFsPaths(facts.driveFsTargets))
      roots.push({ provider: "google-drive", root: r, source: "registry DriveFS SyncTargets" });
    for (const d of facts.drives) {
      if (d.label === "Google Drive")
        roots.push({ provider: "google-drive", root: d.name, source: "volume label" });
    }
    const icloud = join(home, "iCloudDrive");
    if (exists(icloud)) roots.push({ provider: "icloud", root: icloud, source: "default folder" });
    roots.push(
      ...dropboxRoots(
        [process.env.APPDATA, process.env.LOCALAPPDATA]
          .filter((d): d is string => d !== undefined)
          .map((d) => join(d, "Dropbox", "info.json")),
        exists,
      ),
    );
    const volume = (p: string): Volume => {
      if (p.startsWith("\\\\") && !p.startsWith("\\\\?\\"))
        return { kind: "network", fsType: "unc" };
      const letter = p.slice(0, 3).toUpperCase();
      const d = facts.drives.find((x) => x.name.toUpperCase() === letter);
      if (d === undefined) return { kind: "unknown", fsType: "unknown" };
      const kind =
        d.type === "Network"
          ? "network"
          : d.type === "Removable" || d.type === "CDRom"
            ? "removable"
            : d.type === "Fixed"
              ? "local"
              : "unknown";
      return { kind, fsType: d.format === "" ? d.type : d.format };
    };
    return { platform, home, roots, exists, list, volume };
  }
  // A2 3.2.2 rule 1: home comes from the account, not the environment.
  const home = os.userInfo().homedir;
  const roots = dropboxRoots([join(home, ".dropbox", "info.json")], exists);
  const volume =
    platform === "linux" ? linuxVolume : (): Volume => ({ kind: "unknown", fsType: "unknown" });
  return { platform, home, roots, exists, list, volume };
}

/** ~/Tasks and the folders of A2 3.2.1 for this OS, by label. Nothing is created. */
export function defaultTargets(
  platform: NodeJS.Platform,
  home: string,
  uid: number,
): Map<string, string> {
  const t = new Map<string, string>();
  t.set("~/Tasks", join(home, "Tasks"));
  if (platform === "win32") {
    t.set("<root> %USERPROFILE%\\.ttasks", join(home, ".ttasks"));
    t.set("<config>", join(home, ".ttasks", "config"));
    t.set("<state>", join(home, ".ttasks", "state"));
    t.set("<cache>", join(home, ".ttasks", "cache"));
  } else if (platform === "darwin") {
    const base = join(home, "Library", "Application Support", "ttasks");
    t.set("<root>", base);
    t.set("<config>", join(base, "config"));
    t.set("<state>", join(base, "state"));
    t.set("<cache>", join(home, "Library", "Caches", "ttasks"));
  } else {
    t.set("<root> ~/.local/share/ttasks", join(home, ".local", "share", "ttasks"));
    t.set("<config> ~/.config/ttasks", join(home, ".config", "ttasks"));
    t.set("<state> ~/.local/state/tasks", join(home, ".local", "state", "ttasks"));
    t.set("<cache> ~/.cache/tasks", join(home, ".cache", "tasks"));
    t.set("socket dir /run/user/<uid>", `/run/user/${String(uid)}`);
  }
  return t;
}

function main(argv: readonly string[]): number {
  let out: string | undefined;
  let allowList = true;
  let defaults = false;
  let providerRoots = false;
  const targets = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--no-list") allowList = false;
    else if (a === "--defaults") defaults = true;
    else if (a === "--provider-roots") providerRoots = true;
    else if (a === "--target") {
      const spec = argv[++i] ?? "";
      const at = spec.indexOf("=");
      const p = spec.slice(at + 1);
      if (at < 1 || !isAbsolute(p)) throw new Error(`--target wants <label>=<absolute path>`);
      targets.set(spec.slice(0, at), p);
    } else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (out === undefined) throw new Error("pass --out <folder>");
  const ctx = realContext(allowList);
  const uid = process.getuid?.() ?? -1;
  const all = new Map<string, string>([
    ...(defaults ? defaultTargets(ctx.platform, ctx.home, uid) : []),
    ...targets,
  ]);
  if (providerRoots) {
    for (const r of ctx.roots) all.set(`provider root: ${r.provider} (${r.source})`, r.root);
  }
  const rows = [...all].map(([label, path]) => {
    // A provider root is judged with listing off, so nothing inside it is ever read.
    const d = detect(
      path,
      label.startsWith("provider root") ? { ...ctx, list: () => undefined } : ctx,
    );
    console.log(
      `${label}: ${d.verdict}${d.providers.length > 0 ? ` (${d.providers.join(", ")})` : ""}, ` +
        `exists ${String(d.exists)}, volume ${d.volume.kind} ${d.volume.fsType}` +
        (d.signals.length > 0
          ? `; signals ${d.signals.map((s) => `${s.kind}:${s.provider}:${s.rule}@${String(s.depth)}`).join(", ")}`
          : ""),
    );
    return { label, ...d };
  });
  const file = writeResult(out, "r07-sync-detect.json", {
    row: "R07",
    at: new Date().toISOString(),
    machine: machineFacts(),
    listing: allowList,
    providerRootsFound: ctx.roots.map((r) => ({ provider: r.provider, source: r.source })),
    targets: rows,
  });
  console.log(`result: ${file}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
