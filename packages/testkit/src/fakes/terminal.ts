// A fake terminal program (A4 3.6.2; M2.09). The service's terminal adapters start it in place of
// Ghostty, GNOME Terminal, Windows Terminal and the others: a test's spawner (fakes.ts) maps the
// terminal's program path to `node <this file>` and passes every argument the service built.
//
// It records what it received, as JSON lines in FAKE_TERMINAL_LOG: its argv (after the program),
// the folder it was started in, its role and its PID. Then it behaves as its mode says:
// - `direct` (Ghostty `-e`, kitty, WezTerm, Konsole): runs the command at the end of its argv
//   (`<product…> shim <ticket>`) as its child in its own working folder, and lives as long as it
//   does, like a window that closes with its command;
// - `handoff` (Windows Terminal, GNOME Terminal): starts a detached copy of itself as the
//   "server", which runs the command after FAKE_TERMINAL_DELAY_MS, and exits at once with
//   FAKE_TERMINAL_EXIT (default 0), like a client that handed the request on;
// - `exit`: exits at once with FAKE_TERMINAL_EXIT and runs nothing, like a direct terminal whose
//   window failed to open;
// - `console`: Windows PowerShell's console starter (commands.ts): hands off as `handoff` does,
//   and the server starts the program its `…_CONSOLE_PROGRAM` variable names with the command
//   line in `…_CONSOLE_ARGUMENTS`, passed on verbatim as ShellExecute passes it to CreateProcess.
// The command's stdout and stderr go to files beside the log, so a test can read the shim's lines.
// No fake outlives its test: it ends its command and itself after FAKE_TERMINAL_MAX_MS.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

const env = process.env;
const log = env["FAKE_TERMINAL_LOG"];
const mode = env["FAKE_TERMINAL_MODE"] ?? "direct";
const role = env["FAKE_TERMINAL_ROLE"] ?? "client";
const exitCode = Number(env["FAKE_TERMINAL_EXIT"] ?? "0");
const delayMs = Number(env["FAKE_TERMINAL_DELAY_MS"] ?? "0");
const maxMs = Number(env["FAKE_TERMINAL_MAX_MS"] ?? "120000");
const productLength = Number(env["FAKE_TERMINAL_PRODUCT_LENGTH"] ?? "1");
const args = process.argv.slice(2);

const record = (entry: Record<string, unknown>): void => {
  if (log === undefined) return;
  appendFileSync(log, `${JSON.stringify({ pid: process.pid, role, mode, ...entry })}\n`);
};

/** The command at the end of the argv: `<product…> shim <ticket>`, or undefined. */
function commandOf(argv: readonly string[]): string[] | undefined {
  const at = argv.length - 2;
  if (at < productLength || argv[at] !== "shim") return undefined;
  return argv.slice(at - productLength);
}

function runCommand(): void {
  const command = commandOf(args);
  if (command === undefined) {
    record({ event: "no_command" });
    process.exit(64);
  }
  const [file, ...rest] = command;
  run(file ?? "", rest);
}

/**
 * Runs the command as this process's child and lives as long as it. On Windows the child gets a
 * hidden console of its own, as a terminal gives it a visible one: the shim's agent inherits that
 * console. A shim started without any console (`detached`) would give its agent a new, visible one.
 */
function run(file: string, rest: readonly string[], verbatim = false): void {
  const base = log ?? "fake-terminal";
  const out = openSync(`${base}.${String(process.pid)}.out`, "a");
  const err = openSync(`${base}.${String(process.pid)}.err`, "a");
  const child = spawn(file, rest, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", out, err],
    windowsHide: true,
    // The command line exactly as CreateProcess would get it: the program quoted, then the line.
    ...(verbatim ? { argv0: `"${file}"`, windowsVerbatimArguments: true } : {}),
  });
  closeSync(out);
  closeSync(err);
  const guard = setTimeout(() => {
    child.kill("SIGKILL");
    process.exit(124);
  }, maxMs);
  child.once("spawn", () => {
    record({ event: "command", child: child.pid });
  });
  child.once("error", () => {
    record({ event: "command_failed" });
    process.exit(127);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(guard);
    record({ event: "command_exit", code, signal });
    process.exit(code ?? 1);
  });
}

/** The console starter's program and command line, as its variables say. */
function consoleCommand(): { program: string | undefined; line: string | undefined } {
  const named = (suffix: string): string | undefined =>
    Object.entries(env).find(([name]) => name.endsWith(suffix))?.[1];
  return { program: named("_CONSOLE_PROGRAM"), line: named("_CONSOLE_ARGUMENTS") };
}

/** The console starter, faked: runs the program with its command line passed on verbatim. */
function runConsole(): void {
  const { program, line } = consoleCommand();
  if (program === undefined || line === undefined) process.exit(1);
  run(program, [line], true);
}

/** Starts a detached copy of this fake as the server, which outlives this client. */
function handOff(): void {
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: process.cwd(),
    env: { ...env, FAKE_TERMINAL_ROLE: "server" },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  server.once("spawn", () => {
    record({ event: "handed_off", server: server.pid });
    server.unref();
    process.exit(exitCode);
  });
  server.once("error", () => {
    process.exit(70);
  });
}

record({ event: "start", argv: args, cwd: process.cwd(), envNames: Object.keys(env).sort() });

if (role === "server") {
  setTimeout(mode === "console" ? runConsole : runCommand, delayMs);
} else if (mode === "exit") {
  process.exit(exitCode);
} else if (mode === "console") {
  const { program, line } = consoleCommand();
  record({ event: "console", program, arguments: line });
  if (program === undefined || line === undefined) process.exit(1);
  handOff();
} else if (mode === "handoff") {
  handOff();
} else {
  runCommand();
}
