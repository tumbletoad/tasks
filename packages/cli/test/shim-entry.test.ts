// `tasks shim` is entered before the CLI loads (A4 3.6.3, the way in `tasks mcp` has too):
// bin.ts imports the shim only for its verb, and the shim loads only its own modules, the protocol
// client and discovery of @tasks/bridge, three leaf modules of @tasks/launch (the start time
// readers, the wire, and places with its Git remote reader for the in-folder check), @tasks/brand
// and @tasks/files (exit.json's exact mode). A load recorder preloaded into the real process lists every module it resolves,
// dynamic imports included.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_BIN = join(REPO, "packages", "cli", "src", "bin.ts");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "entry.ts");
const SHIM_DIR = join(REPO, "packages", "cli", "src", "shim");
/** As a URL: --import takes a specifier, and a Windows path is not one. */
const RECORDER = new URL("../../../tests/forwarder/load-recorder.ts", import.meta.url).href;

/**
 * The built-ins the shim may load: the bridge's, a child process for the agent, tty, and
 * fs/promises for the in-folder check (the build's SHIM_BUILTINS hold the same list), and v8,
 * which the entry's safe-exit loads before the shim (A2 3.12.1).
 */
const BUILTINS = [
  "child_process",
  "crypto",
  "fs",
  "fs/promises",
  "net",
  "os",
  "path",
  "process",
  "tty",
  "url",
  "v8",
].map((name) => `node:${name}`);

/** The files the shim may load, by their path in the repository. */
const ALLOWED: readonly RegExp[] = [
  /^packages\/cli\/src\/(bin|mcp)\.ts$/,
  // The entry's first import (A2 3.12.1).
  /^packages\/bridge\/src\/safe-exit\.ts$/,
  /^packages\/cli\/src\/shim\/[a-z-]+\.ts$/,
  /^packages\/bridge\/src\/protocol\/[a-z-]+\.ts$/,
  /^packages\/bridge\/src\/mcp\/(discovery|names|unavailable)\.ts$/,
  /^packages\/launch\/src\/process\.ts$/,
  // The folder's reasons are launch codes too: intents.ts holds them, and imports nothing.
  /^packages\/launch\/src\/(places|git-remote|intents)\.ts$/,
  /^packages\/launch\/src\/shim\/wire\.ts$/,
  /^packages\/brand\/src\/index\.ts$/,
  // exit.json's exact mode (A2 3.2.2 rule 5): a leaf that imports only Node built-ins.
  /^packages\/files\/src\/index\.ts$/,
];

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

function run(args: readonly string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  log: string;
}> {
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-shim-entry-")));
  temps.push(temp);
  const log = join(temp, "loaded.txt");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(TASKS_|CLAUDE|CODEX_|T3CODE_)/i.test(name)) env[name] = value;
  }
  const child = spawn(process.execPath, ["--import", RECORDER, CLI_BIN, "shim", ...args], {
    env: { ...env, TASKS_HOME: join(temp, "home"), KF_LOAD_LOG: log },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin.end();
  return new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr, log });
    });
  });
}

function loaded(log: string): { builtins: string[]; files: string[]; other: string[] } {
  const urls = new Set(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  );
  const builtins: string[] = [];
  const files: string[] = [];
  const other: string[] = [];
  for (const url of urls) {
    if (url.startsWith("node:")) builtins.push(url);
    else if (url.startsWith("file:")) {
      files.push(relative(realpathSync.native(REPO), fileURLToPath(url)).split(sep).join("/"));
    } else other.push(url);
  }
  return { builtins: builtins.sort(), files: files.sort(), other };
}

/** Ways to load code that a static walk cannot follow (the bridge's imports.test.ts has the same). */
function dynamicLoads(source: string): string[] {
  const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
  const loader = new RegExp(
    String.raw`\b(?:import|require)${gap}\(|\bcreateRequire\b|\bprocess${gap}\.${gap}(?:dlopen|binding|_linkedBinding)\b`,
    "g",
  );
  return [...source.matchAll(loader)].map((match) => match[0]);
}

describe("[A4.5.shim.entry] tasks shim through the CLI's entry", () => {
  test(
    "loads only the shim's own path, and a bad argument exits 2 with a usage line that never repeats it",
    { timeout: 120_000 },
    async () => {
      const result = await run(["not-a-ticket"]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("tasks shim: usage: tasks shim <ticket>\n");

      const { builtins, files, other } = loaded(result.log);
      expect(other).toEqual([]);
      for (const name of builtins) expect(BUILTINS, name).toContain(name);
      for (const file of files) {
        expect(
          ALLOWED.some((pattern) => pattern.test(file)),
          file,
        ).toBe(true);
      }
      // The recorder saw the whole path: the entry, the shim, its link and its agent.
      for (const file of [
        "packages/cli/src/bin.ts",
        "packages/cli/src/shim/run.ts",
        "packages/cli/src/shim/link.ts",
        "packages/cli/src/shim/agent.ts",
        "packages/bridge/src/protocol/client.ts",
        "packages/bridge/src/mcp/discovery.ts",
        "packages/launch/src/shim/wire.ts",
        "packages/launch/src/process.ts",
        "packages/launch/src/places.ts",
      ]) {
        expect(files).toContain(file);
      }
      expect(files).not.toContain("packages/cli/src/main.ts");
    },
  );

  test("the shim's own modules load nothing a static walk cannot see", () => {
    for (const name of readdirSync(SHIM_DIR)) {
      if (!name.endsWith(".ts")) continue;
      expect(dynamicLoads(readFileSync(join(SHIM_DIR, name), "utf8")), name).toEqual([]);
    }
    // Both entries (bin.ts from source, entry.ts in a version folder) route `shim` after `mcp`
    // and before they load the CLI; the route (shim.ts) imports nothing and loads the shim with
    // one dynamic import, so `tasks mcp` loads nothing of the shim.
    for (const file of [CLI_BIN, CLI_ENTRY]) {
      const entry = readFileSync(file, "utf8");
      const route = entry.indexOf('if (argv[0] === "shim")');
      expect(route, file).toBeGreaterThan(entry.indexOf("if (argv[0] === MCP_VERB)"));
      expect(route, file).toBeLessThan(entry.indexOf('import("./run.ts")'));
      expect(entry.split('await import("./shim/run.ts")').length - 1, file).toBe(1);
      expect(entry, file).not.toMatch(/^import .*shim/m);
    }
  });
});
