// The probe of lab run A (M0.09): an MCP stdio server that agent CLIs start. Usage:
//   node probe.ts --out <folder> --label <label> [--expect <expect.json>] [--tools echo|a09]
//                 [--delay-ms <n>]   (M0.11: tools/call replies wait n ms)
// It writes one result file per start, `<out>/probe-<label>-<pid>.json`, rewritten after every
// event. Under rule 8 of the step it records only:
// - the NAMES of the variables in WATCHED that are present (never their values), and how many
//   variables it got in all;
// - for TASKS_TICKET, the session and thread IDs and the scratch homes: present or not, equal to
//   the expected value in `--expect` or not, and an ID's format (length and character class);
// - the protocol version and client name the host sent (known labels, else `[other:...]`), the
//   methods that arrived, tool names called, and the key names of each request's `_meta`.
// An ID that has no expectation (a Codex thread ID is only known after the session) is kept as a
// 12-hex SHA-256 prefix in `pending`, which the lab replaces by `equal` before anything is kept.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpResponder, eraOf, textResult, type ToolDef } from "../kit/mcp-stub.ts";
import { KNOWN_CLIENTS, KNOWN_METHODS, KNOWN_VERSIONS, known, version } from "../kit/probe-log.ts";
import {
  LineReader,
  asObject,
  option,
  parseObject,
  sha256Hex,
  type JsonObject,
} from "../kit/wire.ts";
import { errorLabel } from "./facts.ts";

/** Variables whose presence (name only) the probe records. */
export const WATCHED = [
  "TASKS_TICKET",
  "TASKS_TASK",
  "TASKS_SPACE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "T3CODE_THREAD_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MCP_ALLOWLIST_ENV",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CODEX_HOME",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "ENABLE_TOOL_SEARCH",
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "SystemRoot",
  "USER",
  "USERNAME",
  "LANG",
  "TERM",
  "SHELL",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "PATHEXT",
  "ComSpec",
] as const;

/** IDs whose format and match the probe records. */
export const ID_NAMES = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "T3CODE_THREAD_ID",
] as const;

/** Paths compared with the expected scratch home (by equality, never recorded). */
export const HOME_NAMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

/** The request_id rule of A3 3.4.1, as server instructions for A06. ASCII only. */
export const INSTRUCTIONS =
  "Tasks probe for the M0 lab. It offers one tool, probe_echo. " +
  "Rule for request_id: every write needs a request_id of 16 to 64 characters from " +
  "[A-Za-z0-9_-], for example a UUID. Use a new value for every intended change, and the same " +
  "value only to retry the same call. The same ID with the same intent returns the stored result " +
  "marked (replayed); the same ID with a different intent is request_id_conflict.";

/**
 * The first A06 length check: marker words every 10 characters (M001 at 0, M002 at 10, ...),
 * 2,000 in all. The prompt that used it named the sequence, so the answer it gave is a report of
 * the model, not a visibility bound. The random-marker check (`--instructions-file`) replaces it.
 */
export const MARKERS = Array.from(
  { length: 200 },
  (_, i) => `M${String(i + 1).padStart(3, "0")}-----`,
)
  .join(" ")
  .padEnd(2000, "-")
  .slice(0, 2000);

export interface Expect {
  ticket_sha256?: string;
  ids?: Partial<Record<(typeof ID_NAMES)[number], string>>;
  homes_sha256?: Partial<Record<(typeof HOME_NAMES)[number], string>>;
}

/** Length and character class of an ID, never the ID. */
export function idFormat(value: string): { length: number; class: string } {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const cls = uuid
    ? "uuid"
    : /^[0-9a-f]+$/i.test(value)
      ? "hex"
      : /^[A-Za-z0-9_-]+$/.test(value)
        ? "word"
        : "other";
  return { length: value.length, class: cls };
}

/** A `_meta` key name: a protocol-style key is kept, anything else becomes `[other:...]`. */
export function metaKey(key: string): string {
  return /^[A-Za-z0-9._/-]{1,80}$/.test(key) ? key : `[other:${sha256Hex(key).slice(0, 12)}]`;
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** The facts of the start record, from an environment and an expectation. */
export function startFacts(env: NodeJS.ProcessEnv, expect: Expect): JsonObject {
  const present = (name: string) => env[name] !== undefined;
  const ids: JsonObject = {};
  const pending: JsonObject = {};
  for (const name of ID_NAMES) {
    const value = env[name];
    if (value === undefined) {
      ids[name] = { present: false };
      continue;
    }
    const want = expect.ids?.[name];
    ids[name] = {
      present: true,
      equal: want === undefined ? null : value === want,
      format: idFormat(value),
    };
    if (want === undefined) pending[name] = sha256Hex(value).slice(0, 12);
  }
  const homes: JsonObject = {};
  for (const name of HOME_NAMES) {
    const value = env[name];
    const want = expect.homes_sha256?.[name];
    homes[name] =
      value === undefined
        ? { present: false }
        : { present: true, equal: want === undefined ? null : sha256Hex(norm(value)) === want };
  }
  const ticket = env["TASKS_TICKET"];
  return {
    env_present: WATCHED.filter(present),
    env_count: Object.keys(env).length,
    ticket:
      ticket === undefined
        ? { present: false }
        : {
            present: true,
            equal:
              expect.ticket_sha256 === undefined
                ? null
                : sha256Hex(ticket) === expect.ticket_sha256,
          },
    ids,
    homes,
    pending,
  };
}

const ECHO: ToolDef = {
  name: "probe_echo",
  description: "Returns a fixed line from the probe. Harmless, changes nothing.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

/** A09: one tool marked to load upfront (anthropic/alwaysLoad in its _meta), one plain. */
const A09_TOOLS = [
  {
    name: "probe_marked",
    description: "Returns the word heron. Harmless, changes nothing.",
    inputSchema: { type: "object", properties: {} },
    _meta: { "anthropic/alwaysLoad": true },
  },
  {
    name: "probe_plain",
    description: "Returns the word osprey. Harmless, changes nothing.",
    inputSchema: { type: "object", properties: {} },
  },
] as unknown as ToolDef[];

function main(): void {
  const args = process.argv.slice(2);
  const out = option(args, "--out");
  const label = option(args, "--label") ?? "probe";
  if (out === undefined || !/^[A-Za-z0-9._-]{1,60}$/.test(label)) {
    process.stderr.write("Usage: probe --out <folder> --label <label> [--expect <file>]\n");
    process.exit(64);
  }
  const expectFile = option(args, "--expect");
  const expect = (
    expectFile === undefined ? {} : JSON.parse(readFileSync(expectFile, "utf8"))
  ) as Expect;
  const toolsArg = option(args, "--tools");
  const tools =
    toolsArg === "a09"
      ? A09_TOOLS
      : toolsArg === "a09-unmarked"
        ? A09_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }))
        : [ECHO];
  const known_tools = new Set(tools.map((t) => t.name));
  mkdirSync(out, { recursive: true });
  const file = join(out, `probe-${label}-${String(process.pid)}.json`);

  const record: JsonObject = {
    label,
    platform: process.platform,
    // PIDs only (no names): A03 to A05 count bridges per thread or conversation by them.
    pid: process.pid,
    ppid: process.ppid,
    started: new Date().toISOString(),
    ...startFacts(process.env, expect),
    initialize: null,
    first_era: null,
    methods: {},
    tool_calls: [],
    meta_keys: {},
  };
  const save = () => {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  save();

  // `--instructions-file`: A06's random-marker check (the lab writes the text into its scratch).
  const instructionsFile = option(args, "--instructions-file");
  const respond = createMcpResponder({
    name: "tasks-probe",
    instructions:
      instructionsFile !== undefined
        ? readFileSync(instructionsFile, "utf8")
        : option(args, "--instructions") === "markers"
          ? MARKERS
          : INSTRUCTIONS,
    tools,
    call: (name) => textResult(`probe: ${name} ok`),
  });

  const stdin = new LineReader(process.stdin);
  stdin.pipe(
    (line) => {
      const msg = parseObject(line);
      if (msg === undefined) return;
      const method = msg["method"];
      if (typeof method === "string") {
        const label = known(method, KNOWN_METHODS) ?? "[none]";
        const methods = record["methods"] as JsonObject;
        methods[label] = ((methods[label] as number | undefined) ?? 0) + 1;
        record["first_era"] ??= eraOf(msg);
        const params = asObject(msg["params"]) ?? {};
        if (method === "initialize") {
          const client = asObject(params["clientInfo"]);
          record["initialize"] = {
            protocol_version: known(params["protocolVersion"], KNOWN_VERSIONS),
            client: known(client?.["name"], KNOWN_CLIENTS),
            client_version: version(client?.["version"]),
          };
        }
        const meta = asObject(params["_meta"]);
        if (meta !== undefined) {
          const keys = record["meta_keys"] as JsonObject;
          const list = new Set((keys[label] as string[] | undefined) ?? []);
          for (const key of Object.keys(meta)) list.add(metaKey(key));
          keys[label] = [...list].sort();
          // An ID-like string value in _meta: record its key, format and (hashed) match.
          for (const [key, value] of Object.entries(meta)) {
            if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) continue;
            if (/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
            const ids = ((record["meta_ids"] as JsonObject | undefined) ??= {});
            ids[metaKey(key)] = { format: idFormat(value), sha12: sha256Hex(value).slice(0, 12) };
          }
        }
        if (method === "tools/call") {
          const name = params["name"];
          (record["tool_calls"] as string[]).push(
            typeof name === "string" && known_tools.has(name) ? name : "[other]",
          );
        }
        save();
      }
      const reply = respond(msg);
      if (reply === null) return;
      // M0.11: `--delay-ms` holds tool results back, so a cancel lands during a pending call.
      const delay = method === "tools/call" ? Number(option(args, "--delay-ms") ?? "0") : 0;
      const write = () => process.stdout.write(`${JSON.stringify(reply)}\n`);
      if (delay > 0) setTimeout(write, delay);
      else write();
    },
    () => {
      record["ended"] = new Date().toISOString();
      save();
    },
  );
}

// The program's boundary: an error class only, never its message, a path or a stack.
if (process.argv[1] !== undefined && /probe\.(ts|mjs)$/.test(process.argv[1])) {
  const fail = (error: unknown) => {
    process.stderr.write(`probe: error ${errorLabel(error)}\n`);
    process.exit(70);
  };
  process.on("uncaughtException", fail);
  try {
    main();
  } catch (error) {
    fail(error);
  }
}
