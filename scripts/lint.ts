// pnpm verify's lint step: ESLint over the folder it runs in, on two threads, failing on any
// warning.
//
// ESLint returns its results only once every thread has reported the files it took, and a thread
// that fails reports its error. A thread that ends without reporting leaves ESLint waiting for
// good, and the process would then end with 0 without that thread's files. So the step passes only
// when ESLint returned.
import { enableCompileCache } from "node:module";

// As ESLint's own command does, before ESLint and the rules it loads are compiled.
enableCompileCache();
const { ESLint } = await import("eslint");

process.exitCode = 1;
let returned = false;
process.on("exit", () => {
  if (!returned) console.error("lint: a lint thread ended before it reported its files");
});

const eslint = new ESLint({ concurrency: 2 });
let results: Awaited<ReturnType<typeof eslint.lintFiles>>;
try {
  results = await eslint.lintFiles(["."]);
} finally {
  returned = true;
}
const report = await (await eslint.loadFormatter("stylish")).format(results);
if (report !== "") console.log(report);
const problems = results.reduce((n, r) => n + r.errorCount + r.warningCount, 0);
process.exitCode = problems === 0 ? 0 : 1;
