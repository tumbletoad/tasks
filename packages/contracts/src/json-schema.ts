// JSON Schema draft 2020-12 from the Zod schemas (A3 decision 2: `z.toJSONSchema`), the MCP tool
// definition and the token estimator (A3 3.2.5).
import { z } from "zod";
import { inputSchemaFor, type AnyEntry, type EntryKind } from "./define.ts";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type JsonSchema = Record<string, unknown>;

/**
 * Converts a schema. Inputs use the input side of normalising transforms. `$schema` is left out:
 * every generated schema is draft 2020-12, which is also MCP's default dialect.
 */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const converted = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "throw",
    cycles: "throw",
    reused: "inline",
  }) as JsonSchema;
  delete converted["$schema"];
  return converted;
}

/** The full input with its defaults, as the user's faces and the RPC methods take it. */
export function inputJsonSchema(entry: AnyEntry): JsonSchema {
  return toJsonSchema(inputSchemaFor(entry, "user"), "input");
}

/** The input agents see: hidden fields gone, required fields required, agent limits applied. */
export function agentInputJsonSchema(entry: AnyEntry): JsonSchema {
  return toJsonSchema(inputSchemaFor(entry, "agent"), "input");
}

export function outputJsonSchema(entry: AnyEntry): JsonSchema {
  return toJsonSchema(entry.output, "output");
}

export interface McpAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * Set explicitly on every tool, because the 2026-07-28 defaults are destructive and open-world
 * (A3 3.3). Writes are idempotent per request_id, and nothing is deleted: everything has history.
 */
export function annotationsFor(kind: EntryKind): McpAnnotations {
  return {
    readOnlyHint: kind === "read",
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/**
 * The `_meta` key that makes Claude Code load a tool's definition at start instead of on demand
 * (M0 row A09, A3 5). Only the tools a session needs first carry it.
 */
export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** One tool of `mcp-tools.json` (A3 3.2.2). */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: McpAnnotations;
  readonly _meta?: { readonly [ALWAYS_LOAD_META]: true };
}

export function mcpTool(entry: AnyEntry): McpTool | undefined {
  const face = entry.faces.mcp;
  if (face === undefined) return undefined;
  return {
    name: face.tool,
    title: face.title,
    description: face.description,
    inputSchema: agentInputJsonSchema(entry),
    annotations: annotationsFor(entry.kind),
    ...(face.alwaysLoad === true ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
  };
}

const utf8 = new TextEncoder();

/**
 * A3 3.2.5's estimator, `ceil(utf8 bytes / bytes per token)`, with M0's divisors (row A08):
 * divisor 3 undercounts for Claude, so tool definitions take 2.0 bytes per token
 * and tool results 1.5. They are estimates until Claude's own counts confirm them (M2.15).
 */
export const BYTES_PER_TOKEN = { definition: 2, result: 1.5 } as const;

/** Estimated tokens of `text` at `bytesPerToken`. */
export function estimateTokens(text: string, bytesPerToken: number): number {
  return Math.ceil(utf8.encode(text).length / bytesPerToken);
}

/** The estimated cost of a tool definition: its compact JSON. */
export function definitionTokens(tool: McpTool): number {
  return estimateTokens(JSON.stringify(tool), BYTES_PER_TOKEN.definition);
}

/** The estimated cost of a tool result's text. */
export function resultTokens(text: string): number {
  return estimateTokens(text, BYTES_PER_TOKEN.result);
}
