// One member added to or taken out of a JSON object, as a splice in the file's own text: the JSON
// counterpart of machine.toml's editor (config/edit.ts applyEdits), for TTasks's entry in Claude
// Code's and Claude Desktop's files (A3 3.13.2, 3.13.3). Everything else stays byte for byte: other
// members, their order, the file's indentation and line endings (the caller keeps a byte order
// mark, and config/edit.ts commitEdit writes the file with its mode, refusing a file that changed
// meanwhile). An insertion into an empty object replaces the whitespace inside it, which addEntry
// returns (`inner`) so that removeEntry can give it back.
//
// The text is valid JSON already (setup reads it strictly, json.ts), so the locator only needs to
// tell strings, brackets, colons and commas apart. Every result is checked: it must parse to exactly
// the document before it plus, or minus, the one member; anything else is refused and nothing is
// written.
import { isDeepStrictEqual } from "node:util";
import { parseStrictJson } from "./json.ts";

interface Member {
  readonly key: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** An object in the text: its braces and its members in order. */
interface ObjectSpan {
  readonly open: number;
  readonly close: number;
  readonly members: readonly Member[];
}

class Unexpected extends Error {}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

function skipSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && isSpace(text.charAt(i))) i += 1;
  return i;
}

/** The index just past the string that starts at `at` (a `"`). */
function stringEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "\\") i += 1;
    else if (c === '"') return i + 1;
  }
  throw new Unexpected();
}

/** The index just past the value that starts at `at`. Iterative over brackets: no stack to blow. */
function valueEnd(text: string, at: number): number {
  const c = text.charAt(at);
  if (c === '"') return stringEnd(text, at);
  if (c !== "{" && c !== "[") {
    let i = at;
    while (i < text.length && !isSpace(text.charAt(i)) && !",]}".includes(text.charAt(i))) i += 1;
    if (i === at) throw new Unexpected();
    return i;
  }
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    const d = text.charAt(i);
    if (d === '"') i = stringEnd(text, i) - 1;
    else if (d === "{" || d === "[") depth += 1;
    else if (d === "}" || d === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Unexpected();
}

/** The object that starts at `open` (a `{`), with its members. */
function objectAt(text: string, open: number): ObjectSpan {
  if (text.charAt(open) !== "{") throw new Unexpected();
  const members: Member[] = [];
  let i = skipSpace(text, open + 1);
  if (text.charAt(i) === "}") return { open, close: i, members };
  for (;;) {
    if (text.charAt(i) !== '"') throw new Unexpected();
    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipSpace(text, keyEnd);
    if (text.charAt(i) !== ":") throw new Unexpected();
    const valueStart = skipSpace(text, i + 1);
    const end = valueEnd(text, valueStart);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd: end });
    i = skipSpace(text, end);
    if (text.charAt(i) === "}") return { open, close: i, members };
    if (text.charAt(i) !== ",") throw new Unexpected();
    i = skipSpace(text, i + 1);
  }
}

/** The object at `path` below the top-level object, or undefined when a step is missing. */
function objectPath(text: string, path: readonly string[]): ObjectSpan | undefined {
  let object = objectAt(text, skipSpace(text, 0));
  for (const step of path) {
    const member = object.members.find((m) => m.key === step);
    if (member === undefined) return undefined;
    object = objectAt(text, member.valueStart);
  }
  return object;
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

/** The whitespace that starts the line holding `at`, or undefined when other text comes first. */
function indentAt(text: string, at: number): string | undefined {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const lead = text.slice(start, at);
  return /^[ \t]*$/u.test(lead) ? lead : undefined;
}

/** The whitespace that starts the line holding `at`, whatever follows it. */
function lineIndent(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(start, at))?.[0] ?? "";
}

/** The indentation step of a multi-line file: the top-level members' indent, else two spaces. */
function unitOf(text: string): string {
  const top = objectAt(text, skipSpace(text, 0));
  const first = top.members[0];
  const indent = first === undefined ? undefined : indentAt(text, first.keyStart);
  return indent !== undefined && indent !== "" ? indent : "  ";
}

/** `value` as JSON whose lines after the first start with `indent`, in the file's line endings. */
function rendered(value: unknown, unit: string, indent: string, eol: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(`${eol}${indent}`);
}

/** The text with one more member, `key`, at the end of the object at `path`. */
function insertMember(text: string, object: ObjectSpan, key: string, value: unknown): string {
  const eol = eolOf(text);
  const multiLine = text.includes("\n");
  const last = object.members.at(-1);
  if (last !== undefined) {
    const first = object.members[0] ?? last;
    const ownLines = text.slice(object.open, first.keyStart).includes("\n");
    const separator = text.slice(last.keyEnd, last.valueStart);
    if (ownLines) {
      const indent = indentAt(text, last.keyStart);
      if (indent === undefined) throw new Unexpected();
      const parent = lineIndent(text, object.open);
      const unit =
        indent.startsWith(parent) && indent !== parent ? indent.slice(parent.length) : unitOf(text);
      const member = `${JSON.stringify(key)}${separator}${rendered(value, unit, indent, eol)}`;
      return `${text.slice(0, last.valueEnd)},${eol}${indent}${member}${text.slice(last.valueEnd)}`;
    }
    const between =
      object.members.length > 1
        ? text.slice(object.members[0]?.valueEnd, object.members[1]?.keyStart)
        : ", ";
    const member = `${JSON.stringify(key)}${separator}${JSON.stringify(value)}`;
    return `${text.slice(0, last.valueEnd)}${between}${member}${text.slice(last.valueEnd)}`;
  }
  // An empty object: its members go on lines of their own in a multi-line file.
  const before = text.slice(0, object.open);
  const after = text.slice(object.close + 1);
  if (!multiLine) return `${before}{${JSON.stringify(key)}: ${JSON.stringify(value)}}${after}`;
  const parent = lineIndent(text, object.open);
  const unit = unitOf(text);
  const indent = `${parent}${unit}`;
  const member = `${JSON.stringify(key)}: ${rendered(value, unit, indent, eol)}`;
  return `${before}{${eol}${indent}${member}${eol}${parent}}${after}`;
}

/**
 * The text without the member at `index` of `object`: the inverse of insertMember. An object left
 * empty gets `inner` between its braces, the whitespace the insertion replaced.
 */
function deleteMember(text: string, object: ObjectSpan, index: number, inner = ""): string {
  const member = object.members[index];
  if (member === undefined) throw new Unexpected();
  if (object.members.length === 1) {
    return `${text.slice(0, object.open + 1)}${inner}${text.slice(object.close)}`;
  }
  const previous = object.members[index - 1];
  if (previous !== undefined) {
    return `${text.slice(0, previous.valueEnd)}${text.slice(member.valueEnd)}`;
  }
  const next = object.members[index + 1];
  if (next === undefined) throw new Unexpected();
  return `${text.slice(0, member.keyStart)}${text.slice(next.keyStart)}`;
}

export type JsonEdit =
  | {
      readonly ok: true;
      readonly text: string;
      /** addEntry into an empty object: the whitespace that was inside it; else null. */
      readonly inner: string | null;
    }
  | { readonly ok: false; readonly reason: "unsupported_layout" | "invalid_file" };

type Doc = Record<string, unknown>;

const isObject = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The parsed document, when it is a JSON object. */
function docOf(text: string): Doc | undefined {
  const parsed = parseStrictJson(text);
  return parsed.ok && isObject(parsed.value) ? parsed.value : undefined;
}

/** Whether `text` parses to exactly `intended`; the edit is refused otherwise. */
function checked(text: string, intended: Doc, inner: string | null = null): JsonEdit {
  const after = docOf(text);
  return after !== undefined && isDeepStrictEqual(after, intended)
    ? { ok: true, text, inner }
    : { ok: false, reason: "unsupported_layout" };
}

/** The whitespace inside an object that has no member, else null. */
const innerOf = (text: string, object: ObjectSpan): string | null =>
  object.members.length === 0 ? text.slice(object.open + 1, object.close) : null;

/**
 * Adds `key` with `value` to the object `parent` holds at the top level (`mcpServers`), creating
 * that object at the end of the document when it is missing. `key` must not be there yet.
 */
export function addEntry(text: string, parent: string, key: string, value: unknown): JsonEdit {
  const doc = docOf(text);
  if (doc === undefined) return { ok: false, reason: "invalid_file" };
  const servers = doc[parent];
  if (servers !== undefined && (!isObject(servers) || Object.hasOwn(servers, key))) {
    return { ok: false, reason: "unsupported_layout" };
  }
  try {
    const into =
      servers === undefined
        ? objectAt(text, skipSpace(text, 0))
        : (objectPath(text, [parent]) ?? fail());
    const next =
      servers === undefined
        ? insertMember(text, into, parent, { [key]: value })
        : insertMember(text, into, key, value);
    return checked(
      next,
      { ...doc, [parent]: { ...(servers ?? {}), [key]: value } },
      innerOf(text, into),
    );
  } catch (error) {
    if (error instanceof Unexpected) return { ok: false, reason: "unsupported_layout" };
    throw error;
  }
}

/**
 * Takes `key` out of the top-level object `parent`, and `parent` itself when `dropEmptyParent` and
 * nothing else is left in it (setup created it): the inverse of addEntry. An object left empty gets
 * `inner` back, the whitespace addEntry replaced in it.
 */
export function removeEntry(
  text: string,
  parent: string,
  key: string,
  dropEmptyParent: boolean,
  inner: string | null = null,
): JsonEdit {
  const doc = docOf(text);
  if (doc === undefined) return { ok: false, reason: "invalid_file" };
  const servers = doc[parent];
  if (!isObject(servers) || !Object.hasOwn(servers, key)) {
    return { ok: false, reason: "unsupported_layout" };
  }
  const rest = Object.fromEntries(Object.entries(servers).filter(([k]) => k !== key));
  const dropParent = dropEmptyParent && Object.keys(rest).length === 0;
  try {
    const top = objectAt(text, skipSpace(text, 0));
    let next: string;
    if (dropParent) {
      next = deleteMember(
        text,
        top,
        top.members.findIndex((m) => m.key === parent),
        inner ?? "",
      );
    } else {
      const object = objectPath(text, [parent]) ?? fail();
      next = deleteMember(
        text,
        object,
        object.members.findIndex((m) => m.key === key),
        inner ?? "",
      );
    }
    const intended = dropParent
      ? Object.fromEntries(Object.entries(doc).filter(([k]) => k !== parent))
      : { ...doc, [parent]: rest };
    return checked(next, intended);
  } catch (error) {
    if (error instanceof Unexpected) return { ok: false, reason: "unsupported_layout" };
    throw error;
  }
}

function fail(): never {
  throw new Unexpected();
}
