// `tasks roots` (A1 3.15; M2.07): this machine's roots, the named folders that places live under.
// The service carries them out through its `roots/*` methods (hub/roots.ts) and edits
// machine.toml; the CLI resolves a folder against its working folder and sends it absolute.
//
//   tasks roots [list]
//   tasks roots add <id> <folder> [--label <text>] [--runs]
//
// Only the user adds a root, in an interactive terminal. `tasks roots rename` (A1 3.15) needs an
// edit that renames a table and a commit that rebinds every place: not built yet.
import { isAbsolute, resolve } from "node:path";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage, str } from "./output.ts";
import { asAppError } from "./verbs.ts";

/** `tasks roots --help` and `tasks help roots`. */
export const ROOTS_HELP = `Usage: tasks roots <command> [arguments] [--json]

  list                                         This machine's roots: ID, label, folder
  add <id> <folder> [--label <text>] [--runs]  Add a root: a named folder that places live under

<id> is lower case: a to z, 0 to 9, _ and -, at most 32 characters, and never changes.
--runs allows background runs under the root (A4). Only the user can add a root, in an
interactive terminal; list works everywhere.
`;

interface RootRow {
  id: string;
  label: string;
  path: string;
  runs: boolean;
  rev?: number;
}

function printRoot(io: Io, row: RootRow, verb: string): void {
  io.stdout(
    `${verb}${row.id}  ${row.label === row.id ? "" : `${row.label}  `}${row.path}${row.runs ? "  (runs allowed)" : ""}\n`,
  );
}

export async function rootsCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  connect: ConnectOptions,
): Promise<number> {
  const [sub, ...rest] = args;
  let session: Session | undefined;
  const call = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    session ??= await connectService(io, connect);
    return (await session.call(method, params, {
      timeoutMs: globals.timeoutS * 1000,
    })) as Record<string, unknown>;
  };
  const out = (result: Record<string, unknown>, text: () => void): void => {
    if (globals.json) io.stdout(`${JSON.stringify(result)}\n`);
    else text();
  };
  try {
    switch (sub) {
      case undefined:
      case "list": {
        if (rest.length > 0) throw new UsageError("tasks roots list takes no arguments");
        const result = await call("roots/list", {});
        out(result, () => {
          const roots = result["roots"] as RootRow[];
          if (roots.length === 0) {
            io.stdout("No roots. Add one with: tasks roots add <id> <folder>\n");
          }
          for (const row of roots) printRoot(io, row, "");
        });
        return 0;
      }
      case "add": {
        const positional: string[] = [];
        let label: string | undefined;
        let runs = false;
        for (let i = 0; i < rest.length; i += 1) {
          const token = rest[i] ?? "";
          if (token === "--runs") runs = true;
          else if (token === "--label" || token.startsWith("--label=")) {
            label = token === "--label" ? rest[(i += 1)] : token.slice("--label=".length);
            if (label === undefined) throw new UsageError("--label needs a value");
          } else if (token.startsWith("--")) {
            throw new UsageError(
              `tasks roots add has no option ${/^--[a-z-]{1,30}$/.test(token) ? token : "like that"}`,
            );
          } else positional.push(token);
        }
        const [id, folder] = positional;
        if (id === undefined || folder === undefined || positional.length > 2) {
          throw new UsageError("tasks roots add takes <id> <folder>");
        }
        const result = await call("roots/add", {
          id,
          path: isAbsolute(folder) ? resolve(folder) : resolve(io.cwd, folder),
          ...(label === undefined ? {} : { label }),
          ...(runs ? { runs } : {}),
        });
        out(result, () => {
          const row = result["root"] as RootRow;
          printRoot(io, row, "Added root ");
          io.stdout(`Places under ${str(row.path)} now bind to ${row.id}.\n`);
        });
        return 0;
      }
      default:
        throw new UsageError("tasks roots has list and add");
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
