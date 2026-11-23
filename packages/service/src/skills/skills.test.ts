// The shipped skills and the skill file format: what the repository's `skills/` holds is what an
// agent gets, each in the Agent Skills format and within its size, and the user's part of a
// default holds judgement only, so no edit of it can break a call.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, resultTokens } from "@ttasks/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DESCRIPTION_CHARS, parseSkill } from "./format.ts";
import {
  DEFAULTS,
  SKILL_BYTES,
  SKILL_FOLDERS,
  isSkillName,
  listSkills,
  readSkills,
  servedText,
} from "./index.ts";

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
    for (const skill of (await listSkills(undefined)).skills) {
      const text = servedText(skill, SCALE) ?? "";
      expect(/^[\x20-\x7e\n]*$/u.test(text), skill.name).toBe(true);
      expect(resultTokens(text), skill.name).toBeLessThanOrEqual(SHIPPED_TOKENS);
    }
  });

  test("the user's part of a default names no tool and no field; TTasks' part does", async () => {
    const tools = registry.flatMap((entry) => entry.faces.mcp?.tool ?? []);
    for (const skill of (await listSkills(undefined)).skills) {
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
    const sizing = (await listSkills(undefined)).skills.find(
      (skill) => skill.name === "sizing-effort",
    );
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
    expect(description('---\ndescription: "Use \\"it\\"."\nlicense: MIT\n---\nBody')).toBe(
      'Use "it".',
    );
    expect(description("---\ndescription: >-\n  Use it\n  when asked.\nname: a\n---\nBody")).toBe(
      "Use it when asked.",
    );
    expect(description("---\nname: a\n---\nBody")).toBeUndefined();
    expect(description("---\nname: a\nBody")).toBe("its front matter has no closing --- line");
  });

  test("an empty, cut or binary file is not used, and says why", () => {
    const problem = (bytes: Uint8Array) => {
      const parsed = parseSkill(bytes);
      return parsed.ok ? undefined : parsed.problem;
    };
    expect(problem(encode(""))).toBe("it is empty");
    expect(problem(encode(" \n\t\n"))).toBe("it is empty");
    expect(problem(encode("---\nname: a\ndescription: Use it.\n---\n\n"))).toBe(
      "it has no text after its front matter",
    );
    expect(problem(new Uint8Array([0x41, 0x00, 0x42]))).toBe("it is not text: it holds a NUL byte");
    // Prose with no front matter is a skill as it stands.
    expect(problem(encode("Every title starts with a verb."))).toBeUndefined();
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

describe("[A3.3.6.mcp.skills] the user's skills folder", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tt-skills-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const write = (dir: string, name: string, text: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), text);
  };
  const OUTSIDE = "A rule from outside the skills folder.";

  test("a linked skill folder, or a linked skills folder, is not read, and says so", async () => {
    const outside = join(root, "outside");
    write(outside, "sizing-effort", `${OUTSIDE}\n`);
    write(outside, "away", `${OUTSIDE}\n`);
    const folder = join(root, "skills");
    mkdirSync(folder);
    // A junction on Windows, a link elsewhere: neither needs special rights.
    symlinkSync(join(outside, "sizing-effort"), join(folder, "sizing-effort"), "junction");
    symlinkSync(join(outside, "away"), join(folder, "away"), "junction");
    for (const skills of [
      (await listSkills(folder)).skills,
      (await readSkills(folder, ["sizing-effort", "away"])).skills,
    ]) {
      const sizing = skills.find((skill) => skill.name === "sizing-effort");
      expect(sizing?.origin).toBe("default");
      expect(sizing?.body).toBe(DEFAULTS.get("sizing-effort")?.body);
      expect(sizing?.problem).toContain("it is a link");
      const away = skills.find((skill) => skill.name === "away");
      expect(away).toMatchObject({ origin: "own", body: undefined });
      expect(away?.problem).toContain("it is a link");
    }
    const linked = join(root, "linked");
    symlinkSync(outside, linked, "junction");
    for (const skills of [
      (await listSkills(linked)).skills,
      (await readSkills(linked, ["sizing-effort", "away"])).skills,
    ]) {
      for (const skill of skills) {
        expect(skill.body ?? "", skill.name).not.toContain(OUTSIDE);
        expect(skill.problem, skill.name).toContain("the skills folder: it is a link");
      }
    }
  });

  test("a linked SKILL.md in a real folder is not read", async (context) => {
    const outside = join(root, "outside.md");
    writeFileSync(outside, `${OUTSIDE}\n`);
    mkdirSync(join(root, "skills", "sizing-effort"), { recursive: true });
    try {
      symlinkSync(outside, join(root, "skills", "sizing-effort", "SKILL.md"), "file");
    } catch (error) {
      // Windows lets an account make a file link only in developer mode or as an administrator.
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }
    const [sizing] = (await readSkills(join(root, "skills"), ["sizing-effort"])).skills;
    expect(sizing?.body).toBe(DEFAULTS.get("sizing-effort")?.body);
    expect(sizing?.problem).toContain("it is a link");
  });

  test("a skills folder that does not answer in time gives the defaults, and why", async () => {
    const stalled = () => new Promise<never>(() => undefined);
    const { skills } = await listSkills(root, 10, stalled);
    expect(skills.map((skill) => skill.name)).toEqual([...DEFAULTS.keys()]);
    for (const skill of skills) {
      expect(skill.origin).toBe("default");
      expect(skill.problem).toBe("the skills folder: it did not answer within 0.01 s");
    }
  });

  test("a list reads the first folders by name and counts the rest", async () => {
    for (let n = 0; n < SKILL_FOLDERS + 3; n += 1) {
      write(root, `own-${String(n).padStart(3, "0")}`, "A skill.\n");
    }
    const catalog = await listSkills(root);
    expect(catalog.unread).toBe(3);
    expect(catalog.skills.filter((skill) => skill.origin === "own")).toHaveLength(SKILL_FOLDERS);
    // A read by name still finds one past the cap.
    const late = `own-${String(SKILL_FOLDERS + 2).padStart(3, "0")}`;
    expect((await readSkills(root, [late])).skills[0]?.body).toBe("A skill.");
  });
});
