// TTasks's own entry in an agent app's file: the one member of `mcpServers`
// (JSON) or the one `[mcp_servers.<key>]` table (TOML) that TTasks writes, exactly as it intends
// it, spliced into the file's own text and taken out again; every other byte stays. Pure: the
// caller reads and writes the file (agents.ts).
//
// What is TTasks's own is decided against what it intended to write, never against what it read
// back: the whole entry, every key and value, and in TOML no comment inside its table or on the
// line above it. Anything else is the person's, and stays.
import { isDeepStrictEqual } from "node:util";
import { envVar, MCP_SERVER_KEY } from "@ttasks/brand";
import { applyEdits, tableSpan, type EditValue } from "../config/edit.ts";
import { scanToml, ScanError, tomlComments } from "../config/scan.ts";
import { parseToml } from "../config/toml.ts";
import { addEntry, removeEntry } from "./json-edit.ts";
import { parseStrictJson } from "./json.ts";

export type EntryFormat = "json" | "toml";

/** Codex waits 10 s for a server by default; 20 covers a cold bridge start on Windows. */
export const CODEX_STARTUP_TIMEOUT_SEC = 20;

/**
 * The entry TTasks writes to run `argv`: its command and arguments, and for Codex the ticket's
 * variable, which Codex passes on only when an entry names it, and the cold-start
 * allowance. Claude Code reads an entry without `type` as stdio.
 */
export function intendedEntry(
  format: EntryFormat,
  argv: readonly string[],
): Readonly<Record<string, EditValue>> {
  const entry = { command: argv[0] ?? "", args: argv.slice(1) };
  return format === "toml"
    ? { ...entry, env_vars: [envVar("TICKET")], startup_timeout_sec: CODEX_STARTUP_TIMEOUT_SEC }
    : entry;
}

/** What TTasks made around its entry, which its removal gives back. */
export interface Made {
  /** The servers' table (`mcpServers`): TTasks created it, so it goes when it holds nothing else. */
  readonly parent: boolean;
  /**
   * Bytes beside the entry that TTasks's add put or replaced: in TOML the line breaks before its
   * table, in JSON the whitespace that was inside the object it went into when that was empty.
   * Null when there are none, or for an entry an earlier build wrote.
   */
  readonly spacing: string | null;
}

class NotJson extends Error {}

/** `value` as plain JSON data, or NotJson for what JSON cannot hold exactly (a TOML date). */
function plain(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NotJson();
    return value;
  }
  if (Array.isArray(value)) return (value as unknown[]).map(plain);
  if (typeof value !== "object" || value instanceof Date) throw new NotJson();
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
}

/** Whether an entry is exactly `wanted`: the same keys, in any order, and values. */
export function sameEntry(entry: unknown, wanted: unknown): boolean {
  try {
    return entry !== undefined && isDeepStrictEqual(plain(entry), wanted);
  } catch (error) {
    if (error instanceof NotJson) return false;
    throw error;
  }
}

/** TTasks's entry as the file holds it now: absent, or its value. */
function entryIn(format: EntryFormat, servers: string, text: string): unknown {
  const parsed = format === "toml" ? parseToml(text) : parseStrictJson(text);
  if (!parsed.ok) return undefined;
  const doc = "doc" in parsed ? parsed.doc : parsed.value;
  const table = (doc as Record<string, unknown> | null)?.[servers];
  if (typeof table !== "object" || table === null || !Object.hasOwn(table, MCP_SERVER_KEY)) {
    return undefined;
  }
  return (table as Record<string, unknown>)[MCP_SERVER_KEY];
}

/** The last line before `at`, without its line break; "" when there is none. */
function lineBefore(text: string, at: number): string {
  const body = text.slice(0, at);
  if (!body.endsWith("\n")) return "";
  const line = body.slice(0, -1);
  return line.slice(line.lastIndexOf("\n") + 1).replace(/\r$/u, "");
}

/**
 * Whose the entry in `text` is: `own` when it is exactly one of `own` (TTasks's intended entry,
 * and for an earlier build's record the shapes its writers left), and in TOML a table of its own
 * with no comment inside it or on the line right above it; `edited` when it is there otherwise;
 * `absent` when there is none.
 */
export function whoseEntry(
  format: EntryFormat,
  servers: string,
  text: string,
  own: readonly unknown[],
): "own" | "edited" | "absent" {
  const entry = entryIn(format, servers, text);
  if (entry === undefined) return "absent";
  if (!own.some((wanted) => sameEntry(entry, wanted))) return "edited";
  if (format === "json") return "own";
  try {
    const span = tableSpan(scanToml(text), [servers, MCP_SERVER_KEY]);
    if ("refused" in span) return "edited";
    const noted =
      tomlComments(text).some((at) => at >= span.start && at < span.end) ||
      lineBefore(text, span.start).trimStart().startsWith("#");
    return noted ? "edited" : "own";
  } catch (error) {
    if (error instanceof ScanError) return "edited";
    throw error;
  }
}

export type EntryEdit =
  | { readonly ok: true; readonly text: string; readonly made: Made }
  | {
      readonly ok: false;
      readonly reason: "invalid_file" | "unsupported_layout" | "invalid_value";
    };

/** `text` with TTasks's entry added at the end of its servers' table, and what that made. */
export function addOwnEntry(
  format: EntryFormat,
  servers: string,
  text: string,
  entry: Readonly<Record<string, EditValue>>,
): EntryEdit {
  if (format === "json") {
    const parent = (() => {
      const parsed = parseStrictJson(text);
      return !parsed.ok || (parsed.value as Record<string, unknown>)[servers] === undefined;
    })();
    const added = addEntry(text, servers, MCP_SERVER_KEY, entry);
    return added.ok
      ? { ok: true, text: added.text, made: { parent, spacing: added.inner } }
      : { ok: false, reason: added.reason };
  }
  const parsed = parseToml(text);
  if (!parsed.ok) return { ok: false, reason: "invalid_file" };
  const added = applyEdits(text, [
    { op: "add_table", table: [servers, MCP_SERVER_KEY], entries: entry },
  ]);
  if (!added.ok) {
    return {
      ok: false,
      reason: added.reason === "invalid_value" ? "invalid_value" : "unsupported_layout",
    };
  }
  // The table goes at the end: what stands between the old end and its header is the add's.
  const span = tableSpan(scanToml(added.text), [servers, MCP_SERVER_KEY]);
  if ("refused" in span || !added.text.startsWith(text)) {
    return { ok: false, reason: "unsupported_layout" };
  }
  return {
    ok: true,
    text: added.text,
    made: {
      parent: parsed.doc[servers] === undefined,
      spacing: added.text.slice(text.length, span.start),
    },
  };
}

/** `text` without TTasks's entry, giving back what its add made (`made`). */
export function removeOwnEntry(
  format: EntryFormat,
  servers: string,
  text: string,
  made: Made,
): EntryEdit {
  if (format === "json") {
    const removed = removeEntry(text, servers, MCP_SERVER_KEY, made.parent, made.spacing);
    return removed.ok
      ? { ok: true, text: removed.text, made }
      : { ok: false, reason: removed.reason };
  }
  const removed = applyEdits(text, [
    { op: "remove_table", table: [servers, MCP_SERVER_KEY], before: made.spacing },
  ]);
  if (removed.ok) return { ok: true, text: removed.text, made };
  return {
    ok: false,
    reason: removed.reason === "invalid_file" ? "invalid_file" : "unsupported_layout",
  };
}

/** Whether a file holds nothing but what an empty one of its format holds: `{}` in JSON, nothing in TOML. */
export function holdsNothing(format: EntryFormat, text: string): boolean {
  if (format === "toml") return text.trim() === "";
  const parsed = parseStrictJson(text);
  return (
    parsed.ok &&
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    !Array.isArray(parsed.value) &&
    Object.keys(parsed.value).length === 0
  );
}
