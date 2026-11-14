// Host detection (A3 3.7.5, M4.06): which bind frames come from a host that runs one MCP server for
// many conversations, from the entry's app word, its environment and the bridge's ancestors. The
// process table is a fixture here (a /proc tree in a temporary folder, Windows command lines as
// text); one test reads this process's own ancestors from the OS.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  linuxAncestors,
  osAncestry,
  programName,
  runsAppServer,
  sharedHost,
  windowsAncestors,
  windowsArgv,
  windowsLines,
  type Ancestry,
} from "./hosts.ts";

let proc: string;

/** A process of the fixture /proc: its stat line (comm and parent) and its arguments. */
function processOf(pid: number, comm: string, parent: number, argv: readonly string[]): void {
  const dir = join(proc, String(pid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "stat"), `${String(pid)} (${comm}) S ${String(parent)} 1 1 0 -1\n`, {
    mode: 0o600,
  });
  writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`, { mode: 0o600 });
}

beforeAll(() => {
  proc = mkdtempSync(join(tmpdir(), "tasks-hosts-"));
  // T3 Code's server, its Codex app-server (through the npm wrapper), and the bridge's parent.
  processOf(4000, "node", 1, ["node", "/opt/t3/server.js"]);
  processOf(4100, "node", 4000, [
    "/usr/bin/node",
    "/usr/lib/node_modules/codex/bin/codex.js",
    "app-server",
  ]);
  processOf(4200, "codex-x86_64-u", 4100, [
    "/usr/lib/codex-x86_64-unknown-linux-musl",
    "app-server",
  ]);
  // A terminal's Codex CLI, whose name has a space and parentheses in its comm.
  processOf(5000, "bash", 1, ["bash"]);
  processOf(5100, "co (dex) x", 5000, ["codex", "--model", "fixture"]);
  // A wrapper whose parent (6000) is gone, or cannot be read.
  processOf(6100, "sh", 6000, ["sh", "-c", "wrapper"]);
});
afterAll(() => {
  rmSync(proc, { recursive: true, force: true });
});

describe("[A3.3.7.binding.hosts] a shared host is told from the bind frame and the bridge's ancestors", () => {
  test("Claude Desktop's chat (no session ID) is shared; its Code tab, with one, is not", async () => {
    expect(await sharedHost({ app: "claude-desktop", env: {}, parent: undefined }, undefined)).toBe(
      "claude-desktop",
    );
    expect(
      await sharedHost(
        { app: "claude-desktop", env: { CLAUDE_CODE_SESSION_ID: "fixture-1" }, parent: undefined },
        undefined,
      ),
    ).toBeUndefined();
    // Other apps' words, and Claude Code's, are per session.
    expect(await sharedHost({ app: "claude-code", env: {}, parent: undefined }, undefined)).toBe(
      undefined,
    );
  });

  test("a Codex entry under an app-server is shared, a Codex CLI's is not, and an unread table is unknown", async () => {
    const fromProc: Ancestry = (pid, depth) => Promise.resolve(linuxAncestors(pid, depth, proc));
    const at = (pid: number) => ({ app: "codex", env: {}, parent: { pid } });
    expect(await sharedHost(at(4200), fromProc)).toBe("app-server");
    expect(await sharedHost({ ...at(4200), app: "codex-app" }, fromProc)).toBe("app-server");
    expect(await sharedHost(at(5100), fromProc)).toBeUndefined();
    // Another app word is not read at all; a missing or bad PID reads nothing.
    let read = 0;
    const counting: Ancestry = (pid, depth) => {
      read += 1;
      return fromProc(pid, depth);
    };
    expect(await sharedHost({ ...at(4200), app: "test" }, counting)).toBeUndefined();
    expect(await sharedHost({ ...at(-1) }, counting)).toBe("unknown");
    expect(await sharedHost({ app: "codex", env: {}, parent: "4200" }, counting)).toBe("unknown");
    expect(read).toBe(0);
    // A table that cannot be read, or shows no ancestor, is unknown: its ticket binds nothing.
    const failing: Ancestry = () => Promise.reject(new Error("fixture: no process table"));
    expect(await sharedHost(at(4200), failing)).toBe("unknown");
    expect(await sharedHost(at(9999), fromProc)).toBe("unknown");
    // No reader on this OS: the host is not read at all.
    expect(await sharedHost(at(4200), undefined)).toBeUndefined();
  });

  test("ancestors are read upwards from the parent, at most four, and stop at a process that is gone", () => {
    expect(linuxAncestors(4200, 4, proc).map((a) => a.argv[0])).toEqual([
      "/usr/lib/codex-x86_64-unknown-linux-musl",
      "/usr/bin/node",
      "node",
    ]);
    expect(linuxAncestors(4200, 1, proc)).toHaveLength(1);
    expect(linuxAncestors(5100, 4, proc).map((a) => a.argv)).toEqual([
      ["codex", "--model", "fixture"],
      ["bash"],
    ]);
    // A process that is gone or cannot be read ends the walk as an ancestor nobody knows.
    expect(linuxAncestors(9999, 4, proc)).toEqual([{ argv: [] }]);
    expect(linuxAncestors(6100, 4, proc).map((a) => a.argv)).toEqual([["sh", "-c", "wrapper"], []]);
  });

  test("an ancestor that could not be read leaves the host unknown, unless an app-server was read", async () => {
    const fromProc: Ancestry = (pid, depth) => Promise.resolve(linuxAncestors(pid, depth, proc));
    // A readable wrapper under an ancestor that cannot be read: it may be an app-server.
    expect(await sharedHost({ app: "codex", env: {}, parent: { pid: 6100 } }, fromProc)).toBe(
      "unknown",
    );
    const partial: Ancestry = () => Promise.resolve([{ argv: ["cmd", "/c"] }, { argv: [] }]);
    expect(await sharedHost({ app: "codex", env: {}, parent: { pid: 1 } }, partial)).toBe(
      "unknown",
    );
    const below: Ancestry = () =>
      Promise.resolve([{ argv: ["codex", "app-server"] }, { argv: [] }]);
    expect(await sharedHost({ app: "codex", env: {}, parent: { pid: 1 } }, below)).toBe(
      "app-server",
    );
    // Windows: a process whose command line Windows does not give is `-` in the read's output.
    const line = (text: string) => Buffer.from(text, "utf8").toString("base64");
    expect(
      windowsLines(`${line("cmd /c tasks")}\r\n-\r\n${line("codex app-server")}\r\n`, 4),
    ).toEqual([{ argv: ["cmd", "/c", "tasks"] }, { argv: [] }]);
    expect(windowsLines(`${line("a")}\n${line("b")}\n${line("c")}\n`, 2)).toEqual([
      { argv: ["a"] },
      { argv: ["b"] },
    ]);
  });

  test("an app-server is a Codex program followed by app-server, wherever node puts it", () => {
    expect(programName("C:\\Program Files\\Codex\\codex.exe")).toBe("codex");
    expect(runsAppServer(["codex", "app-server"])).toBe(true);
    expect(runsAppServer(["node", "/x/codex.js", "app-server", "--listen"])).toBe(true);
    expect(runsAppServer(windowsArgv('"C:\\Program Files\\Codex\\codex.exe" app-server'))).toBe(
      true,
    );
    expect(runsAppServer(["codex", "exec", "app-server"])).toBe(false);
    expect(runsAppServer(["app-server"])).toBe(false);
    expect(runsAppServer(["other", "app-server"])).toBe(false);
    expect(windowsArgv('a "b c" d""e  ')).toEqual(["a", "b c", "de"]);
    expect(windowsArgv('""')).toEqual([""]);
  });

  test("this process's own ancestors, as the OS records them", { timeout: 120_000 }, async () => {
    if (process.platform === "win32") {
      // The bind's own deadline is not this test's: a loaded machine may take longer.
      const found = await windowsAncestors(process.pid, 2, process.env, 60_000);
      expect(found.length).toBeGreaterThan(0);
      expect(programName(found[0]?.argv[0] ?? "")).toBe("node");
    } else if (process.platform === "linux") {
      const read = osAncestry("linux");
      const found = (await read?.(process.pid, 2)) ?? [];
      expect(found.length).toBeGreaterThan(0);
      expect(programName(found[0]?.argv[0] ?? "")).toBe("node");
    }
    expect(osAncestry("darwin")).toBeUndefined();
  });
});
