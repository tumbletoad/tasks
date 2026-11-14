// `tasks doctor`'s rows about the version folder it runs from (A2 3.13): integrity against
// manifest.json, and the runtime gate of A2 3.12.1 against the manifest's pins. From source both
// are skipped. Fixture files in a temporary folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GateFacts } from "@tasks/service/runtime-gate";
import { writeVersionManifest } from "@tasks/service/version-folder";
import { versionChecks } from "../src/doctor.ts";
import type { Io } from "../src/io.ts";
import { runMain } from "./cli-harness.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-doctor-version-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const io = { platform: process.platform } as Io;

const launched: GateFacts = {
  nodeVersion: process.version,
  sqliteVersion: process.versions.sqlite,
  execArgv: ["--report-exclude-env"],
  reportExcludesEnv: () => true,
};

let count = 0;
function versionFolder(): string {
  count += 1;
  const root = join(work, `install-${String(count)}`);
  const folder = join(root, "versions", "0.1.0");
  mkdirSync(join(folder, "lib"), { recursive: true });
  writeFileSync(join(folder, "lib", "tasks.mjs"), "// fixture entry\n");
  writeFileSync(join(folder, "LICENSE"), "fixture\n");
  writeVersionManifest(folder, {
    version: "0.1.0",
    build: "fixture0doc1",
    platform: "linux-x64",
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? "",
    protocol: { min: 1, max: 1 },
  });
  writeFileSync(join(root, "current"), "0.1.0");
  return folder;
}

const row = (checks: { id: string; status: string; detail: string }[], id: string) =>
  checks.find((c) => c.id === id);

describe("[A2.3.13.cli.doctor-version] doctor checks the version folder it runs from", () => {
  test("from source there is no version folder: both rows are skipped", async () => {
    const checks = await versionChecks(io, undefined);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["integrity", "skip"],
      ["runtime", "skip"],
    ]);
  });

  test("an intact folder on its pinned runtime passes both rows", async () => {
    const checks = await versionChecks(io, versionFolder(), launched);
    expect(row(checks, "integrity")).toMatchObject({ status: "ok" });
    expect(row(checks, "integrity")?.detail).toContain("0.1.0 (fixture0doc1, linux-x64)");
    expect(row(checks, "runtime")).toMatchObject({ status: "ok" });
    expect(row(checks, "runtime")?.detail).toContain("FTS5");
  });

  test("a changed or extra file, a bad current, a missing manifest and a bare Node fail", async () => {
    const folder = versionFolder();
    writeFileSync(join(folder, "lib", "tasks.mjs"), "// changed\n");
    writeFileSync(join(folder, "lib", "extra.mjs"), "");
    writeFileSync(join(folder, "..", "..", "current"), "0.9.9");
    const changed = await versionChecks(io, folder, launched);
    expect(row(changed, "integrity")?.status).toBe("fail");
    expect(row(changed, "integrity")?.detail).toBe(
      "changed: lib/tasks.mjs; not in manifest.json: lib/extra.mjs; current names 0.9.9, which is not installed.",
    );
    const bare = await versionChecks(io, versionFolder(), { ...launched, execArgv: [] });
    expect(row(bare, "runtime")?.status).toBe("fail");
    expect(row(bare, "runtime")?.detail).toMatch(/--report-exclude-env/);
    const none = await versionChecks(io, join(work, "no-folder"), launched);
    expect(none.map((c) => c.status)).toEqual(["fail", "fail"]);
  });

  test("main passes the version folder to doctor", async () => {
    const folder = versionFolder();
    const ran = await runMain(["doctor", "--json"], {
      home: join(work, "home"),
      main: { versionFolder: folder },
    });
    const report = JSON.parse(ran.stdout) as { checks: { id: string; status: string }[] };
    expect(report.checks.find((c) => c.id === "integrity")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "runtime")).toBeDefined();
  });
});
