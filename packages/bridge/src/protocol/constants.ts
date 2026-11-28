// The fixed values of `ttasks-local/1` (docs/protocol/ttasks-local-1.md). They are wire
// constants that a forwarder hard-codes too. Every bound the protocol applies is named here.

/** The protocol this build speaks. An integer that changes only for incompatible changes. */
export const PROTOCOL = 1;

/** The modes a hello may name. */
export const MODES = ["rpc", "mcp"] as const;
export type Mode = (typeof MODES)[number];

/** `client.kind` values of the bind frame. */
export const CLIENT_KINDS = ["cli", "bridge", "shim", "forwarder"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** `ipc.key` holds 32 random bytes as base64url. */
export const KEY_BYTES = 32;

/** `Ns` and `Nc`: 32 random bytes, base64url. */
export const NONCE_BYTES = 32;

/** The longest line either side accepts once the handshake is done. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * The most a service reads from a peer before the peer's proof verifies, and the longest
 * challenge or proof line a client reads before the service's proof verifies. A valid hello is
 * about 170 bytes.
 */
export const HELLO_MAX_BYTES = 1024;

/** The longest bind frame a service accepts. It carries the context, `mcp_init` included. */
export const BIND_MAX_BYTES = 1024 * 1024;

/**
 * rpc requests a connection may have in flight. The service refuses a request beyond
 * it at once and keeps reading, so `$/cancel` always arrives. The client sends no more than this
 * and queues the rest. A cancelled request counts until the service answers it.
 */
export const MAX_IN_FLIGHT = 64;

/** The deepest nesting accepted in a value that canonical JSON covers (bind frame and result). */
export const MAX_JSON_DEPTH = 64;

/** The most protocol versions a challenge may list. The service lists two at most. */
export const MAX_PROTOCOLS = 8;

/** The longest instance ID a challenge may carry. */
export const MAX_INSTANCE_LENGTH = 128;

/**
 * The longest Unix socket path, in bytes. `sun_path` holds 108 bytes on Linux and 104 on macOS,
 * and a longer path fails or is cut, so both sides refuse one before they try.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Default time from the connect call to the connection, client side. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** Default time to complete a handshake: client from connect to a verified bind result, service
 * from accept to a verified bind frame. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** A wrong proof or bind closes the connection after this fixed delay. */
export const REFUSAL_DELAY_MS = 200;

/**
 * The service's output deadline. While output waits for a peer, the socket must take some of it
 * within this time, or the peer is treated as not reading and the connection closes. The clock
 * runs only while output waits and starts again whenever the socket takes bytes, so a slow but
 * steady reader of a large burst is never closed by it.
 */
export const OUTPUT_STALL_MS = 30_000;

/** Handshake method names and rpc mode's cancellation. */
export const METHOD = {
  challenge: "ttasks/challenge",
  hello: "ttasks/hello",
  bind: "ttasks/bind",
  cancel: "$/cancel",
} as const;

/** The fixed JSON-RPC IDs of the hello and the bind. */
export const HELLO_ID = 0;
export const BIND_ID = 1;

/** JSON-RPC error codes the protocol uses. TTasks errors travel as `app` with the TTasks error body in `data`. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  app: -32000,
  cancelled: -32800,
} as const;

/** The error message of a line over the limit, sent once before the service closes. */
export const FRAME_TOO_LARGE = "frame_too_large";

/**
 * Environment names that make the service classify a CLI connection as `cli-agent`.
 * `CODEX_SANDBOX` is a prefix: every name that starts with it counts.
 */
export const AGENT_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "T3CODE_THREAD_ID",
  "TTASKS_TICKET",
  "TTASKS_TASK",
] as const;
export const AGENT_MARKER_PREFIX = "CODEX_SANDBOX";

/** Whether an environment name is an agent marker. */
export function isAgentMarker(name: string): boolean {
  return (
    (AGENT_MARKERS as readonly string[]).includes(name) || name.startsWith(AGENT_MARKER_PREFIX)
  );
}

/** The environment names an rpc client copies into its bind context: the markers and the space. */
export function isContextEnvName(name: string): boolean {
  return isAgentMarker(name) || name === "TTASKS_SPACE";
}

/**
 * The environment names a bridge copies into an mcp mode bind context, and no others:
 * the native session IDs, the launch ticket and the launch's two hints.
 */
export const MCP_CONTEXT_ENV = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "T3CODE_THREAD_ID",
  "TTASKS_TICKET",
  "TTASKS_TASK",
  "TTASKS_SPACE",
] as const;
