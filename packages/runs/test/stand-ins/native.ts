// Windows programs for the container tests: ttasks-run.exe as the product builds it, and the
// jobhold.c fixture, compiled with the same MSVC.
import { join } from "node:path";
import { buildRunHelper, compileC, findMsvc } from "@ttasks/launcher-win/build";

export interface Natives {
  readonly helper: string;
  readonly jobhold: string;
}

export function buildNatives(outDir: string): Natives {
  const msvc = findMsvc();
  const helper = buildRunHelper(outDir, msvc);
  const jobhold = compileC(msvc, {
    source: join(import.meta.dirname, "jobhold.c"),
    out: join(outDir, "jobhold.exe"),
    compile: ["/W4", "/WX", "/MT", "/utf-8", "/DUNICODE", "/D_UNICODE"],
    link: [],
  });
  return { helper, jobhold };
}
