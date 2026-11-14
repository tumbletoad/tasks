// root_rev (A4 3.2, A6 3.8.3): a counter per root in machine state that rises whenever the root's
// mapping changes, and never otherwise. Fixture roots in a temporary state folder.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Root } from "@tasks/launch";
import { afterEach, describe, expect, test } from "vitest";
import { ROOTS_FILE, syncRootRevisions } from "./root-revs.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const root = (id: string, path: string): Root => ({ id, label: id, path, runs: false });

describe("[A4.3.2.root-rev] each root's revision in machine state", () => {
  test("starts at 1, rises when the path changes, keeps across removal, and ignores labels and runs", () => {
    const state = mkdtempSync(join(tmpdir(), "tasks-roots-"));
    temps.push(state);
    const revs = (roots: Root[]) => Object.fromEntries(syncRootRevisions(state, roots).revs);

    expect(revs([root("work", "/home/mira/work"), root("oss", "/home/mira/oss")])).toEqual({
      work: 1,
      oss: 1,
    });
    // Nothing changed: nothing written, nothing raised. A label or `runs` is not the mapping.
    const before = readFileSync(join(state, ROOTS_FILE), "utf8");
    const same = syncRootRevisions(state, [
      { ...root("work", "/home/mira/work"), label: "Work", runs: true },
      root("oss", "/home/mira/oss"),
    ]);
    expect(same.changed).toBe(0);
    expect(readFileSync(join(state, ROOTS_FILE), "utf8")).toBe(before);

    expect(revs([root("work", "/home/mira/work2"), root("oss", "/home/mira/oss")])).toEqual({
      work: 2,
      oss: 1,
    });
    // Removed, then added again elsewhere: it continues, so no revision is handed out twice.
    expect(revs([root("oss", "/home/mira/oss")])).toEqual({ oss: 1 });
    expect(revs([root("work", "/home/mira/work"), root("oss", "/home/mira/oss")])).toEqual({
      work: 3,
      oss: 1,
    });
    // The file holds hashes of the mappings, never a path.
    expect(readFileSync(join(state, ROOTS_FILE), "utf8")).not.toContain("/home/mira");

    // A damaged file starts again, and says so.
    writeFileSync(join(state, ROOTS_FILE), "{not json");
    const reset = syncRootRevisions(state, [root("work", "/home/mira/work")]);
    expect(reset.reset).toBe(true);
    expect(Object.fromEntries(reset.revs)).toEqual({ work: 1 });
  });
});
