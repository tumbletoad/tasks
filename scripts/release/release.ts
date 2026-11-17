// Signing a release: SHA256SUMS over the release archives, signed with the Ed25519 release key in
// both formats (SHA256SUMS.sig raw, SHA256SUMS.sshsig OpenSSH), and the release's install scripts
// pinning the release keys beside them. Three ways in, one signing path (signFolder):
//   - releaseSign: by hand, the key in a file and its passphrase asked at a terminal. Refuses any
//     CI.
//   - ciReleaseSign: the release workflow's signing job, the key and its passphrase from that job's
//     secrets. Refuses anything but the run that the push of the archives' version tag started, in
//     a repository that is not a fork, with the release environment's secrets present.
//   - rehearsalSign: a key made in memory for the call, so the whole release path can run on a pull
//     request. Its output says it is a rehearsal (version, file names, a marker file) and no product
//     trusts its key.
// The key is an Ed25519 private key in PKCS#8, encrypted with a passphrase (`pnpm release keygen`
// writes one). The private key and the passphrase are never printed, logged or written; only the
// public half and its fingerprint are.
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
import { trustedKeys } from "../../packages/service/src/version/release.ts";
import { readTarGz, readZip } from "../build/archive.ts";
import { ARCHIVE_NAME } from "../build/platforms.ts";
import {
  checkReleaseKeys,
  checkKeys,
  INSTALLER_KINDS,
  installerName,
  ReleaseKeyError,
  renderInstaller,
  renderReleaseInstallers,
  type InstallerKind,
} from "../install/render.ts";
import {
  distArchives,
  fingerprint,
  opensshPublicKey,
  parseOpensshPublicKey,
  signSums,
  TEST_KEY_COMMENT,
  TEST_KEY_FILE,
  writeSums,
  type Signed,
} from "../build/signing.ts";
import { isRehearsalVersion, releaseTag, releaseVersionProblem } from "./version.ts";

/** A refusal: the release script prints its message and exits 2, having signed nothing. */
export class Refusal extends Error {
  override readonly name = "Refusal";
}

export const KEY_FILE = `${PRODUCT_ID}-release-ed25519.pem`;
export const PUBLIC_KEY_FILE = `${PRODUCT_ID}-release-ed25519.pub`;
export const KEY_COMMENT = `${PRODUCT_ID}-release`;
export const MIN_PASSPHRASE = 12;

/** The names of the release environment's secrets, as the signing job passes them. */
export const KEY_SECRET = "RELEASE_KEY";
export const PASSPHRASE_SECRET = "RELEASE_KEY_PASSPHRASE";

type Env = Readonly<Record<string, string | undefined>>;

/** Refuses any CI environment: the terminal path is for signing by hand. */
export function refuseInCi(env: Env): void {
  if ((env["CI"] ?? "") !== "" || env["GITHUB_ACTIONS"] === "true") {
    throw new Refusal(
      "pnpm release sign is for signing by hand in a terminal, outside CI. In CI a release is signed by the release workflow (pnpm release sign-ci), a rehearsal by pnpm release rehearse.",
    );
  }
}

/**
 * Refuses every job but the release workflow's signing job: GitHub Actions, the push of a version
 * tag (a pull request, a branch, a dispatch or a schedule never signs a release), in a repository
 * that is not a fork, and with the release environment's secrets present. GitHub does not tell a
 * step which environment its job runs in; the secrets are what that environment gives, and only to
 * jobs that reference it from a ref its policy allows. Checked before any secret is read.
 */
export function refuseOutsideReleaseJob(
  env: Env,
  secrets: { key: string; passphrase: string },
): void {
  if (env["GITHUB_ACTIONS"] !== "true") {
    throw new Refusal(
      "pnpm release sign-ci runs only in the release workflow. On your own machine: pnpm release sign.",
    );
  }
  if (env["GITHUB_EVENT_NAME"] !== "push" || !(env["GITHUB_REF"] ?? "").startsWith("refs/tags/v")) {
    throw new Refusal(
      `A release is signed only in the run a version tag starts, not on ${env["GITHUB_EVENT_NAME"] ?? "this event"} of ${env["GITHUB_REF"] ?? "this ref"}.`,
    );
  }
  let fork: unknown;
  try {
    const event = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf8")) as {
      repository?: { fork?: unknown };
    };
    fork = event.repository?.fork;
  } catch {
    throw new Refusal("The run's event cannot be read, so it cannot be told from a fork's.");
  }
  if (fork !== false) throw new Refusal("A fork never signs a release.");
  if (secrets.key === "" || secrets.passphrase === "") {
    throw new Refusal(
      `The release key's secrets (${KEY_SECRET}, ${PASSPHRASE_SECRET}) are not here: the signing job runs only in the release environment.`,
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
  env: Env = process.env,
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

export interface ReleaseSigned extends Signed {
  readonly version: string;
  readonly archives: readonly string[];
  /** The install scripts written beside them. */
  readonly installers: readonly string[];
}

const KEY_IN_TEXT = /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=])/g;

/** Every OpenSSH Ed25519 key line written in a text. */
export const keyLinesIn = (text: string): string[] =>
  [...text.matchAll(KEY_IN_TEXT)].map((match) => match[0]);

/** Every OpenSSH Ed25519 key line written in any file of a release archive. */
export function keysInArchive(path: string): Set<string> {
  const data = readFileSync(path);
  const entries = path.endsWith(".zip") ? readZip(data) : readTarGz(data);
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    for (const line of keyLinesIn(entry.data.toString("latin1"))) found.add(line);
  }
  return found;
}

/**
 * The archives and their single version in `dist`, for signing. Refuses a folder a test key or a
 * rehearsal signed, one without archives, and one with archives of more than one version.
 */
function releaseArchives(dist: string): { archives: string[]; version: string } {
  if (existsSync(join(dist, TEST_KEY_FILE))) {
    throw new Refusal(
      `A throwaway test key signed this folder (${TEST_KEY_FILE}). Copy the release archives into a new folder and sign that.`,
    );
  }
  const archives = distArchives(dist);
  if (archives.length === 0) throw new Refusal("The folder holds no release archive to sign.");
  const versions = new Set(archives.map((name) => ARCHIVE_NAME.exec(name)?.[1] ?? ""));
  if (versions.size !== 1) {
    throw new Refusal(
      `The folder holds archives of more than one version (${[...versions].sort().join(", ")}). Put one release's archives in a folder of their own.`,
    );
  }
  return { archives, version: [...versions][0] ?? "" };
}

type Kind = "release" | "rehearsal";

/** Refuses a version that the kind of signing may not carry. */
function checkVersion(version: string, kind: Kind): void {
  if (kind === "rehearsal") {
    if (!isRehearsalVersion(version)) {
      throw new Refusal(
        `A rehearsal signs only rehearsal versions (<x.y.z>-rehearsal.<n>…), so its files cannot pass for a release: not ${version}.`,
      );
    }
    return;
  }
  const problem = releaseVersionProblem(version);
  if (problem !== undefined) throw new Refusal(problem);
}

/**
 * Refuses archives whose updater would trust other keys than the committed release keys: a test
 * build that trusts a throwaway key, or a build made before the key was pinned. The product
 * carries its trusted keys as literal lines in lib/, so every key line in any file counts.
 */
function checkEmbeddedKeys(
  dist: string,
  archives: readonly string[],
  committed: readonly string[],
): void {
  const want = [...trustedKeys(committed)].map((key) => opensshPublicKey(key)).sort();
  for (const archive of archives) {
    const found = [...keysInArchive(join(dist, archive))].sort();
    if (JSON.stringify(found) !== JSON.stringify(want)) {
      throw new Refusal(
        `${archive} trusts ${found.length === 0 ? "no release key" : `other keys (${found.join(", ")})`} where the committed release keys are ${want.length === 0 ? "none" : want.join(", ")}. Build it again from the commit, unchanged.`,
      );
    }
  }
}

interface FolderOptions {
  readonly kind: Kind;
  /** The keys the install scripts pin. The signing key must be one of them. */
  readonly pinned: readonly string[];
  /** The keys the archives' updater must trust: the release keys of the commit they came from. */
  readonly committed: readonly string[];
}

/** The checks on a folder that need no key. Run before the key or its passphrase is read. */
function prepareFolder(
  dist: string,
  options: FolderOptions,
): { archives: string[]; version: string } {
  const found = releaseArchives(dist);
  checkVersion(found.version, options.kind);
  if (options.kind === "release") {
    try {
      checkReleaseKeys(options.pinned);
    } catch (error) {
      if (error instanceof ReleaseKeyError) throw new Refusal(error.message);
      throw error;
    }
  }
  checkEmbeddedKeys(dist, found.archives, options.committed);
  return found;
}

/** Signs a prepared folder with `key` and writes its install scripts. */
function signFolder(
  dist: string,
  prepared: { archives: string[]; version: string },
  key: KeyObject,
  options: FolderOptions,
): ReleaseSigned {
  const { archives, version } = prepared;
  const publicKey = opensshPublicKey(createPublicKey(key));
  let installers: Record<InstallerKind, string>;
  try {
    installers =
      options.kind === "release"
        ? renderReleaseInstallers(version, publicKey, options.pinned)
        : {
            sh: renderInstaller("sh", { version, keys: checkKeys([publicKey]), build: "test" }),
            ps1: renderInstaller("ps1", { version, keys: checkKeys([publicKey]), build: "test" }),
          };
  } catch (error) {
    if (error instanceof ReleaseKeyError) throw new Refusal(`${error.message} Nothing was signed.`);
    throw error;
  }
  writeSums(dist, archives);
  const work = join(dist, ".signing-check");
  let signed: Signed;
  try {
    signed = signSums(dist, key, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const written = INSTALLER_KINDS.map((kind) => {
    const name = installerName(kind, version, options.kind === "release" ? "release" : "test");
    writeFileSync(join(dist, name), installers[kind]);
    return name;
  });
  if (options.kind === "rehearsal") {
    writeFileSync(join(dist, TEST_KEY_FILE), `${signed.publicKey} ${TEST_KEY_COMMENT}\n`);
  }
  return { version, archives, installers: written, ...signed };
}

export interface ReleaseSignOptions {
  readonly keyFile: string;
  readonly dist: string;
  readonly repoRoot: string;
  /** Asked only after every check that needs no key has passed. */
  readonly passphrase: () => Promise<string>;
  /** The expected public key (an OpenSSH line, for example the .pub file's text). */
  readonly expect?: string;
  readonly env?: Env;
  /** The release keys. Always RELEASE_PUBLIC_KEYS; tests pass their throwaway key's. */
  readonly pinned?: readonly string[];
}

/** `pnpm release sign`, by hand: the key from a file, its passphrase asked at a terminal. */
export async function releaseSign(options: ReleaseSignOptions): Promise<ReleaseSigned> {
  refuseInCi(options.env ?? process.env);
  if (!existsSync(options.keyFile)) throw new Refusal("There is no key file at that path.");
  refuseRepositoryPath(options.keyFile, options.repoRoot);
  refuseOpenKeyFile(options.keyFile);
  const pinned = options.pinned ?? RELEASE_PUBLIC_KEYS;
  const folder = { kind: "release" as const, pinned, committed: pinned };
  const prepared = prepareFolder(options.dist, folder);
  const expected =
    options.expect === undefined
      ? undefined
      : opensshPublicKey(parseOpensshPublicKey(options.expect));
  const key = readReleaseKey(readFileSync(options.keyFile, "utf8"), await options.passphrase());
  if (expected !== undefined && expected !== opensshPublicKey(createPublicKey(key))) {
    throw new Refusal("The key is not the expected release key. Nothing was signed.");
  }
  return signFolder(options.dist, prepared, key, folder);
}

export interface CiSignOptions {
  readonly dist: string;
  /** The secrets' values, already taken out of the process's environment. */
  readonly secrets: { readonly key: string; readonly passphrase: string };
  readonly env: Env;
  /** The release keys. Always RELEASE_PUBLIC_KEYS; tests pass their throwaway key's. */
  readonly pinned?: readonly string[];
}

/** `pnpm release sign-ci`: the release workflow's signing job. */
export function ciReleaseSign(options: CiSignOptions): ReleaseSigned {
  refuseOutsideReleaseJob(options.env, options.secrets);
  const pinned = options.pinned ?? RELEASE_PUBLIC_KEYS;
  const folder = { kind: "release" as const, pinned, committed: pinned };
  const prepared = prepareFolder(options.dist, folder);
  if (options.env["GITHUB_REF"] !== `refs/tags/${releaseTag(prepared.version)}`) {
    throw new Refusal(
      `The archives are ${prepared.version}, but this run is for ${options.env["GITHUB_REF"] ?? "no tag"}. Nothing was signed.`,
    );
  }
  const key = readReleaseKey(options.secrets.key, options.secrets.passphrase);
  return signFolder(options.dist, prepared, key, folder);
}

/**
 * `pnpm release rehearse`: the release's signing with a key made in memory for this call and gone
 * when it returns. The install scripts pin that key and are marked as test builds, the folder gets
 * SHA256SUMS.test-key.pub, and the version must be a rehearsal version. The archives must still
 * trust exactly the committed release keys: a rehearsal signs what a release would.
 */
export function rehearsalSign(
  dist: string,
  committed: readonly string[] = RELEASE_PUBLIC_KEYS,
): ReleaseSigned {
  const folder = { kind: "rehearsal" as const, pinned: [], committed };
  const prepared = prepareFolder(dist, folder);
  const { privateKey } = generateKeyPairSync("ed25519");
  return signFolder(dist, prepared, privateKey, {
    ...folder,
    pinned: [opensshPublicKey(createPublicKey(privateKey))],
  });
}

export interface Secrets {
  readonly key: string;
  readonly passphrase: string;
}

/**
 * Takes the release key's secrets out of `env` (the process's own environment), so no process this
 * one starts (ssh-keygen, git, gh) inherits them. Called first, before any command is chosen.
 */
export function takeSecrets(env: Record<string, string | undefined>): Secrets {
  const secrets = { key: env[KEY_SECRET] ?? "", passphrase: env[PASSPHRASE_SECRET] ?? "" };
  Reflect.deleteProperty(env, KEY_SECRET);
  Reflect.deleteProperty(env, PASSPHRASE_SECRET);
  return secrets;
}

/**
 * `text` with every secret value replaced by `***`: the passphrase, and each line of the key's
 * text. For any message the release script prints while it holds them.
 */
export function redact(text: string, secrets: Secrets): string {
  const values = [
    secrets.passphrase,
    ...secrets.key.split(/\r?\n/).filter((line) => !line.startsWith("-----")),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.replaceAll(value, "***");
  return out;
}
