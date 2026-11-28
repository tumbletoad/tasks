// A fake clipboard tool (`wl-copy`, `xclip`, `xsel`, `pbcopy` or PowerShell's Set-Clipboard) for
// the tests of `ttasks brief --copy`. No test ever touches the machine's clipboard: the
// test's program seam runs `node <this file>` in place of the tool.
//
// It reads its standard input whole and writes those bytes to FAKE_CLIP_OUT, and its argv as JSON
// to FAKE_CLIP_ARGV. Its controls:
// - FAKE_CLIP_EXIT=<n>: exit with n after reading (a tool that fails).
// - FAKE_CLIP_HANG=1: never exit (a tool that does not finish).
// - FAKE_CLIP_SERVE=<pid file>: like xclip and wl-copy, start a process that holds "the selection"
//   and outlives the tool, write its PID to the file, then exit 0. The holder ends by itself after
//   FAKE_CLIP_SERVE_MS (default 60 s); the test that made it stops it by that PID.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parse } from "node:path";

const env = process.env;
if (env["FAKE_CLIP_HOLDER"] === "1") {
  // The selection holder: it only waits.
  setTimeout(() => undefined, Number(env["FAKE_CLIP_SERVE_MS"] ?? "60000"));
} else {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const out = env["FAKE_CLIP_OUT"];
    if (out !== undefined) writeFileSync(out, Buffer.concat(chunks));
    const argv = env["FAKE_CLIP_ARGV"];
    if (argv !== undefined) writeFileSync(argv, JSON.stringify(process.argv.slice(2)));
    if (env["FAKE_CLIP_HANG"] === "1") {
      setInterval(() => undefined, 1_000);
      return;
    }
    const serve = env["FAKE_CLIP_SERVE"];
    if (serve !== undefined) {
      const holder = spawn(process.execPath, [process.argv[1] ?? ""], {
        env: { ...env, FAKE_CLIP_HOLDER: "1" },
        // Not in the test's folder, so the folder can go while the holder still runs.
        cwd: parse(process.cwd()).root,
        stdio: "ignore",
        windowsHide: true,
        // On Linux and macOS it stays in the tool's process group, as xclip's does. On Windows a
        // child that is not detached dies with its parent's job, which no real tool there has.
        // eslint-disable-next-line no-restricted-syntax -- the holder only waits.
        detached: process.platform === "win32",
      });
      holder.unref();
      writeFileSync(serve, String(holder.pid ?? ""));
    }
    process.exit(Number(env["FAKE_CLIP_EXIT"] ?? "0"));
  });
}
