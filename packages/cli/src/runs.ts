// `ttasks run` (runs/*): a background run of a task, with the agent working in the task's folder
// on its own, and what a person needs beside it at the command line.
//
//   ttasks run <task> [--instance <id>] [--wait] [<request> | -]
//   ttasks run list [<task>]
//   ttasks run show <run>
//   ttasks run stop <run>
//
// The request is the person's own words for the agent: typed on their own command line (like
// `ttasks add`), or read from stdin with `-`. Without one, the agent works on the task. It reaches
// the agent over its protocol, never on a command line TTasks starts. Only the person starts a run,
// from an interactive command: a run may change anything their agent setup allows, without asking.
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { FINAL_RUN_STATES, RECORDED } from "@ttasks/contracts/runs";
import { isRequestId, REQUEST_ID_RULE, UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage } from "./output.ts";
import { checkedSpace } from "./space.ts";
import { asAppError, newRequestId, readInput } from "./verbs.ts";

/** `ttasks run --help` and `ttasks help run`. */
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
  --input <file>     The start as JSON, - reads it from stdin: task, request, instance and
                     request_id. Arguments set their fields over it.
A run has full access unless its instance names a narrower run_permission: it may do whatever
your agent setup allows, without asking. Only you can start one, from a terminal.
`;

/** How often --wait looks at the run. */
const WAIT_EVERY_MS = 1_000;

/**
 * Where --wait stops: a run that ended, or one the copy of the space served now records as open
 * when its backup was made, which will never move there.
 */
const STOPS_WAITING: ReadonlySet<string> = new Set([...FINAL_RUN_STATES, RECORDED]);

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
export function described(run: Shown): string {
  const out = [runLine(run)];
  const cleanup = typeof run["cleanup"] === "string" ? CLEANUP[run["cleanup"]] : undefined;
  if (cleanup !== undefined) out.push(cleanup);
  if (run["state"] === "unknown") {
    out.push(
      `It could not be stopped: the agent, or something it started, may still be running. Try again with: ${CLI_NAME} run stop ${String(run["id"])}`,
    );
  }
  if (run["state"] === "recorded") {
    out.push("It was open when the backup of this restored copy was made. Nothing of it runs now.");
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
    const cut =
      run["answer_cut"] === true
        ? ` (only its start: it was longer than ${PRODUCT_NAME} keeps)`
        : "";
    out.push("", `${what}${cut}:`, answer);
  }
  return `${out.join("\n")}\n`;
}

/** The fields `--input`'s JSON may give a start, as its arguments do. */
const START_FIELDS: ReadonlySet<string> = new Set(["task", "request", "instance", "request_id"]);

interface Start {
  readonly task: string;
  readonly instance: string | undefined;
  readonly request: string | undefined;
  readonly requestId: string | undefined;
  readonly wait: boolean;
}

/**
 * A start from `--input`'s JSON and the arguments, which set their fields over it as with every
 * other verb: `<task>`, then `<request>` (`-` reads stdin), `--instance`, `--wait`.
 */
async function startOf(io: Io, globals: Globals, args: readonly string[]): Promise<Start> {
  const base = globals.input === undefined ? {} : await readInput(io, globals.input);
  for (const [field, value] of Object.entries(base)) {
    if (!START_FIELDS.has(field)) {
      throw new UsageError(
        `${CLI_NAME} run takes no ${/^[a-z_]{1,40}$/.test(field) ? field : "such field"} in --input: it takes task, request, instance and request_id`,
      );
    }
    if (typeof value !== "string") throw new UsageError(`--input's ${field} is a text`);
  }
  const from = (field: string): string | undefined => base[field] as string | undefined;
  let instance = from("instance");
  let wait = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--instance") {
      instance = args[i + 1];
      i += 1;
      if (instance === undefined)
        throw new UsageError(`${CLI_NAME} run --instance takes an instance ID`);
    } else if (arg === "--wait") wait = true;
    else if (arg.startsWith("--"))
      throw new UsageError(`${CLI_NAME} run takes --instance and --wait`);
    else words.push(arg);
  }
  if (words.length > 2) {
    throw new UsageError(
      `${CLI_NAME} run takes the request as one argument: put it in quotes, or use -`,
    );
  }
  const task = words[0] ?? from("task");
  if (task === undefined)
    throw new UsageError(`${CLI_NAME} run takes a task, or list, show or stop`);
  if (instance !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) {
    throw new UsageError(`${CLI_NAME} run --instance takes an instance ID`);
  }
  let request = words[1] ?? from("request");
  if (words[1] === "-") {
    if (globals.input === "-") throw new UsageError("Only one argument can read stdin");
    request = (await io.readStdin()).trim();
  }
  const givenId = from("request_id");
  if (givenId !== undefined && !isRequestId(givenId)) {
    throw new UsageError(`--input's request_id ${REQUEST_ID_RULE}`);
  }
  if (givenId !== undefined && globals.requestId !== undefined && givenId !== globals.requestId) {
    throw new UsageError("--request-id and --input name two request IDs");
  }
  return { task, instance, request, requestId: globals.requestId ?? givenId, wait };
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
  // Every request of the verb goes to one space: the one the person named, then the one the start
  // was queued in, so a default that changes meanwhile moves nothing.
  let space: { space?: string } = {};
  try {
    const named = await checkedSpace(io, globals, undefined, call);
    if (named !== undefined) space = { space: named };
    const [first, ...rest] = args;
    if ((first === "list" || first === "show" || first === "stop") && globals.input !== undefined) {
      throw new UsageError(`${CLI_NAME} run ${first} takes no --input`);
    }
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
    const { task, instance, request, requestId: givenId, wait } = await startOf(io, globals, args);
    // A start whose answer was lost may have queued the run: the same request ID finds it and
    // starts nothing twice. A script keeps the ID; a person reads it when a retry is the way out.
    const requestId = givenId ?? newRequestId();
    if (givenId === undefined && globals.json && !globals.quiet) {
      io.stderr(`request ${requestId}\n`);
    }
    const retry = globals.quiet ? undefined : `Retry with: --request-id ${requestId}\n`;
    let started: Shown;
    try {
      io.onInterrupt?.(retry);
      started = await call("runs/start", {
        ...space,
        task,
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
    if (typeof started["space"] === "string") space = { space: started["space"] };
    // As the person can paste it: with the space they chose, which need not be the default.
    const look = `${CLI_NAME} run show ${id}${named === undefined || space.space === undefined ? "" : ` --space ${space.space}`}`;
    if (!wait) {
      if (globals.json) io.stdout(`${JSON.stringify(started)}\n`);
      else {
        io.stdout(`${runLine(started)}\n`);
        io.stderr(`See it with: ${look}\n`);
      }
      return 0;
    }
    io.onInterrupt?.(`The run goes on. See it with: ${look}`);
    for (;;) {
      const shown = await call("runs/show", { ...space, run: id });
      if (STOPS_WAITING.has(String(shown["state"]))) {
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
