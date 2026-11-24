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
import {
  EFFORT_ABOUT_MAX,
  EFFORT_LEVELS,
  EFFORT_SCALE_MAX,
  registry,
  resultTokens,
  type EffortLevel,
} from "@ttasks/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DESCRIPTION_CHARS, parseSkill } from "./format.ts";
import { TTASKS_PARTS } from "./ttasks-part.ts";
import {
  DEFAULTS,
  SKILL_BYTES,
  SKILL_FOLDERS,
  isSkillName,
  listSkills,
  readSkills,
  servedText,
  skillCatalogue,
  TTASKS_LABEL,
  USER_LABEL,
  type SkillFiles,
} from "./index.ts";

const REPO_SKILLS = join(import.meta.dirname, "..", "..", "..", "..", "skills");
const SCALE = { sizes: EFFORT_LEVELS };
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
      const part = TTASKS_PARTS[skill.name]?.(SCALE, body, false).ttasks.join("\n") ?? "";
      expect(
        tools.some((tool) => new RegExp(`\\b${tool}\\b`, "u").test(part)),
        skill.name,
      ).toBe(true);
    }
  });

  test("TTasks' part comes first under its head, and the user's part follows under theirs", async () => {
    for (const skill of (await listSkills(undefined)).skills) {
      const text = servedText(skill, SCALE) ?? "";
      const part = TTASKS_PARTS[skill.name]?.(SCALE, skill.body ?? "", false);
      if (part === undefined) throw new Error(`${skill.name} has no part of TTasks'`);
      expect(text.startsWith(`${TTASKS_LABEL}\n${part.ttasks.join("\n")}\n`), skill.name).toBe(
        true,
      );
      expect(text.endsWith(`\n\n${USER_LABEL}\n\n${part.body}`), skill.name).toBe(true);
    }
    // A skill of the user's own has no TTasks part, and no heads.
    const own = {
      name: "own",
      origin: "own",
      description: "",
      body: "Mine.",
      path: "",
      problem: undefined,
    } as const;
    expect(servedText(own, SCALE)).toBe("Mine.");
  });
});

describe("[A3.3.6.mcp.skills] sizing-effort in a space", () => {
  const sizing = () => {
    const skill = DEFAULTS.get("sizing-effort");
    if (skill === undefined) throw new Error("no sizing-effort");
    return skill;
  };
  const servedLevels = (
    sizes: readonly EffortLevel[],
    body = sizing().body,
    edited = false,
  ): string =>
    servedText(
      {
        name: "sizing-effort",
        origin: edited ? "edited" : "default",
        description: "",
        body,
        path: undefined,
        problem: undefined,
      },
      { sizes },
    ) ?? "";
  const served = (keys: readonly string[], body = sizing().body, edited = false) =>
    servedLevels(
      keys.map((key) => ({ key })),
      body,
      edited,
    );
  const headings = (text: string) => [...text.matchAll(/^## (.+)$/gmu)].map((m) => m[1]);
  /** The lines that say one level each, in their order. */
  const levelLines = (text: string) =>
    text
      .slice(0, text.indexOf(USER_LABEL))
      .split("\n")
      .filter((line) => line.startsWith("- "));
  /** The sizes the TTasks part names, in its order. */
  const named = (text: string, keys: readonly string[]) =>
    keys
      .map((key) => ({ key, at: text.search(new RegExp(`(?<![A-Za-z])${key}(?![A-Za-z])`, "u")) }))
      .filter(({ at }) => at >= 0)
      .sort((a, b) => a.at - b.at)
      .map(({ key }) => key);

  test("its part names the space's own sizes, in their order", () => {
    for (const keys of [
      ["S", "M", "L"],
      ["XS", "S", "M", "L", "XL"],
      ["small", "big"],
    ]) {
      const text = served(keys);
      const part = text.slice(0, text.indexOf("# Sizing effort"));
      expect(named(part, keys)).toEqual(keys);
    }
  });

  test("[A3.3.6.mcp.skills.levels] the levels part says each level's time and line, from the space's list as it is", () => {
    expect(levelLines(servedLevels(EFFORT_LEVELS))).toEqual([
      "- XS, about 10 minutes: A quick reply, a payment or a booking, with everything at hand.",
      "- S, about 1 hour: A reply that needs some reading first; a small, clear fix; checking an agent's short change.",
      "- M, about 4 hours: One long focused sitting: a summary of a few sources; a meeting prepared with its papers.",
      "- L, about 2 days: Work over several sittings: a first draft of a report; a design for a feature; a tax return.",
      "- XL, about 1 week: A week or more: too big to plan as one piece, a signal to split it.",
    ]);
    // A level says what it has: a time, a line, either or neither; a line keeps its own stop.
    const mixed = servedLevels([
      { key: "Quick", time: { amount: 15, unit: "minutes" } },
      { key: "Day", about: "A whole day away from the desk!" },
      { key: "Odd" },
    ]);
    expect(levelLines(mixed)).toEqual([
      "- Quick, about 15 minutes",
      "- Day: A whole day away from the desk!",
      "- Odd",
    ]);
    expect(mixed).toContain("Match the work to the closest description.");
    expect(mixed).toContain("The times are reference points");
    const timed = servedLevels([{ key: "A", time: { amount: 2, unit: "hours" } }, { key: "B" }]);
    expect(timed).not.toContain("closest description");
    expect(timed).not.toContain("own examples");
    // Names only: one line of names, as a space that never said more.
    const names = served(["small", "big"]);
    expect(levelLines(names)).toEqual([]);
    expect(names).toContain("This space's sizes, smallest first: small, big.");
    // Every list, bare or with times and lines, one level or ten: send a listed name as written,
    // and these lines win over a copy that names or describes a size otherwise.
    const ten = Array.from({ length: EFFORT_SCALE_MAX }, (_, i) => ({ key: `L${String(i)}` }));
    for (const text of [
      names,
      served(["Q"]),
      mixed,
      timed,
      servedLevels(EFFORT_LEVELS),
      servedLevels(ten),
    ]) {
      expect(text).toContain(
        "Send one size's name exactly as written here, never a time. Where the text below gives a size another name, time or meaning, these lines win.",
      );
    }
  });

  test("[A3.3.6.mcp.skills.levels] ten levels with the longest lines in any script are served whole, beside a copy near its limit", () => {
    const line = "Ünïcödé 説明 ".repeat(40).slice(0, EFFORT_ABOUT_MAX).trimEnd();
    const ten = Array.from({ length: EFFORT_SCALE_MAX }, (_, i) => ({
      key: `L${String(i)}`,
      time: { amount: i + 1, unit: "days" as const },
      about: line,
    }));
    const copy = `# Their sizing\n\n${"Their rule. ".repeat(1_300)}`;
    expect(new TextEncoder().encode(copy).byteLength).toBeLessThanOrEqual(SKILL_BYTES);
    const text = servedLevels(ten, copy, true);
    expect(levelLines(text)).toEqual(
      ten.map(
        (level) =>
          `- ${level.key}, about ${String(level.time.amount)} ${level.time.amount === 1 ? "day" : "days"}: ${line}.`,
      ),
    );
    expect(text.endsWith(copy)).toBe(true);
  });

  test("the default's text holds no section per size: the levels part says them", () => {
    expect(headings(sizing().body)).toEqual([]);
    for (const keys of [
      ["XS", "S", "M", "L", "XL"],
      ["small", "big"],
    ]) {
      expect(served(keys)).toContain(sizing().body);
    }
  });

  test("the user's copy is served as written, whatever its headings, below the levels part", () => {
    const copy = "## S\n\nTheir own S.\n\n## Huge\n\nTheir own huge.";
    const text = servedLevels(EFFORT_LEVELS, copy, true);
    expect(text.endsWith(copy)).toBe(true);
    expect(levelLines(text)).toHaveLength(EFFORT_LEVELS.length);
    expect(text.indexOf("these lines win")).toBeLessThan(text.indexOf(copy));
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

  test("a stalled folder is read once however many requests wait, and each gets the defaults in time", async () => {
    let lists = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const files: SkillFiles = {
      list: async () => {
        lists += 1;
        await held;
        return new Map();
      },
      read: () => Promise.reject(new Error("no file is read while the listing stalls")),
    };
    const catalogue = skillCatalogue(files, { withinMs: 10, freshMs: 0 });
    for (let n = 0; n < 3; n += 1) {
      const { skills } = await catalogue.list(root);
      expect(skills.map((skill) => skill.name)).toEqual([...DEFAULTS.keys()]);
      for (const skill of skills) {
        expect(skill.problem).toBe("the skills folder: it did not answer within 0.01 s");
      }
      const named = await catalogue.read(root, ["sizing-effort", "own-one"]);
      expect(named.skills.map((skill) => skill.problem)).toEqual([
        "the skills folder: it did not answer within 0.01 s",
        "the skills folder: it did not answer within 0.01 s",
      ]);
    }
    expect(lists).toBe(1);
    release();
    await catalogue.list(root);
    // Once it answered, a later request reads the folder again.
    await catalogue.list(root);
    expect(lists).toBe(2);
  });

  test("a burst of requests reads the folder once", async () => {
    let lists = 0;
    const files: SkillFiles = {
      list: () => {
        lists += 1;
        return Promise.resolve(new Map());
      },
      read: () => Promise.reject(new Error("no file to read")),
    };
    const catalogue = skillCatalogue(files, { freshMs: 60_000 });
    await Promise.all([catalogue.list(root), catalogue.list(root), catalogue.read(root, ["a"])]);
    await catalogue.list(root);
    expect(lists).toBe(1);
  });

  test("a full list of folders and a loose file leaves no folder unread", async () => {
    for (let n = 0; n < SKILL_FOLDERS; n += 1) {
      write(root, `own-${String(n).padStart(3, "0")}`, "A skill.\n");
    }
    writeFileSync(join(root, "sample.md"), "A loose file.\n");
    expect((await listSkills(root)).unread).toBe(0);
  });

  test("the listing decides a name for the list and for a read by name alike", async () => {
    write(root, "Case-Test", "A rule.\n");
    writeFileSync(join(root, "sample.md"), "A loose file.\n");
    mkdirSync(join(root, "huge"));
    writeFileSync(join(root, "huge", "SKILL.md"), "z".repeat(SKILL_BYTES + 1));
    const listed = new Map((await listSkills(root)).skills.map((skill) => [skill.name, skill]));
    const named = await readSkills(root, ["case-test", "Case-Test", "sample", "huge"]);
    // A spelling the folder does not have is no skill, also where the disk ignores case.
    expect(named.missing).toEqual(["case-test"]);
    for (const skill of named.skills) {
      expect(skill.problem, skill.name).toBe(listed.get(skill.name)?.problem);
      expect(skill.problem, skill.name).toBeDefined();
      expect(skill.body, skill.name).toBeUndefined();
    }
  });

  test("a disk that fails gives a reason, and the skills come in the listing's order", async () => {
    const folder = (name: string) => ({ kind: "folder" as const, path: join(root, name) });
    const waits: Record<string, number> = { "own-a": 30, "own-b": 15, "own-c": 0 };
    const files: SkillFiles = {
      list: () =>
        Promise.resolve(new Map(["own-a", "own-b", "own-c", "own-d"].map((n) => [n, folder(n)]))),
      read: async (path) => {
        const name = /own-[a-d]/u.exec(path)?.[0] ?? "";
        if (name === "own-d") throw Object.assign(new Error("gone"), { code: "EIO" });
        await new Promise((done) => setTimeout(done, waits[name]));
        return { path, ok: true, description: undefined, body: name };
      },
    };
    const catalogue = skillCatalogue(files, { freshMs: 60_000 });
    for (let n = 0; n < 2; n += 1) {
      const own = (await catalogue.list(root)).skills.filter((skill) => skill.origin === "own");
      expect(own.map((skill) => skill.name)).toEqual(["own-a", "own-b", "own-c", "own-d"]);
      expect(own.map((skill) => skill.problem)).toEqual([
        undefined,
        undefined,
        undefined,
        "it cannot be read (EIO)",
      ]);
    }
    const failing = skillCatalogue(
      { ...files, list: () => Promise.reject(Object.assign(new Error("gone"), { code: "EIO" })) },
      { freshMs: 60_000 },
    );
    const defaults = (await failing.list(root)).skills;
    expect(defaults.map((skill) => skill.name)).toEqual([...DEFAULTS.keys()]);
    expect(defaults[0]?.problem).toBe("the skills folder: it cannot be read (EIO)");
  });

  test("a list reads the first folders by name and counts the rest", async () => {
    for (let n = 0; n < SKILL_FOLDERS + 3; n += 1) {
      write(root, `own-${String(n).padStart(3, "0")}`, "A skill.\n");
    }
    // Past the first folders by name: a default's folder and a loose file are still listed.
    write(root, "sizing-effort", "The user's sizing.\n");
    writeFileSync(join(root, "zz-loose.md"), "A loose file.\n");
    const catalog = await listSkills(root);
    expect(catalog.unread).toBe(3);
    const own = catalog.skills.filter((skill) => skill.origin === "own");
    expect(own).toHaveLength(SKILL_FOLDERS + 1);
    expect(own.at(-1)?.problem).toContain("a skill is a folder");
    const listed = catalog.skills.find((skill) => skill.name === "sizing-effort");
    const named = (await readSkills(root, ["sizing-effort"])).skills[0];
    expect(listed?.origin).toBe("edited");
    expect(listed?.body).toBe(named?.body);
    // A read by name still finds one past the cap.
    const late = `own-${String(SKILL_FOLDERS + 2).padStart(3, "0")}`;
    expect((await readSkills(root, [late])).skills[0]?.body).toBe("A skill.");
  });
});
