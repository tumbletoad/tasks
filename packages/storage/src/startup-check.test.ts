import { describe, expect, test } from "vitest";
import { capabilityProblems, versionAtLeast, type Capabilities } from "./startup-check.ts";

const good: Capabilities = {
  sqliteVersion: "3.54.1",
  compileOptions: ["ENABLE_FTS5"],
  fts5Compiled: true,
  fts5Works: true,
  json: true,
  strict: true,
  backup: true,
};

describe("[A1.5.driver.startup-check] the start-up check's verdict on probe results", () => {
  test("a build with every capability passes", () => {
    expect(capabilityProblems(good)).toEqual([]);
    // The fallback's SQLite (better-sqlite3 13.0.3, A1 3.19) passes too.
    expect(capabilityProblems({ ...good, sqliteVersion: "3.53.4" })).toEqual([]);
  });

  test("the minimum version is 3.45.0, compared as numbers", () => {
    expect(versionAtLeast("3.45.0", "3.45.0")).toBe(true);
    expect(versionAtLeast("3.100.0", "3.45.0")).toBe(true);
    expect(versionAtLeast("4.0.0", "3.45.0")).toBe(true);
    expect(versionAtLeast("3.44.9", "3.45.0")).toBe(false);
    expect(versionAtLeast("3.9.0", "3.45.0")).toBe(false);
    expect(versionAtLeast("unknown", "3.45.0")).toBe(false);
  });

  test("a build without FTS5 is refused with both FTS5 findings", () => {
    expect(capabilityProblems({ ...good, fts5Compiled: false, fts5Works: false })).toEqual([
      "FTS5 is not compiled in (ENABLE_FTS5)",
      "an FTS5 table cannot be created and matched",
    ]);
  });

  test("each missing capability is named", () => {
    const missing: [Partial<Capabilities>, string][] = [
      [{ sqliteVersion: "3.44.2" }, "SQLite 3.44.2 is older than 3.45.0"],
      [{ sqliteVersion: "unknown" }, "SQLite unknown is older than 3.45.0"],
      [{ fts5Works: false }, "an FTS5 table cannot be created and matched"],
      [{ json: false }, "the JSON functions are missing"],
      [{ strict: false }, "a STRICT table does not reject a value of the wrong type"],
      [{ backup: false }, "the online backup API does not work"],
    ];
    for (const [change, problem] of missing) {
      expect(capabilityProblems({ ...good, ...change })).toEqual([problem]);
    }
  });
});
