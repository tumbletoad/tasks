// JSON Schema draft 2020-12 from the Zod schemas (A3 decision 2: `z.toJSONSchema`), the MCP tool
// definition and the token estimator.
import { z } from "zod";
import {
  inputSchemaFor,
  shownKind,
  shownSchemaFor,
  type AnyEntry,
  type EntryKind,
} from "./define.ts";
import { isOffered } from "./later.ts";

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

/**
 * The input agents see: hidden fields gone, required fields required, agent limits applied, and
 * nothing a later step builds (later.ts).
 */
export function agentInputJsonSchema(entry: AnyEntry): JsonSchema {
  return toJsonSchema(shownSchemaFor(entry, "agent"), "input");
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
 * Set explicitly on every tool, because the 2026-07-28 defaults are destructive and open-world.
 * Writes are idempotent per request_id, and nothing is deleted: everything has history.
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
 * Only the tools a session needs first carry it.
 */
export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** One tool of `mcp-tools.json`. */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: McpAnnotations;
  readonly _meta?: { readonly [ALWAYS_LOAD_META]: true };
}

/** The tool of an entry, or undefined for an entry with no MCP face or none offered yet. */
export function mcpTool(entry: AnyEntry): McpTool | undefined {
  const face = entry.faces.mcp;
  if (face === undefined || !isOffered(entry.name)) return undefined;
  return {
    name: face.tool,
    title: face.title,
    description: face.description,
    inputSchema: agentInputJsonSchema(entry),
    annotations: annotationsFor(shownKind(entry)),
    ...(face.alwaysLoad === true ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
  };
}

const utf8 = new TextEncoder();

/**
 * The estimator, `ceil(utf8 bytes / bytes per token)`, with measured divisors:
 * divisor 3 undercounts for Claude, so tool definitions take 2.0 bytes per token
 * and tool results 1.5. They are estimates until Claude's own counts confirm them.
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
