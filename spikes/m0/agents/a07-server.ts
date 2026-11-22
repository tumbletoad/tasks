// A07's one-server question: the official v2 TypeScript server SDK over stdio. Usage:
//   node a07-server.ts --mode factory|single --count <file>
// `factory`: serveStdio with a factory, the SDK's own era selection, one instance pinned per
// connection. `single`: one McpServer object hand-wired to a StdioServerTransport. The count file
// gets one line per instance the process built, so the lab sees how many objects served.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { option } from "../kit/wire.ts";
import { errorLabel } from "./facts.ts";

const args = process.argv.slice(2);
const mode = option(args, "--mode") ?? "factory";
const count = option(args, "--count");

function build(): McpServer {
  if (count !== undefined) appendFileSync(count, "instance\n");
  const server = new McpServer(
    { name: "ttasks-a07", version: "0.0.0" },
    { capabilities: { tools: {} }, instructions: "Tasks A07 stand-in. One tool: status." },
  );
  server.registerTool(
    "status",
    { description: "Returns ok.", annotations: { readOnlyHint: true } },
    () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  return server;
}

// The program's boundary: an error class only, never its message, a path or a stack.
const fail = (error: unknown) => {
  process.stderr.write(`a07-server: error ${errorLabel(error)}\n`);
  process.exit(70);
};
process.on("uncaughtException", fail);
try {
  if (mode === "single") {
    await build().connect(new StdioServerTransport());
  } else {
    serveStdio(build);
  }
} catch (error) {
  fail(error);
}
