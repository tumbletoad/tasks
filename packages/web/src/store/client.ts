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
// - `watch`: while an Agents page is mounted, whether the tab is visible and its window focused,
//   on every change and after every `hello`; the service asks the Agent Monitor at that pace and
//   sends `agents`, which the tab keeps in memory until the page unmounts. From a lost connection
//   or a service of another build until the next `agents`, the page shows it as not current. A
//   page of another build tells nothing: the service may not know the message.
//
// Each tab has its own socket and subscription, to the space its route names. Two tabs on two
// spaces never share one.
import type { Api } from "../api.ts";
import { isReplaced, SignedOut, StaleBuild } from "../api.ts";
import type { PageRoute } from "../route.ts";
import { AgentsFeed } from "./agents.ts";
import { browserAttention, type Attention } from "./browser-attention.ts";
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
  /** Whether the tab is visible and focused (tests pass their own). Read only while watched. */
  readonly attention?: Attention;
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
  /** The Agent Monitor's view, while an Agents page is mounted. */
  readonly agents = new AgentsFeed();
  /** How many Agents pages are mounted, and the attention they are told about. */
  #watching = 0;
  #attention: Attention | undefined;
  #unattend: (() => void) | undefined;
  /** The watch message the service has: sent again only when it changes. */
  #told: string | undefined;

  constructor(options: LiveOptions) {
    this.#options = options;
    this.store = new LiveStore({
      space: options.route.space,
      frames: options.frames ?? browserFrames(),
      onResnapshot: () => {
        if (!this.#greeting) this.#subscribe(undefined);
      },
      onSpace: options.onSpace,
      onGone: () => {
        this.#ended();
      },
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

  /** The copy of the space the tab loaded, once its first snapshot named it. Every call names it. */
  get copy(): string | undefined {
    return this.store.copy;
  }

  /**
   * A write through the store: its overlay shows until the feed confirms it (store.ts). The caller
   * handles the answer's refusal (`failed` first, then its own message).
   */
  write<T>(send: (request: string) => Promise<T>, overlay?: Overlay, request?: string): Sent<T> {
    return this.store.write(send, overlay, request);
  }

  start(): void {
    void this.#connect();
  }

  /**
   * Asks for a fresh snapshot on the same session: what Open offers comes only with one. The tab's
   * edits and its change log stay, as they belong to this session.
   */
  refresh(): void {
    if (this.#stopped) return;
    // What the feed sent before the ask applies first: its changes are still the person's to see.
    this.store.flush();
    this.store.resnapshot();
    if (!this.#greeting) this.#subscribe(undefined);
  }

  /** The tab stopped (closed, or signed out): nothing more is asked of the service. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** An Agents page mounted: the service is told, and asks the monitor while it is seen. */
  watchAgents(): () => void {
    this.#watching += 1;
    if (this.#watching === 1) {
      this.#attention ??= this.#options.attention ?? browserAttention();
      this.#unattend = this.#attention.onChange(() => {
        this.#tell();
      });
    }
    this.#tell();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#watching -= 1;
      if (this.#watching > 0) return;
      this.#unattend?.();
      this.#unattend = undefined;
      this.agents.clear();
      this.#tell();
    };
  }

  /** Tells the service what changed of the tab's attention, or all of it after a `hello`. */
  #tell(): void {
    const attention = this.#attention;
    const watching = this.#watching > 0 && attention !== undefined;
    const message = JSON.stringify({
      type: "watch",
      agents: watching,
      visible: watching && attention.visible(),
      focused: watching && attention.focused(),
    });
    // A tab never told of one tells nothing until it watches. A stale page may speak to a service
    // that does not know the message.
    if (message === this.#told || (this.#told === undefined && !watching)) return;
    if (this.#ws?.readyState !== 1 || this.getState().stale) return;
    this.#told = message;
    this.#ws.send(message);
  }

  stop(): void {
    this.#stopped = true;
    this.#unattend?.();
    clearTimeout(this.#retry);
    this.store.stop();
    this.#ws?.close(1000);
  }

  /**
   * The service refused the token, the build, or the copy of the space the tab loaded: the page's
   * state says so.
   */
  failed(error: unknown): boolean {
    if (error instanceof SignedOut) {
      this.#signedOut();
      return true;
    }
    if (error instanceof StaleBuild) {
      this.#stale();
      return true;
    }
    if (isReplaced(error)) {
      this.store.gone({ why: "replaced" });
      return true;
    }
    return false;
  }

  /** The copy the tab loaded is gone: nothing more is asked of the service, and no feed. */
  #ended(): void {
    this.#stopped = true;
    this.#unattend?.();
    clearTimeout(this.#retry);
    this.#ws?.close(1000);
    this.agents.cut();
  }

  /** The service runs another build than this page: it shows the reload bar until a reload. */
  #stale(): void {
    this.store.set({ stale: true });
    // It no longer watches, so nothing it shows of the monitor is current.
    this.agents.cut();
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
      else if (message.type === "agents") {
        if (this.#watching > 0 && !this.getState().stale) this.agents.show(message.view);
      } else this.store.push(message);
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      // Until the next connection sends a view, the monitor's is as it was.
      this.agents.cut();
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
    if (this.#options.build !== "" && build !== this.#options.build) this.#stale();
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
    // A new connection knows nothing of this tab: an Agents page that is open says so again.
    this.#told = undefined;
    this.#tell();
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
    // The copy the tab loaded: another one served now answers with a snapshot, never batches.
    const copy = this.store.copy;
    if (cursor !== undefined && copy !== undefined) message["copy"] = copy;
    // Without a socket, the next `hello` subscribes: from no cursor while a snapshot is awaited.
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify(message));
  }
}
