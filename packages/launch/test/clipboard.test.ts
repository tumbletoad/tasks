// The clipboard tools of `tasks brief --copy` (A4 3.4.6): which tool runs on each OS and session,
// that the text reaches it through standard input byte for byte and never through its argv, that
// only an exit 0 is a copy, that the next tool runs when one fails, that a tool that does not
// finish is ended, and that the selection holder a Linux tool forks is left to serve. The tools
// are testkit's fake clipboard (`node <fake>`); the machine's clipboard is never touched. On
// Windows the real Windows PowerShell runs the script once with a sink that writes a file instead
// of calling Set-Clipboard, to prove it reads standard input as UTF-8.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FAKE_CLIPBOARD } from "@tasks/testkit";
import {
  CLIPBOARD_ARGS,
  clipboardProgram,
  clipboardTools,
  copyText,
  windowsClipboardScript,
  type ClipboardTool,
} from "../src/clipboard.ts";
import { powershellPath } from "../src/process.ts";

const TEXT =
  'TT Tasks task M-14 "Fix appointment time zones" (launch L7KQ2M).\nCafé 😀 — line two\n';

let dir = "";
/** PIDs of selection holders a fake started: each is stopped by its recorded PID. */
const holders: number[] = [];
beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-clipboard-")));
});
afterAll(() => {
  for (const pid of holders) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It ended by itself.
    }
  }
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

let runs = 0;
/** A fresh output file and the env a fake reads its controls from. */
function fake(controls: Record<string, string> = {}): {
  env: Record<string, string>;
  out: string;
  argv: string;
} {
  runs += 1;
  const out = join(dir, `out-${String(runs)}.bin`);
  const argv = join(dir, `argv-${String(runs)}.json`);
  // Each case names its own session: the one this test runs in must not choose the tool.
  const inherited = { ...(process.env as Record<string, string>) };
  delete inherited["WAYLAND_DISPLAY"];
  delete inherited["DISPLAY"];
  return {
    out,
    argv,
    env: {
      ...inherited,
      FAKE_CLIP_OUT: out,
      FAKE_CLIP_ARGV: argv,
      ...controls,
    },
  };
}

/** Every tool is the fake, so the order and the fallbacks show through `seen`. */
const fakes = (seen: ClipboardTool[], only?: readonly ClipboardTool[]) => (tool: ClipboardTool) => {
  if (only !== undefined && !only.includes(tool)) return undefined;
  seen.push(tool);
  return [process.execPath, FAKE_CLIPBOARD];
};

describe("[A4.5.clipboard.tools] tasks brief --copy: the OS's clipboard tool through standard input, never a copy that did not happen", () => {
  test("the tools per OS and session, in A4's order", () => {
    expect(clipboardTools("win32", {})).toEqual(["set-clipboard"]);
    expect(clipboardTools("darwin", {})).toEqual(["pbcopy"]);
    expect(clipboardTools("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
    expect(clipboardTools("linux", { DISPLAY: ":0" })).toEqual(["xclip", "xsel"]);
    expect(clipboardTools("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual(["wl-copy"]);
    expect(clipboardTools("linux", { DISPLAY: "" })).toBe("no_session");
    // Each tool's own flags: the clipboard selection, input mode; never the text.
    expect(CLIPBOARD_ARGS.xclip).toEqual(["-selection", "clipboard", "-in"]);
    expect(CLIPBOARD_ARGS.xsel).toEqual(["--clipboard", "--input"]);
    expect(CLIPBOARD_ARGS["wl-copy"]).toEqual([]);
    const ps = CLIPBOARD_ARGS["set-clipboard"];
    expect(ps.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(ps).not.toContain("-EncodedCommand");
    expect(ps.at(-1)).toContain("Set-Clipboard -Value $text");
    // PowerShell by its full path under the system folder; the Linux tools on the PATH by name.
    expect(clipboardProgram("set-clipboard", "win32", { SystemRoot: "C:\\Windows" })).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
    expect(clipboardProgram("xclip", "linux", { PATH: join(dir, "nothing-here") })).toBeUndefined();
  });

  test("the text reaches the tool on standard input byte for byte, and its argv holds only the tool's flags", async () => {
    const f = fake();
    const seen: ClipboardTool[] = [];
    const result = await copyText(TEXT, {
      platform: "linux",
      env: { ...f.env, DISPLAY: ":0" },
      cwd: dir,
      program: fakes(seen),
    });
    expect(result).toEqual({ status: "copied", tool: "xclip" });
    expect(seen).toEqual(["xclip"]);
    expect(readFileSync(f.out)).toEqual(Buffer.from(TEXT, "utf8"));
    const argv = JSON.parse(readFileSync(f.argv, "utf8")) as string[];
    expect(argv).toEqual(["-selection", "clipboard", "-in"]);
    expect(argv.join(" ")).not.toContain("M-14");
  });

  test("a tool that fails makes the next one run; when every tool fails the copy is reported as not made", async () => {
    const f = fake({ FAKE_CLIP_EXIT: "1" });
    const seen: ClipboardTool[] = [];
    const failed = await copyText(TEXT, {
      platform: "linux",
      env: { ...f.env, WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      cwd: dir,
      program: fakes(seen),
    });
    expect(seen).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(failed).toEqual({ status: "failed", reason: "failed", tool: "xsel", code: 1 });
    // None installed: no tool, nothing run. No desktop session: nothing to hold a clipboard.
    const none = await copyText(TEXT, {
      platform: "linux",
      env: { DISPLAY: ":0" },
      cwd: dir,
      program: () => undefined,
    });
    expect(none).toEqual({ status: "failed", reason: "no_tool" });
    expect(await copyText(TEXT, { platform: "linux", env: {}, cwd: dir })).toEqual({
      status: "failed",
      reason: "no_session",
    });
    // A tool that is named but cannot start is a failure too, never a copy.
    const missing = await copyText(TEXT, {
      platform: "linux",
      env: { DISPLAY: ":0" },
      cwd: dir,
      program: (tool) => (tool === "xclip" ? [join(dir, "no-such-program")] : undefined),
    });
    expect(missing).toMatchObject({ status: "failed", reason: "failed", tool: "xclip" });
  });

  test("a tool that does not finish is ended at its deadline and reported, and the next one runs", async () => {
    const hang = fake({ FAKE_CLIP_HANG: "1" });
    const result = await copyText(TEXT, {
      platform: "linux",
      env: { ...hang.env, WAYLAND_DISPLAY: "wayland-0" },
      cwd: dir,
      program: fakes([]),
      deadlineMs: 1_500,
    });
    expect(result).toEqual({ status: "failed", reason: "timeout", tool: "wl-copy" });
  });

  test("the selection holder a Linux tool forks is left to serve, and the copy does not wait for it", async () => {
    const pidFile = join(dir, "holder.pid");
    const f = fake({ FAKE_CLIP_SERVE: pidFile });
    const result = await copyText(TEXT, {
      platform: "linux",
      env: { ...f.env, DISPLAY: ":0" },
      cwd: dir,
      program: fakes([]),
    });
    expect(result).toEqual({ status: "copied", tool: "xclip" });
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    holders.push(pid);
    // Still alive after the copy returned: the runner ended neither it nor its group.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  test.runIf(process.platform === "win32")(
    "Windows PowerShell reads standard input as UTF-8 bytes: the script with a file in place of Set-Clipboard",
    () => {
      const out = join(dir, "powershell.txt");
      const script = windowsClipboardScript(
        `[System.IO.File]::WriteAllText('${out.replaceAll("'", "''")}', $text, [System.Text.UTF8Encoding]::new($false))`,
      );
      const ran = spawnSync(
        powershellPath(process.env),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { input: Buffer.from(TEXT, "utf8"), windowsHide: true, timeout: 60_000 },
      );
      expect(ran.status).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(TEXT);
    },
  );
});
