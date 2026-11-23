// The skills an agent can read: TTasks' defaults (the repository's `skills/`, compiled into
// generated/skills.json by `pnpm gen`) and the person's own files in `<TTasks home>/skills/`.
// The person's files are read at every request, so an edit reaches every agent app at once.
//
// A person's `skills/<name>/SKILL.md` replaces a default's text whole, or is a skill of their own
// when no default has its name. A file that cannot be used is never served in part: a default
// falls back to its own text, and either way the reason travels with the skill.
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import shipped from "../../generated/skills.json" with { type: "json" };
import { isSkillName, kib, parseSkill, SKILL_BYTES, SKILL_FILE } from "./format.ts";
import { TTASKS_PARTS, type SpaceFacts } from "./ttasks-part.ts";

export { isSkillName, SKILL_BYTES, SKILL_FILE } from "./format.ts";
export type { SpaceFacts } from "./ttasks-part.ts";

/** A default as it ships: its whole file, which `copy` writes for a person to start from. */
interface Default {
  readonly name: string;
  readonly file: string;
  readonly description: string;
  readonly body: string;
}

/** The defaults, in the generated file's order (by name). A broken one fails at load. */
export const DEFAULTS: ReadonlyMap<string, Default> = new Map(
  shipped.skills.map(({ name, file }) => {
    const parsed = parseSkill(new TextEncoder().encode(file));
    if (!parsed.ok || parsed.description === undefined || TTASKS_PARTS[name] === undefined) {
      throw new Error(`the default skill ${name} is not a skill this build can serve`);
    }
    return [name, { name, file, description: parsed.description, body: parsed.body }];
  }),
);

/**
 * One skill as an agent may read it. `default`: TTasks' text; `edited`: the person's copy of a
 * default; `own`: a skill of the person's that no default has.
 */
export interface Skill {
  readonly name: string;
  readonly origin: "default" | "edited" | "own";
  /** When to read it: the person's file's, else the default's. Empty when neither says. */
  readonly description: string;
  /** The person's part as served; undefined for a skill of the person's that cannot be used. */
  readonly body: string | undefined;
  /** The person's file or folder for this name, when there is one. */
  readonly path: string | undefined;
  /** Why the person's file is not used, when it is not. */
  readonly problem: string | undefined;
}

type Found = { readonly path: string } & (
  | { readonly ok: true; readonly description: string | undefined; readonly body: string }
  | { readonly ok: false; readonly problem: string }
);

const codeOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? "an error";

/** A person's skill file: what it says, or why it cannot be used. */
async function readOne(path: string): Promise<Found> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = codeOf(error);
    return {
      path,
      ok: false,
      problem:
        code === "ENOENT" ? `its folder has no ${SKILL_FILE}` : `it cannot be read (${code})`,
    };
  }
  try {
    const { size } = await handle.stat();
    if (size > SKILL_BYTES) {
      return {
        path,
        ok: false,
        problem: `it is ${kib(size)}, over the limit of ${kib(SKILL_BYTES)}`,
      };
    }
    return { path, ...parseSkill(await handle.readFile()) };
  } catch (error) {
    return { path, ok: false, problem: `it cannot be read (${codeOf(error)})` };
  } finally {
    await handle.close();
  }
}

/** What the person's skills folder holds, by skill name, or why the folder cannot be read. */
async function readFolder(folder: string): Promise<Map<string, Found> | string> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    const code = codeOf(error);
    return code === "ENOENT" || code === "ENOTDIR" ? new Map() : `it cannot be read (${code})`;
  }
  const visible = entries.filter((entry) => !entry.name.startsWith("."));
  const found = new Map<string, Found>();
  await Promise.all(
    visible.map(async (entry) => {
      if (entry.isFile()) return;
      const path = join(folder, entry.name);
      found.set(
        entry.name,
        isSkillName(entry.name)
          ? await readOne(join(path, SKILL_FILE))
          : {
              path,
              ok: false,
              problem:
                "its folder's name is no skill name: use lower case letters, digits and hyphens",
            },
      );
    }),
  );
  // A skill written as one file beside the folders, the way some apps keep them.
  for (const entry of visible) {
    const stem = entry.isFile() ? /^(.+)\.md$/iu.exec(entry.name)?.[1] : undefined;
    if (stem === undefined || found.has(stem)) continue;
    found.set(stem, {
      path: join(folder, entry.name),
      ok: false,
      problem: `a skill is a folder: move it to ${join(folder, stem, SKILL_FILE)}`,
    });
  }
  return found;
}

/**
 * Every skill, read now: the defaults in their order, then the person's own by name. `folder` is
 * the person's skills folder; none serves the defaults alone.
 */
export async function listSkills(folder: string | undefined): Promise<Skill[]> {
  const read = folder === undefined ? new Map<string, Found>() : await readFolder(folder);
  const files = typeof read === "string" ? new Map<string, Found>() : read;
  const skills: Skill[] = [...DEFAULTS.values()].map((skill): Skill => {
    const file = files.get(skill.name);
    if (file?.ok === true) {
      return {
        name: skill.name,
        origin: "edited",
        description: file.description ?? skill.description,
        body: file.body,
        path: file.path,
        problem: undefined,
      };
    }
    return {
      name: skill.name,
      origin: "default",
      description: skill.description,
      body: skill.body,
      path: typeof read === "string" ? folder : file?.path,
      problem: typeof read === "string" ? `the skills folder: ${read}` : file?.problem,
    };
  });
  const own = [...files.entries()]
    .filter(([name]) => !DEFAULTS.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, file] of own) {
    skills.push({
      name,
      origin: "own",
      description: file.ok ? (file.description ?? "") : "",
      body: file.ok ? file.body : undefined,
      path: file.path,
      problem: file.ok ? undefined : file.problem,
    });
  }
  return skills;
}

/**
 * The text an agent is handed: TTasks' part of a default, then the person's part. Undefined for a
 * skill of the person's that cannot be used.
 */
export function servedText(skill: Skill, space: SpaceFacts): string | undefined {
  if (skill.body === undefined) return undefined;
  const ttasks = skill.origin === "own" ? [] : (TTASKS_PARTS[skill.name]?.(space) ?? []);
  return [ttasks.join("\n"), skill.body].filter((part) => part !== "").join("\n\n");
}
