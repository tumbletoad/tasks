// A fake `codex app-server` that speaks exactly a recorded exchange (fixtures/codex-app-server):
// it waits for each message the recording's client sent, answers with the recorded server lines
// in their order, and sends the recorded server requests, waiting for the client's answers. What
// the client says is matched by method, and its request IDs replace the recorded ones; everything
// it sent is kept for the test. A test can change a recording in a few named ways (FakeScenario).
//
// In a test it serves a pair of streams (`serveCodex`), or runs as a program on its stdio:
//
//   node codex-server.ts            the scenario as JSON in FAKE_CODEX_SCENARIO
//
// As a program it listens on the named pipe `ttasks-test-standin-<token>-<pid>` on Windows and
// carries `--token=<token>` in its arguments elsewhere, so the stand-in census counts it.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "codex-app-server");

/** How a test changes the recording it replays. */
export interface FakeScenario {
  /** The recording, such as `windows-plain`. */
  readonly fixture: string;
  /** The final answer's text in place of the recording's. */
  readonly answer?: string;
  /** Bytes of other output (a command's output) sent before the final answer. */
  readonly floodBytes?: number;
  /** Server requests sent once the turn started, each answered before the replay goes on. */
  readonly requests?: readonly { readonly method: string; readonly params: Json }[];
  /**
   * Notifications sent once the turn started, after the requests: of the recorded thread and turn
   * unless their params name others, as an agent the run's agent started would.
   */
  readonly notifications?: readonly { readonly method: string; readonly params: Json }[];
  /** At this client method the server stops answering anything, and keeps reading. */
  readonly stallAt?: string;
  /** The recorded gaps between server lines, times this. Default 0: no gaps. */
  readonly pace?: number;
  /** The server goes on after its stdin ended, as a server that hangs would. */
  readonly ignoreEnd?: boolean;
  /** The folder `thread/start` says the thread works in, in place of the recording's; null: none. */
  readonly cwd?: string | null;
  /** Program mode: where each message the client sent is appended, as a JSON line. */
  readonly log?: string;
  /** Program mode: the stand-in census token. */
  readonly token?: string;
  /** Program mode: the turn does not complete while this file exists. */
  readonly holdWhile?: string;
  /**
   * Program mode: the first command leaves an idle stand-in behind, with the token: detached, or
   * in the agent's own process group, as a command started in the background with `&` would.
   */
  readonly leave?: "detached" | "in-group";
  /**
   * At the recorded tool call, these tools of the server the thread's configuration names under
   * `ttasks` are called for real, in order, on one connection: its command, arguments and
   * environment, with `home` as the install's home. Each answer goes to the log as
   * `{"tool": …, "tool_result": …}`.
   */
  readonly callTool?: { readonly calls: readonly ToolCall[]; readonly home: string };
}

/** Resolves once `file` no longer exists, looking every 50 ms. */
export async function heldWhile(file: string | undefined): Promise<void> {
  if (file === undefined) return;
  while (existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 50));
}

/** One call of a tool, as an agent makes it. */
export interface ToolCall {
  readonly name: string;
  readonly arguments: Json;
}

interface Line {
  readonly dir: string;
  readonly ms: number;
  readonly msg: Json;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutCwd = (value: Json): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cwd"));

export function readFixture(name: string): Line[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

/** A running fake: what the client sent, whether it sent all of the recording, and its end. */
export interface FakeCodex {
  readonly received: Json[];
  /** Every recorded line was sent, or the replay stopped early. */
  readonly replayed: Promise<void>;
  readonly done: Promise<number>;
}

/** Serves `scenario` on a pair of streams: the client's output in, its input out. */
export function serveCodex(input: Readable, output: Writable, scenario: FakeScenario): FakeCodex {
  const lines = readFixture(scenario.fixture);
  const received: Json[] = [];
  const inbox: Json[] = [];
  let wake: (() => void) | undefined;
  let inputEnded = false;
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
    inbox.push(message);
    wake?.();
  });
  reader.on("close", () => {
    inputEnded = true;
    wake?.();
  });
  output.on("error", () => undefined);

  const send = (message: Json): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const ids = new Map<unknown, unknown>();
  /** TTasks's own server as the client's thread/start named it. */
  let tasksServer: Json | undefined;
  const finalItems = new Set<unknown>();
  let thread: unknown;
  let turn: unknown;
  /** An interrupt the recording did not have ended the turn: the rest of it is not sent. */
  let turnOver = false;
  /** The current turn completed, so an interrupt has nothing to end. */
  let completed = false;
  let stalled = false;
  const isOver = (): boolean => stalled || turnOver;

  /** The next message of the client, or undefined once its output ended. */
  const next = async (): Promise<Json | undefined> => {
    for (;;) {
      const message = inbox.shift();
      if (message !== undefined) return message;
      if (inputEnded) return undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  };

  /** A client message the recording did not expect here: answered as the app server would. */
  const unexpected = (message: Json): void => {
    if (stalled || typeof message["method"] !== "string" || !("id" in message)) return;
    if (message["method"] === "turn/interrupt") {
      send({ id: message["id"], result: {} });
      if (!turnOver && !completed) {
        turnOver = true;
        completed = true;
        send({
          method: "turn/completed",
          params: {
            threadId: thread,
            turn: { id: turn, items: [], status: "interrupted", error: null },
          },
        });
      }
      return;
    }
    send({
      id: message["id"],
      error: { code: -32601, message: `Method not found: ${message["method"]}` },
    });
  };

  /** Waits for the client message `expected` stands for; false once nothing more will come. */
  const await_ = async (expected: Json): Promise<boolean> => {
    const method = expected["method"];
    const isRequest = typeof method === "string" && "id" in expected;
    const isNotification = typeof method === "string" && !("id" in expected);
    for (;;) {
      const message = await next();
      if (message === undefined) return false;
      if (isRequest && message["method"] === method && "id" in message) {
        ids.set(expected["id"], message["id"]);
        if (method === "thread/start") {
          const config = isObject(message["params"]) ? message["params"]["config"] : undefined;
          const entry = isObject(config) ? config["mcp_servers.ttasks"] : undefined;
          tasksServer = isObject(entry) ? entry : undefined;
        }
        if (method === scenario.stallAt) stalled = true;
        return true;
      }
      if (isNotification) {
        // A notification the client did not send is not waited for: its message comes next.
        if (message["method"] !== method) inbox.unshift(message);
        return true;
      }
      if (!isRequest && message["id"] === expected["id"]) return true;
      unexpected(message);
    }
  };

  /** A server line as the replay sends it: the client's IDs, the scenario's answer. */
  const rewrite = (message: Json): Json => {
    if (!("method" in message) && "id" in message && ids.has(message["id"])) {
      const result = isObject(message["result"]) ? message["result"] : undefined;
      const started = isObject(result?.["thread"]) ? result["thread"] : undefined;
      if (scenario.cwd !== undefined && typeof result?.["cwd"] === "string") {
        const cwd = scenario.cwd === null ? {} : { cwd: scenario.cwd };
        const rest = withoutCwd(result);
        const thread = started === undefined ? undefined : withoutCwd(started);
        return {
          ...message,
          id: ids.get(message["id"]),
          result: {
            ...rest,
            ...cwd,
            ...(thread === undefined ? {} : { thread: { ...thread, ...cwd } }),
          },
        };
      }
      return { ...message, id: ids.get(message["id"]) };
    }
    const params = isObject(message["params"]) ? message["params"] : undefined;
    if (params === undefined || scenario.answer === undefined) return message;
    const item = isObject(params["item"]) ? params["item"] : undefined;
    if (item?.["type"] === "agentMessage" && item["phase"] === "final_answer") {
      finalItems.add(item["id"]);
      if (message["method"] === "item/completed") {
        return { ...message, params: { ...params, item: { ...item, text: scenario.answer } } };
      }
    }
    if (message["method"] === "item/agentMessage/delta" && finalItems.has(params["itemId"])) {
      return { ...message, params: { ...params, delta: scenario.answer } };
    }
    const turnOf = isObject(params["turn"]) ? params["turn"] : undefined;
    if (message["method"] === "turn/completed" && Array.isArray(turnOf?.["items"])) {
      const items = (turnOf["items"] as unknown[]).map((i) =>
        isObject(i) && i["type"] === "agentMessage" && i["phase"] === "final_answer"
          ? { ...i, text: scenario.answer }
          : i,
      );
      return { ...message, params: { ...params, turn: { ...turnOf, items } } };
    }
    return message;
  };

  const flood = (): void => {
    let left = scenario.floodBytes ?? 0;
    const chunk = "x".repeat(64 * 1024);
    while (left > 0) {
      send({
        method: "item/commandExecution/outputDelta",
        params: { threadId: thread, turnId: turn, itemId: "exec-flood", delta: chunk },
      });
      left -= chunk.length;
    }
  };

  const replay = async (): Promise<number> => {
    let last = 0;
    let flooded = false;
    let asked = false;
    for (const line of lines) {
      if (line.dir === "exit") {
        return typeof line.msg["code"] === "number" ? line.msg["code"] : 0;
      }
      if (line.dir === "send") {
        if (stalled || turnOver) continue;
        if (!(await await_(line.msg))) return 0;
        continue;
      }
      if (line.dir !== "recv" || stalled || turnOver) continue;
      const pace = scenario.pace ?? 0;
      if (pace > 0 && line.ms > last) {
        await new Promise((resolve) => setTimeout(resolve, (line.ms - last) * pace));
      }
      last = line.ms;
      // The client may have stalled or interrupted the replay while it waited.
      if (isOver()) continue;
      const message = rewrite(line.msg);
      const params = isObject(message["params"]) ? message["params"] : {};
      if (message["method"] === "thread/started" && isObject(params["thread"])) {
        thread = params["thread"]["id"];
      }
      const item = isObject(params["item"]) ? params["item"] : undefined;
      if (
        !flooded &&
        message["method"] === "item/started" &&
        item?.["type"] === "agentMessage" &&
        item["phase"] === "final_answer"
      ) {
        flooded = true;
        flood();
      }
      if (
        scenario.leave !== undefined &&
        scenario.token !== undefined &&
        message["method"] === "item/started" &&
        item?.["type"] === "commandExecution"
      ) {
        leave(scenario.token, scenario.leave);
      }
      if (
        scenario.callTool !== undefined &&
        tasksServer !== undefined &&
        message["method"] === "item/started" &&
        item?.["type"] === "mcpToolCall"
      ) {
        const results = await callTools(tasksServer, scenario.callTool);
        for (const [n, result] of results.entries()) {
          const tool = scenario.callTool.calls[n]?.name;
          if (scenario.log !== undefined) {
            appendFileSync(scenario.log, `${JSON.stringify({ tool, tool_result: result })}\n`);
          }
        }
      }
      if (message["method"] === "turn/completed") await heldWhile(scenario.holdWhile);
      send(message);
      if (message["method"] === "turn/started" && isObject(params["turn"])) {
        turn = params["turn"]["id"];
        if (!asked) {
          asked = true;
          for (const [n, request] of (scenario.requests ?? []).entries()) {
            const id = 100 + n;
            send({
              id,
              method: request.method,
              params: { threadId: thread, turnId: turn, ...request.params },
            });
            for (;;) {
              const answer = await next();
              if (answer === undefined) return 0;
              if (answer["id"] === id && !("method" in answer)) break;
              unexpected(answer);
            }
          }
          for (const notification of scenario.notifications ?? []) {
            send({
              method: notification.method,
              params: { threadId: thread, turnId: turn, ...notification.params },
            });
          }
        }
      }
      if (message["method"] === "turn/started") completed = false;
      if (message["method"] === "turn/completed") completed = true;
    }
    return 0;
  };

  const replaying = replay();
  const done = (async () => {
    const code = await replaying;
    // Whatever else the client says is answered as it comes, until its output ends.
    for (;;) {
      const message = await next();
      if (message === undefined) break;
      unexpected(message);
    }
    if (scenario.ignoreEnd === true) {
      // Something must keep a program alive once its input is gone.
      setInterval(() => undefined, 1 << 30);
      await new Promise<never>(() => undefined);
    }
    return code;
  })();
  return { received, replayed: replaying.then(() => undefined), done };
}

/**
 * Calls tools of an MCP server over its stdio, in order on one connection, as an agent would:
 * each one's answer, or its error. `server` is an entry of a thread's `mcp_servers`.
 */
export async function callTools(
  server: Json,
  call: NonNullable<FakeScenario["callTool"]>,
): Promise<unknown[]> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const own = isObject(server["env"]) ? server["env"] : {};
  for (const [key, value] of Object.entries(own)) if (typeof value === "string") env[key] = value;
  env["TTASKS_HOME"] = call.home;
  const args = Array.isArray(server["args"]) ? server["args"].map(String) : [];
  const child = spawn(String(server["command"]), args, { env, stdio: ["pipe", "pipe", "ignore"] });
  const answers = new Map<number, (value: Json) => void>();
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try {
      const message = JSON.parse(line) as Json;
      if (typeof message["id"] === "number") answers.get(message["id"])?.(message);
    } catch {
      // Not a message.
    }
  });
  const ask = (id: number, method: string, params: Json): Promise<Json> =>
    new Promise((resolve) => {
      answers.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await ask(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-fake", version: "0.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const results: unknown[] = [];
    for (const [n, tool] of call.calls.entries()) {
      const answer = await ask(2 + n, "tools/call", { name: tool.name, arguments: tool.arguments });
      results.push(answer["result"] ?? answer["error"]);
    }
    return results;
  } finally {
    child.stdin.end();
  }
}

/** An idle stand-in, as a command that starts a process and returns would leave. */
function leave(token: string, how: "detached" | "in-group"): void {
  const standIn = join(import.meta.dirname, "stand-ins", "stand-in.ts");
  spawn(process.execPath, [standIn, "idle", `--token=${token}`], {
    // eslint-disable-next-line no-restricted-syntax -- an idle stand-in, which starts nothing.
    detached: how === "detached",
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

/** Program mode. */
async function main(): Promise<void> {
  const scenario = JSON.parse(process.env["FAKE_CODEX_SCENARIO"] ?? "{}") as FakeScenario;
  if (scenario.token !== undefined && process.platform === "win32") {
    createServer()
      .listen(`\\\\.\\pipe\\ttasks-test-standin-${scenario.token}-${String(process.pid)}`)
      .unref()
      .on("error", () => undefined);
  }
  // Never outlives a minute, so a broken process group cannot leave it running for long.
  setTimeout(() => process.exit(124), 60_000).unref();
  // As the real server, the thread works in the folder the program was started in.
  const fake = serveCodex(process.stdin, process.stdout, {
    ...scenario,
    cwd: scenario.cwd ?? process.cwd(),
  });
  const code = await fake.done;
  process.exit(code);
}

if (process.argv[1]?.endsWith("codex-server.ts") === true) await main();
