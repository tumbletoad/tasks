// Small native programs for the launcher tests, compiled from test/fixtures/ with the same MSVC
// as the launchers: a stand-in OpenSSL provider DLL, a stand-in node.exe that reports the
// handles it received, and a starter that runs a program with chosen standard handles, an
// unrelated inheritable handle and raw environment entries. Each source file says how to use it.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMsvc, type Msvc } from "../src/build.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type Fixture = "provider" | "spy" | "starter";

/** Compiles test/fixtures/<name>.c into outDir and returns the DLL or program. */
export function compileFixture(outDir: string, name: Fixture, msvc: Msvc = findMsvc()): string {
  const dll = name === "provider";
  const out = join(outDir, `${name}.${dll ? "dll" : "exe"}`);
  const objDir = join(outDir, `${name}.obj.d`);
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
      ...(dll ? ["/LD"] : []),
      `/Fo${objDir}\\`,
      `/Fe${out}`,
      join(fixtures, `${name}.c`),
    ],
    { cwd: outDir, env: msvc.env, encoding: "utf8", windowsHide: true },
  );
  rmSync(objDir, { recursive: true, force: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`cl.exe failed for ${name}:\n${result.stdout}`);
  return out;
}
