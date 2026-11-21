// Lab run N (M0.11): headless runs of the agent CLIs and their output streams. Usage:
//   node spikes/m0/runs/lab.ts <command> --scratch <folder> [--results <folder>]
// Commands:
//   build-helper   compile the console-ctrl helper into <scratch>/bin (Windows)
//   n01            claude -p stream-json cases (Windows)
//   n02            codex exec --json cases with full access (Windows)
//   n02-linux     codex exec --json, reduced: default sandbox and approve mode (Linux)
//   n03            taskkill /T without /F on both CLIs (Windows)
//   n03-detached   Ctrl+C under a detached parent, plain and through console-ctrl run (Windows)
//   repeats        repeats of the console events and early cancels (Windows)
//   n05            sanitise the recordings marked as fixtures into --fixtures <folder>
//   resanitise     run the sanitiser over the committed fixtures in --fixtures <folder>
//   keys           counts of the user-scope MCP keys of the real homes (--label before|after)
//   cleanup        remove this run's Claude transcript folder and Codex rollout files (Windows)
// Every CLI starts through the clean spawner's environment (spikes/m0/agents/spawn.ts) and lab run
// A's cleanup path. Raw streams and stderr stay in <scratch>/raw. The console and the result files
// (--results) get fixed classes, counts, exit codes, timings and yes or no facts only: never what a
// CLI, a model or the OS wrote. Windows-only commands and full access are refused on any other
// host before anything starts (guard.ts). Session counts are capped per machine in
// <scratch>/runs-ledger.json.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realHomeKeys } from "../agents/config-record.ts";
import { findClis, type Cli, type Clis } from "../agents/clis.ts";
import { LabError, errorLabel, num, oneOf } from "../agents/facts.ts";
import { openScratch } from "../agents/scratch.ts";
import { cleanEnv, endAll, installCleanup, track } from "../agents/spawn.ts";
import { option, type JsonObject } from "../kit/wire.ts";
import {
  CLAUDE,
  CODEX,
  VOCAB,
  eventKeyOf,
  type CliKind,
  type Os,
  type Spec,
} from "../../../tests/stream-schema.ts";
import { STDERR_CLASSES, machineDenyList } from "../../../tests/stream-content.ts";
import { guardCommand, guardRun } from "./guard.ts";
import { buildHelper } from "./helper.ts";
import { stageAndPublish, type Output } from "./publish.ts";
import { record, type CancelHow, type Recording } from "./record.ts";
import { cutLastLine, mergeInventories, sanitiseStream, type Inventory } from "./sanitise.ts";

// The boundary for anything thrown outside a command: an error class only, then the cleanup path.
const fail = (error: unknown) => {
  process.stderr.write(`error: ${errorLabel(error)}\n`);
  void endAll().finally(() => process.exit(1));
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
installCleanup();

const RUNS = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(RUNS, "..", "agents");
const NODE = process.execPath;
const WIN = process.platform === "win32";
const machine = WIN ? "windows" : "linux";
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const scratchArg = option(args, "--scratch");
if (scratchArg === undefined) {
  process.stderr.write("Usage: lab <command> --scratch <folder> [--results <folder>]\n");
  process.exit(64);
}
// The machine rule is code, checked before any folder or process.
try {
  guardCommand(command, WIN);
} catch (error) {
  process.stderr.write(`error: ${errorLabel(error)}\n`);
  process.exit(1);
}
const sc = openScratch(scratchArg);
const scratch = sc.root;
const resultsArg = option(args, "--results");
const results = resultsArg ?? sc.mkdir(join(scratch, "results"));
if (resultsArg !== undefined) mkdirSync(resultsArg, { recursive: true });
const work = sc.mkdir(join(scratch, "work"));
const raw = sc.mkdir(join(scratch, "raw"));
const probeOut = sc.mkdir(join(scratch, "probe"));
const outDir = sc.mkdir(join(scratch, "out"));
const mcpDir = sc.mkdir(join(scratch, "mcp"));
const helperExe = join(scratch, "bin", "console-ctrl.exe");
const helper = WIN && existsSync(helperExe) ? helperExe : undefined;

// ---------------------------------------------------------------------------------------------
// Bookkeeping (scratch only).
interface Ledger {
  pids: number[];
  swept: number[];
  claude_sessions: number;
  codex_sessions: number;
  claude_session_ids: string[];
  /** Non-ephemeral Codex threads: their rollout files stay in the home until cleanup. */
  codex_threads: string[];
  codex_resumable_sessions: number;
}
const ledgerFile = join(scratch, "runs-ledger.json");
const ledger: Ledger = existsSync(ledgerFile)
  ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as Ledger)
  : {
      pids: [],
      swept: [],
      claude_sessions: 0,
      codex_sessions: 0,
      claude_session_ids: [],
      codex_threads: [],
      codex_resumable_sessions: 0,
    };
const saveLedger = () => {
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
};
// Rules 4 and 5 of the step: Windows 30 Claude and 25 Codex; Linux no Claude, 8 Codex, 2 resumable.
const LIMITS = WIN
  ? { claude: 30, codex: 25, resumable: 25 }
  : { claude: 0, codex: 8, resumable: 2 };

interface Entry {
  label: string;
  cli: CliKind;
  case: string;
  /** Set when this recording becomes a committed fixture. */
  fixture: string | null;
  facts: JsonObject;
}
const indexFile = join(scratch, "recordings.json");
const index: Entry[] = existsSync(indexFile)
  ? (JSON.parse(readFileSync(indexFile, "utf8")) as Entry[])
  : [];
const saveIndex = () => {
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
};

function save(name: string, data: unknown): void {
  writeFileSync(join(results, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${name}.json`);
}

// ---------------------------------------------------------------------------------------------
// Briefs: fixture text only (rule 6).
const TOOL_BRIEF =
  "Call the tool probe_echo with the text hello. Then reply with the single word done.";
const AGAIN_BRIEF =
  "Call the tool probe_echo with the text again. Then reply with the single word done.";
const SHORT_BRIEF = "Reply with the single word done.";
const BAD_MODEL = "fixture-no-such-model";

const tomlLiteral = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
const tomlArray = (items: string[]) => `[${items.map(tomlLiteral).join(", ")}]`;

function probeArgs(label: string, delayMs: number): string[] {
  return [
    join(AGENTS, "probe.ts"),
    "--out",
    probeOut,
    "--label",
    label,
    ...(delayMs > 0 ? ["--delay-ms", String(delayMs)] : []),
  ];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const parseLines = (file: string): JsonObject[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const v = JSON.parse(l) as unknown;
        return typeof v === "object" && v !== null && !Array.isArray(v) ? [v as JsonObject] : [];
      } catch {
        return [];
      }
    });

/** A short error class from a fixed list (STDERR_CLASSES), never the text. */
function errorClass(text: string): (typeof STDERR_CLASSES)[number] {
  const classes: [RegExp, (typeof STDERR_CLASSES)[number]][] = [
    [/input must be provided|no prompt|no input|stdin/i, "no_input"],
    [/model|not_found|not found|404|does not exist|not supported/i, "model"],
    [/git repo|trusted directory|skip-git-repo-check/i, "not_git"],
    [/interrupt|cancel|abort/i, "interrupted"],
    [/not logged in|login|unauthor|401/i, "auth"],
    [/rate.?limit|429|usage limit/i, "rate_limit"],
    [/terminal|tty|not a terminal|raw mode/i, "needs_terminal"],
    [/max.?turns/i, "max_turns"],
    [/approval/i, "approval"],
    [/mcp|server/i, "mcp"],
  ];
  for (const [re, label] of classes) if (re.test(text)) return label;
  return text.trim() === "" ? "none" : "other";
}

/** Executable names the result files may name; any other shows as "[other]". */
const KNOWN_EXES = [
  "claude.exe",
  "claude",
  "node.exe",
  "node",
  "codex.exe",
  "codex",
  "conhost.exe",
  "console-ctrl.exe",
  "cmd.exe",
  "bash",
  "sh",
  "rg.exe",
  "rg",
  "git.exe",
  "git",
  "pwsh.exe",
  "powershell.exe",
];
const exe = (name: string) => oneOf(name, KNOWN_EXES) ?? "[other]";
const KNOWN_MODELS = ["claude-haiku-5-5", "<synthetic>", BAD_MODEL];

/** The schema's field names among `keys`, sorted, and the number of others (never their names). */
function fieldNames(spec: Spec | undefined, keys: readonly string[]): JsonObject {
  const allowed = spec !== undefined && "obj" in spec ? spec.obj : {};
  const known = keys.filter((k) => Object.hasOwn(allowed, k)).sort();
  return { keys: known, other_keys: keys.length - known.length };
}

/** Recording facts that may be kept: no PIDs, no paths, no values from the stream. */
function recordingFacts(r: Recording): JsonObject {
  const c = r.cancel;
  return {
    exit: r.exit,
    signal: r.signal,
    ms: r.ms,
    timed_out: r.timed_out,
    first_line_ms: r.first_line_ms,
    lines: r.lines,
    json_lines: r.json_lines,
    non_json_lines: r.non_json_lines,
    ends_with_newline: r.ends_with_newline,
    partial_final_line: r.partial_final_line,
    crlf_lines: r.crlf_lines,
    stdout_end_after_exit_ms: r.stdout_end_after_exit_ms,
    stderr_bytes: r.stderr_bytes,
    event_keys: r.event_keys,
    cancel:
      c === null
        ? null
        : {
            how: c.how,
            sent_after_line: c.trigger_line,
            action_exit: c.action_exit,
            action_class: c.action_class,
            exit_after_cancel_ms: c.exit_after_cancel_ms,
            escalated_to_force: c.escalated,
            lines_after_cancel: c.lines_after_cancel,
            tree_before: c.tree_before.map((p) => exe(p.exe)),
            left_after_exit: c.left_after_exit.map((p) => exe(p.exe)),
          },
    swept: r.swept.map((p) => exe(p.exe)),
  };
}

// ---------------------------------------------------------------------------------------------
// Claude Code (Windows only): the claude-print adapter's argv (A4 3.11.3) in the signed-in home
// with settings for this run only (rule 1): --mcp-config <scratch file> --strict-mcp-config
// --setting-sources project, haiku, one short turn.
let found: Clis | undefined;
const clis = (): Clis => (found ??= findClis());

interface ClaudeCase {
  label: string;
  case: string;
  fixture?: string;
  brief: string;
  model?: string;
  resume?: string;
  maxTurns?: number;
  delayMs?: number;
  cancel?: { how: CancelHow; delayMs?: number; on?: "tool" | "start" };
  noProbe?: boolean;
}

function claudeMcpConfig(label: string, delayMs: number): string {
  const file = join(mcpDir, `${label}.json`);
  const config = {
    mcpServers: { tasks: { type: "stdio", command: NODE, args: probeArgs(label, delayMs) } },
  };
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/** n03-detached: start the CLI through `console-ctrl run`, which re-enables Ctrl+C first. */
let wrapRuns = false;

async function runCli(
  kind: CliKind,
  cli: Cli,
  label: string,
  argv: string[],
  stdin: string,
  cancel?: { how: CancelHow; trigger: (l: string) => boolean; delayMs?: number },
  timeoutMs = 240_000,
): Promise<Recording> {
  if (!/^[a-z0-9-]{1,60}$/.test(label)) throw new LabError("bad label");
  const wrap = wrapRuns && helper !== undefined;
  return record({
    label,
    cli: kind,
    file: wrap ? helper : cli.file,
    args: wrap ? ["run", cli.file, ...cli.prefix, ...argv] : [...cli.prefix, ...argv],
    env: cleanEnv(process.env, {}, { path: clis().path }),
    cwd: work,
    stdin,
    rawDir: raw,
    timeoutMs,
    ...(helper === undefined ? {} : { helper }),
    ...(cancel === undefined ? {} : { cancel: { ...cancel, graceMs: 10_000 } }),
    onPid: (pid) => {
      ledger.pids.push(pid);
      saveLedger();
    },
    onSweep: (procs) => {
      ledger.swept.push(...procs.map((p) => p.pid));
      saveLedger();
    },
  });
}

const claudeToolTrigger = (l: string) =>
  l.includes('"type":"assistant"') && l.includes('"tool_use"');
const claudeStartTrigger = (l: string) => l.includes('"subtype":"init"');

function claudeFacts(r: Recording, sessionId: string | undefined): JsonObject {
  const events = parseLines(r.raw_stdout);
  const init = events.find((e) => e["type"] === "system" && e["subtype"] === "init");
  const result = events.find((e) => e["type"] === "result");
  const servers = Array.isArray(init?.["mcp_servers"]) ? (init["mcp_servers"] as unknown[]) : [];
  const tools = Array.isArray(init?.["tools"]) ? (init["tools"] as unknown[]) : [];
  const toolUses: string[] = [];
  let toolResults = 0;
  let toolErrors = 0;
  for (const e of events) {
    const content = (e["message"] as JsonObject | undefined)?.["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content as JsonObject[]) {
      if (block["type"] === "tool_use")
        toolUses.push(oneOf(block["name"], VOCAB.tool) ?? "[other]");
      if (block["type"] === "tool_result") {
        toolResults++;
        if (block["is_error"] === true) toolErrors++;
      }
    }
  }
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  return {
    init:
      init === undefined
        ? null
        : {
            ...fieldNames(CLAUDE["system/init"], Object.keys(init)),
            session_id_equals_preset:
              sessionId === undefined ? null : str(init["session_id"]) === sessionId,
            cwd_equals_work: norm(str(init["cwd"])) === norm(work),
            mcp_servers: servers.map((s) => {
              const o = (typeof s === "object" && s !== null ? s : {}) as JsonObject;
              return {
                name: o["name"] === "ttasks" ? "tasks" : "[other]",
                status: oneOf(o["status"], VOCAB["mcp-status"]),
              };
            }),
            permission_mode: oneOf(init["permissionMode"], VOCAB["permission-mode"]),
            model: oneOf(init["model"], KNOWN_MODELS),
            probe_tool_listed: tools.includes("mcp__ttasks__probe_echo"),
            tool_count: tools.length,
          },
    tool_uses: toolUses,
    tool_results: toolResults,
    tool_result_errors: toolErrors,
    result:
      result === undefined
        ? null
        : {
            ...fieldNames(CLAUDE["result"], Object.keys(result)),
            subtype: oneOf(result["subtype"], VOCAB["result-subtype"]),
            is_error: typeof result["is_error"] === "boolean" ? result["is_error"] : null,
            num_turns: num(result["num_turns"]),
            permission_denials: Array.isArray(result["permission_denials"])
              ? result["permission_denials"].length
              : null,
            session_id_equals_preset:
              sessionId === undefined ? null : str(result["session_id"]) === sessionId,
          },
  };
}

async function claudeCase(c: ClaudeCase): Promise<{ facts: JsonObject; sessionId: string }> {
  if (ledger.claude_sessions >= LIMITS.claude) throw new LabError("Claude session limit reached");
  const sessionId = randomUUID();
  const argv = ["-p"];
  if (c.resume === undefined) argv.push("--session-id", sessionId);
  else argv.push("--resume", c.resume);
  argv.push("--output-format", "stream-json", "--verbose");
  argv.push("--permission-mode", "bypassPermissions", "--permission-prompts", "none");
  argv.push("--max-turns", String(c.maxTurns ?? 5));
  argv.push("--model", c.model ?? "haiku");
  if (c.noProbe !== true) argv.push("--mcp-config", claudeMcpConfig(c.label, c.delayMs ?? 0));
  argv.push("--strict-mcp-config", "--setting-sources", "project");
  guardRun("claude", argv, WIN);
  ledger.claude_sessions++;
  if (c.resume === undefined) ledger.claude_session_ids.push(sessionId);
  saveLedger();
  const r = await runCli(
    "claude-print",
    clis().claude,
    c.label,
    argv,
    c.brief,
    c.cancel === undefined
      ? undefined
      : {
          how: c.cancel.how,
          trigger: c.cancel.on === "start" ? claudeStartTrigger : claudeToolTrigger,
          ...(c.cancel.delayMs === undefined ? {} : { delayMs: c.cancel.delayMs }),
        },
  );
  // stderr stays in the raw folder; only its class goes further.
  const facts = {
    case: c.case,
    argv_shape: argv
      .map((a) => (a.includes("\\") || a.includes("/") ? "<file>" : a))
      .map((a) => (/^[0-9a-f-]{36}$/.test(a) ? "<uuid>" : a)),
    ...recordingFacts(r),
    stderr_class: errorClass(readFileSync(r.raw_stderr, "utf8")),
    claude: claudeFacts(r, c.resume ?? sessionId),
  };
  index.push({
    label: c.label,
    cli: "claude-print",
    case: c.case,
    fixture: c.fixture ?? null,
    facts,
  });
  saveIndex();
  console.log(`${c.label}: exit ${String(r.exit)} ${r.event_keys.join(" ")}`);
  return { facts, sessionId };
}

// ---------------------------------------------------------------------------------------------
// Codex: the codex-exec adapter's argv (A4 3.11.3) in the default home with -c overrides and
// --ignore-user-config (rule 1). Windows: full access. Linux: the default sandbox and approve mode.
interface CodexCase {
  label: string;
  case: string;
  fixture?: string;
  brief: string;
  model?: string;
  /** Persist the rollout (a resumable thread). Default: --ephemeral. */
  persist?: boolean;
  resume?: string;
  approve?: boolean;
  fullAccess?: boolean;
  skipGitCheck?: boolean;
  delayMs?: number;
  cancel?: { how: CancelHow; delayMs?: number; on?: "tool" | "start" };
  noProbe?: boolean;
  timeoutMs?: number;
}

const codexToolTrigger = (l: string) =>
  l.includes('"type":"item.started"') && l.includes('"mcp_tool_call"');
const codexStartTrigger = (l: string) => l.includes('"type":"turn.started"');
const CODEX_ITEM_TYPES = Object.keys(
  (
    (CODEX["item.completed"] as { obj: Record<string, Spec> }).obj["item"] as {
      cases: Record<string, unknown>;
    }
  ).cases,
);

function codexFacts(r: Recording, lastMessage: string): JsonObject {
  const events = parseLines(r.raw_stdout);
  const started = events.find((e) => e["type"] === "thread.started");
  const thread = str(started?.["thread_id"]);
  const items: JsonObject[] = [];
  const errors: string[] = [];
  let usageKeys: JsonObject | null = null;
  for (const e of events) {
    if (e["type"] === "item.completed") {
      const i = (
        typeof e["item"] === "object" && e["item"] !== null ? e["item"] : {}
      ) as JsonObject;
      const type = oneOf(i["type"], CODEX_ITEM_TYPES);
      const status = oneOf(i["status"], VOCAB["item-status"]);
      if (type === "mcp_tool_call") {
        // The error's text stays in the raw stream: only its class goes further.
        const error = i["error"];
        items.push({
          type,
          server: i["server"] === "ttasks" ? "tasks" : "[other]",
          tool: oneOf(i["tool"], VOCAB["probe-tool"]),
          status,
          error: error === null || error === undefined ? null : errorClass(JSON.stringify(error)),
        });
      } else items.push({ type, status });
    }
    if (e["type"] === "turn.completed") {
      const usage = e["usage"];
      const keys = typeof usage === "object" && usage !== null ? Object.keys(usage) : [];
      usageKeys = fieldNames(
        (CODEX["turn.completed"] as { obj: Record<string, Spec> }).obj["usage"],
        keys,
      );
    }
    if (e["type"] === "turn.failed" || e["type"] === "error") {
      errors.push(`${e["type"]}:${errorClass(JSON.stringify(e))}`);
    }
  }
  return {
    thread_started: started !== undefined,
    thread_id_format: thread === "" ? null : /^[0-9a-f-]{36}$/.test(thread) ? "uuid" : "other",
    event_keys_unknown: events.filter((e) => eventKeyOf("codex-exec", e) === "unknown-event")
      .length,
    items,
    usage_keys: usageKeys,
    errors,
    last_message_file: existsSync(lastMessage),
    last_message_nonempty: existsSync(lastMessage)
      ? readFileSync(lastMessage, "utf8").trim() !== ""
      : null,
  };
}

async function codexCase(c: CodexCase): Promise<{ facts: JsonObject; thread: string | null }> {
  if (ledger.codex_sessions >= LIMITS.codex) throw new LabError("Codex session limit reached");
  const persist = c.persist === true || c.resume !== undefined;
  if (persist && ledger.codex_resumable_sessions >= LIMITS.resumable) {
    throw new LabError("resumable Codex session limit reached");
  }
  const lastMessage = join(outDir, `${c.label}.last.txt`);
  const argv = c.resume === undefined ? ["exec"] : ["exec", "resume", c.resume];
  argv.push("--json");
  if (c.resume === undefined) argv.push("-C", work);
  if (c.fullAccess === true) argv.push("--dangerously-bypass-approvals-and-sandbox");
  if (c.skipGitCheck === true) argv.push("--skip-git-repo-check");
  if (!persist) argv.push("--ephemeral");
  argv.push("--ignore-user-config");
  argv.push("-c", 'model_reasoning_effort="low"');
  if (c.model !== undefined) argv.push("-m", c.model);
  if (c.noProbe !== true) {
    argv.push("-c", `mcp_servers.ttasks.command=${tomlLiteral(NODE)}`);
    argv.push("-c", `mcp_servers.ttasks.args=${tomlArray(probeArgs(c.label, c.delayMs ?? 0))}`);
    argv.push("-c", "mcp_servers.ttasks.startup_timeout_sec=20");
    argv.push("-c", "mcp_servers.ttasks.tool_timeout_sec=120");
    if (c.approve === true) {
      argv.push("-c", 'mcp_servers.ttasks.default_tools_approval_mode="approve"');
    }
  }
  argv.push("-o", lastMessage, "-");
  // Finding 4 of the review: full access is refused off Windows before anything is spawned.
  guardRun("codex", argv, WIN);
  ledger.codex_sessions++;
  if (persist) ledger.codex_resumable_sessions++;
  saveLedger();
  const r = await runCli(
    "codex-exec",
    clis().codex,
    c.label,
    argv,
    c.brief,
    c.cancel === undefined
      ? undefined
      : {
          how: c.cancel.how,
          trigger: c.cancel.on === "start" ? codexStartTrigger : codexToolTrigger,
          ...(c.cancel.delayMs === undefined ? {} : { delayMs: c.cancel.delayMs }),
        },
    c.timeoutMs,
  );
  const startedEvent = parseLines(r.raw_stdout).find((e) => e["type"] === "thread.started");
  const thread = str(startedEvent?.["thread_id"]) || null;
  if (persist && thread !== null && !ledger.codex_threads.includes(thread)) {
    ledger.codex_threads.push(thread);
    saveLedger();
  }
  const facts = {
    case: c.case,
    argv_shape: argv
      .map((a) => (a.includes("\\") || a.includes("/") ? "<path or toml>" : a))
      .map((a) => (/^[0-9a-f-]{36}$/.test(a) ? "<thread id>" : a)),
    ...recordingFacts(r),
    stderr_class: errorClass(readFileSync(r.raw_stderr, "utf8")),
    codex: codexFacts(r, lastMessage),
    thread_equals_resumed: c.resume === undefined ? null : thread === c.resume,
  };
  index.push({
    label: c.label,
    cli: "codex-exec",
    case: c.case,
    fixture: c.fixture ?? null,
    facts,
  });
  saveIndex();
  console.log(`${c.label}: exit ${String(r.exit)} ${r.event_keys.join(" ")}`);
  return { facts, thread };
}

// ---------------------------------------------------------------------------------------------
// Commands.

function buildHelperCommand(): Promise<void> {
  buildHelper(sc.mkdir(join(scratch, "bin")));
  console.log("built the console-ctrl helper in the scratch folder");
  return Promise.resolve();
}

function needHelper(): void {
  if (WIN && helper === undefined) throw new LabError("run build-helper first");
}

async function n01(): Promise<void> {
  needHelper();
  const runs: JsonObject[] = [];
  const ok = await claudeCase({
    label: "n01-success",
    case: "success with a probe tool call",
    fixture: "success-tool-call",
    brief: TOOL_BRIEF,
  });
  runs.push(ok.facts);
  runs.push(
    (
      await claudeCase({
        label: "n01-resume",
        case: "--resume of the success session, another probe call",
        fixture: "resume",
        brief: AGAIN_BRIEF,
        resume: ok.sessionId,
      })
    ).facts,
  );
  runs.push(
    (
      await claudeCase({
        label: "n01-error-model",
        case: "invalid model name",
        fixture: "error-model",
        brief: SHORT_BRIEF,
        model: BAD_MODEL,
        noProbe: true,
      })
    ).facts,
  );
  runs.push(
    (
      await claudeCase({
        label: "n01-no-brief",
        case: "empty stdin (no brief delivered)",
        fixture: "error-no-brief",
        brief: "",
        noProbe: true,
      })
    ).facts,
  );
  runs.push(
    (
      await claudeCase({
        label: "n01-max-turns",
        case: "--max-turns 1 with a tool call",
        fixture: "error-max-turns",
        brief: TOOL_BRIEF,
        maxTurns: 1,
      })
    ).facts,
  );
  for (const how of ["ctrl-c", "ctrl-break", "terminate"] as const) {
    runs.push(
      (
        await claudeCase({
          label: `n01-cancel-${how}`,
          case: `${how} while a probe call is pending`,
          fixture: `cancel-${how}`,
          brief: TOOL_BRIEF,
          delayMs: 60_000,
          cancel: { how, delayMs: 1_500 },
        })
      ).facts,
    );
  }
  save("n01-claude-print", {
    row: "N01",
    machine,
    route:
      'claude.exe -p in the signed-in home: --session-id, --output-format stream-json --verbose, --permission-mode bypassPermissions --permission-prompts none, --max-turns, --model haiku, --mcp-config <scratch file with the probe as "tasks"> --strict-mcp-config --setting-sources project, brief on stdin; empty working folder',
    runs,
  });
}

async function n02(): Promise<void> {
  needHelper();
  const runs: JsonObject[] = [];
  const base = { fullAccess: true } as const;
  const plain = await codexCase({
    ...base,
    label: "n02-tool-no-approve",
    case: "full access, outside git without --skip-git-repo-check, probe without an approval mode",
    brief: TOOL_BRIEF,
  });
  runs.push(plain.facts);
  const items = (plain.facts["codex"] as JsonObject)["items"] as JsonObject[];
  const ran = items.some((i) => i["type"] === "mcp_tool_call" && i["status"] === "completed");
  if (!ran) {
    runs.push(
      (
        await codexCase({
          ...base,
          label: "n02-tool-approve",
          case: "full access, probe with default_tools_approval_mode approve",
          brief: TOOL_BRIEF,
          approve: true,
        })
      ).facts,
    );
  }
  const approve = !ran;
  const persisted = await codexCase({
    ...base,
    approve,
    label: "n02-success",
    case: "success with a probe tool call, persisted (resumable)",
    fixture: "success-tool-call",
    brief: TOOL_BRIEF,
    persist: true,
  });
  runs.push(persisted.facts);
  if (persisted.thread !== null) {
    runs.push(
      (
        await codexCase({
          ...base,
          approve,
          label: "n02-resume",
          case: "codex exec resume <thread> - with another probe call",
          fixture: "resume",
          brief: AGAIN_BRIEF,
          resume: persisted.thread,
        })
      ).facts,
    );
    // Interactive `codex resume` is not run: it needs a terminal, and it has no
    // --ignore-user-config, so it would start the home's own MCP servers (rule 1). Session work.
  }
  runs.push(
    (
      await codexCase({
        ...base,
        label: "n02-error-model",
        case: "invalid model name",
        fixture: "error-model",
        brief: SHORT_BRIEF,
        model: BAD_MODEL,
        noProbe: true,
      })
    ).facts,
  );
  runs.push(
    (
      await codexCase({
        ...base,
        label: "n02-no-brief",
        case: "empty stdin with - (no brief delivered)",
        fixture: "error-no-brief",
        brief: "",
        noProbe: true,
      })
    ).facts,
  );
  runs.push(
    (
      await codexCase({
        label: "n02-outside-git-read-only",
        case: "read-only sandbox, outside git, no --skip-git-repo-check",
        fixture: "error-not-git",
        brief: SHORT_BRIEF,
        noProbe: true,
      })
    ).facts,
  );
  for (const how of ["ctrl-c", "ctrl-break", "terminate"] as const) {
    runs.push(
      (
        await codexCase({
          ...base,
          approve,
          label: `n02-cancel-${how}`,
          case: `${how} while a probe call is pending`,
          fixture: `cancel-${how}`,
          brief: TOOL_BRIEF,
          delayMs: 60_000,
          cancel: { how, delayMs: 1_500 },
        })
      ).facts,
    );
  }
  save("n02-codex-exec", {
    row: "N02",
    machine,
    route:
      'node codex.js exec --json -C <empty working folder> --dangerously-bypass-approvals-and-sandbox --ignore-user-config, --ephemeral unless resumable, -c model_reasoning_effort="low", the probe as mcp_servers.ttasks through -c, -o <scratch file>, - with the brief on stdin; the account in the default home',
    approve_mode_needed_with_full_access: approve,
    runs,
  });
}

async function n02Linux(): Promise<void> {
  const runs: JsonObject[] = [];
  const base = { approve: true, skipGitCheck: true } as const;
  runs.push(
    (
      await codexCase({
        ...base,
        label: "n02l-success",
        case: "default sandbox, approve mode, probe tool call",
        fixture: "success-tool-call",
        brief: TOOL_BRIEF,
      })
    ).facts,
  );
  for (const how of ["sigint-group", "sigterm-group"] as const) {
    runs.push(
      (
        await codexCase({
          ...base,
          label: `n02l-cancel-${how}`,
          case: `${how} while a probe call is pending (own process group)`,
          fixture: `cancel-${how}`,
          brief: TOOL_BRIEF,
          delayMs: 60_000,
          cancel: { how, delayMs: 1_500 },
        })
      ).facts,
    );
  }
  const persisted = await codexCase({
    ...base,
    label: "n02l-persisted",
    case: "default sandbox, approve mode, persisted (resumable)",
    brief: TOOL_BRIEF,
    persist: true,
  });
  runs.push(persisted.facts);
  if (persisted.thread !== null) {
    runs.push(
      (
        await codexCase({
          ...base,
          label: "n02l-resume",
          case: "codex exec resume <thread> - with another probe call",
          fixture: "resume",
          brief: AGAIN_BRIEF,
          resume: persisted.thread,
        })
      ).facts,
    );
  }
  runs.push(
    (
      await codexCase({
        ...base,
        label: "n02l-error-model",
        case: "invalid model name",
        fixture: "error-model",
        brief: SHORT_BRIEF,
        model: BAD_MODEL,
        noProbe: true,
      })
    ).facts,
  );
  runs.push(
    (
      await codexCase({
        ...base,
        label: "n02l-no-brief",
        case: "empty stdin with - (no brief delivered)",
        brief: "",
        noProbe: true,
      })
    ).facts,
  );
  runs.push(
    (
      await codexCase({
        approve: true,
        label: "n02l-outside-git",
        case: "default sandbox, outside git, no --skip-git-repo-check",
        brief: SHORT_BRIEF,
        noProbe: true,
      })
    ).facts,
  );
  save("n02-codex-exec", {
    row: "N02 (reduced)",
    machine,
    route:
      'codex (from the login-shell PATH) exec --json -C <empty working folder> --skip-git-repo-check --ignore-user-config, --ephemeral unless resumable, -c model_reasoning_effort="low", the probe as mcp_servers.ttasks through -c with default_tools_approval_mode="approve", the default sandbox (no full access in this row), -o <scratch file>, - with the brief on stdin; the account of the default home; own process group',
    full_access_variant: "session work: needs the owner at the machine",
    // The IDs themselves go to the report only, never into a committed file.
    threads_left_in_work_home: ledger.codex_threads.length,
    runs,
  });
}

async function n03(): Promise<void> {
  needHelper();
  const runs: JsonObject[] = [];
  runs.push(
    (
      await claudeCase({
        label: "n03-claude-taskkill",
        case: "taskkill /PID <pid> /T without /F while a probe call is pending",
        fixture: "cancel-taskkill-tree",
        brief: TOOL_BRIEF,
        delayMs: 60_000,
        cancel: { how: "taskkill-tree", delayMs: 1_500 },
      })
    ).facts,
  );
  runs.push(
    (
      await codexCase({
        fullAccess: true,
        approve: option(args, "--approve") === "1",
        label: "n03-codex-taskkill",
        case: "taskkill /PID <pid> /T without /F while a probe call is pending",
        fixture: "cancel-taskkill-tree",
        brief: TOOL_BRIEF,
        delayMs: 60_000,
        cancel: { how: "taskkill-tree", delayMs: 1_500 },
      })
    ).facts,
  );
  save("n03-cancel", {
    row: "N03",
    machine,
    note: "After 10 s without exit the recorder forces the tree with taskkill /T /F (A4 3.11.8 step 5)",
    runs,
  });
}

/**
 * N03 follow-up: the lab started as the service would start a run shim (Node `detached: true`,
 * so CREATE_NEW_PROCESS_GROUP, which passes "Ctrl+C ignored" on to every descendant). Ctrl+C to
 * each CLI started plainly, and started through `console-ctrl run`, which re-enables Ctrl+C.
 */
async function n03Detached(): Promise<void> {
  needHelper();
  if (option(args, "--inner") !== "1") {
    const child = spawn(NODE, [...process.argv.slice(1), "--inner", "1"], {
      detached: true,
      stdio: "inherit",
      windowsHide: true,
    });
    track(child, false);
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    if (code !== 0) throw new LabError("the detached lab did not exit with 0");
    return;
  }
  const runs: JsonObject[] = [];
  for (const wrap of [false, true]) {
    wrapRuns = wrap;
    const how = wrap ? "through console-ctrl run" : "started plainly";
    runs.push({
      wrapped: wrap,
      ...(
        await claudeCase({
          label: `det-claude-${wrap ? "wrapped" : "plain"}`,
          case: `ctrl-c under a detached parent, ${how}`,
          brief: TOOL_BRIEF,
          delayMs: 60_000,
          cancel: { how: "ctrl-c", delayMs: 1_500 },
        })
      ).facts,
    });
    runs.push({
      wrapped: wrap,
      ...(
        await codexCase({
          fullAccess: true,
          label: `det-codex-${wrap ? "wrapped" : "plain"}`,
          case: `ctrl-c under a detached parent, ${how}`,
          brief: TOOL_BRIEF,
          delayMs: 60_000,
          cancel: { how: "ctrl-c", delayMs: 1_500 },
        })
      ).facts,
    });
  }
  wrapRuns = false;
  save("n03-detached-parent", {
    row: "N03",
    machine,
    note: "The lab process itself was started with detached: true, as the service starts a run shim",
    runs,
  });
}

/** Repeats of the console events, and cancels while the model is still answering (Windows). */
async function repeats(): Promise<void> {
  needHelper();
  const runs: JsonObject[] = [];
  for (const how of ["ctrl-c", "ctrl-break"] as const) {
    runs.push(
      (
        await claudeCase({
          label: `rep-claude-${how}`,
          case: `${how} while a probe call is pending (repeat)`,
          brief: TOOL_BRIEF,
          delayMs: 60_000,
          cancel: { how, delayMs: 1_500 },
        })
      ).facts,
    );
  }
  for (const how of ["ctrl-c", "terminate"] as const) {
    runs.push(
      (
        await claudeCase({
          label: `rep-claude-${how}-early`,
          case: `${how} 300 ms after the init event (model still answering)`,
          ...(how === "ctrl-c" ? { fixture: "cancel-ctrl-c-early" } : {}),
          brief: TOOL_BRIEF,
          cancel: { how, delayMs: 300, on: "start" },
        })
      ).facts,
    );
  }
  runs.push(
    (
      await codexCase({
        fullAccess: true,
        label: "rep-codex-ctrl-c",
        case: "ctrl-c while a probe call is pending (repeat)",
        brief: TOOL_BRIEF,
        delayMs: 60_000,
        cancel: { how: "ctrl-c", delayMs: 1_500 },
      })
    ).facts,
  );
  runs.push(
    (
      await codexCase({
        fullAccess: true,
        label: "rep-codex-ctrl-c-early",
        case: "ctrl-c 300 ms after turn.started (model still answering)",
        fixture: "cancel-ctrl-c-early",
        brief: TOOL_BRIEF,
        cancel: { how: "ctrl-c", delayMs: 300, on: "start" },
      })
    ).facts,
  );
  save("n01-n02-repeats", { rows: "N01, N02, N03", machine, runs });
}

// ---------------------------------------------------------------------------------------------
// Fixtures. Everything is built and checked in the scratch folder, then published all at once.

interface IndexEntry {
  file: string;
  cli: CliKind;
  os: Os;
  case: string;
  note?: string;
  exit: unknown;
  signal: unknown;
  cancel: unknown;
  escalated_to_force: unknown;
  stderr_class: unknown;
  lines: number;
  ends_with_newline: boolean;
  final_line: string;
}

const TRUNCATED = "killed-truncated-final-line";
/** The stream a truncated fixture is cut from (README rule). */
const truncationSource = (os: Os) =>
  os === "windows" ? "cancel-terminate" : "cancel-sigterm-group";

const lineFacts = (stream: string) => ({
  lines: stream.split("\n").filter((l) => l !== "").length,
  ends_with_newline: stream === "" || stream.endsWith("\n"),
});

function fixturesArg(): string {
  const fixtures = option(args, "--fixtures");
  if (fixtures === undefined || !existsSync(fixtures)) {
    throw new LabError("--fixtures <existing folder> is required");
  }
  return fixtures;
}

function n05(): Promise<void> {
  const fixtures = fixturesArg();
  const os: Os = WIN ? "windows" : "linux";
  const outputs: Output[] = [];
  const inventories: Inventory[] = [];
  const written: IndexEntry[] = [];
  const emit = (e: Entry, name: string, cut: boolean) => {
    const r = e.facts;
    const rawFile = join(raw, `${e.label}.stdout.jsonl`);
    const text = existsSync(rawFile) ? readFileSync(rawFile, "utf8") : "";
    const { stream, inventory, truncated } = sanitiseStream(e.cli, os, text, { cutFinalLine: cut });
    const file = `${e.cli}/${os}-${name}.jsonl`;
    outputs.push({ rel: file, text: stream });
    if (!cut) inventories.push(inventory);
    const cancel = r["cancel"] as JsonObject | null;
    written.push({
      file,
      cli: e.cli,
      os,
      case: cut
        ? `${e.case}; last line cut in half by the sanitiser (a kill in mid-write)`
        : e.case,
      exit: r["exit"] ?? null,
      signal: r["signal"] ?? null,
      cancel: cancel?.["how"] ?? null,
      escalated_to_force: cancel?.["escalated_to_force"] ?? null,
      stderr_class: r["stderr_class"] ?? null,
      ...lineFacts(stream),
      final_line: truncated.kind,
    });
  };
  for (const e of index) {
    if (e.fixture === null) continue;
    emit(e, e.fixture, false);
    if (e.fixture === truncationSource(os)) emit(e, TRUNCATED, true);
  }
  outputs.push({ rel: `index-${os}.json`, text: `${JSON.stringify(written, null, 2)}\n` });
  outputs.push({
    rel: `fields-${os}.json`,
    text: `${JSON.stringify(mergeInventories(inventories), null, 2)}\n`,
  });
  const { files } = stageAndPublish(sc, outputs, fixtures, machineDenyList());
  console.log(`published ${String(files)} files`);
  return Promise.resolve();
}

/** Notes for index entries that are easy to misread (fixed lab text). */
const NOTES: Record<string, string> = {
  "codex-exec/linux-success-tool-call.jsonl":
    "not a recorded pair with linux-resume: this run was ephemeral (--ephemeral); the resume fixture continues a later persisted run of the same case, which is not committed",
  "codex-exec/linux-resume.jsonl":
    "continues the persisted run n02l-persisted (not committed), not the thread of linux-success-tool-call; the shared fixture thread ID only means both are the first ID of their stream",
};

/**
 * The committed fixtures through the current sanitiser, from their committed form (the raw
 * streams are gone). Event order, lines, field names and JSON types stay; every value is set again
 * by its treatment. A truncated fixture is cut again from its re-sanitised source, after a check
 * that the committed one was cut from the committed source. Inventories and indexes are rebuilt.
 */
function resanitise(): Promise<void> {
  const fixtures = fixturesArg();
  const outputs: Output[] = [];
  for (const os of ["windows", "linux"] as const) {
    const indexPath = join(fixtures, `index-${os}.json`);
    if (!existsSync(indexPath)) continue;
    const entries = JSON.parse(readFileSync(indexPath, "utf8")) as IndexEntry[];
    const inventories: Inventory[] = [];
    const fresh = new Map<string, string>();
    const read = (rel: string) => readFileSync(join(fixtures, rel), "utf8");
    for (const e of entries) {
      if (e.final_line === "cut-by-sanitiser") continue;
      const before = read(e.file);
      const s = sanitiseStream(e.cli, os, before);
      if (before.split("\n").length !== s.stream.split("\n").length) {
        throw new LabError("re-sanitising changed the line structure");
      }
      fresh.set(e.file, s.stream);
      inventories.push(s.inventory);
    }
    const rebuilt: IndexEntry[] = [];
    for (const e of entries) {
      let stream = fresh.get(e.file);
      if (e.final_line === "cut-by-sanitiser") {
        const source = e.file.replace(TRUNCATED, truncationSource(os));
        const oldCut = read(e.file).split("\n");
        const oldTail = oldCut.pop() ?? "";
        const oldSource = read(source).split("\n");
        oldSource.pop();
        const oldLast = oldSource.pop() ?? "";
        if (oldCut.join("\n") !== oldSource.join("\n") || !oldLast.startsWith(oldTail)) {
          throw new LabError("a truncated fixture is not cut from its source");
        }
        const lines = (fresh.get(source) ?? "").split("\n");
        lines.pop();
        stream = cutLastLine(lines);
      }
      if (stream === undefined) throw new LabError("a fixture of the index is missing");
      outputs.push({ rel: e.file, text: stream });
      const note = NOTES[e.file];
      rebuilt.push({
        file: e.file,
        cli: e.cli,
        os: e.os,
        case: e.case,
        ...(note === undefined ? {} : { note }),
        exit: e.exit,
        signal: e.signal,
        cancel: e.cancel,
        escalated_to_force: e.escalated_to_force,
        stderr_class: e.stderr_class,
        ...lineFacts(stream),
        final_line: e.final_line,
      });
    }
    outputs.push({ rel: `index-${os}.json`, text: `${JSON.stringify(rebuilt, null, 2)}\n` });
    outputs.push({
      rel: `fields-${os}.json`,
      text: `${JSON.stringify(mergeInventories(inventories), null, 2)}\n`,
    });
  }
  const { files } = stageAndPublish(sc, outputs, fixtures, machineDenyList());
  console.log(`published ${String(files)} files`);
  return Promise.resolve();
}

function keys(): Promise<void> {
  const home = homedir();
  const k = realHomeKeys(join(home, ".claude.json"), join(home, ".codex", "config.toml"), work);
  const label = option(args, "--label") ?? "now";
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new LabError("bad label");
  // Kept in the scratch folder only; the console gets counts and yes or no, never a name.
  writeFileSync(join(scratch, `real-keys-${label}.json`), `${JSON.stringify(k, null, 2)}\n`);
  console.log(
    JSON.stringify({
      claude_user_mcp_servers: k.claude_user_mcp_servers?.length ?? null,
      claude_user_has_tasks: k.claude_user_mcp_servers?.includes("tasks") ?? null,
      claude_project_count: k.claude_project_count,
      claude_project_entry_for_work: k.claude_project_entry_for_work,
      codex_mcp_servers: k.codex_mcp_servers?.length ?? null,
      codex_has_tasks: k.codex_mcp_servers?.includes("tasks") ?? null,
    }),
  );
  return Promise.resolve();
}

/** The Claude Code transcript folder name for a working folder: non-alphanumerics become '-'. */
function claudeProjectSlug(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, "-");
}

function findRollouts(root: string, ids: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, depth + 1);
      else if (ids.some((id) => name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`))) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

function cleanup(): Promise<void> {
  const home = homedir();
  const report: JsonObject = {};
  // Claude Code: exactly the one transcript folder of the working folder, if it holds only ours.
  const projects = join(home, ".claude", "projects");
  const slug = claudeProjectSlug(work);
  const folder = existsSync(projects)
    ? readdirSync(projects).find((n) => n.toLowerCase() === slug.toLowerCase())
    : undefined;
  if (folder === undefined) report["claude_folder"] = "absent";
  else {
    const dir = join(projects, folder);
    const names = readdirSync(dir);
    // Claude Code also creates an empty `memory` folder for the project's auto memory.
    const emptyMemory = (n: string) =>
      n === "memory" &&
      statSync(join(dir, n)).isDirectory() &&
      readdirSync(join(dir, n)).length === 0;
    const ours = (n: string) =>
      emptyMemory(n) || ledger.claude_session_ids.some((id) => n.startsWith(id));
    const foreign = names.filter((n) => !ours(n));
    report["claude_folder_entries"] = names.length;
    report["claude_folder_foreign_entries"] = foreign.length;
    if (foreign.length === 0 && option(args, "--remove") === "1") {
      rmSync(dir, { recursive: true });
      report["claude_folder"] = existsSync(dir) ? "still there" : "removed";
    } else report["claude_folder"] = foreign.length === 0 ? "only ours (dry run)" : "kept: foreign";
  }
  // Codex: exactly the rollout files of the threads this run persisted.
  const rollouts = findRollouts(join(home, ".codex", "sessions"), ledger.codex_threads);
  report["codex_threads"] = ledger.codex_threads.length;
  report["codex_rollouts_found"] = rollouts.length;
  if (option(args, "--remove") === "1") {
    for (const f of rollouts) rmSync(f);
    report["codex_rollouts_left"] = findRollouts(
      join(home, ".codex", "sessions"),
      ledger.codex_threads,
    ).length;
  }
  console.log(JSON.stringify(report));
  writeFileSync(join(scratch, "cleanup.json"), `${JSON.stringify(report, null, 2)}\n`);
  return Promise.resolve();
}

const commands: Record<string, () => Promise<void>> = {
  "build-helper": buildHelperCommand,
  n01,
  n02,
  "n02-linux": n02Linux,
  n03,
  "n03-detached": n03Detached,
  repeats,
  n05,
  resanitise,
  keys,
  cleanup,
};
const fn = commands[command];
if (fn === undefined) {
  console.log(`commands: ${Object.keys(commands).join(", ")}`);
  process.exit(command === "help" ? 0 : 64);
}
let exitCode = 0;
try {
  await fn();
} catch (error) {
  process.stderr.write(`error: ${errorLabel(error)}\n`);
  exitCode = 1;
} finally {
  await endAll();
}
console.log(
  `sessions so far on this machine: claude ${String(ledger.claude_sessions)}, codex ${String(ledger.codex_sessions)} (resumable ${String(ledger.codex_resumable_sessions)})`,
);
process.exit(exitCode);
