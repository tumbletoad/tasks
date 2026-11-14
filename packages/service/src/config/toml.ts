// Reading a TOML configuration file strictly: bounded size, strict UTF-8, TOML 1.0 through
// smol-toml (1.9.1, BSD-3-Clause). A failure is a content-free problem: a parser's message quotes
// the line it stopped at, so only its line and column are kept.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { parse, TomlError } from "smol-toml";
import type { ConfigProblem } from "@tasks/launch";

/** A configuration file larger than this is refused unread (`too_large`). */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * The deepest nesting accepted, counted over the whole parsed document: tables from headers and
 * dotted keys as well as inline arrays and tables. Deeper is `too_large`.
 */
export const MAX_DEPTH = 32;

export type TomlDocument = Record<string, unknown>;

/** U+FEFF, the byte order mark. */
export const BOM = String.fromCharCode(0xfeff);

const fileProblem = (code: ConfigProblem["code"]): ConfigProblem => ({
  key: "",
  code,
  severity: "error",
});

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether the nearest existing ancestor of `path` is something other than a folder. */
function fileOnTheWay(path: string): boolean {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      return !statSync(dir).isDirectory();
    } catch {
      if (dirname(dir) === dir) return false;
    }
  }
}

export type ConfigRead =
  | { readonly kind: "missing" }
  | { readonly kind: "bytes"; readonly bytes: Buffer; readonly stat: Stats }
  | { readonly kind: "problem"; readonly problem: ConfigProblem };

/**
 * Reads a configuration file through one descriptor, bounded: what it is (a regular file) and its
 * size are checked on the descriptor before any byte is read, and at most MAX_CONFIG_BYTES + 1
 * bytes are ever read. On Linux and macOS it is opened non-blocking, so a FIFO in its place cannot
 * hold the caller. A link in its place is never followed (O_NOFOLLOW; on Windows, which has no such
 * flag, the path is looked at first): configuration is read only from a real file
 * (A2 3.2.4). The descriptor's facts come back for the caller's checks.
 * `maxBytes` is another file's bound (an agent app's configuration, setup/agents.ts).
 */
export function readConfigFile(path: string, maxBytes: number = MAX_CONFIG_BYTES): ConfigRead {
  if (process.platform === "win32" && isLink(path)) {
    return { kind: "problem", problem: fileProblem("unreadable") };
  }
  let fd: number;
  try {
    const posixFlags =
      process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | posixFlags);
  } catch (error) {
    // Missing means nothing at all at the path. A link (ELOOP), a dangling one included, or a file
    // in place of a folder on the way (ENOTDIR) is a configuration that cannot be read:
    // the defaults must not stand in for it, and an editor must not replace it.
    // (Windows reports a file on the way as ENOENT, so the nearest existing folder is checked.)
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !isLink(path) && !fileOnTheWay(path)) return { kind: "missing" };
    return { kind: "problem", problem: fileProblem("unreadable") };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "problem", problem: fileProblem("unreadable") };
    if (stat.size > maxBytes) return { kind: "problem", problem: fileProblem("too_large") };
    // The size can change between the stat and the read: read one byte past the bound to know. The
    // buffer starts at the file's size and grows up to that one byte past the bound.
    let buffer = Buffer.alloc(Math.min(maxBytes, stat.size) + 1);
    let length = 0;
    for (;;) {
      if (length === buffer.length) {
        const grown = Buffer.alloc(Math.min(maxBytes + 1, buffer.length * 2));
        buffer.copy(grown);
        buffer = grown;
      }
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
      if (length > maxBytes) {
        return { kind: "problem", problem: fileProblem("too_large") };
      }
    }
    return { kind: "bytes", bytes: buffer.subarray(0, length), stat };
  } catch {
    return { kind: "problem", problem: fileProblem("unreadable") };
  } finally {
    closeSync(fd);
  }
}

/**
 * The text of a configuration file's bytes, or the problem with them. A byte order mark is kept in
 * `bom`, so an editor writes back exactly what it read around its change.
 */
export function decodeConfig(
  bytes: Uint8Array,
): { ok: true; text: string; bom: boolean } | { ok: false; problem: ConfigProblem } {
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    return { ok: false, problem: fileProblem("too_large") };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, problem: fileProblem("encoding") };
  }
  const bom = text.startsWith(BOM);
  return { ok: true, text: bom ? text.slice(1) : text, bom };
}

/** Whether `doc` nests tables and arrays deeper than MAX_DEPTH. Iterative: no stack to exhaust. */
function tooDeep(doc: TomlDocument): boolean {
  const stack: [unknown, number][] = [[doc, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [value, depth] = item;
    if (typeof value !== "object" || value === null || value instanceof Date) continue;
    if (depth > MAX_DEPTH) return true;
    const children = Array.isArray(value) ? (value as unknown[]) : Object.values(value);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return false;
}

/** Parses TOML text. Keys such as `__proto__` are refused, never merged into an object. */
export function parseToml(
  text: string,
): { ok: true; doc: TomlDocument } | { ok: false; problem: ConfigProblem } {
  let doc: TomlDocument;
  try {
    doc = parse(text, { unsafeKeyBehaviour: "throw", maxDepth: MAX_DEPTH });
  } catch (error) {
    const problem: ConfigProblem =
      error instanceof TomlError
        ? { key: "", code: "syntax", severity: "error", line: error.line, column: error.column }
        : fileProblem("syntax");
    return { ok: false, problem };
  }
  // smol-toml's bound covers inline values only; a header or dotted key nests without one.
  if (tooDeep(doc)) return { ok: false, problem: fileProblem("too_large") };
  return { ok: true, doc };
}
