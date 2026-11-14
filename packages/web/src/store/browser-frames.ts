// The browser's frame clock for the live store's queue (frame.ts): the animation frame, with a
// timer beside it. A hidden tab gets no animation frames, and its queue must not grow until the tab
// is shown again.
import type { FrameClock } from "./frame.ts";

/** The longest a queued message waits when the tab gets no animation frame. */
export const FRAME_FALLBACK_MS = 1_000;

/** The browser's frames, with a timer for a tab that is hidden. */
export function browserFrames(fallbackMs = FRAME_FALLBACK_MS): FrameClock {
  return {
    request(run) {
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        run();
      };
      const frame = requestAnimationFrame(once);
      const timer = setTimeout(once, fallbackMs);
      return () => {
        done = true;
        cancelAnimationFrame(frame);
        clearTimeout(timer);
      };
    },
  };
}
