// Stand-in for lib/tasks.mjs in the launcher tests (A2 3.12.2). Commands:
//   argv <args…>   print what reached Node as JSON: arguments, execArgv, the runtime and the
//                  launcher's variables (only whether NODE_OPTIONS and NODE_PATH are set)
//   env            print as JSON the names of the NODE_ and OPENSSL_ variables that reached Node,
//                  the proxy and SSL_CERT_ variables with their values, how many extra CA
//                  certificates Node loaded from NODE_EXTRA_CA_CERTS, every TASKS_ name in the
//                  block (each copy) and the launcher's variables as argv prints them
//   exit <code>    exit with that code
//   version        print this version folder's version and runtime as JSON
//   wait           print Node's process ID, then stay alive for 60 s whatever happens to stdin
//   detach         start a detached child Node, print both process IDs, then wait as above
//   serve          the stub service: follows plan.json in TASKS_STUB_DIR (see serve below)
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { getCACertificates } from "node:tls";
import { fileURLToPath, URL } from "node:url";

const [command = "", ...rest] = process.argv.slice(2);
const versionFolder = fileURLToPath(new URL("..", import.meta.url));

function version() {
  return JSON.parse(readFileSync(join(versionFolder, "manifest.json"), "utf8")).version;
}

function launcherVariables() {
  const env = process.env;
  return {
    NODE_OPTIONS: env.NODE_OPTIONS !== undefined,
    NODE_PATH: env.NODE_PATH !== undefined,
    TASKS_HOME: env.TASKS_HOME ?? null,
    TASKS_ROOT: env.TASKS_ROOT ?? null,
    TASKS_LAUNCHER: env.TASKS_LAUNCHER ?? null,
    TASKS_LAUNCH_MODE: env.TASKS_LAUNCH_MODE ?? null,
    TASKS_PACKAGE: env.TASKS_PACKAGE ?? null,
  };
}

/**
 * Stays alive for 60 s. Not until stdin ends: when a launcher dies, the test's Node closes the
 * pipe to its stdin, which would end this process without any job object.
 */
function stayAlive() {
  setTimeout(() => process.exit(0), 60_000);
}

/**
 * The stub service. plan.json is a list of steps, one per start: {exit, ms?, switchTo?,
 * replaceSupervisor?}. The n-th start follows step n (after the list: exit 0). It logs a start
 * line (with its parent, the supervisor), writes switchTo into <TASKS_ROOT>\current if given (an
 * update switching current), with replaceSupervisor renames <TASKS_ROOT>\bin\tasksw.exe aside
 * (as an update does while it runs) and copies tasksw-next.exe from its folder there, waits ms,
 * logs an end line and exits with the step's code. log.jsonl in the same folder holds the lines.
 */
function serve() {
  const dir = process.env.TASKS_STUB_DIR;
  if (dir === undefined) {
    process.stderr.write("TASKS_STUB_DIR is not set\n");
    process.exit(2);
  }
  const log = join(dir, "log.jsonl");
  const starts = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.includes('"ev":"start"')).length
    : 0;
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  const step = plan[starts] ?? { exit: 0 };
  const line = (fields) => {
    appendFileSync(log, `${JSON.stringify(fields)}\n`);
  };
  line({
    ev: "start",
    n: starts,
    t: Date.now(),
    pid: process.pid,
    ppid: process.ppid,
    version: version(),
    execPath: process.execPath,
    args: process.argv.slice(2),
    mode: process.env.TASKS_LAUNCH_MODE ?? null,
    manager: process.env.TASKS_SERVICE_MANAGER ?? null,
  });
  if (typeof step.switchTo === "string") {
    writeFileSync(join(process.env.TASKS_ROOT ?? "", "current"), step.switchTo);
  }
  if (step.replaceSupervisor === true) {
    const bin = join(process.env.TASKS_ROOT ?? "", "bin");
    renameSync(join(bin, "tasksw.exe"), join(bin, "tasksw.exe.old-1"));
    copyFileSync(join(dir, "tasksw-next.exe"), join(bin, "tasksw.exe"));
  }
  setTimeout(() => {
    line({ ev: "end", n: starts, t: Date.now(), exit: step.exit });
    process.exit(step.exit);
  }, step.ms ?? 0);
}

switch (command) {
  case "argv":
    process.stdout.write(
      `${JSON.stringify({
        args: rest,
        execArgv: process.execArgv,
        execPath: process.execPath,
        env: launcherVariables(),
      })}\n`,
    );
    break;
  case "env": {
    const names = Object.keys(process.env);
    process.stdout.write(
      `${JSON.stringify({
        names: names.filter((name) => /^(node|openssl)_/i.test(name)).sort(),
        passed: Object.fromEntries(
          names
            .filter((name) => /^(https?_proxy|no_proxy|ssl_cert_(file|dir))$/i.test(name))
            .map((name) => [name, process.env[name]]),
        ),
        extraCertificates: getCACertificates("extra").length,
        prefixedNames: names.filter((name) => /^tasks_/i.test(name)).sort(),
        launcher: launcherVariables(),
      })}\n`,
    );
    break;
  }
  case "exit":
    process.exitCode = Number.parseInt(rest[0] ?? "0", 10);
    break;
  case "version":
    process.stdout.write(`${JSON.stringify({ version: version(), execPath: process.execPath })}\n`);
    break;
  case "wait":
    process.stdout.write(`${String(process.pid)}\n`);
    stayAlive();
    break;
  case "detach": {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      // eslint-disable-next-line no-restricted-syntax -- an idle Node, which starts nothing.
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    process.stdout.write(`${String(process.pid)} ${String(child.pid)}\n`);
    stayAlive();
    break;
  }
  case "serve":
    serve();
    break;
  default:
    process.stderr.write(
      "usage: tasks argv|env|exit|version|wait|detach|serve (launcher test stub)\n",
    );
    process.exitCode = 64;
}
