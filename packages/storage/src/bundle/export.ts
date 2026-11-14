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
// 1. A read-only connection copies the database in one backup step into a private work folder
//    `.export.tmp-<random>` in the exports folder (A1 3.1: `<space>/exports`), and the space's
//    connection closes. The copy is vacuumed, so it carries no bytes of deleted rows, and checked
//    (integrity_check and the facts, as a backup's).
// 2. The secret scan (A6 3.16.4): every text value of every table, and every attachment's bytes,
//    against the secret patterns (secrets.ts). An attachment's file must be the regular file of its
//    row under the space's own `attachments/`, never a link out of it, and never a file of a
//    secrets folder. A hit writes nothing: EXPORT_SECRET_FOUND names the kind and the table and
//    column, never the text.
// 3. Every file is checked against its kind's limit, and the files together against the count and
//    the total (the shared BundlePolicy), before anything is written.
// 4. The archive is written in the work folder, flushed, then read back exactly as a restore reads
//    it (read.ts), every checksum against export.json: Tasks never publishes a bundle it would
//    refuse.
// 5. Publication: the archive takes its name `<mode>-<utc>-e<epoch>-s<seq>.zip` in the exports
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
import { createReadStream, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { misuse, StorageError } from "../errors.ts";
import {
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
import { findSecret, SECRET_OVERLAP } from "../secrets.ts";
import { openSpaceWith, SOURCE_APP_VERSION } from "../space.ts";
import { checkSpacePath } from "../space-path.ts";
import type { CheckedDriver } from "../startup-check.ts";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import { makeDurableFolder } from "../backup/backup.ts";
import {
  BUNDLE_POLICY,
  bundleEntryKind,
  entryLabel,
  entryLimit,
  limitExceeded,
  type BundlePolicy,
} from "../backup/policy.ts";
import { utcStamp } from "../backup/sidecar.ts";
import { checkSnapshot, copySnapshot, type SnapshotFacts } from "../backup/snapshot.ts";
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
import { dataTables, writeJsonl } from "./jsonl.ts";
import { readBundle } from "./read.ts";
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

/** A published bundle. */
export interface ExportRecord {
  /** The file name, `<mode>-<utc>-e<epoch>-s<seq>.zip`. */
  name: string;
  file: string;
  /** The archive file's own size and SHA-256. */
  size: number;
  sha256: string;
  manifest: ExportManifest;
}

/** The points a crash or a fault is injected at, in order. */
export type ExportPoint =
  /** The snapshot is in the work folder, vacuumed and checked. */
  | "snapshot"
  /** The secret scan passed and the attachments are found. */
  | "scanned"
  /** The archive is written and flushed in the work folder. */
  | "written"
  /** The archive read back as a restore reads it. */
  | "verified"
  /** The archive has its name. */
  | "published";

/** What tests inject. Not part of the package's interface. */
export interface ExportSeams {
  at?: (point: ExportPoint) => void;
  policy?: BundlePolicy;
  steps?: readonly SchemaStep[];
  io?: FileIo;
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
 * space or the bundle (BUNDLE_LIMIT_EXCEEDED, BUNDLE_INVALID, EXPORT_SECRET_FOUND, SPACE_TOO_NEW,
 * SPACE_VERSION_UNKNOWN), and are BACKUP_FAILED otherwise, with the cause's code in the message.
 */
export async function exportBundle(
  checked: CheckedDriver,
  folder: string,
  options: ExportOptions,
): Promise<ExportRecord> {
  return exportBundleWith(checked, folder, options, {});
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
    vacuum(checked, db, busy);
    const facts = checkSnapshot(checked, db, options.busyTimeoutMs);
    const position = stepPosition(steps, facts.userVersion);
    if (position.state === "newer") {
      throw new StorageError("SPACE_TOO_NEW", "The space's schema is newer than this build writes");
    }
    if (position.state === "unknown") {
      throw new StorageError("SPACE_VERSION_UNKNOWN", "The space's schema revision is unknown");
    }
    seams.at?.("snapshot");

    // 2. The secret scan, the attachments the snapshot names, and data.jsonl.
    const jsonl = options.withJsonl === true ? join(work, JSONL_FILE) : undefined;
    const blobs = scanSnapshot(checked, db, jsonl, busy);
    const sources = blobs.map((blob) => attachmentSource(dir, blob, options.secretFolders ?? []));
    seams.at?.("scanned");

    // 3. The limits, before anything is written.
    const spaceJson = Buffer.from(
      manifestText(manifestFor(facts.space, position.step, appVersion)),
    );
    const planned: { name: string; size: number }[] = [
      { name: MANIFEST_FILE, size: spaceJson.length },
      { name: DATABASE_FILE, size: sizeOf(db) },
      ...sources.map((s) => ({ name: s.name, size: s.size })),
      ...(jsonl === undefined ? [] : [{ name: JSONL_FILE, size: sizeOf(jsonl) }]),
    ];
    checkPlanned(planned, policy);

    // 4. The archive, then read back as a restore reads it.
    const archive = join(work, "bundle.zip");
    const manifest = await writeArchive(archive, {
      createdAt,
      spaceJson,
      db,
      sources,
      jsonl,
      facts,
      options,
      appVersion,
      policy,
      io,
    });
    seams.at?.("written");
    await readBundle(archive, policy);
    const digest = await fileDigest(archive);
    seams.at?.("verified");

    // 5. Publication: the one point where the bundle appears, never over anything.
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
    return { name, file, size: digest.size, sha256: digest.sha256, manifest };
  } catch (error) {
    throw exportFailed(error);
  } finally {
    // Safe twice: the snapshot closed it already when it got that far.
    opened.conn.close();
    // The work folder is this export's own, by its full name, and only once it made it.
    if (made) removeQuietly(work, io);
  }
}

/** The codes an export passes on as they are: they say what is wrong with the space or bundle. */
const OWN_CODES: ReadonlySet<string> = new Set([
  "BACKUP_FAILED",
  "BUNDLE_INVALID",
  "BUNDLE_LIMIT_EXCEEDED",
  "EXPORT_SECRET_FOUND",
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
 * Vacuums the private snapshot, so the bundle carries no bytes of deleted rows or free pages. The
 * connection is the only one on the file; its close checkpoints the -wal into the file.
 */
function vacuum(checked: CheckedDriver, db: string, busy: { busyTimeoutMs?: number }): void {
  const conn = openWriter(checked, db, busy);
  try {
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

/** A secret-shaped text refuses the export, naming where it is and never what it is. */
function refuseSecret(table: string, column: string, text: string): void {
  const kind = findSecret(text);
  if (kind === undefined) return;
  const place = /^[a-z_][a-z0-9_]{0,63}$/.test(column) ? `${table}.${column}` : table;
  throw new StorageError(
    "EXPORT_SECRET_FOUND",
    `The export would hold a string shaped like a secret (${kind}) in ${place}. Nothing was written`,
  );
}

/**
 * The secret scan of every text value in the snapshot (writing data.jsonl in the same pass when
 * asked), and the blobs its live attachment rows name.
 */
function scanSnapshot(
  checked: CheckedDriver,
  db: string,
  jsonl: string | undefined,
  busy: { busyTimeoutMs?: number },
): Blob[] {
  const conn = openReader(checked, db, busy);
  try {
    if (jsonl !== undefined) {
      writeJsonl(conn, jsonl, { seeText: refuseSecret });
    } else {
      for (const table of dataTables(conn)) {
        for (const row of conn.prepare(`SELECT * FROM "${table}"`).iterate()) {
          for (const [column, value] of Object.entries(row)) {
            if (typeof value === "string") refuseSecret(table, column, value);
          }
        }
      }
    }
    const hasTable =
      conn
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'attachments'",
        )
        .get()?.["n"] === 1;
    if (!hasTable) return [];
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

/** An attachment's file in the space, checked, with its bundle path. */
interface Source {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The file of a live attachment row (A1 3.18 "Attachments"): the regular file at
 * `attachments/sha256/<first two hex>/<hash>` of the space itself, reached through no link, of the
 * row's size, and in no secrets folder.
 */
function attachmentSource(space: string, blob: Blob, secretFolders: readonly string[]): Source {
  const name = `attachments/sha256/${blob.sha256.slice(0, 2)}/${blob.sha256}`;
  const path = join(space, ...name.split("/"));
  let real: string;
  let size: number;
  try {
    real = realpathSync(path);
    size = statSync(real).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new StorageError("BUNDLE_INVALID", "An attachment of the space is missing");
    }
    throw fsError(error);
  }
  const expected = join(realpathSync(space), ...name.split("/"));
  if (real !== expected || !fsCall(() => statSync(real).isFile())) {
    throw new StorageError("BUNDLE_INVALID", "An attachment of the space is not its own file");
  }
  for (const secrets of secretFolders) {
    let realSecrets: string;
    try {
      realSecrets = realpathSync(secrets);
    } catch {
      continue;
    }
    if (inside(real, realSecrets)) {
      throw new StorageError(
        "EXPORT_SECRET_FOUND",
        "A file of the export lies in the secrets folder. Nothing was written",
      );
    }
  }
  if (size !== blob.size) {
    throw new StorageError("BUNDLE_INVALID", "An attachment differs from its row");
  }
  return { name, path: real, size, sha256: blob.sha256 };
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

/** A byte scan for secrets across chunks: the end of each chunk is kept in front of the next. */
function byteScanner(): (chunk: Buffer) => void {
  let tail = "";
  return (chunk) => {
    const text = tail + chunk.toString("latin1");
    const kind = findSecret(text);
    if (kind !== undefined) {
      throw new StorageError(
        "EXPORT_SECRET_FOUND",
        `The export would hold a string shaped like a secret (${kind}) in an attachment. Nothing was written`,
      );
    }
    tail = text.slice(-SECRET_OVERLAP);
  };
}

interface ArchiveInput {
  createdAt: number;
  spaceJson: Buffer;
  db: string;
  sources: readonly Source[];
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
    for (const source of input.sources) {
      const written = await writer.addFile(
        source.name,
        source.path,
        source.size,
        entryLimit("attachment", policy),
        byteScanner(),
      );
      // The blob is the content its name and row promise.
      if (written.sha256 !== source.sha256) {
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
