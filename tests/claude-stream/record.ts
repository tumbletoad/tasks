// The recorder of what a real Claude Code says in print mode with JSON lines both ways
// (`claude -p --input-format stream-json --output-format stream-json`), as the run driver speaks
// it: one process per case, every line in both directions with its time, byte for byte into
// `<scratch>/raw/` only. sanitise.ts turns them into the fixtures in fixtures/claude-stream/, which
// the run driver's fake replays. Run by hand, never by a test:
//
//   pnpm exec node tests/claude-stream/record.ts <scratch> [case ...]
//   pnpm exec node tests/claude-stream/sanitise.ts <scratch> fixtures/claude-stream
//
// Its rules: the installed `claude`, the cheapest model, trivial requests in an empty folder inside
// the scratch folder, no session kept on disk (`--no-session-persistence`), nothing written into
// the Claude home and nothing in it opened or listed. The signed-out case starts with an empty home
// of its own in the scratch folder. The console gets event kinds and times only.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "haiku";

type Message = Record<string, unknown>;

interface Case {
  readonly request: string;
  readonly mode: string;
  /** Tasks' tools stand-in, under the name `tasks`, given as a file. */
  readonly tools?: boolean;
  /** An empty Claude home of the case's own. */
  readonly signedOut?: boolean;
  /** Interrupts this long after the first call of this tool. */
  readonly interruptOnTool?: string;
  /** Interrupts, and ends the input, this long after the first result. */
  readonly stopAfterResultMs?: number;
}

const CASES: Readonly<Record<string, Case>> = {
  plain: { request: "Reply with the word ok and nothing else.", mode: "bypassPermissions" },
  command: {
    request: "Run the shell command `echo hi` and then reply with its output only.",
    mode: "bypassPermissions",
  },
  tool: {
    request:
      "Call the tool probe_echo of the tasks server with the text hello. Then reply with the single word done.",
    mode: "bypassPermissions",
    tools: true,
  },
  background: {
    request:
      "Start the shell command `ping -n 8 127.0.0.1` as a background task (run_in_background true). Do not wait for it and do not check on it: reply with the word started right away.",
    mode: "bypassPermissions",
  },
  interrupt: {
    request:
      "Run the shell command `ping -n 30 127.0.0.1` in the foreground and wait for it. Then reply with the word done.",
    mode: "bypassPermissions",
    interruptOnTool: "PowerShell",
  },
  "background-agent": {
    request:
      "Use the Agent tool with run_in_background true (general-purpose subagent, model haiku) with this task for the subagent: run the shell command `ping -n 6 127.0.0.1`, then reply with the word pong. Do not wait for the subagent: reply with the word launched right away.",
    mode: "bypassPermissions",
  },
  "stop-background": {
    request:
      "Start the shell command `ping -n 30 127.0.0.1` as a background task (run_in_background true). Do not wait for it and do not check on it: reply with the word started right away.",
    mode: "bypassPermissions",
    stopAfterResultMs: 1_500,
  },
  question: {
    request:
      "Before anything else, use the AskUserQuestion tool to ask me whether I prefer red or blue. Then reply with my choice.",
    mode: "bypassPermissions",
  },
  denied: {
    request:
      "Run the shell command `ping -n 1 127.0.0.1` once. If it is refused, do not try again: reply with the word refused.",
    mode: "manual",
  },
  "signed-out": {
    request: "Reply with the word ok and nothing else.",
    mode: "bypassPermissions",
    signedOut: true,
  },
};

/** The environment of the session this runs in, without what marks it as an agent's. */
function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|T3CODE_)/i.test(name)) continue;
    env[name] = value;
  }
  return env;
}

function record(scratch: string, name: string, c: Case): Promise<void> {
  const work = join(scratch, `work-${name}`);
  mkdirSync(work, { recursive: true });
  mkdirSync(join(scratch, "raw"), { recursive: true });
  const fd = openSync(join(scratch, "raw", `${name}.jsonl`), "w", 0o600);
  const t0 = performance.now();
  const write = (dir: string, msg: unknown): void => {
    writeSync(fd, `${JSON.stringify({ dir, ms: Math.round(performance.now() - t0), msg })}\n`);
  };
  const env = environment();
  if (c.signedOut === true) {
    const home = join(scratch, `home-${name}`);
    mkdirSync(home, { recursive: true });
    env["CLAUDE_CONFIG_DIR"] = home;
  }
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    MODEL,
    "--no-session-persistence",
    "--permission-mode",
    c.mode,
    "--permission-prompt-tool",
    "stdio",
  ];
  if (c.tools === true) {
    const stub = fileURLToPath(new URL("../codex-app-server/mcp-stub.ts", import.meta.url));
    const file = join(scratch, `tools-${name}.json`);
    const tools = {
      mcpServers: { tasks: { type: "stdio", command: process.execPath, args: [stub], env: {} } },
    };
    const out = openSync(file, "w", 0o600);
    writeSync(out, JSON.stringify(tools));
    closeSync(out);
    args.push("--mcp-config", file);
  }
  const child = spawn("claude", args, { cwd: work, env, windowsHide: true });
  let ended = false;
  const send = (message: Message): void => {
    if (ended) return;
    write("send", message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    write("mark", { what: "stdin end" });
    child.stdin.end();
  };
  let interrupts = 0;
  const interrupt = (): void => {
    interrupts += 1;
    send({
      type: "control_request",
      request_id: `req_lab_${String(interrupts)}`,
      request: { subtype: "interrupt" },
    });
  };
  let background = 0;
  let stopping = false;
  let interrupted = false;
  let buffer = "";
  const kinds: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        write("recv-text", { text: line });
        continue;
      }
      write("recv", message);
      const type = String(message["type"]);
      kinds.push(`${String(Math.round(performance.now() - t0))} ${type}`);
      const content = (message["message"] as { content?: Message[] } | undefined)?.content ?? [];
      if (type === "system" && message["subtype"] === "background_tasks_changed") {
        background = Array.isArray(message["tasks"]) ? message["tasks"].length : 0;
      }
      if (
        c.interruptOnTool !== undefined &&
        !interrupted &&
        content.some((b) => b["type"] === "tool_use" && b["name"] === c.interruptOnTool)
      ) {
        interrupted = true;
        setTimeout(interrupt, 1_500);
      }
      if (type === "control_request") {
        const request = (message["request"] ?? {}) as Message;
        if (request["subtype"] === "can_use_tool") {
          const asks = request["requires_user_interaction"] === true;
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message["request_id"],
              response: asks
                ? { behavior: "deny", message: "No one can answer in this run.", interrupt: true }
                : { behavior: "deny", message: "No one can approve this in this run." },
            },
          });
          if (asks) {
            stopping = true;
            interrupt();
          }
        } else {
          send({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: message["request_id"],
              error: "Not supported",
            },
          });
        }
      }
      if (type === "result") {
        if (c.stopAfterResultMs !== undefined && !stopping) {
          stopping = true;
          setTimeout(() => {
            interrupt();
            end();
          }, c.stopAfterResultMs);
        } else if (stopping || background === 0) {
          end();
        }
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    write("stderr", { text: chunk.toString("utf8") });
  });
  send({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: c.request }] },
  });
  const guard = setTimeout(() => {
    write("mark", { what: "time limit" });
    end();
    setTimeout(() => child.kill(), 15_000).unref();
  }, 120_000);
  return new Promise((resolve) => {
    child.once("close", (code) => {
      clearTimeout(guard);
      write("exit", { code });
      closeSync(fd);
      console.log(`${name}: ${kinds.join(", ")}; exit ${String(code)}`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const [scratch, ...names] = process.argv.slice(2);
  if (scratch === undefined) throw new Error("usage: record.ts <scratch> [case ...]");
  const chosen = names.length === 0 ? Object.keys(CASES) : names;
  for (const name of chosen) {
    const c = CASES[name];
    if (c === undefined) throw new Error(`No case ${name}`);
    await record(scratch, name, c);
  }
}

if (process.argv[1]?.endsWith("record.ts") === true) await main();
