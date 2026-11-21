// The server instructions (A3 3.6, 3.2.5; M0 row A06; M4.04): their size, their alphabet, the
// start rule in the first 240 characters, and the tools and fields they name, checked against the
// registry itself.
import { registry, type AnyEntry } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import { GUIDE_STEPS, GUIDES } from "../ops/guides.ts";
import {
  INSTRUCTIONS,
  MAX_INSTRUCTION_BYTES,
  START_RULE,
  START_RULE_CHARS,
} from "./instructions.ts";
import { TOOLS } from "./tools.ts";

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The registry's MCP tools: every entry with an MCP face (an agent may call each, check.ts). */
const REGISTRY_TOOLS: ReadonlyMap<string, AnyEntry> = new Map(
  registry.flatMap((entry) => {
    const tool = entry.faces.mcp?.tool;
    return tool === undefined ? [] : [[tool, entry] as const];
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
  test("ASCII only, at most 3,500 bytes, and about 2 KB", () => {
    expect(/^[\x20-\x7e\n]*$/.test(INSTRUCTIONS)).toBe(true);
    expect(bytes(INSTRUCTIONS)).toBeLessThanOrEqual(MAX_INSTRUCTION_BYTES);
    expect(MAX_INSTRUCTION_BYTES).toBe(3_500);
    // A3 3.6's target: about 2 KB.
    expect(bytes(INSTRUCTIONS)).toBeGreaterThan(1_500);
    expect(bytes(INSTRUCTIONS)).toBeLessThan(2_600);
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
      ...INSTRUCTIONS.matchAll(/end with ([a-z_]+)/g),
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
      ["get_task", "bind"],
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
    // The guides behind status hold the longer workflows (A3 3.6). A guide a later step brings is
    // refused by status now (GUIDE_STEPS), so the line must not name it yet.
    const line = /Longer workflows \(([a-z, ]+)\): status with guide\./u.exec(INSTRUCTIONS);
    const named = (line?.[1] ?? "").split(", ");
    expect(named.sort()).toEqual(Object.keys(GUIDES).sort());
    expect(named).toContain("work");
    for (const guide of named) {
      expect(valuesOf("status", "guide"), guide).toContain(guide);
      expect(Object.hasOwn(GUIDE_STEPS, guide), guide).toBe(false);
    }
  });
});
