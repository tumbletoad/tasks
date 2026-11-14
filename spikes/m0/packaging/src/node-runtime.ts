// The official Node runtime for a version folder (A2 3.12.1): downloaded from nodejs.org, never
// taken from the machine that builds, and accepted only when
//   1. SHASUMS256.txt carries a valid OpenPGP signature from a Node releaser, checked with gpgv
//      against the nodejs/release-keys keyring at a pinned commit whose SHA-256 is pinned too,
//   2. the archive's SHA-256 equals its line in SHASUMS256.txt, and
//   3. that digest equals the one pinned in node-pin.json (which also matches pnpm-lock.yaml).
// The binary and Node's licence are then read out of the archive unchanged.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTarGz, readZip } from "./archive.ts";
import { nodePinFile } from "./paths.ts";
import { type Platform, sha256 } from "./version-folder.ts";

export interface NodePin {
  version: string;
  sqlite: string;
  base: string;
  signature: { keyring: string; keyringSha256: string };
  platforms: Record<Platform, { file: string; sha256: string; binary: string; license: string }>;
}

export function loadPin(file: string = nodePinFile): NodePin {
  return JSON.parse(readFileSync(file, "utf8")) as NodePin;
}

const SHASUM_LINE = /^([0-9a-f]{64}) {2}(\S+)$/;

/** Parses SHASUMS256.txt. Throws on a malformed line or a name listed twice. */
export function parseShasums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = SHASUM_LINE.exec(line);
    if (m === null) throw new Error(`malformed SHASUMS256.txt line: ${JSON.stringify(line)}`);
    const [, digest = "", name = ""] = m;
    if (sums.has(name)) throw new Error(`SHASUMS256.txt lists ${name} twice`);
    sums.set(name, digest);
  }
  return sums;
}

/** The checks 2 and 3 above, as a pure function. Returns one message per problem. */
export function checkNodeArchive(
  pin: NodePin,
  platform: Platform,
  shasums: string,
  archiveSha256: string,
): string[] {
  const entry = pin.platforms[platform];
  let sums: Map<string, string>;
  try {
    sums = parseShasums(shasums);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const listed = sums.get(entry.file);
  const problems: string[] = [];
  if (listed === undefined) problems.push(`SHASUMS256.txt does not list ${entry.file}`);
  else if (listed !== archiveSha256) problems.push(`${entry.file} does not match SHASUMS256.txt`);
  if (archiveSha256 !== entry.sha256) problems.push(`${entry.file} does not match node-pin.json`);
  return problems;
}

/** The gpgv to use: GPGV, Git for Windows' copy on Windows, else gpgv on PATH. */
export function findGpgv(): string {
  const fromEnv = process.env["GPGV"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const git = join(programFiles, "Git", "usr", "bin", "gpgv.exe");
    if (existsSync(git)) return git;
    return "gpgv.exe";
  }
  return "gpgv";
}

export interface SignatureResult {
  ok: boolean;
  /** The fingerprint of the key that made a valid signature. */
  fingerprint?: string;
  problem?: string;
}

/**
 * Verifies `sigFile` over `dataFile` with gpgv and only `keyring`. All three files sit in `dir`,
 * which also serves as gpgv's home, so nothing outside it is read or written. gpgv runs with the
 * folder as its working directory and relative names, because the MSYS build in Git for Windows
 * misreads absolute Windows paths for --keyring.
 */
export function verifyWithGpgv(
  gpgv: string,
  dir: string,
  files: { keyring: string; sig: string; data: string },
): SignatureResult {
  const home = join(dir, "gnupg-home");
  mkdirSync(home, { recursive: true });
  const result = spawnSync(
    gpgv,
    [
      "--homedir",
      "gnupg-home",
      "--status-fd",
      "1",
      "--keyring",
      `./${files.keyring}`,
      files.sig,
      files.data,
    ],
    { cwd: dir, encoding: "utf8", windowsHide: true },
  );
  if (result.error) return { ok: false, problem: `cannot run ${gpgv}: ${result.error.message}` };
  const valid = /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40}) /m.exec(result.stdout);
  if (result.status === 0 && valid !== null) return { ok: true, fingerprint: valid[1] ?? "" };
  const status = result.stdout
    .split(/\r?\n/)
    .filter((l) => /^\[GNUPG:\] (BADSIG|ERRSIG|NO_PUBKEY|EXPKEYSIG|REVKEYSIG)/.test(l))
    .map((l) => l.replace(/^(\[GNUPG:\] (?:BAD|EXPKEY|REVKEY)SIG [0-9A-F]+) .*$/, "$1"))
    .join("; ");
  return { ok: false, problem: `gpgv exited ${String(result.status)}: ${status || "no status"}` };
}

async function download(url: string, to: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${String(response.status)}`);
  const data = Buffer.from(await response.arrayBuffer());
  const tmp = `${to}.part`;
  writeFileSync(tmp, data);
  renameSync(tmp, to);
  return data;
}

/** Reads a cached download, or fetches it. Cached bytes are verified like fresh ones. */
async function cached(url: string, to: string): Promise<Buffer> {
  if (existsSync(to)) return readFileSync(to);
  return download(url, to);
}

export interface FetchedRuntime {
  binary: string;
  license: string;
  version: string;
  sqlite: string;
  signer?: string;
}

export interface FetchOptions {
  pin?: NodePin;
  platform: Platform;
  /** Folder for downloads and the extracted binary. Re-used across runs. */
  cacheDir: string;
  /** `require` (default) fails without a verified signature. `skip` is for offline debugging. */
  signature?: "require" | "skip";
  log?: (line: string) => void;
}

/** Downloads, verifies and extracts the pinned Node for one platform. */
export async function fetchNodeRuntime(options: FetchOptions): Promise<FetchedRuntime> {
  const pin = options.pin ?? loadPin();
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const entry = pin.platforms[options.platform];
  const dir = join(options.cacheDir, `node-v${pin.version}`);
  mkdirSync(dir, { recursive: true });

  const shasums = await download(
    new URL("SHASUMS256.txt", pin.base).href,
    join(dir, "SHASUMS256.txt"),
  );
  let signer: string | undefined;
  if (options.signature === "skip") {
    log("node: SHASUMS256.txt signature NOT checked (--signature skip)");
  } else {
    await download(new URL("SHASUMS256.txt.sig", pin.base).href, join(dir, "SHASUMS256.txt.sig"));
    const keyring = await cached(pin.signature.keyring, join(dir, "release-keys.kbx"));
    if (sha256(keyring) !== pin.signature.keyringSha256) {
      throw new Error("the Node release keyring does not match its pinned SHA-256");
    }
    const sig = verifyWithGpgv(findGpgv(), dir, {
      keyring: "release-keys.kbx",
      sig: "SHASUMS256.txt.sig",
      data: "SHASUMS256.txt",
    });
    if (!sig.ok) throw new Error(`SHASUMS256.txt signature: ${sig.problem ?? "invalid"}`);
    signer = sig.fingerprint;
    log(`node: SHASUMS256.txt signature valid, key ${String(signer)}`);
  }

  const archive = await cached(new URL(entry.file, pin.base).href, join(dir, entry.file));
  const problems = checkNodeArchive(
    pin,
    options.platform,
    shasums.toString("utf8"),
    sha256(archive),
  );
  if (problems.length > 0) throw new Error(`node download rejected: ${problems.join("; ")}`);
  log(`node: ${entry.file} matches SHASUMS256.txt and node-pin.json (${entry.sha256})`);

  const entries = options.platform === "win-x64" ? readZip(archive) : readTarGz(archive);
  const pick = (path: string): Buffer => {
    const found = entries.find((e) => e.path === path);
    if (found?.type !== "file") throw new Error(`${entry.file} has no file ${path}`);
    return found.data;
  };
  const out = join(dir, options.platform);
  mkdirSync(out, { recursive: true });
  const binary = join(out, options.platform === "win-x64" ? "node.exe" : "node");
  const license = join(out, "LICENSE");
  writeFileSync(binary, pick(entry.binary), { mode: 0o755 });
  writeFileSync(license, pick(entry.license));
  return {
    binary,
    license,
    version: pin.version,
    sqlite: pin.sqlite,
    ...(signer === undefined ? {} : { signer }),
  };
}
