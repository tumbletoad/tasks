// What a later step builds (contracts' later.ts) is never offered: no tool, field or value on the
// list reaches what an agent is shown (the tool list the endpoint and the offline file serve, the
// instructions, the guides, docs/agents/tools.md), and every row names something its entry declares.
import { readFileSync } from "node:fs";
import { coreOf, defOf, findEntry, LATER, isOffered } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import { GUIDES } from "../ops/guides.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { toolEntry, TOOLS } from "./tools.ts";

const DOCS = readFileSync(new URL("../../../../docs/agents/tools.md", import.meta.url), "utf8");

const word = (name: string) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "u");

/** Every property name and enum value anywhere in a JSON Schema. */
function names(schema: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema as unknown[]) names(item, into);
  } else if (typeof schema === "object" && schema !== null) {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const property of Object.keys(value)) into.add(property);
      }
      if (key === "enum" && Array.isArray(value)) {
        for (const v of value) if (typeof v === "string") into.add(v);
      }
      names(value, into);
    }
  }
  return into;
}

const toolOfEntry = (entry: string) => TOOLS.find((t) => toolEntry(t.name)?.name === entry);

/** A row's name as an agent would read it: the tool, the value, or the field. */
function nameOf(row: (typeof LATER)[number]): string {
  if ("field" in row) return row.value ?? row.field;
  return findEntry(row.entry)?.faces.mcp?.tool ?? row.entry;
}

describe("[A3.3.3.mcp.later] what a later step builds is never offered", () => {
  test("every row names an entry, and a field or a value that entry declares", () => {
    for (const row of LATER) {
      const entry = findEntry(row.entry);
      expect(entry, row.entry).toBeDefined();
      if (entry === undefined || !("field" in row)) continue;
      const field = (entry.input.shape as Record<string, Parameters<typeof coreOf>[0]>)[row.field];
      expect(field, `${row.entry}.${row.field}`).toBeDefined();
      if (field === undefined || row.value === undefined) continue;
      const entries = defOf(coreOf(field))["entries"] as Record<string, string> | undefined;
      expect(Object.values(entries ?? {}), `${row.entry}.${row.field}`).toContain(row.value);
    }
  });

  test("a whole entry has no tool, and a listed field or value is not in its tool", () => {
    for (const row of LATER) {
      const tool = toolOfEntry(row.entry);
      if (!("field" in row)) {
        expect(tool, row.entry).toBeUndefined();
        expect(isOffered(row.entry)).toBe(false);
        expect(toolEntry(findEntry(row.entry)?.faces.mcp?.tool)).toBeUndefined();
        continue;
      }
      if (tool === undefined) continue;
      const property = (tool.inputSchema["properties"] as Record<string, unknown>)[row.field] as
        { enum?: unknown[] } | undefined;
      if (row.value === undefined) expect(property, `${row.entry}.${row.field}`).toBeUndefined();
      else expect(property?.enum ?? [], `${row.entry}.${row.field}`).not.toContain(row.value);
      // Nor does the tool's text name it.
      expect(JSON.stringify(tool), `${tool.name}: ${nameOf(row)}`).not.toMatch(word(nameOf(row)));
    }
  });

  test("a name no tool offers appears nowhere an agent reads", () => {
    const offered = new Set(TOOLS.map((t) => t.name));
    for (const tool of TOOLS) names(tool.inputSchema, offered);
    const texts: [string, string][] = [
      ["the instructions", INSTRUCTIONS],
      ...Object.entries(GUIDES).map(([name, text]): [string, string] => [`guide ${name}`, text]),
      ...TOOLS.map((t): [string, string] => [t.name, JSON.stringify(t)]),
      ["docs/agents/tools.md", DOCS],
    ];
    const absent = [...new Set(LATER.map(nameOf))].filter((name) => !offered.has(name));
    // The list's own names: a tool, a field and two values no tool offers.
    expect(absent).toEqual(
      expect.arrayContaining(["run_report", "remove_sources", "propose", "refresh"]),
    );
    for (const name of absent) {
      for (const [where, text] of texts) expect(text, `${where}: ${name}`).not.toMatch(word(name));
    }
  });
});
