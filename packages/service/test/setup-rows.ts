// The service's agent-home rows as setup's tests keep them: the production verbs (hub/agent-homes.ts)
// and grant gate (hub/home-gate.ts) over a grants table of the test's own, so a test sees what
// setup gave and took back and when, can ask the gate what an entry's connection may do, and can
// make the service refuse.
import { MANUAL_INSTANCE } from "@ttasks/launch";
import { agentHomeVerbs } from "../src/hub/agent-homes.ts";
import { homeGate } from "../src/hub/home-gate.ts";
import type { Logger } from "../src/hub/log.ts";
import { isLive, MemoryGrants } from "../src/local/index.ts";
import {
  entryInstance,
  GrantRefused,
  rowAccess,
  type Access,
  type AgentHome,
} from "../src/setup/index.ts";

export interface KeptRow {
  readonly app: string;
  readonly home: string;
  /** Undefined for a row an earlier build made. */
  readonly file: string | undefined;
  readonly instance: string;
  readonly space: string;
  readonly grant: string;
}

export interface KeptRows extends Access {
  /** The live rows. */
  readonly live: KeptRow[];
  /** Each call as it came: `grant` or `revoke`, with the home's folder. */
  readonly asked: { readonly verb: "grant" | "revoke"; readonly home: string }[];
  /** What the service does with the next calls: refuse a grant, or fail a revoke. */
  refuse: { grant?: "instance_taken" | "grant_failed"; revoke?: boolean };
  /**
   * Whether a connection the agent app starts from `entry` (TTasks's entry as its file holds it)
   * may use `space`: its instance as the bridge presents it, through the gate.
   */
  may(entry: unknown, space: string): boolean;
  /** A row as the build before this one made it: a folder and no file. */
  earlier(home: AgentHome, space: string): string;
}

/** The service's rows for setup's tests. `before` sees each call first. */
export function keptRows(before?: (verb: "grant" | "revoke", home: AgentHome) => void): KeptRows {
  const grants = new MemoryGrants();
  // Every space a test names is served.
  const served = new Set<string>();
  const spaces = () => [...served].map((id) => ({ id, state: "open" }));
  const verbs = agentHomeVerbs({
    log: { log: () => undefined } as unknown as Logger,
    grants: () => grants,
    spaces,
    platform: process.platform,
  });
  const access = rowAccess(async (method, params) => {
    if (typeof params["space"] === "string") served.add(params["space"]);
    const verb = verbs[method];
    if (verb === undefined) throw new Error(`no verb ${method}`);
    return (await verb(params, "cli-interactive")) as Record<string, unknown>;
  });
  const gate = homeGate({ grants: () => grants, spaces, defaultSpace: () => undefined });
  const rows: KeptRows = {
    get live() {
      return grants
        .list("agent_home")
        .filter((grant) => isLive(grant))
        .map((grant) => {
          const text = (key: string) => {
            const value = grant.attrs[key];
            return typeof value === "string" ? value : "";
          };
          return {
            app: text("app"),
            home: text("home"),
            file: text("file") === "" ? undefined : text("file"),
            instance: text("instance"),
            space: grant.spaces[0] ?? "",
            grant: grant.grant_id,
          };
        });
    },
    asked: [],
    refuse: {},
    async grant(home, space, of) {
      rows.asked.push({ verb: "grant", home: home.home });
      before?.("grant", home);
      if (rows.refuse.grant !== undefined) throw new GrantRefused(rows.refuse.grant);
      return access.grant(home, space, of);
    },
    async revoke(home, of) {
      rows.asked.push({ verb: "revoke", home: home.home });
      before?.("revoke", home);
      if (rows.refuse.revoke === true) throw new Error("service gone");
      return access.revoke(home, of);
    },
    may(entry, space) {
      return gate.may(entryInstance(entry) ?? MANUAL_INSTANCE, space);
    },
    earlier(home, space) {
      served.add(space);
      return grants.create({
        kind: "agent_home",
        principal: "user",
        spaces: [space],
        attrs: {
          app: home.app,
          home: home.home,
          instance: home.instance,
          account: home.account,
          hosts: [...home.hosts],
        },
      }).grant.grant_id;
    },
  };
  return rows;
}
