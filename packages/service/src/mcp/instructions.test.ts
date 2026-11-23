// The server instructions: their size, their alphabet, the start rule in the first 240
// characters, and the tools and fields they name, checked against the registry itself.
import { isOffered, laterFields, registry, type AnyEntry } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import { GUIDES } from "../ops/guides.ts";
import {
  INSTRUCTIONS,
  MAX_INSTRUCTION_CHARS,
  START_RULE,
  START_RULE_CHARS,
} from "./instructions.ts";
import { TOOLS } from "./tools.ts";

/** The registry's MCP tools this build offers: every entry with an MCP face that is not later's. */
const REGISTRY_TOOLS: ReadonlyMap<string, AnyEntry> = new Map(
  registry.flatMap((entry) => {
    const tool = entry.faces.mcp?.tool;
    return tool === undefined || !isOffered(entry.name) ? [] : [[tool, entry] as const];
  }),
);

/** A tool's input fields, from its registry entry. */
const fieldsOf = (tool: string): readonly string[] => {
  const entry = REGISTRY_TOOLS.get(tool);
  return entry === undefined ? [] : Object.keys(entry.input.shape);
};

/** The values a tool's enum field takes, from its registry entry. */
const valuesOf = (tool: string, field: string): readonly string[] => {
  const schema = REGISTRY_TOOLS.get(tool)?.input.shape[field] as
    { unwrap?: () => unknown; options?: unknown } | undefined;
  const inner = (schema?.unwrap?.() ?? schema) as { options?: unknown } | undefined;
  return Array.isArray(inner?.options) ? (inner.options as string[]) : [];
};

describe("[A3.3.6.mcp.instructions] the server instructions", () => {
  test("ASCII only, and whole within what Claude Code shows its model", () => {
    expect(/^[\x20-\x7e\n]*$/.test(INSTRUCTIONS)).toBe(true);
    // The smallest cut a Claude Code release makes (MAX_INSTRUCTION_CHARS says where it comes from).
    expect(MAX_INSTRUCTION_CHARS).toBe(2_048);
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
  });

  test("the trigger and the start rule stand alone in the first 240 characters", () => {
    expect(START_RULE_CHARS).toBe(240);
    expect(INSTRUCTIONS.startsWith(START_RULE)).toBe(true);
    expect(START_RULE.length).toBeLessThanOrEqual(START_RULE_CHARS);
    const head = INSTRUCTIONS.slice(0, START_RULE_CHARS);
    // The trigger words, and both ways to start: a launch reference, or status with the cwd.
    for (const words of ["task list", "task", "todo", "launch", "get_task", "status", "cwd"]) {
      expect(head).toContain(words);
    }
    // The start rule ends inside the first 240 characters, so a cut there leaves it whole.
    expect(head).toContain("Otherwise call status with your cwd.");
    // What the start rule asks for exists: get_task takes launch, status takes cwd.
    expect(fieldsOf("get_task")).toContain("launch");
    expect(fieldsOf("status")).toContain("cwd");
  });

  test("every tool the text names is a registry tool, and every registry tool is named", () => {
    // The generated list the endpoint serves is the registry's (contracts' gen): the same names.
    expect([...REGISTRY_TOOLS.keys()].sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const tools = new Set(REGISTRY_TOOLS.keys());
    const fields = new Set([...tools].flatMap(fieldsOf));
    // Every snake_case word is a tool, a tool's input field, or as_of (the read position).
    const words = INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      expect(tools.has(word) || fields.has(word) || word === "as_of", word).toBe(true);
    }
    // A one-word tool name is caught where the text calls or names a tool: after "call", before
    // "with", and after a colon that ends a "for this, use" line.
    const named = [
      ...INSTRUCTIONS.matchAll(/\bcall ([a-z_]+)/g),
      ...INSTRUCTIONS.matchAll(/\b([a-z_]+) with (?:launch|task|scope|guide|your|only|one)\b/g),
      ...INSTRUCTIONS.matchAll(/: ([a-z_]+)\./g),
    ].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(8);
    for (const tool of named) expect(tools.has(tool), tool).toBe(true);
    // Claude Code loads only the tool names and these instructions at start (A3 3.3): every one of
    // the registry's tools is named, so a session finds each without a tool search.
    for (const tool of tools) expect(INSTRUCTIONS, tool).toMatch(new RegExp(`\\b${tool}\\b`));
  });

  test("the fields and values the text names are the tools' own", () => {
    const claims: readonly (readonly [string, string, string?])[] = [
      ["get_task", "task"],
      ["get_task", "launch"],
      ["get_task", "sections"],
      ["search", "scope", "learnings"],
      ["complete_task", "follow_ups"],
      ["update_task", "base"],
      ["update_task", "request_id"],
    ];
    for (const [tool, field, value] of claims) {
      expect(fieldsOf(tool), `${tool}.${field}`).toContain(field);
      if (value !== undefined) expect(valuesOf(tool, field), `${tool}.${field}`).toContain(value);
    }
  });

  test("search and add_tasks carry A3 3.6's lines for working and for small calls", () => {
    expect(INSTRUCTIONS).toContain(
      'call search with scope "learnings" for lessons from similar tasks.',
    );
    expect(INSTRUCTIONS).toMatch(/Work left for later becomes a task \(add_tasks\b/);
    expect(INSTRUCTIONS).toContain("not a TODO in a file.");
    expect(INSTRUCTIONS).toContain("Give items from email, chat or tickets a source key.");
    expect(INSTRUCTIONS).toContain(
      "Keep calls small: search rows first, then get_task with only the sections you need.",
    );
  });

  test("the guides line names only the guides this build serves, and every one of them", () => {
    // The guides behind status hold the longer workflows. A guide a later step brings is on the
    // later list, so status neither offers nor names it yet.
    const line = /Longer workflows \(([a-z, ]+)\): status with guide\./u.exec(INSTRUCTIONS);
    const named = (line?.[1] ?? "").split(", ");
    expect(named.sort()).toEqual(Object.keys(GUIDES).sort());
    expect(named).toContain("work");
    for (const guide of named) {
      expect(valuesOf("status", "guide"), guide).toContain(guide);
    }
    // Every guide the tool offers is one this build has.
    const later = laterFields("space.status").flatMap((row) =>
      row.field === "guide" && row.value !== undefined ? [row.value] : [],
    );
    const offered = valuesOf("status", "guide").filter((guide) => !later.includes(guide));
    expect(offered.sort()).toEqual(Object.keys(GUIDES).sort());
  });
});
