// A seeded random source for the fixture generators. The same seed gives the same sequence on
// every machine and Node version: sfc32 over 32-bit integers, seeded from SHA-256 of the seed text.
import { createHash } from "node:crypto";

// Crockford base32 in lower case, as A1 3.3 defines for IDs.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string) {
    const h = createHash("sha256").update(seed).digest();
    this.#a = h.readUInt32LE(0);
    this.#b = h.readUInt32LE(4);
    this.#c = h.readUInt32LE(8);
    this.#d = h.readUInt32LE(12);
    for (let i = 0; i < 16; i++) this.u32();
  }

  /** The next unsigned 32-bit integer (sfc32). */
  u32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** A float in [0, 1). */
  float(): number {
    return this.u32() / 4294967296;
  }

  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** An integer in [min, max]. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }

  /** An A1 3.3 ID: the prefix, then 26 Crockford base32 characters encoding 128 random bits. */
  id(prefix: string): string {
    // 26 characters hold 130 bits. The top two are zero, so the first character is 0 to 7.
    const words = [this.u32(), this.u32(), this.u32(), this.u32()];
    let out = "";
    let acc = 0;
    let bits = 2; // the two leading zero bits
    for (const word of words) {
      for (let shift = 28; shift >= 0; shift -= 4) {
        acc = (acc << 4) | ((word >>> shift) & 15);
        bits += 4;
        if (bits >= 5) {
          bits -= 5;
          out += ALPHABET.charAt((acc >>> bits) & 31);
          acc &= (1 << bits) - 1;
        }
      }
    }
    return `${prefix}_${out}`;
  }
}
