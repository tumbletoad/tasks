// The local endpoint: the hub's adapter over `tasks-local/1` (M1.09, `@tasks/service/local`).
//
// The hub owns the endpoint's name and its protection (A2 3.2.1, 3.4): it picks the socket path in
// a user-only folder or the pipe name with this start's instance ID, removes a stale socket file,
// and retries a pipe name that is taken (service.ts). It owns `ipc.key`, the instance ID and the
// grants table too. The protocol library takes all of them as parameters (A2 3.6).
//
// The rpc methods the service answers are registered in one place, `handlerTable` below. The hub
// owns two itself (A2 3.6.4): `service/status` and `service/shutdown`, which is how a stop reaches
// the service on Windows (A2 3.3.5). M1.10 registers `op/call` and `op/list` (the request path for
// operations, ops/) and the `space/*` verbs (space-verbs.ts), M2.07 the `roots/*` verbs (roots.ts),
// M2.11 the `t3/*` verbs of `tasks setup t3` (t3.ts), M2.14 the `setup/*` verbs of `tasks setup
// agents` (agent-homes.ts), `tasks setup instances` its `instances/*` (instances.ts); later steps
// add theirs the same way.
//
// The library's events go into the hub's log catalogue (`local.*` in log.ts), every word of them
// from a closed list, so the log stays content-free by construction.
import { PROTOCOL, RPC_ERROR, RpcError, type JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import { sessionFacts, type Bindings } from "../binding/index.ts";
import type { HttpEvent, HttpStatus } from "../http/index.ts";
import {
  MemoryGrants,
  serve,
  type ConnectionClass,
  type GrantStore,
  type LocalEvent,
  type RpcHandler,
  type RpcHandlers,
} from "../local/index.ts";
import { mcpEndpoint } from "../mcp/index.ts";
import { opCall, opList, type OpsHost } from "../ops/index.ts";
import type { Logger } from "./log.ts";
import { defaultSpaceVerbs, type DefaultSpace } from "./default-space.ts";
import { rootVerbs, type RootsHost } from "./roots.ts";
import { spaceVerbs, type SpaceVerbsHost } from "./space-verbs.ts";
import { t3Verbs, type T3Host } from "./t3.ts";
import { agentHomeVerbs, type AgentHomesHost } from "./agent-homes.ts";
import { instanceVerbs, type InstancesHost } from "./instances.ts";

/** The protocols this build speaks (A2 3.6.6): the library's, listed in service.json too. */
export const PROTOCOLS = { min: PROTOCOL, max: PROTOCOL } as const;

/** What a running service reports (`service/status`, `tasks service status --json`). */
export interface ServiceStatus {
  readonly state: "starting" | "ready" | "draining";
  readonly pid: number;
  readonly instance: string;
  readonly install_id: string;
  readonly version: string;
  readonly build: string;
  readonly uptime_ms: number;
  readonly manager: string;
  readonly protocol: { readonly min: number; readonly max: number };
  readonly endpoint: { readonly kind: "unix" | "pipe"; readonly path: string } | null;
  readonly spaces: readonly SpaceSummary[];
  /** The UI's listener (M2.12): its port, whether it moved, and whether it is blocked. */
  readonly http?: HttpStatus | null;
}

/** The UI listener as the endpoint reaches it (`ui/mint_code`, `service/port`). */
export interface EndpointUi {
  mintCode(): { code: string; port: number; persisted: number | null; moved: boolean };
  setPort(port: number, reuse: boolean): Promise<void>;
}

/** A space as status names it (spaces.ts SpaceView has these fields and more). */
export interface SpaceSummary {
  readonly entry: number;
  readonly id?: string;
  readonly name?: string;
  readonly ref_prefix?: string;
  readonly state: string;
  readonly reason?: string;
}

/** What the endpoint may ask of the hub. */
export interface EndpointHub {
  status(): ServiceStatus;
  /** `service/shutdown {restart}`: drain, then exit 0, or 75 to be started again. */
  requestStop(options: { restart: boolean }): void;
  readonly log: Logger;
  /** The request path for operations (`op/call`): the spaces it serves and this machine. */
  readonly ops?: OpsHost;
  /** `tasks space` (`space/*`). */
  readonly spaces?: SpaceVerbsHost;
  /** The UI's HTTP listener (M2.12), once it runs. */
  ui?: EndpointUi | undefined;
  /** `tasks roots` (`roots/*`). */
  readonly roots?: RootsHost;
  /** The machine's default space: `tasks space use` (`space/use`). */
  readonly defaults?: Pick<DefaultSpace, "make">;
  /**
   * The launch shim's methods (A4 3.6.3, `launch.*`, shim class only): launch/ (M2.08). `doctor`
   * answers `doctor/launch` (A3 3.14); undefined while there is no launch service to ask.
   */
  readonly launches?: {
    handlers(): RpcHandlers;
    doctor?(take: boolean): Promise<JsonObject | undefined>;
  };
  /** `tasks setup t3` (`t3/*`). */
  readonly t3?: T3Host;
  /**
   * Session binding (A3 3.7, M2.04): an mcp mode connection's binding from its bind frame, and a
   * `cli-agent` call's session from its ticket.
   */
  readonly bindings?: Bindings;
  /** `tasks setup agents` (`setup/*`): the agent-home rows of the grants table. */
  readonly agentHomes?: AgentHomesHost;
  /** `tasks setup instances` (`instances/*`): machine.toml's [[instance]] entries. */
  readonly instances?: InstancesHost;
}

export interface EndpointOptions {
  /** The socket path or pipe name the hub chose. */
  readonly path: string;
  /** The 32 bytes of ipc.key. */
  readonly key: Uint8Array;
  /** This start's instance ID, as service.json names it. */
  readonly instance: string;
  readonly service: { readonly version: string; readonly build: string };
  readonly protocols: { readonly min: number; readonly max: number };
  readonly hub: EndpointHub;
  /** The grants table (A2 3.2.5). In memory until M2.12 keeps it in service.sqlite. */
  readonly grants?: GrantStore;
}

export interface EndpointServer {
  /**
   * Stops listening, lets each connection finish for up to `graceMs` (its requests in flight
   * answered and sent), then closes what is left. Resolves when all are closed.
   */
  close(graceMs?: number): Promise<void>;
}

/**
 * Listens on `options.path`. Rejects with the listen error when the path is in use (EADDRINUSE),
 * so the hub can pick a new pipe name or remove a stale socket file.
 */
export type ListenEndpoint = (options: EndpointOptions) => Promise<EndpointServer>;

/** A word: what `service/shutdown`'s optional reason may be. It is not logged. */
const REASON_WORD = /^[a-z][a-z_]{0,39}$/;

/**
 * The rpc methods this service answers: the one place they are registered. The library refuses a
 * method a connection's class may not call (A2 3.6.4, 3.6.5), and answers one without a handler
 * with "method not found".
 */
export function handlerTable(hub: EndpointHub): RpcHandlers {
  const ops = hub.ops;
  const verbs: Readonly<
    Record<string, (params: JsonObject, cls: ConnectionClass) => Promise<unknown>>
  > = {
    ...(hub.spaces === undefined ? {} : spaceVerbs(hub.spaces)),
    ...(hub.roots === undefined ? {} : rootVerbs(hub.roots)),
    ...(hub.defaults === undefined ? {} : defaultSpaceVerbs(hub.defaults)),
    ...(hub.t3 === undefined ? {} : t3Verbs(hub.t3)),
    ...(hub.agentHomes === undefined ? {} : agentHomeVerbs(hub.agentHomes)),
    ...(hub.instances === undefined ? {} : instanceVerbs(hub.instances)),
  };
  const verb = (name: string): RpcHandler | undefined => {
    const found = verbs[name];
    return found === undefined
      ? undefined
      : (params, context) => found(params, context.connection.class);
  };
  return {
    ...(ops === undefined
      ? {}
      : {
          // A2 3.6.4: one registry operation, for the connection's class and environment. A
          // `cli-agent` call whose ticket maps to a live session acts as it (A3 3.7.4).
          "op/call": (params, context) => {
            const cls = context.connection.class;
            const env = envOf(context.connection.context);
            const binding = cls === "cli-agent" ? hub.bindings?.mapped(env) : undefined;
            return opCall(
              ops,
              { class: cls, env, ...(binding === undefined ? {} : { binding }) },
              params,
            );
          },
          "op/list": () => opList(),
        }),
    ...Object.fromEntries(
      VERB_METHODS.flatMap((name) => {
        const handler = verb(name);
        return handler === undefined ? [] : [[name, handler]];
      }),
    ),
    // A4 3.6.3: the shim's claim, attach and reports. Each checks its own credential.
    ...hub.launches?.handlers(),
    // `tasks doctor` (A3 3.14): the launch rows' facts (`take`: `--live` takes the login shell's
    // snapshot now), and the sessions row's.
    "doctor/launch": async (params) =>
      (await hub.launches?.doctor?.(params["take"] === true)) ?? {
        scopes: null,
        environment: null,
      },
    "doctor/sessions": () => (hub.bindings === undefined ? null : sessionFacts(hub.bindings)),
    "service/status": () => hub.status(),
    // A2 3.8.4 step 1: a one-time code for `tasks open`, and the port to use it on.
    "ui/mint_code": () => {
      if (hub.ui === undefined) {
        throw new AppError({
          code: "service_unavailable",
          message: "This service runs no UI listener.",
          hint: "Run: tasks doctor",
          data: { reason: "ui_unavailable", retryable: false },
        });
      }
      return hub.ui.mintCode();
    },
    // A2 3.8.2 step 5: a new persisted port, the observations cleared, then a restart (75).
    "service/port": async (params) => {
      const { port, reuse } = params;
      if (typeof port !== "number" || (reuse !== undefined && typeof reuse !== "boolean")) {
        throw new RpcError(RPC_ERROR.invalidParams, "port is a number and reuse a boolean");
      }
      if (hub.ui === undefined) {
        throw new AppError({
          code: "service_unavailable",
          message: "This service runs no UI listener.",
          data: { reason: "ui_unavailable", retryable: false },
        });
      }
      await hub.ui.setPort(port, reuse === true);
      setImmediate(() => {
        hub.requestStop({ restart: true });
      });
      return { port, state: "draining", restart: true };
    },
    "service/shutdown": (params) => {
      const { restart, reason } = params;
      if (
        (restart !== undefined && typeof restart !== "boolean") ||
        (reason !== undefined && (typeof reason !== "string" || !REASON_WORD.test(reason)))
      ) {
        throw new RpcError(RPC_ERROR.invalidParams, "restart is a boolean and reason a word");
      }
      const again = restart === true;
      // After this reply is written: the drain then lets this connection finish, so the caller
      // gets its answer before the connection ends.
      setImmediate(() => {
        hub.requestStop({ restart: again });
      });
      return { state: "draining", restart: again };
    },
  };
}

/** The local command groups' methods: `tasks space`, `tasks roots` and `tasks setup`. */
const VERB_METHODS = [
  "space/list",
  "space/create",
  "space/open",
  "space/close",
  "space/backup",
  "space/backups",
  "space/export",
  "space/restore",
  "space/rescue",
  "space/claim",
  "space/recover",
  "space/use",
  "roots/list",
  "roots/add",
  "instances/add",
  "instances/remove",
  "t3/status",
  "t3/pair",
  "t3/pair_wait",
  "setup/homes",
  "setup/home_grant",
  "setup/home_revoke",
  "setup/seen",
] as const;

/** The bind context's environment: only text values (the library already kept only listed names). */
function envOf(context: JsonObject): Record<string, string> {
  const env = context["env"];
  const out: Record<string, string> = {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) return out;
  for (const [name, value] of Object.entries(env)) if (typeof value === "string") out[name] = value;
  return out;
}

/**
 * A library event into the log's catalogue. Each event name is an entry of the catalogue (the
 * compiler checks it), and the log checks every field against the entry again at run time.
 */
export function logLocal(log: Logger, event: LocalEvent): void {
  const { ev, ...fields } = event;
  log.log(ev, fields);
}

/** A listener event into the log's catalogue (`http.*`), checked like the library's. */
export function logHttp(log: Logger, event: HttpEvent): void {
  const { ev, ...fields } = event;
  log.log(ev, fields);
}

/** A space as a bind result names it: no holder, no path. The name is for people's output. */
const bindSpace = (space: SpaceSummary): SpaceSummary => ({
  entry: space.entry,
  state: space.state,
  ...(space.id === undefined ? {} : { id: space.id }),
  ...(space.name === undefined ? {} : { name: space.name }),
  ...(space.ref_prefix === undefined ? {} : { ref_prefix: space.ref_prefix }),
  ...(space.reason === undefined ? {} : { reason: space.reason }),
});

/** The endpoint: tasks-local/1's `serve` with the hub's handlers, log, bind hook and grants. */
export const listenEndpoint: ListenEndpoint = async (options) => {
  const { hub } = options;
  const ops = hub.ops;
  const server = await serve({
    path: options.path,
    key: options.key,
    instance: options.instance,
    service: options.service,
    protocols: options.protocols,
    handlers: handlerTable(hub),
    // mcp mode (A3 3.3, M2.02): one MCP server per bridge connection on the request path.
    ...(ops === undefined
      ? {}
      : {
          mcp: mcpEndpoint({
            ops,
            ...(hub.bindings === undefined ? {} : { bindings: hub.bindings }),
            log: (event) => {
              const { ev, ...fields } = event;
              hub.log.log(ev, fields);
            },
            ...(hub.agentHomes?.seen === undefined
              ? {}
              : { seen: hub.agentHomes.seen.saw.bind(hub.agentHomes.seen) }),
          }),
        }),
    // mcp mode: the binding its bind frame resolves (A2 3.6.4 `{handle, space, state}`). A failure
    // there leaves the connection unbound rather than refusing it: its tools still work.
    bind: async (info) => {
      const spaces = hub.status().spaces.map(bindSpace);
      if (info.mode !== "mcp" || hub.bindings === undefined) return { spaces };
      try {
        return { spaces, binding: await hub.bindings.bridge(info) };
      } catch {
        return { spaces };
      }
    },
    grants: options.grants ?? new MemoryGrants(),
    log: (event) => {
      logLocal(hub.log, event);
    },
  });
  return {
    close: (graceMs = 0) => server.close({ graceMs }),
  };
};
