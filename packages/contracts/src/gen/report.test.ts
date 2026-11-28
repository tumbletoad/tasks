// The definition report: every tool definition's size is reported in
// `mcp-definitions.json`, and the report matches the generated definitions byte for byte.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  BYTES_PER_TOKEN,
  definitionTokens,
  estimateTokens,
  mcpTool,
  resultTokens,
  type McpTool,
} from "../json-schema.ts";
import { registry } from "../registry.ts";
import { definitionReport, type DefinitionReport } from "./report.ts";

const generated = (name: string): string =>
  readFileSync(new URL(`../../generated/${name}`, import.meta.url), "utf8");

const utf8 = new TextEncoder();

describe("[A3.3.2.5.mcp.definition-report] the definition report matches the generated definitions", () => {
  test("each tool's bytes and estimated tokens are those of its compact JSON in mcp-tools.json", () => {
    const { tools } = JSON.parse(generated("mcp-tools.json")) as { tools: McpTool[] };
    const report = JSON.parse(generated("mcp-definitions.json")) as DefinitionReport;
    expect(report.tools.map((row) => row.name)).toEqual(tools.map((tool) => tool.name));
    tools.forEach((tool, i) => {
      const bytes = utf8.encode(JSON.stringify(tool)).length;
      expect(report.tools[i]).toEqual({
        name: tool.name,
        bytes,
        tokens: Math.ceil(bytes / BYTES_PER_TOKEN.definition),
      });
    });
    expect(report.total).toEqual({
      tools: tools.length,
      bytes: report.tools.reduce((sum, row) => sum + row.bytes, 0),
      tokens: report.tools.reduce((sum, row) => sum + row.tokens, 0),
    });
    expect(report).toEqual(definitionReport(tools));
  });

  test("the generated definitions are the registry's: same sizes as the definitions it builds", () => {
    const report = JSON.parse(generated("mcp-definitions.json")) as DefinitionReport;
    const built = registry
      .map(mcpTool)
      .filter((tool): tool is McpTool => tool !== undefined)
      .map((tool) => ({ name: tool.name, tokens: definitionTokens(tool) }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(report.tools.map(({ name, tokens }) => ({ name, tokens }))).toEqual(built);
  });

  test("status and get_task load at start in Claude Code; the other tools on demand", () => {
    const { tools } = JSON.parse(generated("mcp-tools.json")) as { tools: McpTool[] };
    const eager = tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true);
    expect(eager.map((tool) => tool.name).sort()).toEqual(["get_task", "status"]);
  });

  test("the estimator: 2.0 bytes per token for definitions, 1.5 for results, rounded up", () => {
    expect(BYTES_PER_TOKEN).toEqual({ definition: 2, result: 1.5 });
    expect(estimateTokens("abcd", 2)).toBe(2);
    expect(estimateTokens("abcde", 2)).toBe(3);
    expect(resultTokens("abc")).toBe(2);
    expect(resultTokens("abcd")).toBe(3);
    // UTF-8 bytes, not characters: three bytes each.
    expect(resultTokens("日本語")).toBe(6);
    expect(resultTokens("")).toBe(0);
  });
});
