// Minimal tar, gzip and zip support for the packaging spike, on Node built-ins only.
//
// Writers make the release archives (A2 3.12.4): a gzipped ustar for Linux, a zip for Windows.
// Both are deterministic: entries sorted, a fixed timestamp, no owner names. The tar carries the
// exec bit for the files that need it, so an archive built on Windows still unpacks correctly.
// Readers extract the official Node binary from nodejs.org's archives and let tests read back
// what the writers produced. Neither supports more than the spike needs: no sparse files, no
// multi-volume archives, no encryption.
import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

export interface FileEntry {
  /** Forward-slash path relative to the archive root, without a leading slash. */
  path: string;
  data: Buffer;
  /** POSIX mode bits for the tar header, for example 0o755. Ignored by zip. */
  mode: number;
}

export interface ReadEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  mode: number;
  data: Buffer;
}

export interface WriteOptions {
  /** Modification time of every entry, in seconds since the epoch. */
  mtime?: number;
  /** zlib compression level, 0 (store) to 9. */
  level?: number;
}

/** 2026-01-01T00:00:00Z: the fixed timestamp of every entry, so archives are reproducible. */
export const FIXED_MTIME = 1_767_225_600;

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/+-]+$/;

function checkPath(path: string): void {
  if (!SAFE_PATH.test(path) || path.endsWith("/") || path.includes("//")) {
    throw new Error(`unsafe archive path: ${JSON.stringify(path)}`);
  }
}

function sortedFiles(entries: readonly FileEntry[]): FileEntry[] {
  const seen = new Set<string>();
  for (const e of entries) {
    checkPath(e.path);
    if (seen.has(e.path)) throw new Error(`duplicate archive path: ${e.path}`);
    seen.add(e.path);
  }
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Every parent directory of the given files, sorted, each with a trailing slash. */
function directoriesOf(files: readonly FileEntry[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return [...dirs].sort();
}

// ---------------------------------------------------------------------------------------------
// tar (ustar)

function octal(value: number, width: number): string {
  // width includes the terminating NUL.
  const text = value.toString(8);
  if (text.length > width - 1) throw new Error(`value ${String(value)} does not fit a tar field`);
  return `${text.padStart(width - 1, "0")}\0`;
}

function tarHeader(name: string, type: "0" | "5", mode: number, size: number, mtime: number) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name longer than 100 bytes: ${name}`);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

/** A ustar stream with explicit directory entries, sorted, owned by uid 0 with no names. */
export function writeTar(entries: readonly FileEntry[], options: WriteOptions = {}): Buffer {
  const mtime = options.mtime ?? FIXED_MTIME;
  const files = sortedFiles(entries);
  const chunks: Buffer[] = [];
  for (const dir of directoriesOf(files)) chunks.push(tarHeader(dir, "5", 0o755, 0, mtime));
  for (const f of files) {
    chunks.push(tarHeader(f.path, "0", f.mode, f.data.length, mtime), f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export function writeTarGz(entries: readonly FileEntry[], options: WriteOptions = {}): Buffer {
  return gzipSync(writeTar(entries, options), { level: options.level ?? 9 });
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

// ---------------------------------------------------------------------------------------------
// zip

function dosDateTime(seconds: number): { time: number; date: number } {
  const d = new Date(seconds * 1000);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

const UTF8_NAMES = 0x0800;

/** A zip with deflate (or stored, at level 0) entries and UTF-8 names. No zip64. */
export function writeZip(entries: readonly FileEntry[], options: WriteOptions = {}): Buffer {
  const level = options.level ?? 9;
  const { time, date } = dosDateTime(options.mtime ?? FIXED_MTIME);
  const files = sortedFiles(entries);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const method = level === 0 ? 0 : 8;
    const body = method === 0 ? f.data : deflateRawSync(f.data, { level });
    const crc = crc32(f.data);
    if (body.length >= 0xffffffff || f.data.length >= 0xffffffff || offset >= 0xffffffff) {
      throw new Error("zip64 is not supported by the spike's writer");
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(UTF8_NAMES, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0x20, 38);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuffer, end]);
}

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

/** Reads a zip's central directory and every entry, checking each CRC-32. */
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
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    let compressed = zip.readUInt32LE(p + 20);
    let size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
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
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad zip local header: ${path}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    if (path.endsWith("/")) {
      entries.push({ path: path.slice(0, -1), type: "directory", mode: 0o755, data: raw });
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
