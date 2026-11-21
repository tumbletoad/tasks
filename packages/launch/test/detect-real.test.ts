// Detection on the real file system and with real processes (A4 3.2): fake commands
// and homes in a temporary folder, an injected environment whose PATH names only those folders,
// and a home that is that folder. No test looks at the real homes of this machine.
//
// The fake commands are Node itself under the commands' names (a hard link, or a copy) and a small
// script as Codex's npm entry, so `--version` really runs. A wrapper that would leave a marker file
// if it ever ran proves wrappers are never run.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { detect, nodeDetectHost } from "../src/detect.ts";

const temps: string[] = [];
afterEach(() => {
  // Retried: on Windows a killed probe's working folder stays in use for a moment after it ends.
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const windows = process.platform === "win32";

/** Node under another name: a hard link where the volume allows it, else a copy. */
function nodeAs(path: string): void {
  try {
    linkSync(process.execPath, path);
  } catch {
    copyFileSync(process.execPath, path);
  }
  if (!windows) chmodSync(path, 0o755);
}

describe("[A4.3.2.detect.real] detection on the real file system with fake commands", () => {
  test("versions from --version, npm entries run by Node, wrappers never run, homes by name only", async () => {
    const home = mkdtempSync(join(tmpdir(), "ttasks-detect-"));
    temps.push(home);
    const bin = join(home, windows ? "bin" : join(".local", "bin"));
    const npm = join(home, "npm-global");
    const entryDir = join(npm, "node_modules", "@openai", "codex", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(entryDir, { recursive: true });

    // Claude Code: Node under Claude's name, so `--version` prints Node's version.
    nodeAs(join(bin, windows ? "claude.exe" : "claude"));
    // Codex: an npm entry that prints a version, and Node beside it on the PATH.
    writeFileSync(join(entryDir, "codex.js"), 'process.stdout.write("codex-cli 0.167.1\\n");\n');
    nodeAs(join(npm, windows ? "node.exe" : "node"));
    if (windows) {
      // npm's shim: found, never run; the entry beside it is what runs.
      writeFileSync(join(npm, "codex.cmd"), "@echo off\r\nexit /b 9\r\n");
    } else {
      symlinkSync(join("node_modules", "@openai", "codex", "bin", "codex.js"), join(npm, "codex"));
      chmodSync(join(entryDir, "codex.js"), 0o755);
      // A wrapper that leaves a marker if anything runs it.
      const wrapper = join(bin, "codex-work");
      writeFileSync(wrapper, `#!/bin/sh\ntouch '${join(home, "wrapper-ran")}'\n`);
      chmodSync(wrapper, 0o755);
    }
    // Homes, with sign-in files detection must never open.
    for (const folder of [".codex", ".codex-work", ".claude"]) {
      mkdirSync(join(home, folder));
      writeFileSync(join(home, folder, "auth.json"), "{}");
    }

    const env: Record<string, string> = { PATH: [bin, npm].join(delimiter) };
    if (windows) {
      // Node needs these to start on Windows; they name no home.
      for (const name of ["SystemRoot", "SYSTEMROOT", "windir"]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
    }
    const detection = await detect(nodeDetectHost({ env, home, timeoutMs: 30_000 }));

    const claude = detection.commands.find((c) => c.target === "claude-cli");
    expect(claude).toMatchObject({ source: "path", version: process.version.slice(1) });
    const codex = detection.commands.find((c) => c.target === "codex-cli");
    expect(codex?.source).toBe("npm");
    expect(codex?.exec[0]).toBe(join(npm, windows ? "node.exe" : "node"));
    expect(codex?.exec[1]?.toLowerCase()).toMatch(/codex\.js$/u);
    expect(codex).toMatchObject({ version: "0.167.1", tested: true });
    expect(detection.homes.map((h) => [h.target, h.suffix])).toEqual([
      ["claude-cli", ""],
      ["codex-cli", ""],
      ["codex-cli", "work"],
    ]);
    if (!windows) {
      expect(detection.wrappers.map((w) => w.suffix)).toEqual(["work"]);
      expect(existsSync(join(home, "wrapper-ran"))).toBe(false);
      expect(detection.proposals.map((p) => p.id)).toEqual(["claude", "codex-work", "codex"]);
    } else {
      expect(detection.proposals.map((p) => p.id)).toEqual(["claude", "codex", "codex-work"]);
    }
  }, 120_000);

  test("a command that hangs is killed at its bound and gives no version", async () => {
    const home = mkdtempSync(join(tmpdir(), "ttasks-detect-hang-"));
    temps.push(home);
    const host = nodeDetectHost({ env: { PATH: "" }, home, timeoutMs: 500 });
    const t0 = Date.now();
    const out = await host.output(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    expect(out).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(20_000);
    // A shim is never run.
    expect(await host.output(join(home, "x.cmd"), ["--version"])).toBeUndefined();
  });

  test("a command that hangs with a descendant is killed with its whole tree at the bound, on every OS", async () => {
    const home = mkdtempSync(join(tmpdir(), "ttasks-detect-hangtree-"));
    temps.push(home);
    const pidFile = join(home, "descendant.pid");
    // Starts a descendant and hangs with it. On Windows the descendant leaves Node's kill-on-close
    // job (`detached`), as one started by a native launcher would never be in it.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      "setTimeout(() => {}, 60000);",
    ].join("\n");
    const env: Record<string, string> = { PATH: "" };
    for (const name of ["SystemRoot", "SYSTEMROOT", "windir"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const host = nodeDetectHost({ env, home, timeoutMs: 2_000 });
    const t0 = Date.now();
    expect(await host.output(process.execPath, ["-e", script])).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const until = Date.now() + 5_000;
    while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const survived = alive();
    if (survived) process.kill(pid);
    expect(survived).toBe(false);
  });

  test("a command that leaves a descendant holding its output still ends within the bound; on Linux and macOS the descendant is killed", async () => {
    const home = mkdtempSync(join(tmpdir(), "ttasks-detect-tree-"));
    temps.push(home);
    const pidFile = join(home, "descendant.pid");
    // Prints a version, starts a descendant that inherits stdout and lives on, and exits.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'ignore'] });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      "c.unref();",
      "process.stdout.write('1.2.3\\n');",
    ].join("\n");
    const env: Record<string, string> = { PATH: "" };
    for (const name of ["SystemRoot", "SYSTEMROOT", "windir"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const host = nodeDetectHost({ env, home, timeoutMs: 1_000 });
    const t0 = Date.now();
    const out = await host.output(process.execPath, ["-e", script]);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    if (windows) {
      // Windows has no process group to kill: the answer still comes within the bound (whether the
      // pipe closed with the command or at the grace), and the test cleans up.
      expect([undefined, "1.2.3\n"]).toContain(out);
      if (alive()) process.kill(pid);
    } else {
      // The command exited 0 with its version; what it left behind was killed with its group.
      expect(out).toBe("1.2.3\n");
      const until = Date.now() + 5_000;
      while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
    }
  });
});
