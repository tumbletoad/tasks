// packages/service/generated/skills.json: the repository's default skills, `skills/<name>/SKILL.md`,
// compiled in as the tool list is. A bundle cannot read a file beside it, so the service reads
// this module instead of the folder.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./run.ts";

export const SKILLS_SOURCE = "skills";
export const SKILLS_GENERATED = "packages/service/generated";

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
      const skills = await Promise.all(
        names.map(async (name) => ({
          name,
          file: (await readFile(join(source, name, "SKILL.md"), "utf8")).replaceAll("\r\n", "\n"),
        })),
      );
      return new Map([["skills.json", `${JSON.stringify({ skills }, null, 2)}\n`]]);
    },
  };
}
