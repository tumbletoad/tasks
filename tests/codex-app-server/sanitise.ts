// Turns a raw recording of `codex app-server` (record.ts) into fixture text, and checks fixture
// text. The rule is an allow-list: a string survives only when it is a word of the protocol's own
// vocabulary (VOCAB), a method name, a version or one of the recorder's own labels. Every other
// string becomes a fixture value by its field: an ID a synthetic ID (the same within a stream), a
// path a fixture path, text "Fixture text.", anything else `unknown-value`. Times keep their
// distance from the stream's first time only, token counts and limits become fixture numbers.
// Field names, the order of the lines and of their fields, and the JSON types stay.
//
// So a fixture holds no account, machine, path, prompt or answer of the recording: what the check
// below accepts is exactly what this can write.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_TEXT = "Fixture text.";
export const UNKNOWN_VALUE = "unknown-value";
export const FIXTURE_WORK = "C:\\fixture\\work";
const FIXTURE_PATH = /^C:\\fixture\\(?:work|path-\d{1,3})$/;
const SYNTHETIC_ID =
  /^(?:00000000-0000-4000-8000-\d{12}|exec-00000000-0000-4000-8000-\d{12}|call_fixture\d{1,4}|fixture-id-\d{1,4})$/;
const VERSION = /^\d{1,3}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;
/** The recorder's client name and version, which the user agent repeats. */
const USER_AGENT = /^tasks_lab\/\d{1,3}\.\d{1,4}\.\d{1,4} \(fixture\)$/;
const FIXTURE_NAMES = /^fixture-(?:server|model|plan|host|key)(?:-\d{1,3})?$/;

/** The protocol's words that a fixture keeps as they were recorded. */
export const VOCAB: ReadonlySet<string> = new Set([
  // Directions and the recorder's own lines.
  "send",
  "recv",
  "stderr",
  "mark",
  "exit",
  // initialize, the client's name and the platform.
  "tasks_lab",
  "windows",
  "linux",
  "macos",
  "unix",
  "2.0",
  // Policies, sandboxes, modes, settings.
  "never",
  "untrusted",
  "on-request",
  "on-failure",
  "danger-full-access",
  "workspace-write",
  "read-only",
  "dangerFullAccess",
  "workspaceWrite",
  "readOnly",
  "user",
  "auto_review",
  "default",
  "plan",
  "pragmatic",
  "friendly",
  "detailed",
  "auto",
  "concise",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "explicitRequestOnly",
  "proactive",
  "paginated",
  "legacy",
  "local",
  "openai",
  "vscode",
  "cli",
  "exec",
  "chatgpt",
  "apikey",
  "codex",
  "disabled",
  "enabled",
  // Thread, turn and item states and kinds.
  "idle",
  "active",
  "notLoaded",
  "systemError",
  "inProgress",
  "completed",
  "interrupted",
  "failed",
  "declined",
  "summary",
  "full",
  "text",
  "userMessage",
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "plan",
  "commentary",
  "final_answer",
  "agent",
  "unifiedExecStartup",
  "userShell",
  "unknown",
  "read",
  "listFiles",
  "search",
  "add",
  "delete",
  "update",
  "command",
  "starting",
  "ready",
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
  "omnimod",
  // The probe server and its tool, as the recorder named them.
  "tasks",
  "probe_echo",
]);

const ID_KEYS = new Set([
  "id",
  "threadId",
  "turnId",
  "itemId",
  "rootTurnId",
  "sessionId",
  "callId",
  "approvalId",
  "processId",
  "installationId",
  "conversationId",
  "requestId",
  "parentThreadId",
  "forkedFromId",
  "attachedToThreadId",
  "clientId",
  "environmentId",
  "projectId",
]);
const PATH_KEYS = new Set([
  "cwd",
  "path",
  "codexHome",
  "runtimeWorkspaceRoots",
  "instructionSources",
  "scriptPath",
  "grantRoot",
]);
const TIME_SECONDS = new Set([
  "createdAt",
  "updatedAt",
  "recencyAt",
  "startedAt",
  "completedAt",
  "resetsAt",
  "sectionEnteredAt",
]);
const TIME_MS = new Set(["startedAtMs", "completedAtMs", "emittedAtMs"]);
/** Small protocol integers that say how something went, kept as they are. */
const KEPT_NUMBERS = new Set(["exitCode", "code", "summaryIndex", "durationMs", "ms"]);
const NAME_KEYS: Readonly<Record<string, string>> = {
  model: "model",
  normalModelSlug: "model",
  planType: "plan",
  serverName: "host",
};

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;

/** Replacement state for one stream, so a value is replaced the same way everywhere in it. */
class Replacer {
  readonly #ids = new Map<string, string>();
  readonly #paths = new Map<string, string>();
  readonly #names = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  #firstSeconds: number | undefined;
  #firstMs: number | undefined;
  readonly work: string | undefined;

  constructor(work: string | undefined) {
    this.work = work;
  }

  id(value: string): string {
    const known = this.#ids.get(value);
    if (known !== undefined) return known;
    const n = this.#ids.size + 1;
    const uuid = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const out = /^exec-/.test(value)
      ? `exec-${uuid}`
      : /^call_/.test(value)
        ? `call_fixture${String(n)}`
        : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)
          ? uuid
          : `fixture-id-${String(n)}`;
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

  seconds(value: number): number {
    this.#firstSeconds ??= value;
    return 1_767_225_600 + (value - this.#firstSeconds);
  }

  ms(value: number): number {
    this.#firstMs ??= value;
    return 1_767_225_600_000 + (value - this.#firstMs);
  }
}

function cleanString(key: string, value: string, r: Replacer, inConfig: boolean): string {
  if (key === "method" && /^[A-Za-z]+(?:\/[A-Za-z]+)*$/.test(value)) return value;
  if (VOCAB.has(value) && !PATH_KEYS.has(key) && !(key in NAME_KEYS)) return value;
  if (key === "userAgent") {
    const head = /^tasks_lab\/(\d{1,3}\.\d{1,4}\.\d{1,4})/.exec(value);
    return head === null ? UNKNOWN_VALUE : `tasks_lab/${head[1] ?? ""} (fixture)`;
  }
  if (key === "cliVersion" || key === "version") return VERSION.test(value) ? value : "0.0.0";
  if (ID_KEYS.has(key)) return r.id(value);
  if (PATH_KEYS.has(key) || (inConfig && (key === "command" || key === "args"))) {
    return r.path(value);
  }
  const named = NAME_KEYS[key];
  if (named !== undefined) return r.name(named, value);
  if (key === "name") return r.name("server", value);
  if (key === "TASKS_TICKET") return "LABTICKET0000000000000000";
  return value === "" ? "" : FIXTURE_TEXT;
}

function clean(value: unknown, key: string, r: Replacer, inConfig: boolean): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanString(key, value, r, inConfig);
  if (typeof value === "number") {
    if (TIME_SECONDS.has(key)) return r.seconds(value);
    if (TIME_MS.has(key)) return r.ms(value);
    if (KEPT_NUMBERS.has(key) || key === "id" || key === "requestId") return value;
    return Number.isInteger(value) ? 100 : 0.5;
  }
  if (Array.isArray(value)) return value.map((x) => clean(x, key, r, inConfig));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
      out[r.key(k)] = clean(x, k, r, inConfig || k === "config");
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
        out.push(JSON.stringify({ dir: raw.dir, ms: raw.ms, msg: clean(raw.msg, "", r, false) }));
        break;
      case "stderr":
        out.push(JSON.stringify({ dir: "stderr", ms: raw.ms, msg: { text: FIXTURE_TEXT } }));
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
        // A line that was not JSON stays a fixed line: its text is the recording's.
        out.push(JSON.stringify({ dir: "recv-text", ms: raw.ms, msg: { text: FIXTURE_TEXT } }));
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
        v === UNKNOWN_VALUE ||
        v === "LABTICKET0000000000000000" ||
        VOCAB.has(v) ||
        (k === "method" && /^[A-Za-z]+(?:\/[A-Za-z]+)*$/.test(v)) ||
        (k === "what" && MARK.test(v)) ||
        SYNTHETIC_ID.test(v) ||
        FIXTURE_PATH.test(v) ||
        FIXTURE_NAMES.test(v) ||
        ((k === "cliVersion" || k === "version") && VERSION.test(v)) ||
        (k === "userAgent" && USER_AGENT.test(v));
      if (!ok) out.push(`a value the sanitiser cannot write at ${k === "" ? "(top)" : k}`);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, k);
    } else if (typeof v === "object" && v !== null) {
      for (const [name, x] of Object.entries(v)) {
        if (!FIELD_NAME.test(name) && !/^fixture-key-\d{1,3}$/.test(name)) {
          out.push("a field name the sanitiser cannot write");
        }
        visit(x, name);
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
