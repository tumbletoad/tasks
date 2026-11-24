// A version folder and its manifest.json (A2 3.12.2): the build writes them (M1.13), and doctor's
// integrity check (A2 3.13), install and update (M1.14, M6) check them. This module owns the format,
// so the writer and every checker agree on it.
//
// manifest.json names the build (version, build, platform, the Node and SQLite it ships, the
// protocol range, whether its service notes that it was seen working) and the SHA-256 of every
// other file in the folder. Its `files` map holds one entry
// per line, `    "<path>": "<hex>",`, sorted, so the POSIX install script can read it with sed.
// A path holds only `[A-Za-z0-9._-]` segments joined by `/`: no `.` or `..` segment, no leading
// slash, nothing an install script would have to quote.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PRODUCT_ID } from "@ttasks/brand";
import { createFile } from "../hub/files.ts";
import { HOME_MARKER } from "../hub/paths.ts";

export const MANIFEST_FILE = "manifest.json";

/** The manifest's format. A later format gets a new number, so an old checker refuses it. */
export const MANIFEST_FORMAT = 1;

export interface VersionManifest {
  readonly format: typeof MANIFEST_FORMAT;
  /** The product (`ttasks`). */
  readonly name: string;
  readonly version: string;
  readonly build: string;
  /** `linux-x64`, `linux-arm64`, `win-x64` or `darwin-arm64` (A2 3.12.1). */
  readonly platform: string;
  /** The Node and SQLite versions the runtime gate expects (A2 3.12.1). */
  readonly node: string;
  readonly sqlite: string;
  /** ttasks-local/1's protocol range of this build's service (A2 3.6.6). */
  readonly protocol: { readonly min: number; readonly max: number };
  /**
   * This build's service notes in install.json's `seen_working` when it is ready, so a version
   * without that note never ran (switch.ts). Absent in a build from before the note, which cannot
   * say, and an older checker ignores it.
   */
  readonly notes_seen_working?: true;
  /** Every other file of the folder: relative path to lowercase hex SHA-256. */
  readonly files: Readonly<Record<string, string>>;
}

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

/** A path the manifest may list. */
export const MANIFEST_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A map from path to digest without a prototype, so a file named `__proto__`, `constructor` or
 * `toString` is a key like any other: never swallowed by an assignment, never found by a lookup
 * it does not own. Every `files` map this module makes is one, and is read with Object.hasOwn.
 */
const fileMap = (): Record<string, string> => Object.create(null) as Record<string, string>;

/** The text of manifest.json: two-space JSON, fixed field order, sorted files, a final newline. */
export function serializeManifest(manifest: VersionManifest): string {
  const files = fileMap();
  for (const path of Object.keys(manifest.files).sort()) files[path] = manifest.files[path] ?? "";
  const ordered: VersionManifest = {
    format: manifest.format,
    name: manifest.name,
    version: manifest.version,
    build: manifest.build,
    platform: manifest.platform,
    node: manifest.node,
    sqlite: manifest.sqlite,
    protocol: { min: manifest.protocol.min, max: manifest.protocol.max },
    ...(manifest.notes_seen_working === true ? { notes_seen_working: true } : {}),
    files,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Parses manifest.json strictly. Throws ManifestError naming the first problem. */
export function parseManifest(text: string): VersionManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ManifestError("manifest.json is not JSON");
  }
  if (!isRecord(json)) throw new ManifestError("manifest.json is not an object");
  const { format, name, version, build, platform, node, sqlite, protocol, files } = json;
  if (format !== MANIFEST_FORMAT) throw new ManifestError("manifest.json has an unknown format");
  if (name !== PRODUCT_ID) throw new ManifestError("manifest.json names another product");
  for (const [field, value] of Object.entries({ version, build, platform, node, sqlite })) {
    if (typeof value !== "string" || !LABEL.test(value)) {
      throw new ManifestError(`manifest.json has no valid ${field}`);
    }
  }
  if (
    !isRecord(protocol) ||
    !Number.isSafeInteger(protocol["min"]) ||
    !Number.isSafeInteger(protocol["max"])
  ) {
    throw new ManifestError("manifest.json has no valid protocol range");
  }
  if (!isRecord(files)) throw new ManifestError("manifest.json has no file list");
  const listed = fileMap();
  for (const [path, digest] of Object.entries(files)) {
    if (!MANIFEST_PATH.test(path) || path === MANIFEST_FILE) {
      throw new ManifestError("manifest.json lists a path it may not list");
    }
    if (typeof digest !== "string" || !HEX64.test(digest)) {
      throw new ManifestError("manifest.json lists a file without a SHA-256");
    }
    listed[path] = digest;
  }
  return {
    format: MANIFEST_FORMAT,
    name: PRODUCT_ID,
    version: version as string,
    build: build as string,
    platform: platform as string,
    node: node as string,
    sqlite: sqlite as string,
    protocol: { min: protocol["min"] as number, max: protocol["max"] as number },
    ...(json["notes_seen_working"] === true ? { notes_seen_working: true as const } : {}),
    files: listed,
  };
}

/** Reads and parses `<folder>/manifest.json`. Throws ManifestError when it is missing or invalid. */
export function readVersionManifest(folder: string): VersionManifest {
  let text: string;
  try {
    text = readFileSync(join(folder, MANIFEST_FILE), "utf8");
  } catch {
    throw new ManifestError("manifest.json cannot be read");
  }
  return parseManifest(text);
}

/** The SHA-256 of a file, read in 1 MiB steps so a large runtime never sits in memory whole. */
export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export interface FolderListing {
  /** Every regular file, as a sorted forward-slash path relative to the folder. */
  readonly files: string[];
  /** One message per entry that is no plain file or folder: a link, a junction, a device. */
  readonly problems: string[];
}

/** Lists a folder without following links: a link anywhere below it is a problem, never a file. */
export function listFolder(folder: string): FolderListing {
  const files: string[] = [];
  const problems: string[] = [];
  const walk = (rel: string): void => {
    const entries = readdirSync(rel === "" ? folder : join(folder, ...rel.split("/")), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) problems.push(`linked: ${path}`);
      else if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else problems.push(`not a file: ${path}`);
    }
  };
  walk("");
  files.sort();
  problems.sort();
  return { files, problems };
}

/** What a build says of itself; the writer adds the rest, this build's `notes_seen_working` too. */
export type ManifestFields = Omit<
  VersionManifest,
  "format" | "name" | "notes_seen_working" | "files"
>;

/**
 * Hashes every file of `folder` and writes its manifest.json. The folder must hold no link and no
 * path the manifest cannot list. Returns the manifest written.
 */
export function writeVersionManifest(folder: string, fields: ManifestFields): VersionManifest {
  const listing = listFolder(folder);
  if (listing.problems.length > 0) throw new ManifestError(listing.problems.join("; "));
  const files = fileMap();
  for (const path of listing.files) {
    if (path === MANIFEST_FILE) throw new ManifestError("the folder already has a manifest.json");
    if (!MANIFEST_PATH.test(path))
      throw new ManifestError(`a path the manifest cannot list: ${path}`);
    files[path] = sha256File(join(folder, ...path.split("/")));
  }
  const manifest: VersionManifest = {
    format: MANIFEST_FORMAT,
    name: PRODUCT_ID,
    ...fields,
    protocol: { min: fields.protocol.min, max: fields.protocol.max },
    notes_seen_working: true,
    files,
  };
  // Checked by the same parser every reader uses, so the build never writes what they refuse.
  const text = serializeManifest(manifest);
  parseManifest(text);
  // Every file of a version folder is 0644 or 0755 (the build sets them; the archive carries
  // them), and so is this one, whatever the umask.
  const fd = createFile(join(folder, MANIFEST_FILE), 0o644);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return manifest;
}

/**
 * Checks a version folder against its manifest.json: every listed file present and unchanged,
 * nothing else in the folder, no link anywhere. Returns one message per problem, sorted.
 */
export function checkVersionFolder(folder: string): string[] {
  let manifest: VersionManifest;
  try {
    manifest = readVersionManifest(folder);
  } catch (error) {
    return [error instanceof ManifestError ? error.message : "manifest.json cannot be read"];
  }
  const listing = listFolder(folder);
  const problems = [...listing.problems];
  const present = new Set(listing.files);
  for (const path of listing.files) {
    if (path !== MANIFEST_FILE && !Object.hasOwn(manifest.files, path)) {
      problems.push(`not in manifest.json: ${path}`);
    }
  }
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (!present.has(path)) problems.push(`missing: ${path}`);
    else if (sha256File(join(folder, ...path.split("/"))) !== digest) {
      problems.push(`changed: ${path}`);
    }
  }
  return problems.sort();
}

/**
 * A2 3.12.3's rule for a version name in `current`: 1 to 64 characters from `[0-9A-Za-z.+-]`,
 * starting and ending with a letter or digit, no `..`, no Windows device name (A2 3.12.3).
 */
export function isVersionName(value: string): boolean {
  if (!/^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,62}[0-9A-Za-z])?$/.test(value)) return false;
  if (value.includes("..")) return false;
  return !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(value);
}

/** Whether `root` is `<base>/share/ttasks`, the daily install's root (any letter case, as on Windows). */
const isDailyRoot = (root: string): boolean =>
  basename(root).toLowerCase() === PRODUCT_ID && basename(dirname(root)).toLowerCase() === "share";

/**
 * The install around a version folder, checked as doctor's integrity row asks (A2 3.13): when the
 * folder sits in `<root>/versions/`, `current` (if there is one) must name an installed version,
 * and on Windows, once the command folder exists, both stable launchers must be in it: `<root>\bin`
 * of a TTASKS_HOME install (it holds home.marker), else `~\.local\bin` beside `share` when the root
 * is `share\ttasks`. An update journal is doctor's `update` row (M6.12): during an update the
 * candidate's own self-test runs beside it. Returns one message per problem. `launchers: false`
 * leaves the stable launchers out: `install --finish` puts them in place itself, after its check.
 */
export function checkInstallAround(
  versionFolder: string,
  platform: NodeJS.Platform,
  options: { readonly launchers?: boolean } = {},
): string[] {
  const versions = dirname(versionFolder);
  if (basename(versions) !== "versions") return [];
  const root = dirname(versions);
  const problems: string[] = [];
  const current = join(root, "current");
  let named: string | undefined;
  try {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(current).replaceAll("\\", "/");
      named = target.startsWith("versions/") ? target.slice("versions/".length) : undefined;
    } else if (stat.isFile()) {
      named = readFileSync(current, "utf8");
    }
    if (named === undefined || !isVersionName(named)) {
      problems.push("current does not name a version");
    } else if (!existsSync(join(versions, named, MANIFEST_FILE))) {
      problems.push(`current names ${named}, which is not installed`);
    }
  } catch (error) {
    // No current is a fresh install's candidate, or a version folder outside an install. A current
    // that is there but cannot be read is a problem: the stable launchers cannot dispatch through it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push("current cannot be read");
    }
  }
  // The command folder, by the Windows launchers' rule: <root>\bin of a TTASKS_HOME install, else
  // the bin beside share when the root is share\ttasks (~\.local\bin for ~\.local\share\ttasks). Any
  // other root has none: no stable launcher dispatches into it.
  const bin = existsSync(join(root, HOME_MARKER))
    ? join(root, "bin")
    : isDailyRoot(root)
      ? join(dirname(dirname(root)), "bin")
      : undefined;
  if (options.launchers !== false && platform === "win32" && bin !== undefined && existsSync(bin)) {
    for (const launcher of [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`]) {
      if (!existsSync(join(bin, launcher))) {
        problems.push(`missing stable launcher: bin/${launcher}`);
      }
    }
  }
  return problems;
}
