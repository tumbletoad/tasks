import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GateRun } from "../src/checks.ts";
import { loadPin } from "../src/node-runtime.ts";
import { appDir } from "../src/paths.ts";
import { removeDir, tempDir } from "./fixture.ts";

// The gate script itself, run by the Node that runs the tests: the same official 26.13.1 binary
// the packaging build downloads. The packaged run (through a launcher) is in release.test.ts and
// in the m0-packaging workflow.
const pin = loadPin();
let scratch: string;

beforeAll(() => {
  scratch = tempDir("gate");
});
afterAll(() => {
  removeDir(scratch);
});

function gate(
  nodeArgs: string[],
  gateArgs: string[] = [],
): { status: number | null; run: GateRun } {
  const result = spawnSync(
    process.execPath,
    [
      ...nodeArgs,
      join(appDir, "ttasks.mjs"),
      "gate",
      "--scratch",
      scratch,
      "--expect-node",
      pin.version,
      "--expect-sqlite",
      pin.sqlite,
      "--json",
      ...gateArgs,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return { status: result.status, run: JSON.parse(result.stdout) as GateRun };
}

const failed = (run: GateRun) => run.results.filter((r) => !r.ok).map((r) => r.check);

describe("[A2.3.12.1.spike.runtime-gate] the runtime gate of A2 3.12.1 and lab row R01", () => {
  test("every check passes on the pinned Node 26.13.1 with SQLite 3.54.1", () => {
    const { status, run } = gate(["--report-exclude-env"]);
    expect(failed(run)).toEqual([]);
    expect(status).toBe(0);
    expect(run.results.map((r) => r.check)).toEqual([
      "node-version",
      "sqlite-version",
      "fts5-compiled",
      "fts5-match",
      "strict-table",
      "json-functions",
      "backup-api",
      "report-exclude-env",
    ]);
    expect(run.results.find((r) => r.check === "sqlite-version")?.detail).toBe("3.54.1");
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("the gate fails without --report-exclude-env", () => {
    const { status, run } = gate([]);
    expect(failed(run)).toEqual(["report-exclude-env"]);
    expect(status).toBe(1);
  });

  test("the gate fails when the runtime is not the pinned Node and SQLite", () => {
    // Later options win, so these replace the pinned expectations.
    const { status, run } = gate(
      ["--report-exclude-env"],
      ["--expect-node", "26.0.0", "--expect-sqlite", "3.0.0"],
    );
    expect(failed(run)).toEqual(["node-version", "sqlite-version"]);
    expect(status).toBe(1);
  });
});
