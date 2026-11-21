// `ttasks view` (A1 3.13, M3.10): the space's generated view, `view/`. The service carries it out
// through its `view/rebuild` method (hub/space-verbs.ts); the CLI opens no space database.
//
//   tasks view rebuild [<space>]
//
// A rebuild looks at every file the projection placed and queues every task to render again. It
// removes nothing the projection cannot prove it wrote: a file a person changed or added stays, or
// is moved aside to the space's exchange/rescued/ where a generated file goes. Only the user runs
// it, in an interactive terminal.
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { whichSpace } from "./space.ts";
import { asAppError } from "./verbs.ts";

/** `ttasks view --help` and `ttasks help view`. */
export const VIEW_HELP = `Usage: ttasks view <command> [arguments] [--json]

  rebuild [<space>]    Check every file of the space's view/ and render every task again

A rebuild removes nothing it cannot prove it wrote: a file you changed or added stays where it is,
or is moved to the space's exchange/rescued/ when a generated file needs its place.
<space> is an ID, a name or a folder. Only the user can run this, in an interactive terminal.
`;

export async function viewCommand(
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
      timeoutMs: Math.max(globals.timeoutS, 120) * 1000,
    })) as Record<string, unknown>;
  };
  try {
    if (sub !== "rebuild") throw new UsageError("ttasks view has rebuild");
    if (rest.some((token) => token.startsWith("--")) || rest.length > 1) {
      throw new UsageError("ttasks view rebuild takes at most one <space>");
    }
    const result = await call("view/rebuild", {
      space: await whichSpace(io, globals, rest[0], call),
    });
    if (globals.json) io.stdout(`${JSON.stringify(result)}\n`);
    else {
      const checked = Number(result["checked"]);
      const queued = Number(result["queued"]);
      const files = checked === 1 ? "1 generated file" : `${String(checked)} generated files`;
      const tasks = queued === 1 ? "1 task is" : `${String(queued)} tasks are`;
      io.stdout(`Checked ${files}. ${tasks} rendered again in the background.\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
