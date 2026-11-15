// Explicit edits to machine.toml (A2 3.2.4: "one module that keeps comments and unknown keys").
// The file is the person's: Tasks never rewrites it whole. Each edit is one splice in the file's
// own style (its line breaks, a byte order mark kept), placed by scan.ts, and is accepted only when
// the edited text parses to exactly the document before it plus the intended change. Anything
// else, such as a table written as an inline table or through dotted keys, is refused with a typed
// reason and nothing is written.
//
// Writing: the bytes are read, edited, read again just before the write and compared, so a change
// the person saved meanwhile is never overwritten (`changed_meanwhile`), then replaced atomically.
//
// Who may edit: approvals and instances are user-only operations (A4 3.2 step 4, R7). The caller
// (the UI session or an interactive CLI, A2 3.6.5) checks that; this module only writes.
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasControl, isTable } from "@tasks/launch";
import { atomicWrite, makeDir } from "../hub/files.ts";
import { loadMachineConfig, MACHINE_TOML } from "./machine-toml.ts";
import { scanToml, ScanError, type ScannedHeader, type ScannedLine } from "./scan.ts";
import {
  BOM,
  decodeConfig,
  MAX_CONFIG_BYTES,
  parseToml,
  readConfigFile,
  type TomlDocument,
} from "./toml.ts";

/** A value an edit writes: what machine.toml's sections hold. */
export type EditValue =
  string | number | boolean | readonly string[] | Readonly<Record<string, string>>;

export type Entries = ReadonlyMap<string, EditValue> | Readonly<Record<string, EditValue>>;

export type Edit =
  /** Sets `key` in the standard table `[table…]`, adding the table at the end when it is absent. */
  | {
      readonly op: "set";
      readonly table: readonly string[];
      readonly key: string;
      readonly value: EditValue;
    }
  /** Adds an element `[[array]]` after the array's last element, or at the end. */
  | { readonly op: "append"; readonly array: string; readonly entries: Entries }
  /** Adds a new standard table `[table…]` at the end. Refused when it exists. */
  | { readonly op: "add_table"; readonly table: readonly string[]; readonly entries: Entries }
  /**
   * Takes out the one element `[[array]]` that is still exactly as `append` wrote `entries` in
   * this file's line breaks: its header and key lines byte for byte, nothing added to it, with the
   * blank line `append` put before it. Refused `absent` when no element is, so an element the
   * person changed is never removed; `unsupported_layout` when more than one is.
   */
  | { readonly op: "remove"; readonly array: string; readonly entries: Entries };

export type EditRefusal =
  /** The file is not valid TOML (or not UTF-8, or too large): fix it first. */
  | "invalid_file"
  /** The edit cannot be placed in this file's layout without rewriting other text. */
  | "unsupported_layout"
  /** `add_table` of a table that exists. */
  | "exists"
  /** `remove` of an element the file does not hold exactly as it was written. */
  | "absent"
  /** A value that cannot be written (a non-finite number, a control character in a key). */
  | "invalid_value"
  /** The file changed between the read and the write. */
  | "changed_meanwhile"
  /** The edited file would be larger than a configuration file may be, so it could not be read. */
  | "too_large"
  /**
   * The config folder or machine.toml fails the permission rule (another user could change it, it
   * is a link, its owner lacks access): nothing is written into it. `tasks doctor` names the fix.
   */
  | "unsafe";

export type EditResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: EditRefusal };

// ---------------------------------------------------------------------------------------------
// Writing values in TOML

const BARE = /^[A-Za-z0-9_-]+$/u;

function basicString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A string, as a literal string when it holds backslashes (Windows paths read as written). */
function stringValue(text: string): string {
  if (text.includes("\\") && !text.includes("'") && !hasControl(text) && !text.includes("\t")) {
    return `'${text}'`;
  }
  return basicString(text);
}

export function keyText(key: string): string {
  return BARE.test(key) ? key : basicString(key);
}

class InvalidValue extends Error {}

export function valueText(value: EditValue): string {
  if (typeof value === "string") return stringValue(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new InvalidValue();
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value as readonly string[];
    return items.length === 0 ? "[]" : `[${items.map((item) => stringValue(item)).join(", ")}]`;
  }
  const entries = Object.entries(value as Readonly<Record<string, string>>);
  return entries.length === 0
    ? "{}"
    : `{ ${entries.map(([k, v]) => `${keyText(k)} = ${stringValue(v)}`).join(", ")} }`;
}

const entriesOf = (entries: Entries): [string, EditValue][] =>
  entries instanceof Map
    ? [...(entries as ReadonlyMap<string, EditValue>)]
    : Object.entries(entries as Readonly<Record<string, EditValue>>);

/** The value as the parser would return it, for the check of the result. */
function parsedValue(value: EditValue): unknown {
  if (Array.isArray(value)) return [...(value as readonly string[])];
  if (typeof value === "object") return { ...(value as Readonly<Record<string, string>>) };
  return value;
}

// ---------------------------------------------------------------------------------------------
// The intended document

/** `doc` with `value` at `path`, copying only the tables on the way. */
function withValue(doc: TomlDocument, path: readonly string[], value: unknown): TomlDocument {
  const [head, ...rest] = path;
  if (head === undefined) return doc;
  const copy: TomlDocument = { ...doc };
  if (rest.length === 0) copy[head] = value;
  else {
    const inner = copy[head];
    copy[head] = withValue(isTable(inner) ? inner : {}, rest, value);
  }
  return copy;
}

function valueAt(doc: TomlDocument, path: readonly string[]): unknown {
  let at: unknown = doc;
  for (const part of path) {
    if (!isTable(at)) return undefined;
    at = at[part];
  }
  return at;
}

const samePath = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, i) => part === b[i]);

const startsWithPath = (path: readonly string[], prefix: readonly string[]) =>
  path.length >= prefix.length && prefix.every((part, i) => part === path[i]);

// ---------------------------------------------------------------------------------------------
// Placing an edit

interface Layout {
  readonly eol: string;
  readonly lines: readonly ScannedLine[];
}

/** The file's own line break: CRLF when its first line ends with one. */
function eolOf(text: string): string {
  const first = text.indexOf("\n");
  return first > 0 && text.charAt(first - 1) === "\r" ? "\r\n" : "\n";
}

/** Text appended at the end, after a line break the file may lack and one blank line. */
function appendAtEnd(text: string, eol: string, block: string): string {
  if (text === "") return block;
  const ended = text.endsWith("\n") ? text : text + eol;
  return `${ended}${eol}${block}`;
}

/** The lines of the table a header opens: up to the next header. */
function tableLines(lines: readonly ScannedLine[], header: ScannedHeader): ScannedLine[] {
  const at = lines.indexOf(header);
  const out: ScannedLine[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.kind === "header") break;
    out.push(line);
  }
  return out;
}

function blockOf(header: string, entries: [string, EditValue][], eol: string): string {
  return `${header}${eol}${entries.map(([k, v]) => `${keyText(k)} = ${valueText(v)}${eol}`).join("")}`;
}

function place(text: string, layout: Layout, edit: Edit): string | { refused: EditRefusal } {
  const { eol, lines } = layout;
  const headers = lines.filter((l): l is ScannedHeader => l.kind === "header");
  switch (edit.op) {
    case "set": {
      const header = headers.find((h) => !h.array && samePath(h.path, edit.table));
      if (header === undefined) {
        // A new table at the end. Where the table exists without its own header (dotted keys, an
        // inline table), the result does not parse to the intended document and is refused.
        const block = blockOf(
          `[${edit.table.map(keyText).join(".")}]`,
          [[edit.key, edit.value]],
          eol,
        );
        return appendAtEnd(text, eol, block);
      }
      const body = tableLines(lines, header);
      const existing = body.find((l) => l.kind === "keyval" && samePath(l.key, [edit.key]));
      if (existing?.kind === "keyval") {
        return (
          text.slice(0, existing.valueStart) + valueText(edit.value) + text.slice(existing.valueEnd)
        );
      }
      if (body.some((l) => l.kind === "keyval" && l.key[0] === edit.key)) {
        return { refused: "unsupported_layout" };
      }
      const last = body.at(-1);
      const at = last === undefined ? header.end : last.end;
      const before = text.slice(0, at);
      const lead = before === "" || before.endsWith("\n") ? "" : eol;
      return `${before}${lead}${keyText(edit.key)} = ${valueText(edit.value)}${eol}${text.slice(at)}`;
    }
    case "append": {
      const elements = headers.filter((h) => h.array && samePath(h.path, [edit.array]));
      const block = blockOf(`[[${keyText(edit.array)}]]`, entriesOf(edit.entries), eol);
      const lastElement = elements.at(-1);
      // No element yet: at the end. An array written inline fails the check of the result.
      if (lastElement === undefined) return appendAtEnd(text, eol, block);
      // After the element's last line, its sub-tables included, before what documents the next.
      const from = lines.indexOf(lastElement);
      let end = lastElement.end;
      for (const line of lines.slice(from + 1)) {
        if (line.kind === "header" && !startsWithPath(line.path, [edit.array])) break;
        if (line.kind === "header" && samePath(line.path, [edit.array])) break;
        end = line.end;
      }
      const before = text.slice(0, end);
      const lead = before.endsWith("\n") ? "" : eol;
      const after = text.slice(end);
      return `${before}${lead}${eol}${block}${after}`;
    }
    case "add_table": {
      const block = blockOf(`[${edit.table.map(keyText).join(".")}]`, entriesOf(edit.entries), eol);
      return appendAtEnd(text, eol, block);
    }
    case "remove": {
      const found = removal(text, layout, edit);
      return "refused" in found ? found : found.text;
    }
  }
}

/**
 * Where `remove` takes its element out: the one element whose text is exactly the block `append`
 * writes for the entries, with nothing after its key lines but the next header (never a key or a
 * sub-table of its own), and the blank line before it. The element's index is for the check.
 */
function removal(
  text: string,
  layout: Layout,
  edit: Extract<Edit, { op: "remove" }>,
): { text: string; index: number } | { refused: EditRefusal } {
  const { eol, lines } = layout;
  const block = blockOf(`[[${keyText(edit.array)}]]`, entriesOf(edit.entries), eol);
  const keys = entriesOf(edit.entries).length;
  const elements = lines.filter(
    (l): l is ScannedHeader => l.kind === "header" && l.array && samePath(l.path, [edit.array]),
  );
  const matches: { header: ScannedHeader; index: number }[] = [];
  elements.forEach((header, index) => {
    if (!text.startsWith(block, header.start)) return;
    const at = lines.indexOf(header);
    const body = lines.slice(at + 1, at + 1 + keys);
    const next = lines[at + 1 + keys];
    const own =
      body.length === keys &&
      body.every((l) => l.kind === "keyval") &&
      (next === undefined ||
        (next.kind === "header" && !startsWithPath(next.path, [edit.array])) ||
        (next.kind === "header" && samePath(next.path, [edit.array])));
    if (own) matches.push({ header, index });
  });
  const [match, other] = matches;
  if (match === undefined) return { refused: "absent" };
  if (other !== undefined) return { refused: "unsupported_layout" };
  let before = text.slice(0, match.header.start);
  let after = text.slice(match.header.start + block.length);
  // The blank line append put before the element; for the first element of a file, which append
  // wrote without one, the blank line that the next append put after it.
  const lineStart = (s: string) => s === "" || s.endsWith("\n");
  if (before.endsWith(eol) && lineStart(before.slice(0, before.length - eol.length))) {
    before = before.slice(0, before.length - eol.length);
  } else if (before === "" && after.startsWith(eol)) {
    after = after.slice(eol.length);
  }
  return { text: before + after, index: match.index };
}

function intended(doc: TomlDocument, edit: Edit, index = -1): TomlDocument | EditRefusal {
  switch (edit.op) {
    case "remove": {
      const current = doc[edit.array];
      if (!Array.isArray(current)) return "absent";
      const left = (current as unknown[]).filter((_, i) => i !== index);
      // The last element gone: the array is gone from the document too.
      const rest = Object.fromEntries(Object.entries(doc).filter(([key]) => key !== edit.array));
      return left.length === 0 ? rest : { ...rest, [edit.array]: left };
    }
    case "set":
      return withValue(doc, [...edit.table, edit.key], parsedValue(edit.value));
    case "append": {
      const current = doc[edit.array];
      if (current !== undefined && !Array.isArray(current)) return "unsupported_layout";
      const element = Object.fromEntries(
        entriesOf(edit.entries).map(([k, v]) => [k, parsedValue(v)]),
      );
      return { ...doc, [edit.array]: [...((current as unknown[] | undefined) ?? []), element] };
    }
    case "add_table": {
      if (valueAt(doc, edit.table) !== undefined) return "exists";
      const table = Object.fromEntries(
        entriesOf(edit.entries).map(([k, v]) => [k, parsedValue(v)]),
      );
      return withValue(doc, edit.table, table);
    }
  }
}

/** Plain data for comparison: dates as their text, everything else as it is. */
function comparable(value: unknown): unknown {
  if (value instanceof Date) return { date: String(value) };
  if (Array.isArray(value)) return value.map(comparable);
  if (isTable(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, comparable(v)]));
  }
  return value;
}

/**
 * Applies `edits` to machine.toml's text (without its byte order mark), each one checked by parsing
 * the result. Pure: nothing is read or written.
 */
export function applyEdits(text: string, edits: readonly Edit[]): EditResult {
  const first = parseToml(text);
  if (!first.ok) return { ok: false, reason: "invalid_file" };
  let doc = first.doc;
  let current = text;
  for (const edit of edits) {
    let lines: ScannedLine[];
    try {
      lines = scanToml(current);
    } catch (error) {
      if (error instanceof ScanError) return { ok: false, reason: "unsupported_layout" };
      throw error;
    }
    const layout = { eol: eolOf(current), lines };
    let next: string | { refused: EditRefusal };
    let want: TomlDocument | EditRefusal;
    try {
      if (edit.op === "remove") {
        // The element's place decides the intended document: the array without that element.
        const found = removal(current, layout, edit);
        if ("refused" in found) return { ok: false, reason: found.refused };
        next = found.text;
        want = intended(doc, edit, found.index);
        if (typeof want === "string") return { ok: false, reason: want };
      } else {
        want = intended(doc, edit);
        if (typeof want === "string") return { ok: false, reason: want };
        next = place(current, layout, edit);
      }
    } catch (error) {
      if (error instanceof InvalidValue) return { ok: false, reason: "invalid_value" };
      throw error;
    }
    if (typeof next !== "string") return { ok: false, reason: next.refused };
    // The check below parses this string, but the file holds its UTF-8: text UTF-8 cannot carry
    // (a lone surrogate) would be written as something else than was checked.
    if (!next.isWellFormed()) return { ok: false, reason: "invalid_value" };
    const parsed = parseToml(next);
    if (!parsed.ok || !isDeepStrictEqual(comparable(parsed.doc), comparable(want))) {
      return { ok: false, reason: "unsupported_layout" };
    }
    doc = parsed.doc;
    current = next;
  }
  return { ok: true, text: current };
}

/** An edit worked out against the file's bytes as read, not yet written. */
export interface PreparedEdit {
  readonly path: string;
  /** The bytes the edit was made against; undefined when the file did not exist. */
  readonly before: Buffer | undefined;
  /** The whole new file, a byte order mark kept. */
  readonly text: string;
}

/** The file's bytes (bounded, a regular file only), undefined when missing, or a problem. */
function readIfPresent(path: string, maxBytes?: number): Buffer | undefined | "problem" {
  const read = readConfigFile(path, maxBytes);
  if (read.kind === "missing") return undefined;
  return read.kind === "bytes" ? read.bytes : "problem";
}

/** Reads `<config>/machine.toml` and works out `edits` on it. Writes nothing. */
export function prepareEdit(
  configDir: string,
  edits: readonly Edit[],
): { ok: true; edit: PreparedEdit } | { ok: false; reason: EditRefusal } {
  const path = join(configDir, MACHINE_TOML);
  // The service's own rule: nothing is written into a config folder or machine.toml that fails it.
  if (loadMachineConfig(configDir).unsafe !== undefined) return { ok: false, reason: "unsafe" };
  const before = readIfPresent(path);
  if (before === "problem") return { ok: false, reason: "invalid_file" };
  let text = "";
  let bom = false;
  if (before !== undefined) {
    const decoded = decodeConfig(before);
    if (!decoded.ok) return { ok: false, reason: "invalid_file" };
    text = decoded.text;
    bom = decoded.bom;
  }
  const result = applyEdits(text, edits);
  if (!result.ok) return result;
  const whole = `${bom ? BOM : ""}${result.text}`;
  // What is written must read back: the reader refuses a file over the bound, byte order mark
  // included, and that would stop the service.
  if (Buffer.byteLength(whole, "utf8") > MAX_CONFIG_BYTES)
    return { ok: false, reason: "too_large" };
  return { ok: true, edit: { path, before, text: whole } };
}

class ChangedMeanwhile extends Error {}

export interface CommitOptions {
  /** Whether the file or its folder fails the caller's rule. Default: machine.toml's rule. */
  readonly unsafe?: (path: string) => boolean;
  /** The bound of the caller's file, which its read before the write keeps. Default: 1 MiB. */
  readonly maxBytes?: number;
}

/**
 * Writes a prepared edit. The new file is written and flushed beside the old one, then the file is
 * read again just before the rename, and a file that changed since the edit was prepared is left
 * alone (`changed_meanwhile`). What remains is the rename itself: a save in that instant is not
 * seen. Tasks's own edits are synchronous, so two in one process never interleave. The write keeps
 * the file's mode exactly, whatever the umask (it is the person's choice); a missing file is
 * created 0600, and missing folders 0700. The folder and the file are judged again first, as the
 * service judges them: machine.toml is never written into a folder that fails the rule, and never
 * through a link (A2 3.2.4; the reader refuses one, so a link that appeared meanwhile is a
 * change). A caller that edits another file with the same editor (an agent app's configuration,
 * setup/agents.ts) passes its own rule for that file: machine.toml's rule is about the product's
 * own configuration folder and refuses group write, which is the norm for files other apps make.
 */
export function commitEdit(edit: PreparedEdit, options: CommitOptions = {}): EditResult {
  const unchanged = () => {
    const again = readIfPresent(edit.path, options.maxBytes);
    if (again === "problem") return false;
    return edit.before === undefined
      ? again === undefined
      : again !== undefined && edit.before.equals(again);
  };
  const unsafe =
    options.unsafe ?? ((path: string) => loadMachineConfig(dirname(path)).unsafe !== undefined);
  if (unsafe(edit.path)) return { ok: false, reason: "unsafe" };
  if (!unchanged()) return { ok: false, reason: "changed_meanwhile" };
  let mode = 0o600;
  if (edit.before === undefined) makeDir(dirname(edit.path), 0o700);
  else {
    try {
      mode = lstatSync(edit.path).mode & 0o777;
    } catch {
      // Keep 0600.
    }
  }
  try {
    atomicWrite(edit.path, edit.text, mode, () => {
      if (!unchanged()) throw new ChangedMeanwhile();
    });
  } catch (error) {
    if (error instanceof ChangedMeanwhile) return { ok: false, reason: "changed_meanwhile" };
    throw error;
  }
  return { ok: true, text: edit.text };
}

/** Edits `<config>/machine.toml` on disk: prepareEdit, then commitEdit. */
export function editMachineToml(configDir: string, edits: readonly Edit[]): EditResult {
  const prepared = prepareEdit(configDir, edits);
  return prepared.ok ? commitEdit(prepared.edit) : prepared;
}
