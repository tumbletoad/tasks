// A seeded random source for fixture generators. The same seed gives the same sequence on every
// machine and Node version: sfc32 over 32-bit integers, seeded from SHA-256 of the seed text.
// Fixture use only. Real IDs come from the OS source.
import { createHash } from "node:crypto";

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string) {
    const h = createHash("sha256").update(seed, "utf8").digest();
    this.#a = h.readUInt32LE(0);
    this.#b = h.readUInt32LE(4);
    this.#c = h.readUInt32LE(8);
    this.#d = h.readUInt32LE(12);
    for (let i = 0; i < 16; i += 1) this.u32();
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

  /** An integer in [0, n), for n up to 2^32. */
  int(n: number): number {
    return Math.floor((this.u32() / 4294967296) * n);
  }

  /** An integer in [min, max]. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.u32() / 4294967296 < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }

  /** Fills `bytes` with random bits: a RandomSource for storage's newId and createSpace. */
  fill(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i += 4) {
      const word = this.u32();
      for (let j = 0; j < 4 && i + j < bytes.length; j += 1)
        bytes[i + j] = (word >>> (8 * j)) & 255;
    }
  }
}
