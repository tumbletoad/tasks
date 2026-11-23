// packages/service/generated/skills.json: the repository's default skills, `skills/<name>/SKILL.md`,
// compiled in as the tool list is. A bundle cannot read a file beside it, so the service reads
// this module instead of the folder.
//
// Each default keeps every version it shipped with, oldest first, so a person's copy made from an
// older one can be shown what changed since. The history lives only here, so the render reads the
// file it renders: a changed SKILL.md adds a version, and an unchanged one renders the file as it is.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./run.ts";

export const SKILLS_SOURCE = "skills";
export const SKILLS_GENERATED = "packages/service/generated";
const FILE = "skills.json";

interface Version {
  readonly id: string;
  readonly file: string;
}

/** A version's ID: the start of the SHA-256 of its text. */
export const versionId = (file: string): string =>
  createHash("sha256").update(file).digest("hex").slice(0, 12);

/** The versions the generated file holds, by skill. A file from before versions holds one. */
async function shippedVersions(root: string): Promise<Map<string, Version[]>> {
  let text: string;
  try {
    text = await readFile(join(root, SKILLS_GENERATED, FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const parsed = JSON.parse(text) as {
    skills: { name: string; file?: string; versions?: Version[] }[];
  };
  return new Map(
    parsed.skills.map((skill) => [
      skill.name,
      skill.versions ??
        (skill.file === undefined ? [] : [{ id: versionId(skill.file), file: skill.file }]),
    ]),
  );
}

/** The generator scripts/generated.ts registers (its `Generator` shape, without importing it). */
export function skillsGenerator(root: string = repoRoot): {
  readonly name: string;
  readonly dir: string;
  render(): Promise<ReadonlyMap<string, string>>;
} {
  return {
    name: "default skills",
    dir: SKILLS_GENERATED,
    render: async () => {
      const source = join(root, SKILLS_SOURCE);
      const names = (await readdir(source, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const shipped = await shippedVersions(root);
      const skills = await Promise.all(
        names.map(async (name) => {
          const file = (await readFile(join(source, name, "SKILL.md"), "utf8")).replaceAll(
            "\r\n",
            "\n",
          );
          const versions = shipped.get(name) ?? [];
          const id = versionId(file);
          return {
            name,
            versions: versions.at(-1)?.id === id ? versions : [...versions, { id, file }],
          };
        }),
      );
      return new Map([[FILE, `${JSON.stringify({ skills }, null, 2)}\n`]]);
    },
  };
}
