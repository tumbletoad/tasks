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
import { isOnMain, planRun } from "./plan.ts";
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
import { settingsProblems, type RepositorySettings, type RulesetSettings } from "./settings.ts";
import {
  checkPublishCommit,
  draftAction,
  draftStep,
  rehearsalVersion,
  releaseVersionProblem,
  VersionRefusal,
  type ReleaseSummary,
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

/** The environment and event of the release workflow's signing job, in the run of tag v0.2.0. */
function releaseJob(change: Record<string, string | undefined> = {}, fork = false) {
  const event = join(work, `event-${String(Math.random()).slice(2)}.json`);
  writeFileSync(event, JSON.stringify({ repository: { fork } }));
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/tags/v0.2.0",
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
    await expect(sign({ env: { CI: "1" } })).rejects.toThrow(/outside CI/);
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
    expect(ran.stderr).toMatch(/outside CI/);
  });

  test("without a terminal the command asks nothing and signs nothing", () => {
    const unsigned = folderOf("no-terminal", "0.1.0", ["linux-x64"]);
    const ran = spawnSync(
      process.execPath,
      [MAIN, "sign", "--key", join(keys, KEY_FILE), "--dist", unsigned],
      {
        env: without(["CI", "GITHUB_ACTIONS"]),
        input: `${PASSPHRASE}\n`,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      },
    );
    // Refused before any question, by whichever check comes first for the committed keys.
    expect(ran.status).toBe(2);
    expect(ran.stderr).not.toMatch(/Passphrase/);
    expect(readdirSync(unsigned)).toEqual(["tasks-0.1.0-linux-x64.tar.gz"]);
    // keygen asks first, so it shows the question's own refusal whatever is pinned.
    const out = join(work, "keygen-no-terminal");
    mkdirSync(out);
    const keygen = spawnSync(process.execPath, [MAIN, "keygen", "--out", out], {
      env: without(["CI", "GITHUB_ACTIONS"]),
      input: `${PASSPHRASE}\n${PASSPHRASE}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    expect(keygen.status).toBe(2);
    expect(keygen.stderr).toMatch(/Run this in a terminal/);
    expect(readdirSync(out)).toEqual([]);
  });

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
  test("signs in the run of the archives' version tag, in a repository that is no fork, with the environment's secrets", () => {
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
      [
        "on a pull request",
        releaseJob({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" }),
        /version tag starts/,
      ],
      ["on a manual start", releaseJob({ GITHUB_EVENT_NAME: "workflow_dispatch" }), /tag starts/],
      ["on a push to main", releaseJob({ GITHUB_REF: "refs/heads/main" }), /tag starts/],
      ["on a push to a branch", releaseJob({ GITHUB_REF: "refs/heads/v0.2.0" }), /tag starts/],
      ["on another tag", releaseJob({ GITHUB_REF: "refs/tags/nightly" }), /tag starts/],
      [
        "on another version's tag",
        releaseJob({ GITHUB_REF: "refs/tags/v0.3.0" }),
        /for refs\/tags\/v0.3.0/,
      ],
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
  });

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
  });

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

  test.runIf(process.platform !== "win32")(
    "the command takes the secrets out of its environment before it starts any program",
    () => {
      const tools = join(work, "fake-git");
      mkdirSync(tools);
      const seen = join(work, "git-env.txt");
      writeFileSync(join(tools, "git"), `#!/bin/sh\nenv > '${seen}'\nexit 1\n`, { mode: 0o755 });
      // `rehearse --trust-from` asks git for the keys at a commit before anything else.
      const ran = spawnSync(
        process.execPath,
        [MAIN, "rehearse", "--dist", join(work, "none"), "--trust-from", "HEAD"],
        {
          env: {
            ...process.env,
            PATH: `${tools}:${process.env["PATH"] ?? ""}`,
            [KEY_SECRET]: pem,
            [PASSPHRASE_SECRET]: PASSPHRASE,
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 60_000,
        },
      );
      expect(ran.status).toBe(2);
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

  test("a draft is filled, resumed and left as it is; other bytes, a moved or deleted tag or a change to a published release are refused", () => {
    const local = { a: "1", b: "2" };
    const remote = (draft: boolean, assets: Record<string, string>): RemoteRelease => ({
      id: 1,
      draft,
      target: "main",
      assets,
    });
    expect(draftStep("0.2.0", "c1", local, "c1", undefined)).toEqual({ step: "create" });
    expect(draftStep("0.2.0", "c1", local, "c1", remote(true, { a: "1" }))).toEqual({
      step: "upload",
      names: ["b"],
    });
    expect(draftStep("0.2.0", "c1", local, "c1", remote(true, local))).toEqual({
      step: "done",
      published: false,
    });
    expect(draftStep("0.2.0", "c1", local, "c1", remote(false, local))).toEqual({
      step: "done",
      published: true,
    });
    for (const [what, tag, found, reason] of [
      ["the tag moved to another commit", "c0", remote(true, {}), /now names commit c0/],
      ["the tag deleted", undefined, remote(true, {}), /no longer exists/],
      ["a file with other bytes", "c1", remote(true, { a: "9" }), /other bytes/],
      ["a file this release does not have", "c1", remote(true, { z: "1" }), /other bytes/],
      ["a published release without a file", "c1", remote(false, { a: "1" }), /never changed/],
    ] as const) {
      expect(() => draftStep("0.2.0", "c1", local, tag, found), what).toThrow(VersionRefusal);
      expect(() => draftStep("0.2.0", "c1", local, tag, found), what).toThrow(reason);
    }
  });
});

describe("[A2.3.12.8.build.release-tag] a version tag starts a release only when it is the version of a commit on main that was not released before, and the run holds the release as a draft until its files are complete", () => {
  /** A repository whose commits on `main` carry the given package.json versions. */
  function planRepo(name: string) {
    const repo = join(work, name);
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
    git("config", "tag.gpgsign", "false");
    const commit = (version: string) => {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version }));
      git("add", "package.json");
      git("commit", "-q", "-m", version);
      return git("rev-parse", "HEAD");
    };
    const release = (tag: string) =>
      planRun({ root: repo, mode: "release", ref: tag, run: 7, main: "main" });
    return { repo, git, commit, release };
  }

  test("the plan builds the commit the tag names, with package.json's version, and a rehearsal upgrades from the previous build", () => {
    const { git, commit, release, repo } = planRepo("plan-tag");
    const first = commit("0.1.0");
    const second = commit("0.2.0");
    git("tag", "v0.2.0", second);
    // An annotated tag, as `git tag -a` and GitHub's page make them, names the same commit.
    git("tag", "-a", "-m", "0.1.0", "v0.1.0", first);
    expect(release("v0.2.0")).toMatchObject({ version: "0.2.0", tag: "v0.2.0", commit: second });
    expect(release("v0.2.0").builds.map((b) => b.platform)).toEqual(RELEASE_PLATFORMS);
    expect(release("v0.1.0")).toMatchObject({ version: "0.1.0", commit: first });

    const rehearsal = planRun({ root: repo, mode: "rehearsal", ref: second, run: 7 });
    expect(rehearsal.version).toBe("0.2.0-rehearsal.7.1");
    // The newest release tag before the commit.
    expect(rehearsal.previous).toEqual({ commit: first, version: "0.1.0-rehearsal.7.0" });
    expect(rehearsal.builds).toHaveLength(6);
  });

  test("a tag that is not its commit's version, on a commit off main, of a development version, or missing is refused with one sentence", () => {
    const { git, commit, release } = planRepo("plan-refused");
    const first = commit("0.1.0");
    git("tag", "v0.1.1", first);
    git("tag", "0.1.0", first);
    git("checkout", "-q", "-b", "side");
    const side = commit("0.3.0");
    git("tag", "v0.3.0", side);
    git("checkout", "-q", "main");
    const dev = commit("0.4.0-dev.3");
    git("tag", "v0.4.0-dev.3", dev);
    for (const [what, tag, reason] of [
      [
        "a tag that is not the version",
        "v0.1.1",
        /v0.1.1 is not the version of its commit \(package.json says 0.1.0\)/,
      ],
      ["a tag without the v", "0.1.0", /0.1.0 is not the version of its commit/],
      ["a commit off main", "v0.3.0", /v0.3.0 names [0-9a-f]{40}, which is not on main/],
      ["a development version", "v0.4.0-dev.3", /development or rehearsal version/],
      ["no such tag", "v9.9.9", /There is no tag v9.9.9/],
      ["an option for a tag", "--help", /not a commit or tag/],
    ] as const) {
      expect(() => release(tag), what).toThrow(Refusal);
      expect(() => release(tag), what).toThrow(reason);
      expect(() => release(tag), what).not.toThrow(/\n/);
    }
  });

  test("a version released before is refused; a release made in the page with the tag is held as a draft; a draft is kept", () => {
    const c1 = "1".repeat(40);
    const c0 = "0".repeat(40);
    const release = (draft: boolean, files: string[], target = "main", id = 1): ReleaseSummary => ({
      id,
      draft,
      target,
      files,
    });
    expect(draftAction("0.2.0", c1, [])).toEqual({ action: "create" });
    // Made in GitHub's page, or by gh release create: published with no files yet.
    expect(draftAction("0.2.0", c1, [release(false, [])])).toEqual({ action: "hide", id: 1 });
    // An earlier run's draft, complete or not, or one the owner saved.
    expect(draftAction("0.2.0", c1, [release(true, [])])).toEqual({ action: "keep", id: 1 });
    expect(draftAction("0.2.0", c1, [release(true, ["a"], c1)])).toEqual({ action: "keep", id: 1 });
    for (const [what, found, reason] of [
      [
        "a version released before",
        [release(false, ["SHA256SUMS"], c0)],
        /v0.2.0 is released already/,
      ],
      [
        "a draft with files built from another commit",
        [release(true, ["SHA256SUMS"], c0)],
        /holds files built from 0{40}, not from 1{40}/,
      ],
      [
        "two releases for the tag",
        [release(true, []), release(false, [], "main", 2)],
        /2 releases for v0.2.0/,
      ],
    ] as const) {
      expect(() => draftAction("0.2.0", c1, found), what).toThrow(VersionRefusal);
      expect(() => draftAction("0.2.0", c1, found), what).toThrow(reason);
    }
  });

  test("a release is published only while its tag still names the commit it was built from, on main", () => {
    const { git, commit, repo } = planRepo("plan-publish");
    const first = commit("0.1.0");
    const second = commit("0.2.0");
    git("checkout", "-q", "-b", "side", first);
    const side = commit("0.3.0");
    const onMain = (c: string) => isOnMain(repo, c, "main");
    expect(() => {
      checkPublishCommit("0.2.0", second, second, onMain);
    }).not.toThrow();
    for (const [what, built, tag, reason] of [
      ["a branch name", "main", "main", /not a commit on main/],
      ["a commit off main", side, side, /not a commit on main/],
      ["a tag moved to another commit", second, first, /v0.2.0 now names commit/],
      ["a tag deleted", second, undefined, /v0.2.0 no longer exists/],
    ] as const) {
      expect(() => {
        checkPublishCommit("0.2.0", built, tag, onMain);
      }, what).toThrow(reason);
    }
  });
});

describe("[A2.3.12.8.build.release-settings] a release is refused when the repository's settings let more than the owner start one, or let the release key reach other refs", () => {
  // As GitHub's API gives them for the owner's steps.
  const ruleset: RulesetSettings = {
    name: "release tags",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
    current_user_can_bypass: "never",
  };
  const base: RepositorySettings = {
    environment: {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    policies: [{ name: "v*", type: "tag" }],
    rulesets: [ruleset],
  };

  test("the settings the owner's steps make are ready", () => {
    expect(settingsProblems(base)).toEqual([]);
    // The rules may sit in more than one ruleset, and one may cover every tag.
    expect(
      settingsProblems({
        ...base,
        rulesets: [
          { ...ruleset, rules: [{ type: "creation" }] },
          {
            ...ruleset,
            name: "all tags",
            conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
            rules: [{ type: "update" }, { type: "deletion" }],
          },
        ],
      }),
    ).toEqual([]);
  });

  test("each setting that is not as it must be is named", () => {
    for (const [what, settings, reason] of [
      ["no environment", { ...base, environment: undefined }, /environment does not exist/],
      [
        "an environment open to every ref",
        { ...base, environment: { deployment_branch_policy: null } },
        /does not limit its secrets to tags v\*/,
      ],
      [
        "an environment open to protected branches",
        {
          ...base,
          environment: {
            deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
          },
        },
        /does not limit its secrets/,
      ],
      [
        "an environment that also allows main",
        { ...base, policies: [...base.policies, { name: "main", type: "branch" }] },
        /also gives its secrets to branch main/,
      ],
      [
        "an environment that allows no tag",
        { ...base, policies: [] },
        /gives its secrets to no tag/,
      ],
      [
        "an environment that allows every tag",
        { ...base, policies: [...base.policies, { name: "*", type: "tag" }] },
        /also gives its secrets to tag \*/,
      ],
      ["no tag ruleset", { ...base, rulesets: [] }, /restricts creation, update, deletion/],
      [
        "a ruleset that is only evaluated",
        { ...base, rulesets: [{ ...ruleset, enforcement: "evaluate" }] },
        /restricts creation, update, deletion/,
      ],
      [
        "a ruleset for other tags",
        {
          ...base,
          rulesets: [
            { ...ruleset, conditions: { ref_name: { include: ["refs/tags/release-*"] } } },
          ],
        },
        /restricts creation/,
      ],
      [
        "a ruleset with an exclusion",
        {
          ...base,
          rulesets: [
            {
              ...ruleset,
              conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/v9*"] } },
            },
          ],
        },
        /restricts creation/,
      ],
      [
        "a ruleset that lets tags be moved",
        {
          ...base,
          rulesets: [{ ...ruleset, rules: [{ type: "creation" }, { type: "deletion" }] }],
        },
        /restricts update:/,
      ],
      [
        "a ruleset the workflow's token bypasses",
        { ...base, rulesets: [{ ...ruleset, current_user_can_bypass: "always" }] },
        /token may bypass the tag ruleset release tags/,
      ],
    ] as const) {
      const problems = settingsProblems(settings);
      expect(problems, what).toHaveLength(1);
      expect(problems[0], what).toMatch(reason);
    }
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
    // The install scripts are not covered by the signature: each must be this version's and pin
    // exactly the release keys.
    const sh = join(folder, "install-0.2.0.sh");
    const rendered = readFileSync(sh, "utf8");
    for (const [what, text] of [
      ["an empty script", ""],
      ["one that pins another key", rendered.replaceAll(pinned, other)],
      ["one that pins another key too", rendered.replace(pinned, `${pinned}\n${other}`)],
      ["another version's", rendered.replaceAll("'0.2.0'", "'0.1.0'")],
    ] as const) {
      writeFileSync(sh, text);
      expect(() => {
        checkReleaseFolder(folder, "0.2.0", [pinned]);
      }, what).toThrow(/install-0.2.0.sh is not this release's install script/);
    }
    writeFileSync(sh, rendered);
    // A key added on main since the release was built (a rotation) does not block it.
    expect(() => {
      checkReleaseFolder(folder, "0.2.0", [pinned, other], [pinned]);
    }).not.toThrow();
    const archivePath = join(folder, archiveName("0.2.0", "win-x64"));
    writeFileSync(archivePath, Buffer.concat([readFileSync(archivePath), Buffer.from("x")]));
    expect(() => {
      checkReleaseFolder(folder, "0.2.0", [pinned]);
    }).toThrow(/win-x64: .*does not match/);
  });
});
