// The bind context of mcp mode, built from an allow-list. The bridge
// copies nothing else from its environment: not the whole environment, not other agent markers,
// not a variable that merely looks related.
import { MCP_CONTEXT_ENV, type JsonObject } from "../protocol/index.ts";
import type { McpArgs } from "./args.ts";

/** A copied environment value longer than this is dropped: tickets and session IDs are short. */
export const MAX_ENV_VALUE = 256;
/** A working folder longer than this is sent as null. */
export const MAX_CWD = 4096;

/** The parts of the context that do not change while the bridge runs. */
export interface BaseContext {
  readonly space: string | null;
  readonly instance: string | null;
  readonly app: string | null;
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly parent: { readonly pid: number };
}

/**
 * Text the bind frame can carry: canonical JSON (RFC 8785) refuses lone surrogates, which a
 * Windows path or environment value can hold, so such a value is left out rather than failing
 * every connection.
 */
const sendable = (value: string | undefined, max: number): value is string =>
  value !== undefined && value !== "" && value.length <= max && value.isWellFormed();

/** The allow-listed environment values, each present, short and well-formed. */
export function contextEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of MCP_CONTEXT_ENV) {
    const value = env[name];
    if (sendable(value, MAX_ENV_VALUE)) picked[name] = value;
  }
  return picked;
}

export function baseContext(
  args: McpArgs,
  facts: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string | undefined;
    readonly ppid: number;
  },
): BaseContext {
  return {
    space: args.space,
    instance: args.instance,
    app: args.app,
    cwd: sendable(facts.cwd, MAX_CWD) ? facts.cwd : null,
    env: contextEnv(facts.env),
    parent: { pid: facts.ppid },
  };
}

/**
 * The context of one bind: the base, the client's first `initialize` or `server/discover` once it
 * was answered, the binding handle an older service gave an earlier bind, and
 * what an earlier bind answer named of its space, a space or null for none, kept for its life.
 */
export function bindContext(
  base: BaseContext,
  mcpInit: JsonObject | undefined,
  handle: string | undefined,
  held?: string | null,
): JsonObject {
  return {
    space: base.space,
    instance: base.instance,
    app: base.app,
    cwd: base.cwd,
    env: { ...base.env },
    parent: { pid: base.parent.pid },
    ...(mcpInit === undefined ? {} : { mcp_init: mcpInit }),
    ...(handle === undefined ? {} : { resume: { handle } }),
    ...(held === undefined ? {} : { held_space: held }),
  };
}
