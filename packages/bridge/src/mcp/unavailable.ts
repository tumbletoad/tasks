// Why the bridge has no service connection right now. The reasons are the transport reasons
// of `service_unavailable`, plus `starting` (the service is starting, or the bridge is
// still reconnecting after a restart). Each picks the offline text a tool call gets.
import { LocalError, type TransportReason } from "../protocol/index.ts";

export type OfflineReason = TransportReason | "starting";

/** A failed connection attempt. `detail` is a fixed word for diagnostics, never peer text. */
export class Unavailable extends Error {
  readonly reason: OfflineReason;
  readonly detail: string;

  constructor(reason: OfflineReason, detail: string) {
    super(`service unavailable: ${reason}`);
    this.name = "Unavailable";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Any error of a connection attempt as an Unavailable. The client's LocalError keeps its reason,
 * except `connection_lost` during a handshake: the service closed or did not answer in time before
 * the bind result, which is a service on its way down or up, or a busy one. Anything else (a path or
 * key the client refuses) cannot be reached.
 */
export function unavailableOf(error: unknown): Unavailable {
  if (error instanceof Unavailable) return error;
  if (error instanceof LocalError) {
    const detail = /^[A-Za-z0-9_]{1,40}$/.test(error.detail) ? error.detail : "failed";
    return error.reason === "connection_lost"
      ? new Unavailable("starting", detail)
      : new Unavailable(error.reason, detail);
  }
  return new Unavailable("unreachable", "client_error");
}
