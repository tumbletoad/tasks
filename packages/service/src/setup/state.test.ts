// Setup's two record files have one reader: state.ts. Every other source file reads a home's records
// through setupRecords, which reads both; one that named a record file could read one by itself,
// which is how a caller kept forgetting the other.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const PACKAGES = join(import.meta.dirname, "..", "..", "..");
const READER = join(import.meta.dirname, "state.ts");
/** A record file's name as code would spell it to open it. */
const NAMED = /["'`](?:[^"'`]*[\\/])?agents(?:-further)?\.json["'`]/u;

/** Source text without its comments, which may name the files for a reader. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");

/** Whether source text names a record file in its code. */
const names = (text: string): boolean => NAMED.test(code(text));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe("[A3.3.13.setup.one-reader] Setup's record files are read in one place, both at once", () => {
  test("no product source but state.ts names a record file", () => {
    const named = readdirSync(PACKAGES, { withFileTypes: true })
      .filter((p) => p.isDirectory())
      .flatMap((p) => {
        try {
          return sources(join(PACKAGES, p.name, "src"));
        } catch {
          return [];
        }
      })
      .filter((file) => file !== READER && names(readFileSync(file, "utf8")))
      .map((file) => relative(PACKAGES, file));
    expect(named).toEqual([]);
  });

  test("the guard sees a name as code would spell it, and not as a comment mentions it", () => {
    expect(names('join(dir, "agents-further.json")')).toBe(true);
    expect(names("const at = `${dir}/agents.json`;")).toBe(true);
    expect(names("// `agents.json` keeps one record per home")).toBe(false);
    expect(names("/** The records in `agents-further.json`. */")).toBe(false);
  });
});
