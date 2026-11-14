// The MCP endpoint (A3 3.3): one SDK server per mcp mode connection, from one factory, the era
// picked by the connection's opening exchange (the SDK's stdio entry over our transport). A tool
// call goes to the request path (`opCall`) with the connection's principal and space, and its
// result or error comes back as one compact text within its budget (render.ts).
//
// Task content never leaves through a side door: a tool's arguments and results reach only the
// request path and the tool's own result. Events carry a connection number, a tool name from the
// generated list and fixed words.
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { McpChannel } from "../local/index.ts";
import type { Bindings } from "../binding/index.ts";
import { opCall, type OpsHost, type Slot } from "../ops/index.ts";
import { bridgePrincipal, clientOf, instanceOf, spaceOf } from "./principal.ts";
import { renderError, renderResult } from "./render.ts";
import { createServer, type ToolCall, type ToolResult } from "./server.ts";
import { toolEntry, TOOLS } from "./tools.ts";
import { ChannelTransport, type TransportLimits, type TransportReason } from "./transport.ts";

/** The tool names an event may name: the generated list's. */
export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/** Why the endpoint ended a connection itself. */
export const CLOSE_REASONS = ["slow_reader", "held_too_much"] as const;
/** Why it answered a request itself, or dropped a line. */
export const REFUSE_REASONS = [
  "in_flight",
  "duplicate_id",
  "unsupported_version",
  "missing_version",
  "not_a_message",
  "init_ignored",
] as const;

/** Content-free events of the endpoint, for the hub's log (`mcp.*` in log.ts). */
export type McpEvent =
  | {
      readonly ev: "mcp.closed";
      readonly conn: number;
      readonly reason: (typeof CLOSE_REASONS)[number];
    }
  | {
      readonly ev: "mcp.refused";
      readonly conn: number;
      readonly reason: (typeof REFUSE_REASONS)[number];
    }
  | { readonly ev: "mcp.init_replayed"; readonly conn: number }
  | { readonly ev: "mcp.tool_failed"; readonly conn: number; readonly tool: string };

/** A transport's report as the event the log takes. */
function eventOf(conn: number, reason: TransportReason): McpEvent {
  switch (reason) {
    case "slow_reader":
    case "held_too_much":
      return { ev: "mcp.closed", conn, reason };
    case "init_replayed":
      return { ev: "mcp.init_replayed", conn };
    default:
      return { ev: "mcp.refused", conn, reason };
  }
}

export interface McpEndpointOptions {
  readonly ops: OpsHost;
  /** Session binding (M2.04): each connection's slot from its bind. Without it, all are unbound. */
  readonly bindings?: Bindings;
  readonly log?: (event: McpEvent) => void;
  /** Tests only. */
  readonly limits?: Partial<TransportLimits>;
}

const text = (value: string, isError: boolean): ToolResult =>
  isError
    ? { content: [{ type: "text", text: value }], isError: true }
    : { content: [{ type: "text", text: value }] };

/** The failure no error body describes: a bug. Nothing of it reaches the agent or the log. */
const INTERNAL = new AppError({
  code: "internal",
  message: "Something went wrong in the service.",
  hint: "Retry once. If it fails again, ask the user to run tasks doctor.",
});

/**
 * The tool calls of one connection: the request path, as the connection's principal, in its space.
 * With a slot (M2.04), the slot decides both: its session's when bound, else the unbound principal
 * in the space it pinned. Without one, the entry's `--space` names the space for each call.
 */
export function toolCaller(options: {
  readonly ops: OpsHost;
  readonly context: JsonObject;
  readonly conn: number;
  readonly log?: (event: McpEvent) => void;
  readonly slot?: Slot;
  readonly bindings?: Bindings;
}): ToolCall {
  const principal = bridgePrincipal(options.context, options.ops.machine.id);
  const client = clientOf(options.context);
  // The agent home whose grant rows decide the spaces this connection may use (A3 3.7.8).
  const home = instanceOf(options.context);
  const { slot, bindings } = options;
  const named = spaceOf(options.context);
  return async (tool, args, thread) => {
    const entry = toolEntry(tool);
    if (entry === undefined) return text(renderError(INTERNAL.toBody()), true);
    // Codex's per-call thread ID (A3 3.7.2): recorded for a later bind, never a binding itself.
    // On a connection that carries two conversations, a call whose own ID does not prove the
    // bound session acts without the binding (A3 3.7.5), in the space the connection pinned.
    const native = typeof thread === "string" ? thread : undefined;
    const binding =
      slot === undefined || bindings === undefined ? slot : bindings.forCall(slot, "codex", native);
    const space = binding === undefined ? (slot?.space ?? named) : undefined;
    try {
      const result = await opCall(
        options.ops,
        // No environment: TASKS_SPACE is a hint for diagnostics, never a binding (A3 3.7.2).
        {
          class: "bridge",
          env: {},
          principal,
          client,
          home,
          ...(binding === undefined ? {} : { binding }),
        },
        { op: entry.name, input: args, ...(space === undefined ? {} : { space }) },
      );
      return text(renderResult(entry.name, result), false);
    } catch (error) {
      if (error instanceof AppError) return text(renderError(error.toBody()), true);
      options.log?.({ ev: "mcp.tool_failed", conn: options.conn, tool });
      return text(renderError(INTERNAL.toBody()), true);
    }
  };
}

/** The local endpoint's `mcp` hook: serves each mcp mode connection it is given. */
export function mcpEndpoint(options: McpEndpointOptions): (channel: McpChannel) => void {
  return (channel) => {
    const { id: conn, context } = channel.connection;
    const log = options.log;
    const bindings = options.bindings;
    // The binding its bind frame resolved (binding/): open from here until the connection ends.
    const slot = bindings?.attach(channel.connection);
    const transport = new ChannelTransport(channel, {
      init: context["mcp_init"],
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      report: (reason) => log?.(eventOf(conn, reason)),
      ...(slot === undefined || bindings === undefined
        ? {}
        : {
            ended: () => {
              bindings.closed(slot);
            },
          }),
    });
    const call = toolCaller({
      ops: options.ops,
      context,
      conn,
      ...(log === undefined ? {} : { log }),
      ...(slot === undefined ? {} : { slot }),
      ...(bindings === undefined ? {} : { bindings }),
    });
    // serveStdio starts the transport before it returns, so the channel's line handler is set
    // before this hook returns, as the local server asks.
    serveStdio(() => createServer(call, (id) => transport.working(id)), {
      transport,
      onerror: () => {
        // The SDK's own reports name what a client sent; nothing of it is logged.
      },
    });
  };
}
