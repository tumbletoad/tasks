// Who an MCP connection is (A3 3.7.4, 3.7.9) until session binding (M2.04): every connection is
// unbound, so its calls carry the actor `agent:<instance>` from the bind context's `instance` (the
// entry's `--instance`, an A4 instance ID), or `agent:manual` for an entry without one (a
// hand-made entry). Its writer scope names the instance and this machine, stable across bridge
// processes, so a retry with the same request ID from a new session of the same agent home finds
// its receipt. A3 3.7.9 keys that scope to the agent home's grant row, which setup (M2.14) creates;
// until then the instance stands for the home. The space is the entry's `--space`, never the
// environment's hint (A3 3.7.2, 3.7.8); without one, the request path's default applies.
import type { JsonObject } from "@tasks/bridge/protocol";
import { INSTANCE_ID } from "@tasks/launch";
import type { Principal } from "../ops/index.ts";

/** The instance a connection's calls name: its A4 instance ID, or `manual`. */
export function instanceOf(context: JsonObject): string {
  const value = context["instance"];
  return typeof value === "string" && INSTANCE_ID.test(value) ? value : "manual";
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
