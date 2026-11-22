// `ttasks-local/1` (A2 3.6, docs/protocol/ttasks-local-1.md): the wire constants, framing,
// canonical JSON, proofs, handshake messages and the client. The service's side is
// `@ttasks/service/local`, which builds on this module. Node built-ins only.
export * from "./constants.ts";
export * from "./errors.ts";
export * from "./framing.ts";
export * from "./jcs.ts";
export * from "./messages.ts";
export * from "./proofs.ts";
export {
  connect,
  openLines,
  openRpc,
  rpcContextEnv,
  LineSession,
  RpcSession,
  type Bound,
  type CallOptions,
  type ConnectOptions,
  type Connected,
} from "./client.ts";
