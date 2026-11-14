// A frame clock the test drives: `frame()` runs what asked for the next frame. Tests only.
import type { FrameClock } from "../src/store/frame.ts";

export class FakeFrames implements FrameClock {
  #waiting: (() => void)[] = [];

  /** How many calls wait for the next frame. */
  get asked(): number {
    return this.#waiting.length;
  }

  request(run: () => void): () => void {
    this.#waiting.push(run);
    return () => {
      this.#waiting = this.#waiting.filter((r) => r !== run);
    };
  }

  frame(): void {
    const runs = this.#waiting;
    this.#waiting = [];
    for (const run of runs) run();
  }
}
