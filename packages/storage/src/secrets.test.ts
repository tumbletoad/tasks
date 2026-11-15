// The secret patterns of A6 3.16.4 (A6 5: "The secret scanner, with true and false positives").
// Every token is built from parts at run time, so this file holds no string shaped like a secret.
import { describe, expect, test } from "vitest";
import { findSecret, SECRET_OVERLAP } from "./secrets.ts";

const join = (...parts: string[]): string => parts.join("");
const run = (chars: string, n: number): string =>
  chars.repeat(Math.ceil(n / chars.length)).slice(0, n);

describe("[A6.5.secrets.scanner] the secret patterns find token shapes, not words", () => {
  test("true positives: each kind, alone and inside text", () => {
    const tokens: [string, string][] = [
      ["private_key", join("-----BEGIN ", "RSA PRIVATE KEY", "-----")],
      ["private_key", join("-----BEGIN ", "PRIVATE KEY", "-----")],
      ["private_key", join("-----BEGIN ", "OPENSSH PRIVATE KEY", "-----")],
      ["github_token", join("gh", "p_", run("aB3dE5", 36))],
      ["github_token", join("github", "_pat_", "11ABCDEFG", run("x9Yz", 40))],
      ["gitlab_token", join("gl", "pat-", run("Ab1-", 20))],
      ["api_key", join("s", "k-", "proj-", run("q7R2", 32))],
      ["api_key", join("s", "k-", "ant-api03-", run("Zx8_", 60))],
      ["slack_token", join("xo", "xb-", "1234567890-", run("abc", 12))],
      ["aws_access_key", join("AK", "IA", "IOSFODNN7EXAMPLE")],
      [
        "jwt",
        join(
          "ey",
          "JhbGciOiJIUzI1NiJ9",
          ".",
          "ey",
          "JzdWIiOiIxMjM0NTY3ODkwIn0",
          ".",
          run("dozjg_N-1", 43),
        ),
      ],
    ];
    for (const [kind, token] of tokens) {
      expect(findSecret(token), kind).toBe(kind);
      expect(findSecret(`Use ${token} for the build.`), kind).toBe(kind);
      expect(findSecret(`(${token})`), kind).toBe(kind);
    }
  });

  test("false positives: words, short or digitless look-alikes, and public keys stay unflagged", () => {
    const fine = [
      "task-list for the week",
      "ask-me-anything-about-the-release-plan",
      join("s", "k-", "learn-is-a-great-library-for-models"),
      "risk-assessment-for-the-third-quarter",
      join("gh", "p_", "short"),
      join("gh", "p_", run("aB3", 35)),
      join("gl", "pat-", "tooShort1"),
      join("xo", "xb-", "abc"),
      join("AK", "IA", " is how the keys begin"),
      join("AK", "IA", "IOSFODNN7EXAMPLE", "X"),
      join("ey", "J alone is no token"),
      join("-----BEGIN ", "PUBLIC KEY", "-----"),
      join("-----BEGIN ", "CERTIFICATE", "-----"),
      join("my", "sk-", run("abc1", 30)),
      "",
    ];
    for (const text of fine) expect(findSecret(text), text).toBeUndefined();
  });

  test("a token at the end of a chunk is found once the chunk's tail joins the next", () => {
    const token = join("gl", "pat-", run("Ab1-", 24));
    const text = `${run("plain text ", 3000)} ${token} and more`;
    const cut = text.indexOf(token) + 10;
    // Without the overlap the token is split in two halves that neither match.
    expect(findSecret(text.slice(0, cut))).toBeUndefined();
    expect(findSecret(text.slice(cut))).toBeUndefined();
    expect(findSecret(text.slice(0, cut).slice(-SECRET_OVERLAP) + text.slice(cut))).toBe(
      "gitlab_token",
    );
  });
});
