// `tasks` (A2 3.10): one command. The generated operation verbs come from the registry's
// `cli-spec.json` (A3 3.2.2); the local commands are routed here.
//
// Every operation verb, `tasks space`, `tasks roots` and `tasks view` go through the service: the CLI opens no space database
// itself. These work without a service, by design: `tasks` alone and `tasks help` (they print the
// service's state from service.json), `tasks version`, `tasks doctor` (a stopped or untrusted
// service is what it diagnoses) and `tasks serve` (it is the service).
//
// The two verbs other steps brought: `tasks service` (M1.12) and `tasks mcp` (the bridge, M2.01).
//
// `tasks mcp` takes its arguments unparsed: they are the bridge's, so it is routed before the
// CLI's options are split, and an option of the CLI's before it is a usage error. bin.ts hands
// over to the bridge before it loads this module at all (mcp.ts); this route is the same verb for
// callers of main().
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import { splitGlobals, takesFolder, UsageError, verbSpec, type Globals } from "./args.ts";
import { briefCommand, type BriefOptions } from "./brief.ts";
import { folderVerb } from "./folders.ts";
import { CLI_BUILD, readServiceRecord, stateDir } from "./connect.ts";
import { doctor, type DoctorOptions } from "./doctor.ts";
import { helpText, shortHelp } from "./help.ts";
import type { Io } from "./io.ts";
import { MCP_VERB, runBridge } from "./mcp.ts";
import { openCommand, servicePortCommand, type OpenOptions } from "./open.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { rootsCommand } from "./roots.ts";
import { runCommand } from "./runs.ts";
import { serviceCommand } from "./service.ts";
import { setupCommand, type SetupOptions } from "./setup.ts";
import { spaceCommand } from "./space.ts";
import { undoCommand } from "./undo.ts";
import { asAppError, runVerb } from "./verbs.ts";
import { viewCommand } from "./view.ts";

export type { Io } from "./io.ts";

export interface MainOptions extends DoctorOptions, OpenOptions, SetupOptions, BriefOptions {
  /** Runs `tasks serve`. The default loads the hub's entry (`@tasks/service/hub`). */
  readonly serve?: () => Promise<number>;
  /**
   * Runs `tasks mcp` with the arguments after `mcp`. The default is the bridge on this process's
   * stdio (`@tasks/bridge/mcp`'s runMcp): 0, 1 or 2.
   */
  readonly mcp?: (argv: readonly string[]) => Promise<number>;
  /**
   * The version folder this CLI runs from: a built version's `lib/tasks.mjs` passes its own
   * (entry.ts). Absent when the CLI runs from source. doctor checks it (integrity, runtime gate).
   */
  readonly versionFolder?: string;
}

type Command = (
  io: Io,
  globals: Globals,
  args: readonly string[],
  options: MainOptions,
) => Promise<number>;

/** Routing slots that later steps fill: a function per local command group. */
export const SLOTS: Record<"service" | "mcp", Command | undefined> = {
  service: (io, globals, args) => serviceCommand(io, globals, args),
  // The bridge: the arguments after `mcp`, as they are (A2 3.7.1).
  mcp: (_io, _globals, args, options) => (options.mcp ?? runBridge)(args),
};

const MCP_USAGE =
  "tasks mcp takes only its own options, after mcp: tasks mcp [--space <space-id>] [--instance <id>] [--app <name>]";

function serviceLine(io: Io): string {
  try {
    const record = readServiceRecord(stateDir(io));
    if (record === undefined)
      return `${PRODUCT_NAME}'s service is not running. Start it with: ${CLI_NAME} service start`;
    return `${PRODUCT_NAME}'s service is ${String(record.state)} (${String(record.version)}, PID ${String(record.pid)}).`;
  } catch {
    return `${PRODUCT_NAME}'s folders cannot be found.`;
  }
}

/** Runs one `tasks` command and returns its exit code (A2 3.10.3). */
export async function main(io: Io, options: MainOptions = {}): Promise<number> {
  const mcp = SLOTS.mcp;
  if (io.argv[0] === MCP_VERB && mcp !== undefined) {
    return await mcp(io, splitGlobals([]).globals, io.argv.slice(1), options);
  }
  let split: ReturnType<typeof splitGlobals>;
  try {
    split = splitGlobals(io.argv);
  } catch (error) {
    if (error instanceof UsageError)
      return printUsage(io, io.argv.includes("--json"), error.message);
    throw error;
  }
  const { globals, rest } = split;
  const [typed, ...args] = rest;
  // `--version` is how every command-line program is asked for its version.
  const command = typed === "--version" ? "version" : typed;
  try {
    if (command === undefined) {
      io.stdout(`${serviceLine(io)}\n\n${shortHelp()}`);
      return 0;
    }
    // Help comes before every command and runs none: `tasks space restore … --help` changes
    // nothing.
    if (command === "help" || globals.help) {
      // `tasks help --help` is help's own help.
      const topic = command === "help" ? (args[0] ?? (globals.help ? "help" : undefined)) : command;
      io.stdout(helpText(topic));
      return 0;
    }
    switch (command) {
      case "version":
        io.stdout(`${PRODUCT_NAME} ${CLI_BUILD.version} (${CLI_BUILD.build})\n`);
        return 0;
      case "serve": {
        if (args.length > 0) return printUsage(io, globals.json, "tasks serve takes no arguments");
        const serve =
          options.serve ?? (async () => (await import("@tasks/service/hub")).runServe());
        return await serve();
      }
      case "space":
        return await spaceCommand(io, globals, args, options);
      // `tasks recover <space>` is `tasks space recover <space>` under a second name (A2 3.10.1).
      case "recover":
        return await spaceCommand(io, globals, ["recover", ...args], options);
      case "roots":
        return rootsCommand(io, globals, args);
      case "view":
        return await viewCommand(io, globals, args, options);
      case "run":
        return await runCommand(io, globals, args, options);
      case "setup":
        return await setupCommand(io, globals, args, options);
      case "doctor":
        return await doctor(io, globals, args, options);
      case "install":
        // The install scripts' hand-over (M1.14). Loaded only for this command: it loads storage.
        return await (
          await import("./install.ts")
        ).installCommand(io, globals, args, options.versionFolder);
      case "update":
        // The updater (M6.12). Loaded only for this command: it loads storage for its lock.
        return await (
          await import("./update.ts")
        ).updateCommand(io, globals, args, options.versionFolder);
      case "open":
        return await openCommand(io, globals, args, options);
      case "mcp":
        // Only with a CLI option before it: `tasks mcp …` itself was routed above.
        return printUsage(io, globals.json, MCP_USAGE);
      case "service": {
        // `tasks service port` is the UI listener's (M2.12), routed ahead of M1.12's slot.
        if (args[0] === "port") {
          return await servicePortCommand(io, globals, args.slice(1), options);
        }
        const slot = SLOTS[command];
        if (slot === undefined) {
          return printUsage(io, globals.json, `tasks ${command} is not in this build yet`);
        }
        return await slot(io, globals, args, options);
      }
      default: {
        const verb = verbSpec(command);
        if (verb === undefined) {
          return printUsage(
            io,
            globals.json,
            `tasks has no command ${/^[a-z][a-z0-9-]{0,30}$/.test(command) ? command : "like that"}`,
          );
        }
        if (verb.entry === "launch.open") {
          return await briefCommand(io, globals, verb, args, options);
        }
        if (verb.entry === "history.undo") {
          return await undoCommand(io, globals, verb, args, options);
        }
        if (takesFolder(verb)) return await folderVerb(io, globals, verb, args, options);
        return await runVerb(io, globals, verb, args, options);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    // A failure the command did not turn into a body: its own body, else internal.
    return printError(io, globals.json, bodyOf(asAppError(error)));
  }
}
