// Export bundles (A1 3.18, `tasks space export --mode backup|fork|transfer`): a ZIP archive that
// holds a consistent snapshot of the space with everything needed to restore or import it, and
// reads without the app.
//
//   export.json      what the bundle is (export-file.ts), with every other file's size and SHA-256
//   space.json       the snapshot's manifest
//   space.db         the snapshot, as for a backup, vacuumed
//   attachments/…    exactly the blobs the snapshot's live attachment rows name
//   data.jsonl       with `withJsonl`: every table, one record per line (jsonl.ts)
//   view/…           the projection, once M3.10 renders it from the snapshot
//
// 0. Before anything is written, on the space's own read-only connection: the revision is one this
//    build knows and not newer, the database has exactly its revision's tables, indexes and views
//    (backup/snapshot.ts requireOwnSchema, the rule a restore applies: SPACE_SCHEMA_FOREIGN), and
//    the free disk space, less the policy's reserve, holds the export's peak without data.jsonl
//    (exportPeak). So an export that a restore would refuse, or that could fill the disk, writes
//    nothing. data.jsonl, whose size is not known before, may hold half of what is left
//    (jsonlBudget), counted as it is written: past that, BUNDLE_LIMIT_EXCEEDED.
// 1. The connection copies the database in one backup step into a private work folder
//    `.export.tmp-<random>` in the exports folder (A1 3.1: `<space>/exports`), and closes. The copy
//    loses the objects the exact-schema rule drops (triggers, SQLite's statistics tables), gets its
//    search index made again from its tasks, is vacuumed, so it carries no bytes of deleted rows,
//    and is checked (integrity_check and the facts, as a backup's).
// 2. The secret scan (A6 3.16.4): every text value of the product's tables, by the product's own
//    table and column names (snapshot.ts productTables), never a name read out of the database. A
//    hit is a warning on the record (ExportRecord.secrets): its kind and the table and column,
//    never the text. It does not stop the export: history keeps text that nothing can remove, so a
//    refusal would keep one pasted token from ever leaving with its own space.
// 3. Every file is checked against its kind's limit, and the files together against the count and
//    the total (the shared BundlePolicy), before the archive is written.
// 4. The archive is written in the work folder and flushed. Each attachment is read through the
//    descriptor that was checked: the regular file of its row under the space's own `attachments/`,
//    reached through no link, of the row's size, in no secrets folder, its bytes scanned for secrets
//    (a warning, as the rows') and hashed to the row's hash while they are written.
// 5. A trial restore of the archive, the restore's own steps (restore/restore.ts restoreCopy) in
//    the work folder: Tasks never publishes a bundle its restore would refuse.
// 6. Publication: the archive takes its name `<mode>-<utc>-e<epoch>-s<seq>.zip` in the exports
//    folder by a hard link or an exclusive create (files.ts publishExclusive), never by a rename,
//    so nothing there is ever replaced, and the folder is synced. That is the one publication
//    point: any failure before it leaves no file under the bundle's name.
// The work folder is removed by its full name at the end, whatever happened.
//
// Modes. `backup` and `fork` write the same bundle with their mode in export.json: a fork bundle
// carries the source's identity, and the import makes it a new space (M3.08). `transfer` carries
// the caller's transfer statement; its states, its signing and its import are M3.08's, which build
// on this function and on readBundle. The exporter only reads the space: no mode changes it.
import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Connection } from "../driver.ts";
import { misuse, StorageError } from "../errors.ts";
import {
  closeQuietly,
  FOLDER_MODE,
  fsCall,
  fsError,
  fsyncFolder,
  errnoCode,
  makeDirExact,
  NODE_IO,
  publishExclusive,
  removeQuietly,
  temporaryTag,
  type FileIo,
} from "../files.ts";
import {
  DATABASE_FILE,
  isAppVersion,
  MANIFEST_FILE,
  manifestFor,
  manifestText,
} from "../manifest.ts";
import { stepPosition } from "../migrate/steps.ts";
import { openReader, openWriter } from "../open.ts";
import { inRange } from "../rows.ts";
import type { SchemaStep } from "../schema.ts";
import { findSecret, SECRET_OVERLAP, type SecretKind } from "../secrets.ts";
import { openSpaceWith, SOURCE_APP_VERSION } from "../space.ts";
import { checkSpacePath } from "../space-path.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { makeDurableFolder } from "../backup/backup.ts";
import {
  BUNDLE_POLICY,
  bundleEntryKind,
  checkFreeSpace,
  entryLabel,
  entryLimit,
  existingFolder,
  freeBytes,
  limitExceeded,
  type BundlePolicy,
} from "../backup/policy.ts";
import { utcStamp } from "../backup/sidecar.ts";
import {
  checkSnapshot,
  copySnapshot,
  databaseBytes,
  productTables,
  requireOwnSchema,
  schemaObjects,
  type ProductTable,
  type SnapshotFacts,
} from "../backup/snapshot.ts";
import { prepareCopy } from "../restore/mark.ts";
import { restoreCopy } from "../restore/restore.ts";
import { inFolder } from "../restore/unpack.ts";
import {
  EXPORT_FILE,
  EXPORT_MARKER,
  EXPORT_MODES,
  EXPORT_VERSION,
  exportText,
  type ExportManifest,
  type ExportMode,
  type FileDigest,
  type TransferStatement,
} from "./export-file.ts";
import { scanText, writeJsonl } from "./jsonl.ts";
import { ZipWriter } from "./zip.ts";

/** The exports folder of a space (A1 3.1): the bundles the person asked for. */
export const EXPORTS_FOLDER = "exports";
/** The prefix of an export's private work folder, before its random tag. */
export const EXPORT_TEMP_PREFIX = ".export.tmp-";
/** The optional rows file. */
export const JSONL_FILE = "data.jsonl";

export interface ExportOptions {
  mode: ExportMode;
  /** Where the bundle goes. Default: `<space>/exports`. */
  exportDir?: string;
  /** Add `data.jsonl`, every table as JSON lines, for other tools. */
  withJsonl?: boolean;
  /** A transfer bundle's statement: required for `transfer`, refused otherwise (M3.08 signs it). */
  statement?: TransferStatement;
  /** Folders no file of the bundle may come from: the secrets folder (A6 3.16.4). */
  secretFolders?: readonly string[];
  appVersion?: string;
  /** Milliseconds since 1970. Default: Date.now. */
  now?: () => number;
  busyTimeoutMs?: number;
}

/** A secret-shaped string the bundle holds: its kind and where, never the text. */
export interface SecretFinding {
  kind: SecretKind;
  /** `<table>.<column>` by the product's own names, or `an attachment`. */
  place: string;
}

/** A published bundle. */
export interface ExportRecord {
  /** The file name, `<mode>-<utc>-e<epoch>-s<seq>.zip`. */
  name: string;
  file: string;
  /** The archive file's own size and SHA-256. */
  size: number;
  sha256: string;
  manifest: ExportManifest;
  /** Each kind and place once, in the order the scan met them. */
  secrets: SecretFinding[];
}

/** The points a crash or a fault is injected at, in order. */
export type ExportPoint =
  /** The snapshot is in the work folder, vacuumed and checked. */
  | "snapshot"
  /** The secret scan of the rows ran and the attachments are known. */
  | "scanned"
  /** The archive is written and flushed in the work folder. */
  | "written"
  /** The archive restored on trial as a restore restores it. */
  | "verified"
  /** The archive has its name. */
  | "published";

/** What tests inject. Not part of the package's interface. */
export interface ExportSeams {
  at?: (point: ExportPoint) => void;
  policy?: BundlePolicy;
  steps?: readonly SchemaStep[];
  io?: FileIo;
  /** Free bytes for a folder. Default: the file system's. */
  freeBytes?: (folder: string) => number;
}

/** The name of a bundle. */
export const exportName = (mode: ExportMode, at: number, epoch: number, seq: number): string =>
  `${mode}-${utcStamp(at)}-e${String(epoch)}-s${String(seq)}.zip`;

/** The exports folder of a space folder. */
export const exportsFolder = (spaceFolder: string): string =>
  join(checkSpacePath(spaceFolder), EXPORTS_FOLDER);

/**
 * Exports the space at `folder` as a bundle (see the header). Opening the space refuses as a
 * reader's open does. Later failures keep their own code when it says what is wrong with the
 * space or the bundle (BUNDLE_LIMIT_EXCEEDED, BUNDLE_INVALID, EXPORT_SECRET_FOUND for a file in a
 * secrets folder,
 * SPACE_SCHEMA_FOREIGN, SPACE_TOO_NEW, SPACE_VERSION_UNKNOWN), and are BACKUP_FAILED otherwise,
 * with the cause's code in the message.
 */
export async function exportBundle(
  checked: CheckedDriver,
  folder: string,
  options: ExportOptions,
): Promise<ExportRecord> {
  return exportBundleWith(checked, folder, options, {});
}

/**
 * What an export needs on disk at its peak, at most, from the space's database size D, its live
 * attachments' total A and data.jsonl's size J (0 without it): the snapshot and its vacuum's
 * write-ahead log (2D), then the snapshot, data.jsonl and the archive that holds them (2D + 2J + A),
 * then the archive and its trial restore (2D + 2A + J), or the archive and its published copy where
 * the file system makes no hard link (2D + 2A + 2J). So 2D + 2A + 2J bounds every step. J is not
 * known before data.jsonl is written (JSON can be many times the database: column names in every
 * row, escaped control characters), so the export checks 2D + 2A before it writes anything, and
 * data.jsonl may then hold half of what is left (jsonlBudget), counted as it is written.
 */
export function exportPeak(databaseSize: number, attachments: number, jsonl: number): number {
  return 2 * databaseSize + 2 * attachments + 2 * jsonl;
}

/** What data.jsonl may hold: half of the free space, less the reserve, that the rest leaves. */
export function jsonlBudget(free: number, needed: number, policy: BundlePolicy): number {
  return Math.max(0, Math.floor((free - policy.freeSpaceReserveBytes - needed) / 2));
}

/** exportBundle with test seams. */
export async function exportBundleWith(
  checked: CheckedDriver,
  folder: string,
  options: ExportOptions,
  seams: ExportSeams,
): Promise<ExportRecord> {
  const policy = seams.policy ?? BUNDLE_POLICY;
  const io = seams.io ?? NODE_IO;
  const steps = seams.steps ?? SCHEMA_STEPS;
  const appVersion = options.appVersion ?? SOURCE_APP_VERSION;
  if (!isAppVersion(appVersion)) throw misuse("An app version is major.minor.patch");
  if (!EXPORT_MODES.includes(options.mode)) throw misuse("Unknown export mode");
  if ((options.mode === "transfer") !== (options.statement !== undefined)) {
    throw misuse("A transfer bundle carries its statement, and only a transfer bundle does");
  }
  const createdAt = (options.now ?? Date.now)();
  if (!inRange(createdAt, "instant")) throw misuse("The clock gave an instant outside its range");
  const dir = checkSpacePath(folder);
  const busy = options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };
  const opened = openSpaceWith(checked, dir, { role: "reader", ...busy }, { steps });
  const exportDir = options.exportDir ?? join(dir, EXPORTS_FOLDER);
  const work = join(exportDir, `${EXPORT_TEMP_PREFIX}${temporaryTag()}`);
  let made = false;
  try {
    // 0. What a restore would refuse, and what the disk cannot hold, before anything is written.
    const tables = checkSource(checked, opened.conn, steps);
    const peak = exportPeak(
      databaseBytes(opened.conn),
      liveAttachmentBytes(opened.conn, tables),
      0,
    );
    const free = (seams.freeBytes ?? freeBytes)(existingFolder(exportDir));
    checkFreeSpace(peak, free, policy);

    makeDurableFolder(exportDir, io);
    fsCall(() => {
      makeDirExact(work, FOLDER_MODE);
    });
    made = true;

    // 1. The snapshot, vacuumed and checked.
    const db = join(work, DATABASE_FILE);
    try {
      await copySnapshot(checked, opened.conn, db, policy);
    } finally {
      opened.conn.close();
    }
    prepareSnapshot(checked, db, busy, steps);
    const facts = checkSnapshot(checked, db, options.busyTimeoutMs);
    const position = stepPosition(steps, facts.userVersion);
    if (position.state !== "known") throw misuse("The snapshot's revision is not the source's");
    seams.at?.("snapshot");

    // 2. The secret scan of the rows, data.jsonl, and the attachments the snapshot names.
    const snapshotTables = productTables(checked, steps, facts.userVersion) ?? [];
    const jsonl = options.withJsonl === true ? join(work, JSONL_FILE) : undefined;
    const secrets = new Findings();
    const blobs = scanSnapshot(checked, db, snapshotTables, busy, secrets, {
      file: jsonl,
      maxBytes: jsonlBudget(free, peak, policy),
    });
    seams.at?.("scanned");

    // 3. The limits, before the archive is written.
    const spaceJson = Buffer.from(
      manifestText(manifestFor(facts.space, position.step, appVersion)),
    );
    const planned: { name: string; size: number }[] = [
      { name: MANIFEST_FILE, size: spaceJson.length },
      { name: DATABASE_FILE, size: sizeOf(db) },
      ...blobs.map((b) => ({ name: blobName(b.sha256), size: b.size })),
      ...(jsonl === undefined ? [] : [{ name: JSONL_FILE, size: sizeOf(jsonl) }]),
    ];
    checkPlanned(planned, policy);

    // 4. The archive. Its sources are inside it now, so they go before the trial restore.
    const archive = join(work, "bundle.zip");
    const manifest = await writeArchive(archive, {
      createdAt,
      spaceJson,
      db,
      space: dir,
      blobs,
      secretFolders: options.secretFolders ?? [],
      secrets,
      jsonl,
      facts,
      options,
      appVersion,
      policy,
      io,
    });
    for (const path of [db, ...(jsonl === undefined ? [] : [jsonl])]) removeQuietly(path, io);
    seams.at?.("written");

    // 5. The trial restore: the restore's own steps, to its first write, on a copy in the work
    // folder (restore/restore.ts restoreCopy).
    const trial = join(work, "trial");
    fsCall(() => {
      makeDirExact(trial, FOLDER_MODE);
    });
    await restoreCopy(checked, archive, inFolder(trial), createdAt, busy, {
      policy,
      steps,
      ...(seams.freeBytes === undefined ? {} : { freeBytes: seams.freeBytes }),
    });
    removeQuietly(trial, io);
    const digest = await fileDigest(archive);
    seams.at?.("verified");

    // 6. Publication: the one point where the bundle appears, never over anything.
    const name = exportName(
      options.mode,
      createdAt,
      facts.space.authority.epoch,
      facts.space.lastSeq,
    );
    const file = join(exportDir, name);
    try {
      publishExclusive(archive, file, io);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") {
        throw new StorageError("BACKUP_FAILED", "An export with this name already exists");
      }
      throw fsError(error);
    }
    fsyncFolder(exportDir, io);
    seams.at?.("published");
    return {
      name,
      file,
      size: digest.size,
      sha256: digest.sha256,
      manifest,
      secrets: secrets.list(),
    };
  } catch (error) {
    throw exportFailed(error);
  } finally {
    // Safe twice: the snapshot closed it already when it got that far.
    opened.conn.close();
    // The work folder is this export's own, by its full name, and only once it made it.
    if (made) removeQuietly(work, io);
  }
}

/**
 * Step 0 on the space's own connection: the revision is known and not newer, and the schema is
 * exactly the revision's. Returns the product's tables at that revision.
 */
function checkSource(
  checked: CheckedDriver,
  conn: Connection,
  steps: readonly SchemaStep[],
): readonly ProductTable[] {
  const userVersion = conn.pragma("user_version");
  const position = inRange(userVersion, "count")
    ? stepPosition(steps, userVersion)
    : { state: "unknown" as const };
  if (position.state === "newer") {
    throw new StorageError("SPACE_TOO_NEW", "The space's schema is newer than this build writes");
  }
  if (position.state !== "known" || typeof userVersion !== "number") {
    throw new StorageError("SPACE_VERSION_UNKNOWN", "The space's schema revision is unknown");
  }
  const schema = conn.transaction("deferred", () => schemaObjects(conn));
  requireOwnSchema(checked, schema, userVersion, steps);
  return productTables(checked, steps, userVersion) ?? [];
}

/** The total size of the live attachment rows' blobs, each blob once. */
function liveAttachmentBytes(conn: Connection, tables: readonly ProductTable[]): number {
  if (!tables.some((table) => table.name === "attachments")) return 0;
  const total = conn
    .prepare(
      "SELECT coalesce(sum(size), 0) AS n FROM " +
        "(SELECT DISTINCT sha256, size FROM attachments WHERE deleted_at IS NULL)",
    )
    .get()?.["n"];
  return inRange(total, "count") ? total : 0;
}

/** The codes an export passes on as they are: they say what is wrong with the space or bundle. */
const OWN_CODES: ReadonlySet<string> = new Set([
  "BACKUP_FAILED",
  "BUNDLE_INVALID",
  "BUNDLE_LIMIT_EXCEEDED",
  "EXPORT_SECRET_FOUND",
  "SPACE_SCHEMA_FOREIGN",
  "SPACE_TOO_NEW",
  "SPACE_VERSION_UNKNOWN",
]);

function exportFailed(error: unknown): StorageError {
  if (error instanceof StorageError && OWN_CODES.has(error.code)) return error;
  const cause = error instanceof StorageError ? error.code : "an unexpected error";
  return new StorageError("BACKUP_FAILED", `The export failed (${cause})`);
}

const sizeOf = (path: string): number => fsCall(() => statSync(path).size);

/**
 * Makes the private snapshot what a bundle holds, in one transaction, then vacuums it, so the
 * bundle carries no bytes of deleted rows or free pages:
 * - the objects the exact-schema rule leaves out are dropped, and the search index, which is
 *   derived from the product's tables, is made again (restore/mark.ts prepareCopy, as a restore
 *   does): the index's rows are copies the secret scan does not read, one may name no document,
 *   and its segments keep words of deleted text until they merge.
 * So the bundle holds exactly its revision's schema and no text the secret scan does not read. The
 * connection is the only one on the file; its close checkpoints the -wal into the file.
 */
function prepareSnapshot(
  checked: CheckedDriver,
  db: string,
  busy: { busyTimeoutMs?: number },
  steps: readonly SchemaStep[],
): void {
  const conn = openWriter(checked, db, busy);
  try {
    conn.transaction("immediate", () => {
      prepareCopy(checked, conn, steps);
    });
    // The log is emptied into the file first, so it holds only the vacuum's pages: at most the
    // database once (exportPeak's 2D).
    conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    conn.exec("VACUUM");
  } finally {
    conn.close();
  }
  for (const path of [`${db}-wal`, `${db}-shm`]) removeQuietly(path);
}

/** A live attachment row's blob: its hash and size. */
interface Blob {
  sha256: string;
  size: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** An attachment's path in a bundle and under a space (A1 3.18 "Attachments"). */
const blobName = (sha256: string): string => `attachments/sha256/${sha256.slice(0, 2)}/${sha256}`;

/** The secret-shaped strings an export met, each kind and place once. */
class Findings {
  readonly #seen = new Map<string, SecretFinding>();
  add(kind: SecretKind, place: string): void {
    const key = `${kind} ${place}`;
    if (!this.#seen.has(key)) this.#seen.set(key, { kind, place });
  }
  list(): SecretFinding[] {
    return [...this.#seen.values()];
  }
}

/**
 * The secret scan of every text value of the product's tables in the snapshot (writing data.jsonl
 * in the same pass when asked, at most `jsonl.maxBytes`), and the blobs its live attachment rows
 * name.
 */
function scanSnapshot(
  checked: CheckedDriver,
  db: string,
  tables: readonly ProductTable[],
  busy: { busyTimeoutMs?: number },
  secrets: Findings,
  jsonl: { file: string | undefined; maxBytes: number },
): Blob[] {
  // `table` and `column` are the product's own names (snapshot.ts productTables).
  const see = (table: string, column: string, text: string): void => {
    const kind = findSecret(text);
    if (kind !== undefined) secrets.add(kind, `${table}.${column}`);
  };
  const conn = openReader(checked, db, busy);
  try {
    if (jsonl.file !== undefined) {
      writeJsonl(conn, jsonl.file, tables, { seeText: see, maxBytes: jsonl.maxBytes });
    } else scanText(conn, tables, see);
    if (!tables.some((table) => table.name === "attachments")) return [];
    const rows = conn
      .prepare(
        "SELECT sha256, max(size) AS size, min(size) AS least FROM attachments " +
          "WHERE deleted_at IS NULL GROUP BY sha256 ORDER BY sha256",
      )
      .all<{ sha256: unknown; size: unknown; least: unknown }>();
    return rows.map((row) => {
      if (
        typeof row.sha256 !== "string" ||
        !SHA256.test(row.sha256) ||
        !inRange(row.size, "count") ||
        row.size !== row.least
      ) {
        throw new StorageError("BUNDLE_INVALID", "An attachment row of the space is not valid");
      }
      return { sha256: row.sha256, size: row.size };
    });
  } finally {
    conn.close();
    for (const path of [`${db}-wal`, `${db}-shm`]) removeQuietly(path);
  }
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** POSIX's refusal to open a link; on Windows the identity checks cover it. */
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

const notOwnFile = (): StorageError =>
  new StorageError("BUNDLE_INVALID", "An attachment of the space is not its own file");

/** The real path of `path`, or BUNDLE_INVALID when nothing is there. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new StorageError("BUNDLE_INVALID", "An attachment of the space is missing");
    }
    throw fsError(error);
  }
}

/**
 * Opens the file of a live attachment row for reading (A1 3.18 "Attachments"): the regular file at
 * `attachments/sha256/<first two hex>/<hash>` of the space itself, reached through no link, in no
 * secrets folder, of the row's size. The checks hold for the file the descriptor reads: the path
 * resolves to the space's own place before and after the open, and the opened file is the one at
 * that place. The caller closes the descriptor.
 */
function openAttachment(space: string, blob: Blob, secretFolders: readonly string[]): number {
  const parts = blobName(blob.sha256).split("/");
  const path = join(space, ...parts);
  const expected = join(
    fsCall(() => realpathSync(space)),
    ...parts,
  );
  if (realOf(path) !== expected) throw notOwnFile();
  for (const secrets of secretFolders) {
    let realSecrets: string;
    try {
      realSecrets = realpathSync(secrets);
    } catch {
      continue;
    }
    if (inside(expected, realSecrets)) {
      throw new StorageError(
        "EXPORT_SECRET_FOUND",
        "A file of the export lies in the secrets folder. Nothing was written",
      );
    }
  }
  let fd: number;
  try {
    fd = openSync(expected, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") throw notOwnFile();
    throw fsError(error);
  }
  try {
    const opened = fsCall(() => fstatSync(fd, { bigint: true }));
    const there = fsCall(() => lstatSync(expected, { bigint: true, throwIfNoEntry: false }));
    if (
      there === undefined ||
      !opened.isFile() ||
      opened.dev !== there.dev ||
      opened.ino !== there.ino ||
      realOf(path) !== expected
    ) {
      throw notOwnFile();
    }
    if (opened.size !== BigInt(blob.size)) {
      throw new StorageError("BUNDLE_INVALID", "An attachment differs from its row");
    }
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
  return fd;
}

/** Refuses a plan that passes a limit of the policy: each file's kind, the count, the total. */
function checkPlanned(
  planned: readonly { name: string; size: number }[],
  policy: BundlePolicy,
): void {
  // export.json is one more entry.
  if (planned.length + 1 > policy.maxEntries) throw limitExceeded("the number of entries");
  let total = 0;
  for (const { name, size } of planned) {
    const kind = bundleEntryKind(name);
    if (kind === undefined) throw misuse("The exporter planned a file a bundle never has");
    if (size > entryLimit(kind, policy)) throw limitExceeded(entryLabel(kind));
    total += size;
  }
  if (total > policy.maxTotalBytes) throw limitExceeded("the total expanded size");
}

/**
 * A byte scan for secrets across chunks: the end of each chunk is kept in front of the next. One
 * finding per attachment is enough to warn of it, so the scan stops looking after the first.
 */
function byteScanner(secrets: Findings): (chunk: Buffer) => void {
  let tail = "";
  let found = false;
  return (chunk) => {
    if (found) return;
    const text = tail + chunk.toString("latin1");
    const kind = findSecret(text);
    if (kind !== undefined) {
      secrets.add(kind, "an attachment");
      found = true;
    }
    tail = text.slice(-SECRET_OVERLAP);
  };
}

interface ArchiveInput {
  createdAt: number;
  spaceJson: Buffer;
  db: string;
  /** The space folder, whose attachments the blobs are. */
  space: string;
  blobs: readonly Blob[];
  secretFolders: readonly string[];
  secrets: Findings;
  jsonl: string | undefined;
  facts: SnapshotFacts;
  options: ExportOptions;
  appVersion: string;
  policy: BundlePolicy;
  io: FileIo;
}

/** Writes the archive and returns its export.json. */
async function writeArchive(archive: string, input: ArchiveInput): Promise<ExportManifest> {
  const { policy } = input;
  const writer = ZipWriter.create(archive, input.createdAt, input.io);
  try {
    const files: Record<string, FileDigest> = {};
    const add = (entry: { name: string; size: number; sha256: string }): void => {
      files[entry.name] = { sha256: entry.sha256, size: entry.size };
    };
    add(writer.addBytes(MANIFEST_FILE, input.spaceJson));
    add(
      await writer.addFile(
        DATABASE_FILE,
        input.db,
        sizeOf(input.db),
        entryLimit("database", policy),
      ),
    );
    for (const blob of input.blobs) {
      const fd = openAttachment(input.space, blob, input.secretFolders);
      let written;
      try {
        written = await writer.addFile(
          blobName(blob.sha256),
          fd,
          blob.size,
          entryLimit("attachment", policy),
          byteScanner(input.secrets),
        );
      } finally {
        closeQuietly(fd);
      }
      // The blob is the content its name and row promise.
      if (written.sha256 !== blob.sha256) {
        throw new StorageError("BUNDLE_INVALID", "An attachment differs from its row");
      }
      add(written);
    }
    if (input.jsonl !== undefined) {
      add(
        await writer.addFile(
          JSONL_FILE,
          input.jsonl,
          sizeOf(input.jsonl),
          entryLimit("jsonl", policy),
        ),
      );
    }
    const { space, userVersion, counts } = input.facts;
    const manifest: ExportManifest = {
      [EXPORT_MARKER]: EXPORT_VERSION,
      mode: input.options.mode,
      space_id: space.spaceId,
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      seq: space.lastSeq,
      user_version: userVersion,
      counts,
      created_at: input.createdAt,
      written_by: input.appVersion,
      files,
      ...(input.options.statement === undefined
        ? {}
        : { transfer_statement: input.options.statement }),
    };
    const text = Buffer.from(exportText(manifest), "utf8");
    if (text.length > policy.maxOtherFileBytes) throw limitExceeded("a file");
    writer.addBytes(EXPORT_FILE, text);
    writer.finish();
    return manifest;
  } catch (error) {
    writer.abort();
    throw error;
  }
}

/** The size and SHA-256 of a whole file. */
async function fileDigest(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      hash.update(bytes);
    }
  } catch (error) {
    throw fsError(error);
  }
  return { size, sha256: hash.digest("hex") };
}
