// The spike forwarder: a stand-in for the bridge `ttasks mcp` (A2 3.7), stdio to the socket or
// pipe, for rows B01-B06, A01-A07, S05 (P-4, P-5) and S08:
//   node forwarder.mjs --state <state> [--space <id>] [--instance <id>] [--app <name>] [--reconnect]
// Online it completes the handshake in mcp mode with the binding context, then pipes lines
// unchanged in both directions and tracks request IDs in flight. When the service cannot be
// reached it answers from the stub (A2 3.7.4). Like the product bridge it imports only Node
// built-ins through wire.ts and mcp-stub.ts.
//
// `--reconnect` (row S08, M0.07) adds A2 3.7.4 and 3.7.5 at spike level: while offline the
// forwarder retries the service after 0.5, 1, 2 and 5 s, then every 10 s, and when the service
// goes away it answers every request in flight with `connection_lost`, answers from the stub and
// starts retrying. It keeps the client's first `initialize` or `server/discover` request and sends
// it as `mcp_init` in the bind context of every reconnect, so the client never has to initialize
// again. An initialize that arrives while a reconnect's handshake runs is answered offline, and
// that binding is discarded and made again with it. Without the flag the forwarder never
// retries, as lab run B measured it.
// Not in the spike: resume handles and the offline cache file.
import {
  OFFLINE_TEXTS,
  STUB_INSTRUCTIONS,
  STUB_TOOLS,
  createMcpResponder,
  eraOf,
  textResult,
  toolResultFor,
  type Era,
} from "./mcp-stub.ts";
import {
  KitError,
  LineReader,
  SPACE_ID,
  clientInfo,
  connect,
  option,
  parseObject,
  type Connection,
  type Json,
  type JsonObject,
} from "./wire.ts";

/** The only environment variables a bridge sends (A2 3.6.4). */
const BINDING_ENV = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "T3CODE_THREAD_ID",
  "TTASKS_TICKET",
  "TTASKS_TASK",
  "TTASKS_SPACE",
];

/** A2 3.7.4: retry after 0.5, 1, 2 and 5 s, then every 10 s. */
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

const args = process.argv.slice(2);
const state = option(args, "--state");
if (state === undefined) {
  process.stderr.write("Usage: forwarder --state <state> [--space <id>] [--reconnect]\n");
  process.exit(64);
}
const reconnect = args.includes("--reconnect");

const stdin = new LineReader(process.stdin);
/** A function, so checks after an await read the reader's current state. */
const clientEnded = (): boolean => stdin.ended;
const out = (line: string) => process.stdout.write(`${line}\n`);

type Reason = keyof typeof OFFLINE_TEXTS;
type Mode =
  | { kind: "offline"; respond: (msg: JsonObject) => JsonObject | null }
  | { kind: "online"; socket: Connection["socket"]; inFlight: Map<string, { id: Json; era: Era }> };

let mode: Mode;
/** The client's first `initialize` or `server/discover` request, replayed as `mcp_init`. */
let init: JsonObject | undefined;
let attempt = 0;
let timer: NodeJS.Timeout | undefined;
const stop = new AbortController();

const context: JsonObject = {
  space: option(args, "--space") ?? SPACE_ID,
  cwd: process.cwd(),
  env: Object.fromEntries(
    BINDING_ENV.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
  parent: { pid: process.ppid },
};
const instance = option(args, "--instance");
const app = option(args, "--app");
if (instance !== undefined) context["instance"] = instance;
if (app !== undefined) context["app"] = app;

function offline(reason: Reason): void {
  const respond = createMcpResponder({
    name: "ttasks",
    instructions: STUB_INSTRUCTIONS,
    tools: STUB_TOOLS,
    call: () => textResult(OFFLINE_TEXTS[reason], true),
  });
  // The client initialized while online: rebuild the responder's state, no reply.
  if (init !== undefined) respond(init);
  mode = { kind: "offline", respond };
  if (reconnect && !stdin.ended && timer === undefined) schedule();
}

function schedule(): void {
  const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 10_000;
  attempt++;
  timer = setTimeout(() => {
    timer = undefined;
    void retry();
  }, delay);
}

async function retry(): Promise<void> {
  if (stdin.ended) return;
  try {
    const captured = init;
    const bindContext = captured === undefined ? context : { ...context, mcp_init: captured };
    const connection = await connect(
      state as string,
      { mode: "mcp", client: clientInfo("forwarder"), context: bindContext },
      { signal: stop.signal },
    );
    if (clientEnded()) {
      connection.socket.destroy();
      return;
    }
    if (init !== captured) {
      // The client initialized while the handshake ran and the offline responder answered it,
      // so this binding has no mcp_init. Discard it and bind again at once with the initialize.
      // `init` is set only once, so this happens at most once per client.
      connection.socket.destroy();
      void retry();
      return;
    }
    attempt = 0;
    online(connection);
  } catch (error) {
    if (clientEnded()) return;
    if (error instanceof KitError && error.code === "untrusted_endpoint") {
      offline("untrusted_endpoint");
    }
    if (timer === undefined) schedule();
  }
}

function online(connection: Connection): void {
  const { socket, reader } = connection;
  const inFlight = new Map<string, { id: Json; era: Era }>();
  mode = { kind: "online", socket, inFlight };
  reader.pipe(
    (line) => {
      const msg = parseObject(line);
      if (msg !== undefined && msg["method"] === undefined && msg["id"] !== undefined) {
        inFlight.delete(JSON.stringify(msg["id"]));
      }
      out(line);
    },
    () => {
      // A2 3.7.5: every request still in flight gets connection_lost. Then the stub answers,
      // and with --reconnect the forwarder retries in the background.
      for (const { id, era } of inFlight.values()) {
        out(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: toolResultFor(era, textResult(OFFLINE_TEXTS.connection_lost, true)),
          }),
        );
      }
      inFlight.clear();
      if (!stdin.ended) offline("service_unavailable");
    },
  );
}

function fromClient(line: string): void {
  const msg = parseObject(line);
  const method = msg?.["method"];
  if (
    msg !== undefined &&
    init === undefined &&
    msg["id"] !== undefined &&
    (method === "initialize" || method === "server/discover")
  ) {
    init = msg;
  }
  if (mode.kind === "online") {
    const id = msg?.["id"];
    if (msg !== undefined && typeof method === "string" && id !== undefined) {
      mode.inFlight.set(JSON.stringify(id), { id, era: eraOf(msg) });
    }
    mode.socket.write(`${line}\n`);
    return;
  }
  if (msg === undefined) return;
  const reply = mode.respond(msg);
  if (reply !== null) out(JSON.stringify(reply));
}

function clientGone(): void {
  clearTimeout(timer);
  timer = undefined;
  stop.abort();
  if (mode.kind === "online") mode.socket.end();
}

try {
  online(await connect(state, { mode: "mcp", client: clientInfo("forwarder"), context }));
} catch (error) {
  offline(
    error instanceof KitError && error.code === "untrusted_endpoint"
      ? "untrusted_endpoint"
      : "service_unavailable",
  );
}
stdin.pipe(fromClient, clientGone);
