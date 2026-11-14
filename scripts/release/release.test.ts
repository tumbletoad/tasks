// The release script (A2 3.12.8 "sign", A7 3.8 M1.13), tested only with throwaway keys the test
// makes in a temporary folder: it refuses CI, a key inside a checkout, an unencrypted key, a
// test-signed folder and an unexpected key, and signs SHA256SUMS in both formats with the key it is
// given. The real release key is the maintainer's and never appears here.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  opensshPublicKey,
  parseOpensshPublicKey,
  RAW_SIGNATURE,
  SSH_SIGNATURE,
  TEST_KEY_FILE,
  verifyRawSignature,
  verifySshSignature,
  verifyWithSshKeygen,
} from "../build/signing.ts";
import {
  RELEASE_KEY_PLACEHOLDER,
  RELEASE_PUBLIC_KEYS,
} from "../../packages/service/src/version/release-keys.ts";
import { repoRoot } from "../run.ts";
import {
  createReleaseKey,
  KEY_FILE,
  PUBLIC_KEY_FILE,
  readReleaseKey,
  Refusal,
  refuseInCi,
  refuseRepositoryPath,
  releaseSign,
} from "./release.ts";

const PASSPHRASE = "fixture passphrase for a throwaway key";
const NO_CI = { CI: undefined, GITHUB_ACTIONS: undefined };

let work: string;
let keys: string;
let dist: string;
/** The throwaway release key's public line: what the release's install scripts pin here. */
let pinned: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-release-"));
  keys = join(work, "keys");
  mkdirSync(keys);
  createReleaseKey(keys, PASSPHRASE, repoRoot, NO_CI);
  pinned = readFileSync(join(keys, PUBLIC_KEY_FILE), "utf8").trim();
  dist = join(work, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "tasks-0.1.0-linux-x64.tar.gz"), "fixture linux archive");
  writeFileSync(join(dist, "tasks-0.1.0-win-x64.zip"), "fixture windows archive");
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const sign = (options: Partial<Parameters<typeof releaseSign>[0]> = {}) =>
  releaseSign({
    keyFile: join(keys, KEY_FILE),
    dist,
    repoRoot,
    passphrase: () => Promise.resolve(PASSPHRASE),
    env: NO_CI,
    pinned: [pinned],
    ...options,
  });

describe("[A2.3.12.8.build.release-script] the release script signs SHA256SUMS with the release key", () => {
  test("keygen writes an encrypted Ed25519 key and its OpenSSH public key, and replaces nothing", () => {
    const pem = readFileSync(join(keys, KEY_FILE), "utf8");
    expect(pem).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----\n/);
    expect(readFileSync(join(keys, PUBLIC_KEY_FILE), "utf8")).toMatch(
      /^ssh-ed25519 [A-Za-z0-9+/]+=* tasks-release\n$/,
    );
    expect(readReleaseKey(pem, PASSPHRASE).asymmetricKeyType).toBe("ed25519");
    expect(() => readReleaseKey(pem, "wrong passphrase")).toThrow(Refusal);
    expect(() => createReleaseKey(keys, PASSPHRASE, repoRoot, NO_CI)).toThrow(/already/);
    expect(() => createReleaseKey(join(work, "missing"), PASSPHRASE, repoRoot, NO_CI)).toThrow(
      Refusal,
    );
    const fresh = join(work, "short");
    mkdirSync(fresh);
    expect(() => createReleaseKey(fresh, "short", repoRoot, NO_CI)).toThrow(/12 characters/);
    if (process.platform !== "win32") {
      expect(statSync(join(keys, KEY_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  test("signs SHA256SUMS over every archive, in raw and OpenSSH formats, with the key's public half", async () => {
    const signed = await sign({ expect: readFileSync(join(keys, PUBLIC_KEY_FILE), "utf8") });
    expect(signed.archives).toEqual(["tasks-0.1.0-linux-x64.tar.gz", "tasks-0.1.0-win-x64.zip"]);
    const sums = readFileSync(join(dist, "SHA256SUMS"));
    expect(
      sums
        .toString()
        .split("\n")
        .filter((l) => l !== ""),
    ).toHaveLength(2);
    const publicKey = parseOpensshPublicKey(readFileSync(join(keys, PUBLIC_KEY_FILE), "utf8"));
    expect(verifyRawSignature(sums, readFileSync(join(dist, RAW_SIGNATURE)), publicKey)).toBe(true);
    const armored = readFileSync(join(dist, SSH_SIGNATURE), "utf8");
    expect(verifySshSignature(sums, armored, publicKey)).toBe(true);
    // The installers' verifier, where this machine has one.
    expect(verifyWithSshKeygen(sums, armored, publicKey, join(work, "check"))).not.toBe(false);
  });

  test("refuses CI, through the function and through the command", async () => {
    expect(() => {
      refuseInCi({ CI: "true" });
    }).toThrow(Refusal);
    expect(() => {
      refuseInCi({ GITHUB_ACTIONS: "true" });
    }).toThrow(Refusal);
    await expect(sign({ env: { CI: "1" } })).rejects.toThrow(/never in CI/);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "CI" && name !== "GITHUB_ACTIONS"),
    );
    const ran = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "release", "main.ts"),
        "sign",
        "--key",
        join(keys, KEY_FILE),
        "--dist",
        dist,
      ],
      { env: { ...env, CI: "true" }, encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    expect(ran.status).toBe(2);
    expect(ran.stderr).toMatch(/never in CI/);
  }, 60_000);

  test("without a terminal the command asks nothing and signs nothing", () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "CI" && name !== "GITHUB_ACTIONS"),
    );
    const ran = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "release", "main.ts"),
        "sign",
        "--key",
        join(keys, KEY_FILE),
        "--dist",
        dist,
      ],
      { env, input: `${PASSPHRASE}\n`, encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    expect(ran.status).toBe(2);
    // While the release key is not pinned, that refusal comes first, also before any question.
    expect(ran.stderr).toMatch(
      RELEASE_PUBLIC_KEYS.includes(RELEASE_KEY_PLACEHOLDER) ? /not pinned yet/ : /terminal/,
    );
  }, 60_000);

  test("writes the release's install scripts pinning the release keys, and signs nothing while they are not pinned or the key is not one of them", async () => {
    const asked = (): Promise<string> => Promise.reject(new Error("the passphrase was asked"));
    const fresh = join(work, "pinning");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "tasks-0.1.0-linux-x64.tar.gz"), "fixture linux archive");
    // The placeholder: refused before the passphrase is asked, nothing written.
    await expect(
      sign({ dist: fresh, pinned: [RELEASE_KEY_PLACEHOLDER], passphrase: asked }),
    ).rejects.toThrow(/not pinned yet/);
    // A key that is not the pinned one: refused, nothing signed.
    const other = opensshPublicKey(generateKeyPairSync("ed25519").publicKey);
    await expect(sign({ dist: fresh, pinned: [other] })).rejects.toThrow(/not one of the pinned/);
    expect(existsSync(join(fresh, "SHA256SUMS"))).toBe(false);
    // The pinned key, with the next key of a rotation beside it.
    const signed = await sign({ dist: fresh, pinned: [pinned, other] });
    expect(signed.installers).toEqual(["install-0.1.0.sh", "install-0.1.0.ps1"]);
    const sh = readFileSync(join(fresh, "install-0.1.0.sh"), "utf8");
    const ps1 = readFileSync(join(fresh, "install-0.1.0.ps1"), "utf8");
    const line = pinned.split(" ").slice(0, 2).join(" ");
    expect(sh).toContain(`RELEASE_KEYS='${line}\n${other}'`);
    expect(ps1).toContain(`$ReleaseKeys = @('${line}', '${other}')`);
    expect(sh).toContain("(release build)");
    expect(sh).not.toContain("@@");
  });

  test("refuses a key inside the repository or any git work tree", () => {
    expect(() => {
      refuseRepositoryPath(join(repoRoot, "scripts", "release", "key.pem"), repoRoot);
    }).toThrow(/inside the repository/);
    const checkout = join(work, "other-checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    expect(() => {
      refuseRepositoryPath(join(checkout, "nested", "key.pem"), repoRoot);
    }).toThrow(/git work tree/);
    expect(() => {
      refuseRepositoryPath(join(keys, KEY_FILE), repoRoot);
    }).not.toThrow();
  });

  test("refuses an unencrypted key, a test-signed folder, an unexpected key and an empty folder", async () => {
    const plain = join(work, "plain.pem");
    writeFileSync(
      plain,
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    await expect(sign({ keyFile: plain })).rejects.toThrow(/encrypted/);

    const other = generateKeyPairSync("ed25519").publicKey;
    await expect(sign({ expect: opensshPublicKey(other) })).rejects.toThrow(/not the expected/);

    const tested = join(work, "tested");
    mkdirSync(tested);
    writeFileSync(join(tested, "tasks-0.1.0-linux-x64.tar.gz"), "x");
    writeFileSync(join(tested, TEST_KEY_FILE), "ssh-ed25519 AAAA test\n");
    await expect(sign({ dist: tested })).rejects.toThrow(/throwaway test key/);

    const empty = join(work, "empty");
    mkdirSync(empty);
    await expect(sign({ dist: empty })).rejects.toThrow(/no release archive/);

    const mixed = join(work, "mixed");
    mkdirSync(mixed);
    writeFileSync(join(mixed, "tasks-0.1.0-linux-x64.tar.gz"), "x");
    writeFileSync(join(mixed, "tasks-0.1.0-dev.7-win-x64.zip"), "y");
    await expect(sign({ dist: mixed })).rejects.toThrow(/more than one version/);
    expect(existsSync(join(mixed, "SHA256SUMS"))).toBe(false);
  });

  test("takes only a key file that is exactly one encrypted PKCS#8 key", () => {
    const encrypted = readFileSync(join(keys, KEY_FILE), "utf8");
    const plain = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const header = "-----BEGIN ENCRYPTED PRIVATE KEY-----";
    for (const [what, pem] of [
      ["a plain key with the encrypted header after it", `${plain}${header}\n`],
      ["a plain key with the encrypted header before it", `${header}\n${plain}`],
      ["a plain key, then the encrypted one", `${plain}${encrypted}`],
      ["the encrypted key, then a plain one", `${encrypted}${plain}`],
      ["the encrypted key twice", `${encrypted}${encrypted}`],
      ["the encrypted key with text after it", `${encrypted}trailing\n`],
      ["the encrypted key with text before it", `note\n${encrypted}`],
    ] as const) {
      expect(() => readReleaseKey(pem, PASSPHRASE), what).toThrow(Refusal);
    }
    // Line ends and a final newline are not the key's content.
    expect(readReleaseKey(encrypted.replaceAll("\n", "\r\n"), PASSPHRASE).type).toBe("private");
    expect(readReleaseKey(encrypted.trimEnd(), PASSPHRASE).type).toBe("private");
  });

  test.runIf(process.platform !== "win32")("refuses a key file other users can read", async () => {
    const open = join(work, "open-keys");
    mkdirSync(open);
    createReleaseKey(open, PASSPHRASE, repoRoot, NO_CI);
    chmodSync(join(open, KEY_FILE), 0o644);
    await expect(sign({ keyFile: join(open, KEY_FILE) })).rejects.toThrow(/chmod 600/);
  });
});
