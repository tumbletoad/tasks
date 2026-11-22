// space.json (A1 3.1): a hint that lets tools identify a space and refuse a too-new format before
// opening SQLite. The database wins on every field except space_id.
//
// The file holds two kinds of field, read apart from each other (A1 3.1):
// - The SAFETY fields guard an open: `space_id` (which space the folder holds), `format`,
//   `min_reader` and `min_writer` (A1 3.17). Each is read on its own, so one damaged field never
//   switches off another: a valid safety field is always honoured, whatever else is damaged.
// - The DESCRIPTION (`name`, `authority`, `lineage`, `transfer`, `written_by`) copies the database
//   and is rebuilt from it.
// A file that exists but is not a JSON object, has no tasks_space marker of this version, is
// larger than MANIFEST_MAX_BYTES or has a safety field that is missing or invalid is DAMAGED. The
// writer refuses a damaged manifest and never rewrites it, because the value it would overwrite
// could be the one that should have stopped it. A reader reports it and reads on. The writer
// rebuilds only a missing file, or one whose safety fields are all valid and allow the open.
import { join } from "node:path";
import { StorageError } from "./errors.ts";
import { NODE_IO, readBounded, writeFileAtomic, type FileIo } from "./files.ts";
import { isId, type Id } from "./ids.ts";
import {
  decodeLineage,
  inRange,
  isSpaceName,
  type Lineage,
  type SpaceFormat,
  type SpaceRow,
} from "./rows.ts";
import type { SchemaStep } from "./schema.ts";

export const MANIFEST_FILE = "space.json";
export const DATABASE_FILE = "space.db";

/**
 * The largest space.json this build reads: 64 KiB. A manifest TTasks writes is under 1 KiB plus
 * about 250 bytes per lineage entry, so the file holds some 250 lineage entries, and manifestFor
 * leaves older ones in the database only. A larger file is damaged, and reading stops at the limit.
 */
export const MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * The marker that makes a JSON file a space manifest, and its version. The key is A1 3.1's
 * literal. It is a format constant, so it stays when the placeholder product name changes.
 */
export const MANIFEST_MARKER = "tasks_space";
export const MANIFEST_VERSION = 1;

export interface SpaceManifest {
  [MANIFEST_MARKER]: typeof MANIFEST_VERSION;
  space_id: Id<"sp">;
  name: string;
  format: SpaceFormat;
  min_reader: string;
  min_writer: string;
  authority: { machine_id: Id<"m">; epoch: number; incarnation: Id<"ai">; since_seq: number };
  lineage: Lineage;
  transfer: Record<string, unknown> | null;
  written_by: string;
}

/** The safety fields that hold a valid value, each read on its own. */
export interface ManifestSafety {
  space_id?: Id<"sp">;
  format?: SpaceFormat;
  min_reader?: string;
  min_writer?: string;
}

export type ManifestRead =
  | { state: "missing" }
  /** A manifest version newer than this build knows: refused before SQLite opens (A1 3.1). */
  | { state: "newer" }
  | {
      state: "present";
      /** The valid safety fields. Honoured whatever else the file holds. */
      safety: ManifestSafety;
      /** Not a manifest, too large, or a safety field missing or invalid. Never rewritten. */
      damaged: boolean;
      /** The whole manifest, when every field is valid. Undefined: the description needs a rebuild. */
      manifest: SpaceManifest | undefined;
      /** The bytes read, so a later look can tell whether the file changed in between. */
      text: string;
    };

// ---------------------------------------------------------------------------------------------
// App versions: SemVer 2.0.0's `major.minor.patch` with an optional pre-release, no build part.

const NUMERIC = "0|[1-9]\\d{0,8}";
const IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const APP_VERSION = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`,
);
/** The longest pre-release tag accepted. */
const PRERELEASE_MAX = 64;

/**
 * Whether `value` is an app version: three numbers without leading zeros, and optionally a
 * pre-release of dot-separated identifiers, each non-empty, from `[0-9A-Za-z-]`, and without a
 * leading zero when it is numeric (SemVer 2.0.0 items 2 and 9). At most 64 characters of pre-release.
 */
export function isAppVersion(value: unknown): value is string {
  return parseAppVersion(value) !== undefined;
}

/** The parts of an app version: three numbers and the pre-release tag, if any. */
function parseAppVersion(value: unknown): [number, number, number, string | undefined] | undefined {
  // The length bound comes first, so the pattern never runs over a long string.
  if (typeof value !== "string" || value.length > 3 * 9 + 3 + PRERELEASE_MAX) return undefined;
  const match = APP_VERSION.exec(value);
  if (match === null) return undefined;
  const tag = match[4];
  if (tag !== undefined && tag.length > PRERELEASE_MAX) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), tag];
}

const isNumeric = (identifier: string): boolean => /^\d+$/.test(identifier);

/** Two numeric identifiers without leading zeros: the longer is larger, else by digits. */
const compareDigits = (a: string, b: string): number =>
  a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;

/**
 * Compares two app versions by SemVer 2.0.0's precedence (item 11): negative, zero or positive.
 * Major, minor and patch compare as numbers. A release ranks above its pre-releases. Pre-release
 * identifiers compare left to right: numeric ones as numbers, alphanumeric ones by ASCII order,
 * numeric below alphanumeric, and a longer list above its own prefix.
 */
export function compareAppVersions(a: string, b: string): number {
  const pa = parseAppVersion(a);
  const pb = parseAppVersion(b);
  if (pa === undefined || pb === undefined) throw new RangeError("Not an app version");
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return Math.sign(diff);
  }
  const ta = pa[3];
  const tb = pb[3];
  if (ta === tb) return 0;
  if (ta === undefined) return 1;
  if (tb === undefined) return -1;
  const ia = ta.split(".");
  const ib = tb.split(".");
  for (let i = 0; i < Math.min(ia.length, ib.length); i += 1) {
    const x = ia[i] ?? "";
    const y = ib[i] ?? "";
    if (x === y) continue;
    const nx = isNumeric(x);
    const ny = isNumeric(y);
    if (nx && ny) return Math.sign(compareDigits(x, y));
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(ia.length - ib.length);
}

// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFormat = (value: unknown): value is SpaceFormat =>
  isRecord(value) && inRange(value["major"], "count") && inRange(value["minor"], "count");

/** Reads each safety field on its own. `complete` is false when one is missing or invalid. */
function readSafety(json: Record<string, unknown>): { safety: ManifestSafety; complete: boolean } {
  const safety: ManifestSafety = {};
  const { space_id, format, min_reader, min_writer } = json;
  if (isId(space_id, "sp")) safety.space_id = space_id;
  if (isFormat(format)) safety.format = { major: format.major, minor: format.minor };
  if (isAppVersion(min_reader)) safety.min_reader = min_reader;
  if (isAppVersion(min_writer)) safety.min_writer = min_writer;
  const complete =
    safety.space_id !== undefined &&
    safety.format !== undefined &&
    safety.min_reader !== undefined &&
    safety.min_writer !== undefined;
  return { safety, complete };
}

/** The whole manifest, when the description is valid as well as the safety fields. */
function readDescription(
  json: Record<string, unknown>,
  safety: Required<ManifestSafety>,
): SpaceManifest | undefined {
  const { name, authority, transfer, written_by } = json;
  if (!isSpaceName(name) || !isAppVersion(written_by) || !isRecord(authority)) return undefined;
  const { machine_id, epoch, incarnation, since_seq } = authority;
  if (!isId(machine_id, "m") || !isId(incarnation, "ai")) return undefined;
  if (!inRange(epoch, "epoch") || !inRange(since_seq, "seq")) return undefined;
  const lineage = decodeLineage(json["lineage"]);
  if (lineage === undefined) return undefined;
  if (transfer !== null && !isRecord(transfer)) return undefined;
  return {
    [MANIFEST_MARKER]: MANIFEST_VERSION,
    space_id: safety.space_id,
    name,
    format: safety.format,
    min_reader: safety.min_reader,
    min_writer: safety.min_writer,
    authority: { machine_id, epoch, incarnation, since_seq },
    lineage,
    transfer,
    written_by,
  };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const damaged = (text: string): ManifestRead => ({
  state: "present",
  safety: {},
  damaged: true,
  manifest: undefined,
  text,
});

/**
 * Reads `space.json` from a space folder, at most MANIFEST_MAX_BYTES of it. Never throws for
 * content, only for I/O.
 */
export function readManifest(folder: string, io: FileIo = NODE_IO): ManifestRead {
  const read = readBounded(join(folder, MANIFEST_FILE), MANIFEST_MAX_BYTES, io);
  if (read.state === "missing") return { state: "missing" };
  if (read.state === "too_large") return damaged("");
  let text: string;
  let json: unknown;
  try {
    text = UTF8.decode(read.bytes);
  } catch {
    return damaged("");
  }
  try {
    json = JSON.parse(text);
  } catch {
    return damaged(text);
  }
  if (!isRecord(json)) return damaged(text);
  const marker = json[MANIFEST_MARKER];
  if (typeof marker === "number" && Number.isSafeInteger(marker) && marker > MANIFEST_VERSION) {
    return { state: "newer" };
  }
  const { safety, complete } = readSafety(json);
  const ok = complete && marker === MANIFEST_VERSION;
  return {
    state: "present",
    safety,
    damaged: !ok,
    manifest: ok ? readDescription(json, safety as Required<ManifestSafety>) : undefined,
    text,
  };
}

/**
 * The manifest the database implies, as written by `appVersion`, for the space's step.
 *
 * The lineage grows by one entry with every claim, restore claim and transfer, and the database
 * keeps all of them. space.json, which a reader takes in at most MANIFEST_MAX_BYTES, carries the
 * newest entries that fit: when the whole lineage would pass the limit, the oldest entries are
 * left out of the file, and the newest one, the current authority's, always stays (A1
 * 3.1). The cut depends on the database alone, so the same database always gives the
 * same file and an open does not rewrite it.
 */
export function manifestFor(space: SpaceRow, step: SchemaStep, appVersion: string): SpaceManifest {
  const manifest = manifestWithLineage(space, step, appVersion, space.lineage.incarnations);
  const all = space.lineage.incarnations;
  if (fits(manifest) || all.length <= 1) return manifest;
  // The largest number of newest entries that fits, found by bisection: [low] fits, [high] not.
  let low = 1;
  let high = all.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(manifestWithLineage(space, step, appVersion, all.slice(-middle)))) low = middle;
    else high = middle;
  }
  return manifestWithLineage(space, step, appVersion, all.slice(-low));
}

const fits = (manifest: SpaceManifest): boolean =>
  Buffer.byteLength(manifestText(manifest), "utf8") <= MANIFEST_MAX_BYTES;

function manifestWithLineage(
  space: SpaceRow,
  step: SchemaStep,
  appVersion: string,
  incarnations: Lineage["incarnations"],
): SpaceManifest {
  return {
    [MANIFEST_MARKER]: MANIFEST_VERSION,
    space_id: space.spaceId,
    name: space.name,
    // The step's format, which open has checked the database holds: never an unchecked value.
    format: { major: step.format.major, minor: step.format.minor },
    min_reader: step.minReader,
    min_writer: step.minWriter,
    authority: {
      machine_id: space.authority.machineId,
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      since_seq: space.authority.sinceSeq,
    },
    lineage: { forked_from: space.lineage.forked_from, incarnations },
    transfer: space.transfer,
    written_by: appVersion,
  };
}

/** The file's text: two-space JSON with a final newline, keys in A1 3.1's order. */
export const manifestText = (manifest: SpaceManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/** Whether two manifests say the same, apart from which app wrote them. */
export const sameManifest = (a: SpaceManifest, b: SpaceManifest): boolean =>
  manifestText({ ...a, written_by: "0.0.0" }) === manifestText({ ...b, written_by: "0.0.0" });

/**
 * Writes `space.json` atomically. A manifest over MANIFEST_MAX_BYTES is refused, because a reader
 * would find it damaged.
 */
export function writeManifest(folder: string, manifest: SpaceManifest, io: FileIo = NODE_IO): void {
  const text = manifestText(manifest);
  if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) {
    throw new StorageError("SPACE_INVALID", "The space's manifest would exceed its size limit");
  }
  writeFileAtomic(folder, MANIFEST_FILE, text, io);
}
