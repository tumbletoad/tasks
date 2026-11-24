// `ttasks` (A2 3.10): one command. The generated operation verbs come from the registry's
// `cli-spec.json` (A3 3.2.2); the local commands are routed here.
//
// Every operation verb, `ttasks space`, `ttasks roots` and `ttasks view` go through the service: the CLI opens no space database
// itself. These work without a service, by design: `ttasks` alone and `ttasks help` (they print the
// service's state from service.json), `ttasks version`, `ttasks doctor` (a stopped or untrusted
// service is what it diagnoses) and `ttasks serve` (it is the service).
//
// The two verbs other steps brought: `ttasks service` (M1.12) and `ttasks mcp` (the bridge, M2.01).
//
// `ttasks mcp` takes its arguments unparsed: they are the bridge's, so it is routed before the
// CLI's options are split, and an option of the CLI's before it is a usage error. bin.ts hands
// over to the bridge before it loads this module at all (mcp.ts); this route is the same verb for
// callers of main().
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { splitGlobals, takesFolder, UsageError, verbSpec, type Globals } from "./args.ts";
import { briefCommand, type BriefOptions } from "./brief.ts";
import { folderVerb } from "./folders.ts";
import { prefsVerb } from "./prefs-file.ts";
import { CLI_BUILD, readServiceRecord, stateDir } from "./connect.ts";
import { doctor, type DoctorOptions } from "./doctor.ts";
import { helpText, localCommand, shortHelp } from "./help.ts";
import type { Io } from "./io.ts";
import { isBridge, runBridge } from "./mcp.ts";
import { openCommand, servicePortCommand, type OpenOptions } from "./open.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { rootsCommand } from "./roots.ts";
import { runCommand } from "./runs.ts";
import { refusedArgument, refusedGlobal, serviceCommand, serviceUsage } from "./service.ts";
import { setupCommand, type SetupOptions } from "./setup.ts";
import { skillsCommand } from "./skills.ts";
import { spaceCommand } from "./space.ts";
import { undoCommand } from "./undo.ts";
import { asAppError, runVerb } from "./verbs.ts";
import { viewCommand } from "./view.ts";

export type { Io } from "./io.ts";

export interface MainOptions extends DoctorOptions, OpenOptions, SetupOptions, BriefOptions {
  /** Runs `ttasks serve`. The default loads the hub's entry (`@ttasks/service/hub`). */
  readonly serve?: () => Promise<number>;
  /**
   * Runs `ttasks mcp` with the arguments after `mcp`. The default is the bridge on this process's
   * stdio (`@ttasks/bridge/mcp`'s runMcp): 0, 1 or 2.
   */
  readonly mcp?: (argv: readonly string[]) => Promise<number>;
  /**
   * The version folder this CLI runs from: a built version's `lib/ttasks.mjs` passes its own
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
  service: (io, globals, args, options) =>
    serviceCommand(io, globals, args, options.serviceContext),
  // The bridge: the arguments after `mcp`, as they are (A2 3.7.1).
  mcp: (_io, _globals, args, options) => (options.mcp ?? runBridge)(args),
};

const MCP_USAGE =
  "ttasks mcp takes only its own options, after mcp: ttasks mcp [--space <space-id>] [--instance <id>] [--app <name>]";

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

/** Runs one `ttasks` command and returns its exit code (A2 3.10.3). */
export async function main(io: Io, options: MainOptions = {}): Promise<number> {
  const mcp = SLOTS.mcp;
  if (isBridge(io.argv) && mcp !== undefined) {
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
    // Help comes before every command and runs none: `ttasks space restore … --help` changes
    // nothing.
    if (command === "help" || globals.help) {
      // `ttasks help --help` is help's own help.
      const topic = command === "help" ? (args[0] ?? (globals.help ? "help" : undefined)) : command;
      io.stdout(helpText(topic));
      return 0;
    }
    // A person's input is never dropped unread: a command of its own that does not read it is
    // refused it. Every generated verb reads it (runVerb).
    const local = localCommand(command);
    if (globals.input !== undefined && local !== undefined && local.input !== true) {
      return printUsage(io, globals.json, `${CLI_NAME} ${command} takes no --input`);
    }
    switch (command) {
      case "version":
        io.stdout(`${PRODUCT_NAME} ${CLI_BUILD.version} (${CLI_BUILD.build})\n`);
        return 0;
      case "serve": {
        if (args.length > 0) return printUsage(io, globals.json, "ttasks serve takes no arguments");
        const serve =
          options.serve ?? (async () => (await import("@ttasks/service/hub")).runServe());
        return await serve();
      }
      case "space":
        return await spaceCommand(io, globals, args, options);
      // `ttasks recover <space>` is `ttasks space recover <space>` under a second name (A2 3.10.1).
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
      case "skills":
        return await skillsCommand(io, globals, args, options);
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
        // Only with a CLI option before it: `ttasks mcp …` itself was routed above.
        return printUsage(io, globals.json, MCP_USAGE);
      case "service": {
        const refused = refusedGlobal(globals);
        if (refused !== undefined) {
          return serviceUsage(io, globals.json, refusedArgument(args[0], refused));
        }
        // `ttasks service port` is the UI listener's (M2.12), routed ahead of M1.12's slot.
        if (args[0] === "port") {
          return await servicePortCommand(io, globals, args.slice(1), options);
        }
        const slot = SLOTS[command];
        if (slot === undefined) {
          return printUsage(io, globals.json, `${CLI_NAME} ${command} is not in this build yet`);
        }
        return await slot(io, globals, args, options);
      }
      default: {
        const verb = verbSpec(command, args);
        if (verb === undefined) {
          return printUsage(
            io,
            globals.json,
            `${CLI_NAME} has no command ${/^[a-z][a-z0-9-]{0,30}$/.test(command) ? command : "like that"}`,
          );
        }
        if (verb.entry === "launch.open") {
          return await briefCommand(io, globals, verb, args, options);
        }
        if (verb.entry === "history.undo") {
          return await undoCommand(io, globals, verb, args, options);
        }
        if (takesFolder(verb)) return await folderVerb(io, globals, verb, args, options);
        if (verb.entry === "prefs.manage") return await prefsVerb(io, globals, verb, args, options);
        return await runVerb(io, globals, verb, args, options);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    // A failure the command did not turn into a body: its own body, else internal.
    return printError(io, globals.json, bodyOf(asAppError(error)));
  }
}
