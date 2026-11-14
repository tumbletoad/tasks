// Managed targets (A3 3.12): a file another tool generates or keeps, which setup must not edit,
// because the next reinstall or checkout would overwrite the change, or the change would land in
// that tool's source. Rules 1 (a link) and 2 (a "generated" mark near the top) are judged where the
// file is read (agents.ts). This file holds the other two:
//
//   3. A git repository other than the home tracks the file.
//   4. machine.toml lists it, or a folder above it, under `[setup.managed] paths`.
//
// Git is read from its files, never started (A1 3.15): the work tree is the nearest
// folder above the file with a `.git` folder or file, and "tracks" means the work tree's index has
// an entry for the file. A repository at the home itself, or inside it, is the person's own record
// of that home, not another tool's. The index is read only when every byte adds up: its trailing
// checksum (which also tells SHA-1 from SHA-256 names), its entries, its extensions. Whatever
// cannot be read for certain (a split index, an index over the bound, a damaged one) counts as
// tracked: the safe side for a write is to make none.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { posix, win32 } from "node:path";

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Paths compare without case on Windows and macOS, as their file systems do by default. */
const fold = (platform: NodeJS.Platform, path: string): string =>
  platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;

/** Whether `inner` is `outer` or lies inside it. */
export function within(platform: NodeJS.Platform, outer: string, inner: string): boolean {
  const p = pathOf(platform);
  const rel = p.relative(fold(platform, p.resolve(outer)), fold(platform, p.resolve(inner)));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** Rule 4: the file, or a folder above it, is listed under `[setup.managed] paths`. */
export function listedAsManaged(
  platform: NodeJS.Platform,
  file: string,
  paths: readonly string[],
): boolean {
  return paths.some((listed) => within(platform, listed, file));
}

/** How far up the folders the search for a work tree goes. */
const MAX_LEVELS = 64;
/** An index past this size is not read: it counts as tracking the file. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

const exists = (path: string): "dir" | "file" | undefined => {
  try {
    const s = lstatSync(path);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
};

/** A small text file of git's (`.git` as a file, `commondir`, `config`), or undefined. */
function smallText(path: string): string | undefined {
  try {
    const bytes = readFileSync(path);
    return bytes.length > 64 * 1024 ? undefined : bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * The bytes of a file up to `max`. Undefined only when the file is not there; "unknown" when it is
 * there but cannot be read for certain: past the bound, not a regular file, no access, locked.
 */
function boundedBytes(path: string, max: number): Buffer | undefined | "unknown" {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unknown";
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return "unknown";
    const size = stat.size;
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } catch {
    return "unknown";
  } finally {
    closeSync(fd);
  }
}

class Unreadable extends Error {}

type HashBytes = 20 | 32;

/**
 * The object format git's config names (`[extensions] objectFormat`), read with git's own syntax:
 * section and key in any case, the value quoted or not, a `#` or `;` comment after it, the last
 * one winning. Undefined when it names none or one this reader does not know.
 */
export function configuredFormat(config: string): HashBytes | undefined {
  let section = "";
  let value: string | undefined;
  for (const raw of config.split(/\r?\n/u)) {
    let line = raw.trim();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/u.exec(line);
    if (header !== null) {
      section = (header[1] ?? "").toLowerCase();
      line = line.slice(header[0].length).trim();
    }
    if (section !== "extensions") continue;
    const entry = /^objectformat\s*=\s*(.*)$/iu.exec(line);
    if (entry === null) continue;
    // The value up to a comment outside quotes, without its quotes.
    let text = "";
    let quoted = false;
    for (const c of entry[1] ?? "") {
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === "#" || c === ";")) break;
      else text += c;
    }
    value = text.trim().toLowerCase();
  }
  return value === "sha256" ? 32 : value === "sha1" || value === undefined ? 20 : undefined;
}

/**
 * The size of the object names in an index, from its trailing checksum: SHA-1 or SHA-256 of every
 * byte before it. An index written without one (git's `index.skipHash`) ends in zeros: the
 * repository's configured format then decides. Anything else is a damaged index: Unreadable.
 */
export function indexHashBytes(index: Buffer, configured: HashBytes | undefined): HashBytes {
  for (const [bytes, algorithm] of [
    [20, "sha1"],
    [32, "sha256"],
  ] as const) {
    if (index.length < 12 + bytes) continue;
    const body = index.subarray(0, index.length - bytes);
    const trailer = index.subarray(index.length - bytes);
    if (createHash(algorithm).update(body).digest().equals(trailer)) return bytes;
  }
  if (
    configured !== undefined &&
    index.length >= 12 + configured &&
    index.subarray(index.length - configured).every((b) => b === 0)
  ) {
    return configured;
  }
  throw new Unreadable();
}

/**
 * The paths an index lists (`/`-separated, relative to the work tree), and the folders a sparse
 * index keeps as one entry (ending in `/`). Versions 2, 3 and 4; SHA-1 or SHA-256 object names.
 * Every byte must add up: the entries, then whole extensions up to the trailing checksum. A split
 * index (`link` extension) keeps entries in another file: Unreadable.
 */
export function indexPaths(index: Buffer, hashBytes: HashBytes): string[] {
  if (index.length < 12 || index.toString("latin1", 0, 4) !== "DIRC") throw new Unreadable();
  const version = index.readUInt32BE(4);
  if (version < 2 || version > 4) throw new Unreadable();
  const count = index.readUInt32BE(8);
  const end = index.length - hashBytes;
  if (end < 12) throw new Unreadable();
  const paths: string[] = [];
  let at = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let n = 0; n < count; n += 1) {
    const start = at;
    at += 40 + hashBytes;
    if (at + 2 > end) throw new Unreadable();
    const flags = index.readUInt16BE(at);
    at += 2;
    if ((flags & 0x4000) !== 0) {
      if (version < 3) throw new Unreadable();
      at += 2;
    }
    let name: Buffer;
    if (version === 4) {
      // The number of bytes to drop from the end of the previous name, then the rest of this one.
      let c = index[at] ?? 0;
      at += 1;
      let drop = c & 0x7f;
      while ((c & 0x80) !== 0) {
        if (at >= end) throw new Unreadable();
        c = index[at] ?? 0;
        at += 1;
        drop = ((drop + 1) << 7) + (c & 0x7f);
      }
      const nul = index.indexOf(0, at);
      if (nul === -1 || nul >= end || drop > previous.length) throw new Unreadable();
      name = Buffer.concat([previous.subarray(0, previous.length - drop), index.subarray(at, nul)]);
      at = nul + 1;
    } else {
      const nul = index.indexOf(0, at);
      if (nul === -1 || nul >= end) throw new Unreadable();
      name = index.subarray(at, nul);
      // Padded with NULs to a multiple of eight bytes from the entry's start.
      const length = nul - start;
      at = start + (Math.floor(length / 8) + 1) * 8;
    }
    if (at > end) throw new Unreadable();
    previous = name;
    paths.push(name.toString("utf8"));
  }
  // Extensions, each whole, ending exactly at the trailing checksum.
  while (at < end) {
    if (at + 8 > end) throw new Unreadable();
    const signature = index.toString("latin1", at, at + 4);
    const size = index.readUInt32BE(at + 4);
    if (signature === "link") throw new Unreadable();
    at += 8 + size;
  }
  if (at !== end) throw new Unreadable();
  return paths;
}

/** Whether the repository whose work tree is `top` tracks `file` (inside `top`). */
function tracks(platform: NodeJS.Platform, top: string, file: string): boolean {
  const p = pathOf(platform);
  const dotGit = p.join(top, ".git");
  let gitDir: string;
  if (exists(dotGit) === "dir") gitDir = dotGit;
  else {
    const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(smallText(dotGit) ?? "")?.[1];
    if (pointer === undefined) return true;
    gitDir = p.resolve(top, pointer);
  }
  const commonDir = smallText(p.join(gitDir, "commondir"))?.trim();
  const common =
    commonDir === undefined || commonDir === "" ? gitDir : p.resolve(gitDir, commonDir);
  const index = boundedBytes(p.join(gitDir, "index"), MAX_INDEX_BYTES);
  // No index yet: a repository where nothing was ever added tracks nothing. An index that is there
  // but cannot be read (past the bound, no access, locked) is no proof either way.
  if (index === undefined) return false;
  if (index === "unknown") return true;
  let paths: string[];
  try {
    const configured = configuredFormat(smallText(p.join(common, "config")) ?? "");
    paths = indexPaths(index, indexHashBytes(index, configured));
  } catch (error) {
    if (error instanceof Unreadable || error instanceof RangeError) return true;
    throw error;
  }
  const rel = fold(platform, p.relative(top, file).split(p.sep).join("/"));
  return paths.some((path) => {
    const entry = fold(platform, path);
    return entry === rel || (entry.endsWith("/") && rel.startsWith(entry));
  });
}

/**
 * Rule 3: a git repository other than the home tracks `file`. The nearest work tree above the file
 * decides; one at the home or inside it is the home's own.
 */
export function trackedByAnotherRepository(
  platform: NodeJS.Platform,
  file: string,
  home: string,
): boolean {
  const p = pathOf(platform);
  let dir = p.dirname(p.resolve(file));
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    if (exists(p.join(dir, ".git")) !== undefined) {
      return within(platform, home, dir) ? false : tracks(platform, dir, file);
    }
    const up = p.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}
