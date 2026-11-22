// Preloaded with --import by cli-entry.test.ts: records the URL of every module the process
// resolves after this file (the entry included), and writes them, one per line, to the file named
// by KF_LOAD_LOG when the process exits. So a test sees what a real `ttasks mcp` loads, dynamic
// imports included, not what a static walk infers. Tests only.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import process from "node:process";

const out = process.env["KF_LOAD_LOG"];
const urls: string[] = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    urls.push(result.url);
    return result;
  },
});

process.on("exit", () => {
  if (out !== undefined && out !== "") writeFileSync(out, `${urls.join("\n")}\n`);
});
