// The secret patterns of A6 3.16.4, in one place: an export refuses a string that matches one
// (bundle/export.ts), and the write path's warning (M4.03) takes the same list.
//
// A6 names each pattern by its prefix. As bare prefixes they would match ordinary words ("task-"
// holds "sk-"), so each pattern is the token's shape: the prefix at the start of a word, then at
// least as many token characters as the issuer's shortest real token. Tokens that are random
// strings of letters and digits must also hold a digit, which no ordinary hyphenated phrase
// ("sk-learn-is-a-library") has. A match names only its kind: never the text.

export const SECRET_KINDS = [
  "private_key",
  "github_token",
  "gitlab_token",
  "api_key",
  "slack_token",
  "aws_access_key",
  "jwt",
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

interface SecretPattern {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
  /** The token must also hold a digit. */
  readonly digit: boolean;
}

/** The patterns, each global so one string is searched past a near miss. */
const PATTERNS: readonly SecretPattern[] = [
  // A PEM header of any private key: RSA, EC, OPENSSH, ENCRYPTED or none.
  { kind: "private_key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, digit: false },
  // GitHub: `ghp_` and 36 characters; fine-grained `github_pat_` and at least 22.
  { kind: "github_token", pattern: /\bghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, digit: false },
  { kind: "github_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, digit: true },
  // GitLab personal access tokens: `glpat-` and at least 20.
  { kind: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, digit: true },
  // `sk-` keys (OpenAI, Anthropic and others): at least 20 after the prefix.
  { kind: "api_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, digit: true },
  // Slack bot, app and user tokens: `xoxb-`, `xoxa-`, `xoxp-` and at least 10.
  { kind: "slack_token", pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}/g, digit: true },
  // AWS access key IDs: `AKIA` and 16 upper-case letters or digits.
  { kind: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}(?![0-9A-Za-z])/g, digit: false },
  // A JWT: three base64url parts, the first two JSON objects (`eyJ` is `{"`).
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    digit: false,
  },
];

const DIGIT = /[0-9]/;

/**
 * The kind of the first secret-shaped token in `text`, or undefined when there is none. Only the
 * kind leaves: the caller reports where it found it, never the text.
 */
export function findSecret(text: string): SecretKind | undefined {
  for (const { kind, pattern, digit } of PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (!digit || DIGIT.test(match[0])) return kind;
    }
  }
  return undefined;
}

/**
 * How much of one chunk a scan of a stream keeps in front of the next, so a token cut by a chunk
 * boundary is still found: any token up to this length, measured from its prefix to the character
 * that decides the match (a JWT's signature, a random token's digit). Tokens have no length limit
 * of their own, but a credential travels in an HTTP header, which servers cap at 8 to 16 KiB.
 */
export const SECRET_OVERLAP = 64 * 1024;
