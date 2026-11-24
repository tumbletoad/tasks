// Fake `claude` and `codex` commands for the tests of detection and `ttasks doctor` (A3 3.14, M4.05):
// small Node scripts laid out as npm installs, so detection finds them on a scratch PATH and runs
// them as `node <entry>` on every OS (A4 3.2), and doctor runs them as real processes. They read the
// entries setup wrote (`.claude.json` in CLAUDE_CONFIG_DIR, else the user home, and
// `$CODEX_HOME/config.toml`), and only in a scratch user home:
// - `--version` prints a version in each tool's form.
// - `claude mcp get <name>` and `codex mcp get <name> --json` exit 0 and describe the entry when it
//   is there, 1 when it is not (doctor's `mcp` and `codex.engines` checks, M4.05).
// - Headless runs (doctor's `--live`): `claude -p --allowedTools mcp__<name>__<tool> …` and
//   `codex exec … -c mcp_servers.<name>.default_tools_approval_mode="approve" -` read the prompt
//   from stdin, start the server their own file names for <name> (as the app would), and call
//   <tool> once over MCP, as a model told to call it would. Exit 0 when the call was answered
//   without an error. FAKE_AGENT_TASKS (`{"path", "argv"}`) runs an entry whose command is `path`
//   as `argv` followed by its arguments: a scratch install's command can stand for the CLI.
//
// A fake refuses to run unless FAKE_AGENT_HOME names the scratch user home, and refuses a file
// outside it, so a test can never reach a real home. Each run appends one JSON line to
// FAKE_AGENT_LOG: the tool, its arguments and the home variables it saw. FAKE_AGENT_FAIL=<tool>
// makes that tool's `mcp` commands exit 1; `<tool>:get` makes its `mcp get` fail as an engine that
// rejects the file.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";

const COMMON = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const base = process.env.FAKE_AGENT_HOME;
if (!base || !path.isAbsolute(base)) process.exit(97);
const inside = (file) => {
  const rel = path.relative(path.resolve(base), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const log = (tool) => {
  const out = process.env.FAKE_AGENT_LOG;
  if (!out) return;
  const env = {};
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) env[name] = process.env[name] ?? null;
  fs.appendFileSync(out, JSON.stringify({ tool, args, env }) + "\n");
};
const failModes = (process.env.FAKE_AGENT_FAIL ?? "").split(",");
const readStdin = () => {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
};
// Starts an MCP server as an agent app does, and calls one tool with no arguments. Resolves true
// when the call was answered without an error.
const callTool = (command, serverArgs, tool) => new Promise((resolve) => {
  const map = process.env.FAKE_AGENT_TASKS ? JSON.parse(process.env.FAKE_AGENT_TASKS) : undefined;
  const argv = map && command === map.path ? [...map.argv, ...serverArgs] : [command, ...serverArgs];
  let child;
  try {
    child = require("node:child_process").spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "ignore"], env: process.env, windowsHide: true,
    });
  } catch { resolve(false); return; }
  let buffer = "";
  let done = false;
  let exited = false;
  // The server ends when its stdin does: the answer waits for that, or kills it after a bound.
  const finish = (ok) => {
    if (done) return;
    done = true;
    try { child.stdin.end(); } catch {}
    if (exited) { resolve(ok); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(ok); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(ok); });
  };
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  child.on("error", () => { exited = true; finish(false); });
  child.on("exit", () => { exited = true; finish(false); });
  child.stdin.on("error", () => finish(false));
  child.stdout.setEncoding("utf8").on("data", (data) => {
    buffer += data;
    for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: {} } });
      } else if (message.id === 2) {
        finish(message.result !== undefined && message.result.isError !== true);
      }
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" },
  } });
  setTimeout(() => finish(false), 60000).unref();
});
`;

const CLAUDE = String.raw`${COMMON}
log("claude");
if (args[0] === "--version") { process.stdout.write("2.1.9 (Claude Code)\n"); process.exit(0); }
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir ? path.join(dir, ".claude.json") : path.join(base, ".claude.json");
if (!inside(file)) process.exit(98);
const modes = failModes.filter((f) => f.startsWith("claude"));
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
if (args[0] === "-p") {
  // A headless run: the model "calls" the one tool --allowedTools names.
  readStdin();
  const allowed = args[args.indexOf("--allowedTools") + 1] ?? "";
  const match = /^mcp__(.+)__([a-z_]+)$/.exec(allowed);
  const entry = match ? (read().mcpServers ?? {})[match[1]] : undefined;
  if (!entry) process.exit(4);
  callTool(entry.command, entry.args ?? [], match[2]).then((ok) => process.exit(ok ? 0 : 3));
  return;
}
if (args[0] !== "mcp") process.exit(2);
if (modes.includes("claude")) process.exit(1);
if (args[1] === "get") {
  if (modes.includes("claude:get")) process.exit(1);
  const entry = (read().mcpServers ?? {})[args[2]];
  if (!entry) process.exit(1);
  process.stdout.write(args[2] + ":\n  Type: stdio\n");
  process.exit(0);
}
process.exit(2);
`;

const CODEX = String.raw`${COMMON}
log("codex");
if (args[0] === "--version") { process.stdout.write("codex-cli 0.167.2\n"); process.exit(0); }
const home = process.env.CODEX_HOME || path.join(base, ".codex");
const file = path.join(home, "config.toml");
if (!inside(file)) process.exit(98);
const modes = failModes.filter((f) => f.startsWith("codex"));
// The keys of one server's table, as setup writes them: JSON-compatible values, and a literal
// string ('…', what TOML editors write for a Windows path) as its text.
const tableOf = (name) => {
  if (!fs.existsSync(file)) return undefined;
  const all = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const at = all.findIndex((line) => line.trim() === "[mcp_servers." + name + "]");
  if (at === -1) return undefined;
  const table = {};
  for (let i = at + 1; i < all.length && !all[i].trimStart().startsWith("["); i += 1) {
    const kv = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/.exec(all[i]);
    if (!kv) continue;
    const raw = kv[2];
    if (/^'[^']*'$/.test(raw)) { table[kv[1]] = raw.slice(1, -1); continue; }
    try { table[kv[1]] = JSON.parse(raw); } catch { table[kv[1]] = raw; }
  }
  return table;
};
if (args[0] === "exec") {
  // A headless run: the model "calls" status on the server whose approval the run sets.
  readStdin();
  const override = args.find((a) => /^mcp_servers\..+\.default_tools_approval_mode=/.test(a)) ?? "";
  const name = /^mcp_servers\.(.+)\.default_tools_approval_mode=/.exec(override)?.[1];
  const table = name === undefined ? undefined : tableOf(name);
  if (!table) process.exit(4);
  callTool(table.command, table.args ?? [], "status").then((ok) => process.exit(ok ? 0 : 3));
  return;
}
if (args[0] !== "mcp") process.exit(2);
if (modes.includes("codex")) process.exit(1);
if (args[1] === "get") {
  if (modes.includes("codex:get")) process.exit(1);
  const table = tableOf(args[2]);
  if (!table) process.exit(1);
  const { command, args: serverArgs, ...rest } = table;
  process.stdout.write(JSON.stringify({ name: args[2], enabled: true,
    transport: { type: "stdio", command, args: serverArgs ?? [] }, ...rest }) + "\n");
  process.exit(0);
}
process.exit(2);
`;

export interface FakeAgentCall {
  readonly tool: "claude" | "codex";
  readonly args: readonly string[];
  readonly env: { readonly CLAUDE_CONFIG_DIR: string | null; readonly CODEX_HOME: string | null };
}

export interface FakeAgents {
  /** The folder on PATH that holds the fakes. */
  readonly bin: string;
  /** An agent environment that finds only the fakes and Node. */
  readonly env: Record<string, string>;
  /** Every run of a fake so far, `--version` runs included. */
  calls(): FakeAgentCall[];
}

/** One npm-style install of a fake: `<bin>/node_modules/<package>/<entry>` and its name on PATH. */
function place(bin: string, name: string, pkg: string, entry: string, source: string): void {
  const file = join(bin, "node_modules", ...pkg.split("/"), ...entry.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  if (process.platform === "win32") {
    // npm's shim: detection finds it, never runs it, and runs the entry beside it with Node.
    writeFileSync(join(bin, `${name}.cmd`), "@echo off\r\nexit /b 9\r\n");
  } else {
    chmodSync(file, 0o755);
    symlinkSync(join("node_modules", ...pkg.split("/"), ...entry.split("/")), join(bin, name));
  }
}

/**
 * Lays out fake `claude` and `codex` commands in `<root>/bin` for the scratch user home `home`, and
 * returns the agent environment that finds them (and Node, from this test's own runtime).
 */
export function installFakeAgents(root: string, home: string): FakeAgents {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  place(bin, "claude", "@anthropic-ai/claude-code", "cli.js", CLAUDE);
  place(bin, "codex", "@openai/codex", "bin/codex.js", CODEX);
  const log = join(root, "calls.jsonl");
  const env: Record<string, string> = {
    PATH: [bin, dirname(process.execPath)].join(delimiter),
    FAKE_AGENT_HOME: home,
    FAKE_AGENT_LOG: log,
  };
  if (process.platform === "win32") {
    // Node needs these to start; they name no home.
    for (const name of ["SystemRoot", "windir", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
  }
  return {
    bin,
    env,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as FakeAgentCall)
        : [],
  };
}
