// pnpm seed --planning (A7 3.14 M7.01): writes the synthetic Planning prototype, fixture data only.
//
//   pnpm seed --planning [--out <folder>]
//
// Writes <folder>/planning-prototype/ and the index beside it, <folder>/planning-prototype.index.json.
// Without --out the folder is the repository's fixtures/, and the committed fixture is replaced by a
// fresh copy. With --out neither may exist yet. The output is the same on every machine, byte for
// byte: the script prints its digest, and tests compare the files with the committed fixture.
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildPlanningFixture,
  digestPlanningFixture,
  PLANNING,
  serializeIndex,
} from "../packages/testkit/src/planning.ts";
import { repoRoot } from "./run.ts";

const USAGE = "Usage: pnpm seed --planning [--out <folder>]";

/** Whether a directory entry exists at `path`, a link that points nowhere included. */
function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** `root` stands for the repository root: tests pass a temporary folder to exercise the replace path. */
export function seedPlanning(argv: string[], root: string = repoRoot): number {
  let values: { planning?: boolean | undefined; out?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { planning: { type: "boolean" }, out: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (values.planning !== true || values.out === "") {
    console.error(USAGE);
    return 2;
  }
  const replace = values.out === undefined;
  const target =
    values.out === undefined
      ? join(root, "fixtures")
      : isAbsolute(values.out)
        ? values.out
        : resolve(values.out);
  const folder = join(target, PLANNING.folder);
  const indexFile = join(target, PLANNING.index);
  if (replace) {
    // Only the generated folder and the index, by their full names. Removing the index first
    // unlinks it, so a write never goes through a link to a file outside the target.
    rmSync(folder, { recursive: true, force: true });
    rmSync(indexFile, { force: true });
  } else if (present(folder) || present(indexFile)) {
    console.error("pnpm seed --planning: the fixture already exists in that folder");
    return 1;
  }
  const fixture = buildPlanningFixture();
  for (const [path, text] of fixture.files) {
    const file = join(folder, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  }
  writeFileSync(indexFile, serializeIndex(fixture.index), { encoding: "utf8", flag: "wx" });
  console.log(`Planning prototype fixture: ${folder}`);
  console.log(
    `files: ${String(fixture.files.size)}, task lines: ${String(fixture.index.counts.taskLines)}`,
  );
  console.log(`digest: ${digestPlanningFixture(fixture)}`);
  return 0;
}
