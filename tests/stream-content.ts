// The content check for the recorded stream fixtures (A7 3.7, M0.11 and N05). Two layers:
//
// 1. A scan for things that never belong in a fixture: a user name, a host name, a home path, an
//    e-mail address, something shaped like a token or key, an IPv4 or IPv6 address, or any string
//    from a deny-list built at run time from the machine it runs on. Each JSON line is parsed and
//    its decoded keys and values are checked separately (so `\u0040` or `\/home` cannot hide a
//    value, and the camelCase allowance for long field names applies to keys only). Text that is
//    not JSON (a cut final line) is scanned raw and with its JSON escapes decoded.
// 2. The structural assertions (tests/stream-schema.ts): every value of a fixture event must be
//    one its field's treatment can produce, every inventory path a schema path or placeholder,
//    every index field a known kind of value.
//
// Layer 1 cannot recognise an arbitrary private name (a colleague, a customer, a project) in a
// field whose values the structure does not constrain: it only knows shapes and this machine's own
// names. Layer 2 is the guarantee: in the stream fixtures no string field is free.
//
// The deny-list is never written anywhere: findings name the rule, never the value. Used by
// tests/stream-content.test.ts on the committed fixtures.
import { isIPv6 } from "node:net";
import { homedir, hostname, userInfo } from "node:os";
import { basename } from "node:path";
import {
  CLAUDE,
  CODEX,
  NOT_JSON_LINE,
  NOT_OBJECT_LINE,
  TREATMENTS,
  UNKNOWN_EVENT,
  UNKNOWN_VALUE,
  VOCAB,
  allowedPaths,
  checkEventStructure,
  type CliKind,
  type Os,
  type Spec,
} from "./stream-schema.ts";

export interface DenyEntry {
  /** What the value is, for the finding: never the value itself. */
  label: string;
  value: string;
}

/** The machine's own names: user, host, home folder (with its slash and JSON-escape variants). */
export function machineDenyList(env: NodeJS.ProcessEnv = process.env): DenyEntry[] {
  const entries: DenyEntry[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value === undefined) return;
    const v = value.trim();
    if (v.length >= 3) entries.push({ label, value: v });
  };
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    user = undefined;
  }
  add("user name", user);
  add("user name (environment)", env["USERNAME"] ?? env["USER"] ?? env["LOGNAME"]);
  add("host name", hostname());
  add("host name (environment)", env["COMPUTERNAME"] ?? env["HOSTNAME"]);
  const home = homedir();
  add("home folder", home);
  add("home folder, forward slashes", home.replaceAll("\\", "/"));
  add("home folder, JSON-escaped", home.replaceAll("\\", "\\\\"));
  add("home folder name", basename(home));
  return entries;
}

interface Rule {
  label: string;
  test: (s: string) => boolean;
}
const re = (label: string, pattern: RegExp): Rule => ({ label, test: (s) => pattern.test(s) });

/** A literal IPv6 address (full or compressed), checked by Node's own parser. */
function hasIPv6(s: string): boolean {
  for (const m of s.matchAll(
    /(?<![A-Za-z0-9:.])[0-9A-Fa-f:]{2,39}(?:%[A-Za-z0-9]+)?(?![A-Za-z0-9:])/g,
  )) {
    const candidate = m[0].replace(/%.*$/, "");
    if (!/[0-9A-Fa-f]/.test(candidate) || !candidate.includes(":")) continue;
    if (!candidate.includes("::") && candidate.split(":").length !== 8) continue;
    if (isIPv6(candidate)) return true;
  }
  return false;
}

/** Shapes that never belong in a fixture, whatever machine the check runs on. */
export const RULES: readonly Rule[] = [
  re("e-mail address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/),
  re(
    "Windows home path",
    /[A-Za-z]:(?:\\{1,2}|\/)(?:Users|Documents and Settings)(?=$|[\\/"'\s,;)\]}])/i,
  ),
  re("Unix home path", /(?:^|[^A-Za-z0-9])\/(?:home|Users)\/[A-Za-z0-9._-]+/),
  re("root home path", /(?:^|[^A-Za-z0-9])\/root(?=$|[/"'\s,;:)\]}])/),
  re("home shorthand path", /(?:^|[^A-Za-z0-9])~[\\/][A-Za-z0-9._-]/),
  // \\server\share as text, or "\\\\server\\share" inside JSON; never a drive path such as C:\x.
  re("UNC path", /(?:^|["'\s=(,])(?:\\\\){1,2}[A-Za-z0-9._-]+\\{1,2}[A-Za-z0-9$._-]+/),
  re(
    "known token or key prefix",
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/,
  ),
  re("JSON web token", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.?[A-Za-z0-9_-]*/),
  re("bearer credential", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/),
  re("IPv4 address", /(?:^|[^0-9.])(?:\d{1,3}\.){3}\d{1,3}(?:[^0-9.]|$)/),
  { label: "IPv6 address", test: hasIPv6 },
];

/**
 * A run of 32 or more key characters that mixes upper case, lower case and digits: the shape of an
 * API key, a signature or an opaque account or request ID. With `fieldName`, a long camelCase
 * field name such as cacheCreationEphemeral1hInputTokens is allowed (every capital starts a word
 * of at least three characters); a value never gets that allowance.
 */
export function keyShaped(text: string, fieldName = false): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const s = m[0];
    if (!(/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s))) continue;
    if (fieldName && /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]{2,})*$/.test(s)) continue;
    return true;
  }
  return false;
}

/** JSON string escapes decoded, for text that cannot be parsed (a cut final line). */
export function decodeEscapes(text: string): string {
  return text
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([\\/"])/g, "$1")
    .replace(/\\[bfnrt]/g, " ");
}

function scan(s: string, deny: readonly DenyEntry[], fieldName: boolean, found: Set<string>) {
  for (const rule of RULES) if (rule.test(s)) found.add(rule.label);
  if (keyShaped(s, fieldName)) found.add("key-shaped string");
  const lower = s.toLowerCase();
  for (const entry of deny) {
    if (lower.includes(entry.value.toLowerCase())) found.add(`machine ${entry.label}`);
  }
}

const sorted = (found: Set<string>) => [...found].sort();

/**
 * The findings for free text, raw and with JSON escapes decoded. Empty means clean. With
 * `fieldNames`, a long camelCase run is not called key-shaped (for raw JSON text, whose keys and
 * values cannot be told apart; the per-line check of the parsed values has no such allowance).
 */
export function checkContent(
  text: string,
  deny: readonly DenyEntry[],
  fieldNames = false,
): string[] {
  const found = new Set<string>();
  scan(text, deny, fieldNames, found);
  scan(decodeEscapes(text), deny, fieldNames, found);
  return sorted(found);
}

/** The findings for a parsed JSON value: every key and every string value, decoded, separately. */
export function checkJsonContent(value: unknown, deny: readonly DenyEntry[]): string[] {
  const found = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") scan(v, deny, false, found);
    else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        scan(k, deny, true, found);
        visit(x);
      }
    }
  };
  visit(value);
  return sorted(found);
}

/** `claude-print/windows-x.jsonl` -> its CLI and OS, or undefined for any other name. */
export function fixtureKind(rel: string): { cli: CliKind; os: Os } | undefined {
  const m = /^(claude-print|codex-exec)\/(windows|linux)-[a-z0-9-]{1,60}\.jsonl$/.exec(
    rel.replaceAll("\\", "/"),
  );
  return m === null ? undefined : { cli: m[1] as CliKind, os: m[2] as Os };
}

/**
 * Every finding for one stream fixture: the scan of each line's decoded keys and values, the
 * structural assertions of each event, and the scan of a cut final line. Findings carry line
 * numbers and schema names only.
 */
export function checkStreamFixture(
  rel: string,
  text: string,
  deny: readonly DenyEntry[],
): string[] {
  const kind = fixtureKind(rel);
  if (kind === undefined) return ["file name: not a stream fixture name"];
  const out: string[] = [];
  for (const f of checkContent(text, deny, true)) out.push(`file: ${f}`);
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  lines.forEach((line, i) => {
    const at = `line ${String(i + 1)}`;
    if (line === NOT_JSON_LINE || line === NOT_OBJECT_LINE) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      out.push(`${at}: not JSON`);
      return;
    }
    for (const f of checkJsonContent(value, deny)) out.push(`${at}: ${f}`);
    for (const f of checkEventStructure(kind.cli, kind.os, value)) out.push(`${at}: ${f}`);
  });
  if (tail !== "") for (const f of checkContent(tail, deny)) out.push(`final line: ${f}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Inventories (fields-<os>.json): event keys and field paths from the schema, or placeholders.

const JSON_TYPES = ["array", "boolean", "null", "number", "object", "string"];

function inventorySpec(cli: string, key: string): Spec | null | undefined {
  if (key === UNKNOWN_EVENT.type) return null;
  if (cli === "claude-print") {
    if (key.startsWith("result/")) {
      const sub = key.slice("result/".length);
      const ok =
        sub === UNKNOWN_VALUE || (VOCAB["result-subtype"] as readonly string[]).includes(sub);
      return ok ? CLAUDE["result"] : undefined;
    }
    return key !== "result" && Object.hasOwn(CLAUDE, key) ? CLAUDE[key] : undefined;
  }
  if (cli !== "codex-exec") return undefined;
  const [type, item] = key.split(":", 2) as [string, string | undefined];
  const spec = Object.hasOwn(CODEX, type) ? CODEX[type] : undefined;
  if (spec === undefined || item === undefined) return spec;
  const itemSpec = (spec as { obj: Record<string, Spec> }).obj["item"] as
    { cases: Record<string, unknown> } | undefined;
  if (itemSpec === undefined) return undefined;
  return item === UNKNOWN_VALUE || Object.hasOwn(itemSpec.cases, item) ? spec : undefined;
}

function pathOk(path: string, allowed: Set<string>): boolean {
  if (allowed.has(path)) return true;
  const at = path.indexOf("<unknown-");
  if (at < 0) return false;
  const parent = path.slice(0, at).replace(/\.$/, "");
  const rest = path.slice(at);
  return (
    (parent === "" || allowed.has(parent)) && /^<unknown-\d+>(?:\.<unknown-\d+>|\[\])*$/.test(rest)
  );
}

/** The structural findings for one inventory file. */
export function checkInventoryStructure(inventory: unknown): string[] {
  const out: string[] = [];
  if (typeof inventory !== "object" || inventory === null || Array.isArray(inventory)) {
    return ["inventory: not an object"];
  }
  for (const [cli, events] of Object.entries(inventory)) {
    if (cli !== "claude-print" && cli !== "codex-exec") {
      out.push("inventory: unknown CLI key");
      continue;
    }
    for (const [key, info] of Object.entries(events as Record<string, unknown>)) {
      const spec = inventorySpec(cli, key);
      if (spec === undefined) {
        out.push(`${cli}: an event key the schema does not know`);
        continue;
      }
      const allowed = spec === null ? new Set(["type"]) : allowedPaths(spec);
      const e = info as { count?: unknown; fields?: Record<string, unknown> };
      if (!Number.isInteger(e.count) || (e.count as number) < 1) out.push(`${cli} ${key}: count`);
      for (const [path, f] of Object.entries(e.fields ?? {})) {
        if (!pathOk(path, allowed))
          out.push(`${cli} ${key}: a field path the schema does not know`);
        const field = f as { types?: unknown; treatment?: unknown };
        const types = Array.isArray(field.types) ? (field.types as unknown[]) : [];
        const treatments = Array.isArray(field.treatment) ? (field.treatment as unknown[]) : [];
        if (types.length === 0 || !types.every((t) => JSON_TYPES.includes(t as string))) {
          out.push(`${cli} ${key} ${path}: types`);
        }
        if (
          treatments.length === 0 ||
          !treatments.every((t) => (TREATMENTS as readonly unknown[]).includes(t))
        ) {
          out.push(`${cli} ${key} ${path}: treatments`);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Indexes (index-<os>.json): fixed field names and known kinds of value.

export const CANCEL_KINDS = [
  "ctrl-c",
  "ctrl-break",
  "terminate",
  "taskkill-tree",
  "sigint-group",
  "sigterm-group",
] as const;
/** The stderr classes the recordings were sorted into: a fixed list, never the text. */
export const STDERR_CLASSES = [
  "none",
  "other",
  "no_input",
  "model",
  "not_git",
  "interrupted",
  "auth",
  "rate_limit",
  "needs_terminal",
  "max_turns",
  "approval",
  "mcp",
] as const;
export const FINAL_LINE_KINDS = ["complete", "partial-from-run", "cut-by-sanitiser", "empty"];
const LAB_TEXT = /^[A-Za-z0-9 ,;.:()<>/'"_=+-]{1,400}$/;

const INDEX_FIELDS: Record<string, (v: unknown) => boolean> = {
  file: (v) => typeof v === "string" && fixtureKind(v) !== undefined,
  cli: (v) => v === "claude-print" || v === "codex-exec",
  os: (v) => v === "windows" || v === "linux",
  case: (v) => typeof v === "string" && LAB_TEXT.test(v),
  note: (v) => typeof v === "string" && LAB_TEXT.test(v),
  exit: (v) => v === null || Number.isInteger(v),
  signal: (v) => v === null || (typeof v === "string" && /^SIG[A-Z]{2,6}$/.test(v)),
  cancel: (v) => v === null || (CANCEL_KINDS as readonly unknown[]).includes(v),
  escalated_to_force: (v) => v === null || typeof v === "boolean",
  stderr_class: (v) => v === null || (STDERR_CLASSES as readonly unknown[]).includes(v),
  lines: (v) => Number.isInteger(v) && (v as number) >= 0,
  ends_with_newline: (v) => typeof v === "boolean",
  final_line: (v) => FINAL_LINE_KINDS.includes(v as string),
};

/** The structural findings for one index file. */
export function checkIndexStructure(index: unknown): string[] {
  if (!Array.isArray(index)) return ["index: not an array"];
  const out: string[] = [];
  index.forEach((entry, i) => {
    const at = `entry ${String(i + 1)}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      out.push(`${at}: not an object`);
      return;
    }
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      const ok = Object.hasOwn(INDEX_FIELDS, k) ? INDEX_FIELDS[k] : undefined;
      if (ok === undefined) out.push(`${at}: a field the index does not allow`);
      else if (!ok(v)) out.push(`${at}: ${k}`);
    }
  });
  return out;
}
