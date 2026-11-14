// `tasks doctor`, the agent side (A3 3.14; M4.05). Doctor reads and probes: it never launches an
// interactive agent app, opens a deep link or starts a login, and it writes into no agent home.
// What it reads is setup's own record (`<state>/setup/agents.json`), the homes' files through the
// reader setup uses (@tasks/service/setup), and the service's agent-home rows (`setup/homes`).
// Until setup has registered a home, it reads no home at all: the one row then says to run setup.
//
//   claude.env            CLAUDE_CODE_MCP_ALLOWLIST_ENV=1 in the agent environment (warn)
//   agents                no home registered yet, or setup's record cannot be read
//   mcp.<instance>        the entry setup wrote: still there by the file and by the app's own
//                         `mcp get`, running this install's command, its --space and --instance
//                         the same as its grant row
//   codex.engines.<inst>  each engine that reads a Codex home (the CLI, the Codex app's bundled
//                         engine) reads Tasks's entry with its own `mcp get --json`
//   bridge.<instance>     the entry's command as a synthetic stdio client: initialize and
//                         server/discover (both eras), tools/list names this build's tools, and a
//                         `status` round trip to the service in under 2 seconds
//   desktop.restart       Claude Desktop started before setup changed its configuration
//   grants                a registered home without its row, or a row without an entry
//   t3.homes              a T3 provider instance runs in a home without Tasks's entry
//   live (--live only)    a headless call through the app (`claude -p`, `codex exec`) in a
//                         temporary folder asks the model to call `status`, and the service must
//                         have seen that call from the home's instance. It spends tokens.
//   sessions, block, approvals   arrive with their steps (binding, the instruction block); setup
//                         never writes approval rules
//
// Each row says what is wrong in plain words and the command that fixes it. Rows name a home by
// its app and instance, never by its path; no entry content, prompt, model answer or token is
// printed or logged. The headless run's prompt goes on stdin, never in argv.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { uptime } from "node:os";
import { join, win32 } from "node:path";
import { CLI_NAME, MCP_SERVER_KEY, PRODUCT_NAME } from "@tasks/brand";
import generatedTools from "@tasks/contracts/generated/mcp-tools.json" with { type: "json" };
import { makeDir } from "@tasks/files";
import { helperOutput, startHelper, type Env } from "@tasks/launch";
import {
  appLabel,
  codexEngines,
  commandEnv,
  commandFor,
  readRecords,
  readsHome,
  samePath,
  SetupStateInvalid,
  survey,
  t3HomesOf,
  type HomeView,
  type SetupInput,
} from "@tasks/service/setup";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { setupInputOf, type AgentsSetupOptions } from "./setup-agents.ts";

export interface AgentDoctorOptions extends ConnectOptions {
  readonly agents?: AgentsSetupOptions;
}

/** One row of doctor's report (doctor.ts has the same shape; it loads this file, not the reverse). */
export interface Check {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail" | "skip";
  readonly detail: string;
}

/** A `status` round trip through the bridge must take less than this (A3 3.14). */
export const BRIDGE_ROUND_TRIP_MS = 2_000;
/** How long one bridge probe may take in all, its start included. */
const BRIDGE_PROBE_MS = 20_000;
/** How long a headless run may take (`--live`): a model answers in this time or the row fails. */
const LIVE_MS = 180_000;
/** How long an app's own `mcp get` may take. */
const GET_MS = 30_000;
/** At most this much of an app's own `mcp get` is read: more is no answer. */
const GET_CHARS = 256 * 1024;

/** The fixed prompt of `--live`. Product text, never task text; it goes on stdin. */
const LIVE_PROMPT = `Call the ${MCP_SERVER_KEY} MCP tool "status" once, with no arguments. Then reply with the single word done.\n`;

/** The tool names this build lists (contracts' generated list). */
const TOOL_NAMES: readonly string[] = generatedTools.tools.map((t) => t.name);

const name = (view: HomeView): string => `${appLabel(view.home.app)} (${view.home.instance})`;

type Call = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The value after `flag` in an argv, or undefined. */
function argAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

interface Row {
  readonly grant: string;
  readonly app: string;
  readonly home: string;
  readonly instance: string;
  readonly spaces: readonly string[];
}

/** The rows that need no registered home: they read only the environment. */
function envCheck(env: Env): Check {
  return env["CLAUDE_CODE_MCP_ALLOWLIST_ENV"] === "1"
    ? {
        id: "claude.env",
        status: "warn",
        detail:
          "CLAUDE_CODE_MCP_ALLOWLIST_ENV=1 is set where Claude Code starts: Claude Code then passes MCP servers only allow-listed variables, so the ticket of a launch may not reach the bridge. Remove it from your shell profile unless you need it.",
      }
    : {
        id: "claude.env",
        status: "ok",
        detail: "Claude Code's environment passes the bridge what it needs.",
      };
}

const SKIPPED_ROWS: readonly Check[] = [
  { id: "sessions", status: "skip", detail: "Arrives with session binding." },
  { id: "block", status: "skip", detail: "Arrives with the optional instruction block." },
  {
    id: "approvals",
    status: "skip",
    detail: `${PRODUCT_NAME} never writes approval rules: ${CLI_NAME} setup agents --parts approve-tools shows the change to make by hand.`,
  },
];

/** The agent-side rows of `tasks doctor` (A3 3.14). */
export async function agentChecks(
  io: Io,
  state: string,
  live: boolean,
  options: AgentDoctorOptions,
): Promise<Check[]> {
  const env = options.agents?.env ?? io.env;
  const checks: Check[] = [envCheck(env)];
  let records;
  try {
    records = readRecords(state);
  } catch (error) {
    if (!(error instanceof SetupStateInvalid)) throw error;
    return [
      ...checks,
      {
        id: "agents",
        status: "fail",
        detail: `Setup's record of the agent homes (setup/agents.json in the state folder) cannot be read, so setup changes nothing. Move it aside, take ${PRODUCT_NAME}'s entries out of the apps by hand, then run: ${CLI_NAME} setup agents`,
      },
      ...SKIPPED_ROWS,
    ];
  }
  if (records.length === 0) {
    return [
      ...checks,
      {
        id: "agents",
        status: "warn",
        detail: `No agent app has ${PRODUCT_NAME}'s MCP entry yet, so agents cannot reach it. Run: ${CLI_NAME} setup agents`,
      },
      ...SKIPPED_ROWS,
      liveSkipped(live, "No agent home is registered."),
    ];
  }

  const { input } = await setupInputOf(io, options);
  const resolve = (argv: readonly string[]) => options.agents?.resolve?.(argv) ?? argv;
  const views = survey(input).filter((view) => view.record !== undefined);
  let session: Session | undefined;
  try {
    session = await connectService(io, options);
  } catch {
    session = undefined;
  }
  const call: Call | undefined =
    session === undefined
      ? undefined
      : async (method, params) =>
          (await session.call(method, params, { timeoutMs: 30_000 })) as Record<string, unknown>;
  try {
    let rows: Row[] | undefined;
    try {
      rows =
        call === undefined
          ? undefined
          : (((await call("setup/homes", {}))["homes"] ?? []) as Row[]);
    } catch {
      rows = undefined;
    }
    const rowOf = (view: HomeView) =>
      rows?.find(
        (r) => r.app === view.home.app && samePath(input.platform, r.home, view.home.home),
      );

    for (const view of views) {
      checks.push(
        await mcpCheck(
          input,
          view,
          rows === undefined ? undefined : (rowOf(view) ?? null),
          resolve,
        ),
      );
      if (view.home.app === "codex" && view.state === "registered") {
        checks.push(await enginesCheck(input, view, resolve));
      }
      if (view.state === "registered") {
        checks.push(
          session === undefined
            ? {
                id: `bridge.${view.home.instance}`,
                status: "skip",
                detail: "No service: the bridge's round trip needs it.",
              }
            : await bridgeCheck(io, view, resolve),
        );
      }
      if (view.home.app === "claude-desktop" && view.state === "registered") {
        checks.push(
          await restartCheck(view, options.agents?.desktopStarted ?? (() => desktopStarted(io))),
        );
      }
    }
    checks.push(grantsCheck(input, views, rows));
    checks.push(t3Check(input, survey(input)));
    checks.push(...SKIPPED_ROWS);
    if (!live) checks.push(liveSkipped(false, ""));
    else {
      const liveMs = options.agents?.liveMs ?? LIVE_MS;
      checks.push(...(await liveChecks(input, state, views, call, resolve, liveMs)));
    }
    return checks;
  } finally {
    session?.close();
  }
}

function liveSkipped(live: boolean, why: string): Check {
  return {
    id: "live",
    status: "skip",
    detail: live
      ? why
      : `${CLI_NAME} doctor --live asks each agent app to call ${PRODUCT_NAME} once; it spends tokens, so it never runs by itself.`,
  };
}

const REFUSED: Readonly<Record<string, string>> = {
  managed:
    "its file is now managed elsewhere (a link, generated, listed, or tracked by another git repository)",
  unsafe: "its file or folder now belongs to another user, or anyone can change it",
  not_set_up: "its file is gone",
};

/** `mcp.<instance>`: the entry setup wrote, as the file and the app itself see it. */
async function mcpCheck(
  input: SetupInput,
  view: HomeView,
  row: Row | null | undefined,
  resolve: (argv: readonly string[]) => readonly string[],
): Promise<Check> {
  const id = `mcp.${view.home.instance}`;
  const fix = `${CLI_NAME} setup agents --remove, then ${CLI_NAME} setup agents and the apply it prints`;
  const record = view.record;
  if (record === undefined) return { id, status: "skip", detail: "Not registered by setup." };
  switch (view.state) {
    case "refused":
      return {
        id,
        status: "fail",
        detail: `${name(view)}: setup can no longer read its file: ${REFUSED[view.refusal ?? ""] ?? "the file is not in a state setup understands"}. Fix the file, then run: ${CLI_NAME} setup agents --status`,
      };
    case "interrupted":
      return {
        id,
        status: "fail",
        detail: `${name(view)}: an apply did not finish. Run: ${fix}`,
      };
    case "missing":
      return {
        id,
        status: "fail",
        detail: `${name(view)}: ${PRODUCT_NAME}'s entry is gone, so this app cannot reach ${PRODUCT_NAME}. Run: ${fix}`,
      };
    case "edited":
      return {
        id,
        status: "warn",
        detail: `${name(view)}: the entry was changed by hand after setup wrote it, so setup leaves it alone. If that was not meant, take it out by hand, then run: ${CLI_NAME} setup agents`,
      };
    default:
      break;
  }
  // The app's own view of its entry (A3 3.14: "according to the app's own mcp get").
  const exec = commandFor(input, view.home);
  if (exec !== undefined) {
    const args =
      view.home.app === "codex"
        ? ["mcp", "get", MCP_SERVER_KEY, "--json"]
        : ["mcp", "get", MCP_SERVER_KEY];
    const out = await output(input, view, resolve([...exec, ...args]));
    if (out === undefined) {
      return {
        id,
        status: "fail",
        detail: `${name(view)}: the app's own mcp get does not find ${PRODUCT_NAME}'s entry, though its file has it. Run: ${fix}`,
      };
    }
  }
  const argv = record.entry_argv;
  const command = argv[0] ?? "";
  if (!isFile(command)) {
    return {
      id,
      status: "fail",
      detail: `${name(view)}: the entry runs a ${CLI_NAME} command that is not there any more. Install ${PRODUCT_NAME} again, or run: ${fix}`,
    };
  }
  if (!samePath(input.platform, command, input.tasks)) {
    return {
      id,
      status: "warn",
      detail: `${name(view)}: the entry runs another ${CLI_NAME} than this install's stable command. Run: ${fix}`,
    };
  }
  if (row === null) {
    return {
      id,
      status: "fail",
      detail: `${name(view)}: the entry has no grant row in the service. Run: ${CLI_NAME} setup agents, then the apply it prints (it renews the row)`,
    };
  }
  if (
    row !== undefined &&
    (row.spaces[0] !== argAfter(argv, "--space") || row.instance !== argAfter(argv, "--instance"))
  ) {
    return {
      id,
      status: "fail",
      detail: `${name(view)}: the entry's --space or --instance does not match its grant row. Run: ${fix}`,
    };
  }
  return {
    id,
    status: "ok",
    detail: `${name(view)}: ${PRODUCT_NAME}'s entry is in place and runs this install's command${row === undefined ? "" : ", as its grant row says"}.`,
  };
}

/** `codex.engines.<instance>`: every engine that reads the home reads Tasks's entry. */
async function enginesCheck(
  input: SetupInput,
  view: HomeView,
  resolve: (argv: readonly string[]) => readonly string[],
): Promise<Check> {
  const id = `codex.engines.${view.home.instance}`;
  const engines = codexEngines(input, view.home);
  if (engines.length === 0) {
    return { id, status: "skip", detail: `${name(view)}: no Codex engine was found to ask.` };
  }
  const command = view.record?.entry_argv[0] ?? "";
  const failed: string[] = [];
  for (const engine of engines) {
    const out = await output(
      input,
      view,
      resolve([...engine.exec, "mcp", "get", MCP_SERVER_KEY, "--json"]),
    );
    if (!readsEntry(out, command)) {
      failed.push(engine.kind === "app" ? "the Codex app's engine" : "the Codex CLI");
    }
  }
  return failed.length === 0
    ? {
        id,
        status: "ok",
        detail: `${name(view)}: ${engines.length === 1 ? "its Codex engine reads" : `all ${String(engines.length)} Codex engines read`} ${PRODUCT_NAME}'s entry.`,
      }
    : {
        id,
        status: "fail",
        detail: `${name(view)}: ${[...new Set(failed)].join(" and ")} cannot read ${PRODUCT_NAME}'s entry (it rejects the file or a key setup wrote). Update that Codex, or run: ${CLI_NAME} setup agents --remove`,
      };
}

/** Whether an engine's `mcp get --json` answer is JSON that names the entry's command. */
function readsEntry(out: string | undefined, command: string): boolean {
  if (out === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(out)).includes(JSON.stringify(command));
  } catch {
    return false;
  }
}

/**
 * An app's command's stdout in the home's environment, or undefined when it failed: a helper of
 * the runner's (@tasks/launch helpers.ts), like every program doctor starts.
 */
function output(
  input: SetupInput,
  view: HomeView,
  argv: readonly string[],
): Promise<string | undefined> {
  const { env } = commandEnv(input, view.home);
  return helperOutput(argv, {
    env,
    cwd: input.userHome,
    deadlineMs: GET_MS,
    maxChars: GET_CHARS,
  });
}

/** A folder as the OS resolves it (links, case, short names), or as given when it cannot. */
function realFolder(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `grants`: each registered home has its row, and each row an entry of setup's. */
function grantsCheck(
  input: SetupInput,
  views: readonly HomeView[],
  rows: readonly Row[] | undefined,
): Check {
  if (rows === undefined) return { id: "grants", status: "skip", detail: "No service to ask." };
  const registered = views.filter((v) => v.record?.state === "applied");
  const without = registered.filter(
    (v) => !rows.some((r) => r.app === v.home.app && samePath(input.platform, r.home, v.home.home)),
  );
  const orphans = rows.filter(
    (r) =>
      !views.some((v) => v.home.app === r.app && samePath(input.platform, r.home, v.home.home)),
  );
  if (without.length > 0) {
    return {
      id: "grants",
      status: "fail",
      detail: `${without.map(name).join(", ")} ${without.length === 1 ? "has" : "have"} no grant row in the service. Run: ${CLI_NAME} setup agents, then the apply it prints (it renews the rows)`,
    };
  }
  if (orphans.length > 0) {
    return {
      id: "grants",
      status: "warn",
      detail: `${String(orphans.length)} grant row${orphans.length === 1 ? " has" : "s have"} no entry of setup's. Run: ${CLI_NAME} setup agents --remove (it revokes rows without entries)`,
    };
  }
  return {
    id: "grants",
    status: "ok",
    detail: "Every registered home has its grant row, and every row its entry.",
  };
}

/** A T3 provider instance's key that a row may show as it is. */
const PROVIDER_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

/** `t3.homes`: every home a T3 provider instance runs in has Tasks's entry. */
function t3Check(input: SetupInput, views: readonly HomeView[]): Check {
  const homes = t3HomesOf(input);
  if (homes.length === 0) {
    return { id: "t3.homes", status: "skip", detail: "T3 Code is not on this machine." };
  }
  // A provider instance that names Claude Code's default folder by its path reads `.claude.json`
  // inside it, not the user's `~/.claude.json` the default home's entry is in (readsHome).
  const elsewhere = homes.filter((t3) =>
    views.some(
      (v) =>
        v.home.app === t3.app &&
        samePath(input.platform, v.home.home, t3.home) &&
        !readsHome(input.platform, t3, v.home.app, v.home.home, v.home.isDefault),
    ),
  );
  const gaps = homes.filter((t3) => {
    if (elsewhere.includes(t3)) return false;
    const view = views.find((v) =>
      readsHome(input.platform, t3, v.home.app, v.home.home, v.home.isDefault),
    );
    return view === undefined || !(view.state === "registered" || view.state === "edited");
  });
  if (gaps.length === 0 && elsewhere.length === 0) {
    return {
      id: "t3.homes",
      status: "ok",
      detail: `Every home T3 Code's provider instances use has ${PRODUCT_NAME}'s entry.`,
    };
  }
  // A provider instance by its key in T3's settings when that is a plain name; a key with a path,
  // spaces or control characters in it never reaches a row.
  const label = (g: (typeof homes)[number]) =>
    `${PROVIDER_KEY.test(g.provider) ? g.provider : "(a key that is not a plain name)"} (${g.app === "codex" ? "Codex" : "Claude Code"})`;
  // Each part says what to do; the command that fixes a gap comes last, as the row's last words.
  const parts = elsewhere.map((t3) =>
    t3.isDefault
      ? `T3 Code's provider instance ${label(t3)} uses Claude Code's default home, so Claude Code reads the user's .claude.json, while machine.toml names that folder by its variable and setup's entry is inside it: set the instance's home path in T3 Code's settings to that folder.`
      : `T3 Code's provider instance ${label(t3)} names Claude Code's default folder as its home path, so Claude Code reads the configuration inside that folder, where setup wrote no entry: in T3 Code's settings, clear the instance's home path so it uses the default home as the CLI does.`,
  );
  if (gaps.length > 0) {
    parts.push(
      `T3 Code's provider instance${gaps.length === 1 ? "" : "s"} ${gaps.map(label).join(", ")} ${gaps.length === 1 ? "runs" : "run"} in a home without ${PRODUCT_NAME}'s entry. Run: ${CLI_NAME} setup agents --app t3`,
    );
  }
  return { id: "t3.homes", status: "warn", detail: parts.join(" ") };
}

/** `desktop.restart`: Claude Desktop loads its configuration only when it starts (A3 3.13.3). */
async function restartCheck(
  view: HomeView,
  started: () => Promise<number | "not_running" | undefined>,
): Promise<Check> {
  const id = "desktop.restart";
  const changed = Date.parse(view.record?.at ?? "");
  const booted = Date.now() - uptime() * 1000;
  const ok: Check = {
    id,
    status: "ok",
    detail: "Claude Desktop has started since setup changed its configuration.",
  };
  if (!Number.isFinite(changed) || booted > changed) return ok;
  const at = await started();
  if (at === "not_running") {
    return {
      id,
      status: "ok",
      detail: "Claude Desktop is not running; it loads the entry when it starts.",
    };
  }
  if (typeof at === "number" && at > changed) return ok;
  return {
    id,
    status: "warn",
    detail:
      at === undefined
        ? `If Claude Desktop was running when setup changed its configuration (${view.record?.at ?? ""}), quit and reopen it: it loads the entry only when it starts.`
        : "Restart needed: Claude Desktop started before setup changed its configuration. Quit and reopen it.",
  };
}

/**
 * When Claude Desktop started: on Windows the earliest start of its `claude.exe` from the MSIX or
 * the classic install (not Claude Code's own `claude.exe`), asked of CIM through Windows
 * PowerShell by its full path; `not_running` when none runs. Elsewhere unknown.
 */
async function desktopStarted(io: Io): Promise<number | "not_running" | undefined> {
  if (io.platform !== "win32") return undefined;
  const root = io.env["SystemRoot"] ?? "C:\\Windows";
  const powershell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { [string]$_.ExecutablePath + '|' + $_.CreationDate.ToUniversalTime().ToString('o') }";
  const out = await helperOutput(
    [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: io.env,
      cwd: io.cwd,
      deadlineMs: 15_000,
      maxChars: 1024 * 1024,
    },
  );
  if (out === undefined) return undefined;
  const starts = out
    .split(/\r?\n/u)
    .map((line) => line.split("|"))
    .filter(([path]) => /\\WindowsApps\\Claude_|\\AnthropicClaude\\/iu.test(path ?? ""))
    .map(([, at]) => Date.parse(at ?? ""))
    .filter(Number.isFinite);
  return starts.length === 0 ? "not_running" : Math.min(...starts);
}

// ---------------------------------------------------------------------------------------------
// Programs doctor starts (the entries' commands for the bridge probe, the apps for --live, the
// apps' own `mcp get`, Windows PowerShell for desktop.restart) are all helpers of the runner in
// @tasks/launch (helpers.ts, A3 3.14): it ends each with what it started at its deadline, on stop,
// and when doctor exits, so a headless run never goes on, and spends tokens, after the person
// stopped doctor. This file imports no child_process (dependency-cruiser checks it).

// ---------------------------------------------------------------------------------------------
// The bridge probe

type Message = Record<string, unknown>;

/** A line of the probe's output not yet ended may be at most this long; past it the probe ends. */
const MAX_PROBE_LINE = 1024 * 1024;

const isMessage = (value: unknown): value is Message =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Probe {
  request(method: string, params: Message): Promise<Message | undefined>;
  notify(method: string): void;
  /** Whether the deadline ended the probe: every request still open then got no answer. */
  timedOut(): boolean;
  close(): Promise<void>;
}

/**
 * The entry's command with stdio, as an agent app starts it: one JSON-RPC line at a time, as a
 * helper of the runner. A line that is not a JSON object is no answer; a line longer than the bound
 * ends the probe. When the program ends, by itself or by the deadline, every open request settles
 * without an answer. Throws when the command cannot be started at all.
 */
function probe(argv: readonly string[], env: Env, cwd: string, deadlineMs: number): Probe {
  const run = startHelper(argv, { env, cwd, deadlineMs, stdin: true, stdout: true });
  const { child } = run;
  const replies = new Map<unknown, (message: Message | undefined) => void>();
  let ended = false;
  const settleAll = () => {
    ended = true;
    for (const settle of replies.values()) settle(undefined);
    replies.clear();
  };
  const stop = () => {
    settleAll();
    run.stop();
  };
  const exited = run.ended.then(settleAll);
  let pending = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isMessage(message) || "method" in message) continue;
      const settle = replies.get(message["id"]);
      if (settle !== undefined) {
        replies.delete(message["id"]);
        settle(message);
      }
    }
    if (pending.length > MAX_PROBE_LINE) stop();
  });
  let next = 1;
  return {
    request(method, params) {
      if (ended) return Promise.resolve(undefined);
      const id = next;
      next += 1;
      return new Promise((resolve) => {
        replies.set(id, resolve);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method) {
      if (!ended) child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    timedOut: () => run.timedOut(),
    async close() {
      child.stdin?.end();
      const timer = setTimeout(stop, 3_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

const MODERN_META = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: `${CLI_NAME}-doctor`, version: "1" },
  },
};

/** The error code at the start of a tool's error text (A3 3.5: `error <code> …`), or a word. */
const errorCode = (text: unknown): string =>
  /^error ([a-z_]+)/u.exec(typeof text === "string" ? text : "")?.[1] ?? "error";

/** `bridge.<instance>`: the registered command answers in both eras and reaches the service. */
async function bridgeCheck(
  io: Io,
  view: HomeView,
  resolve: (argv: readonly string[]) => readonly string[],
): Promise<Check> {
  const id = `bridge.${view.home.instance}`;
  const argv = resolve(view.record?.entry_argv ?? []);
  const failed = (why: string): Check => ({
    id,
    status: "fail",
    detail: `${name(view)}: the entry's command ${why}. Run: ${CLI_NAME} doctor again once the service runs; if it stays, run ${CLI_NAME} setup agents --remove, then ${CLI_NAME} setup agents`,
  });
  const legacy = async (): Promise<Check | number> => {
    const bridge = probe(argv, io.env, io.cwd, BRIDGE_PROBE_MS);
    // An answer missing because the deadline ended the probe is a probe out of time.
    const fail = (why: string) => failed(bridge.timedOut() ? "did not answer in time" : why);
    try {
      const init = await bridge.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: `${CLI_NAME}-doctor`, version: "1" },
      });
      if (!isMessage(init?.["result"])) return fail("did not answer initialize");
      bridge.notify("notifications/initialized");
      const listed = await bridge.request("tools/list", {});
      const result = listed?.["result"];
      const tools = isMessage(result) && Array.isArray(result["tools"]) ? result["tools"] : [];
      const names = tools.map((t: unknown) => (isMessage(t) ? t["name"] : undefined));
      if (names.length !== TOOL_NAMES.length || !TOOL_NAMES.every((n) => names.includes(n))) {
        return fail("lists other tools than this build's (an older or newer install answers)");
      }
      const started = performance.now();
      const status = await bridge.request("tools/call", { name: "status", arguments: {} });
      const took = performance.now() - started;
      const answer = status?.["result"];
      if (!isMessage(answer)) return fail("did not answer a status call");
      if (answer["isError"] === true) {
        const content = Array.isArray(answer["content"]) ? (answer["content"] as unknown[]) : [];
        const first = content[0];
        return failed(
          `got an error for status (${errorCode(isMessage(first) ? first["text"] : undefined)})`,
        );
      }
      return took;
    } finally {
      await bridge.close();
    }
  };
  const modern = async (): Promise<boolean> => {
    const bridge = probe(argv, io.env, io.cwd, BRIDGE_PROBE_MS);
    try {
      const discovered = await bridge.request("server/discover", MODERN_META);
      return isMessage(discovered?.["result"]);
    } finally {
      await bridge.close();
    }
  };
  try {
    const first = await legacy();
    if (typeof first !== "number") return first;
    if (!(await modern())) {
      return failed("did not answer server/discover (the 2026-07-28 era)");
    }
    if (first >= BRIDGE_ROUND_TRIP_MS) {
      return {
        id,
        status: "warn",
        detail: `${name(view)}: a status round trip took ${String(Math.round(first))} ms, over ${String(BRIDGE_ROUND_TRIP_MS)} ms. Run: ${CLI_NAME} doctor again; if it stays slow, restart the service with ${CLI_NAME} service restart`,
      };
    }
    return {
      id,
      status: "ok",
      detail: `${name(view)}: the entry's command answers both eras, lists this build's tools, and a status round trip took ${String(Math.round(first))} ms.`,
    };
  } catch {
    return failed("could not be started");
  }
}

// ---------------------------------------------------------------------------------------------
// --live

/** The headless call of an app (A3 3.14 `live`), or undefined for an app without one. */
function liveArgv(app: HomeView["home"]["app"], exec: readonly string[]): string[] | undefined {
  if (app === "claude-code") {
    return [
      ...exec,
      "-p",
      "--allowedTools",
      `mcp__${MCP_SERVER_KEY}__status`,
      "--no-session-persistence",
    ];
  }
  if (app === "codex") {
    return [
      ...exec,
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-c",
      `mcp_servers.${MCP_SERVER_KEY}.default_tools_approval_mode="approve"`,
      "-",
    ];
  }
  return undefined;
}

/**
 * Runs `argv` as a helper of the runner with `stdin` and nothing kept of its output; its exit code,
 * or null when it could not start or its deadline ended it.
 */
async function runHeadless(
  argv: readonly string[],
  env: Env,
  cwd: string,
  stdin: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const run = startHelper(argv, { env, cwd, deadlineMs: timeoutMs, stdin: true });
    run.child.stdin?.end(stdin);
    return await run.ended;
  } catch {
    return null;
  }
}

/** `live`: one headless call per registered app home, and the service saw it from that home. */
async function liveChecks(
  input: SetupInput,
  state: string,
  views: readonly HomeView[],
  call: Call | undefined,
  resolve: (argv: readonly string[]) => readonly string[],
  liveMs: number,
): Promise<Check[]> {
  if (call === undefined) return [liveSkipped(true, "No service: it must see the call.")];
  sweepLive(state, liveMs);
  const checks: Check[] = [];
  for (const view of views.filter((v) => v.state === "registered")) {
    const id = `live.${view.home.instance}`;
    const exec = commandFor(input, view.home);
    const argv = exec === undefined ? undefined : liveArgv(view.home.app, exec);
    if (argv === undefined) {
      checks.push({
        id,
        status: "skip",
        detail: `${name(view)}: ${exec === undefined && view.home.app !== "claude-desktop" ? "the app's command was not found on this PATH" : "the app has no headless mode"}.`,
      });
      continue;
    }
    // A temporary folder of the doctor's own: the run's working folder, removed by its full name.
    const dir = join(state, "tmp", `${LIVE_FOLDER}${randomBytes(6).toString("hex")}`);
    makeDir(dir, 0o700);
    const started = Date.now();
    try {
      const code = await runHeadless(
        resolve(argv),
        commandEnv(input, view.home).env,
        dir,
        LIVE_PROMPT,
        liveMs,
      );
      // The run's own evidence: a call from this home's instance, after the run started, from a
      // bridge working in the run's folder (the app starts its servers there). A call from the
      // home in another folder may be another session's.
      const folders = [dir, realFolder(dir)].filter((f, i, all) => all.indexOf(f) === i);
      const seen = ((await call("setup/seen", { folders }))["calls"] ?? []) as {
        instance: string;
        at: string;
        folder_at?: string | null;
      }[];
      const mine = seen.find((s) => s.instance === view.home.instance);
      const after = (time: string | null | undefined) => {
        const at = Date.parse(time ?? "");
        return Number.isFinite(at) && at >= started;
      };
      checks.push(
        after(mine?.folder_at)
          ? {
              id,
              status: "ok",
              detail: `${name(view)}: the service carried out a call from this home through the app.`,
            }
          : after(mine?.at)
            ? {
                id,
                status: "warn",
                detail: `${name(view)}: the service saw a call from this home during the run, but not from the run's own folder, so another session of this home may have made it. Close other sessions of this app, then run: ${CLI_NAME} doctor --live`,
              }
            : {
                id,
                status: "fail",
                detail: `${name(view)}: the app ${code === 0 ? "ran, but the service saw no call from this home" : "did not finish its headless run"}. Check that the app is signed in and loads MCP servers, then run: ${CLI_NAME} setup agents --status`,
              },
      );
    } finally {
      removeFolder(dir);
    }
  }
  return checks.length === 0 ? [liveSkipped(true, "No registered home to call through.")] : checks;
}

/** The name of `--live`'s working folders in `<state>/tmp`, before 12 hex digits. */
const LIVE_FOLDER = "doctor-live-";

/**
 * Removes a working folder of doctor's own. On Windows a process an app left behind may still hold
 * it: it stays then, without failing the report, and a later `--live` removes it (sweepLive).
 */
function removeFolder(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch {
    // Left for the next sweep.
  }
}

/** Earlier runs' working folders that could not be removed then, once no run can still use them. */
function sweepLive(state: string, liveMs: number): void {
  const tmp = join(state, "tmp");
  let names: string[];
  try {
    names = readdirSync(tmp);
  } catch {
    return;
  }
  const pattern = new RegExp(`^${LIVE_FOLDER}[0-9a-f]{12}$`, "u");
  for (const name of names.filter((n) => pattern.test(n))) {
    const dir = join(tmp, name);
    try {
      if (Date.now() - lstatSync(dir).mtimeMs > 2 * liveMs) removeFolder(dir);
    } catch {
      // Gone meanwhile.
    }
  }
}
