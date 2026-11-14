// Every bound of the listener in one place (A2 3.8.1, 3.8.3). Tests pass smaller ones.
export interface HttpLimits {
  /** A2 3.8.1: a request's headers within 10 s (Node's parser, and the `idle` timer before them). */
  readonly headersMs: number;
  /** A2 3.8.1: a whole request, its body included, within 30 s. */
  readonly requestMs: number;
  /** A2 3.8.1: an idle keep-alive connection is closed after 5 s. */
  readonly keepAliveMs: number;
  /** All request headers together, in bytes. */
  readonly maxHeaderBytes: number;
  /** A2 3.8.3: a request body is 1 MiB at most. */
  readonly maxBodyBytes: number;
  /** A2 3.8.1: at most 64 connections that have not authenticated. More are closed at once. */
  readonly maxUnauthenticated: number;
  /** All connections at once, authenticated or not, WebSockets included. */
  readonly maxConnections: number;
  /** Connections one token holds at once (a browser keeps about six per origin, plus a feed per tab). */
  readonly maxPerToken: number;
  /** A WebSocket message from the browser. The feed's messages are small. */
  readonly maxWsMessageBytes: number;
  /** Output that may wait for one WebSocket peer. Past it the peer is not reading: closed. */
  readonly maxWsQueuedBytes: number;
  /** Output waiting for a WebSocket peer must move within this long, or the peer is closed. */
  readonly wsOutputStallMs: number;
  /** A WebSocket's ping and heartbeat. A peer that misses one ping is closed at the next. */
  readonly wsPingMs: number;
  /** How often a space with subscribers is checked for new commits. */
  readonly feedPollMs: number;
  /** Fragment codes and WebSocket tickets that may wait at once. */
  readonly maxCodes: number;
  readonly maxTickets: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  headersMs: 10_000,
  requestMs: 30_000,
  keepAliveMs: 5_000,
  maxHeaderBytes: 16 * 1024,
  maxBodyBytes: 1024 * 1024,
  maxUnauthenticated: 64,
  maxConnections: 256,
  maxPerToken: 32,
  maxWsMessageBytes: 64 * 1024,
  maxWsQueuedBytes: 16 * 1024 * 1024,
  wsOutputStallMs: 30_000,
  wsPingMs: 30_000,
  feedPollMs: 1_000,
  maxCodes: 16,
  maxTickets: 64,
};
