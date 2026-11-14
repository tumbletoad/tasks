// The release public keys (A2 3.12.4, 3.12.5): the Ed25519 keys whose signature of SHA256SUMS a
// release's install scripts accept, the current key and, during a rotation, the next one. The
// install scripts pin them in their own text (scripts/install/render.ts); from M6 the updater
// embeds the same list in lib/. This is the one place they are written down.
//
// THE RELEASE KEY DOES NOT EXIST YET. The owner makes it once, on their own machine, with
// `pnpm release keygen` (A2 3.12.5), and its public line (`tasks-release-ed25519.pub`, which
// starts `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI`) replaces the placeholder below in a reviewed
// commit. Until then a release build of the install scripts fails (renderReleaseInstallers), so an
// installer can never ship that trusts a test key, or nothing. Tests and CI render their install
// scripts with a throwaway key of their own and mark them as test builds.

/** Stands in for the release key until the maintainer has made it. A release build refuses it. */
export const RELEASE_KEY_PLACEHOLDER = "RELEASE-KEY-NOT-MADE-YET";

/**
 * The pinned release keys, OpenSSH public key lines (`ssh-ed25519 <base64>`, no comment): the
 * current key first, then the next one during a rotation. One or two.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [RELEASE_KEY_PLACEHOLDER];

/**
 * The keys this build's updater trusts (A2 3.12.5: "embedded in lib/"): the pinned release keys.
 * An installed version verifies a candidate with these before anything of the candidate runs, so
 * while the placeholder stands, `tasks update` refuses every archive. Only the install scripts'
 * test kit replaces this line, in its own test builds (scripts/build/bundle.ts `trustKeys`), so a
 * test install can be updated with a throwaway key; `pnpm build` and a release never do.
 */
export const UPDATE_KEYS: readonly string[] = RELEASE_PUBLIC_KEYS;

/** An OpenSSH Ed25519 public key line: the type, then the 51-byte key blob in base64. */
export const ED25519_KEY_LINE = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;
