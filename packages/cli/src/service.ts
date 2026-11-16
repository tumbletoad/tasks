// `tasks service install|uninstall|start|stop|restart|status` (A2 3.3.5): the service install's entries
// (M1.12, `@tasks/service/install`), a local command (A2 3.10.1). The CLI parses its global flags
// (`--json`); the entry takes the verb and `--yes` and `--dry-run`, prints its preview, asks in a
// terminal and returns A2 3.10.3's exit code. It is loaded only for this command: the service
// install reaches parts of the hub that the other verbs never load.
import { CLI_NAME } from "@tasks/brand";
import type { Globals } from "./args.ts";
import type { Io } from "./io.ts";
import { printUsage } from "./output.ts";

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

/** Runs `tasks service <verb> [--yes] [--dry-run]` and returns its exit code. */
export async function serviceCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
): Promise<number> {
  const install = await import("@tasks/service/install");
  const parsed = install.parseServiceArgs(args);
  if (parsed === undefined) {
    // Like every usage error, it names what is accepted and quotes nothing that was typed.
    return printUsage(
      io,
      globals.json,
      "tasks service takes one of install, uninstall, start, stop, restart, status, and the flags --yes and --dry-run",
    );
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
    () => install.defaultServiceContext({ env: io.env }),
  );
}
