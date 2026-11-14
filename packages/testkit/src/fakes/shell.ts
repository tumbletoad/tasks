// A fake login shell for the login-shell snapshot (A4 3.8; M2.09): `node <this file> -lic <script>`.
// It finds the snapshot's marker in the script the service sends and answers as FAKE_SHELL_MODE
// says, so every way a real profile can behave is a fixture:
// - `ok`: profile noise on stdout, then the fenced `env -0` of its own environment with
//   FAKE_SHELL_EXPORTS (JSON) added, then more noise; exit 0;
// - `noise`: only noise; exit 0;
// - `half`: the opening fence and the environment, never the closing fence; exit 0;
// - `fail`: nothing; exit 1;
// - `hang`: starts a child that also hangs (in its process group), and never answers;
// - `huge`: endless output without fences;
// - `linger`: the fenced environment like `ok`, then never exits (an EXIT trap or a logout script
//   that hangs).
// It records how it was started (its argv's flags, its working folder and its environment's names)
// as a JSON line in FAKE_SHELL_LOG.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const env = process.env;
const args = process.argv.slice(2);
const mode = env["FAKE_SHELL_MODE"] ?? "ok";
const log = env["FAKE_SHELL_LOG"];
if (log !== undefined) {
  appendFileSync(
    log,
    `${JSON.stringify({
      pid: process.pid,
      flags: args.slice(0, -1),
      cwd: process.cwd(),
      envNames: Object.keys(env).sort(),
    })}\n`,
  );
}
const script = args.at(-1) ?? "";
const marker = /printf '\\0%s\\0' ([0-9a-f]+);/.exec(script)?.[1] ?? "none";
const out = (text: string | Buffer): void => {
  process.stdout.write(text);
};
const fence = `\0${marker}\0`;
const entries = (): string => {
  const exports = JSON.parse(env["FAKE_SHELL_EXPORTS"] ?? "{}") as Record<string, string>;
  const all = { ...env, ...exports };
  return Object.entries(all)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}\0`)
    .join("");
};

switch (mode) {
  case "ok":
    out("Welcome to the fixture profile\n\u001b[1mbold noise\u001b[0m\n");
    out(fence);
    out(entries());
    out(fence);
    out("goodbye from .bash_logout\n");
    break;
  case "noise":
    out("only noise, no markers\n");
    break;
  case "half":
    out(fence);
    out(entries());
    break;
  case "fail":
    process.exitCode = 1;
    break;
  case "hang": {
    // A child in the same process group that would keep the pipe open: the deadline ends both.
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "inherit", "ignore"],
    });
    setInterval(() => undefined, 1000);
    break;
  }
  case "linger":
    out(fence);
    out(entries());
    out(fence);
    setInterval(() => undefined, 1000);
    break;
  case "huge": {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pump = (): void => {
      while (process.stdout.write(chunk)) {
        // Fill the pipe.
      }
      process.stdout.once("drain", pump);
    };
    pump();
    break;
  }
}
