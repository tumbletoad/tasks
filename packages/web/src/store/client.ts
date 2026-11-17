// The tab's feed client (A5 3.15; A2 3.8.4): the WebSocket to the service's change feed (A2
// 3.8), feeding the live store (store.ts). All task data comes this way; there is no polling
// beside it and no second path for data.
//
// - `machine`: this machine's settings of the page, handed to the page as they come.
// - `hello`, then `subscribe {space, cursor?}`: with the cursor the store resumes from, so a
//   reconnect continues where the tab was; without one for the first snapshot or a fresh one.
// - Every snapshot, batch and error goes to the store's frame queue in arrival order.
// - The store asks for a fresh snapshot on a gap: the client subscribes again without a cursor.
// - The socket reconnects after 1, 2, 4 and 8 s, then every 15 s, resuming from the cursor. 4401
//   means signed out. A service of another build than the page's (its `hello`, or a request it
//   refuses for the build) shows the reload bar, and the page never reloads by itself.
// - `hello` and `installed` say when another version is installed than the service runs: the
//   page says that a restart of the service switches to it.
//
// Each tab has its own socket and subscription, to the space its route names. Two tabs on two
// spaces never share one.
import type { Api } from "../api.ts";
import { SignedOut, StaleBuild } from "../api.ts";
import type { PageRoute } from "../route.ts";
import { browserFrames } from "./browser-frames.ts";
import type { FrameClock } from "./frame.ts";
import type { Overlay } from "./pending.ts";
import { parseMessage, type Cursor, type MachinePreference } from "./rows.ts";
import { LiveStore, type Changes, type LiveState, type Sent, type Touched } from "./store.ts";

const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const CLOSE_SIGNED_OUT = 4401;

export interface LiveOptions {
  readonly api: Api;
  readonly route: PageRoute;
  /** The build the page was served with: a `hello` with another shows the reload bar. */
  readonly build: string;
  /** The snapshot named the tab's space (a tab opened at `/`): the route takes its ID. */
  readonly onSpace: (space: string) => void;
  /** The token is no longer good: the page forgets it. */
  readonly onSignedOut: () => void;
  /** This machine's settings of the page, as the feed carries them (the theme, the keys). */
  readonly onMachine?: (preferences: readonly MachinePreference[]) => void;
  /** The frame clock (tests pass their own). */
  readonly frames?: FrameClock;
}

export class Live {
  readonly #options: LiveOptions;
  readonly store: LiveStore;
  #ws: WebSocket | undefined;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  /** A `hello` is being answered: it subscribes once, after the queue applied. */
  #greeting = false;
  /** The service's version, from its last `hello`. */
  #running: string | undefined;

  constructor(options: LiveOptions) {
    this.#options = options;
    this.store = new LiveStore({
      space: options.route.space,
      frames: options.frames ?? browserFrames(),
      onResnapshot: () => {
        if (!this.#greeting) this.#subscribe(undefined);
      },
      onSpace: options.onSpace,
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  readonly getState = (): LiveState => this.store.getState();

  onTouched(listener: (touched: Touched) => void): () => void {
    return this.store.onTouched(listener);
  }

  onChanges(listener: (changes: Changes) => void): () => void {
    return this.store.onChanges(listener);
  }

  /** The tab's space ID, once known. Every API call names it. */
  get spaceId(): string | undefined {
    return this.store.space;
  }

  /**
   * A write through the store: its overlay shows until the feed confirms it (store.ts). The caller
   * handles the answer's refusal (`failed` first, then its own message).
   */
  write<T>(send: (request: string) => Promise<T>, overlay?: Overlay): Sent<T> {
    return this.store.write(send, overlay);
  }

  start(): void {
    void this.#connect();
  }

  /** The tab stopped (closed, or signed out): nothing more is asked of the service. */
  get stopped(): boolean {
    return this.#stopped;
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    this.store.stop();
    this.#ws?.close(1000);
  }

  /** The service refused the token or the build: the page's state says so. */
  failed(error: unknown): boolean {
    if (error instanceof SignedOut) {
      this.#signedOut();
      return true;
    }
    if (error instanceof StaleBuild) {
      this.store.set({ stale: true });
      return true;
    }
    return false;
  }

  #signedOut(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    // What the feed sent before it is dropped: a queued snapshot would make the tab live again.
    this.store.stop();
    this.#ws?.close(1000);
    this.#options.onSignedOut();
    this.store.set({ phase: "signed_out" });
  }

  #isStopped(): boolean {
    return this.#stopped;
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    // Only a tab with nothing to show yet says it is connecting: a tab that lost its feed keeps its
    // rows and stays offline until the service greets it again.
    if (this.getState().phase === "starting") this.store.set({ phase: "connecting" });
    let ticket: string;
    try {
      ticket = await this.#options.api.ticket();
    } catch (error) {
      if (!this.failed(error)) this.#again();
      return;
    }
    // Read after the await: the tab may have stopped or signed out meanwhile.
    if (this.#isStopped()) return;
    const ws = new WebSocket(
      `ws://${location.host}/api/v1/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    this.#ws = ws;
    ws.onmessage = (event: MessageEvent) => {
      // A stopped tab (signed out, or closed) takes nothing more from a socket still closing.
      if (this.#ws !== ws || this.#isStopped()) return;
      const message = parseMessage(event.data);
      if (message === undefined) return;
      if (message.type === "hello") {
        this.#running = message.version;
        this.store.setInstalled(message.installed, message.version);
        this.#hello(message.build);
      } else if (message.type === "installed") {
        this.store.setInstalled(message.version, this.#running);
      } else if (message.type === "machine") this.#options.onMachine?.(message.preferences);
      else this.store.push(message);
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      if (event.code === CLOSE_SIGNED_OUT) this.#signedOut();
      else this.#again();
    };
  }

  #again(): void {
    if (this.#stopped) return;
    this.store.set({ phase: "offline" });
    const wait = RETRY_MS[Math.min(this.#attempt, RETRY_MS.length - 1)] ?? 15_000;
    this.#attempt += 1;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      void this.#connect();
    }, wait);
  }

  #hello(build: string): void {
    if (this.#options.build !== "" && build !== this.#options.build)
      this.store.set({ stale: true });
    this.#attempt = 0;
    // What the old socket delivered applies first, so the cursor is the newest the tab has. A gap
    // found there needs no subscription of its own: this one goes without a cursor.
    this.#greeting = true;
    let cursor: Cursor | undefined;
    try {
      cursor = this.store.resumeFrom();
    } finally {
      this.#greeting = false;
    }
    this.#subscribe(cursor);
    // A resumed subscription gets no snapshot, and nothing at all until a commit or the next
    // heartbeat: the rows the tab holds are current as of its cursor, so it is live again now.
    // A cursor the service cannot resume from gets a snapshot, a space that is gone an error.
    if (cursor !== undefined && this.getState().phase === "offline") {
      this.store.set({ phase: "live" });
    }
  }

  #subscribe(cursor: Cursor | undefined): void {
    const message: Record<string, unknown> = { type: "subscribe" };
    const space = this.store.space;
    if (space !== undefined) message["space"] = space;
    if (cursor !== undefined) message["cursor"] = cursor;
    // Without a socket, the next `hello` subscribes: from no cursor while a snapshot is awaited.
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify(message));
  }
}
