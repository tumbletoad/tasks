// A fake `systemd-run` (A4 3.7; M2.09). No test ever runs the real one against the person's user
// manager: a test's spawner maps the path the service found to `node <this file>`.
//
// It records its argv as a JSON line in FAKE_SYSTEMD_LOG, then, like `systemd-run --user --scope`,
// runs the command after `--` as its child and passes its exit status through. The command's
// program is mapped by FAKE_PROGRAMS (JSON: path to argv prefix) as the spawner maps it, so the
// terminal inside the scope is a fake too. FAKE_SYSTEMD_FAIL=1 stands for a user manager that
// cannot be reached: it exits 1 and runs nothing.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const env = process.env;
const args = process.argv.slice(2);
const log = env["FAKE_SYSTEMD_LOG"];
if (log !== undefined) appendFileSync(log, `${JSON.stringify({ pid: process.pid, argv: args })}\n`);

if (env["FAKE_SYSTEMD_FAIL"] === "1") process.exit(1);
const split = args.indexOf("--");
const command = split === -1 ? [] : args.slice(split + 1);
const [file, ...rest] = command;
if (file === undefined) process.exit(64);
const programs = JSON.parse(env["FAKE_PROGRAMS"] ?? "{}") as Record<string, string[]>;
const mapped = [...(programs[file] ?? [file]), ...rest];
const child = spawn(mapped[0] ?? "", mapped.slice(1), {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", () => {
  process.exit(1);
});
child.once("exit", (code) => {
  process.exit(code ?? 1);
});
