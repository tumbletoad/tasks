import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./run.ts";

// A lint rule that ends the ESLint thread it runs on when it reaches a file named dies.js, before
// that thread reports what it found. In the main thread it does nothing.
const config = (debuggerLevel: string, dies: boolean) => `
import { isMainThread } from "node:worker_threads";
const die = {
  create(context) {
    if (${String(dies)} && !isMainThread && context.filename.endsWith("dies.js")) process.exit(13);
    return {};
  },
};
export default [
  {
    files: ["**/*.js"],
    plugins: { t: { rules: { die } } },
    rules: { "no-debugger": "${debuggerLevel}", "t/die": "error" },
  },
];
`;

async function lint(debuggerLevel: string, dies: boolean, violation = true) {
  const dir = await mkdtemp(join(tmpdir(), "ttasks-lint-"));
  try {
    await writeFile(join(dir, "eslint.config.mjs"), config(debuggerLevel, dies));
    await writeFile(join(dir, "dies.js"), violation ? "debugger;\n" : "export {};\n");
    for (const name of ["a", "b", "c", "d", "e"]) {
      await writeFile(join(dir, `${name}.js`), "export {};\n");
    }
    const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "lint.ts")], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
    });
    return { status: r.status, output: r.stdout + r.stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("[A7.3.3.verify.lint-complete] pnpm verify's lint passes only when every file was linted and reported", () => {
  test("a lint thread that ends before it reports fails the step, also when its files held a violation", async () => {
    const r = await lint("error", true);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("a lint thread ended before it reported its files");
  });

  test("a violation fails the step and is named, a warning too", async () => {
    for (const level of ["error", "warn"]) {
      const r = await lint(level, false);
      expect(r.status, level).toBe(1);
      expect(r.output, level).toContain("no-debugger");
      expect(r.output, level).toContain("dies.js");
    }
  });

  test("files without a problem pass", async () => {
    const r = await lint("error", false, false);
    expect(r.status).toBe(0);
  });
});
