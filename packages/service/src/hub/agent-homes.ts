// `tasks setup agents` (A3 3.13.1, A3 3.7.4, A2 3.2.5; M2.14): the agent-home rows of the
// grants table, as rpc methods registered in the handler table (endpoint.ts), like `t3/*`.
//
//   setup/homes         the live agent-home rows                      (every CLI class)
//   setup/home_grant    the row of one agent home, kept or made anew  (the user only)
//   setup/home_revoke   revokes agent-home rows by ID                 (the user only)
//   setup/seen          the instances whose MCP calls this start saw  (every CLI class)
//
// A row is A3's registration grant: the instance, the app, the home's path, the account label, the
// other apps that read the home (the Codex app, T3: A3 3.13.6 step 3, so attribution can say "via
// T3") and the space the home's entry names (`--space`, `--instance`). It has no secret and no
// expiry; setup revokes it when it takes the entry out. The CLI changes the home's file itself, in
// the person's session with the person's environment (setup/agents.ts); the service keeps the row,
// so the one holder of service.lock is the one writer of the grants table.
//
// `setup/seen` is what `tasks doctor --live` asks after its headless call through an agent app
// (A3 3.14): the time this start last carried out a tool call from each instance (the entry's
// `--instance`), and its `--app`; and, when the caller names the working folder of its own run,
// the last such call from a bridge in that folder, so another session of the same home cannot
// stand in for the run. Instance IDs, app words and times only; never a call's content, and a
// folder only as an answer to the caller's own.
import { AppError } from "@tasks/contracts";
import type { JsonObject } from "@tasks/bridge/protocol";
import { hasControl, INSTANCE_ID, MANUAL_INSTANCE } from "@tasks/launch";
import { isId } from "@tasks/storage";
import { isLive, type ConnectionClass, type Grant, type GrantStore } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import { HOSTS, samePath } from "../setup/agents.ts";
import { AGENT_APPS, isAgentApp } from "../setup/state.ts";
import type { Logger } from "./log.ts";

export interface AgentHomesHost {
  readonly log: Logger;
  /** The grants table: service.sqlite's when the UI listener runs, else this start's own. */
  grants(): GrantStore;
  /** The spaces this service serves: a row names one of them. */
  spaces(): readonly { readonly id: string | undefined; readonly state: string }[];
  readonly platform: NodeJS.Platform;
  /** The MCP calls this start saw, by instance (`setup/seen`). */
  readonly seen?: SeenCalls;
}

/** At most this many instances are remembered; the oldest goes first. */
const MAX_SEEN = 256;
/** At most this many working folders per instance; the oldest goes first. */
const MAX_FOLDERS = 8;
/** A folder longer than this is not kept (the bridge sends at most 4096 characters). */
const MAX_FOLDER = 4096;

interface Seen {
  app: string | undefined;
  at: number;
  /** The working folders its calls came from, with the last call's time, the oldest first. */
  folders: Map<string, number>;
}

/**
 * The last tool call this start carried out for each instance (an A4 instance ID, the entry's
 * `--instance`), with the entry's `--app`, and the last call from each of the instance's latest
 * working folders. In memory only: a restart forgets it, and `--live` compares with the time it
 * started its own call.
 */
export class SeenCalls {
  readonly #calls = new Map<string, Seen>();
  readonly #now: () => number;
  readonly #platform: NodeJS.Platform;

  constructor(now: () => number = Date.now, platform: NodeJS.Platform = process.platform) {
    this.#now = now;
    this.#platform = platform;
  }

  /** A tool call from `instance`, in `folder`, went through the request path. */
  saw(instance: string | undefined, app: string | undefined, folder?: string): void {
    if (instance === undefined || !INSTANCE_ID.test(instance)) return;
    const at = this.#now();
    const folders = this.#calls.get(instance)?.folders ?? new Map<string, number>();
    this.#calls.delete(instance);
    if (folder !== undefined && folder !== "" && folder.length <= MAX_FOLDER) {
      folders.delete(folder);
      folders.set(folder, at);
      if (folders.size > MAX_FOLDERS) {
        const oldest = folders.keys().next().value;
        if (oldest !== undefined) folders.delete(oldest);
      }
    }
    this.#calls.set(instance, {
      app: app !== undefined && INSTANCE_ID.test(app) ? app : undefined,
      at,
      folders,
    });
    if (this.#calls.size > MAX_SEEN) {
      const oldest = this.#calls.keys().next().value;
      if (oldest !== undefined) this.#calls.delete(oldest);
    }
  }

  /**
   * Each instance's last call; with `folders` (the caller's own run's folder, as given and as the
   * OS resolves it), also its last call from one of them, or null.
   */
  list(folders?: readonly string[]): {
    instance: string;
    app: string | null;
    at: string;
    folder_at?: string | null;
  }[] {
    return [...this.#calls].map(([instance, seen]) => {
      let inFolder: number | undefined;
      if (folders !== undefined) {
        for (const [folder, at] of seen.folders) {
          if (folders.some((f) => samePath(this.#platform, f, folder))) {
            inFolder = Math.max(inFolder ?? at, at);
          }
        }
      }
      return {
        instance,
        app: seen.app ?? null,
        at: new Date(seen.at).toISOString(),
        ...(folders === undefined
          ? {}
          : { folder_at: inFolder === undefined ? null : new Date(inFolder).toISOString() }),
      };
    });
  }
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

/** The other apps that read a home, as a row keeps them: known words only, sorted. */
const hostsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(value.filter((h): h is string => (HOSTS as readonly unknown[]).includes(h))),
      ].sort()
    : [];

/** A row as the CLI sees it. No secret: an agent-home row has none. */
function rowOf(grant: Grant) {
  return {
    grant: grant.grant_id,
    app: attr(grant, "app"),
    home: attr(grant, "home"),
    instance: attr(grant, "instance"),
    account: attr(grant, "account"),
    hosts: hostsOf(grant.attrs["hosts"]),
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

    "setup/seen": (params) => {
      const given = params["folders"];
      if (
        given !== undefined &&
        (!Array.isArray(given) ||
          given.length > 2 ||
          !given.every((f) => typeof f === "string" && f !== "" && f.length <= MAX_FOLDER))
      ) {
        throw invalid("folders", "Expected one or two folders");
      }
      const folders = given as string[] | undefined;
      return Promise.resolve({ calls: host.seen?.list(folders) ?? [] });
    },

    "setup/home_grant": async (params, cls) => {
      userOnly(cls);
      const app = params["app"];
      if (!isAgentApp(app)) throw invalid("app", `Expected ${AGENT_APPS.join(", ")}`);
      const given = params["hosts"];
      if (
        given !== undefined &&
        (!Array.isArray(given) || !given.every((h) => (HOSTS as readonly unknown[]).includes(h)))
      ) {
        throw invalid("hosts", `Expected ${HOSTS.join(" or ")}`);
      }
      const hosts = hostsOf(given);
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
          hostsOf(grant.attrs["hosts"]).join() === hosts.join() &&
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
        attrs: { app, home, instance, account, hosts },
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
