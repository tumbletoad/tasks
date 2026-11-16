// A version folder (A2 3.12.2), assembled from the verified runtime, the launchers and the bundles:
//
//   bin/tasks                     POSIX launcher (Linux, macOS)
//   bin/tasks-launchd             launchd wrapper (macOS, M1.12's text, A2 3.3.4)
//   bin/tasks.exe, bin/tasksw.exe C launchers (Windows)
//   bin/tasks-run.exe             the holder of a background run's job object (Windows)
//   runtime/node | node.exe       the official Node binary, unmodified
//   lib/tasks.mjs                 entry: compile cache, then the CLI chunk, the bridge or the shim
//   lib/chunks/*.mjs              the CLI, the three worker entries and their shared chunks
//   lib/bridge.mjs                the bridge, Node built-ins only (A2 3.7.1)
//   lib/shim.mjs                  the launch shim, Node built-ins only (A4 3.6.3)
//   lib/mcp-offline.json          its offline answers, stamped with this build (A2 3.7.3)
//   ui/index.html, ui/assets/*    the page (packages/web, M2.13), which the service serves
//   ui/manifest.webmanifest, ui/icon*  its web app manifest and icons (M5.01)
//   licenses/node.txt             Node's licence, from its archive
//   LICENSE, NOTICE               Tasks's
//   THIRD_PARTY.txt               the npm packages in lib/ and ui/, with their licences
//   manifest.json                 the build and the SHA-256 of every other file
//
// `native/` (empty unless a fallback SQLite binding is needed, A2 3.12.1) is not made: an archive
// holds no empty folder, and a build has none yet.
import { closeSync, existsSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { PROTOCOL } from "../../packages/bridge/src/protocol/constants.ts";
import {
  listFolder,
  writeVersionManifest,
  type VersionManifest,
} from "../../packages/service/src/version/folder.ts";
import { createFile, makeDir } from "../../packages/files/src/index.ts";
import type { FileEntry } from "./archive.ts";
import { osOf, type Platform } from "./platforms.ts";

/** Folders whose file names the bundlers pick (content hashes): checked as a whole, not by name. */
const BUNDLED_FOLDERS = ["lib/chunks/", "ui/assets/"] as const;

/** The files of a version folder outside BUNDLED_FOLDERS. */
export function plannedFiles(platform: Platform): string[] {
  const windows = platform === "win-x64";
  return [
    ...(windows
      ? [`bin/${PRODUCT_ID}.exe`, `bin/${PRODUCT_ID}w.exe`, `bin/${PRODUCT_ID}-run.exe`]
      : [
          `bin/${PRODUCT_ID}`,
          ...(osOf(platform) === "darwin" ? [`bin/${PRODUCT_ID}-launchd`] : []),
        ]),
    windows ? "runtime/node.exe" : "runtime/node",
    `lib/${PRODUCT_ID}.mjs`,
    "lib/bridge.mjs",
    "lib/mcp-offline.json",
    "lib/shim.mjs",
    "ui/index.html",
    // The web app manifest and its icons (A5 3.24 `PWA`, M5.01), at the page's root.
    "ui/manifest.webmanifest",
    "ui/icon.svg",
    "ui/icon-192.png",
    "ui/icon-512.png",
    "licenses/node.txt",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY.txt",
  ].sort();
}

/** The files that carry the exec bit in a POSIX archive. Windows needs none. */
export function executables(platform: Platform): ReadonlySet<string> {
  return platform === "win-x64"
    ? new Set()
    : new Set([`bin/${PRODUCT_ID}`, `bin/${PRODUCT_ID}-launchd`, "runtime/node"]);
}

/** Where each file comes from: a file on disk, or text the build wrote. */
export type Source = { readonly file: string } | { readonly text: string };

export interface FolderInput {
  readonly platform: Platform;
  readonly version: string;
  readonly build: string;
  readonly node: {
    readonly version: string;
    readonly sqlite: string;
    readonly binary: string;
    readonly license: string;
  };
  /**
   * The launchers: the POSIX script's and the launchd wrapper's text (macOS takes the wrapper),
   * or the compiled Windows pair and tasks-run.exe.
   */
  readonly launchers:
    | { readonly posix: string; readonly launchd: string }
    | { readonly tasks: string; readonly tasksw: string; readonly run: string };
  /** The bundler's output folder, which holds lib/. */
  readonly bundle: { readonly out: string; readonly files: readonly string[] };
  /** The page's build (packages/web): its folder, and its files relative to it. */
  readonly ui: { readonly out: string; readonly files: readonly string[] };
  readonly thirdParty: string;
  readonly repoRoot: string;
}

/** Every file of the folder but manifest.json, with its source. */
export function folderSources(input: FolderInput): Map<string, Source> {
  const sources = new Map<string, Source>();
  const windows = input.platform === "win-x64";
  if ("tasks" in input.launchers) {
    if (!windows) throw new Error("only win-x64 takes the C launchers");
    sources.set(`bin/${PRODUCT_ID}.exe`, { file: input.launchers.tasks });
    sources.set(`bin/${PRODUCT_ID}w.exe`, { file: input.launchers.tasksw });
    sources.set(`bin/${PRODUCT_ID}-run.exe`, { file: input.launchers.run });
  } else {
    if (windows) throw new Error("win-x64 needs the C launchers");
    sources.set(`bin/${PRODUCT_ID}`, { text: input.launchers.posix });
    if (osOf(input.platform) === "darwin") {
      sources.set(`bin/${PRODUCT_ID}-launchd`, { text: input.launchers.launchd });
    }
  }
  sources.set(windows ? "runtime/node.exe" : "runtime/node", { file: input.node.binary });
  for (const file of input.bundle.files) sources.set(file, { file: join(input.bundle.out, file) });
  for (const file of input.ui.files) {
    sources.set(`ui/${file}`, { file: join(input.ui.out, ...file.split("/")) });
  }
  sources.set("licenses/node.txt", { file: input.node.license });
  sources.set("LICENSE", { file: join(input.repoRoot, "LICENSE") });
  sources.set("NOTICE", { file: join(input.repoRoot, "NOTICE") });
  sources.set("THIRD_PARTY.txt", { text: input.thirdParty });
  return sources;
}

/**
 * Writes `bytes` into the new file `to` with exactly `mode`, whatever the umask: created
 * exclusively, its mode set on the open file (@tasks/files), never by its path.
 */
function writeNewFile(to: string, bytes: Uint8Array, mode: number): void {
  const fd = createFile(to, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (n <= 0) throw new Error(`a write to ${to} made no progress`);
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates the version folder at `out` (which must not exist), writes its manifest.json and returns
 * the manifest. The folder holds exactly the planned files, lib/chunks/, ui/assets/ and
 * manifest.json.
 */
export function assembleVersionFolder(out: string, input: FolderInput): VersionManifest {
  if (existsSync(out)) throw new Error(`${out} already exists`);
  const sources = folderSources(input);
  const exec = executables(input.platform);
  for (const [rel, source] of [...sources].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const to = join(out, ...rel.split("/"));
    // Folders 0755 and files 0644 or 0755, exactly, whatever the umask: the archive sets the same
    // modes itself, and this makes the folder runnable and readable as it stands, too.
    makeDir(dirname(to), 0o755);
    const bytes = "file" in source ? readFileSync(source.file) : Buffer.from(source.text, "utf8");
    writeNewFile(to, bytes, exec.has(rel) ? 0o755 : 0o644);
  }
  const planned = plannedFiles(input.platform);
  const present = listFolder(out).files;
  const unplanned = present.filter(
    (f) => !planned.includes(f) && !BUNDLED_FOLDERS.some((folder) => f.startsWith(folder)),
  );
  const missing = planned.filter((f) => !present.includes(f));
  if (unplanned.length > 0 || missing.length > 0) {
    throw new Error(
      `the version folder does not match its plan: extra ${unplanned.join(", ") || "none"}, missing ${missing.join(", ") || "none"}`,
    );
  }
  return writeVersionManifest(out, {
    version: input.version,
    build: input.build,
    platform: input.platform,
    node: input.node.version,
    sqlite: input.node.sqlite,
    protocol: { min: PROTOCOL, max: PROTOCOL },
  });
}

/** A version folder's files as archive entries, with the exec bits of the POSIX executables. */
export function folderEntries(dir: string, platform: Platform): FileEntry[] {
  const listing = listFolder(dir);
  if (listing.problems.length > 0) throw new Error(listing.problems.join("; "));
  const exec = executables(platform);
  return listing.files.map((rel) => ({
    path: rel,
    data: readFileSync(join(dir, ...rel.split("/"))),
    mode: exec.has(rel) ? 0o755 : 0o644,
  }));
}

/** Files the scan skips: Node's own binary and licence, which the build does not make. */
const NOT_OURS = new Set(["runtime/node", "runtime/node.exe", "licenses/node.txt"]);

/** Machine paths shorter than this are not searched for: they would match ordinary text. */
const MIN_NEEDLE = 8;

/**
 * The spellings of this machine's paths that must never reach a version folder: the builder's
 * home folder and the repository and work folders, with either separator, JSON-escaped, as a file
 * URL, and lowercased on Windows. Each is searched as UTF-8 and as UTF-16 (the launchers' strings).
 */
export function machinePathNeedles(paths: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/[\\/]+$/, "");
    if (path.length < MIN_NEEDLE) continue;
    const forward = path.replaceAll("\\", "/");
    const backward = path.replaceAll("/", "\\");
    for (const form of [path, forward, backward, backward.replaceAll("\\", "\\\\")]) {
      needles.add(form);
      if (process.platform === "win32") needles.add(form.toLowerCase());
    }
    needles.add(encodeURI(forward));
  }
  return [...needles].filter((n) => n.length >= MIN_NEEDLE).sort();
}

/** The paths of this build machine that machinePathNeedles spells out. */
export function buildMachinePaths(repoRoot: string, work: string): string[] {
  return [homedir(), repoRoot, work];
}

/**
 * One message per file of the folder that holds a machine path. Node's binary and licence are
 * skipped: the build does not make them, and they are the official files.
 */
export function scanForMachinePaths(dir: string, needles: readonly string[]): string[] {
  const forms = needles.flatMap((n) => [Buffer.from(n, "utf8"), Buffer.from(n, "utf16le")]);
  const hits: string[] = [];
  for (const rel of listFolder(dir).files) {
    if (NOT_OURS.has(rel)) continue;
    const data = readFileSync(join(dir, ...rel.split("/")));
    const lower =
      process.platform === "win32"
        ? Buffer.from(data.toString("latin1").toLowerCase(), "latin1")
        : data;
    if (forms.some((form) => data.includes(form) || lower.includes(form))) hits.push(rel);
  }
  return hits;
}
