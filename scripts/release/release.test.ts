// The release script, tested only with throwaway keys the tests make in a temporary folder. The
// real release key is the owner's and never appears here.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeTarGz, writeZip } from "../build/archive.ts";
import { archiveName, type Platform } from "../build/platforms.ts";
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
import { ReleaseError, verifyRelease } from "../../packages/service/src/version/release.ts";
import { repoRoot } from "../run.ts";
import { gatherArchives, RELEASE_PLATFORMS } from "./gather.ts";
import { checkReleaseFolder } from "./github.ts";
import { planRun } from "./plan.ts";
import {
  ciReleaseSign,
  createReleaseKey,
  KEY_FILE,
  KEY_SECRET,
  PASSPHRASE_SECRET,
  PUBLIC_KEY_FILE,
  readReleaseKey,
  redact,
  Refusal,
  refuseInCi,
  refuseRepositoryPath,
  rehearsalSign,
  releaseSign,
  takeSecrets,
} from "./release.ts";
import {
  draftStep,
  rehearsalVersion,
  releaseVersionProblem,
  VersionRefusal,
  type RemoteRelease,
} from "./version.ts";

const PASSPHRASE = "fixture passphrase for a throwaway key";
const NO_CI = { CI: undefined, GITHUB_ACTIONS: undefined };
const MAIN = join(repoRoot, "scripts", "release", "main.ts");

let work: string;
let keys: string;
let dist: string;
/** The throwaway release key's public line: what the tests pin as the release key. */
let pinned: string;
let pem: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-release-"));
  keys = join(work, "keys");
  mkdirSync(keys);
  createReleaseKey(keys, PASSPHRASE, repoRoot, NO_CI);
  pinned = readFileSync(join(keys, PUBLIC_KEY_FILE), "utf8")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
  pem = readFileSync(join(keys, KEY_FILE), "utf8");
  dist = folderOf("dist", "0.1.0", ["linux-x64", "win-x64"]);
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * A release archive whose updater trusts `trusts` (key lines written in its lib/, as a build
 * writes them), with a manifest so it reads like a version folder.
 */
function archive(version: string, platform: Platform, trusts: readonly string[]): Buffer {
  const entries = [
    {
      path: "lib/tasks.mjs",
      data: Buffer.from(`const UPDATE_KEYS = ${JSON.stringify(trusts)};\n`),
      mode: 0o644,
    },
    {
      path: "manifest.json",
      data: Buffer.from(JSON.stringify({ version, build: "fixture", platform })),
      mode: 0o644,
    },
  ];
  return platform === "win-x64" ? writeZip(entries) : writeTarGz(entries);
}

/** A new folder in `work` with archives of `version` that trust `trusts` (default: the pinned key). */
function folderOf(
  name: string,
  version: string,
  platforms: readonly Platform[],
  trusts: readonly string[] = [pinned],
): string {
  const folder = join(work, name);
  mkdirSync(folder);
  for (const platform of platforms) {
    writeFileSync(join(folder, archiveName(version, platform)), archive(version, platform, trusts));
  }
  return folder;
}

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

/** The environment and event of the release workflow's signing job. */
function releaseJob(change: Record<string, string | undefined> = {}, fork = false) {
  const event = join(work, `event-${String(Math.random()).slice(2)}.json`);
  writeFileSync(event, JSON.stringify({ repository: { fork } }));
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_PATH: event,
    ...change,
  };
}

const ciSign = (
  folder: string,
  options: {
    env?: Record<string, string | undefined>;
    key?: string;
    passphrase?: string;
    pinned?: string[];
  } = {},
) =>
  ciReleaseSign({
    dist: folder,
    secrets: { key: options.key ?? pem, passphrase: options.passphrase ?? PASSPHRASE },
    env: options.env ?? releaseJob(),
    pinned: options.pinned ?? [pinned],
  });

const without = (names: readonly string[]) =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name)));

describe("[A2.3.12.8.build.release-script] the release script signs SHA256SUMS with the release key", () => {
  test("keygen writes an encrypted Ed25519 key and its OpenSSH public key, and replaces nothing", () => {
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
    const publicKey = parseOpensshPublicKey(pinned);
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
    await expect(sign({ env: { CI: "1" } })).rejects.toThrow(/owner's machine/);
    const ran = spawnSync(
      process.execPath,
      [MAIN, "sign", "--key", join(keys, KEY_FILE), "--dist", dist],
      {
        env: { ...without(["CI", "GITHUB_ACTIONS"]), CI: "true" },
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      },
    );
    expect(ran.status).toBe(2);
    expect(ran.stderr).toMatch(/owner's machine/);
  }, 60_000);

  test("without a terminal the command asks nothing and signs nothing", () => {
    const ran = spawnSync(
      process.execPath,
      [MAIN, "sign", "--key", join(keys, KEY_FILE), "--dist", dist],
      {
        env: without(["CI", "GITHUB_ACTIONS"]),
        input: `${PASSPHRASE}\n`,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      },
    );
    expect(ran.status).toBe(2);
    // While the release key is not pinned, that refusal comes first, also before any question.
    expect(ran.stderr).toMatch(
      RELEASE_PUBLIC_KEYS.includes(RELEASE_KEY_PLACEHOLDER) ? /not pinned yet/ : /terminal/,
    );
  }, 60_000);

  test("writes the release's install scripts pinning the release keys, and signs nothing while they are not pinned or the key is not one of them", async () => {
    const asked = (): Promise<string> => Promise.reject(new Error("the passphrase was asked"));
    const fresh = folderOf("pinning", "0.1.0", ["linux-x64"]);
    // The placeholder: refused before the passphrase is asked, nothing written.
    await expect(
      sign({ dist: fresh, pinned: [RELEASE_KEY_PLACEHOLDER], passphrase: asked }),
    ).rejects.toThrow(/not pinned yet/);
    // A key that is not the pinned one: refused, nothing signed.
    const other = opensshPublicKey(generateKeyPairSync("ed25519").publicKey);
    const trustsOther = folderOf("pinning-other", "0.1.0", ["linux-x64"], [other]);
    await expect(sign({ dist: trustsOther, pinned: [other] })).rejects.toThrow(
      /not one of the pinned/,
    );
    expect(existsSync(join(trustsOther, "SHA256SUMS"))).toBe(false);
    // The pinned key, with the next key of a rotation beside it.
    const rotating = folderOf("pinning-rotation", "0.1.0", ["linux-x64"], [pinned, other]);
    const signed = await sign({ dist: rotating, pinned: [pinned, other] });
    expect(signed.installers).toEqual(["install-0.1.0.sh", "install-0.1.0.ps1"]);
    const sh = readFileSync(join(rotating, "install-0.1.0.sh"), "utf8");
    const ps1 = readFileSync(join(rotating, "install-0.1.0.ps1"), "utf8");
    expect(sh).toContain(`RELEASE_KEYS='${pinned}\n${other}'`);
    expect(ps1).toContain(`$ReleaseKeys = @('${pinned}', '${other}')`);
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

  test("refuses an unencrypted key, a test-signed folder, an unexpected key, an empty folder, mixed versions and a development version", async () => {
    const plain = join(work, "plain.pem");
    writeFileSync(
      plain,
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    await expect(sign({ keyFile: plain })).rejects.toThrow(/encrypted/);

    const other = generateKeyPairSync("ed25519").publicKey;
    await expect(sign({ expect: opensshPublicKey(other) })).rejects.toThrow(/not the expected/);

    const tested = folderOf("tested", "0.1.0", ["linux-x64"]);
    writeFileSync(join(tested, TEST_KEY_FILE), "ssh-ed25519 AAAA test\n");
    await expect(sign({ dist: tested })).rejects.toThrow(/throwaway test key/);

    const empty = join(work, "empty");
    mkdirSync(empty);
    await expect(sign({ dist: empty })).rejects.toThrow(/no release archive/);

    const mixed = folderOf("mixed", "0.1.0", ["linux-x64"]);
    writeFileSync(
      join(mixed, "tasks-0.1.0-dev.7-win-x64.zip"),
      archive("0.1.0-dev.7", "win-x64", [pinned]),
    );
    await expect(sign({ dist: mixed })).rejects.toThrow(/more than one version/);
    expect(existsSync(join(mixed, "SHA256SUMS"))).toBe(false);

    for (const version of ["0.1.0-dev.7", "0.1.0-rehearsal.3.1"]) {
      const reserved = folderOf(`reserved-${version}`, version, ["linux-x64"]);
      await expect(sign({ dist: reserved })).rejects.toThrow(/development or rehearsal version/);
    }
  });

  test("refuses archives whose updater trusts another key than the release keys, or none", async () => {
    const throwaway = opensshPublicKey(generateKeyPairSync("ed25519").publicKey);
    const testBuild = folderOf("trusts-test-key", "0.1.0", ["linux-x64"], [throwaway]);
    await expect(sign({ dist: testBuild })).rejects.toThrow(/trusts other keys/);
    const beforePinning = folderOf(
      "trusts-nothing",
      "0.1.0",
      ["linux-x64"],
      [RELEASE_KEY_PLACEHOLDER],
    );
    await expect(sign({ dist: beforePinning })).rejects.toThrow(/trusts no release key/);
    expect(readdirSync(testBuild)).toEqual(["tasks-0.1.0-linux-x64.tar.gz"]);
  });

  test("takes only a key file that is exactly one encrypted PKCS#8 key", () => {
    const plain = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const header = "-----BEGIN ENCRYPTED PRIVATE KEY-----";
    for (const [what, text] of [
      ["a plain key with the encrypted header after it", `${plain}${header}\n`],
      ["a plain key with the encrypted header before it", `${header}\n${plain}`],
      ["a plain key, then the encrypted one", `${plain}${pem}`],
      ["the encrypted key, then a plain one", `${pem}${plain}`],
      ["the encrypted key twice", `${pem}${pem}`],
      ["the encrypted key with text after it", `${pem}trailing\n`],
      ["the encrypted key with text before it", `note\n${pem}`],
    ] as const) {
      expect(() => readReleaseKey(text, PASSPHRASE), what).toThrow(Refusal);
    }
    // Line ends and a final newline are not the key's content.
    expect(readReleaseKey(pem.replaceAll("\n", "\r\n"), PASSPHRASE).type).toBe("private");
    expect(readReleaseKey(pem.trimEnd(), PASSPHRASE).type).toBe("private");
  });

  test.runIf(process.platform !== "win32")("refuses a key file other users can read", async () => {
    const open = join(work, "open-keys");
    mkdirSync(open);
    createReleaseKey(open, PASSPHRASE, repoRoot, NO_CI);
    chmodSync(join(open, KEY_FILE), 0o644);
    await expect(sign({ keyFile: join(open, KEY_FILE) })).rejects.toThrow(/chmod 600/);
  });
});

describe("[A2.3.12.8.build.release-ci-sign] the release workflow signs with the key from its secrets, only in its signing job, and the secrets reach no output or child process", () => {
  test("signs a dispatch from main in a repository that is no fork, with the environment's secrets", () => {
    const folder = folderOf("ci", "0.2.0", ["linux-x64", "win-x64"]);
    const signed = ciSign(folder);
    expect(signed.publicKey).toBe(pinned);
    expect(signed.installers).toEqual(["install-0.2.0.sh", "install-0.2.0.ps1"]);
    expect(existsSync(join(folder, TEST_KEY_FILE))).toBe(false);
    const sums = readFileSync(join(folder, "SHA256SUMS"));
    expect(
      verifyRawSignature(
        sums,
        readFileSync(join(folder, RAW_SIGNATURE)),
        parseOpensshPublicKey(pinned),
      ),
    ).toBe(true);
  });

  test("refuses every other job, before the secrets are read", () => {
    const folder = folderOf("ci-refused", "0.2.0", ["linux-x64"]);
    // A key text that would be refused for itself: each refusal below comes before it is read.
    const unread = { key: "not a key", pinned: [pinned] };
    for (const [what, env, reason] of [
      [
        "outside GitHub Actions",
        releaseJob({ GITHUB_ACTIONS: undefined }),
        /only in the release workflow/,
      ],
      ["on a pull request", releaseJob({ GITHUB_EVENT_NAME: "pull_request" }), /started by hand/],
      ["on a push", releaseJob({ GITHUB_EVENT_NAME: "push" }), /started by hand/],
      ["from another branch", releaseJob({ GITHUB_REF: "refs/heads/feature" }), /from main/],
      ["from a pull request's ref", releaseJob({ GITHUB_REF: "refs/pull/7/merge" }), /from main/],
      ["on a fork", releaseJob({}, true), /fork/],
      [
        "without the run's event",
        releaseJob({ GITHUB_EVENT_PATH: join(work, "no-event.json") }),
        /event/,
      ],
    ] as const) {
      expect(() => ciSign(folder, { ...unread, env }), what).toThrow(reason);
    }
    // Outside the release environment its secrets are empty.
    expect(() => ciSign(folder, { key: "" })).toThrow(/only in the release environment/);
    expect(() => ciSign(folder, { passphrase: "" })).toThrow(/only in the release environment/);
    expect(readdirSync(folder)).toEqual(["tasks-0.2.0-linux-x64.tar.gz"]);
  });

  test("refuses a test key under the release name, an unencrypted key, a wrong passphrase and the placeholder", () => {
    const folder = folderOf("ci-keys", "0.2.0", ["linux-x64"]);
    const testKey = generateKeyPairSync("ed25519", {
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: PASSPHRASE,
      },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    expect(() => ciSign(folder, { key: testKey })).toThrow(/not one of the pinned/);
    const plain = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    expect(() => ciSign(folder, { key: plain })).toThrow(/encrypted/);
    expect(() => ciSign(folder, { passphrase: "another passphrase" })).toThrow(/does not open/);
    expect(() => ciSign(folder, { pinned: [RELEASE_KEY_PLACEHOLDER] })).toThrow(/not pinned yet/);
    expect(readdirSync(folder)).toEqual(["tasks-0.2.0-linux-x64.tar.gz"]);
  });

  test("takes the key from the secrets only: a key file is refused, wherever it lies", () => {
    const ran = spawnSync(
      process.execPath,
      [MAIN, "sign-ci", "--key", join(repoRoot, "key.pem"), "--dist", dist],
      {
        env: { ...process.env, ...releaseJob() },
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      },
    );
    expect(ran.status).toBe(2);
    expect(ran.stderr).toMatch(/Unknown option '--key'/);
  }, 60_000);

  test("the secrets leave the environment first, and no message prints them", () => {
    const env: Record<string, string | undefined> = {
      [KEY_SECRET]: pem,
      [PASSPHRASE_SECRET]: PASSPHRASE,
      PATH: "x",
    };
    const secrets = takeSecrets(env);
    expect(env).toEqual({ PATH: "x" });
    expect(secrets).toEqual({ key: pem, passphrase: PASSPHRASE });
    const body = pem.split("\n")[1] ?? "";
    expect(redact(`failed with ${PASSPHRASE} and ${body}`, secrets)).toBe(
      "failed with *** and ***",
    );

    // The command, refused at each stage, prints neither secret.
    const folder = folderOf("ci-command", "0.2.0", ["linux-x64"]);
    for (const job of [releaseJob({ GITHUB_EVENT_NAME: "pull_request" }), releaseJob()]) {
      const ran = spawnSync(process.execPath, [MAIN, "sign-ci", "--dist", folder], {
        env: { ...process.env, ...job, [KEY_SECRET]: pem, [PASSPHRASE_SECRET]: PASSPHRASE },
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      expect(ran.status).toBe(2);
      const output = `${ran.stdout}${ran.stderr}`;
      expect(output).not.toContain(PASSPHRASE);
      for (const line of pem.split("\n").filter((l) => l !== "" && !l.startsWith("-----"))) {
        expect(output).not.toContain(line);
      }
    }
  }, 120_000);

  test.runIf(process.platform !== "win32")(
    "a program the signing starts (ssh-keygen) does not inherit the secrets",
    () => {
      const tools = join(work, "fake-tools");
      mkdirSync(tools);
      const seen = join(work, "ssh-keygen-env.txt");
      writeFileSync(
        join(tools, "ssh-keygen"),
        `#!/bin/sh\nenv > '${seen}'\ncat > /dev/null\nexit 0\n`,
        {
          mode: 0o755,
        },
      );
      const saved = { ...process.env };
      try {
        process.env["PATH"] = `${tools}:${process.env["PATH"] ?? ""}`;
        process.env[KEY_SECRET] = pem;
        process.env[PASSPHRASE_SECRET] = PASSPHRASE;
        // As main.ts does first.
        const secrets = takeSecrets(process.env);
        ciReleaseSign({
          dist: folderOf("ci-child", "0.2.0", ["linux-x64"]),
          secrets,
          env: releaseJob(),
          pinned: [pinned],
        });
      } finally {
        for (const name of Object.keys(process.env))
          if (!(name in saved)) Reflect.deleteProperty(process.env, name);
        Object.assign(process.env, saved);
      }
      const childEnv = readFileSync(seen, "utf8");
      expect(childEnv).toContain("PATH=");
      expect(childEnv).not.toContain(KEY_SECRET);
      expect(childEnv).not.toContain(PASSPHRASE);
    },
  );
});

describe("[A2.3.12.8.build.release-rehearsal] a rehearsal signs what a release would, with a key no product trusts, and can never pass for a release", () => {
  test("signs with a key made for the call, marks the folder and its install scripts, and the product refuses it", () => {
    const folder = folderOf("rehearsal", "0.1.0-rehearsal.4.1", ["linux-x64", "win-x64"], []);
    const signed = rehearsalSign(folder, [RELEASE_KEY_PLACEHOLDER]);
    expect(signed.installers).toEqual([
      "install-0.1.0-rehearsal.4.1-test.sh",
      "install-0.1.0-rehearsal.4.1-test.ps1",
    ]);
    expect(readFileSync(join(folder, TEST_KEY_FILE), "utf8")).toContain(signed.publicKey);
    expect(readFileSync(join(folder, signed.installers[0] ?? ""), "utf8")).toContain(
      "(test build)",
    );
    const sums = readFileSync(join(folder, "SHA256SUMS"));
    expect(
      verifyRawSignature(
        sums,
        readFileSync(join(folder, RAW_SIGNATURE)),
        parseOpensshPublicKey(signed.publicKey),
      ),
    ).toBe(true);
    // The product's updater, with today's keys and with a real pinned key.
    const archivePath = join(folder, "tasks-0.1.0-rehearsal.4.1-linux-x64.tar.gz");
    for (const [trusted, reason] of [
      [
        RELEASE_PUBLIC_KEYS,
        RELEASE_PUBLIC_KEYS.includes(RELEASE_KEY_PLACEHOLDER) ? "no_trusted_key" : "bad_signature",
      ],
      [[pinned], "bad_signature"],
    ] as const) {
      expect(() => verifyRelease(archivePath, trusted, "linux-x64")).toThrow(
        expect.objectContaining({ reason }) as ReleaseError,
      );
    }
    // A release signing refuses the rehearsal's folder, and so does publishing.
    expect(() => ciSign(folder)).toThrow(/throwaway test key/);
    expect(() => {
      checkReleaseFolder(folder, "0.1.0-rehearsal.4.1", [pinned]);
    }).toThrow(/never published/);
  });

  test("signs only rehearsal versions, and only archives that trust the committed release keys", () => {
    const release = folderOf("rehearsal-release-version", "0.1.0", ["linux-x64"], []);
    expect(() => rehearsalSign(release, [RELEASE_KEY_PLACEHOLDER])).toThrow(
      /only rehearsal versions/,
    );
    const trusting = folderOf("rehearsal-trusts", "0.1.0-rehearsal.4.1", ["linux-x64"], [pinned]);
    expect(() => rehearsalSign(trusting, [RELEASE_KEY_PLACEHOLDER])).toThrow(/trusts other keys/);
    expect(rehearsalSign(trusting, [pinned]).archives).toHaveLength(1);
  });
});

describe("[A2.3.12.8.build.release-version] a release's version comes from package.json, and the same version is never released with other bytes", () => {
  test("release and rehearsal versions", () => {
    expect(releaseVersionProblem("0.1.0")).toBeUndefined();
    expect(releaseVersionProblem("1.2.3-beta.1")).toBeUndefined();
    for (const version of ["0.1", "0.1.0-dev.12", "0.1.0-rehearsal.1.1", "0.1.0-DEV", "v0.1.0"]) {
      expect(releaseVersionProblem(version), version).toBeDefined();
    }
    expect(rehearsalVersion("0.3.0-beta.2", 41, 1)).toBe("0.3.0-rehearsal.41.1");
    expect(rehearsalVersion("0.3.0", 41, 0)).toBe("0.3.0-rehearsal.41.0");
  });

  test("a draft is made, resumed and left as it is; other bytes, another commit or a change to a published release are refused", () => {
    const local = { a: "1", b: "2" };
    const remote = (
      draft: boolean,
      assets: Record<string, string>,
      target = "c1",
    ): RemoteRelease => ({
      id: 1,
      draft,
      target,
      assets,
    });
    expect(draftStep("0.2.0", "c1", local, undefined, undefined)).toEqual({ step: "create" });
    expect(draftStep("0.2.0", "c1", local, undefined, remote(true, { a: "1" }))).toEqual({
      step: "upload",
      names: ["b"],
    });
    expect(draftStep("0.2.0", "c1", local, undefined, remote(true, local))).toEqual({
      step: "done",
      published: false,
    });
    expect(draftStep("0.2.0", "c1", local, "c1", remote(false, local))).toEqual({
      step: "done",
      published: true,
    });
    for (const [what, tag, found, reason] of [
      ["the tag on another commit", "c0", undefined, /names commit c0/],
      [
        "a draft for another commit",
        undefined,
        remote(true, {}, "c0"),
        /draft of v0.2.0 is for c0/,
      ],
      ["a file with other bytes", undefined, remote(true, { a: "9" }), /other bytes/],
      ["a file this release does not have", undefined, remote(true, { z: "1" }), /other bytes/],
      ["a published release without a file", "c1", remote(false, { a: "1" }), /never changed/],
    ] as const) {
      expect(() => draftStep("0.2.0", "c1", local, tag, found), what).toThrow(VersionRefusal);
      expect(() => draftStep("0.2.0", "c1", local, tag, found), what).toThrow(reason);
    }
  });

  test("the plan takes the version from package.json at the commit, a release only from main, and a rehearsal upgrades from the previous build", () => {
    const repo = join(work, "plan-repo");
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const ran = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
      if (ran.status !== 0) throw new Error(ran.stderr);
      return ran.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    const commit = (version: string) => {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version }));
      git("add", "package.json");
      git("commit", "-q", "-m", version);
      return git("rev-parse", "HEAD");
    };
    const first = commit("0.1.0");
    const second = commit("0.2.0");
    const plan = planRun({ root: repo, mode: "release", ref: second, run: 7, main: "main" });
    expect(plan).toMatchObject({ version: "0.2.0", tag: "v0.2.0", commit: second });
    expect(plan.builds.map((b) => b.platform)).toEqual(RELEASE_PLATFORMS);
    const rehearsal = planRun({ root: repo, mode: "rehearsal", ref: second, run: 7 });
    expect(rehearsal.version).toBe("0.2.0-rehearsal.7.1");
    expect(rehearsal.previous).toEqual({ commit: first, version: "0.1.0-rehearsal.7.0" });
    expect(rehearsal.builds).toHaveLength(6);
    git("checkout", "-q", "-b", "side", first);
    const side = commit("0.3.0");
    expect(() => planRun({ root: repo, mode: "release", ref: side, run: 7, main: "main" })).toThrow(
      /only from main/,
    );
    git("checkout", "-q", "main");
    const dev = commit("0.4.0-dev.3");
    expect(() => planRun({ root: repo, mode: "release", ref: dev, run: 7, main: "main" })).toThrow(
      /development/,
    );
    expect(() => planRun({ root: repo, mode: "release", ref: "--help", run: 7 })).toThrow(Refusal);
  });
});

describe("[A2.3.12.8.build.release-files] the signing job signs exactly the archives its builds checked, and a draft is published only when every file verifies", () => {
  test("gathers one archive per platform, each matching its own build's SHA256SUMS", () => {
    const from = join(work, "artifacts");
    for (const platform of RELEASE_PLATFORMS) {
      // As download-artifact lays them out: one folder per build job's artifact.
      const name = archiveName("0.2.0", platform);
      const data = archive("0.2.0", platform, [pinned]);
      const target = join(from, `unsigned-current-${platform}`);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, name), data);
      writeFileSync(
        join(target, "SHA256SUMS"),
        `${createHash("sha256").update(data).digest("hex")}  ${name}
`,
      );
    }
    const out = join(work, "gathered");
    expect(gatherArchives({ from, prefix: "unsigned-current-", version: "0.2.0", out })).toEqual(
      RELEASE_PLATFORMS.map((p) => archiveName("0.2.0", p)).sort(),
    );
    // A changed archive, or a missing platform, gathers nothing.
    const changed = join(from, "unsigned-current-linux-x64", archiveName("0.2.0", "linux-x64"));
    writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from("x")]));
    expect(() =>
      gatherArchives({
        from,
        prefix: "unsigned-current-",
        version: "0.2.0",
        out: join(work, "gathered-2"),
      }),
    ).toThrow(/does not match the SHA256SUMS its build wrote/);
    expect(() =>
      gatherArchives({
        from,
        prefix: "unsigned-current-win",
        version: "0.2.0",
        out: join(work, "gathered-3"),
      }),
    ).toThrow(/not tasks-0.2.0-linux-arm64/);
    expect(existsSync(join(work, "gathered-2"))).toBe(false);
  });

  test("a signed release folder verifies before publishing; a changed archive or an extra file does not", () => {
    const folder = folderOf("publish", "0.2.0", [...RELEASE_PLATFORMS]);
    ciSign(folder);
    expect(() => {
      checkReleaseFolder(folder, "0.2.0", [pinned]);
    }).not.toThrow();
    const other = opensshPublicKey(generateKeyPairSync("ed25519").publicKey);
    expect(() => {
      checkReleaseFolder(folder, "0.2.0", [other]);
    }).toThrow(/not signed in both formats by a pinned release key/);
    writeFileSync(join(folder, "notes.txt"), "x");
    expect(() => {
      checkReleaseFolder(folder, "0.2.0", [pinned]);
    }).toThrow(/files it should not: notes.txt/);
    rmSync(join(folder, "notes.txt"));
    const archivePath = join(folder, archiveName("0.2.0", "win-x64"));
    writeFileSync(archivePath, Buffer.concat([readFileSync(archivePath), Buffer.from("x")]));
    expect(() => {
      checkReleaseFolder(folder, "0.2.0", [pinned]);
    }).toThrow(/win-x64: .*does not match/);
  });
});
