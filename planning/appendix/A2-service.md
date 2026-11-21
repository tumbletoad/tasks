# A2. The service, process model and packaging

> What is left in this document is background for parts that are not built yet. The code and its tests are the source of truth for everything that is built, and `docs/promises-and-limits.md` says what a person can count on. Do not add to this document.

## 3. Specification

### 3.2 Machine-local locations

#### 3.2.4 `machine.toml`

One machine-local file, `<config>/machine.toml`, never synced or exported. This appendix owns `[service]`, `[http]`, `[ui]`, `[updates]`, `[log]` and `[[spaces]]`. A4 owns `[terminal]`, `[[instance]]`, `[[custom_target]]`, `[approvals]`, `[override.*]` and the run caps. `[roots]` and `[roots.*]` are no longer used, because folders are space data (A1 3.15): a file that holds them still parses, the service ignores them, `ttasks doctor` names them once as no longer used, and TTasks never edits them away. A1 owns `[preferences]`, this machine's preferences by their whole name (A1 3.16). A3 owns `[setup]` (3.12). A6 owns `[remote]` and `[security]`. Code: `packages/service/src/config/` (`machine-toml.ts`, whose header states the rules; `toml.ts`, `edit.ts`). Tests: `A2.3.2.4.config.golden`, `.edit`, `A2.3.13.cli.doctor` (`doctor-config.test.ts`).

- The keys of this appendix: `[service] default_space`; `[http] port`; `[ui] open_mode` (`tab` or `app`); `[updates] channel`, `check`, `auto` (`auto = true` installs only while no run or launched session is active); `[log] level`; `[[spaces]]` with `id`, `path` and `enabled`. Copies of one space share its ID (3.10.5), so an ID may repeat in `[[spaces]]`; a folder named twice, in any spelling the OS reads as one, refuses the start (`A2.3.2.4.config.space-copies`).
- **Reading is strict and content-free** (the key and a fixed code, never the value). A bad entry is dropped, so a half-understood instance is never offered and an approval that is not exactly `allow` approves nothing. A problem in the file itself or in `[[spaces]]` refuses the start, because hosting another set of spaces than the person wrote is worse than not starting.
- The file names commands that run as this user, so its folder and the file follow 3.2.2 rule 5, and **a configuration file or folder that is a link is refused**: it would take the file out of the folder whose owner and mode are checked.
- **Reload** is not built: the file is read once per start, except that every `ttasks setup instances` write or removal, succeeded or failed, ends by setting its instances to those the file holds then (A4 3.2), and every edit reads the file again first, so the service's own writes and a hand edit made while it runs are both kept, except a save that lands in the instant between the editor's last check and its rename (`commitEdit`), which the rename replaces. The space verbs change the service's spaces themselves; the file's `[[spaces]]` is read at the next start. The planned rule: watch, reload changed sections after 500 ms of quiet, keep the last good version.
- **Editing never rewrites the file**: `editMachineToml` splices one change into the file's own text and refuses what it cannot place exactly. Its `remove` takes an `[[instance]]` element out only while it is byte for byte what `append` wrote, with the blank line `append` put beside it, so an append and its removal give the file back (`A2.3.2.4.config.edit-remove`); an element the person changed is never removed. An element appended at the end of a file without a final line break ends without one too, so that file comes back as well. A comment line right above or below the element, with no blank line between, is the person's note on it: the element counts as changed and stays with its note. A comment a blank line away is not the element's and stays where it is when the element goes. Its `set_in_element` sets one key in the one `[[spaces]]` element its selection picks (by folder): the value is replaced where the key is written, else a line is added after the element's last key, and an inline array is refused (`A2.3.2.4.config.edit-element`). An edit's changes can be worked out on the very bytes it read (`prepareEditOf`). The space verbs' records do so, and read a file saved meanwhile again and make the edit on it, up to three times. It refuses a config folder that is a link on every OS (`unsafe`), a junction on Windows included, where the reader has no owner to judge the link by.
- **The product never writes `machine.toml` on its own**, apart from the UI port the first start persists (3.8.2). Every other edit is a user-only operation that runs in the service under `service.lock`.

### 3.3 Service lifecycle

#### 3.3.5 Service commands

`ttasks service install | uninstall | start | stop | status`. Code: `packages/service/src/install/` (`commands.ts`, whose header states the rules; `entries.ts`, `render.ts`, `registry.ts`, `context.ts`). Tests: `A2.3.3.5.service-install.commands`, `A2.3.3.*.service-install.*`. Not built: `restart` (a person runs `stop`, then `start`, and every hint says so), `logs [-f]`, the Start menu shortcut and the Linux desktop entry.

- **Roots are parameters**: only `defaultServiceContext()` names the real ones, so no test enables a unit, touches linger or launchd, or writes a real Run value. On Linux a stand-in `systemd-run` comes first on every test's PATH (`packages/testkit/src/setup.ts`), so no service a test starts makes a scope in the person's user manager.
- **Preview, then apply** exactly the previewed steps, asking once (`--yes`, `--dry-run`). Each step acts only when the entry is still what the plan expects, compared just before the write (exit 4 otherwise). Not detected: a change between that read and the write, which only a same-user process can make (A6 3.15).
- **An entry is ours only when everything it makes its manager do is what install writes**, read as the manager reads it. Anything else is refused and nothing changes. Uninstall removes only what install noted in `service-entry.json`, each folder or key only when empty.
- **start** goes through the OS and succeeds only with a ready service. On Windows it starts `ttasksw.exe` through Explorer (the path quoted, because explorer.exe splits an unquoted argument at commas), or detached in an SSH session. On Linux it starts the unit, or without this install's unit runs the launcher detached (3.3.3). It never runs `ttasks serve` as a child of its own: a detached start is in a session of its own. Every probe gets only the time left of the deadline, so a timeout is never read as "no user manager" or "no Explorer".
- Refusals come before anything is read or written: root, an elevated token on Windows, package identity (3.5), an agent's shell for install, uninstall and stop (3.6.5), an unsafe umask.
- **Open:** a supervisor in its 1 to 8 s back-off is not seen. A stop or uninstall then reports "not running", and the supervisor starts the service afterwards. A fix needs `ttasksw.exe` to write its PID beside `service.json`, or a stop event the CLI can set.

### 3.10 The CLI

#### 3.10.1 Entry point

One command, `tasks`, at the stable path. **Operation verbs** are generated from A3's registry (`cli-spec.json`). **Local commands** are owned here: `service`, `serve` (hidden), `open`, `mcp`, `doctor`, `space`, `recover` (`ttasks space recover` under a second name, one line in the CLI's command table), `roots` (a pointer, below), `view`, `version`, `install --finish` (hidden), `update`, and, not built yet, `ui sessions` and `uninstall`. A4 adds `shim` (hidden), `setup t3` and `setup instances`, A3 `setup agents` and `project` (the command line's face of `organize`, A3 3.4.10), A6 `machine show` and `policy show`. Every folder argument (`--folder`, a `tasks project folder` path) is made absolute against the CLI's own working folder before it is sent, and `--here` sends that folder itself, so the service never reads a relative path. `help`, `version`, `doctor` and `serve` work without the service; everything else goes through it.

**`ttasks space`** verbs are rpc methods `space/*`, not registry entries, because a backup, restore or claim is no A1 operation. Only `space list` is open to scripts and agents. The CLI never opens a space database: create, backup and restore run in a worker of their own in the service.
- A new space goes under the install's own data folder, so a test install never writes into the daily folder. A create into a folder that holds a space says "A space is already in that folder" and names `ttasks space open <folder>`, quoted for the person's shell.
- `create`, `open`, `close`, a restore, `claim` and `recover` record what they did in `[[spaces]]` (3.1), so it holds after a restart.
- A restore in place keeps the old folder as `<slug>.replaced-*`, never removed automatically. `<backup>` is a file, or a backup's or a bundle's name as `space backups` prints it, looked up in the folders of the space named after it: the space restored in place, or for `--to` the space it is of (`--space` and the one space served too).
- **Claim.** A claim prints A6 3.5's warning. Another computer's space (`read_only: not_authority`) is not claimed where it is: the refusal says so and names the way that works now, export it, close it, restore the bundle into a new folder and claim that copy (a transfer is M3.08's). An open space has nothing to claim, and says so.
- **Recover.** `ttasks space recover <space>` and `ttasks recover <space>` are one user-only command (A1 3.18). It first checks that the folder's `space.json` names the space the entry names (`SPACE_ID_MISMATCH` otherwise). The database cannot be read before its journal is played back, so a folder without a `space.json` is checked by the open after the recovery; the replaced folder keeps the original files either way.
- **There is no `space move`.** Moving a space is a later step (6, item 12).
- Not built: `space remove` (take an entry out of `[[spaces]]`; until then the person edits the file) and `ttasks space cleanup` for crash leftovers (it needs A1's age rule and a guard against a create or restore still running). A1 owns `import` and `export`, A6 `fork`, `transfer` and `resolve`.
- Tests: `A2.3.10.cli.space`, `A2.3.10.cli.space-use`, `A2.3.10.cli.space-words`.

**`ttasks roots`** prints one line that points to `tasks project` ("Folders belong to projects now: tasks project add, tasks project folder") and changes nothing, in every form. Until M6.16 it is today's `roots [list]` and user-only `roots add` (`hub/roots.ts`).

**`ttasks view rebuild [<space>]`** is the rpc method `view/rebuild`, user-only: the space's projection reconciles every file it placed and queues every task again, removing nothing it cannot prove it wrote (A1 3.13), and answers the files checked and the tasks queued. Test: `A1.5.projection.cli`.

**Help** (`help.ts`, `A2.3.10.cli.help`). Every command has its own help, printed the same by `ttasks help <command>` and `tasks <command> --help`: what it does in one line, its forms and its flags. The local commands are one table that also names each command's subcommands. A generated verb's help comes from `cli-spec.json` alone, so a flag the contract requires is in its usage line and marked `(required)`, and the CLI names a missing one before any call (`ttasks reopen needs --reason`). `ttasks mcp --help` is the bridge's own argument error (3.7.1), so mcp's help is `ttasks help mcp`.

**Hints name only commands that exist** (`A2.3.10.cli.hints`). A test reads every string and JSX text in the code of every package a person reads text from (the CLI, the service, the bridge, the UI, launch, runs, the importer and the contracts) and fails on a `tasks <command> [<subcommand>]` the table does not have. In a command's place (after `Run: `, `run `, `with: `, a backtick or a quote) every word is checked; elsewhere a short list of English words after "tasks" is prose. A text built by concatenation is not read. A second test fails when the router takes a command the help table lacks. There is no `ttasks service restart`: a hint says `ttasks service stop`, then `ttasks service start`.

### 3.12 Packaging (D11)

#### 3.12.3 Launchers

A launcher inside a version folder runs that version, and the stable launcher runs the version `current` names. Trust assumptions: (1) the install belongs to the user, so a same-user writer that could replace `node.exe` is outside the boundary; (2) the launcher trusts its own location.

**Linux and macOS** (`POSIX_LAUNCHER` in `scripts/build/launchers.ts`, `A2.3.12.3.build.posix-launcher`): a POSIX `sh` script that applies step 3's environment rule and `exec`s Node, so a bridge stays one process. It first turns off xtrace and drops an exported `readlink` function, because bash as `/bin/sh` imports both from the caller: xtrace would print the environment into agent apps' logs, and a `readlink` function would pick the version.

**Windows: `ttasks.exe` (console) and `ttasksw.exe` (GUI)**, one C source in `packages/launcher-win/` (its README and `launcher.c` carry the details; tests `A2.3.12.3.launcher-win.*`).

1. **Mode.** Version-local when the launcher's parent folder sits in `versions` and holds `manifest.json`; `current` is never read. Otherwise stable-dispatch: a `home.marker` beside its folder makes a separate install, else the root is the fixed `share\ttasks` beside the command folder. `current` must name a plain version folder.
2. **Resolve** `runtime\node.exe` and `lib\ttasks.mjs`. No folder or file of the install below the root may be a link or junction.
3. **Environment** from the location only. `NODE_` variables (but `NODE_EXTRA_CA_CERTS`) and OpenSSL's loader variables are removed, because Node and OpenSSL read them before the entry runs and could load a DLL from outside the install. Node inherits only the standard handles.
4. **Command line:** the launcher's own tail, passed verbatim, never re-quoted and never through `cmd.exe`.
5. **`ttasks.exe`** puts Node in a kill-on-close job before Node runs. If any job step is refused, Node never runs (exit 70); the fix for a host that refuses is `CREATE_BREAKAWAY_FROM_JOB`, never Node without the job. Ctrl+C is ignored by a handler, never by `SetConsoleCtrlHandler(NULL, TRUE)`, whose flag children inherit.
6. **`ttasksw.exe`**: no console, no job, stable-dispatch only, the supervisor of 3.3.2.
7. `--package-info` prints the package identity.
8. `--port-owner <port>` (not built): `none`, `self` or `other` from `GetExtendedTcpTable` and the owners' tokens, with no admin rights, to replace `netstat` and `tasklist` in 3.8.2.
9. *(Removed. There is no `--replace`: Windows refuses to rename over a running launcher, and `fs.rename` replaces an idle one.)*
10. **Sibling repair** (`repair_sibling`, `A2.3.12.3.launcher-win.sibling`). Before anything else, a stable-dispatch launcher in a command folder named `bin` checks that its sibling (`ttasks.exe` for `ttasksw.exe`, and the other way round) is there: one file-attribute call, the only cost of a normal start. When it is missing **and an update's journal is there** (`<state>\update.json` in a plain `state` folder; only its existence is read), it puts back a copy of `<root>\versions\<v>\bin\<sibling>` for the version `current` names, then goes on as it would have.
    - **From the version folder `current` names, never from `<sibling>.new` or `<sibling>.old-<n>`:** those are files only the journal can vouch for, and checking them would need a JSON reader and SHA-256 in the program that decides what runs. The version folder adds no input, since the launcher already runs Node from it, and it is the journal's side for that launcher: the swap comes after `current` changed, and a rollback points `current` back before it restores the launchers.
    - **Only while a journal is there:** without one no update is under way, and what manages the command folder then (`install --finish` and its undo, an uninstall) writes no journal, so a repair would race it. A launcher missing without a journal (a cut-off `install --finish`, a deletion by hand) is not put back; running the installer again restores it.
    - `<state>` is the service's own: `<root>\state` in a separate install, else `%USERPROFILE%\.ttasks\state`. `versions`, the version folder, its `bin` and the file must be plain, and from the daily install's command folder `share` and `share\ttasks` too, before `current` is read. The copy is at most 16 MiB, goes to a new temporary file in the command folder (`CREATE_NEW`, no sharing), is flushed and renamed into place through its handle without replacing anything, so a sibling that appeared meanwhile is kept.
    - A failure is reported on stderr and never changes what the launcher runs. A sibling that is there but of another version is left alone: both still run, and the service's repair brings it to the journal's side. A folder or link at its name, and a version-local launcher, are left alone too.

**Path length.** Without a long-path manifest the launchers stop at `MAX_PATH`. The longest path below the root is 91 characters, so a root is at most 168 characters and install refuses a longer one. Recompute when a file name's length changes.

No `.cmd` shim: Node refuses to spawn one without a shell, and cmd.exe would re-parse agent text. No single executable: `node.exe` stays byte for byte official, signature included.

#### 3.12.4 Per-OS install

**Built:** the archives and their signing (`scripts/build/archive.ts`, `scripts/release/`), the install scripts for separate installs, and `ttasks install --finish`. The templates `scripts/install/install.sh` and `install.ps1` are rendered by `render.ts`, and their header comments are the reference for the exact order and every check. `install --finish` is `packages/cli/src/install.ts` over `packages/service/src/version/install.ts`, `switch.ts` and `candidate.ts`. Tests: `A2.3.12.4.install.*`, `A2.3.12.6.install.finish`, `A2.3.12.6.candidate.checks`, and `pnpm smoke` (`scripts/install/smoke.ts`).

The scripts make only a separate install, into a root they are given, from release files in a local folder. They write nothing outside the root and have no download code, so no test can reach the real install root, `PATH` or registry.

**Signatures before code.** The script pins the release public keys in its own text and verifies the signature of `SHA256SUMS`, the archive's hash and every file against `manifest.json` before anything from the archive runs. An unrendered template trusts nothing. The order, the same in both scripts:
1. Start clean (exported functions, and variables such as `TAR_OPTIONS` that change what the tools do).
2. Checks that need nothing from the download.
3. **The install lock**, one install per root, which the system releases however the script ends.
4. A private copy of the release files, so what is verified is what is unpacked.
5. The signature, then the archive's hash.
6. The archive's entries, before anything is unpacked.
7. Unpack into a staging folder, check it against `manifest.json`, rename it to `versions/<ver>/`. An existing folder of that version is used only when it is exactly the staged one.
8. `home.marker`. On Windows the candidate must report no package identity.
9. Hand over to the candidate's version-local launcher: `ttasks install --finish`.

The Windows script must survive Windows PowerShell 5.1 started from PowerShell 7 (a byte order mark written into a child's stdin, a missing `Get-FileHash`, the console code page): its header names each workaround.

**`ttasks install --finish`** runs the self-test (3.12.6 step 6) and only when every row passed switches `current`, the stable command and `install.json` under `<state>/update.lock`, after repairing an interrupted update, because a switch under a journal would let a later repair undo the install. From the switch on it is all or nothing. It prints `ttasks service install` and never runs it.
- It places the stable launchers with two renames and no keeper (3.12.6 step 10), because its undo renames the old launcher back.
- A launcher's sibling repair runs during a finish only when a stuck update's journal is there (3.12.3 step 10). For that case the finish notes which stable launchers were there before the switch: one there afterwards that was not is this install's, recorded in `created` and given its undo before anything about it is hashed or can fail. The undo puts `current` back first, so a launcher started while it runs repairs from the version `current` named before, or with none repairs nothing, and never brings back a launcher the undo removes.
- **The race left open:** with a stuck update's journal during a finish that then fails, a sibling repair that read `current` before the undo removed it can still put its copy in after the undo. The leftover is one launcher in the failed install's command folder, which the next install run takes as its own. Closing it needs a lock that the C launcher shares with Node's `update.lock`.

**A failed run removes only what it made.** Once the root has a `current`, only the download and staging folders go: an update may already use a version folder this run placed.

**The root** is absolute, at most 168 long (3.12.3) and not a link. **Every folder the install runs code from or writes to is the user's and changeable by no one else, and no folder on the way to it lets anyone else rename it away**, because an account with delete-child above could swap the root after the checks. On Linux "no one else" is 3.2.2 rule 5's: the person's own private group may write, a sticky folder above the root (`/tmp`) may be open to all, and a folder above the root may be root's. The script asks for the account's primary group only when a folder's group may write it, each question within 5 s and killed a second later (`timeout -k 1 5`). Each refusal names the folder, and its group when the group's write is the reason, and gives the `chmod` that fixes it for a folder of the person's own; for a folder of root's or another user's it says to choose a root among the person's own folders. `%TEMP%` and `%LOCALAPPDATA%` can grant other accounts change rights (an agent app's sandbox group), so tests use roots under `%USERPROFILE%\.ttasks-test\`.

**The release keys.** `RELEASE_PUBLIC_KEYS` in `packages/service/src/version/release-keys.ts` is the one value, a placeholder until the release key exists, which a release render and `pnpm release sign` refuse. A test build pins a throwaway key and says so, and no test-signed install script can be released.

**The daily install** (not built, M1.15) uses the default roots: the program in `~/.local/share/ttasks` (`%USERPROFILE%\.local\share\ttasks`) and the command in `~/.local/bin` (3.2.1). `install --finish` writes the link `tasks` → `../share/ttasks/current/bin/ttasks` on Linux and macOS, and both stable launchers on Windows (through 3.12.6's staged swap when they exist). Then:
- Linux and macOS: warn if `~/.local/bin` is not on `PATH`. Shell profiles are never edited.
- Windows: add `%USERPROFILE%\.local\bin` to the **user** `Path`.
- Offer `ttasks service install`.
- **The download** comes with the first hosted release (M10): `curl -fsSL <release-base>/install-<ver>.sh | sh` (or a `latest` alias to a versioned script) and `irm <release-base>/install-<ver>.ps1 | iex`, fetching the archive, `SHA256SUMS`, `.sig` and `.sshsig` into the private download folder.
- A per-user graphical installer and winget and Scoop manifests come later.

**macOS** (not built): as Linux, once `install.sh` handles it (`mv -h`, `shasum`, `stat`). `ssh-keygen -Y verify` is built in, `curl` adds no quarantine attribute, and Gatekeeper sees only Node's binary, whose Developer ID signature CI checks.

**Trust.** A first install trusts the versioned install script fetched over HTTPS, whose SHA-256 is in the release notes and the README and which pins the keys. Later updates trust the keys of the installed version, never the network or the candidate. The candidate's self-test is a functional check after authenticity is settled.

**Uninstall** (not built). `ttasks uninstall` first plans the service entry's removal (3.3.5), then lists the autostart entry, desktop entry or shortcut, `PATH` entry, stable command and what `install.json`'s `created` lists, and asks once. It removes nothing else from the install root, and never anything in the data folder or a space. Whether it leaves `install.json` and `update.lock` in `<state>` or moves them is decided when it is built. With agent integrations it asks for `ttasks setup --uninstall` (A3) first. When it finds an update's journal (a stuck update), it removes `current` before the stable launchers, or a launcher started in between puts its removed sibling back (3.12.3 step 10).

#### 3.12.6 `ttasks update`

**Built:** `ttasks update --from <archive> | --rollback | --repair [--yes]` from a local release archive, tested on separate installs, with the staged Windows launcher swap (steps 8, 10 and 14) and the launchers' sibling repair (3.12.3 step 10). Not built: the hosted channel (`--channel`, `--version`, steps 3 and 4: M10) and retiring old versions (step 14).

Code: `packages/service/src/version/` (`update.ts`, whose header gives the order; `release.ts`, `archive.ts`, `journal.ts`, `repair.ts`, and `switch.ts`, which `install --finish` shares), `packages/cli/src/update.ts`. The build imports the platform names, key parser, signature check and archive readers from there, so the build writes what the updater reads. Tests: `A2.3.12.6.update.verify`, `.switch`, `.lock`, `.repair`, `.kill`, `.installed`, `.stage` (the swap in-process, a running copy of a system program for the refusals on Windows) and `.launchers` (the Verify line of M6.13: real builds whose launchers differ, each launcher killed staged, aside and placed while both run, then started through the stable command and through the supervisor).

On Linux and macOS no launcher is swapped: the stable command is a link to `current/bin/ttasks` that no update replaces, and a journal lists no launcher there. The swap and the clean-up run on fixture files on every system.

1. Only the install's own command runs it, so an installed version vouches for its successor. Never an agent's shell, because it restarts the service.
2. **`update.lock`** for the whole update. A second update waits, then repairs what the first left. `install --finish` does not wait.
3. *(M10)* Fetch and verify the channel manifest and pick the version.
4. **Verify** with the installed keys before anything of the archive is unpacked, loaded or run, hashing the same bytes it unpacks. *(M10: the download into `<cache>/updates/<ver>/`, with size, hash and signature.)*
5. **Unpack** into a staging folder that the journal names before it exists, and reuse an equal version folder as in 3.12.4 step 7.
6. **Self-test** through the candidate's version-local launcher: `integrity`, `runtime` and the candidate rows of `version/candidate.ts`. They use the library, not a service start, because the service refuses an elevated token (CI's Windows runners) and the old service still runs.
7. **Ask** once before restarting a running service (3.11).
8. **Journal** each stable launcher the switch changes, with its old and new SHA-256. Then, on Windows, **stage** each changed launcher as `bin\<name>.new`, hashed while it is copied (so what is written is what was checked) and flushed. All of it happens before `current` changes, so the window after the switch is two renames per launcher, and a staging failure is a failure before the switch: the staged copies and the journal go, `current` stays.
9. **Switch `current`.**
10. **Swap the Windows launchers one at a time**, `ttasks.exe` first (`placeLauncher` in `switch.ts`):
    - **One rename** replaces the launcher when Windows allows it: it does not run, and a version folder holds a copy of it (the update passes the old version's folder, a repair both versions'), so nothing later needs the file the rename destroys. The stable path is then never missing.
    - **Otherwise two renames:** Windows refuses to rename over a running launcher but lets it be renamed, so the old one goes aside to `.old-<n>` and the new one is renamed in. Only between the two is the path missing. While `ttasks update` runs, `bin\ttasks.exe` runs (it started the updater), so it always takes two renames, and `ttasksw.exe` does while the service runs under it. A kill between them leaves no `ttasks` command until the supervisor's next start (at sign-in, whose sibling repair puts it back first), a running service's 10 s repair, or `versions\<v>\bin\ttasks.exe update --repair`; the renames are microseconds apart.
    - **Decided by hashes, not journalled per rename:** a launcher already at the wanted SHA-256 counts as swapped, and a rename that fails while the path now holds the wanted hash (a sibling repair got there first) counts as done. So every swap and repair is safe to run again and against a sibling repair racing it.
    - A staged or aside copy is renamed into place rather than copied. Going forward a repair takes the staged copy first; going back it prefers the aside copy, because it is the old file itself, so a supervisor that still runs from it is the file at `bin\ttasksw.exe` again.
    - The aside copy is never a hard link: Windows allows deleting a running program through one of several links, so the clean-up could no longer tell whether it runs.
11. **Restart** through the OS (3.3.5), only a service that ran when the update began or runs now.
12. Wait for a ready service naming the new version, record the outcome in `install.json`, remove the journal.
13. **Rollback** on failure, through the repair, back to the old version and the old service.
14. **Clean-up of the command folder** (`cleanLaunchers`). With `update.lock` held and no journal, the stable launchers' own `.old-<n>`, `.new` and swap or repair temporary files are deleted, and nothing else in `bin`. Windows refuses to delete an aside launcher that still runs, and the refusal leaves it for a later pass. One with another hard link is kept, because then a delete would succeed while it runs.

    **Garbage collection** (not built). Today the updater never removes a version folder. The step that retires versions keeps `current`, its two predecessors and every version a journal names, under `update.lock`:
    - A delete or rename never proves a version unused: on Windows a running version's folder and `node.exe` can be renamed, a refused delete has other causes, a success says nothing about the next instant, and a probe delete can leave a version half deleted. The same holds for process checks on Linux and macOS.
    - Retiring a version needs exclusion against its users and new launches through version-use leases held for a version's life. Without exclusion the version stays.
    - Retirement is journalled. The version moves into a non-launchable garbage folder before any file is deleted. An interrupted deletion keeps its record and is retried. A partly deleted folder is never installed or a rollback candidate.

**The journal and repair** (`journal.ts`, `repair.ts`, whose headers state the rules). A journal found by the holder of `update.lock` belongs to an update that is gone, because the updater holds the lock throughout and the OS releases it on any exit. The journal's `pid` is never trusted, because PIDs are reused. Repair decides from the disk, not from the phase, so it is right for a journal cut off anywhere, and it never goes back to an old version that is gone or damaged. A half-replaced command folder is reconciled the same way, launcher by launcher, by SHA-256, and the staged copies of the journal's launchers go before the journal. The service repairs at start and every 10 s when the lock is free.

**A replaced supervisor.** After a repair that may have replaced `ttasksw.exe` (`supervisorReplaced` in `repair.ts`: a journal that names it, or on Windows any unreadable journal, which cannot say which launchers its update changed), a service that runs under `ttasksw` exits 75 (`update.restart`, `why: supervisor`), so the supervisor still running from the old file hands over at once (3.3.2). When the supervisor already is the new file, that is one restart more than needed, once. `ttasks update --repair` and an update's own repair bring the service back as a supervisor change on the same rule.

**`--rollback`** goes to the previous version, self-tested first. A space the newer version migrated opens as `unavailable(format_too_new)`, and doctor names A1's pre-migration backup.

**A person's data is never touched.** The updater writes only `versions/`, `current`, `bin/`, and in `<state>` its lock, journal, `install.json` and the self-test's folders.

**A damaged version folder** is recovered by hand: move it out of `versions` and reinstall. Doctor's `integrity` row reports it. `ttasks update --repair` may move it aside only under lease exclusion (not built).

### 3.14 Resource budgets

On Windows and Linux with two spaces at A1's design scale (5,000 open and 50,000 done tasks each) and up to 10 agent sessions. A1 owns the shared numbers.

| Budget | Target | If missed |
|---|---|---|
| Service idle memory | RSS ≤ 120 MB with two spaces | Over 200 MB: heap profile, A1 reviews cache sizes |
| Service idle CPU | ≤ 5 s per hour, no idle timer under 10 s | Remove the wake-ups |
| Start to `ready` | Warm ≤ 1 s Linux, ≤ 2 s Windows. Cold ≤ 3 s and ≤ 6 s | Profile loading, lazier chunks |
| Space open | ≤ 300 ms, migrations excluded | A1 reviews |
| CLI call (`ttasks show`) | Warm p95 ≤ 250 ms Linux, ≤ 400 ms Windows | Compile cache, lazy imports |
| Bridge | 3.7.7 | 3.7.7 |
| UI first paint after `ttasks open` | ≤ 1.5 s | A5 and this appendix review the bootstrap |
| Install size | About 45 MB compressed, 130 MB per version | Over 250 MB: review assets |

**The local endpoint's memory** is bounded in time, not size: a connection's waiting output can reach about 528 MiB (64 replies of 8 MiB plus 16 MiB of lines) for at most 30 s after the peer last read. The peers are same-user processes, so the bounds guard against broken clients. Lower it through the in-flight and line limits or A3's per-operation limits. A service-wide cap belongs to the hub.
