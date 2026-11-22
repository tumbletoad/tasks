// A stdio MCP server with one tool, `probe_echo`, that the recorder gives a thread in its
// configuration, as the run driver gives TTasks's own tools: what Codex says around a tool call of a
// server named per thread is then in the recording. It answers `initialize`, `tools/list` and
// `tools/call`, and ignores notifications. Never shipped.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

lines.on("line", (line) => {
  let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return;
  }
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: message.params?.["protocolVersion"] ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ttasks", version: "0.0.0" },
        },
      });
      return;
    case "tools/list":
      send({
        id: message.id,
        result: {
          tools: [
            {
              name: "probe_echo",
              description: "Returns the text it is given.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
      return;
    case "tools/call": {
      const args = (message.params?.["arguments"] ?? {}) as { text?: unknown };
      send({
        id: message.id,
        result: {
          content: [{ type: "text", text: typeof args.text === "string" ? args.text : "" }],
        },
      });
      return;
    }
    default:
      send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
lines.on("close", () => {
  process.exit(0);
});
