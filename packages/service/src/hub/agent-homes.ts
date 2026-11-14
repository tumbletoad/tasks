// `tasks setup agents` (A3 3.13.1, A3 3.7.4, A2 3.2.5; M2.14): the agent-home rows of the
// grants table, as rpc methods registered in the handler table (endpoint.ts), like `t3/*`.
//
//   setup/homes         the live agent-home rows                      (every CLI class)
//   setup/home_grant    the row of one agent home, kept or made anew  (the user only)
//   setup/home_revoke   revokes agent-home rows by ID                 (the user only)
//
// A row is A3's registration grant: the instance, the app, the home's path, the account label and
// the space the home's entry names (`--space`, `--instance`). It has no secret and no expiry; setup
// revokes it when it takes the entry out. The CLI changes the home's file itself, in the person's
// session with the person's environment (setup/agents.ts); the service keeps the row, so the one
// holder of service.lock is the one writer of the grants table.
import { AppError } from "@tasks/contracts";
import type { JsonObject } from "@tasks/bridge/protocol";
import { hasControl, INSTANCE_ID, MANUAL_INSTANCE } from "@tasks/launch";
import { isId } from "@tasks/storage";
import { isLive, type ConnectionClass, type Grant, type GrantStore } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import { samePath } from "../setup/agents.ts";
import { isAgentApp } from "../setup/state.ts";
import type { Logger } from "./log.ts";

export interface AgentHomesHost {
  readonly log: Logger;
  /** The grants table: service.sqlite's when the UI listener runs, else this start's own. */
  grants(): GrantStore;
  /** The spaces this service serves: a row names one of them. */
  spaces(): readonly { readonly id: string | undefined; readonly state: string }[];
  readonly platform: NodeJS.Platform;
}

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

const invalid = (path: string, message: string): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    data: { issues: [{ path, message }] },
  });

function userOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can register agent homes.",
      hint: "Ask the user to run: tasks setup agents --apply",
      data: { rule: "user_only" },
    });
  }
}

/** A grant ID: `gr_` and A1's ID alphabet. */
const GRANT_ID = /^gr_[0-9a-z]{20,32}$/u;

const attr = (grant: Grant, key: string): string => {
  const value = grant.attrs[key];
  return typeof value === "string" ? value : "";
};

/** A row as the CLI sees it. No secret: an agent-home row has none. */
function rowOf(grant: Grant) {
  return {
    grant: grant.grant_id,
    app: attr(grant, "app"),
    home: attr(grant, "home"),
    instance: attr(grant, "instance"),
    account: attr(grant, "account"),
    spaces: grant.spaces,
    created_at: grant.created_at,
  };
}

function text(params: JsonObject, key: string, max: number): string {
  const value = params[key];
  if (typeof value !== "string" || value === "" || value.length > max || hasControl(value)) {
    throw invalid(key, "Expected text");
  }
  return value;
}

export function agentHomeVerbs(host: AgentHomesHost): Readonly<Record<string, Verb>> {
  const live = () =>
    host
      .grants()
      .list("agent_home")
      .filter((grant) => isLive(grant));
  const flush = async () => {
    await host.grants().flush?.();
  };

  return {
    "setup/homes": () => Promise.resolve({ homes: live().map(rowOf) }),

    "setup/home_grant": async (params, cls) => {
      userOnly(cls);
      const app = params["app"];
      if (!isAgentApp(app)) throw invalid("app", "Expected claude-code or codex");
      const home = text(params, "home", 4096);
      const instance = text(params, "instance", 40);
      if (!INSTANCE_ID.test(instance)) throw invalid("instance", "Expected an instance ID");
      // A3 3.7.4: `manual` is the hand-made entry's, which has no row (ops/grant.ts).
      if (instance === MANUAL_INSTANCE) {
        throw invalid("instance", "manual is kept for an entry without --instance");
      }
      // An instance may have no account label (machine.toml's `account` is optional): empty is kept.
      const account = params["account"];
      if (typeof account !== "string" || account.length > 64 || hasControl(account)) {
        throw invalid("account", "Expected text");
      }
      const space = params["space"];
      if (!isId(space, "sp")) throw invalid("space", "Expected a space ID");
      if (!host.spaces().some((s) => s.id === space && s.state !== "closed")) {
        throw new AppError({
          code: "space_unavailable",
          message: "This service does not serve that space.",
          hint: "Run tasks space list.",
          data: { reason: "not_served", retryable: false },
        });
      }
      // One live row per home: the same answer keeps it, another one replaces it.
      const ofHome = live().filter(
        (grant) => attr(grant, "app") === app && samePath(host.platform, attr(grant, "home"), home),
      );
      // One home per instance: a connection shows only its instance, so the grant gate could not
      // tell two homes of one instance apart (hub/home-gate.ts). The person frees the instance by
      // removing the other home, or gives this one its own instance in machine.toml.
      if (live().some((grant) => !ofHome.includes(grant) && attr(grant, "instance") === instance)) {
        throw invalid("instance", "Another agent home is registered as this instance");
      }
      const kept = ofHome.find(
        (grant) =>
          attr(grant, "instance") === instance &&
          attr(grant, "account") === account &&
          grant.spaces.length === 1 &&
          grant.spaces[0] === space,
      );
      for (const grant of ofHome) if (grant !== kept) host.grants().revoke(grant.grant_id);
      if (kept !== undefined) {
        await flush();
        return { grant: rowOf(kept), created: false };
      }
      const { grant } = host.grants().create({
        kind: "agent_home",
        principal: "user",
        spaces: [space],
        attrs: { app, home, instance, account },
      });
      await flush();
      host.log.log("setup.home_granted", { app, replaced: ofHome.length > 0 });
      return { grant: rowOf(grant), created: true };
    },

    "setup/home_revoke": async (params, cls) => {
      userOnly(cls);
      const ids = params["grants"];
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        !ids.every((id) => typeof id === "string" && GRANT_ID.test(id))
      ) {
        throw invalid("grants", "Expected grant IDs");
      }
      let revoked = 0;
      for (const id of ids as string[]) {
        const grant = host.grants().get(id);
        if (grant?.kind === "agent_home" && host.grants().revoke(id)) revoked += 1;
      }
      await flush();
      if (revoked > 0) host.log.log("setup.home_revoked", { count: revoked });
      return { revoked };
    },
  };
}
