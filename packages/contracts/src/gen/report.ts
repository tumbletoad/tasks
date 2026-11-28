// `mcp-definitions.json`: the size of every tool definition, reported and not capped.
// A definition's cost is its compact JSON as `tools/list` returns it, estimated at the
// divisor for definitions. The file is generated beside `mcp-tools.json`, so growth
// shows in a diff and is a reviewed change, and a test holds it equal to the generated definitions.
import { BYTES_PER_TOKEN, type McpTool } from "../json-schema.ts";

const utf8 = new TextEncoder();

export interface DefinitionReport {
  readonly estimator: string;
  readonly bytes_per_token: number;
  readonly tools: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly tokens: number;
  }[];
  readonly total: { readonly tools: number; readonly bytes: number; readonly tokens: number };
}

/** The report of `tools`, in their order: bytes and estimated tokens of each, and the sum. */
export function definitionReport(tools: readonly McpTool[]): DefinitionReport {
  const divisor = BYTES_PER_TOKEN.definition;
  const rows = tools.map((tool) => {
    const bytes = utf8.encode(JSON.stringify(tool)).length;
    return { name: tool.name, bytes, tokens: Math.ceil(bytes / divisor) };
  });
  return {
    estimator: "ceil(utf8 bytes of the compact JSON / bytes_per_token), per tool (A3 3.2.5)",
    bytes_per_token: divisor,
    tools: rows,
    total: {
      tools: rows.length,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    },
  };
}
