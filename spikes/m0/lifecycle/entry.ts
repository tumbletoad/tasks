// The lab release's `lib/ttasks.mjs` (M0.07). `make-release.ts` puts it, `supervisor.mjs` and the
// built kit (`lib/kit/*.mjs`) into a copy of the packaging spike's version folder, so the installed
// launchers run the kit the way the product's launchers will run `ttasks`:
//   ttasks service|call|open|ticket|run-shim|accounts|tree ...   the kit's command line
//   ttasks mcp --state <dir> [--reconnect]                         the spike bridge (forwarder)
//   ttasks shim --state <dir> <ticket>                             the stand-in interactive shim
//   tasks supervise [--state <dir>]                               the ttasksw.exe loop stand-in
//   ttasksw.exe with no arguments                                  the same, as the Run value starts it
//   ttasks version | wait | gate | install --finish                as in the packaging spike
// The kit modules are loaded only for the command that needs them, like the product entry.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { runSupervisor } from "./supervisor.ts";

const [command = "", ...rest] = process.argv.slice(2);

const load = (file: string) => import(new URL(file, import.meta.url).href);

function option(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
}

/** The install root and the default service state folder, from the launcher's variables. */
function defaults(): { root: string; state: string } | undefined {
  const root = process.env["TTASKS_ROOT"];
  if (root === undefined || root === "") return undefined;
  return { root, state: option("--state") ?? join(root, "state", "service") };
}

const launcher = (process.env["TTASKS_LAUNCHER"] ?? "").toLowerCase();
const stableTasksw =
  launcher.endsWith("ttasksw.exe") && process.env["TTASKS_LAUNCH_MODE"] === "stable";

switch (command) {
  case "service":
  case "call":
  case "open":
  case "ticket":
  case "run-shim":
  case "accounts":
  case "tree":
    await load("./kit/kit.mjs");
    break;
  case "mcp":
    await load("./kit/forwarder.mjs");
    break;
  case "shim":
    await load("./kit/shim.mjs");
    break;
  case "":
  case "supervise": {
    // A2 3.3.2: ttasksw.exe with no arguments supervises, and only from the stable bin folder.
    const found = defaults();
    if ((command === "" && !stableTasksw) || found === undefined) {
      process.stderr.write("usage: tasks <command> (lab release, M0.07)\n");
      process.exitCode = 64;
      break;
    }
    process.exitCode = await runSupervisor(found.root, found.state);
    break;
  }
  case "version": {
    const manifest = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    ) as { version: unknown };
    process.stdout.write(`${String(manifest.version)}\n`);
    break;
  }
  case "wait":
    process.stdout.write(`${String(process.pid)}\n`);
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    break;
  case "gate":
  case "install": {
    const { main } = (await load(`./${command}.mjs`)) as {
      main: (args: string[]) => Promise<number>;
    };
    process.exitCode = await main(rest);
    break;
  }
  default:
    process.stderr.write("usage: tasks <command> (lab release, M0.07)\n");
    process.exitCode = 64;
}
