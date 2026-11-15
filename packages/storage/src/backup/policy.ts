// The shared bundle limits of A1 3.18 (DA-17). One BundlePolicy is used by every side that writes
// or reads an archive: the backup writer, the exporter, the restorer and the importer, so Tasks
// never writes an archive it would refuse to read. Limits bound what extraction actually produces,
// counted while streaming, never what a header or a sidecar claims.
//
// A backup is one compressed database (`.db.gz`) beside its sidecar (`.json`): one entry of the
// `space.db` kind and one JSON file. Its limits are the database's and the "any other file" one,
// and its expansion counts against the total and the free disk space.
//
// An export bundle is a ZIP archive (bundle/zip.ts) whose entries each have a kind by their path
// (bundleEntryKind): the database, an attachment, `data.jsonl`, or any other file (`export.json`,
// `space.json`, `view/…`). Each kind has its limit, the entries together the policy's count and
// total (ExpansionBudget), and what a restore unpacks the free disk space.
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  statfsSync,
  type ReadStream,
  type WriteStream,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { StorageError } from "../errors.ts";
import { createFileExact, FILE_MODE, fsError } from "../files.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export interface BundlePolicy {
  /** Entries in one archive. */
  maxEntries: number;
  /** `space.db`, uncompressed. It must also match its sidecar's size and SHA-256. */
  maxDatabaseBytes: number;
  /** One attachment: the space's limit (default 25 MB), at most this. */
  maxAttachmentBytes: number;
  /** `data.jsonl`. */
  maxJsonlBytes: number;
  /** Any other file: `view/` files, JSON, a backup's sidecar. */
  maxOtherFileBytes: number;
  /** Everything an archive expands to. */
  maxTotalBytes: number;
  /** Extraction never leaves less free disk space than this. */
  freeSpaceReserveBytes: number;
}

/** A1 3.18's first values. M3 checks them against the stress corpus (A1 6, open item 5). */
export const BUNDLE_POLICY: Readonly<BundlePolicy> = Object.freeze({
  maxEntries: 1_000_000,
  maxDatabaseBytes: 16 * GIB,
  maxAttachmentBytes: GIB,
  maxJsonlBytes: 16 * GIB,
  maxOtherFileBytes: 64 * MIB,
  maxTotalBytes: 64 * GIB,
  freeSpaceReserveBytes: GIB,
});

/** The refusal for a passed limit. The message names the limit, never a path or a value. */
export const limitExceeded = (limit: string): StorageError =>
  new StorageError("BUNDLE_LIMIT_EXCEEDED", `The archive passes the bundle limit for ${limit}`);

/** Refuses a database larger than the policy allows, before anything is written or extracted. */
export function checkDatabaseSize(bytes: number, policy: BundlePolicy): void {
  if (bytes > policy.maxDatabaseBytes) throw limitExceeded("space.db");
  if (bytes > policy.maxTotalBytes) throw limitExceeded("the total expanded size");
}

/** Free bytes on the file system that holds `folder`, for this user. */
export function freeBytes(folder: string): number {
  try {
    const stats = statfsSync(folder);
    return stats.bavail * stats.bsize;
  } catch (error) {
    throw fsError(error);
  }
}

/**
 * The nearest folder at or above `folder` that exists: where a folder a writer has not made yet
 * will be, for its free disk space.
 */
export function existingFolder(folder: string): string {
  let current = resolve(folder);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

/**
 * Refuses an expansion of `bytes` that would leave less free space than the reserve. Every side
 * that writes or unpacks checks it before it starts, with what it needs at its peak: the backup
 * writer and the exporter for their temporary files (backup.ts, bundle/export.ts), a restore for
 * what it unpacks.
 */
export function checkFreeSpace(bytes: number, free: number, policy: BundlePolicy): void {
  if (bytes > free - policy.freeSpaceReserveBytes) {
    throw limitExceeded("the free disk space");
  }
}

/**
 * What one archive's extraction may still produce: the policy's total, taken chunk by chunk as
 * the entries stream, so the sum of every entry is bounded however their headers lie.
 */
export class ExpansionBudget {
  #left: number;

  constructor(policy: BundlePolicy) {
    this.#left = policy.maxTotalBytes;
  }

  take(bytes: number): void {
    this.#left -= bytes;
    if (this.#left < 0) throw limitExceeded("the total expanded size");
  }
}

/** The kinds of files an export bundle holds, each with its own limit. */
export type BundleEntryKind = "database" | "attachment" | "jsonl" | "other";

/** An attachment's blob: `attachments/sha256/<first two hex>/<hash>` (A1 3.18 "Attachments"). */
export const ATTACHMENT_ENTRY = /^attachments\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

/**
 * The kind of a bundle entry by its path (A1 3.18's layout), or undefined for a path a bundle
 * never holds: an importer refuses those. `view/` holds any relative path below it.
 */
export function bundleEntryKind(name: string): BundleEntryKind | undefined {
  if (name === "space.db") return "database";
  if (name === "data.jsonl") return "jsonl";
  if (name === "export.json" || name === "space.json") return "other";
  const attachment = ATTACHMENT_ENTRY.exec(name);
  if (attachment !== null) {
    return attachment[2]?.startsWith(attachment[1] ?? "-") === true ? "attachment" : undefined;
  }
  if (name.startsWith("view/") && name.length > "view/".length && !name.endsWith("/")) {
    return "other";
  }
  return undefined;
}

/** Whether a folder entry (`name` ends with `/`) is one a bundle's files can sit in. */
export function isBundleFolder(name: string): boolean {
  return (
    name === "attachments/" ||
    name === "attachments/sha256/" ||
    /^attachments\/sha256\/[0-9a-f]{2}\/$/.test(name) ||
    (name.startsWith("view/") && name.endsWith("/"))
  );
}

/** The limit of one file of `kind`. */
export function entryLimit(kind: BundleEntryKind, policy: BundlePolicy): number {
  switch (kind) {
    case "database":
      return policy.maxDatabaseBytes;
    case "attachment":
      return policy.maxAttachmentBytes;
    case "jsonl":
      return policy.maxJsonlBytes;
    case "other":
      return policy.maxOtherFileBytes;
  }
}

/** The name a limit refusal gives for a kind: never the file's own name. */
export const entryLabel = (kind: BundleEntryKind): string =>
  ({ database: "space.db", attachment: "an attachment", jsonl: "data.jsonl", other: "a file" })[
    kind
  ];

/** Size and SHA-256 of a database and of its compressed form. */
export interface Digests {
  size: number;
  sha256: string;
  compressedSize: number;
  compressedSha256: string;
}

/** A pass-through stream that counts and hashes what flows through it. */
class Tap extends Transform {
  readonly #hash = createHash("sha256");
  readonly #limit: number;
  readonly #onLimit: () => StorageError;
  bytes = 0;

  constructor(
    limit = Number.POSITIVE_INFINITY,
    onLimit: () => StorageError = () => limitExceeded("a file"),
  ) {
    super();
    this.#limit = limit;
    this.#onLimit = onLimit;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    // Stop as soon as the limit is passed: the rest is never produced or written.
    if (this.bytes > this.#limit) {
      done(this.#onLimit());
      return;
    }
    this.#hash.update(chunk);
    done(null, chunk);
  }

  digest(): string {
    return this.#hash.digest("hex");
  }
}

/**
 * A stream into the new file `dest`: created exclusively with exactly FILE_MODE (whatever the umask),
 * flushed to disk before it closes. The creation can throw at once (the file exists, say), so it
 * comes before any source stream is opened: a source stream made first would be left with no
 * listener, and its own error (which holds its path) would end the process.
 */
export function newPrivateFile(dest: string): WriteStream {
  const fd = createFileExact(dest, FILE_MODE);
  try {
    return createWriteStream(dest, { fd, flush: true });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** A stream error as a StorageError: its own, or the errno code without the path. */
const streamError = (error: unknown): StorageError =>
  error instanceof StorageError ? error : fsError(error);

const isZlibError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("Z_");
};

/**
 * Runs `source` through `stages` into `sink`, which already exists. pipeline owns every stream from
 * the start: a failure anywhere destroys all of them, the sink's descriptor included, and its error
 * is the one returned. Should the source stream not even be made, the sink is destroyed here.
 * `source` is a path, or the descriptor of a file the caller opened and keeps: read from its start,
 * never closed here, so a reader reads the file it checked even when another file takes the name.
 */
async function pipeInto(
  source: string | number,
  stages: readonly Transform[],
  sink: Writable,
): Promise<void> {
  let input: ReadStream;
  try {
    input =
      typeof source === "number"
        ? createReadStream("", { fd: source, autoClose: false, start: 0 })
        : createReadStream(source);
  } catch (error) {
    sink.destroy();
    throw error;
  }
  await pipeline([input, ...stages, sink]);
}

/**
 * Compresses `source` into the new file `dest` (owner-only, created exclusively, flushed to disk
 * before it closes) and returns the digests of both sides.
 */
export async function compressFile(source: string, dest: string): Promise<Digests> {
  const raw = new Tap();
  const packed = new Tap();
  try {
    await pipeInto(source, [raw, createGzip(), packed], newPrivateFile(dest));
  } catch (error) {
    throw streamError(error);
  }
  return {
    size: raw.bytes,
    sha256: raw.digest(),
    compressedSize: packed.bytes,
    compressedSha256: packed.digest(),
  };
}

export interface InflateLimits {
  /** The policy's limit: passing it is BUNDLE_LIMIT_EXCEEDED. */
  maxBytes: number;
  /** What the sidecar promised: producing more is BACKUP_INVALID. */
  expectedBytes: number;
}

/**
 * Decompresses `source` (a path, or a descriptor the caller holds: pipeInto) into the new file
 * `dest` (owner-only, exclusive, flushed), or only counts and hashes it when `dest` is undefined. It
 * stops as soon as the output passes either limit, so a small archive that expands without end
 * never fills a disk or memory. The caller removes a partial `dest`.
 */
export async function inflateFile(
  source: string | number,
  dest: string | undefined,
  limits: InflateLimits,
): Promise<Digests> {
  const packed = new Tap();
  const hardLimit = Math.min(limits.maxBytes, limits.expectedBytes);
  const raw = new Tap(hardLimit, () =>
    limits.expectedBytes < limits.maxBytes
      ? new StorageError("BACKUP_INVALID", "The backup expands to more than its sidecar records")
      : limitExceeded("space.db"),
  );
  try {
    const sink =
      dest === undefined
        ? new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          })
        : newPrivateFile(dest);
    await pipeInto(source, [packed, createGunzip(), raw], sink);
  } catch (error) {
    // A damaged or truncated archive fails in zlib, whose codes start with Z_ (Z_DATA_ERROR,
    // Z_BUF_ERROR). Its message is dropped like every other native one.
    if (isZlibError(error)) {
      throw new StorageError("BACKUP_INVALID", "The backup does not decompress");
    }
    throw streamError(error);
  }
  return {
    size: raw.bytes,
    sha256: raw.digest(),
    compressedSize: packed.bytes,
    compressedSha256: packed.digest(),
  };
}
