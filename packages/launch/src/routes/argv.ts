// The CLI routes' command lines and the link routes' URLs, from the
// catalogue's templates and an instance of machine.toml. Pure: the same inputs give the same argv
// on every OS, so golden tests compare them as arrays per target, route and OS.
//
// What an agent's argv may carry: the instance's own executable and arguments, the mapped
// permission flags, fixed flags, the session ID TTasks presets, the task's reference and sanitised
// title (`-n`), the folder, and the rendered brief as one element after `--` or as the value of
// one `--name=` element, so it is never read as an option. Every element is one argument of an array that the shim spawns without
// a shell; nothing is ever joined into a command string here. The folder is not
// known at the click (it is resolved right before the launch), so its element stays
// empty and its index travels with the plan: the claim's reply puts the resolved folder there.
import { createHash } from "node:crypto";
import { envVar, MCP_SERVER_KEY } from "@ttasks/brand";
import {
  BRIEF_OPTION,
  checkArgvTemplate,
  checkUrlTemplate,
  isBuiltInTarget,
  placeholdersIn,
  targetDef,
  WHOLE_ELEMENT_PLACEHOLDERS,
  type BuiltInTargetId,
  type RouteDef,
} from "../catalogue.ts";
import { isLaunchRef } from "../intents.ts";
import type { Instance } from "../sections.ts";
import { encodeUrlValue } from "../t3-route.ts";
import { TASK_REF } from "../brief/render.ts";
import { SESSION_UUID } from "../store.ts";

export { SESSION_UUID };

/**
 * The session ID a click presets for Claude Code (`--session-id`), derived from the
 * space and the click's request ID: a repeated request records the same intent with the
 * same ID, so it replays instead of conflicting, and a new click is a new request ID and so a new
 * session. Random-looking, version 4 in form; never reused across clicks.
 */
export function presetSession(space: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`${MCP_SERVER_KEY}-session/1\n${space}\n${requestId}`, "utf8")
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A variable name Codex's `env_vars` may list and TTasks writes back exactly as it is. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
/** At most this many names in the override. */
export const TOOL_ENV_MAX_NAMES = 64;

/** Whether `names` can stand in Codex's `env_vars` override as they are. */
export const isToolEnvList = (names: readonly unknown[]): names is readonly string[] =>
  names.length < TOOL_ENV_MAX_NAMES &&
  names.every((name) => typeof name === "string" && ENV_NAME.test(name));

/**
 * Codex's declaration that TTasks's MCP entry takes the ticket from the agent's environment:
 * Codex clears a stdio server's environment and passes only the names its entry lists, so
 * without it the bridge never sees `TTASKS_TICKET`. Added only when the home's entry exists and
 * lacks it: an override on a home without the entry would make a server table without a command.
 * A `-c` override replaces the entry's whole list, so it repeats the names the entry already
 * lists (`existing`, plain variable names only) and adds the ticket's. The value is names, never
 * a ticket.
 */
export function codexToolEnv(existing: readonly string[] = []): readonly string[] {
  if (!isToolEnvList(existing)) throw new RouteUnavailable("bad_value");
  const names = [...new Set([...existing, envVar("TICKET")])];
  return [
    "-c",
    `mcp_servers.${MCP_SERVER_KEY}.env_vars=[${names.map((name) => `"${name}"`).join(",")}]`,
  ];
}

/** What the template's placeholders stand for in one launch. */
export interface ArgvValues {
  /** `{exec}`: the executable, then `args_prefix`. */
  readonly exec: readonly string[];
  /** `{permission}`: the mapped flags of the instance's open permission. */
  readonly permission: readonly string[];
  /** `{extra_args}`: the instance's own, after TTasks's. */
  readonly extraArgs: readonly string[];
  /** `{tool_env}`: Codex's `-c` when the home's entry lacks it, else none. */
  readonly toolEnv: readonly string[];
  /** `{session}`: the preset session ID. */
  readonly session?: string;
  /** `{resume}`: the ID of the app's own conversation that opens again. */
  readonly resume?: string;
  /** `{task.id}`: the task's reference, such as `M-14`. */
  readonly task: string;
  /** `{task.title}`: the sanitised title. */
  readonly title: string;
  /** `{launch.ref}`. */
  readonly reference?: string;
  /** `{brief}`: the rendered brief. Required when the template names it. */
  readonly brief?: string;
}

/** An agent's argv as a plan carries it: `{cwd}`'s elements are empty until the claim. */
export interface ExpandedArgv {
  readonly argv: readonly string[];
  /** The indices of the elements the resolved folder fills (`{cwd}`). */
  readonly folderArgs: readonly number[];
}

/** Why an instance's route cannot give a command line. */
export class RouteUnavailable extends Error {
  override readonly name = "RouteUnavailable";
  readonly reason: "not_set_up" | "no_route" | "bad_value";
  constructor(reason: "not_set_up" | "no_route" | "bad_value") {
    super(`The route cannot be built: ${reason}`);
    this.reason = reason;
  }
}

/**
 * A template's argv: whole-element placeholders become zero or more elements, the
 * others are replaced within their element, `{cwd}` must be a whole element (it is filled at the
 * claim) and `{brief}` one whole element after `--`, or the value of `--name={brief}`. IDs are
 * checked against their patterns.
 */
export function expandArgv(template: readonly string[], values: ArgvValues): ExpandedArgv {
  if (checkArgvTemplate(template).length > 0) throw new RouteUnavailable("bad_value");
  if (!TASK_REF.test(values.task)) throw new RouteUnavailable("bad_value");
  if (values.session !== undefined && !SESSION_UUID.test(values.session)) {
    throw new RouteUnavailable("bad_value");
  }
  if (values.resume !== undefined && !CONVERSATION_ID.test(values.resume)) {
    throw new RouteUnavailable("bad_value");
  }
  if (values.reference !== undefined && !isLaunchRef(values.reference)) {
    throw new RouteUnavailable("bad_value");
  }
  const whole: Readonly<Record<string, readonly string[]>> = {
    exec: values.exec,
    permission: values.permission,
    extra_args: values.extraArgs,
    tool_env: values.toolEnv,
  };
  const argv: string[] = [];
  const folderArgs: number[] = [];
  for (const element of template) {
    const names = placeholdersIn(element);
    const single = names.length === 1 && element === `{${names[0] ?? ""}}`;
    const name = names[0] ?? "";
    if (single && (WHOLE_ELEMENT_PLACEHOLDERS as readonly string[]).includes(name)) {
      argv.push(...(whole[name] ?? []));
      continue;
    }
    if (names.includes("cwd")) {
      if (!single) throw new RouteUnavailable("bad_value");
      folderArgs.push(argv.length);
      argv.push("");
      continue;
    }
    if (names.includes("brief")) {
      if (values.brief === undefined) throw new RouteUnavailable("bad_value");
      if (single) argv.push(values.brief);
      else if (BRIEF_OPTION.test(element))
        argv.push(element.replace("{brief}", () => values.brief ?? ""));
      else throw new RouteUnavailable("bad_value");
      continue;
    }
    argv.push(
      element.replace(/\{([^{}]*)\}/gu, (_whole, key: string) => {
        const value = textValue(key, values);
        if (value === undefined) throw new RouteUnavailable("bad_value");
        return value;
      }),
    );
  }
  return { argv, folderArgs };
}

/** A placeholder that stands for text within an element. */
function textValue(name: string, values: ArgvValues): string | undefined {
  switch (name) {
    case "session":
      return values.session;
    case "resume":
      return values.resume;
    case "task.id":
      return values.task;
    case "task.title":
      return values.title;
    case "launch.ref":
      return values.reference;
    default:
      return undefined;
  }
}

/** The argv with the resolved folder in its `{cwd}` elements: what the claim's reply sends. */
export function withFolder(
  argv: readonly string[],
  folderArgs: readonly number[] | undefined,
  folder: string,
): string[] {
  const out = [...argv];
  for (const index of folderArgs ?? []) out[index] = folder;
  return out;
}

/** `{exec}` of an instance: `[exec, ...args_prefix]`. Not set up without an `exec`. */
export function execOf(instance: Instance): readonly string[] {
  if (instance.exec === undefined) throw new RouteUnavailable("not_set_up");
  return [instance.exec, ...instance.argsPrefix];
}

/** The catalogue route of a built-in target with this kind and prompt, or undefined. */
export function routeOf(
  target: BuiltInTargetId,
  kind: RouteDef["kind"],
  prompt?: RouteDef["prompt"],
): RouteDef | undefined {
  return targetDef(target).routes.find(
    (route) => route.kind === kind && (prompt === undefined || route.prompt === prompt),
  );
}

/**
 * A CLI instance's terminal command line: Claude Code's or Codex's terminal route
 * of the catalogue with this prompt (its first when none is named), the instance's executable,
 * open permission and extra arguments.
 */
export function cliArgv(
  instance: Instance,
  values: Omit<ArgvValues, "exec" | "permission" | "extraArgs">,
  prompt?: RouteDef["prompt"],
): ExpandedArgv {
  if (!isBuiltInTarget(instance.target)) throw new RouteUnavailable("no_route");
  const route = routeOf(instance.target, "terminal", prompt);
  if (route?.argv === undefined) throw new RouteUnavailable("no_route");
  const permission = targetDef(instance.target).permissionArgs[instance.openPermission].open;
  return expandArgv(route.argv, {
    ...values,
    exec: execOf(instance),
    permission,
    extraArgs: instance.extraArgs,
  });
}

/**
 * A conversation ID that opens again: a UUID of any version (Claude Code's are random, Codex's
 * time-ordered), one plain element that no program reads as an option.
 */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Whether `id` is a conversation ID that a terminal can open again (`{resume}`). */
export const isConversationId = (id: string): boolean => CONVERSATION_ID.test(id);

/**
 * A CLI instance's terminal command line that opens one of its app's own conversations again (a
 * background run's, for Continue), with the instance's executable, open permission and extra
 * arguments, as an Open of it starts. No brief: the conversation already holds the task.
 */
export function resumeArgv(
  instance: Instance,
  values: Omit<ArgvValues, "exec" | "permission" | "extraArgs" | "brief" | "resume"> & {
    readonly resume: string;
  },
): ExpandedArgv {
  if (!isBuiltInTarget(instance.target)) throw new RouteUnavailable("no_route");
  const def = targetDef(instance.target);
  if (def.resume === undefined) throw new RouteUnavailable("no_route");
  return expandArgv(def.resume, {
    ...values,
    exec: execOf(instance),
    permission: def.permissionArgs[instance.openPermission].open,
    extraArgs: instance.extraArgs,
  });
}

/** What a link template's placeholders stand for: each value percent-encoded once. */
export interface UrlValues {
  readonly cwd: string;
  readonly brief: string;
  readonly session?: string;
  readonly task?: string;
  readonly reference?: string;
}

/** A link route's URL (`claude-cli://open?cwd=&q=`), each value encoded once. */
export function expandUrl(template: string, values: UrlValues): string {
  if (checkUrlTemplate(template).length > 0) throw new RouteUnavailable("bad_value");
  return template.replace(/\{([^{}]*)\}/gu, (_whole, key: string) => {
    const value =
      key === "cwd"
        ? values.cwd
        : key === "brief"
          ? values.brief
          : key === "session"
            ? values.session
            : key === "task.id"
              ? values.task
              : key === "launch.ref"
                ? values.reference
                : undefined;
    if (value === undefined) throw new RouteUnavailable("bad_value");
    return encodeUrlValue(value);
  });
}

/**
 * Whether a folder is a UNC path (`\\server\share`, `\\?\UNC\…`), which `claude-cli://` refuses:
 * a UNC place disables that route.
 */
export function isUncPath(folder: string): boolean {
  return /^(\\\\|\/\/)(?!\?\\[A-Za-z]:)/u.test(folder);
}
