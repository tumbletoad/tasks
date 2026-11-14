// The change feed over WebSocket (A2 3.8.4 "WebSocket", A5 3.15). The `ws` package does the
// protocol (A2 3.8.1: pure JavaScript, no native add-ons, no compression). This module does the
// feed: one subscription per socket, to the space the tab's route names; a snapshot, then batches
// in order, each sent only after the previous one was handed to the socket, so at most one batch
// waits per peer; a heartbeat and a ping; a peer that reads nothing or answers no ping is closed
// rather than buffered for.
//
//   service → page   {type:"hello", protocol, version, build}   first, on every connection
//                    {type:"snapshot", …} and {type:"batch", …}  feed.ts's forms; a snapshot
//                                                                also names the instances
//                                                                (launches.ts) for the tiles
//                    {type:"error", code}                        the subscription ended
//   page → service   {type:"subscribe", space?, cursor?}         a new subscription replaces the old
//                    {type:"unsubscribe"}
//
// A space with subscribers is checked for new commits every `feedPollMs` (one small read of its
// head), and at once after a write through this listener. Close codes: 4401 the token was revoked
// or expired (the page shows "signed out"), 1001 the service stops, 1008 a message the feed does
// not take.
//
// A socket's subscription and its output belong to it only while it is open: closing it ends any
// read in progress (the generation moves on), and every continuation after an await checks that
// before it acts.
import type { RawData, WebSocket } from "ws";
import type { ServerTimer } from "../local/index.ts";
import { defaultOf, type ServedSpace } from "../ops/index.ts";
import type { HttpLog, WsClose } from "./events.ts";
import {
  readBatch,
  readHead,
  readSnapshot,
  sameAuthority,
  type Cursor,
  type SnapshotMessage,
  type Visibility,
} from "./feed.ts";
import type { UiInstance } from "./launches.ts";
import type { HttpLimits } from "./limits.ts";
import type { HttpTimerKind, StartHttpTimer } from "./timers.ts";

/** The feed protocol's own version, in `hello`. */
export const FEED_PROTOCOL = 1;

/** Close codes the page reads. */
export const WS_CLOSE = { revoked: 4401, shutdown: 1001, badMessage: 1008 } as const;

export interface FeedHost {
  spaces(): readonly ServedSpace[];
  /** The machine's default space (A2 3.1): what a subscription that names none gets. */
  readonly defaultSpace?: () => string | undefined;
}

export interface FeedOptions {
  readonly host: FeedHost;
  readonly limits: HttpLimits;
  readonly timers: StartHttpTimer;
  readonly log: HttpLog;
  readonly build: { readonly version: string; readonly build: string };
  readonly visible?: Visibility;
  readonly now: () => number;
  /**
   * Whether a grant may still read the feed: not revoked and not expired (7 days unused, 30 days
   * old). A ticket admits a socket once; the feed asks again before every message it sends and
   * at every tick, so an open feed ends when its token does.
   */
  readonly live: (grant: string) => boolean;
  /** The instances a snapshot names for the page's launch tiles (A5 3.15 step 1). Default none. */
  readonly instances?: () => readonly UiInstance[];
}

const ID = /^sp_[0-9a-z]{26}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function cursorOf(value: unknown): Cursor | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return "invalid";
  const { epoch, incarnation, seq } = value;
  if (
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof incarnation !== "string" ||
    !/^[0-9a-z_]{1,64}$/.test(incarnation)
  ) {
    return "invalid";
  }
  return { epoch, incarnation, seq };
}

/** One page's feed connection. */
class FeedSocket {
  readonly #ws: WebSocket;
  readonly #hub: FeedHub;
  readonly grant: string;
  readonly #conn: number;
  readonly #opened: number;
  #space: string | undefined;
  #cursor: Cursor | undefined;
  #generation = 0;
  #pumping = false;
  #again = false;
  #pending = 0;
  #alive = true;
  #closed = false;
  #output: ServerTimer | undefined;
  /**
   * Bytes the socket's buffer took from this feed's writes (frames, their headers and pings, as
   * `bufferedAmount` counts them), and how many had left it at the last output deadline.
   */
  #buffered = 0;
  #drainedMark = 0;
  /** The subscription the page asked for last, waiting for the read in progress to end. */
  #wanted: { readonly ref: string | undefined; readonly cursor: Cursor | undefined } | undefined;
  #subscribing = false;
  readonly #ping: ServerTimer;

  constructor(ws: WebSocket, hub: FeedHub, grant: string, conn: number) {
    this.#ws = ws;
    this.#hub = hub;
    this.grant = grant;
    this.#conn = conn;
    this.#opened = hub.options.now();
    this.#ping = this.#timer("ws_ping", hub.options.limits.wsPingMs, () => {
      this.#tick();
    });
    ws.on("message", (data: RawData, binary: boolean) => {
      this.#message(data, binary);
    });
    ws.on("pong", () => {
      this.#alive = true;
    });
    ws.on("error", () => undefined);
    ws.on("close", () => {
      this.#ended("client");
    });
    const { version, build } = hub.options.build;
    void this.#send({ type: "hello", protocol: FEED_PROTOCOL, version, build }).catch(
      () => undefined,
    );
  }

  #timer(kind: HttpTimerKind, ms: number, fire: () => void) {
    return this.#hub.options.timers({ kind, conn: this.#conn, ms }, fire);
  }

  get space(): string | undefined {
    return this.#space;
  }

  /** Whether the feed has ended (it may end while it is made: its hello can close it). */
  get closed(): boolean {
    return this.#closed;
  }

  /** Read after an await: the socket may have closed meanwhile. */
  #isClosed(): boolean {
    return this.#closed;
  }

  /** Whether this socket's token may still read: else the feed closes with 4401. */
  #authorized(): boolean {
    if (this.#closed) return false;
    if (this.#hub.options.live(this.grant)) return true;
    this.close(WS_CLOSE.revoked, "expired");
    return false;
  }

  /** The ping and the heartbeat: a peer that did not answer the last ping is closed. */
  #tick(): void {
    if (this.#closed) return;
    if (!this.#authorized()) return;
    if (!this.#alive) {
      this.terminate("silent");
      return;
    }
    this.#alive = false;
    try {
      this.#write(() => {
        this.#ws.ping();
      });
    } catch {
      this.terminate("silent");
      return;
    }
    // A1 3.7: empty batches are the feed's heartbeat. The interval (seq, seq] covers nothing.
    const cursor = this.#cursor;
    if (this.#space !== undefined && cursor !== undefined && !this.#pumping) {
      void this.#send({
        type: "batch",
        space_id: this.#space,
        epoch: cursor.epoch,
        incarnation: cursor.incarnation,
        from: cursor.seq,
        through: cursor.seq,
        events: [],
      }).catch(() => undefined);
    }
    this.#ping.refresh();
  }

  /**
   * Hands one message to the socket. Resolves when the socket took it. Output that may wait for
   * this peer is bounded in bytes, and must move within the stall bound, or the peer is closed.
   */
  #send(message: unknown): Promise<void> {
    if (!this.#authorized()) return Promise.reject(new Error("closed"));
    const text = JSON.stringify(message);
    const size = Buffer.byteLength(text);
    const limits = this.#hub.options.limits;
    if (this.#ws.bufferedAmount + size > limits.maxWsQueuedBytes) {
      this.terminate("slow_reader");
      return Promise.reject(new Error("closed"));
    }
    this.#pending += 1;
    // The deadline runs only while output waits. At each deadline the peer must have read some of
    // it since the last one (a large message drains in many steps), or it is closed.
    if (this.#output === undefined) {
      this.#drainedMark = this.#drained();
      this.#output = this.#timer("ws_output", limits.wsOutputStallMs, () => {
        this.#outputDeadline();
      });
    }
    return new Promise((resolve, reject) => {
      this.#write(() => {
        this.#ws.send(text, (error) => {
          this.#pending -= 1;
          if (this.#pending === 0) {
            this.#output?.clear();
            this.#output = undefined;
          }
          // A write that succeeded reports no error: undefined, or null from some socket paths.
          if (error instanceof Error) reject(error);
          else resolve();
        });
      });
    });
  }

  /**
   * Writes to the socket and counts what its buffer took: the growth of `bufferedAmount`, so a
   * frame's header and a ping are counted the same way the buffer counts them. What the kernel
   * took at once never enters the buffer and is not counted.
   */
  #write(write: () => void): void {
    const before = this.#ws.bufferedAmount;
    write();
    this.#buffered += Math.max(0, this.#ws.bufferedAmount - before);
  }

  /** How many of the bytes the socket's buffer took from this feed have left it. */
  #drained(): number {
    return this.#buffered - this.#ws.bufferedAmount;
  }

  /** Output has waited a whole deadline: kept when the peer read some of it, else closed. */
  #outputDeadline(): void {
    if (this.#closed) return;
    const drained = this.#drained();
    if (drained > this.#drainedMark) {
      this.#drainedMark = drained;
      this.#output?.refresh();
      return;
    }
    this.terminate("slow_reader");
  }

  #message(data: RawData, binary: boolean): void {
    if (this.#closed) return;
    let message: unknown;
    try {
      if (binary) throw new Error("binary");
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8");
      message = JSON.parse(text) as unknown;
    } catch {
      this.close(WS_CLOSE.badMessage, "bad_message");
      return;
    }
    if (!isRecord(message)) {
      this.close(WS_CLOSE.badMessage, "bad_message");
      return;
    }
    if (message["type"] === "unsubscribe") {
      this.#wanted = undefined;
      this.#unsubscribe();
      return;
    }
    if (message["type"] !== "subscribe") {
      this.close(WS_CLOSE.badMessage, "bad_message");
      return;
    }
    const space = message["space"];
    const cursor = cursorOf(message["cursor"]);
    if (
      (space !== undefined && (typeof space !== "string" || space.length > 200)) ||
      cursor === "invalid"
    ) {
      this.close(WS_CLOSE.badMessage, "bad_message");
      return;
    }
    // The old subscription ends now (a read in progress for it sends nothing); the new one starts
    // when that read is over. Only the last of several that come meanwhile is read.
    this.#unsubscribe();
    this.#wanted = { ref: space, cursor };
    void this.#nextSubscription();
  }

  /** Runs the wanted subscriptions one at a time: at most one subscribe read per socket. */
  async #nextSubscription(): Promise<void> {
    if (this.#subscribing) return;
    this.#subscribing = true;
    try {
      while (this.#wanted !== undefined && !this.#closed) {
        const { ref, cursor } = this.#wanted;
        this.#wanted = undefined;
        await this.#subscribe(ref, cursor);
      }
    } finally {
      this.#subscribing = false;
    }
  }

  /**
   * The served space a subscription names: an ID or a name; without one, the machine's default
   * space (A2 3.1: what a new tab opens), else the one space served. A default that is set but not
   * served is never replaced by another space.
   */
  #find(ref: string | undefined): ServedSpace | "ambiguous" | "not_served" | undefined {
    const host = this.#hub.options.host;
    const served = host.spaces().filter((s) => s.reader !== undefined && s.id !== undefined);
    if (ref === undefined) {
      const fallback = defaultOf(served, host.defaultSpace?.());
      if (fallback !== undefined) return fallback;
    }
    const matches =
      ref === undefined
        ? served
        : served.filter((s) => (ID.test(ref) ? s.id === ref : s.name === ref));
    if (matches.length > 1) return "ambiguous";
    return matches[0];
  }

  /**
   * Sends a snapshot as the page takes it: with this machine's instances (A5 3.15 step 1). Every
   * snapshot goes through here, so none reaches the page without the instances for its tiles.
   */
  #sendSnapshot(snapshot: SnapshotMessage, reason?: "epoch" | "cursor_ahead"): Promise<void> {
    const instances: readonly UiInstance[] = this.#hub.options.instances?.() ?? [];
    return this.#send({ ...snapshot, instances, ...(reason === undefined ? {} : { reason }) });
  }

  async #subscribe(ref: string | undefined, cursor: Cursor | undefined): Promise<void> {
    this.#unsubscribe();
    const generation = ++this.#generation;
    const found = this.#find(ref);
    if (
      found === undefined ||
      found === "ambiguous" ||
      found === "not_served" ||
      found.reader === undefined
    ) {
      const code =
        found === "ambiguous"
          ? "ambiguous"
          : ref === undefined && found !== "not_served"
            ? "invalid_input"
            : "space_unavailable";
      await this.#send({ type: "error", code }).catch(() => undefined);
      return;
    }
    const reader = found.reader;
    try {
      let start: Cursor | undefined = cursor;
      if (cursor !== undefined) {
        const head = await readHead(reader);
        if (!sameAuthority(cursor, head.cursor) || cursor.seq > head.cursor.seq) {
          start = undefined;
          const snapshot = await readSnapshot(reader);
          if (generation !== this.#generation) return;
          await this.#sendSnapshot(
            snapshot,
            sameAuthority(cursor, head.cursor) ? "cursor_ahead" : "epoch",
          );
          start = snapshot.cursor;
        }
      } else {
        const snapshot = await readSnapshot(reader);
        if (generation !== this.#generation) return;
        await this.#sendSnapshot(snapshot);
        start = snapshot.cursor;
      }
      if (this.#closed || generation !== this.#generation || start === undefined) return;
      this.#space = found.id;
      this.#cursor = start;
      this.#hub.watch(this);
      this.pump();
    } catch {
      if (generation !== this.#generation || this.#closed) return;
      this.#hub.options.log({ ev: "http.feed_failed", stage: "snapshot" });
      await this.#send({ type: "error", code: "space_unavailable" }).catch(() => undefined);
    }
  }

  #unsubscribe(): void {
    this.#generation += 1;
    this.#hub.unwatch(this);
    this.#space = undefined;
    this.#cursor = undefined;
  }

  /** Sends the batches after the cursor until it is current. One run at a time. */
  pump(): void {
    if (this.#closed || this.#space === undefined) return;
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    void this.#run()
      .catch(() => {
        // A send that failed means the socket is gone; its close ends the subscription.
      })
      .finally(() => {
        this.#pumping = false;
        if (this.#again && !this.#closed) {
          this.#again = false;
          this.pump();
        }
      });
  }

  async #run(): Promise<void> {
    const generation = this.#generation;
    for (;;) {
      const spaceId = this.#space;
      const cursor = this.#cursor;
      if (this.#closed || spaceId === undefined || cursor === undefined) return;
      const space = this.#hub.options.host.spaces().find((s) => s.id === spaceId);
      if (space?.reader === undefined) {
        this.#unsubscribe();
        await this.#send({ type: "error", code: "space_unavailable" }).catch(() => undefined);
        return;
      }
      let read;
      try {
        read = await readBatch(space.reader, cursor.seq, {
          ...(this.#hub.options.visible === undefined
            ? {}
            : { visible: this.#hub.options.visible }),
        });
      } catch {
        if (this.#isClosed() || generation !== this.#generation) return;
        this.#hub.options.log({ ev: "http.feed_failed", stage: "batch" });
        this.#unsubscribe();
        await this.#send({ type: "error", code: "space_unavailable" }).catch(() => undefined);
        return;
      }
      if (generation !== this.#generation) return;
      const { head, batch } = read;
      if (!sameAuthority(cursor, head.cursor)) {
        // An epoch or incarnation change always means a fresh snapshot (A1 3.7).
        const snapshot = await readSnapshot(space.reader);
        if (generation !== this.#generation) return;
        await this.#sendSnapshot(snapshot, "epoch");
        this.#cursor = snapshot.cursor;
        continue;
      }
      if (batch.through === cursor.seq) return;
      await this.#send(batch);
      if (generation !== this.#generation) return;
      this.#cursor = { epoch: batch.epoch, incarnation: batch.incarnation, seq: batch.through };
      if (head.cursor.seq <= batch.through) return;
    }
  }

  close(code: number, reason: WsClose): void {
    if (this.#closed) return;
    try {
      this.#ws.close(code, reason);
    } catch {
      this.#ws.terminate();
    }
    this.#ended(reason);
  }

  terminate(reason: WsClose): void {
    if (this.#closed) return;
    this.#ws.terminate();
    this.#ended(reason);
  }

  #ended(reason: WsClose): void {
    if (this.#closed) return;
    this.#closed = true;
    // A read in progress (a subscribe, a batch) finds its generation gone and does nothing.
    this.#generation += 1;
    this.#output?.clear();
    this.#output = undefined;
    this.#ping.clear();
    this.#hub.unwatch(this);
    this.#hub.forget(this);
    this.#hub.options.log({
      ev: "http.ws_closed",
      reason,
      ms: Math.max(0, Math.round(this.#hub.options.now() - this.#opened)),
    });
  }
}

/** Every feed connection, and a poll per space that has subscribers. */
export class FeedHub {
  readonly options: FeedOptions;
  readonly #sockets = new Set<FeedSocket>();
  readonly #watched = new Map<string, { sockets: Set<FeedSocket>; timer: { clear(): void } }>();

  constructor(options: FeedOptions) {
    this.options = options;
  }

  get size(): number {
    return this.#sockets.size;
  }

  /** Serves the feed on an upgraded connection of the grant `grant`. */
  attach(ws: WebSocket, grant: string, conn: number): void {
    const socket = new FeedSocket(ws, this, grant, conn);
    // A feed whose hello already closed it (a full queue, a token that just expired) is not kept.
    if (!socket.closed) this.#sockets.add(socket);
  }

  /** @internal */
  forget(socket: FeedSocket): void {
    this.#sockets.delete(socket);
  }

  /** @internal Starts the space's poll when its first subscriber arrives. */
  watch(socket: FeedSocket): void {
    const space = socket.space;
    if (space === undefined) return;
    const existing = this.#watched.get(space);
    if (existing !== undefined) {
      existing.sockets.add(socket);
      return;
    }
    const entry: { sockets: Set<FeedSocket>; timer: { clear(): void } } = {
      sockets: new Set([socket]),
      timer: { clear: () => undefined },
    };
    this.#watched.set(space, entry);
    const poll = this.options.timers(
      { kind: "feed_poll", conn: undefined, ms: this.options.limits.feedPollMs },
      () => {
        this.poke(space);
        poll.refresh();
      },
    );
    entry.timer = poll;
  }

  /** @internal Stops the space's poll when its last subscriber leaves. */
  unwatch(socket: FeedSocket): void {
    for (const [space, entry] of this.#watched) {
      if (!entry.sockets.delete(socket)) continue;
      if (entry.sockets.size === 0) {
        entry.timer.clear();
        this.#watched.delete(space);
      }
    }
  }

  /** New commits may exist: every subscriber of `space` (or of every space) catches up. */
  poke(space?: string): void {
    for (const [id, entry] of this.#watched) {
      if (space !== undefined && id !== space) continue;
      for (const socket of entry.sockets) socket.pump();
    }
  }

  /** Closes every feed of a revoked grant. */
  closeGrant(grant: string): void {
    for (const socket of [...this.#sockets]) {
      if (socket.grant === grant) socket.close(WS_CLOSE.revoked, "revoked");
    }
  }

  closeAll(code: number, reason: WsClose): void {
    for (const socket of [...this.#sockets]) socket.close(code, reason);
  }
}
