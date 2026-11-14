// The runtime gate (A2 3.12.1, A7 row R01 promoted): the Node that runs these tests is the pinned
// official 26.13.1 that pnpm downloaded, so the gate passes on it with the pins, and fails when a
// pin, the launcher flag or a SQLite capability is wrong. The build runs the same gate inside each
// version folder through its launcher (scripts/build/gate.ts).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDriver, type SqliteDriver } from "@tasks/storage";
import { GATE_CHECKS, runtimeGate, type GateFacts } from "./runtime-gate.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const pin = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "build", "node-pin.json"), "utf8"),
) as {
  version: string;
  sqlite: string;
};
const expectPins = { node: pin.version, sqlite: pin.sqlite };

/** This process, as if a launcher had started it. */
const launched: GateFacts = {
  nodeVersion: process.version,
  sqliteVersion: process.versions.sqlite,
  execArgv: ["--report-exclude-env"],
  reportExcludesEnv: () => true,
};

const failed = (checks: { check: string; ok: boolean }[]) =>
  checks.filter((c) => !c.ok).map((c) => c.check);

describe("[A2.3.12.1.build.runtime-gate] the runtime gate", () => {
  test("passes on the pinned Node 26.13.1 with SQLite 3.54.1, every check named", async () => {
    expect(process.version).toBe(`v${pin.version}`);
    const checks = await runtimeGate(expectPins, launched);
    expect(checks.map((c) => c.check)).toEqual([...GATE_CHECKS]);
    expect(failed(checks)).toEqual([]);
    expect(checks.find((c) => c.check === "sqlite-capabilities")?.detail).toBe(
      "SQLite 3.54.1 with FTS5, JSON, STRICT tables and the backup API.",
    );
  });

  test("fails on another Node or SQLite than the pins", async () => {
    const checks = await runtimeGate({ node: "26.0.0", sqlite: "3.0.0" }, launched);
    expect(failed(checks)).toEqual(["node-version", "sqlite-version", "sqlite-capabilities"]);
    for (const check of checks.filter((c) => !c.ok)) expect(check.detail).toMatch(/pins/);
  });

  test("fails without the launcher's flag, or when reports keep the environment", async () => {
    const bare = await runtimeGate(expectPins, { ...launched, execArgv: [] });
    expect(failed(bare)).toEqual(["launcher-flags"]);
    const leaky = await runtimeGate(expectPins, { ...launched, reportExcludesEnv: () => false });
    expect(failed(leaky)).toEqual(["launcher-flags"]);
  });

  test("fails when the driver's SQLite lacks FTS5, with storage's own words", async () => {
    const real = await loadDriver("node:sqlite");
    // A driver whose SQLite refuses every FTS5 statement, as a build without FTS5 would. The
    // connection keeps private fields, so it is wrapped, not copied.
    const refuse = (sql: string) => {
      if (/fts5|fts_probe|ENABLE_FTS5/i.test(sql)) throw new Error("no such module: fts5");
    };
    const noFts: SqliteDriver = {
      name: real.name,
      backup: (src, dest, options) => real.backup(src, dest, options),
      open: (path, options) => {
        const conn = real.open(path, options);
        return new Proxy(conn, {
          get(target, prop) {
            if (prop === "exec") {
              return (sql: string) => {
                refuse(sql);
                target.exec(sql);
              };
            }
            if (prop === "prepare") {
              return (sql: string) => {
                refuse(sql);
                return target.prepare(sql);
              };
            }
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === "function" ? (value as () => unknown).bind(target) : value;
          },
        });
      },
    };
    const checks = await runtimeGate(expectPins, launched, () => Promise.resolve(noFts));
    expect(failed(checks)).toEqual(["sqlite-capabilities"]);
    expect(checks.find((c) => c.check === "sqlite-capabilities")?.detail).toMatch(/FTS5/);
  });

  test("reads the real process: a child started with and without --report-exclude-env", () => {
    const script = [
      `import { runtimeGate } from ${JSON.stringify(new URL("./runtime-gate.ts", import.meta.url).href)};`,
      `const checks = await runtimeGate(${JSON.stringify(expectPins)});`,
      "process.stdout.write(JSON.stringify(checks.filter((c) => !c.ok).map((c) => c.check)));",
    ].join("\n");
    const run = (flags: string[]) => {
      const result = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as string[];
    };
    expect(run(["--report-exclude-env"])).toEqual([]);
    expect(run([])).toEqual(["launcher-flags"]);
  }, 60_000);
});
