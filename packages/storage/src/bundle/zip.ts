// The archive format of export bundles (A1 3.18): ZIP as APPNOTE 6.3 describes it, written and read
// here, so one BundlePolicy bounds both sides and no third-party parser meets untrusted input.
//
// WRITING. Every entry is a regular file, deflated, with a UTF-8 name (flag bit 11), Unix mode
// 0600 and one fixed time. ZIP64 fields appear only where a size, an offset or the entry count
// needs them, so ordinary bundles open in any unzip tool. The local header's CRC and sizes are
// written afterwards at their position, so there is no data descriptor. A name the reader would
// refuse is refused here first.
//
// READING (A1 3.18 "Restore and import of a bundle", step 1). Nothing a header claims is trusted
// to allow anything: a claim can only make the reader refuse sooner.
// - The file is a regular file, the same one before and after it is opened (never a link).
// - One end record, at the very end; one disk; ZIP64 only through its locator; the central
//   directory lies inside the file before the end records, and holds exactly the records the end
//   record counts, at most the policy's entries.
// - Each name is a plain relative path (checkEntryName): no absolute path, drive, `..`, `.`,
//   empty part, backslash, control character, character Windows refuses, trailing dot or space,
//   or device name; NFC, at most 1,024 bytes. No two names fold to the same name (case, NFC), and
//   no file's name is another entry's folder.
// - Each entry is a regular file or a folder: a link, a device, a pipe or a socket in its
//   attributes is refused. No encryption, and only the methods stored and deflate.
// - Each local header repeats its central record's name, method, CRC and sizes (checkLocalFacts),
//   and the entries' data do not overlap one another or the central directory (the
//   overlapping-entry bomb).
// - Extraction (ZipReader.read) counts what it produces while it streams and stops at the first
//   byte past the caller's limit (BUNDLE_LIMIT_EXCEEDED), past the archive's total (the policy's
//   ExpansionBudget) or past the size the entry claims (BUNDLE_INVALID). Then the size and the
//   CRC-32 must be the claimed ones.
// Every refusal is a StorageError with a fixed sentence: never a name, a path or a value.
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw, createInflateRaw, deflateRawSync } from "node:zlib";
import { StorageError } from "../errors.ts";
import { createFileExact, FILE_MODE, fsError, NODE_IO, type FileIo } from "../files.ts";
import { limitExceeded, type BundlePolicy, type ExpansionBudget } from "../backup/policy.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;
const STORED = 0;
const DEFLATE = 8;
/** "Version made by": Unix (3), so the external attributes carry a mode, and APPNOTE 4.5. */
const MADE_BY = (3 << 8) | 45;
/** A regular file, owner-only, in the external attributes' upper half. */
const FILE_ATTRIBUTES = (0o100000 | FILE_MODE) * 0x10000;
/** A local header with ZIP64 sizes from this size on: deflate adds far less than the margin. */
const ZIP64_LOCAL_FROM = 0xffff0000;
const LOCAL_FIXED = 30;
const CENTRAL_FIXED = 46;
const END_FIXED = 22;
const ZIP64_END_FIXED = 56;
const ZIP64_LOCATOR_SIZE = 20;
const MAX_NAME_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
/** The extra field and the comment of one record: more than any tool writes, less than a bomb. */
const MAX_FIELD_BYTES = 4096;
const CHUNK = 1024 * 1024;

export const invalidArchive = (why: string): StorageError =>
  new StorageError("BUNDLE_INVALID", `The archive is not a valid bundle: ${why}`);

// ---------------------------------------------------------------------------------------------
// Names

/** Characters no entry name may hold: controls, the backslash and what Windows refuses in names. */
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"|?*\\]/;
/** Windows device names, with or without an extension. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * Checks that `name` is a plain relative path, and says whether it names a folder (a final `/`).
 * The writer and the reader both call this, so Tasks never writes a name it would refuse.
 */
export function checkEntryName(name: string): { directory: boolean } {
  if (name.length === 0 || Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
    throw invalidArchive("an entry's name is empty or too long");
  }
  if (name !== name.normalize("NFC")) throw invalidArchive("an entry's name is not in NFC");
  const directory = name.endsWith("/");
  const body = directory ? name.slice(0, -1) : name;
  if (body.length === 0 || body.startsWith("/")) {
    throw invalidArchive("an entry's path is absolute");
  }
  for (const part of body.split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw invalidArchive("an entry's path leaves its folder or has an empty part");
    }
    if (FORBIDDEN.test(part) || DEVICE.test(part) || /[. ]$/.test(part)) {
      throw invalidArchive("an entry's name has characters a file name cannot have");
    }
    if (Buffer.byteLength(part, "utf8") > MAX_SEGMENT_BYTES) {
      throw invalidArchive("an entry's name has a part that is too long");
    }
  }
  return { directory };
}

/** The form under which two names would land on one file: NFC, lower case. */
const folded = (name: string): string => name.normalize("NFC").toLowerCase();

// ---------------------------------------------------------------------------------------------
// Streams

/** Counts, hashes (SHA-256 and CRC-32) and bounds what flows through it. */
class Tap extends Transform {
  readonly #sha = createHash("sha256");
  readonly #limit: number;
  readonly #onLimit: () => StorageError;
  readonly #budget: ExpansionBudget | undefined;
  bytes = 0;
  crc = 0;

  constructor(limit: number, onLimit: () => StorageError, budget?: ExpansionBudget) {
    super();
    this.#limit = limit;
    this.#onLimit = onLimit;
    this.#budget = budget;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    // The first byte past a limit stops the stream: the rest is never produced or written.
    if (this.bytes > this.#limit) {
      done(this.#onLimit());
      return;
    }
    try {
      this.#budget?.take(chunk.length);
    } catch (error) {
      done(error as Error);
      return;
    }
    this.#sha.update(chunk);
    this.crc = crc32(chunk, this.crc);
    done(null, chunk);
  }

  sha256(): string {
    return this.#sha.digest("hex");
  }
}

/** A stream of the bytes `start` to `end` of the open file `fd`, read in order. */
function rangeStream(fd: number, start: number, end: number): Readable {
  let position = start;
  return new Readable({
    highWaterMark: CHUNK,
    read() {
      if (position >= end) {
        this.push(null);
        return;
      }
      const want = Math.min(CHUNK, end - position);
      const buffer = Buffer.allocUnsafe(want);
      let read: number;
      try {
        read = readSync(fd, buffer, 0, want, position);
      } catch (error) {
        this.destroy(fsError(error));
        return;
      }
      if (read <= 0) {
        this.destroy(invalidArchive("the file ends inside an entry"));
        return;
      }
      position += read;
      this.push(read === want ? buffer : buffer.subarray(0, read));
    },
  });
}

/** A sink that drops what it gets: for an entry that is verified but not kept. */
const nowhere = (): Writable =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

/** Writes every byte of `data` at `position` of the open file `fd`. */
function writeAt(fd: number, data: Uint8Array, position: number): void {
  let offset = 0;
  while (offset < data.length) {
    let written: number;
    try {
      written = writeSync(fd, data, offset, data.length - offset, position + offset);
    } catch (error) {
      throw fsError(error);
    }
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new StorageError("DURABILITY_FAILED", "A file write made no progress");
    }
    offset += written;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing

/** One entry as written: its uncompressed size and SHA-256, and where its local header is. */
export interface WrittenEntry {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly offset: number;
  readonly zip64Local: boolean;
}

/** MS-DOS time and date of an instant, in UTC so the archive is the same on every machine. */
function dosTime(at: number): { time: number; date: number } {
  const d = new Date(at);
  const year = d.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: (Math.min(year - 1980, 127) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Writes an archive into a new file, one entry at a time. `finish` writes the central directory
 * and the end records, flushes the file and closes it; `abort` only closes it.
 */
export class ZipWriter {
  readonly #fd: number;
  readonly #io: FileIo;
  readonly #time: { time: number; date: number };
  readonly #entries: WrittenEntry[] = [];
  readonly #names = new Set<string>();
  #offset = 0;
  #open = true;

  private constructor(fd: number, at: number, io: FileIo) {
    this.#fd = fd;
    this.#io = io;
    this.#time = dosTime(at);
  }

  /** Creates `path` exclusively and owner-only (files.ts), stamped with the instant `at`. */
  static create(path: string, at: number, io: FileIo = NODE_IO): ZipWriter {
    let fd: number;
    try {
      fd = createFileExact(path, FILE_MODE, io);
    } catch (error) {
      throw fsError(error);
    }
    return new ZipWriter(fd, at, io);
  }

  get entries(): readonly WrittenEntry[] {
    return this.#entries;
  }

  #begin(name: string, zip64Local: boolean): { nameBytes: Buffer; header: Buffer } {
    if (!this.#open) throw new StorageError("STORAGE_MISUSE", "The archive is closed");
    if (checkEntryName(name).directory) {
      throw new StorageError("STORAGE_MISUSE", "A bundle holds files only");
    }
    const key = folded(name);
    if (this.#names.has(key)) throw new StorageError("STORAGE_MISUSE", "A name is written twice");
    this.#names.add(key);
    const nameBytes = Buffer.from(name, "utf8");
    const header = Buffer.alloc(LOCAL_FIXED + nameBytes.length + (zip64Local ? 20 : 0));
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(zip64Local ? 45 : 20, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(this.#time.time, 10);
    header.writeUInt16LE(this.#time.date, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(zip64Local ? 20 : 0, 28);
    nameBytes.copy(header, LOCAL_FIXED);
    if (zip64Local) {
      header.writeUInt16LE(0x0001, LOCAL_FIXED + nameBytes.length);
      header.writeUInt16LE(16, LOCAL_FIXED + nameBytes.length + 2);
    }
    return { nameBytes, header };
  }

  /** Fills in a local header's CRC and sizes, at its position. */
  #complete(entry: WrittenEntry, header: Buffer, nameLength: number): void {
    header.writeUInt32LE(entry.crc32 >>> 0, 14);
    if (entry.zip64Local) {
      header.writeUInt32LE(MAX32, 18);
      header.writeUInt32LE(MAX32, 22);
      header.writeBigUInt64LE(BigInt(entry.size), LOCAL_FIXED + nameLength + 4);
      header.writeBigUInt64LE(BigInt(entry.compressedSize), LOCAL_FIXED + nameLength + 12);
    } else {
      if (entry.size >= MAX32 || entry.compressedSize >= MAX32) {
        throw new StorageError("STORAGE_MISUSE", "An entry grew past its header's sizes");
      }
      header.writeUInt32LE(entry.compressedSize, 18);
      header.writeUInt32LE(entry.size, 22);
    }
    writeAt(this.#fd, header, entry.offset);
  }

  /**
   * Adds the file `source` as `name`, deflated: a path, or the descriptor of a file the caller
   * opened, checked and closes (read from its start). `expectedSize` is its size now: the file must
   * not change while it is read. Stops at the first byte past `limit` (BUNDLE_LIMIT_EXCEEDED).
   * `onChunk` sees every uncompressed chunk (the export's secret scan).
   */
  async addFile(
    name: string,
    source: string | number,
    expectedSize: number,
    limit: number,
    onChunk?: (chunk: Buffer) => void,
  ): Promise<WrittenEntry> {
    const zip64Local = expectedSize >= ZIP64_LOCAL_FROM;
    const { nameBytes, header } = this.#begin(name, zip64Local);
    const offset = this.#offset;
    writeAt(this.#fd, header, offset);
    let position = offset + header.length;
    const raw = new Tap(limit, () => limitExceeded(name === "space.db" ? "space.db" : "a file"));
    const fd = this.#fd;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        try {
          writeAt(fd, chunk, position);
          position += chunk.length;
          done();
        } catch (error) {
          done(error as Error);
        }
      },
    });
    let input: number;
    try {
      input = typeof source === "number" ? source : openSync(source, "r");
    } catch (error) {
      throw fsError(error);
    }
    try {
      const size = fstatSync(input).size;
      if (size !== expectedSize)
        throw new StorageError("BACKUP_FAILED", "A file changed meanwhile");
      const tap = onChunk === undefined ? [] : [observer(onChunk)];
      await pipeline([rangeStream(input, 0, size), raw, ...tap, createDeflateRaw(), sink]);
    } catch (error) {
      throw error instanceof StorageError ? error : fsError(error);
    } finally {
      // A descriptor the caller passed is the caller's to close.
      if (typeof source !== "number") closeSync(input);
    }
    if (raw.bytes !== expectedSize) {
      throw new StorageError("BACKUP_FAILED", "A file changed meanwhile");
    }
    const entry: WrittenEntry = {
      name,
      size: raw.bytes,
      sha256: raw.sha256(),
      compressedSize: position - offset - header.length,
      crc32: raw.crc,
      offset,
      zip64Local,
    };
    this.#complete(entry, header, nameBytes.length);
    this.#offset = position;
    this.#entries.push(entry);
    return entry;
  }

  /** Adds `data` as `name`, deflated. */
  addBytes(name: string, data: Uint8Array): WrittenEntry {
    const zip64Local = data.length >= ZIP64_LOCAL_FROM;
    const { nameBytes, header } = this.#begin(name, zip64Local);
    const packed = deflateRawSync(data);
    const offset = this.#offset;
    const entry: WrittenEntry = {
      name,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      compressedSize: packed.length,
      crc32: crc32(data),
      offset,
      zip64Local,
    };
    writeAt(this.#fd, packed, offset + header.length);
    this.#complete(entry, header, nameBytes.length);
    this.#offset = offset + header.length + packed.length;
    this.#entries.push(entry);
    return entry;
  }

  /** The central directory and the end records, then fsync and close. */
  finish(): void {
    if (!this.#open) throw new StorageError("STORAGE_MISUSE", "The archive is closed");
    const start = this.#offset;
    const parts: Buffer[] = [];
    for (const entry of this.#entries) parts.push(this.#central(entry));
    const directory = Buffer.concat(parts);
    writeAt(this.#fd, directory, start);
    let position = start + directory.length;
    const count = this.#entries.length;
    const zip64 = count >= MAX16 || start >= MAX32 || directory.length >= MAX32;
    if (zip64) {
      const record = Buffer.alloc(ZIP64_END_FIXED + ZIP64_LOCATOR_SIZE);
      record.writeUInt32LE(SIG_ZIP64_END, 0);
      record.writeBigUInt64LE(BigInt(ZIP64_END_FIXED - 12), 4);
      record.writeUInt16LE(MADE_BY, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directory.length), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      record.writeUInt32LE(SIG_ZIP64_LOCATOR, ZIP64_END_FIXED);
      record.writeBigUInt64LE(BigInt(position), ZIP64_END_FIXED + 8);
      record.writeUInt32LE(1, ZIP64_END_FIXED + 16);
      writeAt(this.#fd, record, position);
      position += record.length;
    }
    const end = Buffer.alloc(END_FIXED);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(directory.length, MAX32), 12);
    end.writeUInt32LE(Math.min(start, MAX32), 16);
    writeAt(this.#fd, end, position);
    this.#io.fsyncSync(this.#fd);
    this.#open = false;
    this.#io.closeSync(this.#fd);
  }

  #central(entry: WrittenEntry): Buffer {
    const name = Buffer.from(entry.name, "utf8");
    const bigSize = entry.zip64Local || entry.size >= MAX32;
    const bigPacked = entry.zip64Local || entry.compressedSize >= MAX32;
    const bigOffset = entry.offset >= MAX32;
    const extraLength = (bigSize ? 8 : 0) + (bigPacked ? 8 : 0) + (bigOffset ? 8 : 0);
    const extra = extraLength === 0 ? 0 : 4 + extraLength;
    const record = Buffer.alloc(CENTRAL_FIXED + name.length + extra);
    record.writeUInt32LE(SIG_CENTRAL, 0);
    record.writeUInt16LE(MADE_BY, 4);
    record.writeUInt16LE(extra === 0 ? 20 : 45, 6);
    record.writeUInt16LE(FLAG_UTF8, 8);
    record.writeUInt16LE(DEFLATE, 10);
    record.writeUInt16LE(this.#time.time, 12);
    record.writeUInt16LE(this.#time.date, 14);
    record.writeUInt32LE(entry.crc32 >>> 0, 16);
    record.writeUInt32LE(bigPacked ? MAX32 : entry.compressedSize, 20);
    record.writeUInt32LE(bigSize ? MAX32 : entry.size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(extra, 30);
    record.writeUInt32LE(FILE_ATTRIBUTES, 38);
    record.writeUInt32LE(bigOffset ? MAX32 : entry.offset, 42);
    name.copy(record, CENTRAL_FIXED);
    if (extra > 0) {
      let at = CENTRAL_FIXED + name.length;
      record.writeUInt16LE(0x0001, at);
      record.writeUInt16LE(extraLength, at + 2);
      at += 4;
      // APPNOTE 4.5.3: only the fields whose header value is all ones, in this order.
      if (bigSize) at = record.writeBigUInt64LE(BigInt(entry.size), at);
      if (bigPacked) at = record.writeBigUInt64LE(BigInt(entry.compressedSize), at);
      if (bigOffset) record.writeBigUInt64LE(BigInt(entry.offset), at);
    }
    return record;
  }

  /** Closes the file after a failure. The caller removes it. */
  abort(): void {
    if (!this.#open) return;
    this.#open = false;
    try {
      this.#io.closeSync(this.#fd);
    } catch {
      // On the way out with the first error.
    }
  }
}

/** A pass-through stage that shows each chunk to `see`, which may throw to stop the stream. */
function observer(see: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        see(chunk);
        done(null, chunk);
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Reading

export interface ZipEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly method: number;
  readonly crc32: number;
  /** What the central directory claims. Never trusted to allow: extraction checks it. */
  readonly size: number;
  readonly compressedSize: number;
  readonly localOffset: number;
  /** The entry's compressed bytes in the file. */
  readonly dataStart: number;
  readonly dataEnd: number;
}

/** Reads a little-endian unsigned 64-bit field as a number, refusing one past 2^53. */
function u64(buffer: Buffer, at: number): number {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalidArchive("a size or offset is too large");
  return Number(value);
}

/** Reads exactly `length` bytes at `position`, or refuses an archive that ends first. */
function readExactly(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    let read: number;
    try {
      read = readSync(fd, buffer, done, length - done, position + done);
    } catch (error) {
      throw fsError(error);
    }
    if (read <= 0) throw invalidArchive("the file ends early");
    done += read;
  }
  return buffer;
}

/** The end of the central directory: where it starts, its size and its record count. */
interface Directory {
  start: number;
  size: number;
  count: number;
  /** Where the end records begin: the central directory must end before it. */
  limit: number;
}

function findDirectory(fd: number, fileSize: number): Directory {
  const tailLength = Math.min(fileSize, END_FIXED + MAX16);
  if (tailLength < END_FIXED) throw invalidArchive("the file is too short");
  const tailStart = fileSize - tailLength;
  const tail = readExactly(fd, tailLength, tailStart);
  // The end record whose comment reaches exactly to the end of the file.
  let at = -1;
  for (let i = tailLength - END_FIXED; i >= 0; i -= 1) {
    if (
      tail.readUInt32LE(i) === SIG_END &&
      i + END_FIXED + tail.readUInt16LE(i + 20) === tailLength
    ) {
      at = i;
      break;
    }
  }
  if (at < 0) throw invalidArchive("there is no end record");
  const endPosition = tailStart + at;
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  const onDisk = tail.readUInt16LE(at + 8);
  let count = tail.readUInt16LE(at + 10);
  let size = tail.readUInt32LE(at + 12);
  let start = tail.readUInt32LE(at + 16);
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) {
    throw invalidArchive("it spans several disks");
  }
  let limit = endPosition;
  const locatorPosition = endPosition - ZIP64_LOCATOR_SIZE;
  const locator =
    locatorPosition >= 0 ? readExactly(fd, ZIP64_LOCATOR_SIZE, locatorPosition) : undefined;
  if (locator?.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
    const total = locator.readUInt32LE(16);
    if (locator.readUInt32LE(4) !== 0 || total > 1) throw invalidArchive("it spans several disks");
    const recordPosition = u64(locator, 8);
    if (recordPosition + ZIP64_END_FIXED > locatorPosition) {
      throw invalidArchive("its ZIP64 end record is out of place");
    }
    const record = readExactly(fd, ZIP64_END_FIXED, recordPosition);
    if (record.readUInt32LE(0) !== SIG_ZIP64_END)
      throw invalidArchive("its ZIP64 end record is missing");
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
      throw invalidArchive("it spans several disks");
    }
    const onThisDisk = u64(record, 24);
    count = u64(record, 32);
    size = u64(record, 40);
    start = u64(record, 48);
    if (onThisDisk !== count) throw invalidArchive("it spans several disks");
    limit = recordPosition;
  } else if (count === MAX16 || size === MAX32 || start === MAX32) {
    throw invalidArchive("its ZIP64 end record is missing");
  }
  if (start + size > limit) throw invalidArchive("its central directory is out of place");
  return { start, size, count, limit };
}

/** Reads the central directory through one window at a time, never more than one record ahead. */
class Cursor {
  readonly #fd: number;
  readonly #end: number;
  #window: Buffer = Buffer.alloc(0);
  #windowStart = 0;
  position: number;

  constructor(fd: number, start: number, end: number) {
    this.#fd = fd;
    this.position = start;
    this.#end = end;
  }

  /** The next `length` bytes, which must lie inside the central directory. */
  take(length: number): Buffer {
    if (this.position + length > this.#end) {
      throw invalidArchive("its central directory ends inside a record");
    }
    const offset = this.position - this.#windowStart;
    if (offset < 0 || offset + length > this.#window.length) {
      const size = Math.min(Math.max(CHUNK, length), this.#end - this.position);
      this.#window = readExactly(this.#fd, size, this.position);
      this.#windowStart = this.position;
    }
    const from = this.position - this.#windowStart;
    this.position += length;
    return this.#window.subarray(from, from + length);
  }
}

/** File-type bits of a Unix mode. */
const TYPE_MASK = 0o170000;
const TYPE_FILE = 0o100000;
const TYPE_FOLDER = 0o040000;
/** MS-DOS attribute bits: a folder, and a reparse point (a link or a junction on Windows). */
const DOS_FOLDER = 0x10;
const DOS_REPARSE = 0x400;
/** Hosts whose external attributes carry a Unix mode: Unix and macOS. */
const UNIX_HOSTS = new Set([3, 19]);

/** Refuses anything but a regular file or a folder, by the attributes its host writes. */
function checkType(madeBy: number, external: number, directory: boolean): void {
  const host = madeBy >> 8;
  if (UNIX_HOSTS.has(host)) {
    const type = Math.floor(external / 0x10000) & TYPE_MASK;
    if (type !== 0 && type !== (directory ? TYPE_FOLDER : TYPE_FILE)) {
      throw invalidArchive("an entry is a link or a special file");
    }
  }
  if ((external & DOS_REPARSE) !== 0) throw invalidArchive("an entry is a link or a special file");
  if ((external & DOS_FOLDER) !== 0 && !directory) {
    throw invalidArchive("an entry is a link or a special file");
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeName(bytes: Buffer, flags: number): string {
  if ((flags & FLAG_UTF8) === 0 && bytes.some((b) => b >= 0x80)) {
    throw invalidArchive("an entry's name is not UTF-8");
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw invalidArchive("an entry's name is not UTF-8");
  }
}

/** The ZIP64 values of a central record, for the fields whose 32-bit value is all ones. */
function zip64Values(
  extra: Buffer,
  want: { size: boolean; packed: boolean; offset: boolean; disk: boolean },
): { size?: number; packed?: number; offset?: number } {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (at + 4 + length > extra.length) throw invalidArchive("an extra field is cut short");
    if (id === 0x0001) {
      const field = extra.subarray(at + 4, at + 4 + length);
      const out: { size?: number; packed?: number; offset?: number } = {};
      let p = 0;
      const next = (): number => {
        if (p + 8 > field.length) throw invalidArchive("a ZIP64 field is cut short");
        const value = u64(field, p);
        p += 8;
        return value;
      };
      if (want.size) out.size = next();
      if (want.packed) out.packed = next();
      if (want.offset) out.offset = next();
      if (want.disk && (p + 4 > field.length || field.readUInt32LE(p) !== 0)) {
        throw invalidArchive("it spans several disks");
      }
      return out;
    }
    at += 4 + length;
  }
  if (want.size || want.packed || want.offset || want.disk) {
    throw invalidArchive("a ZIP64 field is missing");
  }
  return {};
}

/**
 * An archive opened for reading, with every structural rule of the header checked. Close it when
 * done. Extraction (read) enforces the size limits while it streams.
 */
export class ZipReader {
  readonly #fd: number;
  readonly entries: readonly ZipEntry[];
  #open = true;

  private constructor(fd: number, entries: readonly ZipEntry[]) {
    this.#fd = fd;
    this.entries = entries;
  }

  /**
   * Opens the archive at `path` and checks its structure against `policy`: the entry count, and
   * the sizes its headers claim against the total. Throws BUNDLE_INVALID or BUNDLE_LIMIT_EXCEEDED.
   */
  static open(path: string, policy: BundlePolicy): ZipReader {
    const before = lookAt(path);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      throw fsError(error);
    }
    try {
      const opened = fstatSync(fd, { bigint: true });
      // The file opened is the regular file that was looked at, not a link put in its place.
      if (!sameId(before, opened) || !sameId(lookAt(path), opened)) {
        throw invalidArchive("the file changed while it was opened");
      }
      const entries = readEntries(fd, Number(opened.size), policy);
      return new ZipReader(fd, entries);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /**
   * Streams `entry`'s content into `sink` (or only verifies it when `sink` is undefined), and
   * returns its size and SHA-256. Stops at the first byte past `limit` (BUNDLE_LIMIT_EXCEEDED,
   * naming `label`), past `budget`, or past the size the entry claims (BUNDLE_INVALID). The CRC-32
   * and size must then be the claimed ones. The caller removes a partial file.
   */
  async read(
    entry: ZipEntry,
    sink: Writable | undefined,
    limit: number,
    label: string,
    budget: ExpansionBudget,
  ): Promise<{ size: number; sha256: string }> {
    if (!this.#open) throw new StorageError("STORAGE_MISUSE", "The archive is closed");
    const bounded = Math.min(limit, entry.size);
    const tap = new Tap(
      bounded,
      () =>
        entry.size < limit
          ? invalidArchive("an entry expands to more than its header says")
          : limitExceeded(label),
      budget,
    );
    const stages: Transform[] = entry.method === DEFLATE ? [createInflateRaw()] : [];
    try {
      await pipeline([
        rangeStream(this.#fd, entry.dataStart, entry.dataEnd),
        ...stages,
        tap,
        sink ?? nowhere(),
      ]);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && code.startsWith("Z_")) {
        throw invalidArchive("an entry does not decompress");
      }
      throw fsError(error);
    }
    if (tap.bytes !== entry.size || tap.crc >>> 0 !== entry.crc32) {
      throw invalidArchive("an entry's content differs from its header");
    }
    return { size: tap.bytes, sha256: tap.sha256() };
  }

  /** An entry's content in memory, at most `limit` bytes. */
  async bytes(
    entry: ZipEntry,
    limit: number,
    label: string,
    budget: ExpansionBudget,
  ): Promise<Buffer> {
    const parts: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        parts.push(chunk);
        done();
      },
    });
    await this.read(entry, sink, limit, label, budget);
    return Buffer.concat(parts);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    try {
      closeSync(this.#fd);
    } catch {
      // Nothing to do: the reader is done with it.
    }
  }
}

function lookAt(path: string): BigIntStats {
  let stats: BigIntStats | undefined;
  try {
    stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    throw fsError(error);
  }
  if (stats === undefined) throw new StorageError("SPACE_NOT_FOUND", "The bundle file is missing");
  if (!stats.isFile()) throw invalidArchive("it is not a regular file");
  return stats;
}

const sameId = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size;

/** A local header's ZIP64 field: both sizes, or undefined when it is missing or cut short. */
function localZip64(extra: Buffer): { size?: number; packed?: number } | undefined {
  try {
    return zip64Values(extra, { size: true, packed: true, offset: false, disk: false });
  } catch {
    return undefined;
  }
}

/** A data descriptor follows the data, and the local header may hold zeros for its CRC and sizes. */
const FLAG_DESCRIPTOR = 0x0008;

/**
 * The local header's CRC and sizes repeat the central record's (APPNOTE 4.4.4, 4.5.3): a reader
 * that trusts the local header, as a streaming unzip tool does, then sees the same archive Tasks
 * checked. Where a size field holds ZIP64's mark, the local ZIP64 field carries both sizes. With a
 * data descriptor (flag bit 3) the three may be zero instead, as streaming writers leave them.
 */
function checkLocalFacts(
  local: Buffer,
  extra: Buffer,
  record: { crc32: number; size: number; compressedSize: number },
): void {
  const crc = local.readUInt32LE(14);
  let packed = local.readUInt32LE(18);
  let size = local.readUInt32LE(22);
  if ((local.readUInt16LE(6) & FLAG_DESCRIPTOR) !== 0 && crc === 0 && packed === 0 && size === 0) {
    return;
  }
  const differs = invalidArchive("a local header differs from its central record");
  if (crc !== record.crc32 >>> 0) throw differs;
  if (packed === MAX32 || size === MAX32) {
    const big = localZip64(extra);
    if (big === undefined) throw differs;
    size = big.size ?? -1;
    packed = big.packed ?? -1;
  }
  if (size !== record.size || packed !== record.compressedSize) throw differs;
}

function readEntries(fd: number, fileSize: number, policy: BundlePolicy): ZipEntry[] {
  const directory = findDirectory(fd, fileSize);
  if (directory.count > policy.maxEntries) throw limitExceeded("the number of entries");
  const cursor = new Cursor(fd, directory.start, directory.start + directory.size);
  const records: Omit<ZipEntry, "dataStart" | "dataEnd">[] = [];
  const names = new Set<string>();
  let claimed = 0;
  while (cursor.position < directory.start + directory.size) {
    if (records.length >= directory.count) {
      throw invalidArchive("its central directory holds more records than it says");
    }
    const fixed = Buffer.from(cursor.take(CENTRAL_FIXED));
    if (fixed.readUInt32LE(0) !== SIG_CENTRAL) throw invalidArchive("a central record is damaged");
    const madeBy = fixed.readUInt16LE(4);
    const needed = fixed.readUInt16LE(6) & 0xff;
    const flags = fixed.readUInt16LE(8);
    const method = fixed.readUInt16LE(10);
    const crc = fixed.readUInt32LE(16);
    let packed = fixed.readUInt32LE(20);
    let size = fixed.readUInt32LE(24);
    const nameLength = fixed.readUInt16LE(28);
    const extraLength = fixed.readUInt16LE(30);
    const commentLength = fixed.readUInt16LE(32);
    const disk = fixed.readUInt16LE(34);
    const external = fixed.readUInt32LE(38);
    let offset = fixed.readUInt32LE(42);
    if (nameLength === 0 || nameLength > MAX_NAME_BYTES) {
      throw invalidArchive("an entry's name is empty or too long");
    }
    if (extraLength > MAX_FIELD_BYTES || commentLength > MAX_FIELD_BYTES) {
      throw invalidArchive("a central record is too large");
    }
    if (needed > 45) throw invalidArchive("an entry needs a newer ZIP reader");
    if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) !== 0) {
      throw invalidArchive("an entry is encrypted");
    }
    if (method !== STORED && method !== DEFLATE) {
      throw invalidArchive("an entry uses a compression method Tasks does not read");
    }
    const name = decodeName(Buffer.from(cursor.take(nameLength)), flags);
    const extra = Buffer.from(cursor.take(extraLength));
    cursor.take(commentLength);
    const big = zip64Values(extra, {
      size: size === MAX32,
      packed: packed === MAX32,
      offset: offset === MAX32,
      disk: disk === MAX16,
    });
    if (disk !== 0 && disk !== MAX16) throw invalidArchive("it spans several disks");
    size = big.size ?? size;
    packed = big.packed ?? packed;
    offset = big.offset ?? offset;
    const { directory: isFolder } = checkEntryName(name);
    checkType(madeBy, external, isFolder);
    if (isFolder && size !== 0) throw invalidArchive("a folder entry has content");
    if (method === STORED && packed !== size) {
      throw invalidArchive("a stored entry's sizes differ");
    }
    const key = folded(isFolder ? name.slice(0, -1) : name);
    if (names.has(key)) throw invalidArchive("two entries have the same name");
    names.add(key);
    claimed += size;
    if (claimed > policy.maxTotalBytes) throw limitExceeded("the total expanded size");
    records.push({
      name,
      directory: isFolder,
      method,
      crc32: crc,
      size,
      compressedSize: packed,
      localOffset: offset,
    });
  }
  if (records.length !== directory.count) {
    throw invalidArchive("its central directory holds fewer records than it says");
  }
  // No file may sit where another entry needs a folder.
  const files = new Set(records.filter((r) => !r.directory).map((r) => folded(r.name)));
  for (const record of records) {
    const parts = record.name.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (files.has(folded(parts.slice(0, i).join("/")))) {
        throw invalidArchive("a file has the name of a folder");
      }
    }
  }
  // Each local header, in file order: its name and method as the central record says, and data
  // that overlaps no other entry's and ends before the central directory.
  const order = [...records].sort((a, b) => a.localOffset - b.localOffset);
  const entries: ZipEntry[] = [];
  let previousEnd = 0;
  for (const record of order) {
    if (record.localOffset < previousEnd) throw invalidArchive("two entries overlap");
    const local = readExactly(fd, LOCAL_FIXED, record.localOffset);
    if (local.readUInt32LE(0) !== SIG_LOCAL) throw invalidArchive("a local header is damaged");
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const localName = local.readUInt16LE(26);
    const localExtra = local.readUInt16LE(28);
    if (localExtra > MAX_FIELD_BYTES) throw invalidArchive("a local header is too large");
    if ((localFlags & FLAG_ENCRYPTED) !== 0 || localMethod !== record.method) {
      throw invalidArchive("a local header differs from its central record");
    }
    const nameBytes = readExactly(fd, localName, record.localOffset + LOCAL_FIXED);
    if (!nameBytes.equals(Buffer.from(record.name, "utf8"))) {
      throw invalidArchive("a local header differs from its central record");
    }
    const extra = readExactly(fd, localExtra, record.localOffset + LOCAL_FIXED + localName);
    checkLocalFacts(local, extra, record);
    const dataStart = record.localOffset + LOCAL_FIXED + localName + localExtra;
    const dataEnd = dataStart + record.compressedSize;
    if (dataEnd > directory.start) throw invalidArchive("an entry overlaps the central directory");
    previousEnd = dataEnd;
    entries.push({ ...record, dataStart, dataEnd });
  }
  return entries;
}
