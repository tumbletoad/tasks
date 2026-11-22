// Who an MCP connection is when it is no session: its calls carry the actor `agent:<instance>`
// from the bind context's `instance` (the entry's `--instance`, an A4 instance ID), or
// `agent:manual` for an entry without one (a hand-made entry). A session acts as itself instead
// (ops/caller.ts `sessionPrincipal`).
//
// Its writer scope is `bridge:<instance>:<machine>`, named by what the agent-home row and the
// connection share, the instance on this machine. The grant gate (ops/grant.ts) lets a connection
// call only while a live row of its instance grants the space, so every such write is under the
// scope of the row that allowed it. The scope is not the row's ID: setup replaces a row whenever
// its answer changes (an account label, the hosts), and a scope that changed with it would lose
// the receipts a retry must find. Every chat of that app on this machine that is no session
// shares it, and with it its request IDs.
import type { JsonObject } from "@ttasks/bridge/protocol";
import { INSTANCE_ID, MANUAL_INSTANCE } from "@ttasks/launch";
import type { Principal } from "../ops/index.ts";

/**
 * The instance a connection's calls name, which is also its agent home for the grant gate: its A4
 * instance ID, or `manual`.
 */
export function instanceOf(context: JsonObject): string {
  const value = context["instance"];
  return typeof value === "string" && INSTANCE_ID.test(value) ? value : MANUAL_INSTANCE;
}

/** The principal of an unbound MCP connection on machine `machine`. */
export function bridgePrincipal(context: JsonObject, machine: string): Principal {
  const instance = instanceOf(context);
  return {
    audience: "agent",
    actorKind: "agent",
    label: `agent:${instance}`,
    scope: `bridge:${instance}:${machine}`,
    origin: "mcp",
  };
}

/**
 * What a connection's entry says about its agent app, for `status`'s session line: the instance
 * when it is an A4 instance ID, and the `--app` word. Shown only; the request path checks both
 * are words.
 */
export function clientOf(context: JsonObject): { instance?: string; app?: string } {
  const instance = instanceOf(context);
  const app = context["app"];
  return {
    ...(instance === "manual" ? {} : { instance }),
    ...(typeof app === "string" && app !== "" ? { app } : {}),
  };
}

/** The space a connection's calls use: the entry's `--space` (an ID or a name), or none. */
export function spaceOf(context: JsonObject): string | undefined {
  const value = context["space"];
  return typeof value === "string" && value !== "" ? value : undefined;
}
