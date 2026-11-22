// A hand-driven client for tests that need to send exactly chosen bytes at each handshake step.
// Tests only.
import type net from "node:net";
import {
  bindMessage,
  bindProof,
  clientProof,
  encodeLine,
  helloMessage,
  parseChallenge,
  proofToText,
  randomToken,
  sessionKey,
  transcriptHash,
  type BindBody,
  type Challenge,
  type HandshakeIds,
  type Mode,
} from "@ttasks/bridge/protocol";
import { firstLines, rawConnect } from "@ttasks/bridge/test/endpoint";

export interface RawSession {
  readonly socket: net.Socket;
  /** Every byte received until the socket closes. */
  readonly received: Promise<Buffer>;
  readonly closedAt: Promise<number>;
  readonly challenge: Challenge;
  readonly challengeLine: string;
}

/** Connects and reads the challenge. */
export async function rawChallenge(path: string): Promise<RawSession> {
  const raw = await rawConnect(path);
  const [line = ""] = await firstLines(raw.socket, 1);
  const challenge = parseChallenge(line);
  if (challenge === undefined) throw new Error("no valid challenge");
  return { ...raw, challenge, challengeLine: line };
}

/** The ids and a hello line for `session`'s challenge, made with `key`. */
export function makeHello(
  session: RawSession,
  key: Uint8Array,
  mode: Mode = "rpc",
  protocol = 1,
): { ids: HandshakeIds; line: string } {
  const ids: HandshakeIds = {
    instance: session.challenge.instance,
    protocol,
    mode,
    serverNonce: session.challenge.nonce,
    clientNonce: randomToken(),
  };
  const line = encodeLine(
    helloMessage({
      protocol,
      mode,
      nonce: ids.clientNonce,
      proof: proofToText(clientProof(key, ids)),
    }),
  );
  return { ids, line };
}

/** A bind line for `ids` with `body`, authenticated with `key`. */
export function makeBind(
  session: RawSession,
  key: Uint8Array,
  ids: HandshakeIds,
  body: BindBody,
): string {
  const t = transcriptHash(ids, session.challenge.protocols, body);
  return encodeLine(bindMessage(body, proofToText(bindProof(sessionKey(key, ids), t))));
}
