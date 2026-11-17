// A generated verb (A2 3.10.1, A3 3.4.13): its arguments into the entry's input, the fields the CLI
// fills itself (A3 3.2.2's `auto`), one `op/call`, and the result printed.
//
// Retries. A write gets a request ID from --request-id, or a new one that the CLI prints on stderr
// with --json, and on a failure or a Ctrl+C after which the write may have applied, so a retry can
// pass it. A write that needs a base reads one only when no
// receipt exists: with --request-id the CLI first asks for the receipt in its own writer scope
// (`receipt.get`), and when there is one it sends the same input with the receipt's `as_of` as
// base. The receipt's fingerprint covers the input without the base, so the service replays the
// stored result and nothing is expanded again. Without a receipt it reads the task and sends that
// read's `as_of`.
import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { LocalError } from "@tasks/bridge/protocol";
import type { ErrorBody } from "@tasks/contracts";
import {
  isRequestId,
  parseVerb,
  REQUEST_ID_RULE,
  UsageError,
  writes,
  type Globals,
  type VerbSpec,
} from "./args.ts";
import { connectService, transportError, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage, render } from "./output.ts";

/** A new request ID: 128 random bits, 22 characters from A3 3.4.1's alphabet. */
export const newRequestId = (): string => randomBytes(16).toString("base64url");

/** A transport failure from the client library, as A3's body. */
export function asAppError(error: unknown): unknown {
  return error instanceof LocalError
    ? transportError(error.reason, error.retryable, error.detail)
    : error;
}

async function readInput(io: Io, source: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text =
      source === "-"
        ? await io.readStdin()
        : await io.readFile(isAbsolute(source) ? source : join(io.cwd, source));
  } catch {
    throw new UsageError("--input cannot be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError("--input is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError("--input is not a JSON object");
  }
  return value as Record<string, unknown>;
}

/** A folder value that names itself: `cwd`, or one under `~`, which the service expands. */
const namesItself = (value: string): boolean =>
  value === "cwd" || value === "~" || value.startsWith("~/") || value.startsWith("~\\");

/**
 * A folder given relative to the working folder (`--folder .`, `folder=../portal`) made absolute
 * here, as `tasks space` does with its folders: the service never reads a relative path against its
 * own working folder. Every folder field of the input: organize's `folder`, a task update's
 * `set.folder`, a draft's or a follow-up's `folder`.
 */
function absoluteFolders(input: Record<string, unknown>, cwd: string): void {
  const fix = (holder: unknown): void => {
    if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return;
    const record = holder as Record<string, unknown>;
    const folder = record["folder"];
    if (
      typeof folder === "string" &&
      folder !== "" &&
      !namesItself(folder) &&
      !isAbsolute(folder)
    ) {
      record["folder"] = resolve(cwd, folder);
    }
  };
  fix(input);
  fix(input["set"]);
  for (const list of [input["tasks"], input["follow_ups"]]) {
    if (Array.isArray(list)) list.forEach(fix);
  }
}

/** One `op/call` with the call's time limit. */
export function opCall(
  session: Session,
  globals: Globals,
  op: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return session.call(
    "op/call",
    { op, input, ...(globals.space === undefined ? {} : { space: globals.space }) },
    { timeoutMs: globals.timeoutS * 1000 },
  );
}

/** The space a result names, for a person's output: by its task reference's prefix. */
function spaceName(session: Session, globals: Globals, result: Record<string, unknown>): string {
  const spaces = session.bound.spaces as { id?: string; name?: string; ref_prefix?: string }[];
  const wanted = globals.space;
  if (wanted !== undefined) {
    const found = spaces.find(
      (s) => s.id === wanted || s.name?.toLowerCase() === wanted.toLowerCase(),
    );
    if (found?.name !== undefined) return found.name;
  }
  // `tasks` lists created tasks (`tasks add`) or, for an undo or redo, their references.
  const first = (result["tasks"] as unknown[] | undefined)?.[0];
  const listed = typeof first === "string" ? first : (first as { ref?: string } | undefined)?.ref;
  const ref = (typeof result["task"] === "string" ? result["task"] : listed) ?? "";
  const prefix = ref.slice(0, Math.max(0, ref.indexOf("-")));
  return (
    spaces.find((s) => s.ref_prefix === prefix)?.name ??
    spaces.find((s) => s.name !== undefined)?.name ??
    "the space"
  );
}

/** What a verb adds to the generic path: `tasks undo`'s check and question. */
export interface VerbHooks {
  /** Fills fields of the input that the verb's arguments do not give. */
  readonly input?: (input: Record<string, unknown>) => void;
  /**
   * A failure the verb answers itself: its exit code, or undefined to print it as any other.
   * `again` sends the call once more with `changes` over the input and a new request ID, and
   * prints what it returns. `retry` is what a person adds to the same command to send `changes`,
   * for the retry line of a write that may have applied.
   */
  readonly failed?: (
    body: ErrorBody,
    again: (changes: Record<string, unknown>, retry: readonly string[]) => Promise<number>,
  ) => Promise<number | undefined>;
}

export async function runVerb(
  io: Io,
  given: Globals,
  verb: VerbSpec,
  args: readonly string[],
  options: ConnectOptions,
  present?: (result: Record<string, unknown>, printed: string) => Promise<void>,
  hooks?: VerbHooks,
): Promise<number> {
  // `--space` may name a folder, as the space verbs' <space> does: sent absolute, it names that
  // copy of a space, a read-only copy beside its original too (A2 3.10.5).
  const named = given.space;
  const globals: Globals =
    named !== undefined && (isAbsolute(named) || named.includes("/") || named.includes("\\"))
      ? { ...given, space: resolve(io.cwd, named) }
      : given;
  let input: Record<string, unknown>;
  try {
    const base = globals.input === undefined ? undefined : await readInput(io, globals.input);
    // stdin is read once: by `--input -`, or by one text argument `-`, never both.
    const stdin =
      globals.input === "-"
        ? () => Promise.reject(new UsageError("Only one argument can read stdin"))
        : () => io.readStdin();
    input = (await parseVerb(verb, args, stdin, base)).input;
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    throw error;
  }
  // A mixed verb's read action (`tasks area list`) is a read: no request ID, no base (A3 3.2.3).
  const write = writes(verb, input);
  if (verb.auto.includes("cwd") && input["cwd"] === undefined) input["cwd"] = io.cwd;
  absoluteFolders(input, io.cwd);
  hooks?.input?.(input);
  let generated = false;
  if (write && verb.auto.includes("request_id")) {
    const given = input["request_id"];
    if (globals.requestId !== undefined && given !== undefined && given !== globals.requestId) {
      return printUsage(io, globals.json, "--request-id and --input name two request IDs");
    }
    if (given !== undefined && !isRequestId(given)) {
      return printUsage(io, globals.json, `--input's request_id ${REQUEST_ID_RULE}`);
    }
    if (given === undefined) {
      input["request_id"] = globals.requestId ?? newRequestId();
      generated = globals.requestId === undefined;
    }
  }
  const requestId = isRequestId(input["request_id"]) ? input["request_id"] : undefined;
  // A script (--json) keeps the ID it can retry with. A person reads it only when a retry is the
  // way out: the failure below names it.
  if (write && generated && requestId !== undefined && globals.json && !globals.quiet) {
    io.stderr(`request ${requestId}\n`);
  }

  let session: Session | undefined;
  try {
    session = await connectService(io, options);
    if (write && verb.auto.includes("base") && input["base"] === undefined) {
      // A retry finds its receipt first and reads no fresh base (A3 3.4.1): any request ID the
      // caller gave, through --request-id or --input, may be a retry.
      if (!generated && requestId !== undefined) {
        const receipt = (await opCall(session, globals, "receipt.get", {
          request: requestId,
        })) as {
          found: boolean;
          as_of?: string;
        };
        if (receipt.found && receipt.as_of !== undefined) input["base"] = receipt.as_of;
      }
      if (input["base"] === undefined && typeof input["task"] === "string") {
        const read = (await opCall(session, globals, "task.get", { task: input["task"] })) as {
          as_of?: string;
        };
        if (typeof read.as_of === "string") input["base"] = read.as_of;
      }
      // A change to a group names no task: the person's base is the groups as they are now.
      if (
        input["base"] === undefined &&
        verb.entry === "group.manage" &&
        input["action"] !== "create"
      ) {
        const read = (await opCall(session, globals, "group.manage", { action: "list" })) as {
          as_of?: string;
        };
        if (typeof read.as_of === "string") input["base"] = read.as_of;
      }
    }
    const open = session;
    const send = async (sent: Record<string, unknown>): Promise<number> => {
      const result = (await opCall(open, globals, verb.entry, sent)) as Record<string, unknown>;
      const printed = globals.json
        ? `${JSON.stringify(result)}\n`
        : !globals.quiet || !write
          ? render(verb.entry, result, spaceName(open, globals, result))
          : "";
      // A verb with its own output (`tasks brief --copy`) is given the result and what it would
      // print.
      if (present !== undefined) await present(result, printed);
      else io.stdout(printed);
      return 0;
    };
    try {
      interruptible(requestId, []);
      return await send(input);
    } catch (error) {
      // The call ended: a failure after which it may have applied prints its retry line below, and
      // Ctrl+C at a question that follows (undo's) has nothing in doubt.
      io.onInterrupt?.(undefined);
      const body = bodyOf(asAppError(error));
      const answered = await hooks?.failed?.(body, async (changes, retry) => {
        const id = newRequestId();
        try {
          interruptible(id, retry);
          return await send({ ...input, ...changes, request_id: id });
        } catch (failed) {
          return failure(failed, id, retry);
        }
      });
      if (answered !== undefined) return answered;
      throw error;
    }
  } catch (error) {
    return failure(error, requestId, []);
  } finally {
    io.onInterrupt?.(undefined);
    session?.close();
  }

  /**
   * How to retry a write that may have applied without doing it twice: the same command with these
   * arguments. Undefined for a read, or with --quiet.
   */
  function retryLine(id: string | undefined, retry: readonly string[]): string | undefined {
    return write && id !== undefined && !globals.quiet
      ? `Retry with: ${[...retry, "--request-id", id].join(" ")}\n`
      : undefined;
  }

  /** Ctrl+C while a write is sent leaves the person not knowing whether it applied. */
  function interruptible(id: string | undefined, retry: readonly string[]): void {
    io.onInterrupt?.(retryLine(id, retry));
  }

  function failure(error: unknown, id: string | undefined, retry: readonly string[]): number {
    const body = bodyOf(asAppError(error));
    const line = retryLine(id, retry);
    if (line !== undefined && body.data?.["retryable"] === true) io.stderr(line);
    return printError(io, globals.json, body);
  }
}
