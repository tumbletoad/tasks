// `ttasks roots`: retired. A task opens in its own folder or its project's folder on this machine,
// so a root names nothing any more. The command stays as a pointer for people and scripts that
// still call it, and changes nothing: machine.toml's `[roots]` lines are left as they are.
import { CLI_NAME } from "@ttasks/brand";
import type { Globals } from "./args.ts";
import type { Io } from "./io.ts";
import { printUsage } from "./output.ts";

const POINTER =
  "Roots are retired. A task opens in its own folder or its project's folder on this machine, " +
  `and the [roots] lines in machine.toml do nothing. ${CLI_NAME} area lists and makes projects.`;

/** `ttasks roots --help` and `ttasks help roots`. */
export const ROOTS_HELP = `Usage: ${CLI_NAME} roots

${POINTER}
`;

export function rootsCommand(io: Io, globals: Globals, args: readonly string[]): number {
  const [sub] = args;
  // `add` asked for a change that is not made: it fails, so a script that relies on it stops.
  if (sub === "add") return printUsage(io, globals.json, POINTER);
  if (globals.json) io.stdout(`${JSON.stringify({ roots: [], retired: true })}\n`);
  else io.stdout(`${POINTER}\n`);
  return 0;
}
