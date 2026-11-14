// The prototype's ID for a task line without a marker (A7 3.15.2, Fallback ID):
// `t-` and eight lower-case hex digits of 32-bit FNV-1a over the Unicode code points of
// `<group>|<title>`, the title without its trailing dots. Each whole code point is XORed in, then
// multiplied: not UTF-8 bytes and not UTF-16 units, which differ for any character above U+007F
// (bytes) or above U+FFFF (units).

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

/** 32-bit FNV-1a over the code points of a string. */
export function fnv1aCodePoints(value: string): number {
  let hash = OFFSET_BASIS;
  for (const char of value) {
    // The XOR takes the whole code point (up to 21 bits), not one byte of it, and the product is
    // reduced modulo 2^32: Math.imul gives its low 32 bits, `>>> 0` reads them unsigned.
    hash = Math.imul((hash ^ (char.codePointAt(0) ?? 0)) >>> 0, PRIME) >>> 0;
  }
  return hash;
}

export function fallbackId(group: string, title: string): string {
  return `t-${fnv1aCodePoints(`${group}|${title}`).toString(16).padStart(8, "0")}`;
}
