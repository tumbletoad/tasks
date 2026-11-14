// Release files around the archives (A2 3.12.4, 3.12.5): SHA256SUMS, its OpenSSH signature
// SHA256SUMS.sshsig (namespace tasks-release) and the versioned install scripts, which pin the
// release public keys in their own text.
//
// The spike signs only with a throwaway Ed25519 key that a test or CI run generates in a
// temporary folder and deletes afterwards. It never creates, reads or names a real release key.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { installTemplates, repoRoot } from "./paths.ts";
import { archiveName, type Platform, sha256File, VERSION_PATTERN } from "./version-folder.ts";

export const NAMESPACE = "tasks-release";
export const THROWAWAY_COMMENT = "tasks-spike-throwaway-test-key";

/** The ssh-keygen this OS ships: System32\OpenSSH on Windows, ssh-keygen on PATH elsewhere. */
export function systemSshKeygen(): string {
  if (process.platform === "win32") {
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    return join(systemRoot, "System32", "OpenSSH", "ssh-keygen.exe");
  }
  return "ssh-keygen";
}

function run(exe: string, args: string[], input?: Buffer): { stdout: Buffer; stderr: string } {
  const result = spawnSync(exe, args, {
    input,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`cannot run ${exe}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${exe} ${args[0] ?? ""} exited ${String(result.status)}: ${result.stderr.toString()}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr.toString() };
}

function insideRepo(path: string): boolean {
  const rel = relative(repoRoot, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface ThrowawayKey {
  privateKey: string;
  /** `ssh-ed25519 <base64>`, without the comment. */
  publicKey: string;
}

/**
 * Generates a throwaway Ed25519 key in `dir`, which must be a temporary folder outside the
 * repository, so the private key can never be committed.
 */
export function generateThrowawayKey(dir: string, keygen = systemSshKeygen()): ThrowawayKey {
  if (insideRepo(dir)) throw new Error("the throwaway key folder must be outside the repository");
  const privateKey = join(dir, "throwaway-ed25519");
  if (existsSync(privateKey)) throw new Error(`${privateKey} already exists`);
  run(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", THROWAWAY_COMMENT, "-f", privateKey]);
  const pub = readFileSync(`${privateKey}.pub`, "utf8").trim().split(" ");
  if (pub[0] !== "ssh-ed25519" || pub[1] === undefined) throw new Error("unexpected public key");
  return { privateKey, publicKey: `ssh-ed25519 ${pub[1]}` };
}

export function deleteKey(key: ThrowawayKey): void {
  rmSync(key.privateKey, { force: true });
  rmSync(`${key.privateKey}.pub`, { force: true });
}

const ARCHIVE_NAME = /^tasks-(.+)-(linux-x64\.tar\.gz|win-x64\.zip)$/;

export interface DistArchive {
  file: string;
  version: string;
  platform: Platform;
}

/** The release archives in `dist`, sorted by name. */
export function distArchives(dist: string): DistArchive[] {
  return readdirSync(dist)
    .sort()
    .flatMap((file) => {
      const m = ARCHIVE_NAME.exec(file);
      if (m === null) return [];
      const platform: Platform = m[2] === "win-x64.zip" ? "win-x64" : "linux-x64";
      return [{ file, version: m[1] ?? "", platform }];
    });
}

/** Writes SHA256SUMS for every archive in `dist`. */
export function writeSha256Sums(dist: string): string {
  const archives = distArchives(dist);
  if (archives.length === 0) throw new Error(`no archives in ${dist}`);
  const text = archives.map((a) => `${sha256File(join(dist, a.file))}  ${a.file}\n`).join("");
  const file = join(dist, "SHA256SUMS");
  writeFileSync(file, text);
  return file;
}

/** Signs `file` with `ssh-keygen -Y sign` into `<file>.sshsig`. */
export function signFile(file: string, privateKey: string, keygen = systemSshKeygen()): string {
  const { stdout } = run(
    keygen,
    ["-Y", "sign", "-q", "-f", privateKey, "-n", NAMESPACE],
    readFileSync(file),
  );
  const sig = `${file}.sshsig`;
  writeFileSync(sig, stdout);
  return sig;
}

const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;

/** The install script for one platform, with the version and the pinned keys filled in. */
export function renderInstaller(platform: Platform, version: string, keys: string[]): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid version ${version}`);
  if (keys.length === 0 || keys.length > 2 || !keys.every((k) => PUBLIC_KEY.test(k))) {
    throw new Error("pin one or two ssh-ed25519 public keys (current and next)");
  }
  const template = readFileSync(
    platform === "win-x64" ? installTemplates.ps1 : installTemplates.sh,
    "utf8",
  );
  const keyText =
    platform === "win-x64" ? keys.map((k) => `  '${k}'`).join(",\n") : keys.join("\n");
  const out = template.replaceAll("@@VERSION@@", version).replaceAll("@@RELEASE_KEYS@@", keyText);
  if (out.includes("@@")) throw new Error("the install template has an unknown placeholder");
  return out;
}

export function installerName(platform: Platform, version: string): string {
  return `install-${version}.${platform === "win-x64" ? "ps1" : "sh"}`;
}

export interface SignedRelease {
  sums: string;
  signature: string;
  installers: string[];
}

/** SHA256SUMS, its signature and one install script per platform present in `dist`. */
export function signRelease(
  dist: string,
  key: ThrowawayKey,
  keygen = systemSshKeygen(),
): SignedRelease {
  const sums = writeSha256Sums(dist);
  const signature = signFile(sums, key.privateKey, keygen);
  const installers: string[] = [];
  for (const a of distArchives(dist)) {
    if (a.file !== archiveName(a.version, a.platform))
      throw new Error(`odd archive name ${a.file}`);
    const file = join(dist, installerName(a.platform, a.version));
    writeFileSync(file, renderInstaller(a.platform, a.version, [key.publicKey]));
    installers.push(file);
  }
  return { sums, signature, installers };
}
