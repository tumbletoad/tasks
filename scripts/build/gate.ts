// The build's runtime gate: inside the version folder it made, through
// the version's own launcher, as install and update run a candidate. The folder is laid
// out as a test install in the work folder, so the launcher sets TTASKS_HOME to that root and
// nothing outside it is read or written. Then
//   - `ttasks doctor --self-test --json`: its `integrity` row (every file matches manifest.json), its
//     `runtime` row (Node and SQLite as pinned, FTS5, JSON, STRICT, the backup API, the launcher
//     flags) and the candidate's rows (a temporary space, endpoint and bridge) must pass.
//     The rows about a service are not asked: none runs here.
//   - `ttasks version` names the build's version and build.
//   - the entry turned on the compile cache in `<root>/cache/compile/`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { hostFacts, resolveLayout } from "../../packages/service/src/hub/paths.ts";
import { testEnv } from "../../packages/testkit/src/env.ts";
import { layoutTestInstall } from "../../packages/testkit/src/install.ts";

export interface GateRow {
  readonly id: string;
  readonly status: string;
  readonly detail: string;
}

export interface GateRun {
  readonly ok: boolean;
  readonly rows: readonly GateRow[];
  readonly problems: readonly string[];
}

/**
 * The rows of `ttasks doctor` that the build's gate requires: the files and the runtime, and the
 * candidate's own checks that `ttasks install --finish` runs before it switches current,
 * so a build never ships a folder its own install would refuse.
 */
export const GATE_ROWS = [
  "integrity",
  "runtime",
  "candidate-space",
  "candidate-endpoint",
  "candidate-bridge",
] as const;

export function runBuiltGate(
  versionFolder: string,
  work: string,
  expect: { readonly version: string; readonly build: string },
): GateRun {
  const root = join(work, "gate");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const install = layoutTestInstall(versionFolder, root);
  const problems: string[] = [];
  const run = (args: readonly string[]) =>
    spawnSync(install.versionLauncher, args, {
      cwd: root,
      env: testEnv(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    });

  const doctor = run(["doctor", "--self-test", "--json"]);
  let rows: GateRow[] = [];
  try {
    rows = (JSON.parse(doctor.stdout) as { checks: GateRow[] }).checks;
  } catch {
    problems.push(
      `doctor printed no report (exit ${String(doctor.status)}): ${doctor.stderr.trim() || String(doctor.error ?? "")}`,
    );
  }
  for (const id of GATE_ROWS) {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) problems.push(`doctor has no ${id} row`);
    else if (row.status !== "ok") problems.push(`${id}: ${row.detail}`);
  }

  const version = run(["version"]);
  const expected = `${PRODUCT_NAME} ${expect.version} (${expect.build})\n`;
  if (version.status !== 0 || version.stdout.replaceAll("\r\n", "\n") !== expected) {
    problems.push(
      `ttasks version printed ${JSON.stringify(version.stdout)}, expected ${JSON.stringify(expected)}`,
    );
  }

  // The test install's cache folder by the layout: `<root>/cache` of a TTASKS_HOME root.
  const cache = join(resolveLayout(hostFacts({ TTASKS_HOME: root })).cache, "compile");
  if (!existsSync(cache) || readdirSync(cache).length === 0) {
    problems.push("the entry did not turn on the compile cache in <root>/cache/compile");
  }
  if (problems.length === 0)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return {
    ok: problems.length === 0,
    rows: rows.filter((r) => (GATE_ROWS as readonly string[]).includes(r.id)),
    problems,
  };
}
