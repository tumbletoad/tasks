// `tasks mcp` through the CLI's own entry (packages/cli/src/bin.ts, the build's lib/tasks.mjs): the
// entry hands over to the bridge before it loads anything of the CLI, so the bridge starts as fast
// as on its own, nothing the CLI prints can reach stdout, and the bridge's arguments are its own
// (A2 3.7.1, 3.12.2). A load recorder preloaded into the real process lists every
// module it resolves, dynamic imports included.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  Bridge,
  DEFAULT_ARGS,
  Procs,
  REPO,
  cleanEnv,
  isOfflineText,
  libOffline,
  makeHome,
  type Home,
  type Json,
} from "./harness.ts";

const CLI_BIN = join(REPO, "packages", "cli", "src", "bin.ts");
/** As a URL: --import takes a specifier, and a Windows path is not one. */
const RECORDER = new URL("./load-recorder.ts", import.meta.url).href;

/**
 * A2 3.7.1 names net, fs, crypto and process; path, os and url are small parts of Node's core, and
 * v8 sets the flag of the bridge's safe-exit.ts (A2 3.12.1).
 */
const ALLOWED = ["crypto", "fs", "net", "os", "path", "process", "url", "v8"].map(
  (n) => `node:${n}`,
);

/** The CLI's modules on the way to the bridge: its entry and the hand-over. */
const CLI_ENTRY_MODULES = ["packages/cli/src/bin.ts", "packages/cli/src/mcp.ts"];

const procs = new Procs();
const homes: Home[] = [];
const temps: string[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const home of homes.splice(0)) home.remove();
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

function home(label: string): Home {
  const made = makeHome(label);
  homes.push(made);
  return made;
}

/** `tasks <args>` through the CLI's entry, with the load recorder writing to `log`. */
function tasks(where: Home, args: readonly string[], log: string): Bridge {
  const proc = procs.spawn(
    process.execPath,
    ["--import", RECORDER, CLI_BIN, ...args],
    cleanEnv({ TASKS_HOME: where.root, KF_LOAD_LOG: log }),
  );
  return new Bridge(proc);
}

function logFile(): string {
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "kf-load-")));
  temps.push(temp);
  return join(temp, "loaded.txt");
}

/** What the process loaded: built-ins by name, files relative to the repository. */
function loaded(log: string): { builtins: string[]; files: string[]; other: string[] } {
  const urls = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const builtins: string[] = [];
  const files: string[] = [];
  const other: string[] = [];
  for (const url of new Set(urls)) {
    if (url.startsWith("node:")) builtins.push(url);
    else if (url.startsWith("file:")) {
      files.push(relative(realpathSync.native(REPO), fileURLToPath(url)).split(sep).join("/"));
    } else other.push(url);
  }
  return { builtins: builtins.sort(), files: files.sort(), other };
}

describe("[A2.3.7.bridge.cli-entry] tasks mcp through the CLI's entry", () => {
  test(
    "answers initialize and tools/list offline with nothing but MCP frames, and loads only the bridge",
    { timeout: 120_000 },
    async () => {
      const where = home("cli");
      const log = logFile();
      const bridge = tasks(where, ["mcp", ...DEFAULT_ARGS], log);
      const init = await bridge.initialize();
      expect(init["result"]).toMatchObject({ protocolVersion: "2025-11-25" });
      const list = await bridge.request("tools/list");
      const content = libOffline() as { tools_list: { result: Json } };
      expect(JSON.stringify(list["result"])).toBe(JSON.stringify(content.tools_list.result));
      expect(isOfflineText(await bridge.call("status"), "service_down")).toBe(true);
      bridge.end();
      expect(await bridge.proc.exit).toEqual({ code: 0, signal: null });
      expect(bridge.stray).toEqual([]);
      expect(bridge.lines.length).toBe(3);
      for (const line of bridge.stray.concat(bridge.lines)) {
        expect((JSON.parse(line) as Json)["jsonrpc"]).toBe("2.0");
      }

      const { builtins, files, other } = loaded(log);
      expect(other).toEqual([]);
      for (const name of builtins) expect(ALLOWED, name).toContain(name);
      expect(builtins).not.toContain("node:child_process");
      for (const file of files) {
        const ok =
          CLI_ENTRY_MODULES.includes(file) ||
          (file.startsWith("packages/bridge/src/") && !file.endsWith(".test.ts"));
        expect(ok, file).toBe(true);
      }
      // The recorder saw the whole path: the entry, the hand-over, the forwarder and the client.
      for (const file of CLI_ENTRY_MODULES) expect(files).toContain(file);
      expect(files).toContain("packages/bridge/src/mcp/forwarder.ts");
      expect(files).toContain("packages/bridge/src/protocol/client.ts");
    },
  );

  test(
    "the bridge reads its own arguments: a bad one exits 2 with the bridge's usage on stderr and nothing on stdout",
    { timeout: 60_000 },
    async () => {
      const where = home("cli-usage");
      for (const args of [["--bogus"], ["--json"], ["--space"], ["--help"]]) {
        const log = logFile();
        const bridge = tasks(where, ["mcp", ...args], log);
        expect(await bridge.proc.exit, args.join(" ")).toEqual({ code: 2, signal: null });
        expect(bridge.lines, args.join(" ")).toEqual([]);
        expect(bridge.proc.stderr()).toMatch(/^mcp bridge: .*usage:/);
        expect(loaded(log).files).not.toContain("packages/cli/src/main.ts");
      }
    },
  );

  test(
    "a CLI option before mcp is a usage error of the CLI's, and the bridge does not start",
    { timeout: 60_000 },
    async () => {
      const where = home("cli-global");
      const log = logFile();
      const bridge = tasks(where, ["--space", "sp_test", "mcp"], log);
      bridge.end();
      expect(await bridge.proc.exit).toEqual({ code: 2, signal: null });
      expect(bridge.lines).toEqual([]);
      expect(bridge.proc.stderr()).toContain("tasks mcp");
      expect(loaded(log).files).not.toContain("packages/bridge/src/mcp/forwarder.ts");
    },
  );
});
