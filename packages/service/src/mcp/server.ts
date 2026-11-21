// The MCP server of one connection (A3 3.3): the official SDK's low-level server, built fresh for
// each connection from one factory, as M0 qualified it (row A07: one server object cannot answer
// both eras; one factory, one server per connection can). It serves precompiled JSON: the tool
// list from contracts' generated file and the server instructions, the same for every connection.
// Tools only (A3 3.3 "Methods"): no resources, prompts, sampling, elicitation, roots or
// `list_changed`. A tool call goes to `call`, which the endpoint wires to the request path.
import { PRODUCT_ID } from "@ttasks/brand";
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { BUILD } from "../hub/build.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { TOOLS, toolEntry } from "./tools.ts";

/** A tool result: one text item, an error flagged (A3 3.3 "Results"). */
export type ToolResult = CallToolResult & {
  readonly content: [{ readonly type: "text"; readonly text: string }];
};

/**
 * Runs one tool call. `tool` is a listed tool's name; `args` its arguments object, unchecked.
 * `thread` is the call's `_meta.threadId` (Codex sends it on every `tools/call`, A3 3.7.2),
 * unchecked: binding records it, nothing else reads it.
 */
export type ToolCall = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  thread?: unknown,
) => Promise<ToolResult>;

/** The implementation the server names in `initialize`, `server/discover` and 2026 results. */
export const SERVER_INFO = { name: PRODUCT_ID, version: BUILD.version } as const;

/**
 * Tells the connection's transport that a tool call's work starts; the returned function says it
 * ended (transport.ts `working`), so a cancelled call keeps its place until its work is done.
 */
export type Working = (id: string | number) => () => void;

/**
 * Builds the server of one connection. Its answers depend on nothing about the connection. It is
 * the SDK's low-level server: A3 3.3 serves precompiled JSON through request handlers, while the
 * high-level McpServer the SDK steers to registers each tool with its own schema and builds the
 * list itself, which would make the served list the SDK's rather than the generated one.
 */
export function createServer(call: ToolCall, working?: Working) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the low-level server, above
  const server = new Server(
    { ...SERVER_INFO },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  );
  // The generated list as it is: never rebuilt, never filtered.
  server.setRequestHandler("tools/list", () => ({ tools: TOOLS }) as never);
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args, _meta: meta } = request.params;
    if (toolEntry(name) === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool");
    }
    // The request path is not stopped by a cancellation: a write either happens or not, and a
    // retry with the same request ID finds its receipt. Its place is held until it ends.
    const ended = working?.(ctx.mcpReq.id);
    try {
      return await call(
        name,
        args ?? {},
        (meta as Record<string, unknown> | undefined)?.["threadId"],
      );
    } finally {
      ended?.();
    }
  });
  return server;
}
