import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repositoryFiles } from "./machine-facts.ts";
import { repoRoot } from "./run.ts";

// The product's names before it was renamed, in the forms that can only mean the product. The
// word itself stays: it is also the domain's plural, and the stored format markers keep it.
const OLD = "tasks";
const OLD_NAMES: readonly RegExp[] = [
  new RegExp(`\\bTT ${OLD[0]?.toUpperCase() ?? ""}${OLD.slice(1)}\\b`),
  new RegExp(`(?<![\\w.-])@${OLD}/`),
  new RegExp(`(?<![A-Za-z0-9])${OLD.toUpperCase()}_`),
  // The data folder and the marker; a property on a continued line (`  .tasks`) is not one.
  new RegExp(`(?:[~%\\\\/"'\`]|\\S )\\.${OLD}\\b`),
  new RegExp(`\\b${OLD}(?:w|-run)?\\.exe\\b`, "i"),
  new RegExp(`\\b${OLD}w\\b`),
  new RegExp(`\\blocal\\.${OLD}\\.`),
  new RegExp(`\\bmcp__${OLD}__|\\bmcp(?:_s|S)ervers\\.${OLD}\\b`),
];

/** The one declaration that names the earlier data folder, so install can say where it is. */
const EARLIER = /^export const EARLIER_DATA_FOLDER = /;

/** This file, which spells the old forms to test that each is found. */
const SELF = "scripts/old-names.test.ts";

function oldNames(file: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, i) =>
      !EARLIER.test(line) && OLD_NAMES.some((re) => re.test(line))
        ? [`${file}:${String(i + 1)}: ${line.trim()}`]
        : [],
    );
}

describe("[A7.3.2.brand.old-names] the product's earlier names do not come back", () => {
  test("no file in the repository uses one", () => {
    const found = repositoryFiles(repoRoot).flatMap((file) => {
      if (file === SELF) return [];
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(repoRoot, file));
      } catch {
        return []; // listed in the index but deleted in the working tree
      }
      return bytes.includes(0) ? [] : oldNames(file, bytes.toString("utf8"));
    });
    expect(found).toEqual([]);
  });

  test("finds each form, and lets the new names and the domain's plural pass", () => {
    const old = [
      "TT Tasks",
      "@tasks/brand",
      "TASKS_HOME",
      "~/.tasks/spaces",
      "a .tasks-marker folder",
      "bin\\tasksw.exe",
      "TASKS.EXE",
      "local.tasks.service",
      "mcp__tasks__status",
      "mcpServers.tasks",
    ];
    for (const line of old) expect(oldNames("x", line), line).toHaveLength(1);
    const current = [
      "TTasks",
      "@ttasks/brand",
      "TTASKS_HOME",
      "~/.ttasks/spaces",
      "ttasksw.exe",
      "local.ttasks.service",
      "mcp__ttasks__status",
      "state.tasks.map(render)",
      "HAS_ACTIVE_TASKS",
      'export const EARLIER_DATA_FOLDER = ".tasks";',
    ];
    for (const line of current) expect(oldNames("x", line), line).toEqual([]);
  });
});
