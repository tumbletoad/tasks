// Small native programs for the launcher tests, compiled from test/fixtures/ with the same MSVC
// as the launchers: a stand-in OpenSSL provider DLL, a stand-in node.exe that reports the
// handles it received, and a starter that runs a program with chosen standard handles, an
// unrelated inheritable handle and raw environment entries. Each source file says how to use it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileC, findMsvc, type Msvc } from "../src/build.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type Fixture = "provider" | "spy" | "starter";

/** Compiles test/fixtures/<name>.c into outDir and returns the DLL or program. */
export function compileFixture(outDir: string, name: Fixture, msvc: Msvc = findMsvc()): string {
  const dll = name === "provider";
  return compileC(msvc, {
    source: join(fixtures, `${name}.c`),
    out: join(outDir, `${name}.${dll ? "dll" : "exe"}`),
    compile: ["/W4", "/WX", "/MT", "/utf-8", "/DUNICODE", "/D_UNICODE"],
    link: dll ? ["/DLL"] : [],
  });
}
