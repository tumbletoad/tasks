// An agent's connections to a service in this process, made the way a bridge and a shell make them:
// through the local endpoint (ttasks-local/1), a bridge in mcp mode with its bind frame and MCP tool
// calls, a shell in rpc mode with its environment and `op/call`. Nothing reaches into the service's
// binding: a test reads what the endpoint gives back (the bind answer, each call's answer or
// refusal) and what the space kept (the receipts a request left, under their writer scopes, and
// the log). Tests only.
import type { JsonObject, RpcSession } from "@ttasks/bridge/protocol";
import type { ErrorBody } from "@ttasks/contracts";
import type { RunningService } from "../src/hub/service.ts";
import { toolOf } from "../src/mcp/index.ts";
import type { OpsHost } from "../src/ops/index.ts";
import { bridgeContext, openMcp, RawMcp, textOf, type Json } from "./mcp-helpers.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

/** A service in this process, as a test world holds it. */
export interface Served {
  readonly service: RunningService;
  readonly home: string;
  readonly path: string;
}

/** A refused call, as its agent read it. */
export interface Refusal {
  readonly code: string;
  /** The reason word a refusal names, when it names one. */
  readonly reason: string | undefined;
  /** What the agent read: a bridge's tool text, a shell's message. */
  readonly text: string;
  /** The whole A3 error body: a shell's. A bridge reads text only. */
  readonly body: ErrorBody | undefined;
}

export class Refused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.text);
    this.name = "Refused";
    this.refusal = refusal;
  }
}

/**
 * What a call's request path reads in place of the service's own host: built from the host as it
 * is (`own`), such as a space whose reader is a trap, a later clock, or a gate that changes its
 * answer.
 */
export type HostPatch = (own: OpsHost) => Partial<OpsHost>;

/** How a test makes one call. */
export interface CallOptions {
  /** Only a shell can name a space: no tool takes one. */
  readonly space?: string;
  readonly host?: HostPatch;
}

/**
 * Runs `body` while the service's request path, the endpoint's own, reads `patch` over its host,
 * and puts the host back after. Calls are one at a time in a test file, so no other call sees it.
 */
export async function onHost<T>(
  world: Served,
  patch: HostPatch | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (patch === undefined) return body();
  const host = world.service.ops as unknown as Record<string, unknown>;
  const own = { ...world.service.ops };
  const changed = patch(own) as Record<string, unknown>;
  const saved = Object.keys(changed).map(
    (key) => [key, Object.getOwnPropertyDescriptor(host, key)] as const,
  );
  Object.assign(host, changed);
  try {
    return await body();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(host, key);
      else Object.defineProperty(host, key, descriptor);
    }
  }
}

/** One agent connection. A bridge's answers are its tools' texts; a shell's, `op/call`'s results. */
export interface Agent<Answer> {
  /** The bind answer: what the bind frame resolved for a bridge. A shell has none: null. */
  readonly binding: Json | null;
  /**
   * One registry operation as this connection's agent calls it: its MCP tool, or `op/call`.
   * Rejects with `Refused`.
   */
  call(op: string, input?: Json, options?: CallOptions): Promise<Answer>;
  /** The refusal of a call that must be refused. */
  refusal(op: string, input?: Json, options?: CallOptions): Promise<Refusal>;
  /** Ends the connection. The next bridge connects once the service saw it end (`ended`). */
  close(): Promise<void>;
}

/** One person's session per service, for the questions a test asks between calls. */
const users = new WeakMap<RunningService, Promise<RpcSession>>();

/** The bridge connections the service holds open now (`ttasks doctor`'s sessions row). */
async function openBridges(world: Served): Promise<number | undefined> {
  let user = users.get(world.service);
  if (user === undefined || (await user).closed) {
    user = classSession(world.home, world.path, "cli-interactive");
    users.set(world.service, user);
  }
  const facts = (await (await user).call("doctor/sessions", {}, { timeoutMs: 60_000 })) as {
    open?: number;
  } | null;
  return facts?.open;
}

/** Per service, the bridge connections that were closed and that it may not have seen end yet. */
const ending = new WeakMap<RunningService, Set<Promise<void>>>();

/** Resolves once the service saw every closed bridge connection end, as an app's next start does. */
export async function ended(world: Served): Promise<void> {
  await Promise.all([...(ending.get(world.service) ?? [])]);
}

const refusalOf = async <A>(call: Promise<A>, op: string): Promise<Refusal> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
  throw new Error(`${op} was not refused`);
};

/** A tool's error text, `error <code> (<reason>): …`, as its refusal. */
const ERROR_TEXT = /^error ([a-z_]+)(?: \(([a-z_]+)\))?:/;

/**
 * A bridge's connection: the handshake with its bind frame (`context`, as `bridgeContext` or
 * `launchContext` builds it), the MCP opening, then each call through the tool of its entry.
 */
export async function bridge(world: Served, context: JsonObject): Promise<Agent<string>> {
  // Main's resolver decides a bind by the connections still open: a bridge closed before this one
  // is gone first.
  await ended(world);
  const mcp = new RawMcp(await openMcp(world.home, world.path, context));
  await mcp.initialize();
  const call: Agent<string>["call"] = async (op, input = {}, options = {}) => {
    if (options.space !== undefined) throw new Error("No tool takes a space: a bridge names none");
    const reply = await onHost(world, options.host, () =>
      mcp.request("tools/call", { name: toolOf(op), arguments: input }),
    );
    const result = reply.message["result"] as { isError?: boolean } | undefined;
    if (result === undefined) throw new Error(`${op}: ${JSON.stringify(reply.error)}`);
    const text = textOf(result);
    if (result.isError !== true) return text;
    const [, code, reason] = ERROR_TEXT.exec(text) ?? [];
    if (code === undefined) throw new Error(`${op}: not an error text: ${text}`);
    throw new Refused({ code, reason, text, body: undefined });
  };
  return {
    binding: (mcp.session.bound.binding as Json | null | undefined) ?? null,
    call,
    refusal: (op, input, options) => refusalOf(call(op, input, options), op),
    close: async () => {
      // One close at a time is counted, and no bridge of these connects while one is (`bridge`
      // waits): the count drops below `before` only by this connection's own end.
      await ended(world);
      const before = await openBridges(world);
      mcp.close();
      if (before === undefined) return;
      // Seen by the next bridge's connect; a service that stops meanwhile sees everything end.
      const seen = (async () => {
        const deadline = Date.now() + 30_000;
        while (((await openBridges(world)) ?? 0) >= before) {
          if (Date.now() > deadline) throw new Error("the service did not see the bridge close");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })().catch((error: unknown) => {
        if (world.service.status().state === "ready") throw error;
      });
      const set = ending.get(world.service) ?? new Set();
      ending.set(world.service, set);
      set.add(seen);
      void seen.finally(() => set.delete(seen));
    },
  };
}

/**
 * A shell's connection: the `ttasks` command an agent runs in its terminal, which presents its
 * environment only (`env`: an agent marker at least, such as the ticket), then each call through
 * `op/call`. It stays open across calls, as a test's would; the CLI opens one per command.
 */
export async function shell(world: Served, env: Record<string, string>): Promise<Agent<Json>> {
  const session = await classSession(world.home, world.path, "cli-agent", env);
  const call: Agent<Json>["call"] = async (op, input = {}, options = {}) => {
    try {
      return (await onHost(world, options.host, () =>
        session.call(
          "op/call",
          { op, input, ...(options.space === undefined ? {} : { space: options.space }) },
          { timeoutMs: 60_000 },
        ),
      )) as Json;
    } catch (error) {
      const body = errorOf(error);
      const reason = body.data?.["reason"];
      throw new Refused({
        code: body.code,
        reason: typeof reason === "string" ? reason : undefined,
        text: body.message,
        body,
      });
    }
  };
  return {
    binding: null,
    call,
    refusal: (op, input, options) => refusalOf(call(op, input, options), op),
    close: () => {
      session.close();
      return Promise.resolve();
    },
  };
}

/** The instance a bridge of another app or home inside a launched agent presents. */
export const OTHER_INSTANCE = "other-agent";

/**
 * What the bridge of a launched agent presents: the entry setup writes for the launch's home (its
 * space, instance and app) and the agent's environment, with the ticket. `present`
 * `other-instance`: a bridge inside the same agent whose entry names another instance.
 */
export function launchContext(
  space: string,
  launch: {
    readonly instance: string;
    readonly app: string | undefined;
    readonly ticket: string;
  },
  options: { readonly present?: "launch" | "other-instance"; readonly env?: Json } = {},
): JsonObject {
  return bridgeContext({
    space,
    instance: options.present === "other-instance" ? OTHER_INSTANCE : launch.instance,
    app: launch.app ?? null,
    env: { TTASKS_TICKET: launch.ticket, ...options.env },
  });
}

/** A request's receipt as the space kept it: under which writer scope, and its outcome. */
export interface Written {
  readonly scope: string;
  readonly status: string;
}

/**
 * The receipts a request ID left in `space`, under every writer scope: one for a request that
 * committed once, two for one written twice under two scopes, none for one never decided.
 */
export async function written(world: Served, space: string, requestId: string): Promise<Written[]> {
  const served = world.service.ops.spaces().find((s) => s.id === space);
  const reader = served?.reader;
  if (reader === undefined) throw new Error("the space is not served");
  const [rows] = (await reader.transaction("deferred", [
    {
      sql: "SELECT scope_id, status FROM receipts WHERE request_id = $request ORDER BY scope_id",
      mode: "all",
      params: { request: requestId },
    },
  ])) as { scope_id: string; status: string }[][];
  return (rows ?? []).map((row) => ({ scope: row.scope_id, status: row.status }));
}
