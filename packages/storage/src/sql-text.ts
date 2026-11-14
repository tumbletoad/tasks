// What a driver needs to know about SQL text without running it: where its parameter placeholders
// are, and whether text is only whitespace, comments and semicolons. node:sqlite does not expose
// sqlite3_bind_parameter_name, so the scanner follows SQLite's own tokenizer (tokenize.c) for
// everything that can hide or hold a placeholder: string literals, quoted names, comments,
// identifiers (which may contain $) and the variable tokens themselves. The node:sqlite driver
// confirms each scan against SQLite (node-sqlite.ts), so a scan that disagrees with SQLite refuses
// the statement instead of binding NULL.
import { misuse } from "./errors.ts";

/** One variable token as SQLite reads it: `?`, `?NNN`, or `$`, `:`, `@` or `#` and a name. */
export interface Placeholder {
  /** Offset of the token in the SQL text. */
  start: number;
  end: number;
  /** The token's text, prefix included. */
  token: string;
}

/** A statement's named parameters: each bare name once, in order of first use. */
export interface NamedParameters {
  names: readonly string[];
  placeholders: readonly (Placeholder & { name: string })[];
}

const DASH = 0x2d;
const SLASH = 0x2f;
const STAR = 0x2a;
const SEMICOLON = 0x3b;
const QUESTION = 0x3f;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const QUOTES = new Set([0x27, 0x22, 0x60]); // ' " `
const VARIABLE_PREFIXES = new Set([0x24, COLON, 0x40, 0x23]); // $ : @ #

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** SQLite's IdChar: ASCII letters and digits, _ and $, and every non-ASCII character. */
const isIdChar = (c: number): boolean =>
  (c >= 0x61 && c <= 0x7a) ||
  (c >= 0x41 && c <= 0x5a) ||
  isDigit(c) ||
  c === 0x5f ||
  c === 0x24 ||
  c >= 0x80;

/** SQLite's sqlite3Isspace: space, \t, \n, \v, \f and \r. Ends a Tcl-style array index. */
const isSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);

/** The tokenizer's CC_SPACE (\v is not one), and a byte-order mark at the start of a token. */
const isBlank = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0xfeff;

/** The end of the quoted token that starts at `i`. A doubled quote is part of the text. */
function quotedEnd(sql: string, i: number, quote: number): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql.charCodeAt(j) === quote) {
      if (sql.charCodeAt(j + 1) !== quote) return j + 1;
      j += 2;
    } else {
      j += 1;
    }
  }
  return sql.length;
}

/** The end of the variable token that starts at `i` (SQLite's CC_DOLLAR and CC_VARALPHA). */
function variableEnd(sql: string, i: number): { end: number; legal: boolean } {
  let named = 0;
  let j = i + 1;
  while (j < sql.length) {
    const c = sql.charCodeAt(j);
    if (isIdChar(c)) {
      named += 1;
      j += 1;
    } else if (c === OPEN_PAREN && named > 0) {
      // A Tcl-style array index: $name(index).
      j += 1;
      while (j < sql.length && !isSpace(sql.charCodeAt(j)) && sql.charCodeAt(j) !== CLOSE_PAREN) {
        j += 1;
      }
      if (sql.charCodeAt(j) !== CLOSE_PAREN) return { end: j, legal: false };
      return { end: j + 1, legal: true };
    } else if (c === COLON && sql.charCodeAt(j + 1) === COLON) {
      j += 2;
    } else {
      break;
    }
  }
  return { end: j, legal: named > 0 };
}

type Token = { kind: "trivia" | "other"; end: number } | { kind: "variable"; end: number };

/** Reads the token at `i`, as far as telling placeholders and trivia from the rest goes. */
function tokenAt(sql: string, i: number): Token {
  const c = sql.charCodeAt(i);
  const next = sql.charCodeAt(i + 1);
  if (isBlank(c)) {
    let j = i + 1;
    while (j < sql.length && isBlank(sql.charCodeAt(j))) j += 1;
    return { kind: "trivia", end: j };
  }
  if (c === DASH && next === DASH) {
    const newline = sql.indexOf("\n", i + 2);
    return { kind: "trivia", end: newline === -1 ? sql.length : newline + 1 };
  }
  if (c === SLASH && next === STAR) {
    const close = sql.indexOf("*/", i + 2);
    return { kind: "trivia", end: close === -1 ? sql.length : close + 2 };
  }
  if (c === SEMICOLON) return { kind: "trivia", end: i + 1 };
  if (QUOTES.has(c)) return { kind: "other", end: quotedEnd(sql, i, c) };
  if (c === OPEN_BRACKET) {
    const close = sql.indexOf("]", i + 1);
    return { kind: "other", end: close === -1 ? sql.length : close + 1 };
  }
  if (c === QUESTION) {
    let j = i + 1;
    while (j < sql.length && isDigit(sql.charCodeAt(j))) j += 1;
    return { kind: "variable", end: j };
  }
  if (VARIABLE_PREFIXES.has(c)) {
    const { end, legal } = variableEnd(sql, i);
    // An illegal token is a syntax error to SQLite: it never binds anything.
    return { kind: legal ? "variable" : "other", end: Math.max(end, i + 1) };
  }
  if (isIdChar(c)) {
    // Keywords, names and numbers. A name may hold $, which then starts no placeholder.
    let j = i + 1;
    while (j < sql.length && isIdChar(sql.charCodeAt(j))) j += 1;
    return { kind: "other", end: j };
  }
  return { kind: "other", end: i + 1 };
}

/** Every variable token in `sql`, in order. */
export function placeholders(sql: string): Placeholder[] {
  const found: Placeholder[] = [];
  let i = 0;
  while (i < sql.length) {
    const token = tokenAt(sql, i);
    if (token.kind === "variable") {
      found.push({ start: i, end: token.end, token: sql.slice(i, token.end) });
    }
    i = token.end;
  }
  return found;
}

/** Whether `sql` holds nothing but whitespace, comments and semicolons. */
export function isTrivia(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    const token = tokenAt(sql, i);
    if (token.kind !== "trivia") return false;
    i = token.end;
  }
  return true;
}

/** A bare parameter name: what an object key binds, and what an error message may show. */
export const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The named parameters of one statement's SQL. Params binds by name (A1 3.19), so `?` and `?NNN`
 * are refused, as are `#name`, names that are not plain identifiers, and one name under two
 * prefixes ($a and :a), which the bindings treat differently.
 */
export function namedParameters(sql: string): NamedParameters {
  const prefixes = new Map<string, string>();
  const named: (Placeholder & { name: string })[] = [];
  for (const placeholder of placeholders(sql)) {
    const prefix = placeholder.token.charAt(0);
    if (prefix === "?") {
      throw misuse("Positional parameters (? and ?NNN) cannot be bound by name: use $name");
    }
    const name = placeholder.token.slice(1);
    if (prefix === "#" || !PARAMETER_NAME.test(name)) {
      throw misuse("A parameter is $name, :name or @name, with a plain identifier as its name");
    }
    const seen = prefixes.get(name);
    if (seen !== undefined && seen !== prefix) {
      throw misuse(`The parameter name ${name} appears with two prefixes`);
    }
    prefixes.set(name, prefix);
    named.push({ ...placeholder, name });
  }
  return { names: [...prefixes.keys()], placeholders: named };
}
