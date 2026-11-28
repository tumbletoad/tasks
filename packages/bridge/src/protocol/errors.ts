// The client's failures, as the transport reasons of `service_unavailable`. This module
// imports nothing from the repository, so the bridge bundle stays small. The CLI turns a
// LocalError into contracts' AppError with `toBody()`.

/** The transport reasons that the local client reports, with `retryable` from its table. */
export const TRANSPORT_REASONS = {
  /** No endpoint: the socket or pipe does not exist, or the connection was refused. */
  not_running: { retryable: false },
  /** The endpoint exists but cannot be reached, for example from inside a sandbox (`EPERM`). */
  unreachable: { retryable: false },
  /** The endpoint answered the handshake wrongly. Nothing but the hello was sent. */
  untrusted_endpoint: { retryable: false },
  /**
   * The connection ended or stalled: before the service's proof (only the hello was sent) or after
   * it. A retry is safe.
   */
  connection_lost: { retryable: true },
  /** The service refused this client's protocol as too old (`client_too_old`). */
  restart_session: { retryable: false },
  /** The service refused this client's protocol or mode as too new. */
  service_too_old: { retryable: false },
} as const;

export type TransportReason = keyof typeof TRANSPORT_REASONS;

const MESSAGES: Record<TransportReason, string> = {
  not_running: "The local service is not running.",
  unreachable: "The local service's endpoint cannot be reached from this process.",
  untrusted_endpoint: "Something other than the local service is listening at its endpoint.",
  connection_lost: "The connection to the local service was lost.",
  restart_session: "The local service no longer accepts this client's protocol.",
  service_too_old: "The local service is older than this client.",
};

/**
 * A failure to reach or trust the service. `detail` is a fixed word for diagnostics (never peer
 * text): what exactly went wrong, for example `bad_proof` or `timeout`.
 */
export class LocalError extends Error {
  readonly code = "service_unavailable";
  readonly reason: TransportReason;
  readonly retryable: boolean;
  readonly detail: string;

  constructor(reason: TransportReason, detail: string) {
    super(MESSAGES[reason]);
    this.name = "LocalError";
    this.reason = reason;
    this.retryable = TRANSPORT_REASONS[reason].retryable;
    this.detail = detail;
  }

  /** The TTasks error body. */
  toBody(): {
    code: "service_unavailable";
    message: string;
    data: { reason: TransportReason; retryable: boolean; detail: string };
  } {
    return {
      code: this.code,
      message: this.message,
      data: { reason: this.reason, retryable: this.retryable, detail: this.detail },
    };
  }
}

/** A JSON-RPC error reply to an rpc mode call. `data` holds the error body for TTasks errors. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}
