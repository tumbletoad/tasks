// How a file name reaches SQLite (A1 3.19). The rule: every
// file name this package hands SQLite goes through literalPath, which makes it one literal
// file-system path, and SQLite receives it only as the file: URI that sqliteUri builds from that
// path, so SQLite opens exactly that file. A writer's claim (worker/client.ts) is computed from
// literalPath's result too, so the claim and SQLite name the same file. No caller's string is read
// as a URI: a leading `file:`, `?`, `#` and `%` are characters of a path. A backup's destination
// takes the same road (backupTarget), and SQL cannot name a file at all (node-sqlite.ts).
//
// The URI opens a path with an explicit mode: `rw` fails on a missing file, `rwc` creates it, `ro`
// only reads. It has no authority and every byte that is not unreserved is percent-encoded, so
// SQLite decodes exactly the path it was given: spaces, #, %, ? and non-ASCII characters, Windows
// backslashes, UNC paths (which a file://server/ URI would turn into an authority SQLite refuses)
// and Windows extended paths (\\?\C:\…, which pathToFileURL drops the prefix of).
import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import { MEMORY } from "./driver.ts";
import { misuse, StorageError } from "./errors.ts";
import { createEmptyFile, FILE_MODE } from "./files.ts";
import { windowsComponentProblem } from "./space-path.ts";

export type OpenMode = "ro" | "rw" | "rwc";

/**
 * The longest plain Windows path SQLite can open: MAX_PATH (260) less the terminating NUL and
 * the longest suffix SQLite adds for its own files ("-journal").
 */
export const WINDOWS_PLAIN_PATH_LIMIT = 260 - 1 - "-journal".length;

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** Percent-encodes the UTF-8 bytes of `text`, leaving only unreserved characters as they are. */
function percentEncode(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const char = String.fromCharCode(byte);
    out +=
      byte < 0x80 && UNRESERVED.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** A Windows root in a device namespace: \\?\C:\, \\?\UNC\, \\.\C:\. */
const DEVICE_ROOT = /^\\\\[?.]\\/;
/** A UNC root, \\server\share\: its server and share are parts like any other. */
const UNC_ROOT = /^\\\\([^\\]+)\\([^\\]+)\\?$/;

/**
 * The one literal path SQLite acts on for `path`: resolved against the process's working folder,
 * so it is absolute and holds no `.` or `..` part, and a relative path means the same file to
 * every thread that uses the result. On Windows every part of it must be a name Windows keeps as
 * written (space-path.ts): no trailing dot or space, which Windows drops, no colon, which names a
 * stream, no ? or *, which are wildcards, no other reserved or control character, and no device
 * name (NUL, CON, COM1 …), which opens the device. The result is its own literal path. MEMORY
 * names no file and comes back as it is. Anything else is STORAGE_MISUSE before any file is
 * touched, and the message never quotes the path.
 */
export function literalPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw misuse("A database path is a non-empty string without NUL");
  }
  if (path === MEMORY) return path;
  if (platform !== "win32") return posix.resolve(path);
  const resolved = win32.resolve(path);
  const { root } = win32.parse(resolved);
  const unc = DEVICE_ROOT.test(root) ? null : UNC_ROOT.exec(root);
  const parts = resolved
    .slice(root.length)
    .split("\\")
    .filter((part) => part !== "");
  for (const part of unc === null ? parts : [unc[1] ?? "", unc[2] ?? "", ...parts]) {
    const problem = windowsComponentProblem(part);
    if (problem !== undefined) {
      throw misuse(`A database path on Windows has ${problem}`);
    }
  }
  return resolved;
}

/**
 * A Windows path SQLite can open. SQLite does not add the extended prefix itself, so a path beyond
 * MAX_PATH moves into the \\?\ namespace (\\?\UNC\ for a UNC path). That namespace skips Windows'
 * own normalisation, so the path is resolved first. Shorter paths, and paths already in a device
 * namespace (\\?\ or \\.\), stay as they are.
 */
export function windowsLongPath(path: string): string {
  if (path.startsWith("\\\\?\\") || path.startsWith("\\\\.\\")) return path;
  const full = win32.resolve(path);
  if (full.length <= WINDOWS_PLAIN_PATH_LIMIT) return path;
  return full.startsWith("\\\\") ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
}

/**
 * The URI that opens literalPath(`path`) in `mode` on `platform`: the only form in which a driver
 * hands SQLite a file name. MEMORY stays MEMORY.
 */
export function sqliteUri(
  path: string,
  mode: OpenMode,
  platform: NodeJS.Platform = process.platform,
): string {
  const literal = literalPath(path, platform);
  if (literal === MEMORY) return MEMORY;
  const native = platform === "win32" ? windowsLongPath(literal) : literal;
  return `file:${percentEncode(native)}?mode=${mode}`;
}

/** A backup's destination already exists: a backup writes only a new file (A1 3.18). */
export const destinationExists = (): StorageError =>
  misuse("A backup writes a new file: its destination exists");

/** A backup's destination could not be created: its folder is missing or not writable. */
export const destinationNotCreated = (): StorageError =>
  new StorageError("STORAGE_CANT_OPEN", "A backup's destination file cannot be created");

/**
 * Makes literalPath(`path`) the new file a backup writes, and returns the URI SQLite writes it
 * through. A backup writes only a new file (A1 3.18 backs up into a temporary file): the file is
 * created here, exclusively and owner-only, or it is an empty regular file with no other name,
 * which a caller created for this backup (a storage worker's claim does, worker/client.ts).
 * Anything else stays as it is and is refused with STORAGE_MISUSE: a database, any file with
 * content, a file with a second name, a symbolic link. So a backup never writes into a file that
 * has, or had, another name. A failed backup leaves its destination as SQLite left it, for the
 * caller, which uses a new temporary name for its next attempt. MEMORY stays MEMORY.
 */
export function backupTarget(path: string): string {
  const literal = literalPath(path);
  if (literal === MEMORY) return MEMORY;
  try {
    createEmptyFile(literal, FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw destinationNotCreated();
    let fresh = false;
    try {
      const stats = lstatSync(literal);
      fresh = stats.isFile() && stats.size === 0 && stats.nlink === 1;
    } catch {
      // Gone again, or unreadable: not a file this backup may write.
    }
    if (!fresh) throw destinationExists();
  }
  return sqliteUri(literal, "rw");
}
