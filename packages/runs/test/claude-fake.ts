// A fake Claude Code in print mode that speaks exactly a recorded exchange (fixtures/claude-stream):
// it waits for each line the recording's client sent, answers with the recorded program lines in
// their order, and waits for the client's answer to each recorded permission prompt. What the
// client says is matched by its type, and its request IDs replace the recorded ones; everything it
// sent is kept for the test. A test can change a recording in a few named ways (FakeClaudeScenario).
//
// In a test it serves a pair of streams (`serveClaude`), or runs as a program on its stdio:
//
//   node claude-fake.ts [claude's arguments]     the scenario as JSON in FAKE_CLAUDE_SCENARIO
//
// As a program it listens on the named pipe `ttasks-test-standin-<token>-<pid>` on Windows and
// carries `--token=<token>` in its arguments elsewhere, so the stand-in census counts it.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { callTools, type ToolCall } from "./codex-server.ts";

type Json = Record<string, unknown>;

export const CLAUDE_FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "claude-stream",
);

/** How a test changes the recording it replays. */
export interface FakeClaudeScenario {
  /** The recording, such as `windows-plain`. */
  readonly fixture: string;
  /** The text of every successful result and of every assistant text, in place of the recording's. */
  readonly answer?: string;
  /** Bytes of other output (a command's output) sent before and after the last result. */
  readonly floodBytes?: number;
  /**
   * Control requests the program sends at the start of its last turn, each answered before it goes
   * on. Once its input ended, a request fails in the program and its turn goes on without it.
   */
  readonly requests?: readonly Json[];
  /** The program writes nothing at all (`init`), or stops before its result; it keeps reading. */
  readonly stallAt?: "init" | "result";
  /** The recorded gaps between program lines, times this. Default 0: no gaps. */
  readonly pace?: number;
  /** The program goes on after its input ended, as a program that hangs would. */
  readonly ignoreEnd?: boolean;
  /** Program mode: where each line the client sent is appended. */
  readonly log?: string;
  /** Program mode: the stand-in census token. */
  readonly token?: string;
  /** Program mode: the first command leaves an idle stand-in behind, with the token. */
  readonly leave?: "detached" | "in-group";
  /**
   * Program mode: at the recorded call of TTasks's tools, these tools of the server the
   * `--mcp-config` file names under `ttasks` are called for real, in order, on one connection, with
   * `home` as the install's home. Each answer goes to the log as `{"tool": …, "tool_result": …}`.
   */
  readonly callTool?: { readonly calls: readonly ToolCall[]; readonly home: string };
}

interface Line {
  readonly dir: string;
  readonly ms: number;
  readonly msg: Json;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readClaudeFixture(name: string): Line[] {
  return readFileSync(join(CLAUDE_FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

/** A running fake: what the client sent, whether the replay ended, and the program's exit code. */
export interface FakeClaude {
  readonly received: Json[];
  /** Every recorded line was sent, or the replay stopped early. */
  readonly replayed: Promise<void>;
  /** Resolves once the client's input to the program ended. */
  readonly inputEnded: Promise<void>;
  readonly done: Promise<number>;
}

const isInterrupt = (message: Json): boolean =>
  message["type"] === "control_request" &&
  isObject(message["request"]) &&
  message["request"]["subtype"] === "interrupt";

/** Tool calls of TTasks's tools in an assistant line. */
const callsTasks = (message: Json): boolean => {
  const content = isObject(message["message"]) ? message["message"]["content"] : undefined;
  return (
    Array.isArray(content) &&
    content.some(
      (b) =>
        isObject(b) &&
        b["type"] === "tool_use" &&
        typeof b["name"] === "string" &&
        b["name"].startsWith("mcp__ttasks__"),
    )
  );
};

const callsCommand = (message: Json): boolean => {
  const content = isObject(message["message"]) ? message["message"]["content"] : undefined;
  return (
    Array.isArray(content) &&
    content.some(
      (b) =>
        isObject(b) &&
        b["type"] === "tool_use" &&
        ["Bash", "PowerShell"].includes(String(b["name"])),
    )
  );
};

/** Serves `scenario` on a pair of streams: the client's output in, its input out. */
export function serveClaude(
  input: Readable,
  output: Writable,
  scenario: FakeClaudeScenario,
  tasksServer?: Json,
): FakeClaude {
  const lines = readClaudeFixture(scenario.fixture);
  const received: Json[] = [];
  const inbox: Json[] = [];
  const ids = new Map<unknown, unknown>();
  /** The interrupts the recording's client sent and the replay still waits for. */
  let interrupts = lines.filter((l) => l.dir === "send" && isInterrupt(l.msg)).length;
  let wake: (() => void) | undefined;
  let ended = false;
  let markEnded: () => void = () => undefined;
  const inputEnded = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const reader = createInterface({ input, crlfDelay: Infinity });
  reader.on("line", (text) => {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    received.push(message);
    if (scenario.log !== undefined) appendFileSync(scenario.log, `${text}\n`);
    // An interrupt the recording has no place for is heard at once, as the program hears it.
    if (isInterrupt(message) && interrupts === 0) {
      unexpected(message);
      return;
    }
    inbox.push(message);
    wake?.();
  });
  reader.on("close", () => {
    ended = true;
    markEnded();
    wake?.();
  });
  output.on("error", () => undefined);

  const send = (message: Json): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  let session: unknown = "00000000-0000-4000-8000-000000000001";
  let resulted = false;
  /** A turn goes on: from the request, or the program's own `init`, to its result. */
  let inTurn = true;
  /** An interrupt the recording did not have ended the turn: the rest of it is not sent. */
  let turnOver = false;
  /** The program says nothing more, and keeps reading. */
  let stalled = scenario.stallAt === "init";
  const isOver = (): boolean => stalled || turnOver;

  const next = async (): Promise<Json | undefined> => {
    for (;;) {
      const message = inbox.shift();
      if (message !== undefined) return message;
      if (ended) return undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  };

  /** A client line the recording did not expect here: answered as the program would. */
  const unexpected = (message: Json): void => {
    if (stalled || message["type"] !== "control_request") return;
    const request = isObject(message["request"]) ? message["request"] : {};
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message["request_id"],
        response: request["subtype"] === "interrupt" ? { still_queued: [] } : {},
      },
    });
    if (request["subtype"] === "interrupt" && !turnOver && inTurn) {
      turnOver = true;
      resulted = true;
      inTurn = false;
      send({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        result: "",
        permission_denials: [],
        session_id: session,
      });
    }
  };

  /** Waits for the client line `expected` stands for; false once nothing more will come. */
  const await_ = async (expected: Json): Promise<boolean> => {
    for (;;) {
      const message = await next();
      if (message === undefined) return false;
      if (message["type"] === expected["type"]) {
        if (expected["type"] !== "control_request") return true;
        const want = isObject(expected["request"]) ? expected["request"]["subtype"] : undefined;
        const got = isObject(message["request"]) ? message["request"]["subtype"] : undefined;
        if (want === got) {
          ids.set(expected["request_id"], message["request_id"]);
          if (isInterrupt(message)) interrupts -= 1;
          return true;
        }
      }
      unexpected(message);
    }
  };

  /** A program line as the replay sends it: the client's IDs, the scenario's answer. */
  const rewrite = (message: Json): Json => {
    if (message["type"] === "control_response" && isObject(message["response"])) {
      const response = message["response"];
      const id = ids.get(response["request_id"]) ?? response["request_id"];
      return { ...message, response: { ...response, request_id: id } };
    }
    if (scenario.answer === undefined) return message;
    if (message["type"] === "result" && message["is_error"] === false) {
      return { ...message, result: scenario.answer };
    }
    if (message["type"] === "assistant" && isObject(message["message"])) {
      const inner = message["message"];
      const content = Array.isArray(inner["content"])
        ? (inner["content"] as unknown[]).map((b) =>
            isObject(b) && b["type"] === "text" ? { ...b, text: scenario.answer } : b,
          )
        : inner["content"];
      return { ...message, message: { ...inner, content } };
    }
    return message;
  };

  const flood = (): void => {
    let left = scenario.floodBytes ?? 0;
    const chunk = "x".repeat(64 * 1024);
    while (left > 0) {
      send({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_flood", content: chunk }],
        },
        session_id: session,
      });
      left -= chunk.length;
    }
  };

  const ask = async (): Promise<void> => {
    for (const [n, request] of (scenario.requests ?? []).entries()) {
      if (ended) return;
      const id = `fake-request-${String(n)}`;
      send({ type: "control_request", request_id: id, request });
      for (;;) {
        const answer = await next();
        if (answer === undefined) return;
        if (
          answer["type"] === "control_response" &&
          isObject(answer["response"]) &&
          answer["response"]["request_id"] === id
        ) {
          break;
        }
        unexpected(answer);
      }
    }
  };

  const lastResult = lines.findLastIndex((l) => l.dir === "recv" && l.msg["type"] === "result");
  const lastInit = lines.findLastIndex(
    (l) => l.dir === "recv" && l.msg["type"] === "system" && l.msg["subtype"] === "init",
  );

  const replay = async (): Promise<number> => {
    let last = 0;
    let left = false;
    let called = false;
    for (const [index, line] of lines.entries()) {
      if (line.dir === "exit") {
        return typeof line.msg["code"] === "number" ? line.msg["code"] : 0;
      }
      if (line.dir === "mark") {
        if (line.msg["what"] === "stdin end") {
          // The recorded client ended the input here: the program waits for this one to.
          for (;;) {
            const message = await next();
            if (message === undefined) break;
            unexpected(message);
          }
        }
        continue;
      }
      if (line.dir === "send") {
        if (stalled || turnOver) continue;
        if (!(await await_(line.msg))) return resulted ? 0 : 1;
        continue;
      }
      if (line.dir !== "recv" || stalled || turnOver) continue;
      const type = line.msg["type"];
      const subtype = line.msg["subtype"];
      if (scenario.stallAt === "result" && type === "result") {
        stalled = true;
        continue;
      }
      const pace = scenario.pace ?? 0;
      if (pace > 0 && line.ms > last) {
        await new Promise((resolve) => setTimeout(resolve, (line.ms - last) * pace));
      }
      last = line.ms;
      // The client may have interrupted the replay while it waited.
      if (isOver()) continue;
      if (index === lastResult) flood();
      const message = rewrite(line.msg);
      if (type === "system" && subtype === "init") session = message["session_id"];
      if (
        !left &&
        scenario.leave !== undefined &&
        scenario.token !== undefined &&
        type === "assistant" &&
        callsCommand(message)
      ) {
        left = true;
        leave(scenario.token, scenario.leave);
      }
      if (
        !called &&
        scenario.callTool !== undefined &&
        tasksServer !== undefined &&
        type === "assistant" &&
        callsTasks(message)
      ) {
        called = true;
        const results = await callTools(tasksServer, scenario.callTool);
        for (const [n, result] of results.entries()) {
          const tool = scenario.callTool.calls[n]?.name;
          if (scenario.log !== undefined) {
            appendFileSync(scenario.log, `${JSON.stringify({ tool, tool_result: result })}\n`);
          }
        }
      }
      send(message);
      if (type === "result") {
        resulted = true;
        inTurn = false;
      }
      if (type === "system" && subtype === "init") inTurn = true;
      if (index === lastResult) flood();
      if (index === lastInit) await ask();
    }
    return 0;
  };

  const replaying = replay();
  const done = (async () => {
    const code = await replaying;
    // Whatever else the client says is answered as it comes, until its input ends.
    for (;;) {
      const message = await next();
      if (message === undefined) break;
      unexpected(message);
    }
    if (scenario.ignoreEnd === true) await new Promise<never>(() => undefined);
    return code;
  })();
  return { received, replayed: replaying.then(() => undefined), inputEnded, done };
}

/** An idle stand-in, as a command that starts a process and returns would leave. */
function leave(token: string, how: "detached" | "in-group"): void {
  const standIn = join(import.meta.dirname, "stand-ins", "stand-in.ts");
  spawn(process.execPath, [standIn, "idle", `--token=${token}`], {
    // eslint-disable-next-line no-restricted-syntax -- the idle stand-in only waits.
    detached: how === "detached",
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

/** TTasks's server as the `--mcp-config` file among `args` names it. */
function tasksServerOf(args: readonly string[]): Json | undefined {
  const at = args.indexOf("--mcp-config");
  const file = at === -1 ? undefined : args[at + 1];
  if (file === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const servers = isObject(parsed) ? parsed["mcpServers"] : undefined;
    const tasks = isObject(servers) ? servers["ttasks"] : undefined;
    return isObject(tasks) ? tasks : undefined;
  } catch {
    return undefined;
  }
}

/** Program mode. */
async function main(): Promise<void> {
  const scenario = JSON.parse(process.env["FAKE_CLAUDE_SCENARIO"] ?? "{}") as FakeClaudeScenario;
  if (scenario.token !== undefined && process.platform === "win32") {
    createServer()
      .listen(`\\\\.\\pipe\\ttasks-test-standin-${scenario.token}-${String(process.pid)}`)
      .unref()
      .on("error", () => undefined);
  }
  // What Run asks before it starts the app: its version, and signed in as the recordings were made,
  // or not with FAKE_CLAUDE_SIGNED_OUT=1.
  const asked = process.argv.slice(2).join(" ");
  if (asked === "--version") {
    process.stdout.write("2.1.332 (Claude Code)\n");
    process.exit(0);
  }
  if (asked === "auth status") process.exit(process.env["FAKE_CLAUDE_SIGNED_OUT"] === "1" ? 1 : 0);
  // Never outlives a minute, so a broken process group cannot leave it running for long.
  setTimeout(() => process.exit(124), 60_000).unref();
  // A program that ignores the end of its input needs something to keep it alive.
  if (scenario.ignoreEnd === true) setInterval(() => undefined, 1 << 30);
  const args = process.argv.slice(2);
  if (scenario.log !== undefined) {
    appendFileSync(scenario.log, `${JSON.stringify({ argv: args, cwd: process.cwd() })}\n`);
  }
  const fake = serveClaude(process.stdin, process.stdout, scenario, tasksServerOf(args));
  const code = await fake.done;
  process.exit(code);
}

if (process.argv[1]?.endsWith("claude-fake.ts") === true) await main();
