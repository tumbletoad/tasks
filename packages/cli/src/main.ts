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
import { PRODUCT_NAME } from "@tasks/brand";
import {
  CLI_SPEC,
  splitGlobals,
  UsageError,
  verbSpec,
  type Globals,
  type VerbSpec,
} from "./args.ts";
import { briefCommand, type BriefOptions } from "./brief.ts";
import { CLI_BUILD, readServiceRecord, stateDir } from "./connect.ts";
import { doctor, type DoctorOptions } from "./doctor.ts";
import { IMPORT_HELP, importCommand } from "./import.ts";
import type { Io } from "./io.ts";
import { MCP_VERB, runBridge } from "./mcp.ts";
import { openCommand, servicePortCommand, type OpenOptions } from "./open.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { ROOTS_HELP, rootsCommand } from "./roots.ts";
import { SERVICE_HELP, serviceCommand } from "./service.ts";
import { SETUP_HELP, setupCommand, type SetupOptions } from "./setup.ts";
import { SPACE_HELP, spaceCommand } from "./space.ts";
import { asAppError, runVerb } from "./verbs.ts";
import { VIEW_HELP, viewCommand } from "./view.ts";

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

const LOCAL: readonly [string, string][] = [
  ["open", "Open the UI in the browser (--space, --task, --print-url)"],
  ["service", SERVICE_HELP],
  ["space", "List, create, open, close, back up, restore, claim and recover spaces"],
  ["roots", "List and add this machine's roots, the folders places live under"],
  ["view", "Check a space's generated view/ and render it again (view rebuild)"],
  ["import", "Preview the import of the Planning prototype (import planning <folder> --dry-run)"],
  [
    "setup",
    "Connect this machine's agent apps: Open's instances (setup instances), their MCP entries (setup agents), T3 Code (setup t3)",
  ],
  ["mcp", "Connect an agent app to the service over stdio (its MCP server entry runs this)"],
  ["doctor", "Check the install, the service and the agent apps (--self-test, --live, --json)"],
  ["install", "Finish an install: the install scripts run tasks install --finish"],
  ["update", "Update from a signed release archive (--from <archive>), --rollback or --repair"],
  ["serve", "Run the service (for service managers)"],
  ["version", "Print this CLI's version"],
  ["help", "Show help, or help for one command"],
];

function serviceLine(io: Io): string {
  try {
    const record = readServiceRecord(stateDir(io));
    if (record === undefined)
      return `${PRODUCT_NAME}'s service is not running. Start it with: tasks service start`;
    return `${PRODUCT_NAME}'s service is ${String(record.state)} (${String(record.version)}, PID ${String(record.pid)}).`;
  } catch {
    return `${PRODUCT_NAME}'s folders cannot be found.`;
  }
}

function shortHelp(): string {
  const width = Math.max(
    ...CLI_SPEC.verbs.map((v) => v.verb.length),
    ...LOCAL.map(([n]) => n.length),
  );
  const lines = [
    "Usage: tasks <command> [arguments] [--json] [--space <id or name>] [--request-id <id>]",
    "",
  ];
  for (const verb of [...CLI_SPEC.verbs].sort((a, b) => a.verb.localeCompare(b.verb))) {
    lines.push(`  ${verb.verb.padEnd(width)}  ${verb.summary}`);
  }
  lines.push("");
  for (const [name, summary] of LOCAL) lines.push(`  ${name.padEnd(width)}  ${summary}`);
  return `${lines.join("\n")}\n`;
}

function verbHelp(verb: VerbSpec): string {
  const usage = [
    `tasks ${verb.verb}`,
    ...verb.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`)),
    ...(verb.keyValue === undefined ? [] : ["[key=value ...]"]),
    "[options]",
  ].join(" ");
  const lines = [`Usage: ${usage}`, "", verb.summary, ""];
  for (const p of verb.positionals) lines.push(`  <${p.name}>  ${p.help}`);
  for (const k of verb.keyValue?.keys ?? []) lines.push(`  ${k.key}=  ${k.help}`);
  for (const f of verb.flags) {
    const values = f.values === undefined ? "" : ` (${f.values.map(String).join(", ")})`;
    lines.push(
      `  ${f.short === undefined ? "" : `${f.short}, `}${f.flag}${f.repeat ? " (repeatable)" : ""}  ${f.help}${values}`,
    );
  }
  // `tasks brief --copy` is the CLI's own: the OS's clipboard tool, else the text printed.
  if (verb.entry === "launch.open") {
    lines.push("  --copy  Put the text on the clipboard instead of printing it");
  }
  lines.push(
    "  --input <file or ->  The whole input as JSON",
    "  --json  Print the result as JSON",
  );
  if (verb.actors === "user")
    lines.push("", "Only the user can run this, in an interactive terminal.");
  return `${lines.join("\n")}\n`;
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
  const [command, ...args] = rest;
  try {
    if (command === undefined) {
      io.stdout(`${serviceLine(io)}\n\n${shortHelp()}`);
      return 0;
    }
    // Help comes before every command and runs none: `tasks space restore … --help` changes
    // nothing.
    if (command === "help" || globals.help) {
      const topic = command === "help" ? args[0] : command;
      const verb = topic === undefined ? undefined : verbSpec(topic);
      io.stdout(
        topic === "space"
          ? SPACE_HELP
          : topic === "roots"
            ? ROOTS_HELP
            : topic === "view"
              ? VIEW_HELP
              : topic === "setup"
                ? SETUP_HELP
                : topic === "import"
                  ? IMPORT_HELP
                  : verb === undefined
                    ? shortHelp()
                    : verbHelp(verb),
      );
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
      case "roots":
        return await rootsCommand(io, globals, args, options);
      case "view":
        return await viewCommand(io, globals, args, options);
      case "import":
        return await importCommand(io, globals, args, options);
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
        return await runVerb(io, globals, verb, args, options);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    // A failure the command did not turn into a body: its own body, else internal.
    return printError(io, globals.json, bodyOf(asAppError(error)));
  }
}
