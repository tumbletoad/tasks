# Packaging spike (M0.03)

**Promoted to the product build (M1.13).** `pnpm build` (`scripts/build/`) now makes the real version folder, and this spike stays as the lab's record, untouched and still passing as a lab test. What took over each part, so a change goes to the product code, not here:

| Spike | Product |
|---|---|
| `src/archive.ts`, `A2.3.12.2.spike.version-folder` | `scripts/build/archive.ts` (gzip header OS byte fixed), `A2.3.12.4.build.archives` |
| `src/node-runtime.ts`, `node-pin.json`, `A2.3.12.1.spike.node-download` | `scripts/build/node-runtime.ts`, `node-pin.json` (four platforms, no `--signature skip`), `fixtures/node-v26.13.1/`, `A2.3.12.1.build.node-download` |
| `src/version-folder.ts` | `scripts/build/version-folder.ts`, the manifest format in `packages/service/src/version/folder.ts`, `A2.3.12.2.build.version-folder` and `.version-manifest` |
| `app/gate.mjs`, `A2.3.12.1.spike.runtime-gate` | `packages/service/src/version/runtime-gate.ts` as `tasks doctor`'s `runtime` row, run by the build through the version's launcher, `A2.3.12.1.build.runtime-gate` |
| `launcher/tasks.sh`, the POSIX half of `A2.3.12.3.spike.launcher-argv` | `POSIX_LAUNCHER` in `scripts/build/launchers.ts` (A2 3.12.3's environment rule), `A2.3.12.3.build.posix-launcher`; the C launchers are `packages/launcher-win/` (M1.11) |
| `src/release.ts`, `scripts/sign.ts` | `scripts/build/signing.ts` (raw and OpenSSH signatures from one key, throwaway keys in memory) and `scripts/release/` (the release key), `A2.3.12.4.build.signing`, `A2.3.12.8.build.release-script` |
| `install/`, `scripts/smoke.ts`, `app/install.mjs`, `A2.3.12.4.spike.install-verify` | `scripts/install/install.sh`, `install.ps1` and `render.ts` (the release keys pinned from `packages/service/src/version/release-keys.ts`), `tasks install --finish` (`packages/cli/src/install.ts`, `packages/service/src/version/install.ts`) with doctor's candidate rows (`candidate.ts` there), `pnpm smoke` (`scripts/install/smoke.ts`), `A2.3.12.4.install.*` (M1.14) |

Lab code for A2 3.12 (packaging, D11). It builds a version folder with the official Node 26.13.1, the POSIX launcher, the two C launchers, minimal `install.sh` and `install.ps1`, and the runtime gate. Lab rows R01 (runtime gate), R09 (per-user install, signature first, hostile argv) and S08 (switching `current`, `--replace`) in A7 3.7 use it. Nothing outside `spikes/` imports it, and none of it ships.

## What is here

| Path | What |
|---|---|
| `node-pin.json` | Node version, SQLite version, nodejs.org base URL, the two archive digests, the pinned Node release keyring |
| `app/` | Stand-in for `lib/`: `tasks.mjs` (routes `argv`, `exit`, `version`, `wait`, `gate`, `install --finish`), `gate.mjs` (the runtime gate), `install.mjs` (the hand-over after verification) |
| `launcher/tasks.sh` | The POSIX launcher, verbatim from A2 3.12.3 |
| `launcher/tasks-launcher.c` | `tasks.exe` and `tasksw.exe` from one source (A2 3.12.3, spike scope listed in the file) |
| `launcher/canary-stand-in.c` | Test-only Windows stand-in for the tamper checks. It is compiled for a test or smoke run, never shipped |
| `install/install.template.sh`, `.ps1` | The install bootstraps. The sign step fills in the version and the pinned public keys |
| `src/` | Archive writers and readers, the Node download and its checks, MSVC discovery, the version folder and manifest, SHA256SUMS and signing, the shared install and argv checks |
| `scripts/build.ts`, `sign.ts`, `smoke.ts` | The three CI steps, also runnable by hand |
| `test/` | Offline tests, part of `pnpm verify`. `test/fixtures/node-v26.13.1/` holds Node's public `SHASUMS256.txt`, its signature and the pinned release keyring |

The version folder (A2 3.12.2, spike subset):

```
bin/tasks | bin/tasks.exe, bin/tasksw.exe
runtime/node | runtime/node.exe          official binary, unmodified
lib/tasks.mjs, lib/gate.mjs, lib/install.mjs
licenses/node.txt  LICENSE  NOTICE
manifest.json                            version, build, platform, node, sqlite, SHA-256 of every other file
```

The archives are `tasks-<version>-linux-x64.tar.gz` and `tasks-<version>-win-x64.zip`, reproducible from the same folder (fixed timestamp, sorted entries). The Linux archive is gzip, not xz (A2 3.12.4).

## Running it

The build downloads Node, so it never runs inside `pnpm verify`. Everything runs on the pnpm-provided Node 26.13.1.

```
pnpm exec node spikes/m0/packaging/scripts/build.ts --platform win-x64 --work <tmp>/build
pnpm exec node spikes/m0/packaging/scripts/sign.ts --throwaway <tmp>/key
pnpm exec node spikes/m0/packaging/scripts/smoke.ts --work <tmp>/smoke
```

- `build.ts` writes the archive into `spikes/m0/packaging/dist/` (git-ignored; `--dist` changes it). `win-x64` builds on Windows only, because it compiles the launchers with MSVC (found through `vswhere`, no `vcvars` batch file). `--signature skip` disables the `SHASUMS256.txt` signature check for offline debugging only. CI never passes it.
- `sign.ts` generates a throwaway Ed25519 key in the given empty folder (which must be outside the repository), writes `SHA256SUMS`, `SHA256SUMS.sshsig` and `install-<version>.sh`/`.ps1` pinning that key, then deletes the key.
- `smoke.ts` installs with the real install script into `<work>/home` (`TASKS_HOME`), runs the gate through the stable and the version-local launcher, sends hostile argv through every launcher, checks that four tampered downloads stop before anything from them runs, and checks that a reinstall refuses an existing version folder that is not exactly the signed release. On Windows it compiles the canary stand-in with MSVC, as the build does.

To install by hand, always into a temporary folder:

```
sh dist/install-0.0.0-spike.sh --source dist --root /tmp/tasks-test
powershell -NoProfile -ExecutionPolicy Bypass -File dist\install-0.0.0-spike.ps1 -Source dist -Root $env:TEMP\tasks-test
```

The install scripts refuse to run without `--root`/`-Root` or `TASKS_HOME`. They never install into `~/.local/share/tasks` or `%USERPROFILE%\.tasks`, never touch `PATH` or the user `Path`, and write nothing outside the root. Every root they install is a separate install with `home.marker`, so the launchers export `TASKS_HOME`.

The workflow `.github/workflows/m0-packaging.yml` runs build, sign and smoke on `ubuntu-24.04` and `windows-2025` and uploads the archive for three days.

## Trust assumptions

Each item says what is trusted and why that is acceptable for the spike. A candidate archive never vouches for itself: nothing inside it is read or run before its authenticity is settled from outside it.

**Building**

1. **The Node runtime.** Trusted: nodejs.org over HTTPS, the Node releasers' OpenPGP keys, and `gpgv`. The build accepts the archive only when (a) `SHASUMS256.txt.sig` verifies with `gpgv` against `nodejs/release-keys` at commit `481637f8…` (`gpg-only-active-keys/pubring.kbx`, SHA-256 pinned in `node-pin.json`), (b) the archive matches its line in `SHASUMS256.txt`, and (c) it matches the digest pinned in `node-pin.json`. A test checks that the pinned digests equal the ones pnpm recorded in `pnpm-lock.yaml`, an independent download. So a changed `SHASUMS256.txt`, even one signed by a compromised releaser key, still fails (c). The binary is copied out of the verified archive byte for byte. On the Windows lab machine the packaged `node.exe` equals `win-x64/node.exe` in `SHASUMS256.txt` and has a valid OpenJS Foundation Authenticode signature. The rule: A2 3.12.1.
2. **`gpgv`.** The runner's own: `/usr/bin/gpgv` on Ubuntu, Git for Windows' `gpgv.exe` on Windows (`GPGV` overrides). It runs with a private `--homedir` inside the build folder, so no user keyring is read or written.
3. **The build machine.** The GitHub-hosted runner, its MSVC and its Windows SDK are trusted to compile the launchers and assemble the folder. The launchers are not Authenticode-signed (A2 3.12.7: SignPath before the first public Windows build).
4. **Tests.** The offline tests in `pnpm verify` package the Node that runs them (pnpm's download of the same official 26.13.1, verified by pnpm against `pnpm-lock.yaml`), so they need no network. Only the workflow and `build.ts` package a fresh download.

**Signing**

5. **The release key.** The spike never creates, reads or names a real release key. Each test run and each CI run generates a throwaway Ed25519 key with `ssh-keygen` in a temporary folder outside the repository, signs `SHA256SUMS` in OpenSSH's signature format (namespace `tasks-release`), renders the install scripts with its public key, and deletes the private key. `generateThrowawayKey` refuses a folder inside the repository. The `.sshsig` and install scripts made this way prove the mechanism only. They are not uploaded as artifacts.
6. **Not in the spike:** the raw `SHA256SUMS.sig`, the `openssl pkeyutl` fallback on Linux, the Authenticode-checked `node.exe` fallback verifier on Windows, the signed channel manifest and key rotation (A2 3.12.4, 3.12.5). The scripts pin up to two keys already (current and next).

**Installing**

7. **The install script itself** is the first-install trust root (A2 3.12.4, S31). It pins the public keys in its own text. Whoever controls the script controls the install, so a script fetched from the same untrusted place as the archive protects nothing: in a release it comes over HTTPS from the release host, versioned, with its SHA-256 in the release notes. In the spike it sits next to the archive in a local folder (`--source`).
8. **The OS's own tools.** Linux: the first `ssh-keygen` on `PATH` (OpenSSH 8.1 or later), `sha256sum`, `awk`, `sed`, `cmp`, GNU `tar` and `mv`. Windows: `ssh-keygen.exe` by absolute path from `[Environment]::GetFolderPath('System')` + `OpenSSH\` (part of Windows), `Get-FileHash` and .NET's `ZipFile`. A same-user attacker who controls `PATH` can already run code as the user, so trusting `PATH` on Linux adds nothing new. No verifier: the script stops.
9. **Order.** The script copies the archive, `SHA256SUMS` and `SHA256SUMS.sshsig` into a private download folder, so the bytes it verifies are the bytes it unpacks. Then (1) the signature of `SHA256SUMS` must verify against a pinned key, (2) `SHA256SUMS` must list the archive exactly once and its SHA-256 must match. Only then is the archive unpacked into `versions/.staging-<rand>`, every file checked against `manifest.json` (no missing, extra, changed or linked files), and the folder renamed into place. Only after all of that does the new version's own launcher run: `--package-info` (Windows), then `install --finish`, whose self-test (the runtime gate) is a functional check, never an authenticity check.
10. **An existing folder of the same version** never vouches for itself. It runs only if it is exactly this signed release: a plain folder, its `manifest.json` byte for byte the staged one (which came out of the signed archive), and every file checked against that staged manifest. On any mismatch (a changed file, files and manifest changed together, a manifest from another build of the same version, a link) the script stops with "versions/<v> already exists but is not this signed release", runs nothing from it and leaves it, `current`, `bin/` and `install.json` as they were. It does not replace the folder, because a running Tasks may use it. The rule: A2 3.12.4, step 7.
11. **Tested refusals.** A look-alike archive under the real name has every runnable file replaced by a canary stand-in: the launchers (a POSIX script, on Windows a small stand-in executable built from `launcher/canary-stand-in.c`), the runtime and every `lib/` module, with a consistent `manifest.json`. Each stand-in writes a file into a canary folder when it runs in any way: any arguments, any entry point, any shell. The folder's path is written into each stand-in, so a cleaned environment does not silence it. Before the refusals run, each stand-in is run once to prove it fires. The look-alike is refused in four ways: archive swapped with the original `SHA256SUMS`, `SHA256SUMS` rewritten to the look-alike's digest, `SHA256SUMS` re-signed with a foreign key, and the signature missing. Each must stop with "Cannot verify this download", leave the canary folder empty, and leave no version folder, no staging or download folder, no `current` and no `bin/`. A reinstall over a changed, a consistently changed (canary stand-ins and a matching manifest) and a rebuilt version folder must stop the same way, with the canary folder empty and the folder unchanged.
12. **Not protected against:** a same-user attacker after install (they can change the installed files anyway), a compromised build runner, and a compromised Node release process that also changes `node-pin.json` in a reviewed commit. No `update.lock` yet, so two concurrent installs into one root are not serialised (A2 3.12.6 brings it).

**Launching**

13. The launchers trust their own location. `bin/tasks` resolves itself with `readlink -f`. `tasks.exe` finds its mode from `GetModuleFileNameW` and reads `current` only in stable-dispatch mode, accepting only `[0-9A-Za-z.+-]{1,64}` that is not all dots. They remove `NODE_OPTIONS` and `NODE_PATH`, so an agent's environment cannot inject code into Node. The Windows details are in `packages/launcher-win/README.md`.
14. `tasks.exe` runs Node only inside its kill-on-close job. If Windows refuses to create, configure or assign the job, or to resume Node, the launcher terminates the suspended Node and exits 70, so Node never runs without the job. A test-only build (`TASKS_TEST_HOOKS`) simulates each refusal. Release builds never define it.

## What the tests prove

| Manifest ID | Proves |
|---|---|
| `A2.3.12.1.spike.runtime-gate` | The gate passes on Node 26.13.1 with SQLite 3.54.1 (FTS5 compiled in and matching, STRICT, JSON, `backup()`, `--report-exclude-env`), and fails when the flag is missing or the versions differ |
| `A2.3.12.1.spike.node-download` | The pins agree with `.node-version` and `pnpm-lock.yaml`. A wrong digest, a missing entry or a malformed `SHASUMS256.txt` is refused. `gpgv` accepts Node's real signature and refuses a changed file or an unknown key |
| `A2.3.12.2.spike.version-folder` | Layout per platform, a manifest of every file, the manifest check, the line format the POSIX script reads, exec bits in the tar, reproducible archives, unsafe paths refused |
| `A2.3.12.3.spike.launcher-argv` | 33 hostile arguments (spaces, quotes, backslash runs, trailing backslashes, empty strings, `%`, `^&|<>`, tabs, newlines, emoji, combining marks, right-to-left text) reach Node unchanged through `bin/tasks` (version-local and through `bin/tasks` → `current`), and through `tasks.exe` and `tasksw.exe` in both modes. A raw, unbalanced command line reaches Node exactly as Node would parse it directly. `NODE_OPTIONS` and `NODE_PATH` are removed, exit codes pass through, `TASKS_*` variables are set, a bad `current` and a missing runtime exit 70, `--package-info` and `--replace` work. Each refused job step (simulated in a test build) exits 70 before Node runs, the release build ignores the test hook, and killing `tasks.exe` kills Node |
| `A2.3.12.4.spike.install-verify` | A good install into a temporary `TASKS_HOME` with the gate passing through the installed launcher, the stand-ins that fire when run, the four refusals and the three refused reinstalls of item 11, an intact reinstall that keeps the folder, and no install without a named root. On Windows also from a PowerShell 7 window (lab row R09): on a code page 65001 console and with its inherited PSModulePath, ssh-keygen reads exactly the bytes of SHA256SUMS, the install completes and the four refusals hold |

## Results so far (2026-11-12)

- Windows 11 (the Windows lab machine): `pnpm verify` passes. The real `win-x64` build (download, signature, MSVC launchers), sign and smoke pass. Gate: Node v26.13.1, SQLite 3.54.1, every check passes.
- WSL Ubuntu 22.04 (OpenSSH 8.9, glibc 2.35): `pnpm verify` passes. The real `linux-x64` build, sign and smoke pass with the same gate result.
- After the review fixes (existing version folder, canary stand-ins in every runnable file, job object fail closed), both rows above pass again, including the smoke's new reinstall step. Each finding was first reproduced: the reinstall and tamper findings on both OSes, the job-object finding on Windows.
- Job object, Windows lab machine only (Windows 11 build 26300): `tasks.exe` inside an outer job, without limits and with every UI limit set, still starts Node in its own nested job.
- S08, preliminary, Windows lab machine only: `tasks.exe --replace <new> <target>` over a **running** `tasks.exe` or `tasksw.exe` fails with `ERROR_ACCESS_DENIED` (5). Renaming the running launcher aside works. So A2 3.12.6 step 10 takes the two-rename path on this machine. M0.07 records the row properly, with a bridge running.
- The workflow runs on GitHub's runners (ubuntu-24.04, windows-2025) for every push to the pull request.
- M0.05 (lab run R, 2026-11-12): from a PowerShell 7 console with code page 65001, `install.ps1` refused a good signature (Windows PowerShell 5.1 put a byte order mark before `SHA256SUMS` on ssh-keygen's input) and then lacked `Get-FileHash` (PowerShell 7's `PSModulePath`). Both are fixed in the template (A2 3.12.4). After the fix, install and smoke pass on the Windows lab machine, and on the Linux lab machine (Ubuntu 24.04, OpenSSH 9.6p1) into a `TASKS_HOME` test root (A7 3.7, row R09).
