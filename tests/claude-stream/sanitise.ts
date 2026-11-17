// Turns a raw recording of Claude Code's print mode (record.ts) into fixture text, and checks
// fixture text. The rule is an allow-list: a string survives only when it is a word of the
// protocol's own vocabulary (VOCAB), the name of a built-in tool, a version or one of the
// recorder's own labels. Every other string becomes a fixture value by its field: an ID a synthetic
// ID (the same within a stream), a path a fixture path, a model, server or tool name a fixture name,
// a time one of a fixed series, text "Fixture text.". Numbers become fixture numbers, except the
// few small ones that say how something went. Field names, the order of the lines and of their
// fields, and the JSON types stay.
//
// So a fixture holds no account, machine, path, prompt, answer, skill or server name of the
// recording: what the check below accepts is exactly what this can write.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_TEXT = "Fixture text.";
export const FIXTURE_WORK = "C:\\fixture\\work";
const FIXTURE_PATH = /^C:\\fixture\\(?:work|path-\d{1,3})$/;
const SYNTHETIC_ID =
  /^(?:00000000-0000-4000-8000-\d{12}|toolu_fixture\d{1,4}|msg_fixture\d{1,4}|req_fixture\d{1,4}|fixture-id-\d{1,4})$/;
const VERSION = /^\d{1,3}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;
const FIXTURE_NAMES = /^fixture-(?:server|model|tool|key)-\d{1,3}$/;
const FIXTURE_TIME = /^2026-01-01T\d\d:\d\d:\d\d\.\d{3}Z$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;

/** Claude Code's built-in tools, and the recorder's stand-in for Tasks' tools. */
export const TOOLS: ReadonlySet<string> = new Set([
  "Task",
  "Agent",
  "AskUserQuestion",
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "ToolSearch",
  "TaskStop",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
  "tasks",
  "probe_echo",
  "mcp__tasks__probe_echo",
]);

/** The protocol's words that a fixture keeps as they were recorded. */
export const VOCAB: ReadonlySet<string> = new Set([
  // Directions and the recorder's own lines.
  "send",
  "recv",
  "recv-text",
  "stderr",
  "mark",
  "exit",
  // Event types and subtypes.
  "user",
  "assistant",
  "system",
  "result",
  "message",
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "tool_reference",
  "rate_limit_event",
  "stream_event",
  "control_request",
  "control_response",
  "control_cancel_request",
  "init",
  "thinking_tokens",
  "permission_denied",
  "background_tasks_changed",
  "task_started",
  "task_updated",
  "task_notification",
  "can_use_tool",
  "interrupt",
  "success",
  "error",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "direct",
  "addRules",
  // Stop and end reasons, states, modes.
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "completed",
  "aborted_tools",
  "aborted_streaming",
  "api_error",
  "pending",
  "connected",
  "failed",
  "needs-auth",
  "allowed",
  "running",
  "killed",
  "stopped",
  "allow",
  "deny",
  "accept",
  "reject",
  "default",
  "manual",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
  "plan",
  "auto",
  "local_bash",
  "local_agent",
  "localSettings",
  "userSettings",
  "projectSettings",
  "session",
  "mode",
  "other",
  "permission-rule",
  "user-rejected",
  "authentication_failed",
  "none",
  "off",
  "on",
  "dynamic",
  "config",
  "user_reject",
  "session-task",
  "builtin",
]);

const ID_KEYS = new Set([
  "id",
  "uuid",
  "session_id",
  "sessionId",
  "tool_use_id",
  "parent_tool_use_id",
  "request_id",
  "requestId",
  "message_id",
  "task_id",
  "run_id",
  "runId",
  "backgroundTaskId",
  "agent_id",
]);
const PATH_KEYS = new Set([
  "cwd",
  "original_cwd",
  "file_path",
  "path",
  "output_file",
  "powershell_path",
  "messaging_socket_path",
  "memory_paths",
  "additional_directories",
]);
const MODEL_KEYS = new Set(["model", "canonicalModel"]);
const TOOL_KEYS = new Set(["tool_name", "toolName", "display_name", "tools", "matches"]);
const SERVER_KEYS = new Set(["name", "server_display_name"]);
const ISO_TIMES = new Set(["timestamp", "credential_expires_at", "resetsAt"]);
const MS_TIMES = new Set(["end_time", "start_time", "lastUsedAt"]);
/** Small numbers that say how something went, kept as they are. */
const KEPT_NUMBERS = new Set(["code", "result_index", "queued_turn_count", "api_error_status"]);

/** Replacement state for one stream, so a value is replaced the same way everywhere in it. */
class Replacer {
  readonly #ids = new Map<string, string>();
  readonly #paths = new Map<string, string>();
  readonly #names = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  #firstIso: number | undefined;
  #firstMs: number | undefined;
  readonly work: string | undefined;

  constructor(work: string | undefined) {
    this.work = work;
  }

  id(value: string): string {
    const known = this.#ids.get(value);
    if (known !== undefined) return known;
    const n = String(this.#ids.size + 1);
    const out = value.startsWith("toolu_")
      ? `toolu_fixture${n}`
      : value.startsWith("msg_")
        ? `msg_fixture${n}`
        : value.startsWith("req_")
          ? `req_fixture${n}`
          : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)
            ? `00000000-0000-4000-8000-${n.padStart(12, "0")}`
            : `fixture-id-${n}`;
    this.#ids.set(value, out);
    return out;
  }

  path(value: string): string {
    if (value === "") return "";
    if (this.work !== undefined && value === this.work) return FIXTURE_WORK;
    const known = this.#paths.get(value);
    if (known !== undefined) return known;
    const out = `C:\\fixture\\path-${String(this.#paths.size + 1)}`;
    this.#paths.set(value, out);
    return out;
  }

  name(kind: string, value: string): string {
    const k = `${kind}\0${value}`;
    const known = this.#names.get(k);
    if (known !== undefined) return known;
    const count = [...this.#names.keys()].filter((key) => key.startsWith(`${kind}\0`)).length;
    const out = `fixture-${kind}-${String(count + 1)}`;
    this.#names.set(k, out);
    return out;
  }

  key(value: string): string {
    if (FIELD_NAME.test(value)) return value;
    const known = this.#keys.get(value);
    if (known !== undefined) return known;
    const out = `fixture-key-${String(this.#keys.size + 1)}`;
    this.#keys.set(value, out);
    return out;
  }

  iso(value: string): string {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return "2026-01-01T00:00:00.000Z";
    this.#firstIso ??= at;
    const offset = Math.max(0, Math.min(at - this.#firstIso, 86_399_000));
    return new Date(Date.UTC(2026, 0, 1) + offset).toISOString();
  }

  ms(value: number): number {
    this.#firstMs ??= value;
    return 1_767_225_600_000 + (value - this.#firstMs);
  }
}

function cleanString(key: string, value: string, r: Replacer): string {
  if (ID_KEYS.has(key)) return r.id(value);
  if (PATH_KEYS.has(key)) return r.path(value);
  if (MODEL_KEYS.has(key)) return r.name("model", value);
  if (TOOL_KEYS.has(key)) return TOOLS.has(value) ? value : r.name("tool", value);
  if (SERVER_KEYS.has(key)) return TOOLS.has(value) ? value : r.name("server", value);
  if (ISO_TIMES.has(key)) return r.iso(value);
  if (key === "claude_code_version" || key === "version") {
    return VERSION.test(value) ? value : "0.0.0";
  }
  if (VOCAB.has(value)) return value;
  return value === "" ? "" : FIXTURE_TEXT;
}

function clean(value: unknown, key: string, r: Replacer): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanString(key, value, r);
  if (typeof value === "number") {
    if (MS_TIMES.has(key)) return r.ms(value);
    if (KEPT_NUMBERS.has(key)) return value;
    return Number.isInteger(value) ? 100 : 0.5;
  }
  if (Array.isArray(value)) return value.map((x) => clean(x, key, r));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
      // A map whose keys are data (paths, model names) keeps its values' treatment by its own key.
      out[r.key(k)] = clean(x, FIELD_NAME.test(k) ? k : key, r);
    }
    return out;
  }
  return null;
}

interface RawLine {
  dir: string;
  ms: number;
  msg: Record<string, unknown>;
}

/** One raw recording as fixture lines. `work` is the case's working folder. */
export function sanitiseRecording(text: string, work: string | undefined): string {
  const r = new Replacer(work);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const raw = JSON.parse(line) as RawLine;
    switch (raw.dir) {
      case "send":
      case "recv":
        out.push(JSON.stringify({ dir: raw.dir, ms: raw.ms, msg: clean(raw.msg, "", r) }));
        break;
      case "mark":
        out.push(
          JSON.stringify({ dir: "mark", ms: raw.ms, msg: { what: String(raw.msg["what"]) } }),
        );
        break;
      case "exit":
        out.push(
          JSON.stringify({
            dir: "exit",
            ms: raw.ms,
            msg: { code: typeof raw.msg["code"] === "number" ? raw.msg["code"] : null },
          }),
        );
        break;
      default:
        // stderr, and a line that was not JSON: its text is the recording's.
        out.push(
          JSON.stringify({
            dir: raw.dir === "stderr" ? "stderr" : "recv-text",
            ms: raw.ms,
            msg: { text: FIXTURE_TEXT },
          }),
        );
    }
  }
  return `${out.join("\n")}\n`;
}

/** The recorder's own labels for its marks: lab text. */
const MARK = /^[a-z][a-z ]{0,60}$/;

/** The findings for one fixture value: every string must be one the sanitiser can write. */
export function checkFixtureValue(value: unknown, key = ""): string[] {
  const out: string[] = [];
  const visit = (v: unknown, k: string): void => {
    if (typeof v === "string") {
      const ok =
        v === "" ||
        v === FIXTURE_TEXT ||
        VOCAB.has(v) ||
        TOOLS.has(v) ||
        (k === "what" && MARK.test(v)) ||
        SYNTHETIC_ID.test(v) ||
        FIXTURE_PATH.test(v) ||
        FIXTURE_NAMES.test(v) ||
        FIXTURE_TIME.test(v) ||
        ((k === "claude_code_version" || k === "version") && VERSION.test(v));
      if (!ok) out.push(`a value the sanitiser cannot write at ${k === "" ? "(top)" : k}`);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, k);
    } else if (typeof v === "object" && v !== null) {
      for (const [name, x] of Object.entries(v)) {
        if (!FIELD_NAME.test(name) && !/^fixture-key-\d{1,3}$/.test(name)) {
          out.push("a field name the sanitiser cannot write");
        }
        visit(x, FIELD_NAME.test(name) ? name : k);
      }
    }
  };
  visit(value, key);
  return [...new Set(out)];
}

/** The findings for one fixture file: each line one object of the fixture form. */
export function checkFixture(text: string): string[] {
  const out: string[] = [];
  if (!text.endsWith("\n")) out.push("the file does not end with a line break");
  text
    .split("\n")
    .filter((line) => line !== "")
    .forEach((line, i) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        out.push(`line ${String(i + 1)}: not JSON`);
        return;
      }
      if (typeof value !== "object" || value === null) {
        out.push(`line ${String(i + 1)}: not a fixture line`);
        return;
      }
      const v = value as Record<string, unknown>;
      if (
        Object.keys(v).join(",") !== "dir,ms,msg" ||
        !["send", "recv", "recv-text", "stderr", "mark", "exit"].includes(String(v["dir"])) ||
        !Number.isInteger(v["ms"])
      ) {
        out.push(`line ${String(i + 1)}: not a fixture line`);
        return;
      }
      for (const f of checkFixtureValue(v["msg"])) out.push(`line ${String(i + 1)}: ${f}`);
    });
  return out;
}

/** `sanitise.ts <scratch> <fixtures folder>`: every raw recording, as `windows-<case>.jsonl`. */
function main(): void {
  const [scratch, destination] = process.argv.slice(2);
  if (scratch === undefined || destination === undefined) {
    throw new Error("usage: sanitise.ts <scratch> <fixtures folder>");
  }
  const os = process.platform === "win32" ? "windows" : "linux";
  for (const name of readdirSync(join(scratch, "raw"))) {
    if (!name.endsWith(".jsonl")) continue;
    const label = name.slice(0, -".jsonl".length);
    const fixture = sanitiseRecording(
      readFileSync(join(scratch, "raw", name), "utf8"),
      join(scratch, `work-${label}`),
    );
    const findings = checkFixture(fixture);
    if (findings.length > 0) throw new Error(`${label}: ${findings.join("; ")}`);
    writeFileSync(join(destination, `${os}-${label}.jsonl`), fixture);
    console.log(`${os}-${label}.jsonl: ${String(fixture.split("\n").length - 1)} lines`);
  }
}

if (process.argv[1]?.endsWith("sanitise.ts") === true) main();
