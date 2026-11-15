// `export.json`, the description an export bundle carries of itself (A1 3.18): its mode, the
// snapshot's identity and facts, and the size and SHA-256 of every other file in the archive. A
// restore or an import checks every file against it, and the snapshot against its facts.
//
//   tasks_export          1, the format
//   mode                  backup | fork | transfer
//   space_id, epoch, incarnation, seq
//                         the snapshot's space, authority and last commit
//   user_version          the snapshot's schema revision (A1 3.17's encoding)
//   counts                rows per table in the snapshot
//   created_at            when the export began, in milliseconds since 1970
//   written_by            the app version that wrote it
//   files                 {path: {sha256, size}} for every other file
//   transfer_statement    a transfer bundle's statement (A6 3.5): M3.08 signs and verifies it
import { isId, type Id } from "../ids.ts";
import { isAppVersion } from "../manifest.ts";
import { inRange } from "../rows.ts";
import { bundleEntryKind } from "../backup/policy.ts";

export const EXPORT_FILE = "export.json";
export const EXPORT_MARKER = "tasks_export";
export const EXPORT_VERSION = 1;

/** What an export is for (A6 3.5). */
export const EXPORT_MODES = ["backup", "fork", "transfer"] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

/**
 * A transfer bundle's statement (A1 3.18 "Transfer states", A6 3.5). This step carries it as the
 * caller gives it; M3.08 builds and signs it with the machine key and verifies it on import. It
 * names at least the transfer and the machine it is for.
 */
export interface TransferStatement {
  transfer_id: Id<"tr">;
  to: Id<"m">;
  [field: string]: unknown;
}

export interface FileDigest {
  sha256: string;
  size: number;
}

export interface ExportManifest {
  [EXPORT_MARKER]: typeof EXPORT_VERSION;
  mode: ExportMode;
  space_id: Id<"sp">;
  epoch: number;
  incarnation: Id<"ai">;
  seq: number;
  user_version: number;
  counts: Record<string, number>;
  created_at: number;
  written_by: string;
  files: Record<string, FileDigest>;
  transfer_statement?: TransferStatement;
}

/** The file's text: two-space JSON with a final newline. */
export const exportText = (manifest: ExportManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SHA256 = /^[0-9a-f]{64}$/;
const TABLE = /^[a-z_][a-z0-9_]{0,63}$/;

/** Decodes an export.json value, or undefined when any field breaks its shape. */
export function decodeExport(json: unknown): ExportManifest | undefined {
  if (!isRecord(json) || json[EXPORT_MARKER] !== EXPORT_VERSION) return undefined;
  const { mode, space_id, epoch, incarnation, seq, user_version, counts, created_at } = json;
  const { written_by, files, transfer_statement } = json;
  if (!EXPORT_MODES.includes(mode as ExportMode)) return undefined;
  if (!isId(space_id, "sp") || !isId(incarnation, "ai")) return undefined;
  if (!inRange(epoch, "epoch") || !inRange(seq, "seq") || !inRange(user_version, "count")) {
    return undefined;
  }
  if (!inRange(created_at, "instant") || !isAppVersion(written_by)) return undefined;
  if (!isRecord(counts) || !isRecord(files)) return undefined;
  const tableCounts: Record<string, number> = {};
  for (const [table, count] of Object.entries(counts)) {
    if (!TABLE.test(table) || !inRange(count, "seq")) return undefined;
    tableCounts[table] = count;
  }
  const digests: Record<string, FileDigest> = {};
  for (const [path, digest] of Object.entries(files)) {
    if (path === EXPORT_FILE || bundleEntryKind(path) === undefined || !isRecord(digest)) {
      return undefined;
    }
    const { sha256, size } = digest;
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) return undefined;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
    digests[path] = { sha256, size };
  }
  let statement: TransferStatement | undefined;
  if (mode === "transfer") {
    if (!isRecord(transfer_statement)) return undefined;
    if (!isId(transfer_statement["transfer_id"], "tr") || !isId(transfer_statement["to"], "m")) {
      return undefined;
    }
    statement = transfer_statement as TransferStatement;
  } else if (transfer_statement !== undefined) {
    return undefined;
  }
  return {
    [EXPORT_MARKER]: EXPORT_VERSION,
    mode: mode as ExportMode,
    space_id,
    epoch,
    incarnation,
    seq,
    user_version,
    counts: tableCounts,
    created_at,
    written_by,
    files: digests,
    ...(statement === undefined ? {} : { transfer_statement: statement }),
  };
}
