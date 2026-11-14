// The one tool list (A3 3.3, X3): contracts' generated `mcp-tools.json`, served as it is on every
// connection, bound or not, in both eras, and copied into the offline file from the same import.
// Nothing about a connection changes it, so no `list_changed` is ever needed.
import { findEntry, registry, type AnyEntry, type McpTool } from "@tasks/contracts";
import generated from "@tasks/contracts/generated/mcp-tools.json" with { type: "json" };

/** The tools, in the generated file's order and with its key order. One list for all. */
export const TOOLS: readonly McpTool[] = Object.freeze(
  (generated as unknown as { tools: McpTool[] }).tools,
);

/** The registry entry behind each tool: the one whose MCP face names it. */
const ENTRIES: ReadonlyMap<string, AnyEntry> = new Map(
  registry.flatMap((entry) => {
    const tool = entry.faces.mcp?.tool;
    return tool !== undefined && TOOLS.some((t) => t.name === tool) ? [[tool, entry] as const] : [];
  }),
);

/** The entry a tool name calls, or undefined for a name that is not a tool. */
export function toolEntry(name: unknown): AnyEntry | undefined {
  return typeof name === "string" ? ENTRIES.get(name) : undefined;
}

/** The tool name of a registry entry; throws for an entry without an MCP face. */
export function toolOf(entryName: string): string {
  const tool = findEntry(entryName)?.faces.mcp?.tool;
  if (tool === undefined || !ENTRIES.has(tool)) {
    throw new Error(`${entryName} is not an MCP tool of this build`);
  }
  return tool;
}
