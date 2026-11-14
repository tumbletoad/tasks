// A release's files as the updater reads them (A2 3.12.4, 3.12.5): the archive, named after its
// version and platform, and beside it `SHA256SUMS` with its raw Ed25519 signature
// `SHA256SUMS.sig`. The build writes them (scripts/build/: platforms.ts, signing.ts and archive.ts
// take their names, the key format and the check of a signature from here), and the updater of an
// installed version verifies them with the keys its own build carries before anything of the
// archive is unpacked or run (verifyRelease). One module for both, so the writer and the reader
// agree.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PRODUCT_ID } from "@tasks/brand";
import { ED25519_KEY_LINE, RELEASE_KEY_PLACEHOLDER } from "./release-keys.ts";

// ---------------------------------------------------------------------------------------------
// Platforms and archive names (A2 3.12.1, 3.12.4)

export const PLATFORMS = ["linux-x64", "linux-arm64", "win-x64", "darwin-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** The operating system a platform runs on, as Node names it. */
export function osOf(platform: Platform): "linux" | "win32" | "darwin" {
  return platform === "win-x64" ? "win32" : platform === "darwin-arm64" ? "darwin" : "linux";
}

/** The platform of this machine, if Tasks builds for it. */
export function hostPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Platform | undefined {
  const name = `${platform === "win32" ? "win" : platform}-${arch}`;
  return isPlatform(name) ? name : undefined;
}

/** `tasks-<version>-<platform>.tar.gz`, or `.zip` for Windows (A2 3.12.4). */
export function archiveName(version: string, platform: Platform): string {
  return `${PRODUCT_ID}-${version}-${platform}.${platform === "win-x64" ? "zip" : "tar.gz"}`;
}

/** The archive names a build may write: the product, a version, a known platform. */
export const ARCHIVE_NAME = new RegExp(
  `^${PRODUCT_ID}-([0-9A-Za-z.+-]+)-(${PLATFORMS.join("|")})\\.(tar\\.gz|zip)$`,
);

// ---------------------------------------------------------------------------------------------
// SHA256SUMS, its signatures and the key format

export const SUMS_FILE = "SHA256SUMS";
export const RAW_SIGNATURE = `${SUMS_FILE}.sig`;
export const SSH_SIGNATURE = `${SUMS_FILE}.sshsig`;

/** Reads RFC 4251 wire data: uint32 lengths and the strings they announce. */
export class SshReader {
  #at = 0;
  readonly data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
  }
  bytes(n: number): Buffer {
    if (this.#at + n > this.data.length) throw new Error("truncated SSH data");
    const out = this.data.subarray(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }
  uint32(): number {
    return this.bytes(4).readUInt32BE(0);
  }
  string(): Buffer {
    return this.bytes(this.uint32());
  }
  done(): boolean {
    return this.#at === this.data.length;
  }
}

/** Parses `ssh-ed25519 <base64> [comment]` into a public key. Throws when it is none. */
export function parseOpensshPublicKey(line: string): KeyObject {
  const [type, base64] = line.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || base64 === undefined) throw new Error("not an ssh-ed25519 key");
  const blob = Buffer.from(base64, "base64");
  const reader = new SshReader(blob);
  if (reader.string().toString("utf8") !== "ssh-ed25519") throw new Error("not an Ed25519 key");
  const raw = reader.string();
  if (raw.length !== 32 || !reader.done()) throw new Error("malformed ssh-ed25519 key");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

/** Whether `signature` is `key`'s raw Ed25519 signature (64 bytes) over `message`. */
export function verifyRawSignature(message: Buffer, signature: Buffer, key: KeyObject): boolean {
  return signature.length === 64 && verify(null, message, key, signature);
}

const SUMS_LINE = /^([0-9a-f]{64}) {2}(\S+)$/;

/**
 * The digest SHA256SUMS lists for `name`. The file must be exactly sha256sum's lines (`<hex>  <name>`
 * with a line feed after each), and name the archive exactly once. Undefined otherwise.
 */
export function sumsDigest(sums: Buffer, name: string): string | undefined {
  const text = sums.toString("utf8");
  if (text === "" || !text.endsWith("\n") || Buffer.from(text, "utf8").compare(sums) !== 0) {
    return undefined;
  }
  const found: string[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    const match = SUMS_LINE.exec(line);
    if (match === null) return undefined;
    if (match[2] === name) found.push(match[1] ?? "");
  }
  return found.length === 1 ? found[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// The updater's check of a release (A2 3.12.4 "signatures before code", 3.12.5)

/** Why a release was refused. Nothing of its archive was unpacked or run. */
export type ReleaseRefusal =
  | "not_an_archive"
  | "other_platform"
  | "no_trusted_key"
  | "missing_file"
  | "too_large"
  | "bad_signature"
  | "not_listed"
  | "hash_mismatch";

export class ReleaseError extends Error {
  override readonly name = "ReleaseError";
  readonly reason: ReleaseRefusal;
  constructor(reason: ReleaseRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** A verified release: its archive's bytes, read once, and what its name says. */
export interface VerifiedRelease {
  readonly version: string;
  readonly platform: Platform;
  readonly archive: string;
  /** The archive's bytes: the ones that were hashed, and the ones that are unpacked. */
  readonly bytes: Buffer;
}

/** A release archive is at most this large: a version folder is about 100 MB unpacked. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;

/** Reads a whole file through one descriptor, refusing one over `limit` bytes. */
function readBounded(path: string, limit: number, what: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    throw new ReleaseError("missing_file", `${what} is missing or cannot be read.`);
  }
  try {
    const size = fstatSync(fd).size;
    if (size > limit) throw new ReleaseError("too_large", `${what} is too large to be a release.`);
    const data = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const read = readSync(fd, data, at, size - at, at);
      if (read === 0) break;
      at += read;
    }
    if (at !== size) throw new ReleaseError("missing_file", `${what} changed while it was read.`);
    return data;
  } finally {
    closeSync(fd);
  }
}

/**
 * The trusted keys of this build, parsed: the pinned release keys (release-keys.ts). A placeholder
 * or no key trusts nothing.
 */
export function trustedKeys(lines: readonly string[]): KeyObject[] {
  const keys: KeyObject[] = [];
  for (const line of lines) {
    const pair = line.trim().split(/\s+/).slice(0, 2).join(" ");
    if (line.includes(RELEASE_KEY_PLACEHOLDER) || !ED25519_KEY_LINE.test(pair)) continue;
    try {
      keys.push(parseOpensshPublicKey(pair));
    } catch {
      // Not a key: it trusts nothing.
    }
  }
  return keys;
}

/**
 * Verifies a release archive the way the install scripts do, in node:crypto, with `keys` (the
 * installed version's own): the raw signature of SHA256SUMS beside it by one of the keys, then the
 * archive's SHA-256 against its one line there. The archive is read once, so the bytes verified are
 * the bytes unpacked. Throws ReleaseError before anything is written.
 */
export function verifyRelease(
  archivePath: string,
  keys: readonly string[],
  platform: Platform,
): VerifiedRelease {
  const archive = basename(archivePath);
  const named = ARCHIVE_NAME.exec(archive);
  if (named === null) {
    throw new ReleaseError(
      "not_an_archive",
      `${archive} is not a ${PRODUCT_ID} release archive (${archiveName("<version>", platform)}).`,
    );
  }
  const version = named[1] ?? "";
  if (named[2] !== platform) {
    throw new ReleaseError(
      "other_platform",
      `${archive} is for ${String(named[2])}, not ${platform}.`,
    );
  }
  const trusted = trustedKeys(keys);
  if (trusted.length === 0) {
    throw new ReleaseError(
      "no_trusted_key",
      "This build trusts no release key yet, so it cannot verify an update. Install the new version with its install script instead.",
    );
  }
  const dir = dirname(archivePath);
  const sums = readBounded(join(dir, SUMS_FILE), MAX_SUMS_BYTES, SUMS_FILE);
  const signature = readBounded(join(dir, RAW_SIGNATURE), MAX_SUMS_BYTES, RAW_SIGNATURE);
  if (!trusted.some((key) => verifyRawSignature(sums, signature, key))) {
    throw new ReleaseError(
      "bad_signature",
      `The signature of ${SUMS_FILE} does not verify with this install's release keys. Nothing from the archive was unpacked or run.`,
    );
  }
  const want = sumsDigest(sums, archive);
  if (want === undefined) {
    throw new ReleaseError("not_listed", `${SUMS_FILE} does not list ${archive} exactly once.`);
  }
  const bytes = readBounded(archivePath, MAX_ARCHIVE_BYTES, archive);
  if (createHash("sha256").update(bytes).digest("hex") !== want) {
    throw new ReleaseError(
      "hash_mismatch",
      `${archive} does not match ${SUMS_FILE}. Nothing from it was unpacked or run.`,
    );
  }
  return { version, platform, archive, bytes };
}
