// Finding the service (A2 3.6.1, 3.10.4, 3.3.6): `<state>/service.json` names the endpoint, the
// key is `<state>/ipc.key`, read for every connection. One attempt with a 2 s connect timeout,
// except while service.json says `starting` for a live PID: then the CLI waits up to 10 s. The CLI
// never starts the service here: only `ttasks service start` and `ttasks open` do (A2 S6). Every
// failure is A3's `service_unavailable` with its reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import {
  LocalError,
  openRpc,
  parseKey,
  rpcContextEnv,
  type RpcSession,
  type TransportReason,
} from "@ttasks/bridge/protocol";
import { AppError } from "@ttasks/contracts";
import {
  hostFacts,
  IPC_KEY,
  LayoutError,
  resolveLayout,
  SERVICE_JSON,
} from "@ttasks/service/paths";
import type { Io } from "./io.ts";
import { RESTART_HINT } from "./output.ts";

/** This CLI's version and build. M1.13's release build stamps its own. */
export const CLI_BUILD = { version: "0.0.0", build: "source" } as const;

/** A2 3.10.4: connect timeout 2 s, and up to 10 s for a service that is starting. */
export const CONNECT_MS = 2_000;
export const STARTING_WAIT_MS = 10_000;

export interface ServiceRecord {
  readonly state?: unknown;
  readonly pid?: unknown;
  readonly instance?: unknown;
  readonly version?: unknown;
  readonly build?: unknown;
  readonly protocol?: unknown;
  readonly started_at?: unknown;
  readonly endpoint?: { readonly kind?: unknown; readonly path?: unknown } | null;
}

/** The state folder of this install (A2 3.2.2), from the account's home or TTASKS_HOME. */
export function stateDir(io: Pick<Io, "env" | "platform">): string {
  try {
    return resolveLayout(hostFacts(io.env, io.platform)).state;
  } catch (error) {
    if (error instanceof LayoutError) {
      throw new AppError({
        code: "invalid_input",
        message: `${PRODUCT_NAME}'s folders cannot be found: ${error.message}.`,
        data: { issues: [{ path: "TTASKS_HOME", message: "Invalid" }] },
      });
    }
    throw error;
  }
}

export function readServiceRecord(state: string): ServiceRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(state, SERVICE_JSON), "utf8")) as unknown;
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the process `pid` names is running (or runs as someone this one may not signal). */
export function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const TEXT: Record<TransportReason | "starting", { message: string; hint?: string }> = {
  not_running: {
    message: `${PRODUCT_NAME}'s service is not running.`,
    hint: `${CLI_NAME} service start`,
  },
  starting: {
    message: `${PRODUCT_NAME}'s service is still starting.`,
    hint: "Try again in a moment.",
  },
  unreachable: {
    message: `${PRODUCT_NAME}'s service cannot be reached from this process.`,
    hint: `Inside a sandbox, use ${PRODUCT_NAME}'s MCP tools instead`,
  },
  untrusted_endpoint: {
    message: `Something other than ${PRODUCT_NAME}'s service answers at its endpoint. Nothing was sent.`,
    hint: "Run: ttasks doctor",
  },
  connection_lost: {
    message: `The connection to ${PRODUCT_NAME}'s service was lost. The call may or may not have applied.`,
    hint: "Run the same command again with the same --request-id.",
  },
  restart_session: {
    message: `The running ${PRODUCT_NAME} service is newer than this ttasks command.`,
    hint: "Run the ttasks command of the current install.",
  },
  service_too_old: {
    message: `A newer ${PRODUCT_NAME} is installed than the running service.`,
    hint: RESTART_HINT,
  },
};

/** A transport failure as A3's body (A3 3.5's transport table). */
export function transportError(
  reason: TransportReason | "starting",
  retryable: boolean,
  detail?: string,
): AppError {
  const text = TEXT[reason];
  return new AppError({
    code: "service_unavailable",
    message: text.message,
    ...(text.hint === undefined ? {} : { hint: text.hint }),
    data: { reason, retryable, ...(detail === undefined ? {} : { detail }) },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The service record once it is past `starting`, waiting up to 10 s for a live one. */
async function settledRecord(state: string): Promise<ServiceRecord> {
  let record = readServiceRecord(state);
  if (record === undefined) throw transportError("not_running", false, "no_service_json");
  const deadline = Date.now() + STARTING_WAIT_MS;
  while (record.state === "starting" && alive(record.pid)) {
    if (Date.now() > deadline) throw transportError("starting", true);
    await sleep(100);
    record = readServiceRecord(state);
    if (record === undefined) throw transportError("not_running", false, "no_service_json");
  }
  return record;
}

/** What the CLI uses of an rpc session. */
export type Session = Pick<RpcSession, "bound" | "call" | "close">;

export interface ConnectOptions {
  /** The protocol this client names. Tests only: a CLI newer than the service. */
  readonly protocol?: number;
  /** Tests only: wraps the session, to record the calls or to lose a reply after it applied. */
  readonly wrap?: (session: Session) => Session;
}

/** Connects to this install's service in rpc mode, or throws its `service_unavailable` body. */
export async function connectService(io: Io, options: ConnectOptions = {}): Promise<Session> {
  const state = stateDir(io);
  const record = await settledRecord(state);
  const path = record.endpoint?.path;
  if (typeof path !== "string" || path === "") {
    throw transportError("not_running", false, "no_endpoint");
  }
  let key: Uint8Array;
  try {
    key = parseKey(readFileSync(join(state, IPC_KEY), "utf8"));
  } catch {
    throw new AppError({
      code: "service_unavailable",
      message: `${PRODUCT_NAME}'s key cannot be read.`,
      hint: "Run: ttasks doctor",
      data: { reason: "unreachable", retryable: false, detail: "key" },
    });
  }
  const pkg = io.env["TTASKS_PACKAGE"];
  let session: Session;
  try {
    session = await openRpc({
      path,
      key,
      client: {
        kind: "cli",
        version: CLI_BUILD.version,
        build: CLI_BUILD.build,
        pid: io.pid,
        package: pkg === undefined || pkg === "" ? null : pkg,
        // `stderr` only when it alone is a terminal, the one case where it changes the class: a
        // service that predates the field refuses the bind, so every other command still binds to it.
        tty:
          io.tty.stderr && !io.tty.stdin && !io.tty.stdout
            ? { stdin: false, stdout: false, stderr: true }
            : { stdin: io.tty.stdin, stdout: io.tty.stdout },
      },
      context: { env: rpcContextEnv(io.env) },
      connectTimeoutMs: CONNECT_MS,
      ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    });
  } catch (error) {
    if (error instanceof LocalError)
      throw transportError(error.reason, error.retryable, error.detail);
    throw transportError("unreachable", false, "connect_failed");
  }
  return options.wrap === undefined ? session : options.wrap(session);
}
