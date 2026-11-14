// Signing a release (A2 3.12.4, 3.12.5, 3.12.8 "sign"; A7 2 P9): SHA256SUMS over the release
// archives, signed with the Ed25519 release key in both formats, SHA256SUMS.sig (raw) and
// SHA256SUMS.sshsig (OpenSSH, namespace tasks-release). The v1 key lives on the owner's machine and is
// used there by hand; CI never sees it (it test-signs with a throwaway key, `pnpm build --sign
// test`).
//
// The key is an Ed25519 private key in PKCS#8, encrypted with a passphrase (`pnpm release keygen`
// writes one), so node:crypto signs both formats from the one key without any other tool. What
// this module refuses, so the key cannot leak through it or be used where it does not belong:
//   - any CI environment (CI or GITHUB_ACTIONS set),
//   - a key inside this repository or any other git work tree, where it could be committed,
//   - a key file other users can read (Linux, macOS),
//   - a key that is not encrypted, or not Ed25519, or a key file that holds anything else,
//   - a folder that a throwaway test key signed (SHA256SUMS.test-key.pub is in it),
//   - a folder with archives of more than one version,
//   - with `expect`, a key whose public half is not the one expected,
//   - while the release keys are not pinned (the placeholder in
//     packages/service/src/version/release-keys.ts), before the passphrase is asked, and a key that
//     is not one of the pinned keys: the release's install scripts would trust nothing, or refuse it.
// Beside the signatures it writes the release's install scripts, install-<v>.sh and .ps1, pinning
// the release keys (scripts/install/render.ts, M1.14).
// The private key is never printed, logged or copied; only its public half and fingerprint are.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { RELEASE_PUBLIC_KEYS } from "../../packages/service/src/version/release-keys.ts";
import { ARCHIVE_NAME } from "../build/platforms.ts";
import {
  checkReleaseKeys,
  INSTALLER_KINDS,
  installerName,
  ReleaseKeyError,
  renderReleaseInstallers,
  type InstallerKind,
} from "../install/render.ts";
import {
  distArchives,
  fingerprint,
  opensshPublicKey,
  parseOpensshPublicKey,
  signSums,
  TEST_KEY_FILE,
  writeSums,
  type Signed,
} from "../build/signing.ts";

/** A refusal: the release script prints its message and exits 2, having changed nothing. */
export class Refusal extends Error {
  override readonly name = "Refusal";
}

export const KEY_FILE = `${PRODUCT_ID}-release-ed25519.pem`;
export const PUBLIC_KEY_FILE = `${PRODUCT_ID}-release-ed25519.pub`;
export const KEY_COMMENT = `${PRODUCT_ID}-release`;
export const MIN_PASSPHRASE = 12;

/** Refuses any CI environment: the release key is used on the owner's machine only. */
export function refuseInCi(env: Readonly<Record<string, string | undefined>>): void {
  if ((env["CI"] ?? "") !== "" || env["GITHUB_ACTIONS"] === "true") {
    throw new Refusal(
      "The release key is used by hand on the owner's machine, never in CI. CI signs with a throwaway test key: pnpm build --sign test.",
    );
  }
}

const inside = (child: string, parent: string, platform: NodeJS.Platform): boolean => {
  const fold = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Refuses a path for the key (or the folder keygen writes it to) inside the repository or inside
 * any git work tree: a key there is one `git add` away from being published.
 */
export function refuseRepositoryPath(
  path: string,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const target = real(path);
  if (inside(target, real(repoRoot), platform)) {
    throw new Refusal(
      "The release key may not be inside the repository. Keep it outside any checkout.",
    );
  }
  for (let dir = target; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      throw new Refusal(
        "The release key may not be inside a git work tree. Keep it outside any checkout.",
      );
    }
    if (dirname(dir) === dir) break;
  }
}

/** Refuses a key file that other users can read (Linux, macOS). Windows relies on the profile's ACL. */
export function refuseOpenKeyFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") return;
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Refusal("Other users can read the release key file. Make it yours alone: chmod 600.");
  }
}

/**
 * The whole text of a key file as `pnpm release keygen` writes it: one encrypted PKCS#8 block and
 * nothing else, apart from line ends. node:crypto takes the first key block it finds in a text, so
 * a file that also held a plain key, before or after, could sign with that one.
 */
const ENCRYPTED_PKCS8 =
  /^-----BEGIN ENCRYPTED PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END ENCRYPTED PRIVATE KEY-----\n?$/;

/** The release key from its encrypted PKCS#8 text and its passphrase. */
export function readReleaseKey(pem: string, passphrase: string): KeyObject {
  const text = pem.replaceAll("\r\n", "\n");
  let opensWithout = false;
  try {
    createPrivateKey({ key: text, format: "pem" });
    opensWithout = true;
  } catch {
    // Expected: an encrypted key does not open without its passphrase.
  }
  if (!ENCRYPTED_PKCS8.test(text) || opensWithout) {
    throw new Refusal(
      "The release key must be an encrypted PKCS#8 Ed25519 key, as pnpm release keygen writes it, and nothing else in its file.",
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem", passphrase });
  } catch {
    throw new Refusal("The passphrase does not open the release key.");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Refusal("The release key is not an Ed25519 key.");
  return key;
}

export interface CreatedKey {
  readonly privateKeyFile: string;
  readonly publicKeyFile: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/**
 * `pnpm release keygen`: a new Ed25519 release key in `folder`, encrypted with `passphrase`
 * (AES-256-CBC, PKCS#8's PBES2), and its public half in OpenSSH's format beside it. Refuses a
 * folder inside a checkout, and never replaces a key file.
 */
export function createReleaseKey(
  folder: string,
  passphrase: string,
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CreatedKey {
  refuseInCi(env);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Refusal("Create the key's folder first, outside any checkout.");
  }
  refuseRepositoryPath(folder, repoRoot);
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Refusal(`Use a passphrase of at least ${String(MIN_PASSPHRASE)} characters.`);
  }
  const privateKeyFile = join(folder, KEY_FILE);
  const publicKeyFile = join(folder, PUBLIC_KEY_FILE);
  if (existsSync(privateKeyFile) || existsSync(publicKeyFile)) {
    throw new Refusal("A release key is already in that folder. Nothing was replaced.");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const pub = createPublicKey(publicKey);
  writeFileSync(privateKeyFile, privateKey, { mode: 0o600, flag: "wx" });
  const line = opensshPublicKey(pub, KEY_COMMENT);
  writeFileSync(publicKeyFile, `${line}\n`, { mode: 0o644, flag: "wx" });
  return { privateKeyFile, publicKeyFile, publicKey: line, fingerprint: fingerprint(pub) };
}

export interface ReleaseSignOptions {
  readonly keyFile: string;
  readonly dist: string;
  readonly repoRoot: string;
  /** Asked only after every check that needs no key has passed. */
  readonly passphrase: () => Promise<string>;
  /** The expected public key (an OpenSSH line, for example the .pub file's text). */
  readonly expect?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The keys the release's install scripts pin. Always RELEASE_PUBLIC_KEYS
   * (packages/service/src/version/release-keys.ts); tests pass their throwaway key's.
   */
  readonly pinned?: readonly string[];
}

export interface ReleaseSigned extends Signed {
  readonly archives: readonly string[];
  /** The install scripts written beside them, pinning the release keys (M1.14). */
  readonly installers: readonly string[];
}

/** `pnpm release sign`: SHA256SUMS over the archives in `dist`, signed in both formats. */
export async function releaseSign(options: ReleaseSignOptions): Promise<ReleaseSigned> {
  refuseInCi(options.env ?? process.env);
  if (!existsSync(options.keyFile)) throw new Refusal("There is no key file at that path.");
  refuseRepositoryPath(options.keyFile, options.repoRoot);
  refuseOpenKeyFile(options.keyFile);
  if (existsSync(join(options.dist, TEST_KEY_FILE))) {
    throw new Refusal(
      `A throwaway test key signed this folder (${TEST_KEY_FILE}). Copy the release archives into a new folder and sign that.`,
    );
  }
  const archives = distArchives(options.dist);
  if (archives.length === 0) throw new Refusal("The folder holds no release archive to sign.");
  const versions = new Set(archives.map((name) => ARCHIVE_NAME.exec(name)?.[1]));
  if (versions.size !== 1) {
    throw new Refusal(
      `The folder holds archives of more than one version (${[...versions].sort().join(", ")}). Put one release's archives in a folder of their own.`,
    );
  }
  // A release ships install scripts that pin the release keys (M1.14). While those are not
  // pinned, there is nothing to sign for: refused before the passphrase is asked.
  const pinned = options.pinned ?? RELEASE_PUBLIC_KEYS;
  try {
    checkReleaseKeys(pinned);
  } catch (error) {
    if (error instanceof ReleaseKeyError) throw new Refusal(error.message);
    throw error;
  }
  const expected =
    options.expect === undefined
      ? undefined
      : opensshPublicKey(parseOpensshPublicKey(options.expect));
  const key = readReleaseKey(readFileSync(options.keyFile, "utf8"), await options.passphrase());
  const publicKey = opensshPublicKey(createPublicKey(key));
  if (expected !== undefined && expected !== publicKey) {
    throw new Refusal("The key is not the expected release key. Nothing was signed.");
  }
  const version = [...versions][0] ?? "";
  let installers: Record<InstallerKind, string>;
  try {
    installers = renderReleaseInstallers(version, publicKey, pinned);
  } catch (error) {
    if (error instanceof ReleaseKeyError) throw new Refusal(`${error.message} Nothing was signed.`);
    throw error;
  }
  writeSums(options.dist, archives);
  const work = join(options.dist, ".signing-check");
  let signed: Signed;
  try {
    signed = signSums(options.dist, key, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const written = INSTALLER_KINDS.map((kind) => {
    const name = installerName(kind, version, "release");
    writeFileSync(join(options.dist, name), installers[kind]);
    return name;
  });
  return { archives, installers: written, ...signed };
}
