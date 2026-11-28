// The handshake's proofs and canonical JSON: a good proof, a wrong key,
// a wrong instance, a replayed client proof against a new nonce, constant-time comparison used.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { canonicalJson, CanonicalJsonError } from "./jcs.ts";
import {
  bindProof,
  boundProof,
  clientProof,
  decode32,
  parseKey,
  proofMatches,
  proofToText,
  randomToken,
  serverProof,
  sessionKey,
  transcriptHash,
  type HandshakeIds,
} from "./proofs.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const key = randomBytes(32);
const ids = (over: Partial<HandshakeIds> = {}): HandshakeIds => ({
  instance: "9c4e1f07a2d35b8e6f10c2a94d7b3e51",
  protocol: 1,
  mode: "rpc",
  serverNonce: randomToken(),
  clientNonce: randomToken(),
  ...over,
});
const hmac = (k: Uint8Array, text: string) => createHmac("sha256", k).update(text).digest();
const hex = (text: string) => createHash("sha256").update(text).digest("hex");

describe("[A2.3.6.local.proofs] proofs", () => {
  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockClear();
  });

  test("the proofs, session key and bind proofs follow A2 3.6.3's formulas", () => {
    const h = ids();
    const { instance: i, serverNonce: ns, clientNonce: nc } = h;
    expect(clientProof(key, h)).toEqual(
      hmac(key, `ttasks-local/1 client\n${i}\n1\nrpc\n${ns}\n${nc}`),
    );
    expect(serverProof(key, h)).toEqual(
      hmac(key, `ttasks-local/1 server\n${i}\n1\nrpc\n${nc}\n${ns}`),
    );
    const ks = hmac(key, `ttasks-local/1 session\n${i}\n${ns}\n${nc}`);
    expect(sessionKey(key, h)).toEqual(ks);
    const body = { protocol: 1, mode: "rpc" as const, client: { b: 1, a: [2] }, context: {} };
    const t = hex(
      `ttasks-local/1 transcript\n${i}\n${ns}\n${nc}\n[1]\n` +
        '{"client":{"a":[2],"b":1},"context":{},"mode":"rpc","protocol":1}',
    );
    expect(transcriptHash(h, [1], body)).toBe(t);
    expect(bindProof(ks, t)).toEqual(hmac(ks, `ttasks-local/1 bind\n${t}`));
    const result = { protocol: 1, spaces: [] };
    expect(boundProof(ks, t, result)).toEqual(
      hmac(ks, `ttasks-local/1 bound\n${t}\n${hex('{"protocol":1,"spaces":[]}')}`),
    );
  });

  test("a proof made with another key, instance, protocol, mode or nonce never matches", () => {
    const h = ids();
    const good = proofToText(clientProof(key, h));
    expect(proofMatches(good, clientProof(key, h))).toBe(true);
    const variants: HandshakeIds[] = [
      { ...h, instance: "0000000000000000000000000000ffff" },
      { ...h, protocol: 2 },
      { ...h, mode: "mcp" },
      { ...h, serverNonce: randomToken() },
      { ...h, clientNonce: randomToken() },
    ];
    for (const other of variants) {
      expect(proofMatches(good, clientProof(key, other))).toBe(false);
    }
    expect(proofMatches(good, clientProof(randomBytes(32), h))).toBe(false);
    // The client and server proofs differ, so neither can be reflected as the other.
    expect(proofMatches(good, serverProof(key, h))).toBe(false);
  });

  test("a client proof replayed against a new server nonce fails", () => {
    const first = ids();
    const replayed = proofToText(clientProof(key, first));
    const second = { ...first, serverNonce: randomToken() };
    expect(proofMatches(replayed, clientProof(key, second))).toBe(false);
  });

  test("proofs are compared with timingSafeEqual over the 32 decoded bytes", () => {
    const expected = clientProof(key, ids());
    expect(proofMatches(proofToText(expected), expected)).toBe(true);
    const calls = vi.mocked(timingSafeEqual).mock.calls;
    expect(calls).toHaveLength(1);
    const [a, b] = calls[0] ?? [];
    expect(Buffer.from(a as Uint8Array)).toEqual(expected);
    expect(Buffer.from(b as Uint8Array)).toEqual(expected);
  });

  test("malformed proofs fail without a comparison", () => {
    const expected = clientProof(key, ids());
    const text = proofToText(expected);
    for (const bad of [
      undefined,
      null,
      42,
      "",
      text.slice(1),
      `${text}A`,
      `${text.slice(0, 42)}=`,
      `${text.slice(0, 42)}+`,
      // The last character of 32 bytes carries 2 unused bits: only one spelling is accepted.
      `${text.slice(0, 42)}${text.endsWith("A") ? "B" : "A"}`,
    ]) {
      if (typeof bad === "string" && decode32(bad) !== undefined) continue;
      expect(proofMatches(bad, expected)).toBe(false);
    }
    expect(vi.mocked(timingSafeEqual)).not.toHaveBeenCalled();
  });

  test("nonces are 32 random bytes as canonical base64url", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const nonce = randomToken();
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decode32(nonce)).toHaveLength(32);
      seen.add(nonce);
    }
    expect(seen.size).toBe(100);
  });

  test("an ipc.key file holds 32 bytes as base64url, with at most one line ending", () => {
    const raw = randomBytes(32);
    const text = raw.toString("base64url");
    expect(parseKey(text)).toEqual(raw);
    expect(parseKey(`${text}\n`)).toEqual(raw);
    expect(parseKey(`${text}\r\n`)).toEqual(raw);
    for (const bad of ["", `${text}\n\n`, ` ${text}`, raw.toString("base64"), text.slice(2)]) {
      expect(() => parseKey(bad)).toThrow(/32 bytes/);
    }
    try {
      parseKey("not-a-key-but-a-secret-looking-value");
    } catch (error) {
      expect(String(error)).not.toContain("secret-looking");
    }
  });
});

describe("[A2.3.6.local.proofs] canonical JSON (RFC 8785)", () => {
  test("the RFC's example gives its canonical text", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  test("keys sort by UTF-16 code units at every level", () => {
    const value = {
      "\u20ac": 1,
      "\r": 2,
      "\ufb33": 3,
      "1": 4,
      "\ud83d\ude00": 5,
      "\u0080": 6,
      b: { z: 1, a: 2 },
    };
    expect(canonicalJson(value)).toBe(
      '{"\\r":2,"1":4,"b":{"a":2,"z":1},"\u0080":6,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}',
    );
  });

  test("the same value gives the same text however its keys were ordered", () => {
    expect(canonicalJson({ a: 1, b: [1, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ b: [1, { c: 2, d: 1 }], a: 1 }),
    );
    expect(canonicalJson(-0)).toBe("0");
  });

  test("values JSON cannot hold and nesting past the limit are refused", () => {
    for (const bad of [
      Number.NaN,
      Infinity,
      undefined,
      1n,
      () => 1,
      { a: undefined },
      new Date(),
    ]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
    let deep: unknown = 1;
    for (let i = 0; i < 70; i += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/too deep/);
    expect(() => canonicalJson(JSON.parse("[1e400]"))).toThrow(CanonicalJsonError);
  });

  test("lone surrogates and array holes are refused (RFC 8785 3.2.2.2, I-JSON)", () => {
    for (const bad of [
      "\ud800",
      "a\udc00b",
      { "\ud800": 1 },
      { a: ["x", "\udfff"] },
      // eslint-disable-next-line no-sparse-arrays -- a hole is the case under test
      [1, , 2],
      Array(1),
      Array(2),
    ]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
    // A pair is one character, not a lone surrogate.
    expect(canonicalJson("😀")).toBe('"😀"');
    expect(canonicalJson([null, 1])).toBe("[null,1]");
  });
});
