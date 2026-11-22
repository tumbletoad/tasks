// Lab run A (M0.09): the unattended agent-integration rows. Usage:
//   node spikes/m0/agents/lab.ts <command> --scratch <folder> [--results <folder>]
// Commands: spawner-check, a01-config, a01-sessions, a02-config, a02-sessions, a06, a06-length,
// a06-markers, a07, a08, a08-claude, a09, e02, real-keys. Every CLI starts through spawn.ts (an
// environment from an allow-list), every folder it writes is under --scratch, and every result
// file goes to --results (default <scratch>/results).
// Rules (A7 3.7, lab rules):
// - Facts only. Result files and the console hold fixed classifications and facts: an error class,
//   an exit code, a yes or no, counts, token numbers. No stream, no answer text, no error text, no
//   path, no account or host name. The top-level boundary prints an error class only.
// - One removal rule (scratch.ts): nothing is removed unless it is strictly inside the run's own
//   scratch folder, and a folder only when it carries the run's marker.
// - One cleanup path (spawn.ts): every child and stand-in service ends on a normal end, an error,
//   SIGINT and SIGTERM, gracefully first, then forced.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { option, sha256Hex, type Json, type JsonObject } from "../kit/wire.ts";
import { findClis, type Cli, type Clis } from "./clis.ts";
import { compareRecords, recordHome, realHomeKeys } from "./config-record.ts";
import {
  corpus,
  definitionItems,
  divisorFor,
  estimate,
  resultItems,
  share,
  type Item,
} from "./corpus.ts";
import { LabError, errorLabel, num, oneOf } from "./facts.ts";
import type { Expect } from "./probe.ts";
import { openScratch, parseE02Modes } from "./scratch.ts";
import {
  cleanEnv,
  endAll,
  endChild,
  installCleanup,
  run,
  track,
  type ExtraName,
  type RunResult,
} from "./spawn.ts";

// The boundary for anything thrown outside the command itself: an error class only.
const services = new Set<Service>();
const stopServices = async () => {
  for (const s of [...services]) await s.stop().catch(() => undefined);
};
const fail = (error: unknown) => {
  process.stderr.write(`error: ${errorLabel(error)}\n`);
  void stopServices()
    .then(() => endAll())
    .finally(() => process.exit(1));
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
installCleanup(stopServices);

const AGENTS = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const WIN = process.platform === "win32";
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const scratchArg = option(args, "--scratch");
if (scratchArg === undefined) {
  process.stderr.write("Usage: lab <command> --scratch <folder> [--results <folder>]\n");
  process.exit(64);
}
const sc = openScratch(scratchArg);
const scratch: string = sc.root;
const results = option(args, "--results") ?? join(scratch, "results");
const machine = WIN ? "windows" : "linux";
const work = sc.mkdir(join(scratch, "work"));
mkdirSync(results, { recursive: true });
const TICKET = `kt_${randomUUID().replaceAll("-", "")}`;
const norm = (p: string) => (WIN ? p.toLowerCase() : p);

// ---------------------------------------------------------------------------------------------
// Bookkeeping: every PID this lab starts, and every model session, counted per machine.
const ledgerFile = join(scratch, "ledger.json");
interface Ledger {
  pids: number[];
  claude_sessions: number;
  codex_sessions: number;
  codex_threads: string[];
  claude_session_ids: string[];
}
const ledger: Ledger = existsSync(ledgerFile)
  ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as Ledger)
  : { pids: [], claude_sessions: 0, codex_sessions: 0, codex_threads: [], claude_session_ids: [] };
const saveLedger = () => {
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude Code sessions on Linux only in a lab session with the maintainer (lab session 2, A7 3.7).
const LINUX_CLAUDE = !WIN && process.env["TTASKS_M0_LINUX_CLAUDE"] === "1";
// Windows: the first run's 40 Claude sessions plus the A08 repeat's 60; Codex 25 plus A06's 12.
const LIMITS = WIN ? { claude: 100, codex: 40 } : { claude: LINUX_CLAUDE ? 10 : 0, codex: 10 };

let clisFound: Clis | undefined;
const clis = (): Clis => (clisFound ??= findClis());

function save(name: string, data: unknown): void {
  writeFileSync(join(results, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${name}.json`);
}

function cli(
  c: Cli,
  argv: readonly string[],
  extra: Partial<Record<ExtraName, string>>,
  opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {},
): Promise<RunResult> {
  return run(c.file, [...c.prefix, ...argv], {
    env: cleanEnv(process.env, extra, { path: clis().path }),
    cwd: opts.cwd ?? work,
    timeoutMs: opts.timeoutMs ?? 240_000,
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    onPid: (pid) => {
      ledger.pids.push(pid);
      saveLedger();
    },
  });
}

/** A CLI's outcome as facts: exit code, timeout, duration. Never its output. */
function outcome(r: RunResult): JsonObject {
  return { exit: r.code, timed_out: r.timedOut, ms: r.ms };
}

// ---------------------------------------------------------------------------------------------
// The probe: its command line, its expectation file, its result files.
type ProbeTools = "a09" | "a09-unmarked";
function probeArgv(
  out: string,
  label: string,
  expect: Expect,
  tools?: ProbeTools,
  extraArgs: string[] = [],
): string[] {
  sc.mkdir(out);
  // A re-run of a label starts clean, so its result holds only its own probe starts.
  for (const f of probeNames(out, label)) sc.remove(join(out, f));
  const expectFile = join(out, `expect-${label}.json`);
  writeFileSync(expectFile, JSON.stringify(expect));
  return [
    join(AGENTS, "probe.ts"),
    "--out",
    out,
    "--label",
    label,
    "--expect",
    expectFile,
    ...(tools === undefined ? [] : ["--tools", tools]),
    ...extraArgs,
  ];
}

function probeNames(out: string, label: string): string[] {
  if (!existsSync(out)) return [];
  return readdirSync(out).filter((f) => f.startsWith(`probe-${label}-`) && f.endsWith(".json"));
}

/** The probe records of `label`, oldest start first; with `since`, only files not in it. */
function probeFiles(out: string, label: string, since?: ReadonlySet<string>): JsonObject[] {
  return probeNames(out, label)
    .filter((f) => since === undefined || !since.has(f))
    .map((f) => JSON.parse(readFileSync(join(out, f), "utf8")) as JsonObject)
    .sort((a, b) => str(a["started"]).localeCompare(str(b["started"])));
}

/** Runs `step` and returns the probe starts it caused, sanitised. */
async function withProbes<T>(
  out: string,
  label: string,
  step: () => Promise<T>,
): Promise<{ value: T; probes: JsonObject[] }> {
  const before = new Set(probeNames(out, label));
  const value = await step();
  await new Promise((r) => setTimeout(r, 500));
  return { value, probes: probeFiles(out, label, before).map((p) => sanitize(p)) };
}

/**
 * Rule 8: a probe record as it may be kept. `pending` hashes (IDs that had no expectation) and
 * `_meta` ID hashes become `equal` against the IDs the lab learnt afterwards, then disappear.
 */
function sanitize(record: JsonObject, learnt: Record<string, string> = {}): JsonObject {
  const hashes = new Map(Object.entries(learnt).map(([k, v]) => [sha256Hex(v).slice(0, 12), k]));
  const copy = JSON.parse(JSON.stringify(record)) as JsonObject;
  const pending = (copy["pending"] ?? {}) as Record<string, string>;
  const ids = copy["ids"] as Record<string, JsonObject>;
  for (const [name, sha] of Object.entries(pending)) {
    const id = ids[name];
    if (id !== undefined) id["equal_to"] = hashes.get(sha) ?? null;
  }
  delete copy["pending"];
  const metaIds = copy["meta_ids"] as Record<string, JsonObject> | undefined;
  if (metaIds !== undefined) {
    for (const entry of Object.values(metaIds)) {
      entry["equal_to"] = hashes.get(entry["sha12"] as string) ?? null;
      delete entry["sha12"];
    }
  }
  delete copy["started"];
  delete copy["ended"];
  return copy;
}

const tomlLiteral = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
const tomlArray = (items: string[]) => `[${items.map(tomlLiteral).join(", ")}]`;

// ---------------------------------------------------------------------------------------------
// Claude Code sessions (Windows, signed-in home, rule 3): --mcp-config and --strict-mcp-config,
// user settings not loaded, one user prompt (the model may take more than one turn, recorded as
// num_turns) on haiku unless a row says otherwise.
interface ClaudeRun {
  result: RunResult;
  json: JsonObject | undefined;
  events: JsonObject[];
  text: string;
}

async function claudeSession(o: {
  label: string;
  prompt: string;
  model?: string | null;
  sessionId?: string;
  resume?: string;
  persist?: boolean;
  extra?: Partial<Record<ExtraName, string>>;
  probe?: { out: string; expect: Expect; tools?: ProbeTools } | null;
  allowedTools?: string[];
  stream?: boolean;
  more?: string[];
}): Promise<ClaudeRun> {
  if (ledger.claude_sessions >= LIMITS.claude) throw new LabError("Claude session limit reached");
  const argv = ["-p", o.prompt];
  if (o.probe !== null && o.probe !== undefined) {
    const config = {
      mcpServers: {
        "ttasks-probe": {
          type: "stdio",
          command: NODE,
          args: probeArgv(o.probe.out, o.label, o.probe.expect, o.probe.tools),
        },
      },
    };
    const file = join(sc.mkdir(join(scratch, "mcp")), `${o.label}.json`);
    writeFileSync(file, JSON.stringify(config));
    argv.push("--mcp-config", file);
  }
  argv.push("--strict-mcp-config", "--setting-sources", "project");
  argv.push("--output-format", o.stream === true ? "stream-json" : "json");
  if (o.stream === true) argv.push("--verbose");
  if (o.model !== null) argv.push("--model", o.model ?? "haiku");
  if (o.sessionId !== undefined) argv.push("--session-id", o.sessionId);
  if (o.resume !== undefined) argv.push("--resume", o.resume);
  if (o.persist !== true && o.resume === undefined) argv.push("--no-session-persistence");
  if (o.allowedTools !== undefined) argv.push("--allowedTools", o.allowedTools.join(","));
  argv.push(...(o.more ?? []));
  ledger.claude_sessions++;
  if (o.sessionId !== undefined) ledger.claude_session_ids.push(o.sessionId);
  saveLedger();
  const result = await cli(clis().claude, argv, o.extra ?? {});
  const events: JsonObject[] = [];
  let json: JsonObject | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as JsonObject;
      events.push(value);
      if (value["type"] === "result") json = value;
    } catch {
      // not JSON
    }
  }
  const text = typeof json?.["result"] === "string" ? json["result"] : "";
  return { result, json, events, text };
}

const CLAUDE_SUBTYPES = [
  "success",
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
] as const;
/** A model name of a known family; anything else is "[other]". */
const modelName = (name: string) =>
  /^claude-(haiku|sonnet|opus|fable)-\d+(-\d+)*(\[1m\])?$/.test(name) ? name : "[other]";

/** The usage components of a Claude result: input, cache creation, cache read, output. */
function claudeUsage(r: ClaudeRun): JsonObject {
  const usage = (r.json?.["usage"] ?? {}) as Record<string, unknown>;
  const input = num(usage["input_tokens"]);
  const creation = num(usage["cache_creation_input_tokens"]);
  const read = num(usage["cache_read_input_tokens"]);
  return {
    input,
    cache_creation: creation,
    cache_read: read,
    output: num(usage["output_tokens"]),
    total_input: (input ?? 0) + (creation ?? 0) + (read ?? 0),
  };
}

/** Per model of a Claude result: its input-side token numbers. */
function claudeModelUsage(r: ClaudeRun): JsonObject {
  const out: JsonObject = {};
  for (const [name, value] of Object.entries((r.json?.["modelUsage"] ?? {}) as JsonObject)) {
    const v = (value ?? {}) as Record<string, unknown>;
    out[modelName(name)] = {
      input: num(v["inputTokens"]),
      cache_creation: num(v["cacheCreationInputTokens"]),
      cache_read: num(v["cacheReadInputTokens"]),
      output: num(v["outputTokens"]),
    };
  }
  return out;
}

/** Model names, turns and token usage of a Claude result, without any text. */
function claudeFacts(r: ClaudeRun): JsonObject {
  const isError = r.json?.["is_error"];
  return {
    ...outcome(r.result),
    is_error: typeof isError === "boolean" ? isError : null,
    subtype: oneOf(r.json?.["subtype"], CLAUDE_SUBTYPES),
    models: Object.keys((r.json?.["modelUsage"] ?? {}) as JsonObject).map(modelName),
    num_turns: num(r.json?.["num_turns"]),
    input_tokens_total: claudeUsage(r)["total_input"] ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Codex sessions (rules 3 to 5): the default home, --ephemeral
// (no rollout file), --ignore-user-config (the home's config.toml is not loaded, sign-in is), the
// probe through -c overrides only, lowest reasoning effort, the scratch work folder.
interface CodexRun {
  result: RunResult;
  thread: string | null;
  items: JsonObject[];
  errors: string[];
  text: string;
  usage: JsonObject | null;
}

async function codexSession(o: {
  label: string;
  prompt: string;
  sandbox?: "read-only" | "workspace-write";
  envVars?: boolean;
  approval?: string | null;
  extra?: Partial<Record<ExtraName, string>>;
  probe?: { out: string; expect: Expect; name?: string; args?: string[] } | null;
  cwd?: string;
  more?: string[];
}): Promise<CodexRun> {
  if (ledger.codex_sessions >= LIMITS.codex) throw new LabError("Codex session limit reached");
  const name = o.probe?.name ?? "ttasks-probe";
  const argv = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config"];
  argv.push("-s", o.sandbox ?? "read-only", "-C", o.cwd ?? work);
  argv.push("-c", `model_reasoning_effort="${process.env["TTASKS_M0_EFFORT"] ?? "low"}"`);
  if (o.probe !== null && o.probe !== undefined) {
    argv.push("-c", `mcp_servers.${name}.command=${tomlLiteral(NODE)}`);
    argv.push(
      "-c",
      `mcp_servers.${name}.args=${tomlArray(probeArgv(o.probe.out, o.label, o.probe.expect, undefined, o.probe.args))}`,
    );
    argv.push("-c", `mcp_servers.${name}.startup_timeout_sec=20`);
    if (o.envVars === true) argv.push("-c", `mcp_servers.${name}.env_vars=["TTASKS_TICKET"]`);
    if (o.approval !== undefined && o.approval !== null) {
      argv.push("-c", `mcp_servers.${name}.default_tools_approval_mode="${o.approval}"`);
    }
  }
  argv.push(...(o.more ?? []), o.prompt);
  ledger.codex_sessions++;
  saveLedger();
  const result = await cli(clis().codex, argv, o.extra ?? {}, { cwd: o.cwd ?? work });
  let thread: string | null = null;
  const items: JsonObject[] = [];
  const errors: string[] = [];
  let text = "";
  let usage: JsonObject | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    let event: JsonObject;
    try {
      event = JSON.parse(line) as JsonObject;
    } catch {
      continue;
    }
    if (event["type"] === "thread.started" && typeof event["thread_id"] === "string") {
      thread = event["thread_id"];
    }
    if (event["type"] === "item.completed") {
      const item = (event["item"] ?? {}) as JsonObject;
      items.push(item);
      if (item["type"] === "agent_message" && typeof item["text"] === "string") text = item["text"];
    }
    if (event["type"] === "turn.completed") usage = codexUsage(event["usage"]);
    if (event["type"] === "error" || event["type"] === "turn.failed") {
      errors.push(errorClass(JSON.stringify(event)));
    }
  }
  if (thread !== null) {
    // Only an ID of the expected format is kept (the transcript check needs the format alone).
    ledger.codex_threads.push(ID_FORMAT.test(thread) ? thread : "[other]");
    saveLedger();
  }
  return { result, thread, items, errors, text, usage };
}

const CODEX_USAGE = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;
/** Codex's token usage: the known numeric fields only. */
function codexUsage(value: unknown): JsonObject | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return Object.fromEntries(CODEX_USAGE.map((k) => [k, num(v[k])]));
}

/** An error's class from a fixed list, never its text. */
function errorClass(text: string): string {
  const classes: [RegExp, string][] = [
    [/unsupported.*(reasoning|effort)|reasoning.*not supported|minimal/i, "reasoning_effort"],
    [/requires approval|approval policy/i, "approval"],
    [/not logged in|login|unauthor|401/i, "auth"],
    [/rate.?limit|429|usage limit/i, "rate_limit"],
    [/blocked by policy|rejected/i, "policy"],
    [/sandbox|bwrap|namespace|seccomp|landlock/i, "sandbox"],
    [/timed? ?out|timeout/i, "timeout"],
    [/mcp|server/i, "mcp"],
  ];
  for (const [re, label] of classes) if (re.test(text)) return label;
  return "other";
}

/** A command's output, reduced to the class of its failure. */
function outputClass(output: string): string {
  if (/EPERM/.test(output)) return "EPERM";
  if (/EACCES/.test(output)) return "EACCES";
  if (/ENOENT|Cannot find module/.test(output)) return "ENOENT";
  if (/ECONNREFUSED/.test(output)) return "ECONNREFUSED";
  if (/blocked by policy|rejected/i.test(output)) return "policy";
  return output.trim() === "" ? "none" : "other";
}

const ITEM_TYPES = [
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error",
] as const;
const ITEM_STATUSES = ["in_progress", "completed", "failed", "declined"] as const;
const PROBE_TOOLS = ["probe_echo", "probe_marked", "probe_plain"] as const;

/** Item facts of a Codex run: types, MCP calls (server, tool, status), commands (exit, status). */
function codexItems(r: CodexRun): JsonObject[] {
  return r.items
    .filter((i) => i["type"] !== "agent_message" && i["type"] !== "reasoning")
    .map((i) => {
      if (i["type"] === "mcp_tool_call") {
        const error = i["error"] as JsonObject | null | undefined;
        return {
          type: "mcp_tool_call",
          server: oneOf(i["server"], ["ttasks-probe", "ttasks"]),
          tool: oneOf(i["tool"], PROBE_TOOLS),
          status: oneOf(i["status"], ITEM_STATUSES),
          error: error === null || error === undefined ? null : errorClass(JSON.stringify(error)),
        };
      }
      if (i["type"] === "command_execution") {
        return {
          type: "command_execution",
          exit_code: num(i["exit_code"]),
          status: oneOf(i["status"], ITEM_STATUSES),
          output_class: outputClass(str(i["aggregated_output"])),
        };
      }
      if (i["type"] === "error") return { type: "error", class: errorClass(JSON.stringify(i)) };
      return { type: oneOf(i["type"], ITEM_TYPES) ?? "[other]" };
    });
}

function codexFacts(r: CodexRun): JsonObject {
  return {
    ...outcome(r.result),
    thread_started: r.thread !== null,
    errors: r.errors,
    items: codexItems(r),
    usage: r.usage,
  };
}

// ---------------------------------------------------------------------------------------------
// Commands.

/** Rule 6: a child started through the spawner sees none of the forbidden names. */
async function spawnerCheck(): Promise<void> {
  const script =
    "const bad=Object.keys(process.env).filter(n=>/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_|ANTHROPIC_|CODEX_|T3CODE_|MCP_|OPENAI_)/i.test(n));" +
    "console.log(JSON.stringify({bad,count:Object.keys(process.env).length,ticket:'TTASKS_TICKET' in process.env}))";
  const parentForbidden = Object.keys(process.env).filter((n) =>
    /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_|ANTHROPIC_|CODEX_|T3CODE_|MCP_|OPENAI_)/i.test(n),
  ).length;
  const r = await run(NODE, ["-e", script], {
    env: cleanEnv(process.env, { TTASKS_TICKET: TICKET }, { path: clis().path }),
    cwd: work,
  });
  const child = JSON.parse(r.stdout) as { bad: string[]; count: number; ticket: boolean };
  save("spawner-check", {
    row: "rule 6",
    machine,
    parent_forbidden_count: parentForbidden,
    child_forbidden: child.bad,
    child_env_count: child.count,
    child_has_ticket: child.ticket,
    pass: child.bad.length === 0 && child.ticket,
  });
}

/** Whether a CLI's output matches a pattern: a yes or no, never the line. */
const mentions = (text: string, re: RegExp) => re.test(text);

async function a01Config(): Promise<void> {
  const home = join(scratch, "homes", "claude-a01");
  sc.remove(home);
  sc.mkdir(home);
  const out = join(scratch, "probe", "a01-config");
  const expect: Expect = {
    ticket_sha256: sha256Hex(TICKET),
    homes_sha256: { CLAUDE_CONFIG_DIR: sha256Hex(norm(home)) },
  };
  const env = { CLAUDE_CONFIG_DIR: home };
  const named = [".claude.json"];
  const steps: JsonObject = {};
  const empty = recordHome(home);
  const list0 = await cli(clis().claude, ["mcp", "list"], env);
  steps["list_before"] = outcome(list0);
  const base = recordHome(home, named);
  const add = await cli(
    clis().claude,
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "ttasks-probe",
      "--",
      NODE,
      ...probeArgv(out, "a01-cfg", expect),
    ],
    env,
  );
  steps["add"] = outcome(add);
  const added = recordHome(home, named);
  const getStep = await withProbes(out, "a01-cfg", () =>
    cli(clis().claude, ["mcp", "get", "ttasks-probe"], { ...env, TTASKS_TICKET: TICKET }),
  );
  const get = getStep.value;
  steps["get_with_ticket"] = {
    ...outcome(get),
    says_user_scope: mentions(get.stdout, /scope:\s*user/i),
    says_connected: mentions(get.stdout, /connected/i),
    probe_starts: getStep.probes,
  };
  const variants: [string, Partial<Record<ExtraName, string>>][] = [
    ["list", {}],
    ["list_with_ticket", { TTASKS_TICKET: TICKET }],
    [
      "list_with_ticket_allowlist_env",
      { TTASKS_TICKET: TICKET, CLAUDE_CODE_MCP_ALLOWLIST_ENV: "1" },
    ],
  ];
  for (const [name, extra] of variants) {
    const step = await withProbes(out, "a01-cfg", () =>
      cli(clis().claude, ["mcp", "list"], { ...env, ...extra }),
    );
    steps[name] = {
      ...outcome(step.value),
      lists_probe: mentions(step.value.stdout, /ttasks-probe/),
      says_connected: mentions(step.value.stdout, /ttasks-probe.*connected/i),
      probe_starts: step.probes,
    };
  }
  steps["remove"] = outcome(
    await cli(clis().claude, ["mcp", "remove", "ttasks-probe", "--scope", "user"], env),
  );
  const removed = recordHome(home, named);
  // Round 2: the home now has an (empty) mcpServers object, as a real home with servers does.
  steps["add_again"] = outcome(
    await cli(
      clis().claude,
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "ttasks-probe",
        "--",
        NODE,
        ...probeArgv(out, "a01-cfg2", expect),
      ],
      env,
    ),
  );
  steps["remove_again"] = outcome(
    await cli(clis().claude, ["mcp", "remove", "ttasks-probe", "--scope", "user"], env),
  );
  const removedAgain = recordHome(home, named);
  save("a01-config", {
    row: "A01",
    machine,
    route: "scratch CLAUDE_CONFIG_DIR, no model session",
    steps,
    home_files_created_by_first_command: compareRecords(empty, base).files_added,
    keys_written_by_add: compareRecords(base, added).keys_added,
    files_written_by_add: compareRecords(base, added).files_added,
    removal_against_before_add: compareRecords(base, removed),
    removal_round_2_against_round_1: compareRecords(removed, removedAgain),
  });
}

async function a01Sessions(): Promise<void> {
  const out = join(scratch, "probe", "a01-sessions");
  const runs: JsonObject[] = [];
  for (const allow of [false, true]) {
    const id = randomUUID();
    const extra: Partial<Record<ExtraName, string>> = { TTASKS_TICKET: TICKET };
    if (allow) extra.CLAUDE_CODE_MCP_ALLOWLIST_ENV = "1";
    const expect: Expect = {
      ticket_sha256: sha256Hex(TICKET),
      ids: { CLAUDE_CODE_SESSION_ID: id },
    };
    const tag = allow ? "allow" : "plain";
    const first = await claudeSession({
      label: `a01-${tag}-first`,
      prompt:
        "Call the tool probe_echo once with the text Mira, then reply with the single word OK.",
      sessionId: id,
      persist: true,
      extra,
      probe: { out, expect },
      allowedTools: ["mcp__ttasks-probe__probe_echo"],
    });
    runs.push({
      step: `${tag}: --session-id`,
      allowlist_env: allow,
      session: claudeFacts(first),
      probe: probeFiles(out, `a01-${tag}-first`).map((p) => sanitize(p)),
    });
    const second = await claudeSession({
      label: `a01-${tag}-resume`,
      prompt: "Reply with the single word OK.",
      resume: id,
      extra,
      probe: { out, expect },
    });
    runs.push({
      step: `${tag}: --resume <id>`,
      allowlist_env: allow,
      session: claudeFacts(second),
      probe: probeFiles(out, `a01-${tag}-resume`).map((p) => sanitize(p)),
    });
  }
  save("a01-sessions", {
    row: "A01",
    machine,
    route:
      "signed-in home, --mcp-config <scratch file> --strict-mcp-config --setting-sources project, haiku, one user prompt per session (num_turns per run: the model's turns, tool calls included); TTASKS_TICKET set in the CLI's environment (inherited)",
    runs,
  });
}

function patchEnvVars(toml: string, name: string): string {
  const header = `[mcp_servers.${name}]`;
  const lines = toml.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === header);
  if (at < 0) throw new LabError("the table codex mcp add wrote was not found");
  lines.splice(at + 1, 0, 'env_vars = ["TTASKS_TICKET"]');
  return lines.join("\n");
}

async function a02Config(): Promise<void> {
  const home = join(scratch, "homes", "codex-a02");
  sc.remove(home);
  sc.mkdir(home);
  const out = join(scratch, "probe", "a02-config");
  const expect: Expect = {
    ticket_sha256: sha256Hex(TICKET),
    homes_sha256: { CODEX_HOME: sha256Hex(norm(home)) },
  };
  const env = { CODEX_HOME: home };
  const named = ["config.toml"];
  const steps: JsonObject = {};
  const empty = recordHome(home);
  steps["list_before"] = outcome(await cli(clis().codex, ["mcp", "list"], env));
  const base = recordHome(home);
  steps["add"] = outcome(
    await cli(
      clis().codex,
      ["mcp", "add", "ttasks-probe", "--", NODE, ...probeArgv(out, "a02-cfg", expect)],
      env,
    ),
  );
  const added = recordHome(home, named);
  const get = await cli(clis().codex, ["mcp", "get", "ttasks-probe", "--json"], env);
  let getKeys: string[];
  let transportType: Json = null;
  try {
    const parsed = JSON.parse(get.stdout) as JsonObject;
    const walk = (v: unknown, p: string): string[] =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.entries(v).flatMap(([k, c]) => [p + k, ...walk(c, `${p}${k}.`)])
        : [];
    getKeys = walk(parsed, "")
      .map((k) => (/^[A-Za-z0-9_.]{1,80}$/.test(k) ? k : "[other]"))
      .sort();
    transportType = oneOf((parsed["transport"] as JsonObject | undefined)?.["type"], [
      "stdio",
      "streamable_http",
    ]);
  } catch {
    getKeys = ["[not JSON]"];
  }
  steps["get_json"] = { ...outcome(get), keys: getKeys, transport_type: transportType };
  // The single-key patch of A3 3.13.4, in the scratch home only.
  const tomlPath = join(home, "config.toml");
  writeFileSync(tomlPath, patchEnvVars(readFileSync(tomlPath, "utf8"), "ttasks-probe"));
  const patched = recordHome(home, named);
  const get2 = await cli(clis().codex, ["mcp", "get", "ttasks-probe", "--json"], env);
  let envVars: Json;
  try {
    const parsed = JSON.parse(get2.stdout) as JsonObject;
    const value =
      (parsed["transport"] as JsonObject | undefined)?.["env_vars"] ?? parsed["env_vars"] ?? null;
    envVars = Array.isArray(value)
      ? value.map((v) => (v === "TTASKS_TICKET" ? v : "[other]"))
      : value === null
        ? null
        : "[other]";
  } catch {
    envVars = "[not JSON]";
  }
  steps["get_json_after_env_vars_patch"] = { ...outcome(get2), env_vars: envVars };
  const list = await cli(clis().codex, ["mcp", "list"], { ...env, TTASKS_TICKET: TICKET });
  steps["list"] = {
    ...outcome(list),
    lists_probe: mentions(list.stdout, /ttasks-probe/),
    probe_starts: probeFiles(out, "a02-cfg").length,
  };
  steps["remove"] = outcome(await cli(clis().codex, ["mcp", "remove", "ttasks-probe"], env));
  const removed = recordHome(home, named);
  // Round 2: config.toml now exists, as in a real home.
  steps["add_again"] = outcome(
    await cli(
      clis().codex,
      ["mcp", "add", "ttasks-probe", "--", NODE, ...probeArgv(out, "a02-cfg2", expect)],
      env,
    ),
  );
  steps["remove_again"] = outcome(await cli(clis().codex, ["mcp", "remove", "ttasks-probe"], env));
  const removedAgain = recordHome(home, named);
  save("a02-config", {
    row: "A02",
    machine,
    route: "scratch CODEX_HOME, no model session",
    steps,
    home_files_created_by_first_command: compareRecords(empty, base).files_added,
    keys_written_by_add: compareRecords(base, added).keys_added,
    files_written_by_add: compareRecords(base, added).files_added,
    keys_written_by_env_vars_patch: compareRecords(added, patched).keys_added,
    removal_against_before_add: compareRecords(base, removed),
    config_toml_bytes_after_removal: removed.config["config.toml"]?.bytes ?? null,
    removal_round_2_against_round_1: compareRecords(removed, removedAgain),
    probe_starts: probeFiles(out, "a02-cfg").map((p) => sanitize(p)),
  });
}

async function a02Sessions(): Promise<void> {
  const out = join(scratch, "probe", "a02-sessions");
  const expect: Expect = { ticket_sha256: sha256Hex(TICKET) };
  const prompt =
    "Call the MCP tool probe_echo of the server ttasks-probe once with the text Mira, then reply with the single word OK.";
  const variants: { tag: string; envVars: boolean; approval: string | null }[] = [
    { tag: "no-env-vars", envVars: false, approval: null },
    { tag: "env-vars-approve", envVars: true, approval: "approve" },
    { tag: "env-vars-prompt", envVars: true, approval: "prompt" },
  ];
  const runs: JsonObject[] = [];
  for (const v of variants) {
    const r = await codexSession({
      label: `a02-${v.tag}`,
      prompt,
      envVars: v.envVars,
      approval: v.approval,
      extra: { TTASKS_TICKET: TICKET },
      probe: { out, expect },
    });
    const learnt: Record<string, string> = r.thread === null ? {} : { thread_id: r.thread };
    runs.push({
      variant: v.tag,
      env_vars: v.envVars,
      default_tools_approval_mode: v.approval,
      session: codexFacts(r),
      probe: probeFiles(out, `a02-${v.tag}`).map((p) => sanitize(p, learnt)),
    });
  }
  save("a02-sessions", {
    row: "A02",
    machine,
    route: `the account in the default home, codex exec --ephemeral --ignore-user-config, probe through -c overrides, TTASKS_TICKET in the CLI's environment, one user prompt per session`,
    runs,
  });
}

/** A06: does the model state the request_id rule? Judged by "16" and "64" in the answer. */
function judgeRule(text: string): JsonObject {
  const states = /\b16\b/.test(text) && /\b64\b/.test(text);
  const quote = /16 to 64 characters/i.exec(text)?.[0] ?? (states ? "16 ... 64" : null);
  return { states_rule: states, quoted_phrase: quote };
}

const A06_PROMPT =
  "What do the server instructions of the MCP server ttasks-probe say about request_id? Answer in one or two sentences from those instructions, without calling any tool.";

async function a06(): Promise<void> {
  const out = join(scratch, "probe", "a06");
  const runs: JsonObject[] = [];
  if (WIN || LINUX_CLAUDE) {
    for (const model of ["haiku", null] as const) {
      const label = `a06-claude-${model ?? "default"}`;
      const r = await claudeSession({
        label,
        prompt: A06_PROMPT,
        model,
        probe: { out, expect: {} },
      });
      runs.push({
        host: "Claude Code CLI",
        model_flag: model ?? "(default)",
        session: claudeFacts(r),
        ...judgeRule(r.text),
        probe: probeFiles(out, label).map((p) => sanitize(p)),
      });
    }
  }
  const label = "a06-codex";
  const r = await codexSession({ label, prompt: A06_PROMPT, probe: { out, expect: {} } });
  runs.push({
    host: "Codex CLI",
    model_flag: "(default, --ignore-user-config)",
    session: codexFacts(r),
    ...judgeRule(r.text),
    probe: probeFiles(out, label).map((p) => sanitize(p)),
  });
  save("a06-headless", { row: "A06 (headless part)", machine, runs });
}

async function a09(): Promise<void> {
  const out = join(scratch, "probe", "a09");
  const runs: JsonObject[] = [];
  const prompt =
    "Call the tool mcp__ttasks-probe__probe_marked once and the tool mcp__ttasks-probe__probe_plain once, then reply with the single word OK.";
  const first =
    process.env["TTASKS_M0_A09_SKIP_CALLS"] === "1"
      ? []
      : (["default", "tool-search-off"] as const);
  for (const variant of first) {
    const label = `a09-${variant}`;
    const r = await claudeSession({
      label,
      prompt,
      stream: true,
      probe: { out, expect: {}, tools: "a09" },
      allowedTools: ["mcp__ttasks-probe__probe_marked", "mcp__ttasks-probe__probe_plain"],
      ...(variant === "tool-search-off" ? { extra: { ENABLE_TOOL_SEARCH: "false" } } : {}),
    });
    // Tool-use names in order, from the stream (built-in names and the two probe tools only).
    const uses: string[] = [];
    let initTools: string[] = [];
    for (const e of r.events) {
      if (e["type"] === "system" && e["subtype"] === "init") {
        initTools = ((e["tools"] ?? []) as unknown[]).filter(
          (t): t is string =>
            typeof t === "string" &&
            /^(mcp__ttasks-probe__probe_(marked|plain|echo)|ToolSearch)$/.test(t),
        );
      }
      if (e["type"] !== "assistant") continue;
      const content = ((e["message"] as JsonObject | undefined)?.["content"] ?? []) as JsonObject[];
      for (const block of content) {
        if (block["type"] !== "tool_use") continue;
        const name = str(block["name"]);
        uses.push(
          /^(mcp__ttasks-probe__probe_(marked|plain)|ToolSearch)$/.test(name) ? name : "[other]",
        );
      }
    }
    runs.push({
      variant,
      session: claudeFacts(r),
      init_tools: initTools,
      tool_uses_in_order: uses,
      probe: probeFiles(out, label).map((p) => sanitize(p)),
    });
  }
  // The observation that separates loaded from deferred: a deferred tool's description is not in
  // context, so the model cannot say which word it returns. ToolSearch is disallowed.
  const describe =
    "Without calling or searching for any tool: according to the descriptions you can see right now, which word does the tool probe_marked return, and which word does probe_plain return? If you can see only a tool's name and not its description, answer unknown for it. Reply as two lines: marked=<word> and plain=<word>.";
  const variants = (
    process.env["TTASKS_M0_A09_VARIANTS"] ??
    "describe-default,describe-tool-search-off,describe-unmarked"
  ).split(",");
  for (const variant of variants) {
    if (!/^describe-[a-z-]{1,40}$/.test(variant)) throw new LabError("unknown A09 variant");
    const label = `a09-${variant}`;
    const r = await claudeSession({
      label,
      prompt: describe,
      probe: { out, expect: {}, tools: variant.includes("unmarked") ? "a09-unmarked" : "a09" },
      // Disallowing ToolSearch turned deferral off (first run): the "-search-on" variants keep it.
      more: variant.endsWith("-search-on") ? [] : ["--disallowedTools", "ToolSearch"],
      stream: true,
      ...(variant === "describe-tool-search-off" ? { extra: { ENABLE_TOOL_SEARCH: "false" } } : {}),
    });
    const word = (key: string) => {
      const m = new RegExp(`${key}\\s*=\\s*\\**([A-Za-z]+)`, "i").exec(r.text);
      const w = m?.[1]?.toLowerCase() ?? null;
      return w === "heron" || w === "osprey" || w === "unknown" ? w : w === null ? null : "[other]";
    };
    const uses: string[] = [];
    for (const e of r.events) {
      if (e["type"] !== "assistant") continue;
      const content = ((e["message"] as JsonObject | undefined)?.["content"] ?? []) as JsonObject[];
      for (const block of content)
        if (block["type"] === "tool_use")
          uses.push(
            /^(ToolSearch|mcp__ttasks-probe__probe_(marked|plain))$/.test(str(block["name"]))
              ? str(block["name"])
              : "[other]",
          );
    }
    runs.push({
      variant,
      session: claudeFacts(r),
      tool_uses_in_order: uses,
      marked_answer: word("marked"),
      plain_answer: word("plain"),
      probe: probeFiles(out, label).map((p) => sanitize(p)),
    });
  }
  save("a09-always-load", {
    row: "A09",
    machine,
    route:
      "signed-in home, --mcp-config probe with tool _meta anthropic/alwaysLoad on probe_marked only, stream-json, haiku",
    runs,
  });
}

function realKeys(): Promise<void> {
  const profile = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  const keys = realHomeKeys(
    join(profile, ".claude.json"),
    join(profile, ".codex", "config.toml"),
    work,
  );
  const label = option(args, "--label") ?? "now";
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new LabError("bad label");
  // Kept in the scratch folder only; the console gets counts and yes or no, never a name.
  writeFileSync(join(scratch, `real-keys-${label}.json`), `${JSON.stringify(keys, null, 2)}\n`);
  console.log(
    JSON.stringify({
      claude_user_mcp_servers: keys.claude_user_mcp_servers?.length ?? null,
      claude_user_has_tasks: keys.claude_user_mcp_servers?.includes("ttasks") ?? null,
      claude_project_count: keys.claude_project_count,
      claude_project_entry_for_work: keys.claude_project_entry_for_work,
      codex_mcp_servers: keys.codex_mcp_servers?.length ?? null,
      codex_has_tasks: keys.codex_mcp_servers?.includes("ttasks") ?? null,
    }),
  );
  return Promise.resolve();
}

/**
 * The first A06 length follow-up (kept for the record of the Linux and Windows runs): 2,000
 * characters of marker words M001, M002, ... The prompt named the sequence, so the answer is what
 * the model reported, not a visibility bound. `a06-markers` replaces it.
 */
async function a06Length(): Promise<void> {
  const out = join(scratch, "probe", "a06-length");
  const label = "a06-codex-length";
  const r = await codexSession({
    label,
    prompt:
      "The server instructions of the MCP server ttasks-probe consist of marker words M001, M002 and so on. Without calling any tool, which is the highest-numbered marker you can see in them? Reply with that marker only, and add the word cut if the instructions look truncated.",
    probe: { out, expect: {}, args: ["--instructions", "markers"] },
  });
  const m = /M(\d{3})/.exec(r.text);
  save("a06-codex-instructions-length", {
    row: "A06 (headless part, follow-up)",
    machine,
    route:
      "Codex CLI, probe instructions = 2,000 characters of marker words, Mnnn at offset (n-1)*10; the prompt told the model the marker sequence",
    session: codexFacts(r),
    model_reported_last_marker: m?.[1] === undefined ? null : Number(m[1]),
    model_said_cut: /\bcut\b/i.test(r.text),
    reading:
      "what the model reported, not a visibility bound: it was told the sequence, so it could name a marker it did not see",
  });
}

// A06 repeat: unpredictable markers at known offsets. The model is not told the sequence or the
// length; a marker counts only when the model repeats it correctly.
const MARKER_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MARKER_DIGITS = "23456789";
const MARKER_RE = /[A-HJ-NP-Z][2-9][A-HJ-NP-Z][2-9][A-HJ-NP-Z][2-9]/g;

function randomMarker(): string {
  const bytes = randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) {
    const b = bytes[i] ?? 0;
    s += i % 2 === 0 ? MARKER_LETTERS.charAt(b % 24) : MARKER_DIGITS.charAt(b % 8);
  }
  return s;
}

/** Instructions of exactly `length` characters with a `[XXXXXX]` marker every `every` chars. */
function markerInstructions(
  length: number,
  every = 50,
): { text: string; markers: { marker: string; offset: number }[] } {
  const head = "Markers are codes in square brackets. ";
  const filler = "Plain filler words that carry no meaning at all. ";
  let text = head;
  const markers: { marker: string; offset: number }[] = [];
  while (text.length + 8 <= length) {
    const marker = randomMarker();
    markers.push({ marker, offset: text.length });
    text += `[${marker}]`;
    const next = Math.min(length, text.length + every - 8);
    while (text.length < next) text += filler.slice(0, next - text.length);
  }
  while (text.length < length) text += filler.slice(0, length - text.length);
  return { text, markers };
}

async function a06Markers(): Promise<void> {
  const out = join(scratch, "probe", "a06-markers");
  const inst = sc.mkdir(join(scratch, "a06-instructions"));
  const lengths = (process.env["TTASKS_M0_A06_LENGTHS"] ?? "200,400,1000,4000")
    .split(",")
    .map(Number);
  const repeats = Number(process.env["TTASKS_M0_A06_REPEATS"] ?? "2");
  if (lengths.some((n) => !Number.isInteger(n) || n < 60 || n > 8000)) {
    throw new LabError("bad A06 length");
  }
  if (!Number.isInteger(repeats) || repeats < 1 || lengths.length * repeats > 12) {
    throw new LabError("A06 repeat is limited to 12 sessions");
  }
  const runs: JsonObject[] = [];
  for (let rep = 0; rep < repeats; rep++) {
    for (const length of lengths) {
      const { text, markers } = markerInstructions(length);
      const file = join(inst, `instructions-${String(length)}-${String(rep)}.txt`);
      writeFileSync(file, text);
      const label = `a06-markers-${String(length)}-${String(rep)}`;
      const r = await codexSession({
        label,
        prompt:
          "List every marker you can see in the server instructions of the MCP server ttasks-probe. Do not call any tool.",
        probe: { out, expect: {}, args: ["--instructions-file", file] },
      });
      const seen = new Set(r.text.match(MARKER_RE) ?? []);
      const byMarker = new Map(markers.map((m) => [m.marker, m.offset]));
      const correct = markers.filter((m) => seen.has(m.marker)).map((m) => m.offset);
      const wrong = [...seen].filter((s) => !byMarker.has(s)).length;
      const firstMissing = markers.find((m) => !seen.has(m.marker))?.offset ?? null;
      const last = correct.length === 0 ? null : Math.max(...correct);
      runs.push({
        length,
        repeat: rep,
        session: codexFacts(r),
        probe_started: probeFiles(out, label).length > 0,
        marker_offsets: markers.map((m) => m.offset),
        correct_offsets: correct,
        wrong_markers: wrong,
        last_correct_offset: last,
        last_correct_end: last === null ? null : last + 8,
        first_missing_offset: firstMissing,
        correct_are_a_prefix:
          correct.length === 0 || correct.every((o, i) => o === markers[i]?.offset),
      });
    }
  }
  save("a06-codex-instructions-markers", {
    row: "A06 (headless part, random-marker repeat)",
    machine,
    route:
      "Codex CLI (its default model, --ephemeral --ignore-user-config, model_reasoning_effort low), probe with --instructions-file: a 38-character head ('Markers are codes in square brackets.') then a random 6-character [XXXXXX] marker every 50 characters at recorded offsets, filler words between; prompt: 'List every marker you can see in the server instructions of the MCP server ttasks-probe. Do not call any tool.' The model is not told the markers, their number or the length. Only markers it repeats correctly count.",
    runs,
  });
}

// ---------------------------------------------------------------------------------------------
// E02: the stand-in service's socket or pipe from inside the agents' sandboxes, judged from the
// service's own events.jsonl (a `bind` and an `rpc service/status` after the session started).

interface Service {
  state: string;
  pid: number;
  stop: () => Promise<void>;
}

async function startService(state: string, socketDir: string, kitJs: string): Promise<Service> {
  if (!["run-user", "state", "auto"].includes(socketDir)) throw new LabError("bad socket mode");
  sc.mkdir(dirname(state));
  sc.reserve(state);
  const child = spawn(
    NODE,
    [join(kitJs, "kit.mjs"), "service", "--state", state, "--socket-dir", socketDir, "--port", "0"],
    {
      cwd: dirname(state),
      env: cleanEnv(process.env, {}, { path: clis().path }),
      stdio: "ignore",
      windowsHide: true,
      detached: !WIN,
    },
  );
  if (child.pid === undefined) throw new LabError("service did not start");
  track(child);
  ledger.pids.push(child.pid);
  saveLedger();
  const pid = child.pid;
  let stopped = false;
  const service: Service = {
    state,
    pid,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      services.delete(service);
      // Graceful first: the service's own shutdown call, then the one cleanup path.
      if (child.exitCode === null && child.signalCode === null) {
        await run(NODE, [join(kitJs, "kit.mjs"), "call", "--state", state, "service/shutdown"], {
          env: cleanEnv(process.env, {}, { path: clis().path }),
          cwd: dirname(state),
          timeoutMs: 15_000,
        }).catch(() => undefined);
      }
      await endChild(child);
    },
  };
  services.add(service);
  const events = join(state, "events.jsonl");
  for (let i = 0; i < 100; i++) {
    if (existsSync(events) && readFileSync(events, "utf8").includes('"ready"')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (existsSync(state)) sc.claim(state);
  if (!existsSync(events) || !readFileSync(events, "utf8").includes('"ready"')) {
    await service.stop();
    throw new LabError("service not ready");
  }
  return service;
}

/** The service's events since `since` (ms): kinds and rpc methods only. */
function serviceEvents(state: string, since: number): JsonObject {
  const lines = readFileSync(join(state, "events.jsonl"), "utf8").split(/\r?\n/);
  const kinds: Record<string, number> = {};
  let status = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let e: JsonObject;
    try {
      e = JSON.parse(line) as JsonObject;
    } catch {
      continue;
    }
    const t = typeof e["t"] === "number" ? e["t"] : Date.parse(str(e["time"]));
    if (Number.isFinite(t) && t < since) continue;
    const raw = typeof e["kind"] === "string" ? e["kind"] : str(e["event"]);
    const kind = /^[a-z_./-]{1,40}$/.test(raw) ? raw : "[other]";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (kind === "rpc" && e["method"] === "service/status") status++;
  }
  return { kinds, status_calls: status, reached: status > 0 };
}

async function e02(): Promise<void> {
  // Only the named modes: the mode becomes part of a folder name that is removed below.
  const modes = parseE02Modes(process.env["TTASKS_M0_E02_MODES"], WIN);
  const base = join(work, "e02");
  const kitJs = join(base, "kit-js");
  if (!existsSync(join(kitJs, "kit.mjs")))
    throw new LabError("build the kit into work/e02/kit-js first");
  const runs: JsonObject[] = [];
  for (const mode of modes) {
    // The state folder lies outside the agent's workspace, as the product's does, and the
    // command names it by a relative path (no user name in a prompt).
    const stateName = `../../e02-svc/state-${mode}`;
    const state = join(scratch, "e02-svc", `state-${mode}`);
    sc.remove(state);
    const service = await startService(state, mode, kitJs);
    const commandLine = `node kit-js/kit.mjs call --state ${stateName} service/status`;
    try {
      // Control: the same command line outside any sandbox, through the clean spawner.
      const t0 = Date.now();
      const control = await run(
        WIN ? "node.exe" : "node",
        ["kit-js/kit.mjs", "call", "--state", stateName, "service/status"],
        { env: cleanEnv(process.env, {}, { path: clis().path }), cwd: base, timeoutMs: 30_000 },
      ).catch(() => null);
      runs.push({
        mode,
        host: "control (no sandbox, clean spawner)",
        exit: control?.code ?? null,
        service: serviceEvents(state, t0),
      });
      const prompt = `Run exactly this shell command in the current folder, once, and then reply with its exit code only: ${commandLine}`;
      const t1 = Date.now();
      const r = await codexSession({
        label: `e02-codex-${mode}`,
        prompt,
        sandbox: "workspace-write",
        cwd: base,
        probe: null,
        // exec without this rejected the command before it ran ("blocked by policy", first run):
        // with "never" the command runs inside the sandbox and is never escalated. Per launch.
        more: [
          "-c",
          'approval_policy="never"',
          ...(WIN
            ? [
                "-c",
                `windows.sandbox="${process.env["TTASKS_M0_WIN_SANDBOX"] === "elevated" ? "elevated" : "unelevated"}"`,
              ]
            : []),
        ],
      });
      runs.push({
        mode,
        host: "Codex CLI, -s workspace-write",
        session: codexFacts(r),
        service: serviceEvents(state, t1),
      });
      if ((WIN || LINUX_CLAUDE) && process.env["TTASKS_M0_E02_CLAUDE"] !== "0") {
        const t2 = Date.now();
        const c = await claudeSession({
          label: `e02-claude-${mode}`,
          prompt,
          probe: null,
          allowedTools: ["Bash"],
          stream: true,
          more: [
            "--settings",
            JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }),
          ],
        });
        const uses: string[] = [];
        for (const e of c.events) {
          if (e["type"] !== "assistant") continue;
          const content = ((e["message"] as JsonObject | undefined)?.["content"] ??
            []) as JsonObject[];
          for (const block of content)
            if (block["type"] === "tool_use")
              uses.push(oneOf(block["name"], ["Bash", "PowerShell"]) ?? "[other]");
        }
        runs.push({
          mode,
          host: "Claude Code CLI, --settings sandbox.enabled true, failIfUnavailable true",
          session: claudeFacts(c),
          start_refused_class:
            c.result.code !== 0 && c.events.length === 0 ? outputClass(c.result.stderr) : null,
          tool_uses: uses,
          service: serviceEvents(state, t2),
        });
      }
    } finally {
      await service.stop();
    }
  }
  save("e02-sandbox-reach", { row: "E02", machine, runs });
}

// ---------------------------------------------------------------------------------------------
// A08: the token estimator against o200k_base (whole corpus, exact), and the Claude repeat
// (`a08-claude`, an indirect estimate from claude -p usage numbers).

async function a08(): Promise<void> {
  const { encode } = await import("gpt-tokenizer/encoding/o200k_base");
  const repo = join(AGENTS, "..", "..", "..");
  const items = corpus(repo);
  const rows = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    bytes: Buffer.byteLength(i.text, "utf8"),
    estimate: estimate(i.text),
    o200k: encode(i.text).length,
  }));
  const o = rows.map((r) => ({ bytes: r.bytes, real: r.o200k }));
  save("a08-estimator-o200k", {
    row: "A08 (o200k_base, exact)",
    machine,
    estimator: "ceil(utf8 bytes / 3) (A3 3.2.5)",
    tokenizer: "o200k_base from gpt-tokenizer 4.1.2",
    o200k: summary(o),
    o200k_by_kind: Object.fromEntries(
      [...new Set(rows.map((r) => r.kind))].map((k) => [
        k,
        summary(rows.filter((r) => r.kind === k).map((r) => ({ bytes: r.bytes, real: r.o200k }))),
      ]),
    ),
    rows,
  });
}

const DIVISORS = [3, 2.5, 2.0, 1.9, 1.5] as const;

function summary(s: { bytes: number; real: number }[]): JsonObject {
  return {
    items: s.length,
    share_estimate_ge_real_at_3: s.length === 0 ? null : Math.round(share(s, 3) * 10000) / 100,
    divisor_for_99_percent: divisorFor(s),
    divisor_for_100_percent: divisorFor(s, 1),
    min_bytes_per_token:
      s.length === 0 ? null : Math.round(Math.min(...s.map((r) => r.bytes / r.real)) * 100) / 100,
  };
}

function coverage(s: { bytes: number; real: number }[]): JsonObject {
  return {
    items: s.length,
    ...Object.fromEntries(
      DIVISORS.map((d) => [
        `share_at_${String(d)}`,
        s.length === 0 ? null : Math.round(share(s, d) * 10000) / 100,
      ]),
    ),
  };
}

/**
 * A08 repeat (finding 8 of the M0.09 review). Claude Code has no token-count command and no API
 * key is used, so each item is measured indirectly: `claude -p <item>` with a fixed system prompt
 * and no tools, against baseline runs of the prompt "x" interleaved between the items. Per run
 * the usage components and the model are kept. The cost of the filler "x" is measured from a run
 * of eleven of them. The run stops as soon as a baseline moves by more than 2 tokens from the
 * first: then the method is not stable and no per-item number is claimed.
 */
async function a08Claude(): Promise<void> {
  const { encode } = await import("gpt-tokenizer/encoding/o200k_base");
  const repo = join(AGENTS, "..", "..", "..");
  const defs = definitionItems(repo);
  const res = resultItems();
  if (defs.length < 12) throw new LabError("fewer than 12 definitions");
  const spot = [defs[0], defs[2], defs[7], res[0], res[3], res[6]].filter(
    (i): i is Item => i !== undefined,
  );
  // haiku: baseline, filler, then item and baseline per item; default: baseline, filler, then
  // two items and a baseline per pair.
  const planned = 2 + 2 * (defs.length + res.length) + 2 + spot.length + Math.ceil(spot.length / 2);
  if (planned > 60) throw new LabError("A08 repeat is limited to 60 sessions");
  const sessions: JsonObject[] = [];
  const halt: { reason: string | null } = { reason: null };
  const measure = async (label: string, prompt: string, model: string | null) => {
    const r = await claudeSession({
      label,
      prompt,
      model,
      probe: null,
      more: ["--system-prompt", "Reply with OK.", "--tools", ""],
    });
    const usage = claudeUsage(r);
    const row: JsonObject = {
      label,
      model_flag: model ?? "(default)",
      exit: r.result.code,
      is_error: typeof r.json?.["is_error"] === "boolean" ? r.json["is_error"] : null,
      num_turns: num(r.json?.["num_turns"]),
      usage,
      model_usage: claudeModelUsage(r),
    };
    sessions.push(row);
    return r.result.code === 0 ? (usage["total_input"] as number) : null;
  };

  type Measured = {
    id: string;
    kind: string;
    bytes: number;
    o200k: number;
    real: number | null;
    baseline: [number, number] | null;
  };
  const runSet = async (
    model: string | null,
    items: Item[],
    group: number,
  ): Promise<{ rows: Measured[]; baselines: number[]; filler: number | null }> => {
    const tag = model ?? "default";
    const baselines: number[] = [];
    const rows: Measured[] = [];
    const baseline = async (n: number) => {
      const b = await measure(`a08c-${tag}-base-${String(n)}`, "x", model);
      if (b === null) {
        halt.reason = "a baseline run failed";
        return null;
      }
      baselines.push(b);
      const first = baselines[0] ?? b;
      if (Math.abs(b - first) > 2) {
        halt.reason = `baseline moved from ${String(first)} to ${String(b)} tokens (${tag})`;
        return null;
      }
      return b;
    };
    let before = await baseline(0);
    if (before === null) return { rows, baselines, filler: null };
    // The filler's own cost: eleven "x" against one.
    const eleven = await measure(`a08c-${tag}-filler-11`, Array(11).fill("x").join(" "), model);
    const filler = eleven === null ? null : (eleven - before) / 10;
    for (let i = 0; i < items.length; i += group) {
      const chunk = items.slice(i, i + group);
      const totals: (number | null)[] = [];
      for (const item of chunk)
        totals.push(await measure(`a08c-${tag}-${item.id}`, item.text, model));
      const after = await baseline(baselines.length);
      if (after === null) return { rows, baselines, filler };
      chunk.forEach((item, k) => {
        const t = totals[k] ?? null;
        const base = ((before ?? 0) + after) / 2;
        rows.push({
          id: item.id,
          kind: item.kind,
          bytes: Buffer.byteLength(item.text, "utf8"),
          o200k: encode(item.text).length,
          real: t === null || filler === null ? null : Math.round(t - base + filler),
          baseline: [before ?? 0, after],
        });
      });
      before = after;
    }
    return { rows, baselines, filler };
  };

  const haiku = await runSet("haiku", [...defs, ...res], 1);
  const def = halt.reason === null ? await runSet(null, spot, 2) : null;
  const pick = (rows: Measured[], kind: string) =>
    rows
      .filter((r) => r.kind === kind && r.real !== null)
      .map((r) => ({ bytes: r.bytes, real: r.real ?? 0 }));
  const o200 = (rows: Measured[], kind: string) =>
    rows.filter((r) => r.kind === kind).map((r) => ({ bytes: r.bytes, real: r.o200k }));
  save("a08-claude", {
    row: "A08 (Claude repeat)",
    machine,
    method:
      "indirect: claude -p <item> --system-prompt 'Reply with OK.' --tools '' --strict-mcp-config --setting-sources project --no-session-persistence --output-format json, signed-in home, clean spawner; real(item) = total input of the item run - mean of the baseline runs ('x') just before and just after it + the measured cost of one 'x' (from a run of eleven). total input = input + cache creation + cache read tokens. Items are prompt text, so a definition is measured as the JSON the server sends, not as the host renders it into the model's tool list.",
    stopped: halt.reason,
    sessions: sessions.length,
    haiku: {
      baselines: haiku.baselines,
      baseline_spread:
        haiku.baselines.length === 0
          ? null
          : Math.max(...haiku.baselines) - Math.min(...haiku.baselines),
      filler_cost_per_x: haiku.filler,
      definitions: coverage(pick(haiku.rows, "definition")),
      results: coverage(pick(haiku.rows, "result")),
      definitions_o200k: coverage(o200(haiku.rows, "definition")),
      results_o200k: coverage(o200(haiku.rows, "result")),
      rows: haiku.rows,
    },
    default_model_spot_check:
      def === null
        ? null
        : {
            baselines: def.baselines,
            baseline_spread:
              def.baselines.length === 0
                ? null
                : Math.max(...def.baselines) - Math.min(...def.baselines),
            filler_cost_per_x: def.filler,
            definitions: coverage(pick(def.rows, "definition")),
            results: coverage(pick(def.rows, "result")),
            rows: def.rows,
          },
    runs: sessions,
  });
}

async function a07(): Promise<void> {
  const { runA07 } = await import("./a07.ts");
  const kitJs = option(args, "--kit-js") ?? join(work, "e02", "kit-js");
  const result = await runA07({ scratch, path: clis().path, startService, kitJs });
  save("a07-eras", { ...result, machine });
}

const commands: Record<string, () => Promise<void>> = {
  a07,
  a08,
  "a08-claude": a08Claude,
  e02,
  "a06-length": a06Length,
  "a06-markers": a06Markers,
  "spawner-check": spawnerCheck,
  "a01-config": a01Config,
  "a01-sessions": a01Sessions,
  "a02-config": a02Config,
  "a02-sessions": a02Sessions,
  a06,
  a09,
  "real-keys": realKeys,
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
  await stopServices();
  await endAll();
}
console.log(
  `sessions so far on this machine: claude ${String(ledger.claude_sessions)}, codex ${String(ledger.codex_sessions)}`,
);
process.exit(exitCode);
