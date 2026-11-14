// The key-level configuration record of lab run A (M0.09, A7 3.7 lab rules). It reads a scratch
// home's configuration files and lists their KEYS, never their values, plus a SHA-256 of every
// file in the home. `compareRecords` then proves "restored exactly": the same files with the same
// bytes before a registration and after its removal, and the same keys and value hashes in every
// configuration file the caller names as affected (a named file that is in neither record makes
// "restored" false: the comparison cannot vouch for it).
//
// `entryRecord` is the backup of a registration in a real home (A3 3.13.1): the key paths
// Tasks's registration adds or changes, each with its previous value or its absence, and the
// file's hash for the concurrency check. No other value of the file is copied.
//
// The real homes on the Windows lab machine are compared by key NAMES only, of exactly two places (rule 4 of
// the step): the user-scope `mcpServers` of `~/.claude.json` and the `[mcp_servers.*]` tables of
// `~/.codex/config.toml`. Nothing else in those files is read into the record, and sign-in files
// are never opened.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** Configuration files parsed by key in any home. Sign-in files are never in this list. */
export const CONFIG_FILES = [
  ".claude.json",
  "settings.json",
  "config.toml",
  "claude_desktop_config.json",
] as const;

/** The lab's own marker file (scratch.ts): never part of a home's record. */
const LAB_MARKER = ".tasks-lab-owner";

/** Files that are never opened, whatever folder they are in. */
export const NEVER_OPEN = new Set([".credentials.json", "auth.json"]);

export interface FileRecord {
  sha256: string;
  bytes: number;
  keys: string[];
  /** A 12-hex SHA-256 of each key's value, so a changed value shows by key name only. */
  values: Record<string, string>;
}

export interface HomeRecord {
  /** Every file in the home (relative path), so new files show up even when not parsed. */
  files: string[];
  /** A SHA-256 of every file's bytes (a sign-in file is never opened: a fixed label instead). */
  hashes: Record<string, string>;
  /** Parsed configuration files present: CONFIG_FILES and every file the caller named. */
  config: Record<string, FileRecord>;
  /** The files the caller named as affected. */
  named: string[];
}

/** Key paths of a JSON value with their values: objects are walked, arrays and scalars are leaves. */
export function jsonEntries(value: unknown, prefix = ""): [string, unknown][] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    entries.push([path, child], ...jsonEntries(child, path));
  }
  return entries;
}

export const jsonKeys = (value: unknown): string[] => jsonEntries(value).map(([k]) => k);

/** A dotted TOML key, part by part: quotes go, except around a part that holds a dot. */
const tomlKey = (raw: string) =>
  (raw.match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? [])
    .map((part) => {
      const inner = part.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      return inner.includes(".") ? `"${inner}"` : inner;
    })
    .join(".");

/**
 * Key paths of a TOML file, line by line: `[table]` and `[[array]]` headers and `key = value`
 * lines. Enough for the simple files Codex writes. Multi-line values are skipped, not parsed.
 */
export function tomlEntries(text: string): [string, string][] {
  const keys: [string, string][] = [];
  let table = "";
  let inMultiline: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inMultiline !== null) {
      if (line.includes(inMultiline)) inMultiline = null;
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header?.[1] !== undefined) {
      table = tomlKey(header[1]);
      keys.push([table, ""]);
      continue;
    }
    const pair =
      /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=\s*(.*)$/.exec(
        line,
      );
    if (pair?.[1] === undefined) continue;
    const key = tomlKey(pair[1]);
    const value = pair[2] ?? "";
    keys.push([table === "" ? key : `${table}.${key}`, value]);
    for (const quote of ['"""', "'''"]) {
      if (value.startsWith(quote) && value.indexOf(quote, 3) === -1) inMultiline = quote;
    }
  }
  return keys;
}

export const tomlKeys = (text: string): string[] => tomlEntries(text).map(([k]) => k);

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else if (name !== LAB_MARKER) out.push(relative(root, full).split("\\").join("/"));
  }
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The key-level record of one home: every file with a hash of its bytes, and the keys (with a
 * hash per value) of CONFIG_FILES and of every file in `named` (paths relative to the home).
 */
export function recordHome(home: string, named: readonly string[] = []): HomeRecord {
  const files: string[] = [];
  if (existsSync(home)) walk(home, home, files);
  files.sort();
  const hashes: Record<string, string> = {};
  for (const rel of files) {
    hashes[rel] = NEVER_OPEN.has(baseName(rel))
      ? "[never opened]"
      : sha256Hex(readFileSync(join(home, rel)));
  }
  const config: Record<string, FileRecord> = {};
  for (const name of new Set<string>([...CONFIG_FILES, ...named])) {
    const record = recordHomeFile(join(home, name), name);
    if (record !== undefined) config[name] = record;
  }
  return { files, hashes, config, named: [...named] };
}

/** Keys and value hashes of one configuration file; undefined when absent or never opened. */
function recordHomeFile(path: string, name: string): FileRecord | undefined {
  if (!existsSync(path) || NEVER_OPEN.has(baseName(name))) return undefined;
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  let entries: [string, string][];
  if (name.endsWith(".toml")) entries = tomlEntries(text);
  else {
    try {
      entries = jsonEntries(JSON.parse(text)).map(([k, v]) => [k, JSON.stringify(v)]);
    } catch {
      entries = [["[unparsable]", ""]];
    }
  }
  const values: Record<string, string> = {};
  for (const [k, v] of entries) values[k] = sha256Hex(v).slice(0, 12);
  const keys = entries.map(([k]) => k).sort();
  return { sha256: sha256Hex(bytes), bytes: bytes.length, keys, values };
}

/**
 * The key-level record of named files only, for a real home (a profile folder must never be
 * walked): the same shape as `recordHome`, with `files` and `hashes` limited to `named`.
 */
export function recordFiles(dir: string, named: readonly string[]): HomeRecord {
  const files = named.filter((n) => existsSync(join(dir, n))).sort();
  const hashes: Record<string, string> = {};
  for (const rel of files) {
    hashes[rel] = NEVER_OPEN.has(baseName(rel))
      ? "[never opened]"
      : sha256Hex(readFileSync(join(dir, rel)));
  }
  const config: Record<string, FileRecord> = {};
  for (const name of files) {
    const record = recordHomeFile(join(dir, name), name);
    if (record !== undefined) config[name] = record;
  }
  return { files, hashes, config, named: [...named] };
}

export interface Comparison {
  restored: boolean;
  files_added: string[];
  files_removed: string[];
  keys_added: Record<string, string[]>;
  keys_removed: Record<string, string[]>;
  /** Keys present before and after whose value changed (names only). */
  values_changed: Record<string, string[]>;
  /** Per parsed or named file present in either record: the same bytes before and after. */
  bytes_equal: Record<string, boolean>;
  /** Files present before and after whose bytes differ (any file in the home). */
  files_changed: string[];
  /** Named files present in neither record: not compared, so not vouched for. */
  missing: string[];
}

/**
 * Before against after: `restored` only when the same files exist with the same bytes, every
 * parsed or named file has the same bytes, and every named file was in the comparison.
 */
export function compareRecords(before: HomeRecord, after: HomeRecord): Comparison {
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const result: Comparison = {
    restored: true,
    files_added: diff(after.files, before.files),
    files_removed: diff(before.files, after.files),
    keys_added: {},
    keys_removed: {},
    values_changed: {},
    bytes_equal: {},
    files_changed: before.files.filter(
      (f) => after.hashes[f] !== undefined && after.hashes[f] !== before.hashes[f],
    ),
    missing: [],
  };
  for (const name of new Set([...before.named, ...after.named])) {
    if (before.config[name] === undefined && after.config[name] === undefined) {
      result.missing.push(name);
    }
  }
  const names = new Set([...Object.keys(before.config), ...Object.keys(after.config)]);
  for (const name of names) {
    const b = before.config[name];
    const a = after.config[name];
    result.bytes_equal[name] = a !== undefined && b !== undefined && a.sha256 === b.sha256;
    const added = diff(a?.keys ?? [], b?.keys ?? []);
    const removed = diff(b?.keys ?? [], a?.keys ?? []);
    if (added.length > 0) result.keys_added[name] = added;
    if (removed.length > 0) result.keys_removed[name] = removed;
    const changed = (b?.keys ?? []).filter(
      (k) => a?.values[k] !== undefined && a.values[k] !== b?.values[k],
    );
    if (changed.length > 0) result.values_changed[name] = changed;
    if (!result.bytes_equal[name]) result.restored = false;
  }
  if (
    result.files_added.length > 0 ||
    result.files_removed.length > 0 ||
    result.files_changed.length > 0 ||
    result.missing.length > 0
  ) {
    result.restored = false;
  }
  return result;
}

export interface EntryRecord {
  /** SHA-256 of the file's bytes, or null when the file does not exist. */
  sha256: string | null;
  /** Per key path: present or not and, when present, its value (JSON value, or TOML raw text). */
  entries: Record<string, { present: boolean; value?: unknown }>;
}

/**
 * The entry-level backup of a registration (A3 3.13.1): only `keyPaths` (Tasks's
 * own keys), each with its value or its absence, and the hash of the whole file. Taken before the
 * change and again after it. The undo restores exactly these entries, and only while the file's
 * hash still equals the "after" hash. Never a copy of the file, never another key's value.
 */
export function entryRecord(file: string, keyPaths: readonly string[]): EntryRecord {
  const entries: EntryRecord["entries"] = {};
  if (!existsSync(file) || NEVER_OPEN.has(baseName(file))) {
    for (const k of keyPaths) entries[k] = { present: false };
    return { sha256: null, entries };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString("utf8");
  const found = new Map<string, unknown>(
    file.endsWith(".toml") ? tomlEntries(text) : jsonEntries(JSON.parse(text)),
  );
  for (const k of keyPaths) {
    entries[k] = found.has(k) ? { present: true, value: found.get(k) } : { present: false };
  }
  return { sha256: sha256Hex(bytes), entries };
}

/** The keys a registration added: `after` minus `before`, per file. */
export function addedKeys(before: HomeRecord, after: HomeRecord): Record<string, string[]> {
  return compareRecords(before, after).keys_added;
}

export interface RealHomeKeys {
  claude_user_mcp_servers: string[] | null;
  claude_project_count: number | null;
  claude_project_entry_for_work: boolean | null;
  codex_mcp_servers: string[] | null;
}

/**
 * The real homes, key names only: user-scope `mcpServers` and the number of `projects` in
 * `.claude.json` (and whether `workDir` has a project entry, compared by path, never recorded),
 * and the `[mcp_servers.<name>]` tables of Codex's `config.toml`.
 */
export function realHomeKeys(claudeJson: string, codexToml: string, workDir: string): RealHomeKeys {
  const result: RealHomeKeys = {
    claude_user_mcp_servers: null,
    claude_project_count: null,
    claude_project_entry_for_work: null,
    codex_mcp_servers: null,
  };
  if (existsSync(claudeJson)) {
    const json = JSON.parse(readFileSync(claudeJson, "utf8")) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, unknown>;
    };
    result.claude_user_mcp_servers = Object.keys(json.mcpServers ?? {}).sort();
    const projects = Object.keys(json.projects ?? {});
    result.claude_project_count = projects.length;
    const want = workDir.split("\\").join("/").toLowerCase();
    result.claude_project_entry_for_work = projects.some(
      (p) => p.split("\\").join("/").toLowerCase() === want,
    );
  }
  if (existsSync(codexToml)) {
    const tables = new Set<string>();
    for (const key of tomlKeys(readFileSync(codexToml, "utf8"))) {
      const m = /^mcp_servers\.("[^"]*"|[^.]+)/.exec(key);
      if (m?.[1] !== undefined) tables.add(m[1].replace(/^"(.*)"$/, "$1"));
    }
    result.codex_mcp_servers = [...tables].sort();
  }
  return result;
}
