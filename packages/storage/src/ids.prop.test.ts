// A1 3.3's immutable IDs: a typed prefix and 26 Crockford base32 characters that encode exactly 128
// bits from the OS random source (A7 3.8 M1.03 Verify: "26 Crockford characters, 128 random bits").
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decodeIdBody,
  encodeIdBody,
  ID_ALPHABET,
  ID_PREFIXES,
  isId,
  newId,
  parseId,
  type IdPrefix,
} from "./ids.ts";

const PREFIXES = Object.values(ID_PREFIXES);
const BODY = /^[0-9a-hjkmnp-tv-z]{26}$/;
const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 });
const prefix = fc.constantFrom(...PREFIXES);

/** A random source that hands out the given bytes, and counts what it was asked for. */
function fixedSource(bytes: Uint8Array): { fill: (out: Uint8Array) => void; asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    fill: (out) => {
      asked.push(out.length);
      out.set(bytes.subarray(0, out.length));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[A1.5.ids.property] IDs: 26 Crockford base32 characters, 128 random bits", () => {
  test("the alphabet is Crockford base32 in lower case: no i, l, o or u", () => {
    expect(ID_ALPHABET).toBe("0123456789abcdefghjkmnpqrstvwxyz");
    expect(new Set(ID_ALPHABET).size).toBe(32);
  });

  test("the prefixes are A1 3.3's table, all distinct", () => {
    expect([...PREFIXES].sort()).toEqual(
      [
        "sp",
        "ac",
        "m",
        "se",
        "t",
        "la",
        "a",
        "ru",
        "p",
        "ro",
        "n",
        "pr",
        "l",
        "op",
        "lr",
        "ex",
        "s",
        "at",
        "lb",
        "pl",
        "fo",
        "dv",
        "rc",
        "ai",
        "tr",
      ].sort(),
    );
    expect(new Set(PREFIXES).size).toBe(PREFIXES.length);
  });

  test("a new ID is its prefix and 26 alphabet characters, the first 0 to 7", () => {
    fc.assert(
      fc.property(prefix, (p) => {
        const id = newId(p);
        const [head, body] = id.split("_");
        expect(head).toBe(p);
        expect(body).toMatch(BODY);
        expect(body?.charAt(0)).toMatch(/^[0-7]$/);
        expect(isId(id, p)).toBe(true);
        expect(parseId(id)).toEqual({ prefix: p, body });
      }),
      { numRuns: 200 },
    );
  });

  test("the body encodes exactly the 16 bytes the random source gave: 128 bits, nothing else", () => {
    fc.assert(
      fc.property(prefix, bytes16, (p, bytes) => {
        const source = fixedSource(bytes);
        const id = newId(p, source.fill);
        expect(source.asked).toEqual([16]);
        const body = id.slice(p.length + 1);
        expect(decodeIdBody(body)).toEqual(bytes);
        expect(encodeIdBody(bytes)).toBe(body);
      }),
      { numRuns: 200 },
    );
  });

  test("encoding is a bijection between 16 bytes and the valid bodies", () => {
    fc.assert(
      fc.property(bytes16, bytes16, (a, b) => {
        const same = a.every((byte, i) => byte === b[i]);
        expect(encodeIdBody(a) === encodeIdBody(b)).toBe(same);
      }),
      { numRuns: 200 },
    );
    // The extremes: all zero bits and all 128 bits set.
    expect(encodeIdBody(new Uint8Array(16))).toBe("0".repeat(26));
    expect(encodeIdBody(new Uint8Array(16).fill(255))).toBe(`7${"z".repeat(25)}`);
  });

  test("the default source is crypto.getRandomValues, asked for 16 bytes per ID", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    newId("t");
    expect(spy).toHaveBeenCalledTimes(1);
    const arg: unknown = spy.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Uint8Array);
    expect((arg as Uint8Array).length).toBe(16);
  });

  test("every one of the 128 bits varies across OS-random IDs", () => {
    const n = 2000;
    const ones = new Array<number>(128).fill(0);
    for (let i = 0; i < n; i += 1) {
      const bytes = decodeIdBody(newId("t").slice(2));
      if (bytes === undefined) throw new Error("a new ID did not decode");
      for (let bit = 0; bit < 128; bit += 1) {
        if (((bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1) ones[bit] = (ones[bit] ?? 0) + 1;
      }
    }
    // Binomial(2000, 0.5) has a standard deviation of about 22: 700 to 1300 is 13 deviations wide.
    for (const count of ones) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1300);
    }
  });

  test("validation refuses a wrong prefix, length, alphabet, case or top bits", () => {
    const good = newId("t");
    const body = good.slice(2);
    const bad = [
      `x_${body}`, // unknown prefix
      `T_${body}`, // upper-case prefix
      `t_${body.slice(1)}`, // 25 characters
      `t_${body}0`, // 27 characters
      `t_${body.slice(0, 25)}i`, // i is not in the alphabet
      `t_${body.slice(0, 25)}l`,
      `t_${body.slice(0, 25)}o`,
      `t_${body.slice(0, 25)}u`,
      `t_${body.toUpperCase()}`, // upper-case body
      `t_8${body.slice(1)}`, // the top two bits must be zero
      `t_z${body.slice(1)}`,
      `t${body}`, // no separator
      `t__${body}`,
      "",
      `t_${body} `,
    ];
    for (const value of bad) {
      expect(isId(value), value).toBe(false);
      expect(parseId(value), value).toBeUndefined();
    }
    expect(isId(good, "n")).toBe(false);
    expect(isId(42)).toBe(false);
    expect(decodeIdBody(`8${body.slice(1)}`)).toBeUndefined();
    expect(() => newId("zz" as IdPrefix)).toThrow();
    expect(() => encodeIdBody(new Uint8Array(15))).toThrow();
  });

  test("valid, near-valid and arbitrary strings: exactly the valid ones parse, and round-trip", () => {
    const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCIJLOUZ_-";
    const anyChar = fc.constantFrom(...chars.split(""));
    const valid = fc.tuple(prefix, bytes16).map(([p, b]) => `${p}_${encodeIdBody(b)}`);
    // Each kind says whether the string can still be an ID. A changed character may land on
    // another valid one, so that kind decides nothing by itself; the others are never valid.
    const sample = fc.oneof(
      valid.map((text) => ({ kind: "valid", text })),
      fc.tuple(valid, fc.nat(), anyChar).map(([id, at, c]) => {
        const i = at % id.length;
        return { kind: "one character changed", text: `${id.slice(0, i)}${c}${id.slice(i + 1)}` };
      }),
      fc.tuple(valid, fc.constantFrom(..."89abcdefghjkmnpqrstvwxyz".split(""))).map(([id, c]) => {
        const cut = id.indexOf("_") + 1;
        return { kind: "invalid", text: `${id.slice(0, cut)}${c}${id.slice(cut + 1)}` };
      }),
      fc.tuple(valid, fc.boolean(), anyChar).map(([id, longer, c]) => ({
        kind: "invalid",
        text: longer ? `${id}${c}` : id.slice(0, -1),
      })),
      valid.map((id) => ({ kind: "invalid", text: id.toUpperCase() })),
      fc.string({ unit: anyChar, maxLength: 32 }).map((text) => ({ kind: "arbitrary", text })),
    );
    const seen = { accepted: 0, refused: 0 };
    fc.assert(
      fc.property(sample, ({ kind, text }) => {
        const parsed = parseId(text);
        if (kind === "valid") expect(parsed, text).toBeDefined();
        if (kind === "invalid") expect(parsed, text).toBeUndefined();
        expect(isId(text), text).toBe(parsed !== undefined);
        if (parsed === undefined) {
          seen.refused += 1;
          return;
        }
        seen.accepted += 1;
        const bytes = decodeIdBody(parsed.body);
        expect(bytes).toBeDefined();
        expect(`${parsed.prefix}_${encodeIdBody(bytes ?? new Uint8Array(16))}`).toBe(text);
      }),
      { numRuns: 1000 },
    );
    // Both branches ran: the property was checked on accepted IDs, not only on refusals.
    expect(seen.accepted).toBeGreaterThan(100);
    expect(seen.refused).toBeGreaterThan(100);
  });
});
