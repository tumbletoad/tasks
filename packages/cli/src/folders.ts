// The folder arguments of the verbs that give a project or a task its folder: `ttasks add`,
// `ttasks set` and `ttasks area`. `--folder` comes from the contract and is made absolute here, as
// the service never reads a relative path against its own working folder. `--here` is the working
// folder. `--create` makes a folder that is not there yet, before the call: the person asks for it,
// while the service never makes a folder for anyone. When the call is refused, the folders it made
// are removed again while they are still empty.
import { rmdirSync } from "node:fs";
import { makeDir } from "@ttasks/files";
import { homeFolder, hostFacts } from "@ttasks/service/paths";
import { UsageError, type Globals, type VerbSpec } from "./args.ts";
import type { ConnectOptions } from "./connect.ts";
import type { Io } from "./io.ts";
import { runVerb } from "./verbs.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object of the input that holds the verb's `folder`: a draft, `set`, or the input. */
function holderOf(entry: string, input: Record<string, unknown>): Record<string, unknown> {
  if (entry === "task.add") {
    const tasks = Array.isArray(input["tasks"]) ? (input["tasks"] as unknown[]) : [];
    if (!Array.isArray(input["tasks"])) input["tasks"] = tasks;
    if (!isRecord(tasks[0])) tasks[0] = {};
    return tasks[0] as Record<string, unknown>;
  }
  if (entry === "task.update") {
    if (!isRecord(input["set"])) input["set"] = {};
    return input["set"] as Record<string, unknown>;
  }
  return input;
}

/** `ttasks add`, `ttasks set` and `ttasks area` with `--here` and `--create` taken out first. */
export async function folderVerb(
  io: Io,
  globals: Globals,
  verb: VerbSpec,
  args: readonly string[],
  options: ConnectOptions,
): Promise<number> {
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const here = head.includes("--here");
  const create = head.includes("--create");
  const rest = [
    ...head.filter((a) => a !== "--here" && a !== "--create"),
    ...(end === -1 ? [] : args.slice(end)),
  ];
  if (!here && !create) return runVerb(io, globals, verb, rest, options);
  let made: string[] = [];
  // A failure after which the write may have applied (a lost reply) leaves the folders: the binding
  // may name them.
  const call = { succeeded: false, uncertain: false };
  const code = await runVerb(
    io,
    globals,
    verb,
    rest,
    options,
    (_result, printed) => {
      call.succeeded = true;
      io.stdout(printed);
      return Promise.resolve();
    },
    {
      input: (input) => {
        const holder = holderOf(verb.entry, input);
        if (here) {
          if (holder["folder"] !== undefined) {
            throw new UsageError("--here and --folder name two folders: give one");
          }
          holder["folder"] = io.cwd;
        }
        const folder = holder["folder"];
        if (!create) return;
        if (typeof folder !== "string") throw new UsageError("--create needs --folder or --here");
        // A folder for the person's work, as their own mkdir would make it.
        made = makeDir(expandHome(folder, io), "umask", { platform: io.platform });
      },
      failed: (body) => {
        if (body.data?.["retryable"] === true) call.uncertain = true;
        return Promise.resolve(undefined);
      },
    },
  );
  if (!call.succeeded && !call.uncertain) {
    // Innermost first: a folder made here and still empty goes; anything put in it stays.
    for (const folder of made.toReversed()) {
      try {
        rmdirSync(folder);
      } catch {
        break;
      }
    }
  }
  return code;
}

/** A folder to make: one under `~` in this account's home, `cwd` the working folder. */
function expandHome(folder: string, io: Io): string {
  if (folder === "cwd") return io.cwd;
  if (folder !== "~" && !folder.startsWith("~/") && !folder.startsWith("~\\")) return folder;
  return `${homeFolder(hostFacts(io.env, io.platform))}${folder.slice(1)}`;
}
