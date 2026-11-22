// The trust-entry patch and its inverse for lab run L (M0.10, row L10, A4 3.14 and M0-L16).
//
// TTasks's later "Trust in Claude Code" and "Trust in Codex" offers add one key for one folder to
// another app's configuration file and must be able to take it back exactly. Parse and re-serialise
// would lose comments, key order, spacing and line endings, so this is a TEXT-LEVEL patch:
// - a small scanner finds where the key lives (JSON: the member spans of the objects on the way;
//   TOML: the table headers and key lines, outside strings and multi-line values);
// - the change is one splice (offset, the text removed, the text inserted), written in the file's
//   own style (line ending, indentation, colon spacing);
// - the undo record keeps only that splice and the file hashes. It never holds a copy of the file
//   or any other key's value: `removed` is the previous value of TTasks's own key (or the blank
//   inside an empty object), `inserted` is TTasks's own text.
// The undo puts the removed text back while the file's hash still equals the hash after the
// patch, so the bytes come back identical. When the app changed the file since (Claude Code
// rewrites `.claude.json` often), the undo works on the key alone and keeps the app's changes.
//
// Errors carry a fixed code only, never a path or file content.
import { createHash } from "node:crypto";

export class TrustPatchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "LabError";
  }
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A file's bytes as text, strictly: invalid UTF-8 is refused (a lenient decode would replace it
 * and the undo could not give the same bytes back), and a byte order mark is kept as text.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new TrustPatchError("not UTF-8");
  }
}

// ---------------------------------------------------------------------------------------------
// Key spelling, as lab run L observed the CLIs look the folder up (results/<machine>/launch/).

export type Os = "win32" | "posix";

/**
 * Claude Code's `projects` key for a folder: on Windows the folder with every `\` turned into `/`
 * and the case kept exactly as given (the lookup is case-sensitive, a trailing separator does not
 * match); on Linux the path as it is.
 */
export function claudeTrustKey(folder: string, os: Os): string {
  return os === "win32" ? folder.replaceAll("\\", "/") : folder;
}

/**
 * Codex's `[projects.'<key>']` key: the folder as the OS spells it (`\` on Windows), no trailing
 * separator. On Windows Codex matches it without regard to case.
 */
export function codexTrustKey(folder: string): string {
  return folder;
}

// ---------------------------------------------------------------------------------------------
// The undo record.

export interface Splice {
  /** Offset in the file before the patch. */
  at: number;
  /** Text the patch removed there (TTasks's key's previous value, or blank space). */
  removed: string;
  /** Text the patch inserted there (TTasks's own). */
  inserted: string;
}

/** What the patch did, for the undo's key-level path. */
export type Change =
  | "none" // already trusted: nothing written
  | "file" // the file did not exist: created
  | "container" // added the `projects` member (JSON); TOML has none
  | "entry" // added the folder's entry or table
  | "field" // added the trust key inside an existing entry
  | "value"; // replaced the trust key's previous value

export interface TrustUndo {
  kind: "json" | "toml";
  key: string;
  change: Change;
  splices: Splice[];
  sha_before: string | null;
  sha_after: string | null;
  /** For "value": the previous value's text, to put back on the key-level path. */
  previous?: string;
}

export interface PatchResult {
  text: string;
  undo: TrustUndo;
}

export type UndoPath =
  | "nothing to undo"
  | "exact" // the hash matched: splices reversed, bytes identical
  | "file removed" // the patch created the file and nothing changed since
  | "key-level" // the file changed since: only TTasks's key reverted
  | "key gone" // the file changed since and TTasks's key is no longer there
  | "key changed"; // the file changed since and the key no longer holds TTasks's value: left alone

export interface UndoResult {
  /** The file's new text, or null when the file is to be removed. */
  text: string | null;
  path: UndoPath;
}

function applySplices(text: string, splices: readonly Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.at - a.at)) {
    if (out.slice(s.at, s.at + s.removed.length) !== s.removed) {
      throw new TrustPatchError("splice does not match the file");
    }
    out = out.slice(0, s.at) + s.inserted + out.slice(s.at + s.removed.length);
  }
  return out;
}

/** Reverses splices on the text they produced (offsets shift by the earlier splices). */
function reverseSplices(after: string, splices: readonly Splice[]): string {
  const ordered = [...splices].sort((a, b) => a.at - b.at);
  let shift = 0;
  const located = ordered.map((s) => {
    const at = s.at + shift;
    shift += s.inserted.length - s.removed.length;
    return { ...s, at };
  });
  let out = after;
  for (const s of located.reverse()) {
    if (out.slice(s.at, s.at + s.inserted.length) !== s.inserted) {
      throw new TrustPatchError("inserted text not where the patch put it");
    }
    out = out.slice(0, s.at) + s.removed + out.slice(s.at + s.inserted.length);
  }
  return out;
}

const newlineOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
const BOM = "﻿";

// ---------------------------------------------------------------------------------------------
// JSON: a scanner that keeps spans. Strict JSON only (what Claude Code writes); a BOM is allowed.

interface JMember {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  object: JObject | undefined;
}

interface JObject {
  start: number; // the `{`
  end: number; // just after the `}`
  members: JMember[];
}

const WS = new Set([" ", "\t", "\n", "\r"]);

function jsonScan(text: string): JObject {
  let i = text.startsWith(BOM) ? 1 : 0;
  const skip = () => {
    while (i < text.length && WS.has(text.charAt(i))) i++;
  };
  const fail = (): never => {
    throw new TrustPatchError("not strict JSON");
  };
  const str = (): string => {
    const start = i;
    if (text[i] !== '"') fail();
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      i++;
    }
    if (i >= text.length) fail();
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail();
    }
  };
  const value = (): JObject | undefined => {
    skip();
    const c = text[i];
    if (c === "{") return obj();
    if (c === "[") {
      i++;
      skip();
      if (text[i] === "]") {
        i++;
        return undefined;
      }
      for (;;) {
        value();
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return undefined;
        }
        fail();
      }
    }
    if (c === '"') {
      str();
      return undefined;
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i),
    );
    if (m === null) return fail();
    i += m[0].length;
    return undefined;
  };
  const obj = (): JObject => {
    const start = i;
    i++;
    const members: JMember[] = [];
    skip();
    if (text[i] === "}") {
      i++;
      return { start, end: i, members };
    }
    for (;;) {
      skip();
      const keyStart = i;
      const key = str();
      skip();
      if (text[i] !== ":") fail();
      i++;
      skip();
      const valueStart = i;
      const object = value();
      members.push({ key, keyStart, valueStart, valueEnd: i, object });
      skip();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return { start, end: i, members };
      }
      fail();
    }
  };
  skip();
  if (text[i] !== "{") throw new TrustPatchError("the file's top level is not an object");
  const top = obj();
  skip();
  if (i !== text.length) fail();
  return top;
}

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
}

interface JStyle {
  nl: string; // "" when the file is on one line
  unit: string; // one indentation step
  colon: string; // e.g. ": "
  comma: string; // what follows a comma on one line, e.g. " "
}

function jsonStyle(text: string, top: JObject): JStyle {
  const first = top.members[0];
  const multiline =
    first === undefined ? true : text.slice(top.start, first.keyStart).includes("\n");
  const colon =
    first === undefined
      ? ": "
      : text.slice(first.keyStart, first.valueStart).replace(/^"(?:[^"\\]|\\.)*"/, "");
  if (!multiline) {
    const second = top.members[1];
    const comma =
      first === undefined || second === undefined
        ? ""
        : text.slice(first.valueEnd, second.keyStart).replace(/^\s*,/, "");
    return { nl: "", unit: "", colon, comma };
  }
  const unit = first === undefined ? "  " : lineIndent(text, first.keyStart) || "  ";
  return { nl: newlineOf(text), unit, colon, comma: "" };
}

const findMember = (o: JObject, key: string): JMember | undefined => {
  const hits = o.members.filter((m) => m.key === key);
  if (hits.length > 1) throw new TrustPatchError("duplicate key in the file");
  return hits[0];
};

/**
 * The text that adds `member` (already rendered as `"key": value`) to object `o`, in the file's
 * style. `inner` is the indentation of o's members.
 */
function addMemberSplice(
  text: string,
  o: JObject,
  member: string,
  inner: string,
  s: JStyle,
): Splice {
  const last = o.members[o.members.length - 1];
  if (last !== undefined) {
    const sep = s.nl === "" ? `,${s.comma}` : `,${s.nl}${inner}`;
    return { at: last.valueEnd, removed: "", inserted: sep + member };
  }
  // An empty object: replace its inside (blank or nothing) with the member.
  const outer = s.nl === "" ? "" : lineIndent(text, o.start);
  const body = s.nl === "" ? member : `${s.nl}${inner}${member}${s.nl}${outer}`;
  return { at: o.start + 1, removed: text.slice(o.start + 1, o.end - 1), inserted: body };
}

/** The indentation of an object member's own members: as its existing ones, else one step in. */
function innerIndent(text: string, m: JMember, s: JStyle): string {
  if (s.nl === "") return "";
  const first = m.object?.members[0];
  if (first !== undefined && text.slice(m.valueStart, first.keyStart).includes("\n")) {
    return lineIndent(text, first.keyStart);
  }
  return lineIndent(text, m.keyStart) + s.unit;
}

const TRUST_FIELD = "hasTrustDialogAccepted";

function renderEntry(key: string, s: JStyle, indent: string): string {
  const field = `${JSON.stringify(TRUST_FIELD)}${s.colon}true`;
  const body = s.nl === "" ? `{${field}}` : `{${s.nl}${indent}${s.unit}${field}${s.nl}${indent}}`;
  return `${JSON.stringify(key)}${s.colon}${body}`;
}

/** Adds `projects["<key>"].hasTrustDialogAccepted = true` to Claude Code's `.claude.json` text. */
export function patchClaudeJson(text: string | null, key: string): PatchResult {
  if (text === null) {
    const s: JStyle = { nl: "\n", unit: "  ", colon: ": ", comma: "" };
    const out = `{\n  "projects": {\n    ${renderEntry(key, s, "    ")}\n  }\n}\n`;
    return {
      text: out,
      undo: {
        kind: "json",
        key,
        change: "file",
        splices: [],
        sha_before: null,
        sha_after: sha256(out),
      },
    };
  }
  const top = jsonScan(text);
  const s = jsonStyle(text, top);
  const topInner = s.nl === "" ? "" : s.unit;
  const done = (change: Change, splice: Splice | null, previous?: string): PatchResult => {
    const splices = splice === null ? [] : [splice];
    const out = applySplices(text, splices);
    return {
      text: out,
      undo: {
        kind: "json",
        key,
        change,
        splices,
        sha_before: sha256(text),
        sha_after: sha256(out),
        ...(previous === undefined ? {} : { previous }),
      },
    };
  };
  const projects = findMember(top, "projects");
  if (projects === undefined) {
    const inner = topInner + s.unit;
    const value =
      s.nl === ""
        ? `{${renderEntry(key, s, "")}}`
        : `{${s.nl}${inner}${renderEntry(key, s, inner)}${s.nl}${topInner}}`;
    return done(
      "container",
      addMemberSplice(text, top, `"projects"${s.colon}${value}`, topInner, s),
    );
  }
  if (projects.object === undefined) throw new TrustPatchError("projects is not an object");
  const pInner = innerIndent(text, projects, s);
  const entry = findMember(projects.object, key);
  if (entry === undefined) {
    return done(
      "entry",
      addMemberSplice(text, projects.object, renderEntry(key, s, pInner), pInner, s),
    );
  }
  if (entry.object === undefined) throw new TrustPatchError("the folder's entry is not an object");
  const eInner = innerIndent(text, entry, s);
  const field = findMember(entry.object, TRUST_FIELD);
  if (field === undefined) {
    const member = `${JSON.stringify(TRUST_FIELD)}${s.colon}true`;
    return done("field", addMemberSplice(text, entry.object, member, eInner, s));
  }
  const old = text.slice(field.valueStart, field.valueEnd);
  if (old === "true") return done("none", null);
  // Only a plain earlier value is kept in the undo record, never an object, array or text.
  if (old !== "false" && old !== "null") throw new TrustPatchError("unexpected trust value");
  return done("value", { at: field.valueStart, removed: old, inserted: "true" }, old);
}

/** Removes member `m` of object `o` with its separator, so the object stays valid JSON. */
function removeMemberSplice(text: string, o: JObject, m: JMember): Splice {
  const at = o.members.indexOf(m);
  const prev = o.members[at - 1];
  const next = o.members[at + 1];
  if (prev !== undefined) {
    return { at: prev.valueEnd, removed: text.slice(prev.valueEnd, m.valueEnd), inserted: "" };
  }
  if (next !== undefined) {
    return { at: m.keyStart, removed: text.slice(m.keyStart, next.keyStart), inserted: "" };
  }
  return { at: o.start + 1, removed: text.slice(o.start + 1, o.end - 1), inserted: "" };
}

function undoClaudeKeyLevel(text: string, undo: TrustUndo): UndoResult {
  const top = jsonScan(text);
  const projects = findMember(top, "projects");
  const pObj = projects?.object;
  const entry = pObj === undefined ? undefined : findMember(pObj, undo.key);
  const eObj = entry?.object;
  const field = eObj === undefined ? undefined : findMember(eObj, TRUST_FIELD);
  if (
    projects === undefined ||
    pObj === undefined ||
    entry === undefined ||
    eObj === undefined ||
    field === undefined
  ) {
    return { text, path: "key gone" };
  }
  // Someone set the key to another value since: that is theirs now, not TTasks's to take back.
  if (text.slice(field.valueStart, field.valueEnd) !== "true") return { text, path: "key changed" };
  let splice: Splice;
  if (undo.change === "value") {
    splice = {
      at: field.valueStart,
      removed: text.slice(field.valueStart, field.valueEnd),
      inserted: undo.previous ?? "false",
    };
  } else if (undo.change === "field" || eObj.members.length > 1) {
    splice = removeMemberSplice(text, eObj, field);
  } else if ((undo.change === "container" || undo.change === "file") && pObj.members.length === 1) {
    splice = removeMemberSplice(text, top, projects);
  } else {
    splice = removeMemberSplice(text, pObj, entry);
  }
  return { text: applySplices(text, [splice]), path: "key-level" };
}

// ---------------------------------------------------------------------------------------------
// TOML: a line scanner for the tables Codex writes. It knows comments, the four string kinds,
// multi-line strings and arrays, `[table]` and `[[array]]` headers, and dotted keys.

interface TLine {
  start: number; // offset of the line
  end: number; // offset after its line ending
  body: string; // the line without its ending
}

interface THeader {
  line: number;
  parts: string[];
  array: boolean;
}

interface TKey {
  line: number;
  parts: string[];
  /** Absolute offsets of the value's text on that line (single-line values only). */
  valueStart: number;
  valueEnd: number;
  multiline: boolean;
}

interface TomlScan {
  lines: TLine[];
  headers: THeader[];
  /** Keys with the index of their table header (-1 for the root table). */
  keys: (TKey & { table: number })[];
}

function splitLines(text: string): TLine[] {
  const lines: TLine[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    let body = text.slice(pos, nl === -1 ? text.length : nl);
    // Only a CR before an LF is part of the line ending; a CR at the very end stays in the body.
    if (nl !== -1 && body.endsWith("\r")) body = body.slice(0, -1);
    lines.push({ start: pos, end, body });
    pos = end;
  }
  return lines;
}

const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

/** Element `i` of `list`; a missing one is a scanner fault, not a file problem. */
function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new TrustPatchError("scanner index out of range");
  return v;
}

/** The value of a TOML basic string's inside, or undefined when an escape is invalid. */
function decodeBasic(inner: string): string | undefined {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charAt(i);
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = inner.charAt(i + 1);
    const simple = ESCAPES[e];
    if (simple !== undefined) {
      out += simple;
      i++;
      continue;
    }
    const len = e === "u" ? 4 : e === "U" ? 8 : e === "x" ? 2 : 0;
    const hex = inner.slice(i + 2, i + 2 + len);
    if (len === 0 || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return undefined;
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
    out += String.fromCodePoint(cp);
    i += 1 + len;
  }
  return out;
}

/** Reads a dotted key from `s` at `i`: returns its parts and the index after it, or undefined. */
function readKey(s: string, i: number): { parts: string[]; end: number } | undefined {
  const parts: string[] = [];
  for (;;) {
    while (s[i] === " " || s[i] === "\t") i++;
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return undefined;
      const decoded = decodeBasic(s.slice(i + 1, j));
      if (decoded === undefined) return undefined;
      parts.push(decoded);
      i = j + 1;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j === -1) return undefined;
      parts.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (m === null) return undefined;
      parts.push(m[0]);
      i += m[0].length;
    }
    let j = i;
    while (s[j] === " " || s[j] === "\t") j++;
    if (s[j] !== ".") return { parts, end: i };
    i = j + 1;
  }
}

/**
 * A bare TOML 1.0 value, whole: a boolean, an integer (decimal, hex, octal, binary), a float
 * (`inf` and `nan` too), or a date, time or date-time (`T`, `t` or a space before the time). It
 * must end at a space, a tab, a comment or the end of the line.
 */
const DIGITS = String.raw`\d(?:_?\d)*`;
const TIME = String.raw`\d{2}:\d{2}:\d{2}(?:\.\d+)?`;
const BARE_VALUE = new RegExp(
  "^(?:" +
    [
      "true",
      "false",
      String.raw`[+-]?(?:inf|nan)`,
      String.raw`0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*`,
      String.raw`0o[0-7](?:_?[0-7])*`,
      String.raw`0b[01](?:_?[01])*`,
      String.raw`\d{4}-\d{2}-\d{2}(?:[Tt ]${TIME}(?:[Zz]|[+-]\d{2}:\d{2})?)?`,
      TIME,
      String.raw`[+-]?(?:0|[1-9](?:_?\d)*)(?:\.${DIGITS})?(?:[eE][+-]?${DIGITS})?`,
    ].join("|") +
    String.raw`)(?=$|[ \t#])`,
);
const CLOSER: Record<string, string> = { "]": "[", "}": "{" };

/**
 * Scans the rest of a value from `s` at `i`: returns where the value text ends on this line, the
 * brackets left open, an open multi-line string delimiter, if any, and whether a value started.
 * It refuses what it cannot account for, because a misread string or bracket would misplace every
 * table after it: an ordinary string that does not end on its line, a bracket that does not match,
 * and anything but a comment after a complete value (an item at depth 0).
 */
function scanValue(
  s: string,
  i: number,
  stack: readonly string[],
  open: string | null,
): { end: number; stack: string[]; open: string | null; started: boolean } {
  const st = [...stack];
  let end = i;
  let started = st.length > 0 || open !== null;
  let afterItem = false;
  const unreadable = (): never => {
    throw new TrustPatchError("unreadable value");
  };
  /** A new item begins here: at depth 0 only one per value. */
  const begin = () => {
    if (st.length > 0) return;
    if (afterItem) unreadable();
    started = true;
  };
  while (i < s.length) {
    if (open !== null) {
      // A multi-line basic string has escapes (`\"""` does not close it); a literal one has none.
      let close = -1;
      for (let j = i; j < s.length; j++) {
        if (open === '"""' && s[j] === "\\") {
          j++;
          continue;
        }
        if (s.startsWith(open, j)) {
          close = j;
          break;
        }
      }
      if (close === -1) return { end: s.length, stack: st, open, started };
      i = close + 3;
      // A closing run of quotes may be 4 or 5 long; the last three close the string.
      while (s[i] === open[0]) i++;
      open = null;
      end = i;
      if (st.length === 0) afterItem = true;
      continue;
    }
    const c = s.charAt(i);
    if (c === "#") break;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
      begin();
      open = s.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (c === '"' || c === "'") {
      begin();
      i++;
      while (i < s.length && s[i] !== c) i += c === '"' && s[i] === "\\" ? 2 : 1;
      if (i >= s.length) throw new TrustPatchError("unterminated string");
      i++;
      end = i;
      if (st.length === 0) afterItem = true;
      continue;
    }
    if (c === "[" || c === "{") {
      begin();
      st.push(c);
      i++;
      end = i;
      continue;
    }
    const opener = CLOSER[c];
    if (opener !== undefined) {
      if (st.pop() !== opener) throw new TrustPatchError("unbalanced brackets");
      i++;
      end = i;
      if (st.length === 0) afterItem = true;
      continue;
    }
    if (st.length === 0) {
      begin();
      const m = BARE_VALUE.exec(s.slice(i));
      if (m === null) return unreadable();
      i += m[0].length;
      end = i;
      afterItem = true;
      continue;
    }
    // Inside an array or inline table: commas, keys, `=` and bare values.
    i++;
    end = i;
  }
  return { end, stack: st, open, started };
}

function tomlScan(text: string): TomlScan {
  const lines = splitLines(text);
  const headers: THeader[] = [];
  const keys: (TKey & { table: number })[] = [];
  let stack: string[] = [];
  let open: string | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = at(lines, n);
    let body = line.body;
    if (n === 0 && body.startsWith(BOM)) body = ` ${body.slice(1)}`;
    // A carriage return is only allowed as part of a CRLF line ending (TOML 1.0).
    if (body.includes("\r")) throw new TrustPatchError("bare carriage return");
    if (open !== null || stack.length > 0) {
      const r = scanValue(body, 0, stack, open);
      stack = r.stack;
      open = r.open;
      continue;
    }
    const trimmed = body.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const lead = body.length - trimmed.length;
    if (trimmed.startsWith("[")) {
      const array = trimmed.startsWith("[[");
      const k = readKey(body, lead + (array ? 2 : 1));
      if (k === undefined) throw new TrustPatchError("unreadable table header");
      const rest = body.slice(k.end).trimStart();
      const close = array ? "]]" : "]";
      if (!rest.startsWith(close) || !/^\s*(#.*)?$/.test(rest.slice(close.length))) {
        throw new TrustPatchError("unreadable table header");
      }
      headers.push({ line: n, parts: k.parts, array });
      continue;
    }
    const k = readKey(body, lead);
    if (k === undefined) throw new TrustPatchError("unreadable key line");
    let eq = k.end;
    while (body[eq] === " " || body[eq] === "\t") eq++;
    if (body[eq] !== "=") throw new TrustPatchError("unreadable key line");
    let vs = eq + 1;
    while (body[vs] === " " || body[vs] === "\t") vs++;
    const r = scanValue(body, vs, [], null);
    if (!r.started) throw new TrustPatchError("unreadable key line");
    const multiline = r.stack.length > 0 || r.open !== null;
    stack = r.stack;
    open = r.open;
    keys.push({
      line: n,
      parts: k.parts,
      valueStart: line.start + vs,
      valueEnd: line.start + r.end,
      multiline,
      table: headers.length - 1,
    });
  }
  if (open !== null || stack.length > 0) throw new TrustPatchError("unterminated value");
  // The same table or the same key twice: not TOML, so the file is not TTasks's to edit.
  // A table below an array of tables belongs to that array's latest element, so the same header
  // under two elements is not a duplicate.
  const tables = new Set<string>();
  for (const [index, h] of headers.entries()) {
    if (h.array) continue;
    let element = -1;
    for (let a = index - 1; a >= 0; a--) {
      const prev = at(headers, a);
      if (prev.array && prev.parts.every((p, i) => h.parts[i] === p)) {
        element = a;
        break;
      }
    }
    const id = JSON.stringify([element, ...h.parts]);
    if (tables.has(id)) throw new TrustPatchError("duplicate table");
    tables.add(id);
  }
  const seen = new Set<string>();
  for (const k of keys) {
    const id = JSON.stringify([k.table, ...k.parts]);
    if (seen.has(id)) throw new TrustPatchError("duplicate key in the file");
    seen.add(id);
  }
  return { lines, headers, keys };
}

/** A TOML key part for `key`: a literal string when it can be one, else a basic string. */
export function tomlQuote(key: string): string {
  // Code units are enough here: only ASCII characters are escaped, the rest is copied in order.
  const control = (code: number) => code < 0x20 || code === 0x7f;
  let literal = true;
  let esc = "";
  for (let i = 0; i < key.length; i++) {
    const c = key.charAt(i);
    const code = key.charCodeAt(i);
    if (c === "'" || control(code)) literal = false;
    if (c === "\\") esc += "\\\\";
    else if (c === '"') esc += '\\"';
    else if (control(code)) esc += `\\u${code.toString(16).padStart(4, "0")}`;
    else esc += c;
  }
  return literal ? `'${key}'` : `"${esc}"`;
}

const TRUST_LEVEL = "trust_level";

interface TomlEntry {
  scan: TomlScan;
  /** Index into scan.headers of the folder's `[projects.<key>]` table, if there is one. */
  table: number | undefined;
}

function findTomlEntry(text: string, key: string, fold: boolean): TomlEntry {
  const scan = tomlScan(text);
  const same = (a: string) => (fold ? a.toLowerCase() === key.toLowerCase() : a === key);
  // Layouts this patch does not edit: projects as an array of tables, a bare `[projects]` table
  // with dotted keys, or `projects...` keys in the root table. Refused, never guessed.
  for (const h of scan.headers) {
    if (h.parts[0] !== "projects") continue;
    if (h.array || h.parts.length === 1) throw new TrustPatchError("unsupported projects layout");
    if (h.parts.length > 2 && same(at(h.parts, 1))) {
      throw new TrustPatchError("unsupported projects layout");
    }
  }
  for (const k of scan.keys) {
    if (k.table === -1 && k.parts[0] === "projects") {
      throw new TrustPatchError("unsupported projects layout");
    }
  }
  const tables = scan.headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.parts.length === 2 && h.parts[0] === "projects" && same(at(h.parts, 1)));
  if (tables.length > 1) throw new TrustPatchError("duplicate project table");
  return { scan, table: tables[0]?.i };
}

/** The `trust_level` key line of table `table`, if any (a dotted key there is refused). */
function trustKeyOf(scan: TomlScan, table: number): TKey | undefined {
  const inTable = scan.keys.filter((k) => k.table === table);
  if (inTable.some((k) => k.parts[0] === TRUST_LEVEL && k.parts.length > 1)) {
    throw new TrustPatchError("unsupported projects layout");
  }
  const hits = inTable.filter((k) => k.parts.length === 1 && k.parts[0] === TRUST_LEVEL);
  if (hits.length > 1) throw new TrustPatchError("duplicate key in the file");
  if (hits[0]?.multiline === true) throw new TrustPatchError("unsupported projects layout");
  return hits[0];
}

function tomlStringValue(raw: string): string | undefined {
  const m = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(raw);
  if (m === null) return undefined;
  return m[2] ?? decodeBasic(m[1] ?? "");
}

/**
 * Adds `[projects.'<key>'] trust_level = "trusted"` to Codex's `config.toml` text. `fold`: match an
 * existing table without regard to case (Windows, where Codex itself does so).
 */
export function patchCodexToml(text: string | null, key: string, fold = false): PatchResult {
  const line = `${TRUST_LEVEL} = "trusted"`;
  if (text === null) {
    const out = `[projects.${tomlQuote(key)}]\n${line}\n`;
    return {
      text: out,
      undo: {
        kind: "toml",
        key,
        change: "file",
        splices: [],
        sha_before: null,
        sha_after: sha256(out),
      },
    };
  }
  const nl = newlineOf(text);
  const { scan, table } = findTomlEntry(text, key, fold);
  const done = (change: Change, splice: Splice | null, previous?: string): PatchResult => {
    const splices = splice === null ? [] : [splice];
    const out = applySplices(text, splices);
    return {
      text: out,
      undo: {
        kind: "toml",
        key,
        change,
        splices,
        sha_before: sha256(text),
        sha_after: sha256(out),
        ...(previous === undefined ? {} : { previous }),
      },
    };
  };
  if (table === undefined) {
    // A new table at the end, after a blank line, as Codex itself writes tables.
    let prefix = "";
    if (text.length > 0 && !text.endsWith("\n")) prefix += nl;
    if (text.trim().length > 0) prefix += nl;
    const block = `${prefix}[projects.${tomlQuote(key)}]${nl}${line}${nl}`;
    return done("entry", { at: text.length, removed: "", inserted: block });
  }
  const existing = trustKeyOf(scan, table);
  if (existing === undefined) {
    const header = at(scan.lines, at(scan.headers, table).line);
    const ending = header.end === header.start + header.body.length ? nl : "";
    return done("field", { at: header.end, removed: "", inserted: `${ending}${line}${nl}` });
  }
  const old = text.slice(existing.valueStart, existing.valueEnd);
  const value = tomlStringValue(old);
  if (value === "trusted") return done("none", null);
  // Only a plain earlier string is kept in the undo record, never a table or an array.
  if (value === undefined) throw new TrustPatchError("unexpected trust value");
  return done("value", { at: existing.valueStart, removed: old, inserted: '"trusted"' }, old);
}

function undoCodexKeyLevel(text: string, undo: TrustUndo, fold: boolean): UndoResult {
  const { scan, table } = findTomlEntry(text, undo.key, fold);
  const key = table === undefined ? undefined : trustKeyOf(scan, table);
  if (table === undefined || key === undefined) return { text, path: "key gone" };
  // Someone set the key to another value since: that is theirs now, not TTasks's to take back.
  if (tomlStringValue(text.slice(key.valueStart, key.valueEnd)) !== "trusted") {
    return { text, path: "key changed" };
  }
  if (undo.change === "value") {
    const splice = {
      at: key.valueStart,
      removed: text.slice(key.valueStart, key.valueEnd),
      inserted: undo.previous ?? '"untrusted"',
    };
    return { text: applySplices(text, [splice]), path: "key-level" };
  }
  const keyLine = at(scan.lines, key.line);
  const others = scan.keys.filter((k) => k.table === table && k !== key).length;
  const headerLine = at(scan.lines, at(scan.headers, table).line);
  const nextHeader = scan.headers[table + 1];
  const tableEnd = nextHeader === undefined ? text.length : at(scan.lines, nextHeader.line).start;
  // Comments or other keys in the table, or a header that is no longer the one TTasks wrote (a
  // comment on it, another spelling), mean the app or the user wrote there: keep the table.
  const body = text
    .slice(headerLine.end, tableEnd)
    .replace(text.slice(keyLine.start, keyLine.end), "");
  const ownHeader = headerLine.body === `[projects.${tomlQuote(undo.key)}]`;
  // A comment someone put after the key's value stays, as a comment line of its own.
  const tail = keyLine.body.slice(key.valueEnd - keyLine.start).trim();
  const comment = tail.startsWith("#")
    ? `${/^[ \t]*/.exec(keyLine.body)?.[0] ?? ""}${tail}${text.slice(keyLine.start + keyLine.body.length, keyLine.end)}`
    : "";
  if (undo.change === "field" || others > 0 || body.trim() !== "" || !ownHeader || comment !== "") {
    return {
      text: applySplices(text, [
        { at: keyLine.start, removed: text.slice(keyLine.start, keyLine.end), inserted: comment },
      ]),
      path: "key-level",
    };
  }
  // The table holds only TTasks's key: remove the table and the blank line before it.
  let start = headerLine.start;
  const before = text.slice(0, start);
  const blank = /\r?\n(\r?\n)$/.exec(before);
  if (blank?.[1] !== undefined) start -= blank[1].length;
  return {
    text: applySplices(text, [{ at: start, removed: text.slice(start, tableEnd), inserted: "" }]),
    path: "key-level",
  };
}

// ---------------------------------------------------------------------------------------------
// The undo, for both kinds.

/**
 * Undoes a patch on the file's current text (null: the file is gone). While the file's hash equals
 * the hash after the patch, the splices are reversed and the result has exactly the bytes from
 * before (or the file is removed, when the patch created it). Otherwise only TTasks's key reverts.
 */
export function undoTrust(text: string | null, undo: TrustUndo, fold = false): UndoResult {
  if (undo.change === "none") return { text, path: "nothing to undo" };
  if (text === null) return { text: null, path: "key gone" };
  if (sha256(text) === undo.sha_after) {
    if (undo.change === "file") return { text: null, path: "file removed" };
    const before = reverseSplices(text, undo.splices);
    if (sha256(before) !== undo.sha_before)
      throw new TrustPatchError("reversed text has another hash");
    return { text: before, path: "exact" };
  }
  return undo.kind === "json"
    ? undoClaudeKeyLevel(text, undo)
    : undoCodexKeyLevel(text, undo, fold);
}

/**
 * Reads the trust state of `key` from a file's text, read-only: "trusted", "other" (an entry with
 * another value), "absent", or "unreadable".
 */
export function readTrust(
  kind: "json" | "toml",
  text: string | null,
  key: string,
  fold = false,
): "trusted" | "other" | "absent" | "unreadable" {
  if (text === null) return "absent";
  try {
    if (kind === "json") {
      const top = jsonScan(text);
      const entry = findMember(top, "projects")?.object;
      const e = entry === undefined ? undefined : findMember(entry, key)?.object;
      const f = e === undefined ? undefined : findMember(e, TRUST_FIELD);
      if (f === undefined) return "absent";
      return text.slice(f.valueStart, f.valueEnd) === "true" ? "trusted" : "other";
    }
    const { scan, table } = findTomlEntry(text, key, fold);
    const k = table === undefined ? undefined : trustKeyOf(scan, table);
    if (k === undefined) return "absent";
    return tomlStringValue(text.slice(k.valueStart, k.valueEnd)) === "trusted"
      ? "trusted"
      : "other";
  } catch {
    return "unreadable";
  }
}
