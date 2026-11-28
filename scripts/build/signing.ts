// SHA256SUMS and its two signatures: `SHA256SUMS.sig`, the raw 64-byte Ed25519
// signature over the file's exact bytes (for `openssl pkeyutl -verify -rawin` and node:crypto), and
// `SHA256SUMS.sshsig`, the same key's signature in OpenSSH's format (PROTOCOL.sshsig, namespace
// `ttasks-release`, for `ssh-keygen -Y verify`). Both come from one Ed25519 key in node:crypto, so
// one code path signs a release (scripts/release/, the maintainer's key) and a CI or test build (a throwaway
// key made in memory for the run and never written anywhere).
//
// Ed25519 is deterministic: the same key and file always give the same bytes, and the SSHSIG this
// module writes is byte for byte what `ssh-keygen -Y sign` writes for the same key (the tests
// check it), apart from Windows' text-mode line ends on ssh-keygen's stdout.
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import {
  parseOpensshPublicKey,
  RAW_SIGNATURE,
  SSH_SIGNATURE,
  SshReader,
  SUMS_FILE,
  verifyRawSignature,
} from "../../packages/service/src/version/release.ts";
import { ARCHIVE_NAME } from "./platforms.ts";

// The file names, the key format and the check of a raw signature are the product's: the updater
// of an installed version reads what this module writes (packages/service/src/version/release.ts).
export { parseOpensshPublicKey, RAW_SIGNATURE, SSH_SIGNATURE, SUMS_FILE, verifyRawSignature };

/** The SSHSIG namespace and the allowed_signers identity of release signatures. */
export const NAMESPACE = `${PRODUCT_ID}-release`;
/**
 * The public half of a throwaway test key, beside a test-signed SHA256SUMS. Its presence marks
 * the folder as test-signed: the release script refuses to sign such a folder.
 */
export const TEST_KEY_FILE = `${SUMS_FILE}.test-key.pub`;
export const TEST_KEY_COMMENT = `${PRODUCT_ID}-throwaway-test-key`;

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** The archives in `dist` that SHA256SUMS lists, sorted by name. Only `version`'s when given. */
export function distArchives(dist: string, version?: string): string[] {
  return readdirSync(dist)
    .filter((name) => {
      const match = ARCHIVE_NAME.exec(name);
      return match !== null && (version === undefined || match[1] === version);
    })
    .sort();
}

/** SHA256SUMS's text: one `<hex>  <name>` line per archive, sorted, as sha256sum writes it. */
export function sumsText(entries: readonly { name: string; data: Buffer }[]): string {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${sha256(e.data)}  ${e.name}\n`)
    .join("");
}

/** Writes `<dist>/SHA256SUMS` over the given archives in `dist` and returns its bytes. */
export function writeSums(dist: string, archives: readonly string[]): Buffer {
  if (archives.length === 0) throw new Error("no archives to list in SHA256SUMS");
  const text = Buffer.from(
    sumsText(archives.map((name) => ({ name, data: readFileSync(join(dist, name)) }))),
  );
  writeFileSync(join(dist, SUMS_FILE), text);
  return text;
}

// ---------------------------------------------------------------------------------------------
// SSH wire encoding (RFC 4251 5) and OpenSSH's key and signature formats

const sshString = (data: Buffer | string): Buffer => {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** The 32 raw bytes of an Ed25519 public key. */
export function rawPublicKey(key: KeyObject): Buffer {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("the Ed25519 key has no public part");
  return Buffer.from(jwk.x, "base64url");
}

/** The key as OpenSSH writes it in a .pub file or allowed_signers: `ssh-ed25519 <base64>`. */
export function opensshPublicKey(key: KeyObject, comment?: string): string {
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(rawPublicKey(key))]);
  return `ssh-ed25519 ${blob.toString("base64")}${comment === undefined ? "" : ` ${comment}`}`;
}

/** OpenSSH's fingerprint of a key: `SHA256:<unpadded base64>`. */
export function fingerprint(key: KeyObject): string {
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(rawPublicKey(key))]);
  const digest = createHash("sha256").update(blob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

const MAGIC = Buffer.from("SSHSIG");
const SIG_VERSION = 1;
const HASH = "sha512";
const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const END = "-----END SSH SIGNATURE-----";
/** ssh-keygen wraps the armored base64 at 70 columns. */
const ARMOR_WIDTH = 70;

/** The bytes an SSHSIG signs: the preamble, namespace, reserved, hash name and H(message). */
function signedBlob(message: Buffer, namespace: string): Buffer {
  return Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshString(createHash(HASH).update(message).digest()),
  ]);
}

/** The raw Ed25519 signature over `message`: 64 bytes (SHA256SUMS.sig). */
export function rawSignature(message: Buffer, key: KeyObject): Buffer {
  return sign(null, message, key);
}

/** The armored SSHSIG over `message`, as `ssh-keygen -Y sign -n <namespace>` writes it. */
export function sshSignature(message: Buffer, key: KeyObject, namespace = NAMESPACE): string {
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(rawPublicKey(key))]);
  const signature = sign(null, signedBlob(message, namespace), key);
  const sigBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(signature)]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(SIG_VERSION);
  const blob = Buffer.concat([
    MAGIC,
    version,
    sshString(publicBlob),
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshString(sigBlob),
  ]);
  const base64 = blob.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += ARMOR_WIDTH) lines.push(base64.slice(i, i + ARMOR_WIDTH));
  return `${BEGIN}\n${lines.join("\n")}\n${END}\n`;
}

/**
 * Verifies an armored SSHSIG over `message` against `key`, in node:crypto: the format, the
 * namespace, the public key it names and the Ed25519 signature. ssh-keygen is the installers'
 * verifier; this one lets the build check what it wrote on a machine without it.
 */
export function verifySshSignature(
  message: Buffer,
  armored: string,
  key: KeyObject,
  namespace = NAMESPACE,
): boolean {
  try {
    const text = armored.replaceAll("\r\n", "\n").trim();
    if (!text.startsWith(BEGIN) || !text.endsWith(END)) return false;
    const blob = Buffer.from(text.slice(BEGIN.length, -END.length).replace(/\s+/g, ""), "base64");
    const reader = new SshReader(blob);
    if (!reader.bytes(6).equals(MAGIC) || reader.uint32() !== SIG_VERSION) return false;
    const publicBlob = reader.string();
    const signedNamespace = reader.string().toString("utf8");
    reader.string(); // reserved
    const hash = reader.string().toString("utf8");
    const sigBlob = reader.string();
    if (!reader.done() || signedNamespace !== namespace || hash !== HASH) return false;
    const expected = Buffer.concat([sshString("ssh-ed25519"), sshString(rawPublicKey(key))]);
    if (!publicBlob.equals(expected)) return false;
    const sig = new SshReader(sigBlob);
    if (sig.string().toString("utf8") !== "ssh-ed25519") return false;
    const signature = sig.string();
    if (!sig.done() || signature.length !== 64) return false;
    return verify(null, signedBlob(message, namespace), key, signature);
  } catch {
    return false;
  }
}

/** The ssh-keygen this OS ships: System32\OpenSSH on Windows, else the first on PATH. */
export function systemSshKeygen(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return join(env["SystemRoot"] ?? "C:\\Windows", "System32", "OpenSSH", "ssh-keygen.exe");
  }
  return "ssh-keygen";
}

/**
 * Verifies SHA256SUMS.sshsig with `ssh-keygen -Y verify`, as the install scripts do: an
 * allowed_signers file that names only `key`, identity and namespace `ttasks-release`. `work` is
 * an empty folder for that file. Returns undefined when there is no ssh-keygen to ask.
 */
export function verifyWithSshKeygen(
  message: Buffer,
  armored: string,
  key: KeyObject,
  work: string,
  keygen = systemSshKeygen(),
): boolean | undefined {
  if (process.platform === "win32" && !existsSync(keygen)) return undefined;
  mkdirSync(work, { recursive: true });
  const allowed = join(work, "allowed_signers");
  const signature = join(work, SSH_SIGNATURE);
  writeFileSync(allowed, `${NAMESPACE} namespaces="${NAMESPACE}" ${opensshPublicKey(key)}\n`);
  writeFileSync(signature, armored);
  try {
    const result = spawnSync(
      keygen,
      ["-Y", "verify", "-f", allowed, "-I", NAMESPACE, "-n", NAMESPACE, "-s", signature],
      { input: message, windowsHide: true, encoding: "utf8" },
    );
    if (result.error !== undefined) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw result.error;
    }
    return result.status === 0;
  } finally {
    rmSync(allowed, { force: true });
    rmSync(signature, { force: true });
  }
}

export interface Signed {
  readonly sums: Buffer;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/**
 * Signs `<dist>/SHA256SUMS` in both formats with `key` and checks both signatures against the key's
 * public half before it returns: the raw one and the SSHSIG in node:crypto, and the SSHSIG with
 * ssh-keygen too when this machine has one (`work` holds its allowed_signers for the moment).
 */
export function signSums(dist: string, key: KeyObject, work: string): Signed {
  const sums = readFileSync(join(dist, SUMS_FILE));
  const publicKey = createPublicKey(key);
  const raw = rawSignature(sums, key);
  const armored = sshSignature(sums, key);
  if (!verifyRawSignature(sums, raw, publicKey))
    throw new Error("the raw signature does not verify");
  if (!verifySshSignature(sums, armored, publicKey)) throw new Error("the SSHSIG does not verify");
  if (verifyWithSshKeygen(sums, armored, publicKey, work) === false) {
    throw new Error("ssh-keygen -Y verify refuses the SSHSIG");
  }
  writeFileSync(join(dist, RAW_SIGNATURE), raw);
  writeFileSync(join(dist, SSH_SIGNATURE), armored);
  return { sums, publicKey: opensshPublicKey(publicKey), fingerprint: fingerprint(publicKey) };
}

/**
 * Test-signs `<dist>/SHA256SUMS` (CI and tests): a throwaway Ed25519 key made in
 * memory for this call, never written to disk, gone when the call returns. Its public half goes
 * to SHA256SUMS.test-key.pub so the run can verify what it signed, and so nobody mistakes the
 * folder for a release.
 */
export function testSignSums(dist: string, work: string): Signed {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signed = signSums(dist, privateKey, work);
  writeFileSync(join(dist, TEST_KEY_FILE), `${signed.publicKey} ${TEST_KEY_COMMENT}\n`);
  return signed;
}
