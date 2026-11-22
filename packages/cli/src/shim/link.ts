// The shim's connection to the service (A4 3.6.3 steps 2 and 9, "Re-attaching"). Finding the
// service is the bridge's discovery (A2 3.6.1): `<state>/service.json` and `ipc.key`, read again
// for every attempt, so a restarted service, with its new pipe name, is found. The handshake is
// ttasks-local/1's: the shim sends nothing about its launch before the service's proof verified.
//
// After the claim the connection holds the attachment. Reports wait in order in a queue; when the
// connection drops (a service restart or update) the agent keeps running and the shim tries again
// every 5 s with `launch.attach {credential, pid, start_time}`, then sends what waited. A refused
// attach ends the link: the service no longer knows this shim, and only `exit.json` is left.
import { envVar } from "@ttasks/brand";
import { installFolders, readEndpoint, readKey, hostFacts } from "@ttasks/bridge/discovery";
import {
  openRpc,
  RPC_ERROR,
  RpcError,
  type JsonObject,
  type RpcSession,
} from "@ttasks/bridge/protocol";
import { REFUSED, SHIM_METHODS, type ReportMethod } from "@ttasks/launch/shim-wire";

/** This build's identity in the bind frame. M1.13's release build stamps its own. */
export const SHIM_BUILD = { version: "0.0.0", build: "source" } as const;

/** Connect and handshake bounds, as the CLI's and the bridge's (A2 3.10.4). */
export const CONNECT_MS = 2_000;
/** How long one call may wait for its answer. The claim's own steps have deadlines of 15 and 30 s. */
export const CALL_MS = 60_000;

/** Where the shim runs: what discovery reads, and the bind frame's client. */
export interface Place {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly tty: { readonly stdin: boolean; readonly stdout: boolean };
}

/** Why a connection attempt failed, as A3's transport reasons and discovery's `starting`. */
export function reasonOf(error: unknown): string {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? reason : "unreachable";
}

/** A failure a later attempt may get past: the service is down, starting or restarting. */
export const passing = (reason: string): boolean =>
  reason === "not_running" ||
  reason === "starting" ||
  reason === "connection_lost" ||
  reason === "unreachable";

/** One connection to the service of this install. Throws what discovery or the client throws. */
export async function connectOnce(place: Place): Promise<RpcSession> {
  const folders = installFolders(hostFacts(place.env, place.platform));
  const path = readEndpoint(folders.state, place.platform);
  const key = readKey(folders.state, place.platform);
  const packaged = place.env[envVar("PACKAGE")];
  return openRpc({
    path,
    key,
    client: {
      kind: "shim",
      version: SHIM_BUILD.version,
      build: SHIM_BUILD.build,
      pid: place.pid,
      package: packaged === undefined || packaged === "" ? null : packaged,
      tty: place.tty,
    },
    context: {},
    connectTimeoutMs: CONNECT_MS,
    handshakeTimeoutMs: CONNECT_MS * 2,
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A3's error body of a TTasks error, as the service sent it. */
function bodyOf(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof RpcError) || error.code !== RPC_ERROR.app) return undefined;
  return isObject(error.data) ? error.data : undefined;
}

/**
 * The service's refusal of this launch (`forbidden`, reason `launch_refused`): the call will never
 * be accepted. Every other error, a draining service's or one that could not decide yet included,
 * may pass.
 */
export function isRefusal(error: unknown): boolean {
  const body = bodyOf(error);
  const data = body?.["data"];
  return body?.["code"] === "forbidden" && isObject(data) && data["reason"] === REFUSED;
}

/** An answer the service marks as worth another try: it is draining, or could not decide yet. */
export function isRetryable(error: unknown): boolean {
  const data = bodyOf(error)?.["data"];
  return isObject(data) && data["retryable"] === true;
}

export interface LinkOptions {
  readonly connect: () => Promise<RpcSession>;
  /**
   * What `launch.attach` presents. Absent when the claim's reply gave no valid credential: the link
   * then reports on the connection that claimed only, and once that drops it is done, as refused.
   */
  readonly attach?: {
    readonly credential: string;
    readonly pid: number;
    readonly start_time: string;
  };
  readonly reattachMs: number;
}

interface Waiting {
  readonly method: ReportMethod;
  readonly params: JsonObject;
}

/** The attachment: the reports, the reconnects, and whether the service still takes them. */
export class Link {
  readonly #options: LinkOptions;
  #session: RpcSession | undefined;
  readonly #queue: Waiting[] = [];
  #flushing: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #attaching: Promise<boolean> | undefined;
  /** The service refused the attachment: nothing more is sent. */
  #refused = false;
  #closed = false;
  #idle: (() => void)[] = [];

  constructor(session: RpcSession, options: LinkOptions) {
    this.#options = options;
    this.#hold(session);
  }

  get refused(): boolean {
    return this.#refused;
  }

  /** A method, so a read after an await is not narrowed by one before it. */
  #isClosed(): boolean {
    return this.#closed;
  }

  get connected(): boolean {
    return this.#session !== undefined && !this.#session.closed;
  }

  /** Every report waiting to be sent. */
  get waiting(): number {
    return this.#queue.length;
  }

  #hold(session: RpcSession): void {
    this.#session = session;
    session.onClose = () => {
      if (this.#session === session) this.#session = undefined;
      this.#schedule();
    };
  }

  /** Queues a report and sends what waits, in order. */
  send(method: ReportMethod, params: JsonObject): void {
    if (this.#closed || this.#refused) return;
    this.#queue.push({ method, params });
    void this.#flush();
  }

  /**
   * Sends what waits, one round at a time. The round's promise is held before the round can end,
   * so a round that ends at once (nothing connected) never leaves a finished promise behind that
   * would stand for every later round.
   */
  #flush(): Promise<void> {
    if (this.#flushing === undefined) {
      const flushing: Promise<void> = this.#sendWaiting().finally(() => {
        if (this.#flushing === flushing) this.#flushing = undefined;
        if (this.#queue.length === 0 || this.#refused) this.#wake();
        // A connection held while the round ran (a reattach) takes what still waits.
        else if (this.connected && !this.#closed) void this.#flush();
      });
      this.#flushing = flushing;
    }
    return this.#flushing;
  }

  async #sendWaiting(): Promise<void> {
    for (;;) {
      const next = this.#queue[0];
      const session = this.#session;
      if (next === undefined || session === undefined || session.closed || this.#closed) return;
      try {
        await session.call(next.method, next.params, { timeoutMs: CALL_MS });
        this.#queue.shift();
      } catch (error) {
        if (isRefusal(error)) {
          // The service no longer knows this attachment: nothing it would take is left.
          this.#refused = true;
          this.#queue.length = 0;
          return;
        }
        // Lost on the way, or not taken yet: it is sent again after the reattach.
        session.close();
        if (this.#session === session) this.#session = undefined;
        this.#schedule();
        return;
      }
    }
  }

  #wake(): void {
    const waiters = this.#idle;
    this.#idle = [];
    for (const wake of waiters) wake();
  }

  /** Tries again in `reattachMs`, unless an attempt is due already. */
  #schedule(): void {
    if (this.#closed || this.#refused || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.reattach();
    }, this.#options.reattachMs);
  }

  /** One attempt: connect, `launch.attach`, then send what waits. True when attached. */
  reattach(): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (this.#attaching === undefined) {
      // Held before the attempt can end, as a flush round is.
      const attaching: Promise<boolean> = this.#attachOnce().finally(() => {
        if (this.#attaching === attaching) this.#attaching = undefined;
      });
      this.#attaching = attaching;
    }
    return this.#attaching;
  }

  async #attachOnce(): Promise<boolean> {
    if (this.#closed || this.#refused) return false;
    const attach = this.#options.attach;
    if (attach === undefined) {
      // Nothing to attach with: no other connection will ever take a report.
      this.#refused = true;
      this.#queue.length = 0;
      this.#wake();
      return false;
    }
    let session: RpcSession;
    try {
      session = await this.#options.connect();
    } catch {
      this.#schedule();
      return false;
    }
    try {
      await session.call(SHIM_METHODS.attach, { ...attach }, { timeoutMs: CALL_MS });
    } catch (error) {
      session.close();
      if (isRefusal(error)) {
        this.#refused = true;
        this.#queue.length = 0;
        this.#wake();
      } else {
        this.#schedule();
      }
      return false;
    }
    // Closed while the attach was on its way: the link takes nothing more.
    if (this.#isClosed()) {
      session.close();
      return false;
    }
    this.#hold(session);
    void this.#flush();
    return true;
  }

  /**
   * Queues a last report and waits until everything was taken, up to `ms`: attaching once more at
   * once when the connection is down. True when the service took it all.
   */
  async finish(method: ReportMethod, params: JsonObject, ms: number): Promise<boolean> {
    this.send(method, params);
    if (!this.connected) void this.reattach();
    // A link with nothing to attach with is refused at once, its queue emptied: nothing was taken.
    if (this.#refused) return false;
    if (this.#queue.length === 0) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.#queue.length === 0 && !this.#refused;
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#session?.close();
    this.#session = undefined;
    this.#wake();
  }
}
