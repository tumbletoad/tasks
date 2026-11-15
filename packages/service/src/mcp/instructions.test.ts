// The server instructions v0 (A3 3.6, 3.2.5; M0 row A06): their size, their alphabet, the start
// rule in the first 240 characters, and the tools they name.
import { registry } from "@tasks/contracts";
import { describe, expect, test } from "vitest";
import {
  INSTRUCTIONS,
  MAX_INSTRUCTION_BYTES,
  START_RULE,
  START_RULE_CHARS,
} from "./instructions.ts";
import { TOOLS } from "./tools.ts";

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe("[A3.3.6.mcp.instructions] the server instructions v0", () => {
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
  });

  test("every tool the text names is listed, and every listed tool is named", () => {
    const tools = new Set(TOOLS.map((tool) => tool.name));
    const fields = new Set(
      registry.flatMap((entry) =>
        entry.faces.mcp === undefined ? [] : Object.keys(entry.input.shape),
      ),
    );
    // Every snake_case word is a tool, a tool's input field, or as_of (the read position).
    const words = INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      expect(tools.has(word) || fields.has(word) || word === "as_of", word).toBe(true);
    }
    // Claude Code loads only the tool names and these instructions at start (A3 3.3): every one of
    // the eleven is named, so a session finds each without a tool search.
    expect(tools.size).toBe(11);
    for (const tool of tools) expect(INSTRUCTIONS, tool).toMatch(new RegExp(`\\b${tool}\\b`));
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
});
