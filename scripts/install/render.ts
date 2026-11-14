// The install scripts of a release (A2 3.12.4, 3.12.5): install.sh (Linux) and install.ps1
// (Windows) with the version and the pinned release keys written into their text. The templates
// beside this file are what a release ships after rendering; each script's own comments say what
// it does and in which order.
//
// Two kinds of build, and only these:
//   release  the keys come from packages/service/src/version/release-keys.ts and nowhere else. A
//            release build fails while that file still holds its placeholder, so an installer can
//            never ship that trusts a test key, or nothing. `pnpm release sign` renders them.
//   test     a throwaway key made by a test or a CI run, given here. The script says so in its
//            first comment and on stderr every time it runs, and is named install-<v>-test.*.
// A template that was never rendered trusts no key: it refuses to install anything.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENV_PREFIX, PRODUCT_ID, PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import {
  ED25519_KEY_LINE,
  RELEASE_KEY_PLACEHOLDER,
  RELEASE_PUBLIC_KEYS,
} from "../../packages/service/src/version/release-keys.ts";
import { isVersionName } from "../../packages/service/src/version/folder.ts";

export type InstallerKind = "sh" | "ps1";
export const INSTALLER_KINDS: readonly InstallerKind[] = ["sh", "ps1"];
export type BuildKind = "release" | "test";

export const TEMPLATES: Readonly<Record<InstallerKind, string>> = {
  sh: fileURLToPath(new URL("./install.sh", import.meta.url)),
  ps1: fileURLToPath(new URL("./install.ps1", import.meta.url)),
};

/** A release build refused: the keys are not ready, or not keys. */
export class ReleaseKeyError extends Error {
  override readonly name = "ReleaseKeyError";
}

/** The installer's file name: install-<version>.sh, or install-<version>-test.sh for a test build. */
export function installerName(kind: InstallerKind, version: string, build: BuildKind): string {
  return `install-${version}${build === "test" ? "-test" : ""}.${kind}`;
}

/** The keys a script may pin: one or two OpenSSH Ed25519 lines, without comments. */
export function checkKeys(keys: readonly string[]): string[] {
  const lines = keys.map((key) => key.trim().split(/\s+/).slice(0, 2).join(" "));
  if (lines.length < 1 || lines.length > 2) {
    throw new ReleaseKeyError(
      "pin one or two release keys: the current key and, during a rotation, the next",
    );
  }
  for (const line of lines) {
    if (!ED25519_KEY_LINE.test(line)) {
      throw new ReleaseKeyError("a pinned key is not an OpenSSH Ed25519 public key line");
    }
  }
  if (new Set(lines).size !== lines.length) throw new ReleaseKeyError("a key is pinned twice");
  return lines;
}

function substitute(template: string, values: Readonly<Record<string, string>>): string {
  let text = template;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`@@${name}@@`, value);
  const left = /@@[A-Z_]+@@/.exec(text);
  if (left !== null) throw new Error(`the install template has an unknown placeholder ${left[0]}`);
  return text;
}

/**
 * One install script with the version and the keys in its text. `keys` must be valid keys: a
 * release build passes RELEASE_PUBLIC_KEYS through renderReleaseInstallers, which refuses the
 * placeholder first.
 */
export function renderInstaller(
  kind: InstallerKind,
  options: {
    readonly version: string;
    readonly keys: readonly string[];
    readonly build: BuildKind;
  },
): string {
  if (!isVersionName(options.version)) throw new Error("not a version name");
  const keys = checkKeys(options.keys);
  return substitute(readFileSync(TEMPLATES[kind], "utf8"), {
    PRODUCT: PRODUCT_ID,
    PRODUCT_NAME,
    HOME_VAR: `${ENV_PREFIX}HOME`,
    VERSION: options.version,
    BUILD_KIND: options.build,
    // sh: one key per line inside single quotes. ps1: the items of @('…'), quoted.
    RELEASE_KEYS: kind === "sh" ? keys.join("\n") : keys.join("', '"),
  });
}

/**
 * The pinned release keys, ready for a release: not the placeholder, and one or two real keys.
 * Throws ReleaseKeyError otherwise.
 */
export function checkReleaseKeys(pinned: readonly string[] = RELEASE_PUBLIC_KEYS): string[] {
  if (pinned.some((key) => key.includes(RELEASE_KEY_PLACEHOLDER))) {
    throw new ReleaseKeyError(
      "The release key is not pinned yet: packages/service/src/version/release-keys.ts still holds its placeholder. Make the key (pnpm release keygen, A2 3.12.5) and commit its public line there first.",
    );
  }
  return checkKeys(pinned);
}

/**
 * The release's install scripts, pinning RELEASE_PUBLIC_KEYS. Fails while that list still holds
 * the placeholder, or anything but one or two real keys, and when `signer` (the public key that
 * signs this release's SHA256SUMS) is given and is not one of them: those installers would refuse
 * the very release they ship with.
 */
export function renderReleaseInstallers(
  version: string,
  signer?: string,
  pinned: readonly string[] = RELEASE_PUBLIC_KEYS,
): Record<InstallerKind, string> {
  const keys = checkReleaseKeys(pinned);
  if (signer !== undefined && !keys.includes(checkKeys([signer])[0] ?? "")) {
    throw new ReleaseKeyError(
      "The key that signs this release is not one of the pinned release keys: its install scripts would refuse it.",
    );
  }
  return {
    sh: renderInstaller("sh", { version, keys, build: "release" }),
    ps1: renderInstaller("ps1", { version, keys, build: "release" }),
  };
}

/** A test build: an install script that trusts a throwaway key made by a test or a CI run. */
export function renderTestInstaller(kind: InstallerKind, version: string, testKey: string): string {
  return renderInstaller(kind, { version, keys: [testKey], build: "test" });
}
