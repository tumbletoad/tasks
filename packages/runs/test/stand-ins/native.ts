// Windows programs for the container tests: ttasks-run.exe as the product builds it, and the
// jobhold.c fixture, compiled with the same MSVC.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildRunHelper, findMsvc } from "@ttasks/launcher-win/build";

export interface Natives {
  readonly helper: string;
  readonly jobhold: string;
}

export function buildNatives(outDir: string): Natives {
  const msvc = findMsvc();
  const helper = buildRunHelper(outDir, msvc);
  const jobhold = join(outDir, "jobhold.exe");
  const objDir = join(outDir, "jobhold.obj.d");
  mkdirSync(objDir, { recursive: true });
  const result = spawnSync(
    msvc.cl,
    [
      "/nologo",
      "/W4",
      "/WX",
      "/MT",
      "/utf-8",
      "/DUNICODE",
      "/D_UNICODE",
      `/Fo${objDir}\\`,
      `/Fe${jobhold}`,
      join(import.meta.dirname, "jobhold.c"),
    ],
    { cwd: outDir, env: msvc.env, encoding: "utf8", windowsHide: true },
  );
  rmSync(objDir, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`cl.exe failed for jobhold.c:\n${result.stdout}`);
  return { helper, jobhold };
}
