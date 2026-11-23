// The shipped skills and the skill file format: what the repository's `skills/` holds is what an
// agent gets, each in the Agent Skills format and within its size, and the user's part of a
// default holds judgement only, so no edit of it can break a call.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registry, resultTokens } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTION_CHARS, parseSkill } from "./format.ts";
import { DEFAULTS, SKILL_BYTES, isSkillName, listSkills, servedText } from "./index.ts";

const REPO_SKILLS = join(import.meta.dirname, "..", "..", "..", "..", "skills");
const SCALE = { efforts: ["S", "M", "L"] };
/** What one shipped skill may cost an agent who reads it, in estimated tokens. */
const SHIPPED_TOKENS = 1_500;

const shipped = readdirSync(REPO_SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const encode = (text: string) => new TextEncoder().encode(text);

describe("[A3.3.6.mcp.skills] the shipped skills", () => {
  test("each is a SKILL.md in the Agent Skills format, served as the repository holds it", () => {
    expect(shipped.length).toBeGreaterThan(0);
    expect([...DEFAULTS.keys()].sort()).toEqual([...shipped].sort());
    for (const name of shipped) {
      const file = readFileSync(join(REPO_SKILLS, name, "SKILL.md"));
      expect(isSkillName(name), name).toBe(true);
      expect(file.byteLength, name).toBeLessThanOrEqual(SKILL_BYTES);
      const text = file.toString("utf8");
      expect(text, name).toMatch(
        new RegExp(`^---\\nname: ${name}\\ndescription: Use [^\\n]+\\n---\\n`, "u"),
      );
      const parsed = parseSkill(file);
      if (!parsed.ok) throw new Error(`${name}: ${parsed.problem}`);
      expect(parsed.description?.length ?? 0, name).toBeLessThanOrEqual(DESCRIPTION_CHARS);
      expect(DEFAULTS.get(name)?.file, name).toBe(text);
    }
  });

  test("each is ASCII and small enough to read before every add", async () => {
    for (const skill of await listSkills(undefined)) {
      const text = servedText(skill, SCALE) ?? "";
      expect(/^[\x20-\x7e\n]*$/u.test(text), skill.name).toBe(true);
      expect(resultTokens(text), skill.name).toBeLessThanOrEqual(SHIPPED_TOKENS);
    }
  });

  test("the user's part of a default names no tool and no field; TTasks' part does", async () => {
    const tools = registry.flatMap((entry) => entry.faces.mcp?.tool ?? []);
    for (const skill of await listSkills(undefined)) {
      const body = skill.body ?? "";
      // Tool and field names are snake_case (get_task, request_id); one-word tools are caught
      // where text calls or names one.
      expect(body.match(/\b[a-z]+_[a-z_]+\b/gu) ?? [], skill.name).toEqual([]);
      for (const tool of tools) {
        expect(body, `${skill.name}: ${tool}`).not.toMatch(
          new RegExp(`\`${tool}\`|\\bcall ${tool}\\b|\\b${tool} with\\b`, "u"),
        );
      }
      const ttasks = (servedText(skill, SCALE) ?? "").slice(0, -body.length);
      expect(
        tools.some((tool) => new RegExp(`\\b${tool}\\b`, "u").test(ttasks)),
        skill.name,
      ).toBe(true);
    }
  });

  test("sizing-effort gives the space's own sizes", async () => {
    const sizing = (await listSkills(undefined)).find((skill) => skill.name === "sizing-effort");
    if (sizing === undefined) throw new Error("no sizing-effort");
    expect(servedText(sizing, { efforts: ["XS", "S", "M", "L", "XL"] })).toContain(
      "This space's sizes, smallest first: XS, S, M, L, XL.",
    );
  });
});

describe("[A3.3.6.mcp.skills] a skill file", () => {
  test("its front matter is read the ways other apps write it", () => {
    const description = (text: string) => {
      const parsed = parseSkill(encode(text));
      return parsed.ok ? parsed.description : parsed.problem;
    };
    expect(description("---\nname: a\ndescription: Use it.\n---\nBody")).toBe("Use it.");
    expect(description("---\r\nname: a\r\ndescription: 'It''s for you.'\r\n---\r\nBody")).toBe(
      "It's for you.",
    );
    expect(description('---\ndescription: "Use \\"it\\"."\nlicense: MIT\n---\n')).toBe('Use "it".');
    expect(description("---\ndescription: >-\n  Use it\n  when asked.\nname: a\n---\n")).toBe(
      "Use it when asked.",
    );
    expect(description("---\nname: a\n---\nBody")).toBeUndefined();
    expect(description("---\nname: a\nBody")).toBe("its front matter has no closing --- line");
  });

  test("its text is UTF-8 or UTF-16 with a byte order mark, and over the limit it is not read", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x42, 0, 0x6f, 0, 0x64, 0, 0x79, 0]);
    expect(parseSkill(utf16)).toEqual({ ok: true, description: undefined, body: "Body" });
    expect(parseSkill(encode("\uFEFFBody\n"))).toEqual({
      ok: true,
      description: undefined,
      body: "Body",
    });
    expect(parseSkill(new Uint8Array([0x41, 0xc3, 0x28]))).toEqual({
      ok: false,
      problem: "it is not UTF-8 text",
    });
    expect(parseSkill(new Uint8Array(SKILL_BYTES + 1).fill(0x41))).toEqual({
      ok: false,
      problem: "it is 17 KB, over the limit of 16 KB",
    });
  });
});
