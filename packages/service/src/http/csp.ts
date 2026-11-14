// The response headers of the app shell and the API (A2 3.8.3, A5 3.26). Every response of the
// listener carries them, errors included, so no response can be framed, sniffed, cached by
// another origin or run a worker.
//
// - The CSP: `script-src 'self'` with no inline script, `style-src 'self'` plus a per-response
//   nonce on `index.html` only, `worker-src 'none'` (v1 registers no service worker, A2 3.8.6),
//   and Trusted Types for scripts. Never `'unsafe-inline'`, `'unsafe-eval'` or
//   `'wasm-unsafe-eval'`.
// - The nonce: 128 random bits, base64, new for every `index.html` response, repeated in the
//   document's `<meta name="csp-nonce">` (React Aria's documented nonce plumbing). `index.html` is
//   `no-store`, so a nonce is never reused.
import { randomBytes } from "node:crypto";

/** A fresh style nonce: 128 random bits, base64. */
export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/** The nonce text a CSP source and a meta tag may hold: base64 only. */
const NONCE = /^[A-Za-z0-9+/]{22}==$/;

/** The CSP of a response on `port`. With `nonce`, the style nonce of an `index.html`. */
export function contentSecurityPolicy(port: number, nonce?: string): string {
  if (nonce !== undefined && !NONCE.test(nonce)) throw new TypeError("A nonce is base64");
  const p = String(port);
  return [
    "default-src 'self'",
    "script-src 'self'",
    nonce === undefined ? "style-src 'self'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:${p} ws://localhost:${p}`,
    "worker-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
  ].join("; ");
}

/** How a response may be cached. Hashed assets are immutable; everything else is never stored. */
export type CachePolicy = "no-store" | "immutable";

/** The headers of every response (A2 3.8.3). No CORS header is ever among them. */
export function securityHeaders(
  port: number,
  options: { nonce?: string; cache?: CachePolicy } = {},
): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(port, options.nonce),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control":
      options.cache === "immutable" ? "public, max-age=31536000, immutable" : "no-store",
  };
}
