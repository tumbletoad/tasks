// `ttasks service install|uninstall|start|stop|restart|status` (A2 3.3.5): the service install's entries
// (M1.12, `@ttasks/service/install`), a local command (A2 3.10.1). The CLI parses its global flags
// (`--json`); the entry takes the verb and `--yes` and `--dry-run`, prints its preview, asks in a
// terminal and returns A2 3.10.3's exit code. It is loaded only for this command: the service
// install reaches parts of the hub that the other verbs never load.
import { CLI_NAME } from "@ttasks/brand";
import type { ServiceContext } from "@ttasks/service/install";
import type { Globals } from "./args.ts";
import type { Io } from "./io.ts";
import { printError } from "./output.ts";

export const SERVICE_HELP = `Usage: ${CLI_NAME} service <command> [--json]

  install [--yes] [--dry-run]    Make the OS start the service when you sign in, and start it
  uninstall [--yes] [--dry-run]  Take that entry out again, and stop the service
  start                          Start the service through the OS and wait until it is ready
  stop                           Stop the service and wait until it has stopped
  restart                        Stop, then start: the service runs the installed version after it
  status                         The entry, the service, its spaces and the UI's address
  port <n> [--reuse [--yes]]     Move the UI to another port; the service restarts

install and uninstall show what they will change and ask once: --yes applies without asking (for a
script), --dry-run only shows it. A restart ends background runs, whose answers so far are kept.
Agent sessions keep running and reconnect, and open pages offer a reload.
`;

const VERBS = ["install", "uninstall", "start", "stop", "restart", "status", "port"];

/** A usage error (exit 2) of `ttasks service`, which points to its own help. */
export const serviceUsage = (io: Io, json: boolean, message: string): number =>
  printError(io, json, {
    code: "invalid_input",
    message,
    hint: `Run ${CLI_NAME} service --help for its commands and options.`,
  });

/**
 * The words for an argument `ttasks service <verb>` does not take: the option by its name, or no
 * word of it when it is not a plain option word (argv can hold task text).
 */
export function refusedArgument(verb: string | undefined, token: string): string {
  if (verb === undefined || !VERBS.includes(verb)) {
    return `${CLI_NAME} service takes one of ${VERBS.join(", ")}`;
  }
  return /^--?[A-Za-z][A-Za-z0-9-]{0,40}$/.test(token)
    ? `${CLI_NAME} service ${verb} has no option ${token}`
    : `${CLI_NAME} service ${verb} takes no argument like that`;
}

/**
 * The CLI's own option that `ttasks service` refuses, if one was given. A service verb reads only
 * `--json` of them (`--help` is answered before any command runs). Any other is refused, never
 * ignored: `--space` takes the next word as its value, so `stop --space --dry-run` would stop.
 */
export const refusedGlobal = (globals: Globals): string | undefined =>
  globals.given.find((name) => name !== "--json" && name !== "--help" && name !== "-h");

/** Runs `ttasks service <verb> [--yes] [--dry-run]` and returns its exit code. */
export async function serviceCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  context?: () => ServiceContext,
): Promise<number> {
  const install = await import("@ttasks/service/install");
  const parsed = install.parseServiceArgs(args);
  if (parsed === undefined) {
    const [verb, ...rest] = args;
    const token =
      verb === undefined || !install.isServiceVerb(verb)
        ? ""
        : (rest.find((arg) => install.parseServiceArgs([verb, arg]) === undefined) ?? "");
    return serviceUsage(io, globals.json, refusedArgument(verb, token));
  }
  // A question only in a terminal: the entry reads the answer from it.
  const ask = io.tty.stdin && io.tty.stdout ? install.processIO().ask : undefined;
  return install.serviceEntry(
    parsed.verb,
    { ...parsed.flags, json: globals.json || parsed.flags.json === true },
    {
      out: (text) => {
        io.stdout(text);
      },
      err: (text) => {
        io.stderr(text);
      },
      ask,
    },
    context ?? (() => install.defaultServiceContext({ env: io.env })),
  );
}
