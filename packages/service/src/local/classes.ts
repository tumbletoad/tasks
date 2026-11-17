// Connection classes (A2 3.6.5) and which rpc methods each may call (A2 3.6.4). The service
// decides the class from the authenticated bind frame. The client never names a class or a
// principal. A3 maps classes to principals and actors.
//
// This is a guard for well-behaved agents, not a security boundary: same-user code can fake a
// TTY or drop the markers (A2 3.6.5, A6 3.15).
import { CLI_NAME } from "@tasks/brand";
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
 * - rpc mode from the CLI: `cli-agent` with any agent marker, else `cli-interactive` when any of
 *   its standard streams is a terminal, else `cli-script`.
 *
 * A person who pipes or redirects a command's output (`tasks space list | less`, `x=$(tasks …)`)
 * still has a terminal on its input or its errors. What has none at all is a script run by cron,
 * a command over ssh without a terminal, or an agent's shell, which also carries a marker.
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
  const { stdin, stdout, stderr } = client.tty;
  return stdin || stdout || stderr === true ? "cli-interactive" : "cli-script";
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
  // `tasks update`: hold new runs back while the update waits for the running ones, and stop them
  // when the person says so. Not an agent's: the update restarts the service.
  "runs/hold": OPERATOR,
  "runs/stop_held": OPERATOR,
  // `tasks run`: starting a run is the person's own, since a run may change whatever their agent
  // setup allows, without asking; reading runs and stopping one is any command of theirs.
  "runs/start": USER,
  "runs/list": OPERATOR,
  "runs/show": OPERATOR,
  "runs/stop": OPERATOR,
  "ui/mint_code": OPERATOR,
  // `tasks service port <n> [--reuse]` (A2 3.8.2 step 5): the person resolves a foreign holder.
  "service/port": USER,
  // `tasks space`: what only reads (the list, a space's backups) for every CLI, the rest for the
  // user only.
  "space/list": CLI,
  "space/create": USER,
  "space/open": USER,
  "space/close": USER,
  "space/forget": USER,
  "space/backup": USER,
  "space/backups": CLI,
  // `tasks space export` (A1 3.18, M3.07): a bundle of the space, for the user only.
  "space/export": USER,
  "space/restore": USER,
  // `tasks space rescue` (A1 3.2, M3.07): the readable rows of a space, for the user only.
  "space/rescue": USER,
  "space/claim": USER,
  "space/recover": USER,
  // `tasks space use` (A2 3.1, M5.01): the machine's default space, for the user only.
  "space/use": USER,
  // `tasks view rebuild` (A1 3.13, M3.10): a space's projection checked and rendered again.
  "view/rebuild": USER,
  // `tasks setup instances` (A4 3.2): writing and taking back [[instance]] entries, for the user.
  "instances/add": USER,
  "instances/remove": USER,
  // `tasks setup t3` (A4 3.4.1, M2.11): the status for every CLI, pairing for the user only.
  "t3/status": CLI,
  "t3/pair": USER,
  "t3/pair_wait": USER,
  // `tasks setup agents` (A3 3.13, M2.14): the rows for every CLI, granting and revoking for the user.
  "setup/homes": CLI,
  "setup/home_grant": USER,
  "setup/home_revoke": USER,
  // `tasks doctor --live` (A3 3.14, M4.05): which instances' tool calls this start saw.
  "setup/seen": CLI,
  // `tasks doctor` (A3 3.14, M4.05b): the launch rows' facts (with --live a login-shell snapshot
  // taken now, as a launch takes it) and the sessions row's counts.
  "doctor/launch": CLI,
  "doctor/sessions": CLI,
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

/**
 * Why a connection of class `cls` may not call `method`, in the words of the person who meets it:
 * a user-only method from a command without a terminal, or from an agent's shell, says how to
 * run it instead.
 */
export function refusalOf(
  cls: ConnectionClass,
  method: RpcMethod,
): { readonly message: string; readonly hint?: string } {
  const forUser = mayCall("cli-interactive", method);
  if (forUser && cls === "cli-script") {
    return {
      message:
        "Only the user can run this, from a terminal, and this command has none: its input, output and errors all go to files or pipes, as in a script or over ssh without -t.",
      hint: `Run the same ${CLI_NAME} command in a terminal window, or over ssh -t.`,
    };
  }
  if (forUser && cls === "cli-agent") {
    return {
      message: "Only the user can run this, and this command runs in an agent's shell.",
      hint: `Ask the user to run the same ${CLI_NAME} command in their own terminal.`,
    };
  }
  return { message: "This connection cannot call this method." };
}
