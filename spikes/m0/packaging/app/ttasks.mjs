// Stand-in for lib/ttasks.mjs in the M0.03 packaging spike (A2 3.12.2). It routes a subcommand and
// loads the module that serves it only when needed, like the real entry. Commands:
//   argv <args…>        print what reached Node, as JSON, for the hostile-argv tests (A2 3.12.3)
//   exit <code>         exit with that code, for the exit-code pass-through tests
//   version             print this version folder's version
//   wait                print Node's process ID, then wait until stdin closes (lab row S08 and
//                       the job-object test)
//   gate [options]      the runtime gate (A2 3.12.1, A7 row R01)
//   install --finish    the install hand-over that the bootstrap runs after verification (3.12.4)
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const [command = "", ...rest] = process.argv.slice(2);

/** The variables a launcher sets or removes (A2 3.12.3). Names only for the Node ones. */
function launchEnvironment() {
  const env = process.env;
  return {
    NODE_OPTIONS: env.NODE_OPTIONS !== undefined,
    NODE_PATH: env.NODE_PATH !== undefined,
    TTASKS_HOME: env.TTASKS_HOME ?? null,
    TTASKS_ROOT: env.TTASKS_ROOT ?? null,
    TTASKS_LAUNCHER: env.TTASKS_LAUNCHER ?? null,
    TTASKS_LAUNCH_MODE: env.TTASKS_LAUNCH_MODE ?? null,
    TTASKS_PACKAGE: env.TTASKS_PACKAGE ?? null,
  };
}

switch (command) {
  case "argv":
    process.stdout.write(
      `${JSON.stringify({ args: rest, execArgv: process.execArgv, env: launchEnvironment() })}\n`,
    );
    break;
  case "exit":
    process.exitCode = Number.parseInt(rest[0] ?? "0", 10);
    break;
  case "version": {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    process.stdout.write(`${String(manifest.version)}\n`);
    break;
  }
  case "wait":
    process.stdout.write(`${String(process.pid)}\n`);
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    break;
  case "gate": {
    const { main } = await import("./gate.mjs");
    process.exitCode = await main(rest);
    break;
  }
  case "install": {
    const { main } = await import("./install.mjs");
    process.exitCode = await main(rest);
    break;
  }
  default:
    process.stderr.write(
      "usage: ttasks argv|exit|version|wait|gate|install --finish (packaging spike stand-in)\n",
    );
    process.exitCode = 64;
}
