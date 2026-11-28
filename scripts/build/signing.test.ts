// SHA256SUMS and its two signatures: the raw Ed25519 signature and the SSHSIG, both
// from one key in node:crypto, checked against the tools the install scripts use: ssh-keygen -Y
// verify on every OS, and openssl pkeyutl on Linux (the fallback verifier). Keys are throwaway
// keys made by the test, in a temporary folder, deleted with it.
import { spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  distArchives,
  fingerprint,
  opensshPublicKey,
  parseOpensshPublicKey,
  rawSignature,
  RAW_SIGNATURE,
  SSH_SIGNATURE,
  sshSignature,
  sumsText,
  systemSshKeygen,
  TEST_KEY_FILE,
  testSignSums,
  verifyRawSignature,
  verifySshSignature,
  verifyWithSshKeygen,
  writeSums,
} from "./signing.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ttasks-signing-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const keygen = systemSshKeygen();
const haveKeygen = spawnSync(keygen, ["-?"], { windowsHide: true }).error === undefined;

/** The Ed25519 seed of an unencrypted OpenSSH private key file (PROTOCOL.key), for the cross-check. */
function opensshPrivateKey(text: string): KeyObject {
  const body = text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const data = Buffer.from(body, "base64");
  let at = "openssh-key-v1\0".length;
  const string = (): Buffer => {
    const length = data.readUInt32BE(at);
    const out = data.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return out;
  };
  expect(string().toString()).toBe("none"); // cipher
  string(); // kdf
  string(); // kdf options
  at += 4; // key count
  string(); // public key
  const secret = string();
  at = 0;
  const section = { data: secret };
  const read = (): Buffer => {
    const length = section.data.readUInt32BE(at);
    const out = section.data.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return out;
  };
  at = 8; // two check integers
  expect(read().toString()).toBe("ssh-ed25519");
  const pub = read();
  const priv = read();
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: priv.subarray(0, 32).toString("base64url"),
      x: pub.toString("base64url"),
    },
    format: "jwk",
  });
}

describe("[A2.3.12.4.build.signing] SHA256SUMS signed in raw and OpenSSH formats from one key", () => {
  test("SHA256SUMS lists each archive once, sorted, as sha256sum writes it", () => {
    const dist = join(work, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "ttasks-0.1.0-win-x64.zip"), "zip");
    writeFileSync(join(dist, "ttasks-0.1.0-linux-x64.tar.gz"), "tar");
    writeFileSync(join(dist, "ttasks-0.2.0-linux-x64.tar.gz"), "other version");
    writeFileSync(join(dist, "notes.txt"), "not an archive");
    expect(distArchives(dist, "0.1.0")).toEqual([
      "ttasks-0.1.0-linux-x64.tar.gz",
      "ttasks-0.1.0-win-x64.zip",
    ]);
    const text = writeSums(dist, distArchives(dist, "0.1.0")).toString();
    expect(text).toBe(
      sumsText([
        { name: "ttasks-0.1.0-win-x64.zip", data: Buffer.from("zip") },
        { name: "ttasks-0.1.0-linux-x64.tar.gz", data: Buffer.from("tar") },
      ]),
    );
    expect(text).toMatch(
      /^[0-9a-f]{64} {2}ttasks-0\.1\.0-linux-x64\.tar\.gz\n[0-9a-f]{64} {2}ttasks-0\.1\.0-win-x64\.zip\n$/,
    );
  });

  test("the raw signature is 64 bytes and verifies only the exact file with the key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519").publicKey;
    const sums = Buffer.from("0".repeat(64) + "  ttasks-0.1.0-linux-x64.tar.gz\n");
    const signature = rawSignature(sums, privateKey);
    expect(signature).toHaveLength(64);
    expect(verifyRawSignature(sums, signature, publicKey)).toBe(true);
    expect(verifyRawSignature(Buffer.concat([sums, Buffer.from(" ")]), signature, publicKey)).toBe(
      false,
    );
    expect(verifyRawSignature(sums, signature, other)).toBe(false);
  });

  test("the SSHSIG verifies in node and refuses another file, key or namespace", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sums = Buffer.from("fixture sums\n");
    const armored = sshSignature(sums, privateKey);
    expect(armored).toMatch(
      /^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]{1,70}\n)+-----END SSH SIGNATURE-----\n$/,
    );
    expect(verifySshSignature(sums, armored, publicKey)).toBe(true);
    expect(verifySshSignature(Buffer.from("other\n"), armored, publicKey)).toBe(false);
    expect(verifySshSignature(sums, armored, generateKeyPairSync("ed25519").publicKey)).toBe(false);
    expect(verifySshSignature(sums, armored, publicKey, "other-namespace")).toBe(false);
    expect(verifySshSignature(sums, "not a signature", publicKey)).toBe(false);
    // Public key lines round-trip.
    expect(opensshPublicKey(parseOpensshPublicKey(opensshPublicKey(publicKey, "c")))).toBe(
      opensshPublicKey(publicKey),
    );
  });

  test.runIf(haveKeygen)(
    "the SSHSIG is byte for byte what ssh-keygen -Y sign writes, and ssh-keygen -Y verify accepts it",
    () => {
      const keyFile = join(work, "throwaway-ed25519");
      const made = spawnSync(
        keygen,
        ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", keyFile],
        {
          windowsHide: true,
          encoding: "utf8",
        },
      );
      expect(made.status, made.stderr).toBe(0);
      const key = opensshPrivateKey(readFileSync(keyFile, "utf8"));
      const sums = Buffer.from(`${"a".repeat(64)}  ttasks-0.1.0-win-x64.zip\n`);
      const theirs = spawnSync(
        keygen,
        ["-Y", "sign", "-q", "-f", keyFile, "-n", "ttasks-release"],
        {
          input: sums,
          windowsHide: true,
        },
      );
      expect(theirs.status, theirs.stderr.toString()).toBe(0);
      const ours = sshSignature(sums, key);
      expect(ours).toBe(theirs.stdout.toString().replaceAll("\r\n", "\n"));
      const publicKey = createPublicKey(key);
      expect(readFileSync(`${keyFile}.pub`, "utf8").startsWith(opensshPublicKey(publicKey))).toBe(
        true,
      );
      expect(verifyWithSshKeygen(sums, ours, publicKey, join(work, "verify-1"), keygen)).toBe(true);
      expect(
        verifyWithSshKeygen(
          Buffer.from("tampered\n"),
          ours,
          publicKey,
          join(work, "verify-2"),
          keygen,
        ),
      ).toBe(false);
      // The fingerprint is the one ssh-keygen prints.
      const listed = spawnSync(keygen, ["-l", "-f", `${keyFile}.pub`], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(listed.stdout).toContain(fingerprint(publicKey));
      rmSync(keyFile, { force: true });
      rmSync(`${keyFile}.pub`, { force: true });
    },
  );

  test.runIf(process.platform === "linux" && existsSync("/usr/bin/openssl"))(
    "openssl pkeyutl -verify -rawin accepts the raw signature (A2 3.12.4's Linux fallback)",
    () => {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const dir = join(work, "openssl");
      mkdirSync(dir);
      const sums = Buffer.from("fixture sums for openssl\n");
      writeFileSync(join(dir, "SHA256SUMS"), sums);
      writeFileSync(join(dir, "SHA256SUMS.sig"), rawSignature(sums, privateKey));
      writeFileSync(join(dir, "pub.pem"), publicKey.export({ type: "spki", format: "pem" }));
      const run = (data: string) =>
        spawnSync(
          "/usr/bin/openssl",
          [
            "pkeyutl",
            "-verify",
            "-pubin",
            "-inkey",
            "pub.pem",
            "-rawin",
            "-in",
            data,
            "-sigfile",
            "SHA256SUMS.sig",
          ],
          { cwd: dir, encoding: "utf8" },
        );
      expect(run("SHA256SUMS").status).toBe(0);
      writeFileSync(join(dir, "other"), "other\n");
      expect(run("other").status).not.toBe(0);
    },
  );

  test("a test signing makes a key in memory, signs both formats and writes only its public half", () => {
    const dist = join(work, "test-signed");
    mkdirSync(dist);
    writeFileSync(join(dist, "ttasks-0.1.0-linux-x64.tar.gz"), "tar");
    writeSums(dist, distArchives(dist));
    const signed = testSignSums(dist, join(work, "test-signing"));
    const sums = readFileSync(join(dist, "SHA256SUMS"));
    const publicKey = parseOpensshPublicKey(readFileSync(join(dist, TEST_KEY_FILE), "utf8"));
    expect(readFileSync(join(dist, TEST_KEY_FILE), "utf8")).toMatch(
      / ttasks-throwaway-test-key\n$/,
    );
    expect(signed.fingerprint).toBe(fingerprint(publicKey));
    expect(verifyRawSignature(sums, readFileSync(join(dist, RAW_SIGNATURE)), publicKey)).toBe(true);
    expect(
      verifySshSignature(sums, readFileSync(join(dist, SSH_SIGNATURE), "utf8"), publicKey),
    ).toBe(true);
    // Nothing private was written: the folder holds the archive, the sums, two signatures and a .pub.
    expect(distArchives(dist)).toHaveLength(1);
    for (const name of [RAW_SIGNATURE, SSH_SIGNATURE, TEST_KEY_FILE]) {
      expect(readFileSync(join(dist, name)).toString("latin1")).not.toMatch(/PRIVATE KEY/);
    }
  });
});
