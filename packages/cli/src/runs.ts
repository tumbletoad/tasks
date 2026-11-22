// `tasks run` (runs/*): a background run of a task, with the agent working in the task's folder
// on its own, and what a person needs beside it at the command line.
//
//   tasks run <task> [--instance <id>] [--wait] [<request> | -]
//   tasks run list [<task>]
//   tasks run show <run>
//   tasks run stop <run>
//
// The request is the person's own words for the agent: typed on their own command line (like
// `tasks add`), or read from stdin with `-`. Without one, the agent works on the task. It reaches
// the agent over its protocol, never on a command line Tasks starts. Only the person starts a run,
// from an interactive command: a run may change anything their agent setup allows, without asking.
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { asAppError, newRequestId } from "./verbs.ts";

/** `tasks run --help` and `tasks help run`. */
export const RUN_HELP = `Usage: ${CLI_NAME} run <task> [--instance <id>] [--wait] [<request> | -]
       ${CLI_NAME} run list [<task>]
       ${CLI_NAME} run show <run>
       ${CLI_NAME} run stop <run>

  <task>             Start a background run: an agent works on the task in its folder, on its own
  list [<task>]      The newest runs of the space, or of one task, with their state
  show <run>         A run's state and its answer
  stop <run>         Stop a run: the agent is asked to stop, then ended with what it started

  --instance <id>    The agent instance to use, when more than one can run tasks
  --wait             Wait for the run to end and print its answer
  <request>          Your words for the agent; - reads them from stdin. Without them it works
                     on the task.
A run has full access unless its instance names a narrower run_permission: it may do whatever
your agent setup allows, without asking. Only you can start one, from a terminal.
`;

/** How often --wait looks at the run. */
const WAIT_EVERY_MS = 1_000;

const FINAL = new Set(["succeeded", "failed", "timed_out", "cancelled", "unknown"]);

type Shown = Record<string, unknown>;

/** How long a running run has been quiet, from a minute on: then the person may want to stop it. */
function quiet(run: Shown, now: number): string {
  const since = run["quiet_since"];
  if (typeof since !== "number") return "";
  const minutes = Math.floor((now - since) / 60_000);
  return minutes < 1 ? "" : ` (quiet for ${String(minutes)} min)`;
}

/** One line for a run: its ID, task, state and why, and how many of its requests were refused. */
export function runLine(run: Shown, now = Date.now()): string {
  const state = String(run["state"]);
  const reason = typeof run["reason"] === "string" ? ` (${run["reason"]})` : "";
  const waiting = typeof run["waiting"] === "string" ? ` (waits: ${run["waiting"]})` : "";
  const task = typeof run["task"] === "string" ? run["task"] : "-";
  const count = run["refused"];
  const refused = typeof count === "number" && count > 0 ? ` (${String(count)} refused)` : "";
  return `${String(run["id"])}  ${task}  ${String(run["instance"])}  ${state}${reason}${waiting}${quiet(run, now)}${refused}`;
}

const CLEANUP: Readonly<Record<string, string>> = {
  confirmed: "Nothing it started was left.",
  ended_leftovers: "What it left running was ended, and none of it is left.",
  ended_found: `${PRODUCT_NAME} ended what it could find of what it started: without a process group, nothing confirms that none is left.`,
};

/** A run for a person: its line, how its processes ended, then its answer. */
function described(run: Shown): string {
  const out = [runLine(run)];
  const cleanup = typeof run["cleanup"] === "string" ? CLEANUP[run["cleanup"]] : undefined;
  if (cleanup !== undefined) out.push(cleanup);
  if (run["state"] === "unknown") {
    out.push(
      `Not all of what it started was confirmed ended. End it with: ${CLI_NAME} run stop ${String(run["id"])}`,
    );
  }
  if (typeof run["error"] === "string") out.push(`The agent said: ${run["error"]}`);
  const refused = run["refused"];
  if (typeof refused === "number" && refused > 0) {
    out.push(
      `Its permission refused ${String(refused)} of the agent's requests: it worked without them.`,
    );
  }
  const answer = run["answer"];
  if (typeof answer === "string" && answer !== "") {
    const what =
      run["reason"] === "needs_input"
        ? "It needs you"
        : run["answer_final"] === true
          ? "Answer"
          : "Its last message";
    out.push("", `${what}:`, answer);
  }
  return `${out.join("\n")}\n`;
}

export async function runCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  connect: ConnectOptions,
): Promise<number> {
  let session: Session | undefined;
  const call = async (method: string, params: Record<string, unknown>): Promise<Shown> => {
    session ??= await connectService(io, connect);
    return (await session.call(method, params, {
      timeoutMs: Math.max(globals.timeoutS, 60) * 1000,
    })) as Shown;
  };
  const space = globals.space === undefined ? {} : { space: globals.space };
  try {
    const [first, ...rest] = args;
    if (first === undefined)
      throw new UsageError(`${CLI_NAME} run takes a task, or list, show or stop`);
    if (first === "list") {
      if (rest.length > 1 || rest.some((a) => a.startsWith("-"))) {
        throw new UsageError(`${CLI_NAME} run list takes at most one <task>`);
      }
      const listed = await call("runs/list", {
        ...space,
        ...(rest[0] === undefined ? {} : { task: rest[0] }),
      });
      const runs = Array.isArray(listed["runs"]) ? (listed["runs"] as Shown[]) : [];
      if (globals.json) io.stdout(`${JSON.stringify(listed)}\n`);
      else
        io.stdout(
          runs.length === 0 ? "No runs.\n" : `${runs.map((run) => runLine(run)).join("\n")}\n`,
        );
      return 0;
    }
    if (first === "show" || first === "stop") {
      if (rest.length !== 1 || rest[0]?.startsWith("-") === true) {
        throw new UsageError(`${CLI_NAME} run ${first} takes one <run>`);
      }
      const shown = await call(`runs/${first}`, { ...space, run: rest[0] });
      if (globals.json) io.stdout(`${JSON.stringify(shown)}\n`);
      else io.stdout(first === "show" ? described(shown) : `${runLine(shown)}\n`);
      return 0;
    }
    // A run of a task.
    let instance: string | undefined;
    let wait = false;
    const words: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] ?? "";
      if (arg === "--instance") {
        instance = rest[i + 1];
        i += 1;
        if (instance === undefined || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) {
          throw new UsageError(`${CLI_NAME} run --instance takes an instance ID`);
        }
      } else if (arg === "--wait") wait = true;
      else if (arg.startsWith("--"))
        throw new UsageError(`${CLI_NAME} run takes --instance and --wait`);
      else words.push(arg);
    }
    if (words.length > 1) {
      throw new UsageError(
        `${CLI_NAME} run takes the request as one argument: put it in quotes, or use -`,
      );
    }
    const given = words[0];
    const request = given === "-" ? (await io.readStdin()).trim() : given;
    // A start whose answer was lost may have queued the run: the same request ID finds it and
    // starts nothing twice. A script keeps the ID; a person reads it when a retry is the way out.
    const requestId = globals.requestId ?? newRequestId();
    if (globals.requestId === undefined && globals.json && !globals.quiet) {
      io.stderr(`request ${requestId}\n`);
    }
    const retry = globals.quiet ? undefined : `Retry with: --request-id ${requestId}\n`;
    let started: Shown;
    try {
      io.onInterrupt?.(retry);
      started = await call("runs/start", {
        ...space,
        task: first,
        ...(instance === undefined ? {} : { instance }),
        ...(request === undefined || request === "" ? {} : { request }),
        request_id: requestId,
      });
    } catch (error) {
      const body = bodyOf(asAppError(error));
      if (retry !== undefined && body.data?.["retryable"] === true) io.stderr(retry);
      return printError(io, globals.json, body);
    } finally {
      io.onInterrupt?.(undefined);
    }
    const id = String(started["id"]);
    if (!wait) {
      if (globals.json) io.stdout(`${JSON.stringify(started)}\n`);
      else {
        io.stdout(`${runLine(started)}\n`);
        io.stderr(`See it with: ${CLI_NAME} run show ${id}\n`);
      }
      return 0;
    }
    io.onInterrupt?.(`The run goes on. See it with: ${CLI_NAME} run show ${id}`);
    for (;;) {
      const shown = await call("runs/show", { ...space, run: id });
      if (FINAL.has(String(shown["state"]))) {
        io.stdout(globals.json ? `${JSON.stringify(shown)}\n` : described(shown));
        return shown["state"] === "succeeded" ? 0 : 1;
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_EVERY_MS));
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    io.onInterrupt?.(undefined);
    session?.close();
  }
}
