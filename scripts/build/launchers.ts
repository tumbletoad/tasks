// The launchers of a version folder: the POSIX script `bin/ttasks` for Linux and macOS,
// written here, and `ttasks.exe` and `ttasksw.exe` for Windows, compiled by @ttasks/launcher-win's
// release build and checked again for test hooks before they ship.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import {
  assertReleaseBinary,
  buildLaunchers,
  buildRunHelper,
  type Launchers,
} from "../../packages/launcher-win/src/build.ts";

/**
 * `versions/<v>/bin/ttasks`: the POSIX launcher, with its rules for what reaches Node.
 *
 * - The shell first turns off what it may have taken from the environment before the first line:
 *   bash, which is /bin/sh on Fedora and macOS, reads SHELLOPTS and exported functions from it. With
 *   xtrace on, every expanded command below (the caller's whole environment from `export -p`, and
 *   the arguments) would reach stderr, which agent apps log; an exported `readlink` function would
 *   decide the version folder. `set +x +v` runs first, so tracing shows nothing but that command,
 *   and `unset -f readlink` leaves the one command the script looks up on PATH to PATH. The
 *   special built-ins it uses (set, unset, export, exec) come before functions in a POSIX shell.
 *   `set +e +u` keeps errexit and nounset from SHELLOPTS out of the script's own logic.
 * - `readlink -f` resolves `~/.local/bin/ttasks` and `current`, so one process runs one version.
 * - TTASKS_HOME comes from the location only: the install root when it holds home.marker, else it
 *   is removed, whatever the caller set (point 8). The variables only the Windows launchers set
 *   (TTASKS_ROOT, TTASKS_LAUNCHER, TTASKS_LAUNCH_MODE, TTASKS_PACKAGE) mean nothing here and are
 *   removed, so a caller cannot make the service believe it runs in a package.
 * - Node reads its NODE_ variables and OpenSSL its loader settings while Node starts, before the
 *   entry runs (point 12). So every exported NODE_ variable but NODE_EXTRA_CA_CERTS is removed
 *   (names are case-sensitive here), and OPENSSL_CONF, OPENSSL_CONF_INCLUDE, OPENSSL_MODULES and
 *   OPENSSL_ENGINES. The names come from `export -p`, one per line: a value that spans lines can
 *   only add a spurious NODE_ name, which is removed too (it is one), never hide a real one. A name
 *   that is not a shell identifier is skipped, because `unset` of one would end the script; such a
 *   name is no NODE_ variable Node reads.
 * - Everything else passes through: proxies, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and SSL_CERT_DIR.
 * - `exec` replaces the shell, so a bridge is one process.
 */
export const POSIX_LAUNCHER = `#!/bin/sh
# ${PRODUCT_ID} launcher. Generated at build time. Do not edit.
set +x +v +e +u
unset -f readlink
self=$(readlink -f -- "$0") || exit 70
root=\${self%/bin/${PRODUCT_ID}}
home=\${root%/versions/*}
[ -f "$home/home.marker" ] && export TTASKS_HOME="$home" || unset TTASKS_HOME
unset TTASKS_ROOT TTASKS_LAUNCHER TTASKS_LAUNCH_MODE TTASKS_PACKAGE
unset OPENSSL_CONF OPENSSL_CONF_INCLUDE OPENSSL_MODULES OPENSSL_ENGINES
set -f
IFS='
'
for line in $(export -p); do
  name=\${line#export }
  name=\${name#declare -x }
  name=\${name%%=*}
  case $name in
    NODE_EXTRA_CA_CERTS | *[!A-Za-z0-9_]*) ;;
    NODE_*) unset "$name" ;;
  esac
done
exec "$root/runtime/node" --report-exclude-env "$root/lib/${PRODUCT_ID}.mjs" "$@"
`;

/**
 * The launchd wrapper `bin/ttasks-launchd` of a macOS build, mode 0755. Its text is
 * the service install's own, so the two agree on it.
 */
export { LAUNCHD_WRAPPER } from "../../packages/service/src/install/render.ts";

/** The Windows binaries of a version folder: the two launchers and the holder of a run's job. */
export interface WindowsLaunchers extends Launchers {
  readonly run: string;
}

/**
 * Compiles the Windows release launchers and ttasks-run.exe into `dir` (never with test hooks) and
 * checks each for test hooks again, so no binary the build ships has them.
 */
export function windowsLaunchers(dir: string): WindowsLaunchers {
  if (process.platform !== "win32") {
    throw new Error("win-x64 builds on Windows: its launchers are compiled with MSVC");
  }
  mkdirSync(dir, { recursive: true });
  const built = buildLaunchers(join(dir, "launchers"));
  const run = buildRunHelper(join(dir, "launchers"));
  for (const exe of [built.ttasks, built.ttasksw, run]) assertReleaseBinary(exe);
  return { ...built, run };
}

export { assertReleaseBinary };
