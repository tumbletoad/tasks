// The install scripts' one pinned value (A2 3.12.4, 3.12.5; A7 3.8 M1.14): a release build takes
// the release keys from packages/service/src/version/release-keys.ts only and fails while that
// holds its placeholder; a test build pins a throwaway key and says so; a template never rendered
// trusts nothing. Throwaway keys only, made here in memory.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ED25519_KEY_LINE,
  RELEASE_KEY_PLACEHOLDER,
  RELEASE_PUBLIC_KEYS,
} from "../../packages/service/src/version/release-keys.ts";
import { installerKinds } from "../build/build.ts";
import { opensshPublicKey } from "../build/signing.ts";
import {
  checkReleaseKeys,
  INSTALLER_KINDS,
  installerName,
  ReleaseKeyError,
  renderInstaller,
  renderReleaseInstallers,
  renderTestInstaller,
  TEMPLATES,
} from "./render.ts";

const key = () => opensshPublicKey(generateKeyPairSync("ed25519").publicKey);

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-render-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("[A2.3.12.4.install.render] the install scripts pin the release keys, one value", () => {
  test("a release build fails while the release keys hold the placeholder", () => {
    expect(() => renderReleaseInstallers("0.1.0", undefined, [RELEASE_KEY_PLACEHOLDER])).toThrow(
      /not pinned yet/,
    );
    expect(() => checkReleaseKeys([RELEASE_KEY_PLACEHOLDER])).toThrow(ReleaseKeyError);
    // The committed list is either still the placeholder, which a release refuses, or real keys.
    if (RELEASE_PUBLIC_KEYS.includes(RELEASE_KEY_PLACEHOLDER)) {
      expect(() => renderReleaseInstallers("0.1.0")).toThrow(/not pinned yet/);
    } else {
      expect(RELEASE_PUBLIC_KEYS.every((line) => ED25519_KEY_LINE.test(line))).toBe(true);
    }
  });

  test("a release build pins one or two real keys, and the key that signs the release must be one", () => {
    const [current, next, other] = [key(), key(), key()];
    const one = renderReleaseInstallers("0.1.0", current, [current]);
    expect(one.sh).toContain(`RELEASE_KEYS='${current}'`);
    expect(one.ps1).toContain(`$ReleaseKeys = @('${current}')`);
    const two = renderReleaseInstallers("0.1.0", next, [current, next]);
    expect(two.sh).toContain(`RELEASE_KEYS='${current}\n${next}'`);
    expect(two.ps1).toContain(`$ReleaseKeys = @('${current}', '${next}')`);
    for (const text of [one.sh, one.ps1]) {
      expect(text).toContain("(release build)");
      expect(text).not.toMatch(/@@[A-Z_]+@@/);
      expect(text).toMatch(/BUILD_KIND='release'|\$BuildKind = 'release'/);
    }
    expect(() => renderReleaseInstallers("0.1.0", other, [current])).toThrow(
      /not one of the pinned/,
    );
    expect(() => renderReleaseInstallers("0.1.0", current, [current, next, other])).toThrow(
      /one or two/,
    );
    expect(() => renderReleaseInstallers("0.1.0", current, [current, current])).toThrow(/twice/);
    expect(() => renderReleaseInstallers("0.1.0", current, ["ssh-rsa AAAAB3Nza"])).toThrow(
      /not an OpenSSH Ed25519/,
    );
    expect(() =>
      renderInstaller("sh", { version: "../x", keys: [current], build: "release" }),
    ).toThrow();
  });

  test("a test build pins its throwaway key, says so, and carries its own name", () => {
    const testKey = key();
    for (const kind of INSTALLER_KINDS) {
      const text = renderTestInstaller(kind, "0.1.0-dev.4", testKey);
      expect(text).toContain("(test build)");
      expect(text).toContain(testKey);
      expect(text).toContain("this installer was made by a test and trusts a throwaway key");
      expect(text).toMatch(/BUILD_KIND='test'|\$BuildKind = 'test'/);
      expect(text).not.toMatch(/@@[A-Z_]+@@/);
      expect(installerName(kind, "0.1.0-dev.4", "test")).toBe(`install-0.1.0-dev.4-test.${kind}`);
      expect(installerName(kind, "0.1.0", "release")).toBe(`install-0.1.0.${kind}`);
    }
    // A test-signed build writes one per kind of archive it holds.
    expect(
      installerKinds(["tasks-0.1.0-linux-x64.tar.gz", "tasks-0.1.0-darwin-arm64.tar.gz"]),
    ).toEqual(["sh"]);
    expect(installerKinds(["tasks-0.1.0-win-x64.zip"])).toEqual(["ps1"]);
    expect(installerKinds(["tasks-0.1.0-linux-arm64.tar.gz", "tasks-0.1.0-win-x64.zip"])).toEqual([
      "sh",
      "ps1",
    ]);
  });

  test("the templates keep the keys in one marked block, and each rendered script is valid for its shell", () => {
    for (const kind of INSTALLER_KINDS) {
      const template = readFileSync(TEMPLATES[kind], "utf8");
      expect(template.match(/@@RELEASE_KEYS@@/g)).toHaveLength(1);
      expect(template).toContain("The pinned release keys (A2 3.12.5)");
    }
    const rendered = (kind: "sh" | "ps1") => {
      const file = join(work, `syntax.${kind}`);
      writeFileSync(file, renderTestInstaller(kind, "0.1.0", key()));
      return file;
    };
    if (process.platform === "win32") {
      // PowerShell's own parser, without running anything.
      const ps = join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const parse = spawnSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:TASKS_TEST_SCRIPT, [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }",
        ],
        {
          env: { ...process.env, TASKS_TEST_SCRIPT: rendered("ps1") },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      expect(parse.status, parse.stdout).toBe(0);
    } else {
      const check = spawnSync("/bin/sh", ["-n", rendered("sh")], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
    }
  });
});
