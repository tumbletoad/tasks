// The listener's own timers, started through one function so tests can observe and fire them
// (the pattern of the local server, A7 3.18.1). Node's HTTP parser keeps its own deadlines
// (headers, request, keep-alive), which the listener configures and tests read back.
import type { ServerTimer } from "../local/index.ts";

/**
 * - `idle`: a connection that has not finished a request's headers this long after it was
 *   accepted (or after its last response) is closed.
 * - `ws_output`: output waits for a WebSocket peer that takes nothing for this long: it is closed.
 * - `ws_ping`: a WebSocket's ping and heartbeat; a peer that did not answer the last ping is closed.
 * - `feed_poll`: a space with subscribers is checked for new commits.
 * - `port_retry`: the persisted port is tried again while the listener is on a fallback port.
 * - `monitor_ask`, `monitor_keep`: the Agent Monitor's pace (monitor/pace.ts): the next request,
 *   and how long the newest snapshot is kept.
 */
export const HTTP_TIMER_KINDS = [
  "idle",
  "ws_output",
  "ws_ping",
  "feed_poll",
  "port_retry",
  "monitor_ask",
  "monitor_keep",
] as const;
export type HttpTimerKind = (typeof HTTP_TIMER_KINDS)[number];

export interface HttpTimerSpec {
  readonly kind: HttpTimerKind;
  /** The connection's number, or undefined for the listener's own timers. */
  readonly conn: number | undefined;
  readonly ms: number;
}

export type StartHttpTimer = (spec: HttpTimerSpec, fire: () => void) => ServerTimer;

/** Node's timers. They do not keep the process alive on their own: the listener does. */
export const nodeHttpTimers: StartHttpTimer = (spec, fire) => {
  const timer = setTimeout(fire, spec.ms);
  timer.unref();
  return {
    refresh: () => {
      timer.refresh();
    },
    clear: () => {
      clearTimeout(timer);
    },
  };
};
