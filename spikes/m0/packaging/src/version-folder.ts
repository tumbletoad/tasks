// The version folder and its archive (A2 3.12.2, 3.12.4). Spike layout:
//
//   bin/ttasks                       POSIX launcher (linux-x64)
//   bin/ttasks.exe, bin/ttasksw.exe   C launchers (win-x64)
//   runtime/node | runtime/node.exe the official Node binary, unmodified
//   lib/ttasks.mjs, gate.mjs, install.mjs   the stand-in app
//   licenses/node.txt               Node's licence
//   LICENSE, NOTICE                 TTasks's
//   manifest.json                   version, build, platform, node and sqlite versions,
//                                   and the SHA-256 of every other file
//
// manifest.json keeps "files" as a flat map of path to hex digest, one entry per line, so the
// POSIX install script can read it with sed (no JSON parser needed in sh).
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type FileEntry, writeTarGz, writeZip } from "./archive.ts";
import { appDir, posixLauncher, repoRoot } from "./paths.ts";

export const PLATFORMS = ["linux-x64", "win-x64"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** The platform this process runs on, if the spike builds for it. */
export function hostPlatform(): Platform | undefined {
  if (process.arch !== "x64") return undefined;
  if (process.platform === "linux") return "linux-x64";
  if (process.platform === "win32") return "win-x64";
  return undefined;
}

/** A version that `current` accepts (A2 3.12.3): [0-9A-Za-z.+-], 1 to 64, not only dots. */
export const VERSION_PATTERN = /^(?!\.+$)[0-9A-Za-z.+-]{1,64}$/;

export function archiveName(version: string, platform: Platform): string {
  return `ttasks-${version}-${platform}.${platform === "win-x64" ? "zip" : "tar.gz"}`;
}

export interface Manifest {
  format: 1;
  name: "ttasks";
  version: string;
  build: string;
  platform: Platform;
  node: string;
  sqlite: string;
  files: Record<string, string>;
}

/** Files that carry the exec bit in the tar. */
const EXECUTABLES = new Set(["bin/ttasks", "runtime/node"]);

/** Paths the manifest may list: the same characters the POSIX install script accepts. */
const MANIFEST_PATH = /^[A-Za-z0-9._/-]+$/;

export interface VersionFolderInput {
  version: string;
  build: string;
  platform: Platform;
  node: { version: string; sqlite: string; binary: string; license: string };
  /** The compiled launchers, required for win-x64. */
  launchers?: { ttasks: string; ttasksw: string };
  /** Replaces app files by name, for the tamper tests' look-alike archives. */
  appOverrides?: Record<string, string>;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

/** Every file below `dir`, as sorted forward-slash relative paths. */
export function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`not a regular file: ${rel}`);
  }
  return out.sort();
}

function serializeManifest(m: Manifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** Creates the version folder at `out`, which must not exist yet. Returns its manifest. */
export function assembleVersionFolder(out: string, input: VersionFolderInput): Manifest {
  if (!VERSION_PATTERN.test(input.version)) throw new Error(`invalid version ${input.version}`);
  if (existsSync(out)) throw new Error(`${out} already exists`);
  const place = (rel: string, from: string | Buffer): void => {
    const to = join(out, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    if (typeof from === "string") copyFileSync(from, to);
    else writeFileSync(to, from);
    // The archive sets modes itself. This makes the staged folder runnable as it is, too.
    if (process.platform !== "win32") chmodSync(to, EXECUTABLES.has(rel) ? 0o755 : 0o644);
  };

  if (input.platform === "win-x64") {
    if (input.launchers === undefined) throw new Error("win-x64 needs the compiled launchers");
    place("bin/ttasks.exe", input.launchers.ttasks);
    place("bin/ttasksw.exe", input.launchers.ttasksw);
    place("runtime/node.exe", input.node.binary);
  } else {
    place("bin/ttasks", posixLauncher);
    place("runtime/node", input.node.binary);
  }
  for (const name of ["ttasks.mjs", "gate.mjs", "install.mjs"]) {
    const override = input.appOverrides?.[name];
    place(`lib/${name}`, override === undefined ? join(appDir, name) : Buffer.from(override));
  }
  place("licenses/node.txt", input.node.license);
  place("LICENSE", join(repoRoot, "LICENSE"));
  place("NOTICE", join(repoRoot, "NOTICE"));

  const files: Record<string, string> = {};
  for (const rel of listFiles(out)) {
    if (!MANIFEST_PATH.test(rel)) throw new Error(`path not allowed in a version folder: ${rel}`);
    files[rel] = sha256File(join(out, ...rel.split("/")));
  }
  const manifest: Manifest = {
    format: 1,
    name: "ttasks",
    version: input.version,
    build: input.build,
    platform: input.platform,
    node: input.node.version,
    sqlite: input.node.sqlite,
    files,
  };
  writeFileSync(join(out, "manifest.json"), serializeManifest(manifest));
  return manifest;
}

/** Checks a version folder against its manifest.json. Returns one message per problem. */
export function verifyVersionFolder(dir: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const present = listFiles(dir).filter((f) => f !== "manifest.json");
  const listed = Object.keys(manifest.files).sort();
  for (const f of present) if (!(f in manifest.files)) problems.push(`not in manifest: ${f}`);
  for (const f of listed) {
    if (!present.includes(f)) problems.push(`missing: ${f}`);
    else if (sha256File(join(dir, ...f.split("/"))) !== manifest.files[f]) {
      problems.push(`changed: ${f}`);
    }
  }
  return problems;
}

/** Reads a version folder into archive entries, with exec bits for the POSIX executables. */
export function folderEntries(dir: string): FileEntry[] {
  return listFiles(dir).map((rel) => ({
    path: rel,
    data: readFileSync(join(dir, ...rel.split("/"))),
    mode: EXECUTABLES.has(rel) ? 0o755 : 0o644,
  }));
}

/** Writes the archive of a version folder: gzipped tar for Linux, zip for Windows. */
export function packEntries(entries: FileEntry[], platform: Platform, level = 9): Buffer {
  return platform === "win-x64" ? writeZip(entries, { level }) : writeTarGz(entries, { level });
}

export function packVersionFolder(
  dir: string,
  platform: Platform,
  archive: string,
  level = 9,
): string {
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(archive, packEntries(folderEntries(dir), platform, level));
  if (statSync(archive).size === 0) throw new Error(`empty archive ${archive}`);
  return archive;
}

/** Rewrites manifest.json's file map for a changed set of entries (look-alike archives). */
export function remanifest(entries: FileEntry[]): FileEntry[] {
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  if (manifestEntry === undefined) throw new Error("no manifest.json in the entries");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as Manifest;
  manifest.files = {};
  for (const e of entries) if (e.path !== "manifest.json") manifest.files[e.path] = sha256(e.data);
  const sorted = Object.keys(manifest.files).sort();
  manifest.files = Object.fromEntries(sorted.map((k) => [k, manifest.files[k] ?? ""]));
  return entries.map((e) =>
    e.path === "manifest.json" ? { ...e, data: Buffer.from(serializeManifest(manifest)) } : e,
  );
}
