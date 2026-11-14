// The official Node download (A2 3.12.1), offline: the real SHASUMS256.txt of
// Node 26.13.1, its signature and the pinned nodejs/release-keys keyring are public files kept as
// fixtures (fixtures/node-v26.13.1/), so the signature check runs without the network.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { repoRoot } from "../run.ts";
import {
  checkNodeArchive,
  findGpgv,
  loadPin,
  parseShasums,
  sha256,
  verifyWithGpgv,
} from "./node-runtime.ts";
import { PLATFORMS } from "./platforms.ts";

const fixtures = join(repoRoot, "fixtures", "node-v26.13.1");
const pin = loadPin();
const shasums = readFileSync(join(fixtures, "SHASUMS256.txt"), "utf8");

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-node-runtime-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The digest pnpm recorded in pnpm-lock.yaml for a runtime archive: an independent download. */
function lockfileSha256(file: string): string {
  const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const at = lock.indexOf(`/v${pin.version}/${file}\n`);
  const before = lock.slice(0, at);
  const integrity = /^integrity: sha256-([A-Za-z0-9+/=]+)\n/.exec(
    before.slice(before.lastIndexOf("integrity:")),
  );
  if (at === -1 || integrity?.[1] === undefined) throw new Error(`${file} not in pnpm-lock.yaml`);
  return Buffer.from(integrity[1], "base64").toString("hex");
}

describe("[A2.3.12.1.build.node-download] the Node runtime is the verified official download", () => {
  test("the pin names .node-version, SQLite 3.54.1, nodejs.org and a keyring at a commit", () => {
    const pinned = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
    expect(pin.version).toBe(pinned);
    expect(pin.sqlite).toBe("3.54.1");
    expect(pin.base).toBe(`https://nodejs.org/dist/v${pinned}/`);
    expect(pin.signature.keyring).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/nodejs\/release-keys\/[0-9a-f]{40}\//,
    );
    expect(Object.keys(pin.platforms).sort()).toEqual([...PLATFORMS].sort());
  });

  test("every platform's digest agrees with SHASUMS256.txt and with pnpm-lock.yaml", () => {
    for (const platform of PLATFORMS) {
      const entry = pin.platforms[platform];
      expect(entry.file).toBe(
        `node-v${pin.version}-${platform}.${platform === "win-x64" ? "zip" : "tar.gz"}`,
      );
      expect(checkNodeArchive(pin, platform, shasums, entry.sha256), platform).toEqual([]);
      expect(lockfileSha256(entry.file), platform).toBe(entry.sha256);
    }
  });

  test("a wrong digest, a missing entry and a malformed SHASUMS256.txt are refused", () => {
    const entry = pin.platforms["linux-arm64"];
    const other = "0".repeat(64);
    expect(checkNodeArchive(pin, "linux-arm64", shasums, other)).toEqual([
      `${entry.file} does not match SHASUMS256.txt`,
      `${entry.file} does not match node-pin.json`,
    ]);
    const without = shasums
      .split("\n")
      .filter((l) => !l.endsWith(entry.file))
      .join("\n");
    expect(checkNodeArchive(pin, "linux-arm64", without, entry.sha256)).toEqual([
      `SHASUMS256.txt does not list ${entry.file}`,
    ]);
    // SHASUMS256.txt and the download agree on another digest: the pin still refuses it.
    const swapped = shasums.replace(entry.sha256, other);
    expect(checkNodeArchive(pin, "linux-arm64", swapped, other)).toEqual([
      `${entry.file} does not match node-pin.json`,
    ]);
    expect(() => parseShasums("not a sums line\n")).toThrow(/malformed/);
    expect(() => parseShasums(`${other}  a\n${other}  a\n`)).toThrow(/twice/);
  });

  test("gpgv accepts Node's real signature and refuses a changed file or an unknown key", () => {
    expect(sha256(readFileSync(join(fixtures, "release-keys.kbx")))).toBe(
      pin.signature.keyringSha256,
    );
    for (const name of ["SHASUMS256.txt", "SHASUMS256.txt.sig", "release-keys.kbx"]) {
      copyFileSync(join(fixtures, name), join(work, name));
    }
    const files = {
      keyring: "release-keys.kbx",
      sig: "SHASUMS256.txt.sig",
      data: "SHASUMS256.txt",
    };
    expect(verifyWithGpgv(findGpgv(), work, files)).toEqual({
      ok: true,
      fingerprint: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356",
    });
    writeFileSync(join(work, "SHASUMS256.txt"), shasums.replace(/^[0-9a-f]/, "f"));
    const bad = verifyWithGpgv(findGpgv(), work, files);
    expect(bad.ok).toBe(false);
    expect(bad.problem).toMatch(/BADSIG/);
    writeFileSync(join(work, "empty.kbx"), "");
    writeFileSync(join(work, "SHASUMS256.txt"), shasums);
    const unknown = verifyWithGpgv(findGpgv(), work, { ...files, keyring: "empty.kbx" });
    expect(unknown.ok).toBe(false);
    expect(unknown.problem).toMatch(/NO_PUBKEY|ERRSIG/);
  });
});
