// Connection classes (A2 3.6.5) and which rpc methods each may call (A2 3.6.4). The service
// decides the class from the authenticated bind frame. The client never names a class or a
// principal. A3 maps classes to principals and actors.
//
// This is a guard for well-behaved agents, not a security boundary: same-user code can fake a
// TTY or drop the markers (A2 3.6.5, A6 3.15).
import { isAgentMarker, isObject, type ClientInfo, type Mode } from "@tasks/bridge/protocol";

/** A2 3.6.5's classes. `ui` comes from the HTTP transport, never from the socket or pipe. */
export const CONNECTION_CLASSES = [
  "ui",
  "cli-interactive",
  "cli-script",
  "cli-agent",
  "bridge",
  "shim",
] as const;
export type ConnectionClass = (typeof CONNECTION_CLASSES)[number];

/** Whether the bind context carries an agent marker in `context.env` (A3 3.7.2 keeps the list). */
export function hasAgentMarker(context: unknown): boolean {
  if (!isObject(context)) return false;
  const env = context["env"];
  return isObject(env) && Object.keys(env).some(isAgentMarker);
}

/**
 * The class of a local connection, or undefined when the mode and client kind do not fit
 * together, which the service refuses at bind:
 * - mcp mode from a bridge or a native forwarder: `bridge`;
 * - rpc mode from a shim: `shim`;
 * - rpc mode from the CLI: `cli-agent` with any agent marker, else `cli-interactive` when stdin
 *   and stdout are both TTYs, else `cli-script`.
 */
export function classify(
  mode: Mode,
  client: ClientInfo,
  context: unknown,
): ConnectionClass | undefined {
  if (mode === "mcp") {
    return client.kind === "bridge" || client.kind === "forwarder" ? "bridge" : undefined;
  }
  if (client.kind === "shim") return "shim";
  if (client.kind !== "cli") return undefined;
  if (hasAgentMarker(context)) return "cli-agent";
  return client.tty.stdin && client.tty.stdout ? "cli-interactive" : "cli-script";
}

const CLI: readonly ConnectionClass[] = ["cli-interactive", "cli-script", "cli-agent"];
const OPERATOR: readonly ConnectionClass[] = ["cli-interactive", "cli-script"];
/** A person at a terminal: the user-only operations of A2 3.6.5 (the UI reaches them over HTTP). */
const USER: readonly ConnectionClass[] = ["cli-interactive"];
const SHIM: readonly ConnectionClass[] = ["shim"];

/**
 * rpc mode's methods (A2 3.6.4) and the classes that may call each. A shim may call only A4's
 * methods, and each of those checks its own credential in its handler (A4 3.6.3, 3.17).
 */
export const RPC_METHODS = {
  "op/call": CLI,
  "op/list": CLI,
  "feed/subscribe": CLI,
  "service/status": CLI,
  "service/shutdown": OPERATOR,
  "ui/mint_code": OPERATOR,
  // `tasks service port <n> [--reuse]` (A2 3.8.2 step 5): the person resolves a foreign holder.
  "service/port": USER,
  // `tasks space` (A2 3.10.1, M1.10): the list for every CLI, the rest for the user only.
  "space/list": CLI,
  "space/create": USER,
  "space/open": USER,
  "space/close": USER,
  "space/backup": USER,
  "space/backups": USER,
  // `tasks space export` (A1 3.18, M3.07): a bundle of the space, for the user only.
  "space/export": USER,
  "space/restore": USER,
  "space/claim": USER,
  "space/recover": USER,
  // `tasks space use` (A2 3.1, M5.01): the machine's default space, for the user only.
  "space/use": USER,
  // `tasks roots` (A1 3.15, M2.07): the list for every CLI, adding a root for the user only.
  "roots/list": CLI,
  "roots/add": USER,
  // `tasks setup t3` (A4 3.4.1, M2.11): the status for every CLI, pairing for the user only.
  "t3/status": CLI,
  "t3/pair": USER,
  "t3/pair_wait": USER,
  // `tasks setup agents` (A3 3.13, M2.14): the rows for every CLI, granting and revoking for the user.
  "setup/homes": CLI,
  "setup/home_grant": USER,
  "setup/home_revoke": USER,
  "launch.claim": SHIM,
  "launch.attach": SHIM,
  "launch.started": SHIM,
  "launch.settled": SHIM,
  "launch.exited": SHIM,
  "launch.failed": SHIM,
  "run.attach": SHIM,
  "run.event": SHIM,
  "run.exited": SHIM,
} as const satisfies Record<string, readonly ConnectionClass[]>;

export type RpcMethod = keyof typeof RPC_METHODS;

export function isRpcMethod(name: string): name is RpcMethod {
  return Object.hasOwn(RPC_METHODS, name);
}

/** Whether a connection of class `cls` may call `method`. */
export function mayCall(cls: ConnectionClass, method: RpcMethod): boolean {
  return RPC_METHODS[method].includes(cls);
}
