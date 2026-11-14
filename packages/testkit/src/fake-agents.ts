// Fake `claude` and `codex` commands for the tests of `tasks setup agents` (A3 3.13, M2.14): small
// Node scripts laid out as npm installs, so detection finds them on a scratch PATH and runs them as
// `node <entry>` on every OS (A4 3.2), and setup runs them as real processes.
//
// They do what the real CLIs did in lab run A (A7 3.7, rows A01 and A02), and only in a
// scratch user home:
// - `claude mcp add --scope user <name> -- <command> [args…]` sets `mcpServers.<name>` to
//   `{type: "stdio", command, args, env: {}}` in `.claude.json` (in CLAUDE_CONFIG_DIR, else the user
//   home) and rewrites the whole file as two-space JSON, as Claude Code does. `claude mcp remove
//   <name> --scope user` deletes the key and keeps `mcpServers`, empty or not.
// - `codex mcp add <name> -- <command> [args…]` appends `[mcp_servers.<name>]` with `command` and
//   `args` to `$CODEX_HOME/config.toml` (made when missing) and keeps every other byte, as Codex's
//   format-keeping editor does; `codex mcp remove <name>` cuts that table with its keys and the
//   blank line before it, and leaves a file that add made empty, as lab run A saw.
// - `--version` prints a version in each tool's form.
//
// A fake refuses to run unless FAKE_AGENT_HOME names the scratch user home, and refuses a file
// outside it, so a test can never reach a real home. Each run appends one JSON line to
// FAKE_AGENT_LOG: the tool, its arguments and the home variables it saw. FAKE_AGENT_FAIL=<tool>
// makes that tool's `mcp` commands exit 1 before writing; `<tool>:add-after` makes its `mcp add`
// write, then exit 1.
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
const nameAndCommand = (from) => {
  const sep = args.indexOf("--");
  const head = args.slice(from, sep === -1 ? args.length : sep);
  const tail = sep === -1 ? [] : args.slice(sep + 1);
  let scope = "local";
  const names = [];
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === "--scope" || head[i] === "-s") scope = head[(i += 1)];
    else names.push(head[i]);
  }
  return { scope, names, tail };
};
`;

const CLAUDE = String.raw`${COMMON}
log("claude");
if (args[0] === "--version") { process.stdout.write("2.1.9 (Claude Code)\n"); process.exit(0); }
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir ? path.join(dir, ".claude.json") : path.join(base, ".claude.json");
if (!inside(file)) process.exit(98);
if (args[0] !== "mcp") process.exit(2);
const modes = failModes.filter((f) => f.startsWith("claude"));
if (modes.includes("claude")) process.exit(1);
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const write = (doc) => fs.writeFileSync(file, JSON.stringify(doc, null, 2));
const { scope, names, tail } = nameAndCommand(2);
if (scope !== "user" || names.length !== 1) process.exit(2);
const name = names[0];
const doc = read();
if (args[1] === "add") {
  if (tail.length === 0) process.exit(2);
  doc.mcpServers ??= {};
  if (Object.hasOwn(doc.mcpServers, name)) process.exit(1);
  doc.mcpServers[name] = { type: "stdio", command: tail[0], args: tail.slice(1), env: {} };
  write(doc);
} else if (args[1] === "remove") {
  if (!doc.mcpServers || !Object.hasOwn(doc.mcpServers, name)) process.exit(1);
  delete doc.mcpServers[name];
  write(doc);
} else process.exit(2);
process.exit(args[1] === "add" && modes.includes("claude:add-after") ? 1 : 0);
`;

const CODEX = String.raw`${COMMON}
log("codex");
if (args[0] === "--version") { process.stdout.write("codex-cli 0.167.2\n"); process.exit(0); }
const home = process.env.CODEX_HOME || path.join(base, ".codex");
const file = path.join(home, "config.toml");
if (!inside(file)) process.exit(98);
if (args[0] !== "mcp") process.exit(2);
const modes = failModes.filter((f) => f.startsWith("codex"));
if (modes.includes("codex")) process.exit(1);
const { names, tail } = nameAndCommand(2);
if (names.length !== 1) process.exit(2);
const header = "[mcp_servers." + names[0] + "]";
const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const lines = text === null ? [] : text.split(/(?<=\n)/);
const at = lines.findIndex((line) => line.trim() === header);
if (args[1] === "add") {
  if (tail.length === 0) process.exit(2);
  if (at !== -1) process.exit(1);
  const eol = text !== null && text.includes("\r\n") ? "\r\n" : "\n";
  const q = (s) => JSON.stringify(s);
  const block = header + eol + "command = " + q(tail[0]) + eol +
    "args = [" + tail.slice(1).map(q).join(", ") + "]" + eol;
  const next = text === null || text === "" ? block : text + (text.endsWith("\n") ? "" : eol) + eol + block;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, next);
} else if (args[1] === "remove") {
  if (at === -1) process.exit(1);
  let end = at + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith("[")) end += 1;
  const start = at > 0 && lines[at - 1].trim() === "" ? at - 1 : at;
  lines.splice(start, end - start);
  fs.writeFileSync(file, lines.join(""));
} else process.exit(2);
process.exit(args[1] === "add" && modes.includes("codex:add-after") ? 1 : 0);
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
