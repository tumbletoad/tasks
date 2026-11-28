// Per-frame batching: the feed's messages are queued as they arrive and applied
// together once per animation frame, so a burst of agent writes costs one render. The queue keeps
// every message and their order: a frame drains all that came before it, in arrival order, and a
// message that arrives while a frame drains waits for the next frame.
//
// The clock is injected, so tests drive frames by hand. The browser's is browser-frames.ts.

/** Asks for one call at the next frame; the returned function cancels it. */
export interface FrameClock {
  request(run: () => void): () => void;
}

export class FrameQueue<T> {
  readonly #clock: FrameClock;
  readonly #drain: (items: readonly T[]) => void;
  #items: T[] = [];
  #cancel: (() => void) | undefined;
  #scheduled = false;

  constructor(clock: FrameClock, drain: (items: readonly T[]) => void) {
    this.#clock = clock;
    this.#drain = drain;
  }

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#scheduled) return;
    this.#scheduled = true;
    const cancel = this.#clock.request(() => {
      this.#scheduled = false;
      this.#cancel = undefined;
      this.flush();
    });
    // A clock that ran the frame at once has nothing left to cancel.
    if (this.#waiting()) this.#cancel = cancel;
  }

  /** Whether a frame was asked for and has not run (read after the clock may have run it). */
  #waiting(): boolean {
    return this.#scheduled;
  }

  /** Applies everything queued now, in order, without waiting for the frame. */
  flush(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#scheduled = false;
    const items = this.#items;
    if (items.length === 0) return;
    this.#items = [];
    this.#drain(items);
  }

  /** Forgets what is queued (the tab stops). */
  clear(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#scheduled = false;
    this.#items = [];
  }
}
