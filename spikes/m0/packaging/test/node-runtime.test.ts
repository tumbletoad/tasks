import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  checkNodeArchive,
  findGpgv,
  loadPin,
  parseShasums,
  verifyWithGpgv,
} from "../src/node-runtime.ts";
import { repoRoot, spikeRoot } from "../src/paths.ts";
import { sha256 } from "../src/version-folder.ts";
import { removeDir, tempDir } from "./fixture.ts";

// The real SHASUMS256.txt of Node 26.13.1, its signature and the pinned nodejs/release-keys
// keyring, all public, kept as fixtures so the signature check runs offline.
const fixtures = join(spikeRoot, "test", "fixtures", "node-v26.13.1");
const pin = loadPin();
const shasums = readFileSync(join(fixtures, "SHASUMS256.txt"), "utf8");

let work: string;
beforeAll(() => {
  work = tempDir("node-runtime");
});
afterAll(() => {
  removeDir(work);
});

function lockfileSha256(file: string): string {
  // pnpm-lock.yaml records the runtime archives that devEngines.runtime downloads, each as an
  // `integrity:` line followed by its `url:` line.
  const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const at = lock.indexOf(`/v${pin.version}/${file}\n`);
  const before = lock.slice(0, at);
  const integrity = /^integrity: sha256-([A-Za-z0-9+/=]+)\n/.exec(
    before.slice(before.lastIndexOf("integrity:")),
  );
  if (at === -1 || integrity?.[1] === undefined) throw new Error(`${file} not in pnpm-lock.yaml`);
  return Buffer.from(integrity[1], "base64").toString("hex");
}

describe("[A2.3.12.1.spike.node-download] the official Node download is verified before use", () => {
  test("the pin names .node-version, SQLite 3.54.1 and nodejs.org", () => {
    const pinned = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
    expect(pin.version).toBe(pinned);
    expect(pin.sqlite).toBe("3.54.1");
    expect(pin.base).toBe(`https://nodejs.org/dist/v${pinned}/`);
    expect(pin.signature.keyring).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/nodejs\/release-keys\/[0-9a-f]{40}\//,
    );
  });

  test("the pinned digests agree with SHASUMS256.txt and with pnpm-lock.yaml", () => {
    for (const platform of ["linux-x64", "win-x64"] as const) {
      const entry = pin.platforms[platform];
      expect(checkNodeArchive(pin, platform, shasums, entry.sha256)).toEqual([]);
      expect(lockfileSha256(entry.file)).toBe(entry.sha256);
    }
  });

  test("a wrong digest, a missing entry and a malformed SHASUMS256.txt are refused", () => {
    const entry = pin.platforms["linux-x64"];
    const other = "0".repeat(64);
    expect(checkNodeArchive(pin, "linux-x64", shasums, other)).toEqual([
      `${entry.file} does not match SHASUMS256.txt`,
      `${entry.file} does not match node-pin.json`,
    ]);
    const without = shasums
      .split("\n")
      .filter((l) => !l.endsWith(entry.file))
      .join("\n");
    expect(checkNodeArchive(pin, "linux-x64", without, entry.sha256)).toEqual([
      `SHASUMS256.txt does not list ${entry.file}`,
    ]);
    // SHASUMS256.txt and the pin agree on a different digest: the pin still refuses it.
    const swapped = shasums.replace(entry.sha256, other);
    expect(checkNodeArchive(pin, "linux-x64", swapped, other)).toEqual([
      `${entry.file} does not match node-pin.json`,
    ]);
    expect(() => parseShasums("not a sums line\n")).toThrow(/malformed/);
    expect(() => parseShasums(`${other}  a\n${other}  a\n`)).toThrow(/twice/);
  });

  test("gpgv accepts the real signature and refuses a changed SHASUMS256.txt", () => {
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
    const good = verifyWithGpgv(findGpgv(), work, files);
    expect(good).toEqual({ ok: true, fingerprint: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356" });

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
