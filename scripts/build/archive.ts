// The release archives (A2 3.12.4) on Node built-ins only, promoted from the M0.03 spike
// (A2 3.12.4): a gzipped ustar for Linux and macOS, a zip for Windows.
//
// Both writers are deterministic, so the same version folder always gives the same bytes: entries
// sorted, one fixed timestamp, uid and gid 0 with no owner names, explicit modes (the exec bit on
// the launchers and the runtime, so an archive written on Windows still unpacks runnable), and the
// gzip header's OS byte fixed to Unix, which zlib would otherwise set from the machine that writes.
// The readers are the product's (packages/service/src/version/archive.ts), whose updater unpacks a
// release with them: the build uses them to extract the official Node binary from nodejs.org's
// archives and to read back what it wrote. No zip64 when writing.
import { crc32, deflateRawSync, gzipSync } from "node:zlib";

export {
  readTar,
  readTarGz,
  readZip,
  type ReadEntry,
} from "../../packages/service/src/version/archive.ts";

export interface FileEntry {
  /** Forward-slash path relative to the archive root, without a leading slash. */
  readonly path: string;
  readonly data: Buffer;
  /** POSIX mode bits for the tar header, 0o755 or 0o644. Zip keeps none. */
  readonly mode: number;
}

export interface WriteOptions {
  /** Modification time of every entry, in seconds since the epoch. */
  readonly mtime?: number;
  /** zlib compression level, 0 (store) to 9. */
  readonly level?: number;
}

/** 2026-01-01T00:00:00Z: the timestamp of every entry, so archives are reproducible. */
export const FIXED_MTIME = 1_767_225_600;

/** gzip's OS byte for Unix (RFC 1952 2.3.1). */
const GZIP_OS_UNIX = 3;

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/+-]+$/;

function checkPath(path: string): void {
  if (!SAFE_PATH.test(path) || path.endsWith("/") || path.includes("//")) {
    throw new Error(`unsafe archive path: ${JSON.stringify(path)}`);
  }
}

function checkMode(entry: FileEntry): void {
  if (entry.mode !== 0o755 && entry.mode !== 0o644) {
    throw new Error(`unexpected mode ${entry.mode.toString(8)} for ${entry.path}`);
  }
}

function sortedFiles(entries: readonly FileEntry[]): FileEntry[] {
  const seen = new Set<string>();
  for (const e of entries) {
    checkPath(e.path);
    checkMode(e);
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

/** A gzipped ustar. The gzip header carries no time and names Unix as its OS. */
export function writeTarGz(entries: readonly FileEntry[], options: WriteOptions = {}): Buffer {
  const gz = gzipSync(writeTar(entries, options), { level: options.level ?? 9 });
  // Bytes 4 to 7 are MTIME (zlib writes 0), byte 9 is OS. The CRC covers the data, not the header.
  gz.writeUInt32LE(0, 4);
  gz[9] = GZIP_OS_UNIX;
  return gz;
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
      throw new Error("zip64 is not supported by this writer");
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
