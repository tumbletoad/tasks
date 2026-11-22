// The MCP endpoint (A3 3.3): one SDK server per mcp mode connection, from one factory, the era
// picked by the connection's opening exchange (the SDK's stdio entry over our transport). A tool
// call goes to the request path (`opCall`) with the connection's principal and space, and its
// result or error comes back as one compact text within its budget (render.ts).
//
// Task content never leaves through a side door: a tool's arguments and results reach only the
// request path and the tool's own result. Events carry a connection number, a tool name from the
// generated list and fixed words.
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError } from "@ttasks/contracts";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { McpChannel } from "../local/index.ts";
import type { Bridges } from "../binding/bridges.ts";
import { opCall, type Binding, type Caller, type OpsHost } from "../ops/index.ts";
import { bridgePrincipal, clientOf, instanceOf, spaceOf } from "./principal.ts";
import { renderError, renderResult, showsWhole } from "./render.ts";
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
  /** Each connection's binding from its bind. Without it, each is none, in its entry's space. */
  readonly bridges?: Bridges;
  readonly log?: (event: McpEvent) => void;
  /**
   * A tool call went through the request path from this instance and app (the entry's `--instance`
   * and `--app`), in the bridge's working folder (the bind context's `cwd`): `ttasks doctor --live`
   * asks for it (hub/agent-homes.ts `setup/seen`). Only a call the service carried out counts.
   */
  readonly seen?: (
    instance: string | undefined,
    app: string | undefined,
    folder: string | undefined,
  ) => void;
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
  hint: "Retry once. If it fails again, ask the user to run ttasks doctor.",
});

/**
 * Who a bridge connection's calls come from: who it is by its bind, in the one space that bind
 * settled. No environment: TTASKS_SPACE is a hint for diagnostics, never a space.
 */
export function bridgeCaller(context: JsonObject, machine: string, binding: Binding): Caller {
  const cwd = context["cwd"];
  return {
    class: "bridge",
    env: {},
    principal: bridgePrincipal(context, machine),
    client: clientOf(context),
    // The agent home whose grant rows decide the spaces this connection may use when it is none.
    home: instanceOf(context),
    binding,
    ...(typeof cwd === "string" ? { folder: cwd } : {}),
  };
}

/** The tool calls of one connection: the request path, as `bridgeCaller`. No tool names a space. */
export function toolCaller(options: {
  readonly ops: OpsHost;
  readonly context: JsonObject;
  readonly conn: number;
  readonly log?: (event: McpEvent) => void;
  readonly seen?: McpEndpointOptions["seen"];
  readonly binding: Binding;
}): ToolCall {
  const caller: Caller = {
    ...bridgeCaller(options.context, options.ops.machine.id, options.binding),
    shows: showsWhole,
  };
  const { client, folder } = caller;
  return async (tool, args) => {
    const entry = toolEntry(tool);
    if (entry === undefined) return text(renderError(INTERNAL.toBody()), true);
    try {
      const result = await opCall(options.ops, caller, { op: entry.name, input: args });
      options.seen?.(client?.instance, client?.app, folder);
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
    const bridges = options.bridges;
    // The binding its bind frame decided: fixed from here until the connection ends.
    const binding = bridges?.attach(channel.connection) ?? {
      kind: "none",
      space: spaceOf(context),
    };
    const transport = new ChannelTransport(channel, {
      init: context["mcp_init"],
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      report: (reason) => log?.(eventOf(conn, reason)),
      ...(bridges === undefined
        ? {}
        : {
            ended: () => {
              bridges.closed(channel.connection);
            },
          }),
    });
    const call = toolCaller({
      ops: options.ops,
      context,
      conn,
      ...(log === undefined ? {} : { log }),
      ...(options.seen === undefined ? {} : { seen: options.seen }),
      binding,
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
