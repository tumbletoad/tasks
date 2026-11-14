// Reading a release archive (A2 3.12.4): a gzipped ustar for Linux and macOS, a zip
// for Windows, on Node built-ins only. The build reads back what it wrote and Node's own archives
// with these readers (scripts/build/archive.ts, which also holds the writers); the updater reads a
// release with them, once its signature and hash are verified, and checks every entry before
// anything is written (checkEntries): the install scripts' rule, in Node.
//
// Neither reader supports more than that needs: no sparse files, no multi-volume archives, no
// encryption. A zip entry's Unix type (a link) comes from its external attributes, so a link in a
// zip is reported as one, never read as a file.
import { gunzipSync, crc32, inflateRawSync } from "node:zlib";
import { MANIFEST_PATH } from "./folder.ts";

export interface ReadEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  mode: number;
  data: Buffer;
}

function cString(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function parseOctal(buf: Buffer, start: number, length: number): number {
  const text = cString(buf, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`bad octal field in tar header: ${text}`);
  return Number.parseInt(text, 8);
}

function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(i, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, i + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    i += length;
  }
  return path;
}

/** Reads a tar stream: ustar, pax path records and GNU long names. */
export function readTar(tar: Buffer): ReadEntry[] {
  const entries: ReadEntry[] = [];
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] ?? 0);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error("tar stream ends inside an entry");
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      nextPath = paxPath(data) ?? nextPath;
      continue;
    }
    if (type === "L") {
      nextPath = cString(data, 0, data.length);
      continue;
    }
    if (type === "g" || type === "K") continue;
    let path = cString(h, 0, 100);
    const magic = cString(h, 257, 6);
    const prefix = magic === "ustar" ? cString(h, 345, 155) : "";
    if (prefix !== "") path = `${prefix}/${path}`;
    if (nextPath !== undefined) path = nextPath;
    nextPath = undefined;
    const kind =
      type === "0" || type === "\0"
        ? "file"
        : type === "5"
          ? "directory"
          : type === "2"
            ? "symlink"
            : "other";
    entries.push({ path: path.replace(/\/$/, ""), type: kind, mode: parseOctal(h, 100, 8), data });
  }
  return entries;
}

export function readTarGz(archive: Buffer): ReadEntry[] {
  return readTar(gunzipSync(archive));
}

const UTF8_NAMES = 0x0800;
/** The high byte of "version made by" that says the external attributes hold a Unix mode. */
const MADE_BY_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function zip64Values(extra: Buffer, wanted: number): bigint[] {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    if (id === 0x0001) {
      const values: bigint[] = [];
      for (let j = 0; j < wanted && 8 * (j + 1) <= size; j++) {
        values.push(extra.readBigUInt64LE(i + 4 + 8 * j));
      }
      return values;
    }
    i += 4 + size;
  }
  return [];
}

/**
 * Reads a zip's central directory and every entry, checking each CRC-32. An entry whose external
 * attributes hold a Unix mode of a link or of anything but a file or folder is reported as that,
 * with its data unread.
 */
export function readZip(zip: Buffer): ReadEntry[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("not a zip: no end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const entries: ReadEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory entry");
    const madeBy = zip.readUInt8(p + 5);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    let compressed = zip.readUInt32LE(p + 20);
    let size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const external = zip.readUInt32LE(p + 38);
    let local = zip.readUInt32LE(p + 42);
    const path = zip.toString(flags & UTF8_NAMES ? "utf8" : "latin1", p + 46, p + 46 + nameLength);
    const extra = zip.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    if (size === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) {
      // The zip64 field holds only the values that overflowed, in this order.
      const wide = zip64Values(extra, 3);
      const next = (): number => Number(wide.shift() ?? 0n);
      if (size === 0xffffffff) size = next();
      if (compressed === 0xffffffff) compressed = next();
      if (local === 0xffffffff) local = next();
    }
    p += 46 + nameLength + extraLength + commentLength;
    const unixType = madeBy === MADE_BY_UNIX ? (external >>> 16) & S_IFMT : 0;
    if (unixType !== 0 && unixType !== S_IFREG && unixType !== S_IFDIR) {
      entries.push({
        path: path.replace(/\/$/, ""),
        type: unixType === S_IFLNK ? "symlink" : "other",
        mode: (external >>> 16) & 0o7777,
        data: Buffer.alloc(0),
      });
      continue;
    }
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad zip local header: ${path}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    if (path.endsWith("/") || unixType === S_IFDIR) {
      entries.push({ path: path.replace(/\/$/, ""), type: "directory", mode: 0o755, data: raw });
      continue;
    }
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip method ${String(method)}: ${path}`);
    if (data.length !== size || crc32(data) !== crc)
      throw new Error(`zip entry is corrupt: ${path}`);
    entries.push({ path, type: "file", mode: 0o644, data });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// The entry check (A2 3.12.4 step 6, the install scripts' rule)

/** A Windows device name, alone or before a dot, in any case. */
const DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i;

/**
 * The install scripts' rule for an archive's entries, checked before anything is unpacked: plain
 * files and folders only (no link, hard link or device), every name of `[A-Za-z0-9._-]` segments
 * without `.` or `..`, each name once; on Windows also no device name, no segment ending in a dot
 * and no two names that differ only in case. A signed archive is authentic; these checks keep even
 * it inside its folder. Returns one message per problem, empty when every entry passes.
 */
export function checkEntries(entries: readonly ReadEntry[], windows: boolean): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const shown = JSON.stringify(entry.path.slice(0, 120));
    if (entry.type !== "file" && entry.type !== "directory") {
      problems.push(`${shown} is a ${entry.type === "symlink" ? "link" : "special entry"}`);
      continue;
    }
    if (!MANIFEST_PATH.test(entry.path)) {
      problems.push(`${shown} is not a name a release holds`);
      continue;
    }
    const segments = entry.path.split("/");
    if (windows && segments.some((s) => DEVICE.test(s) || s.endsWith("."))) {
      problems.push(`${shown} is not a name Windows keeps as it is`);
      continue;
    }
    const key = windows ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) problems.push(`${shown} is in the archive twice`);
    seen.add(key);
  }
  // A file's folders must not be files too: `a` as a file and `a/b` would be ambiguous.
  const files = new Set(
    entries.filter((e) => e.type === "file").map((e) => (windows ? e.path.toLowerCase() : e.path)),
  );
  for (const entry of entries) {
    const parts = (windows ? entry.path.toLowerCase() : entry.path).split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (files.has(parts.slice(0, i).join("/"))) {
        problems.push(`${JSON.stringify(entry.path.slice(0, 120))} is inside a file`);
        break;
      }
    }
  }
  return problems;
}
