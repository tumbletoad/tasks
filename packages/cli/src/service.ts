// `tasks service install|uninstall|start|stop|status` (A2 3.3.5): the service install's entries
// (M1.12, `@tasks/service/install`), a local command (A2 3.10.1). The CLI parses its global flags
// (`--json`); the entry takes the verb and `--yes` and `--dry-run`, prints its preview, asks in a
// terminal and returns A2 3.10.3's exit code. It is loaded only for this command: the service
// install reaches parts of the hub that the other verbs never load.
import type { Globals } from "./args.ts";
import type { Io } from "./io.ts";
import { printUsage } from "./output.ts";

export const SERVICE_HELP =
  "Install, uninstall, start, stop or show the service (install|uninstall|start|stop|status, --yes, --dry-run); port <n> [--reuse] moves the UI's port";

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
      "tasks service takes one of install, uninstall, start, stop, status, and the flags --yes and --dry-run",
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
