// `tasks session` (A3 3.7.3 "Rebinding", M4.06): the user ends, unbinds or rebinds an agent
// session. The service carries them out through its `session/*` methods (hub/session-verbs.ts),
// which refuse every caller but a person at a terminal. A task's sessions and their IDs are its
// sessions section: `tasks show <task> --section sessions`.
//
//   tasks session end <session>
//   tasks session unbind <session>
//   tasks session rebind <session> <task>
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage, str } from "./output.ts";
import { asAppError } from "./verbs.ts";

/** `tasks session --help` and `tasks help session`. */
export const SESSION_HELP = `Usage: tasks session <command> <session> [<task>] [--json]

  end <session>            End an agent session: its agent hears that its session ended
  unbind <session>         Unbind an agent session: its agent goes on without a task
  rebind <session> <task>  Move an agent session to another task of its space

<session> is a session ID (se_...). A task's sessions are listed by:
  tasks show <task> --section sessions
Only the user can change a session, in an interactive terminal.
`;

const WORDS: Readonly<Record<string, string>> = {
  ended: "Ended session",
  unbound: "Unbound session",
  rebound: "Rebound session",
};

export async function sessionCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  connect: ConnectOptions,
): Promise<number> {
  const [sub, ...rest] = args;
  let session: Session | undefined;
  try {
    if (rest.some((arg) => arg.startsWith("--"))) {
      throw new UsageError("tasks session takes no options of its own besides --json");
    }
    let method: string;
    let params: Record<string, unknown>;
    switch (sub) {
      case "end":
      case "unbind": {
        if (rest.length !== 1) throw new UsageError(`tasks session ${sub} takes <session>`);
        method = `session/${sub}`;
        params = { session: rest[0] };
        break;
      }
      case "rebind": {
        if (rest.length !== 2) throw new UsageError("tasks session rebind takes <session> <task>");
        method = "session/rebind";
        params = { session: rest[0], task: rest[1] };
        break;
      }
      default:
        throw new UsageError("tasks session has end, unbind and rebind");
    }
    session = await connectService(io, connect);
    const result = (await session.call(method, params, {
      timeoutMs: globals.timeoutS * 1000,
    })) as Record<string, unknown>;
    if (globals.json) {
      io.stdout(`${JSON.stringify(result)}\n`);
      return 0;
    }
    const id = str(result["session"]);
    if (result["result"] === "no_change") {
      io.stdout(`No change: session ${id} is already so.\n`);
      return 0;
    }
    const word = WORDS[str(result["result"])] ?? "Changed session";
    io.stdout(
      result["next"] === undefined
        ? `${word} ${id}.\n`
        : `${word} ${id}: it goes on as ${str(result["next"])} on ${str(result["task"])}.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
