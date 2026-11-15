# A2. The service, process model and packaging

Appendix of the TT Tasks plan. It owns the process model, the service lifecycle per OS, machine-local locations, the local transports and their security, the bridge, the CLI conventions, opening the UI, packaging, install and update, diagnostics and resource budgets.

Other appendices own the rest, and 3.15 lists what this one assumes from them. **A1**: the space folder, schema, storage adapter, migrations and backups. **A3**: the operation registry, the MCP tools, principals and binding. **A4**: launches, the shim (`tasks shim`), process scopes and runs. **A5**: the UI. **A6**: linked machines and the threat model. **A7**: milestones and the lab.

**Names.** The product is TT Tasks, by TumbleToad, called Tasks inside the app. Its identifier is `tasks` everywhere: the command, the `TASKS_` environment prefix, file and protocol names. Every name comes from `packages/brand`. In message texts below, `<Product>` is the brand's display name.

---

## 1. Summary

1. **One service per OS user per state folder.** `tasks serve` hosts every registered space, each with its own storage worker and writer lock. Each UI tab shows one space. Bridges, shims and CLI calls stay pinned to the space they bound to. An **install ID** from the state path keeps a test install's endpoint, runtime folder and registrations apart from the daily install's.
2. **The OS starts the service:** a systemd user unit, an HKCU Run value that starts the `tasksw.exe` supervisor, a LaunchAgent. Bridges and CLI verbs never start it.
3. **Data and program live apart.** Data and configuration live in `~/.tasks`, the program in `~/.local/share/tasks`, both outside the AppData that MSIX virtualises. Removing the program never removes data. The service refuses package identity. Locks guarantee one writer.
4. **Agents and the CLI use a user-only socket or named pipe** speaking `tasks-local/1`, with a mutual HMAC handshake. The client sends its context only after it has verified the service. No TCP for agents.
5. **The browser UI uses HTTP and WebSocket on 127.0.0.1** with a bearer token in a header, strict Host and Origin checks, no CORS, a nonce CSP and a one-time code from `tasks open`. **v1 assumes a single-user machine.** An authenticated UI origin gates the public release (M10).
6. **The bridge is a thin stdio-to-socket forwarder.** The service speaks MCP. Online or offline, every connection lists the same tools.
7. **Packaging bundles the official, unmodified Node 26 binary** behind a stable launcher (a POSIX script, or a C launcher on Windows). A launcher inside a version folder runs that version.
8. **Per-user install with no admin rights:** versioned folders, a signature check before any downloaded code runs, a self-test before switch-over, a journalled update with repair and rollback, and no killed sessions.

---

## 2. Decisions

The IDs are stable. Gaps are rows that the sections now carry alone.

| # | Decision | Choice |
|---|---|---|
| S1 | Service count | One service per OS user per state folder, hosting all registered spaces |
| S4 | Windows start | HKCU `Run` value pointing at `tasksw.exe`, which supervises `tasks serve`. Not Task Scheduler (3.3.2) |
| S5 | macOS start | LaunchAgent running the `tasks-launchd` wrapper, `KeepAlive.SuccessfulExit = false`, `AbandonProcessGroup = true` |
| S6 | Who starts the service | The OS start entry, `tasks service start` and `tasks open`. Never a bridge or a CLI verb, because an agent-side start from a packaged parent could make a second service |
| S7 | Windows paths | `%USERPROFILE%\.tasks\` and `%USERPROFILE%\.local\share\tasks\`. Never `%APPDATA%`, `%LOCALAPPDATA%` or `%TEMP%`, which MSIX virtualises |
| S8 | Packaged context | `tasks serve` exits 64 with package identity. No package is assumed safe |
| S9 | Single instance | `service.lock` held by an exclusive SQLite transaction, plus a writer lock per space. The OS releases both on any exit |
| S10 | Local transport | Unix socket in a 0700 folder, or a named pipe with a per-start name, then mutual HMAC proofs with `ipc.key` and an authenticated bind. Node cannot read peer credentials or set a pipe DACL |
| S12 | Bridge | Thin forwarder. The service hosts the MCP server. The bridge answers offline with the same tool list |
| S13 | Native forwarder | Rust, built only if 3.7.7 reaches rule 3 (steps F1 to F4) |
| S15 | UI credential | Bearer token in `Authorization`, kept in `localStorage` of the exact origin, never a cookie (cookies are shared across ports). Expires 7 days after its last use, 30 days after creation at most |
| S16 | UI bootstrap | A 60-second single-use code minted over the socket, handed only to an HTTP listener proven by HMAC, in the URL fragment |
| S17 | Code leak to other users | Linux: every HTTP connection must come from a socket of the service's UID. macOS: redemption needs an `lsof` record of the client's own socket with that UID |
| S18 | Port | 7713, else the first free port of 7713–7733, persisted. This user's own process on it gives a temporary port. Another OS user on it, now or seen before, means no UI and every UI token revoked |
| S19 | Runtime | Official Node 26.13.1, pinned, unmodified, signature- and checksum-verified. SQLite 3.54.1 with FTS5 |
| S21 | Stable command | `~/.local/bin` on every OS: a symlink to `current`'s launcher on Linux and macOS, both stable launchers on Windows. A separate install keeps its command in `<root>/bin`. No `.cmd` shim |
| S22 | Install | Per-user archive plus install script into `~/.local/share/tasks`, with no admin rights. Built so far: separate installs from local release files (3.12.4) |
| S27 | Logs and crashes | Local and content-free. Node reports exclude the environment |
| S28 | Test installs | `TASKS_HOME` gives a separate install with its own install ID, so its service, runtime folder, socket, pipe, launch folders, port and registrations differ from the daily install's |
| S30 | Install ID | 10 characters (50 bits) of SHA-256 over the canonical state path |
| S31 | First-install trust | The install script pins the release key and verifies with a verifier the OS already has before anything from the archive runs. No verifier: it stops |

---

## 3. Specification

### 3.1 Process model

| Process | Started by | Lifetime | Talks to |
|---|---|---|---|
| `tasks serve` (the service) | The OS start entry, or `tasks service start` / `tasks open` through the OS | Login session, or boot with linger | Owns spaces. Serves the socket or pipe and HTTP |
| `tasksw.exe` (Windows) | Explorer | As long as the service | Supervises `tasks serve` |
| `tasks mcp` (bridge) | The agent app, one per session | The agent session | stdio to the agent, socket to the service |
| `tasks <verb>` (CLI) | A person, a script or an agent shell | One call | Socket |
| `tasks shim` (A4) | A terminal or unit the service started | The launched agent | Socket |
| Browser tab or web app | `tasks open` or the user | Any | HTTP and WebSocket |

**Threads.** The **hub** runs transports, the handshake, credentials, MCP, routing, the feed and A4's run supervision, and holds no SQLite connection. Each space has its own **storage worker**, and `service.sqlite` has its own. Launched terminals and runs live in their own systemd scopes or detached processes (A4).

**Worker restart** (not built). A space worker that crashes or does not answer a 1 s health ping for 10 s is terminated and restarted with backoff (1, 2, 4, 8, 30 s). Requests in flight get `space_unavailable` with reason `restarting`, retryable with the same request ID.

**Spaces** (`packages/service/src/hub/spaces.ts`, whose header gives the start-up order and how each storage refusal maps to a state; `hub/space-settings.ts`; tests `A2.3.1.hub.startup`, `A2.3.2.4.hub.spaces`, `A2.3.2.4.hub.space-id`).
- The service hosts the enabled `[[spaces]]` of `machine.toml` plus those the space verbs add. One failing space never stops the service, and every wait is bounded.
- A space is `opening`, `open`, `read_only(reason)`, `unavailable(reason)`, `closing` or `closed`. Status names the reason, never the log.
- **A failed migration** is served read-only at the old revision. Nothing in the migration path lists, reuses, renames or removes a backup, because each way of bounding the copies by reuse or removal could leave a migration without one. So the attempts are bounded instead: a failure is recorded per build and database state, and the same build on the same state tries again only when the person asks (`tasks space open --retry-migration`). Tests `A2.3.1.hub.failed-migration`, `A2.3.1.hub.migration-timeout`.
- **Default space.** `[service] default_space` decides only what a new tab and an unbound call of the person use (3.10.5). Only the person changes it (Make default, `tasks space use`, through `hub/default-space.ts`). A default that is set but not served is `space_unavailable`, never another space. Test `A2.3.1.default-space`.
- **Pinning.** A bridge or shim binds to one space for its whole life, across restarts. When that space becomes unavailable its calls return `space_unavailable` and never retarget.

### 3.2 Machine-local locations

Code: `packages/service/src/hub/paths.ts` (`resolveLayout`, pure over host facts so every OS's layout is tested on every OS; its header states the rules), `hub/files.ts`. Tests: `A2.3.2.hub.paths`, `A2.3.2.hub.install-id`.

#### 3.2.1 Directories per OS

| Purpose | Linux and macOS | Windows |
|---|---|---|
| Install root (`<root>`) | `~/.local/share/tasks/` | `%USERPROFILE%\.local\share\tasks\` |
| Command folder | `~/.local/bin/tasks` (symlink) | `%USERPROFILE%\.local\bin\tasks.exe`, `tasksw.exe` |
| Data folder, with `config/`, `state/`, `cache/`, `spaces/` | `~/.tasks/` | `%USERPROFILE%\.tasks\` |
| Socket and launch folders | Linux: `/run/user/<uid>/tasks-<install-id>/` and its `launch/`, else as macOS. macOS: `<state>/run/` and `<state>/launch/` | Pipe `\\.\pipe\tasks-<install-id>-<instance>`, `<state>\launch\` |

- The Linux runtime folder comes from the UID, never from `XDG_RUNTIME_DIR`, because an agent app may start the bridge without that variable. It is used only when `/run/user/<uid>` is a private folder of this user (not on WSL). A socket path over 100 bytes is refused.
- A clean stop removes the runtime folder only when empty and only while this start still owns the install (3.3.1). A folder that holds a launch the next start still needs stays (`A2.3.2.1.hub.runtime-folder`).
- A `TASKS_HOME` install keeps program, command and data under its one root.
- **Removing the program never removes data.** Uninstall and update touch the install root and the command only.
- **No code deletes a person's data or a backup as a side effect of another operation.** It reuses what exists, retires and keeps what it replaces, and reports where that is. Removal outside a stated retention policy is the person's explicit act. `tasks service install` then `uninstall` leaves the data folder exactly as it was. The migration path (3.1) and the updater (3.12.6) follow the same rule.

**Install ID** (S30): 10 characters of A1's ID alphabet from SHA-256 over `tasks-install` and the canonical `<state>` path. It names the runtime folder, socket, pipe, launch folders and a separate install's service entries, so a test install never meets the daily one. A test holds a golden value.

#### 3.2.2 Rules

1. **Home comes from the account**, not `HOME`, because a snap or Flatpak parent sets `HOME` to a private folder. Windows uses `%USERPROFILE%`.
2. **`XDG_*` variables are never read.** A systemd unit and an agent shell often disagree on them. Clients read the socket path from `service.json`.
3. **Separate installs.** `TASKS_HOME` holds a whole install and must be absolute. The launchers set it from `home.marker` (3.12.3), so a service entry needs no argument. A separate install's service entries carry its install ID, never a folder name (`tasks-<id>.service`, `TT Tasks (<id>)`, `local.tasks.service.<id>`); the daily install's names are plain, so they survive a renamed home folder.
4. **Windows never uses AppData or `%TEMP%`** for anything another process of the product must see (3.5). A lint rule bans `os.tmpdir()` and AppData paths in product code.
5. **Permissions.**
   - **Exact modes, whatever the umask** (Linux and macOS). A umask differs per system, so a mode passed to `open` or `mkdir` alone is never trusted: the mode is set on the new object through a descriptor, and what already exists keeps its mode. One implementation, `packages/files` (a package of its own because launch and the shim may import neither the service nor storage), re-exported by `hub/files.ts`. Storage keeps the same rule in its own `files.ts`. Folders are 0700 and files 0600, the two lock files 0644, a version folder 0755.
   - **The socket file's mode is not set**: Node cannot set it through a descriptor, and a `chmod` by path could follow a link put there in between. Its folder keeps other users out.
   - **Who else can write** (`hub/permissions.ts`, whose header states the rule). A file or folder the product trusts must belong to this user, and neither its group nor others may write it, whatever the group, because whether a group has other members cannot be known reliably. The service refuses an unsafe state folder at start (exit 64) and names one command that fixes it, quoted by the rule for lines to paste (A3 3.13.7). A path with a control character other than a newline, or a command longer than a line to paste can be, gets no command, and the message says why. A command that changes an owner is never given for a path that is or passes through a link. Agent homes follow setup's own rule (A3 3.13).
   - **A umask that clears an owner bit** is refused (`hub/umask.ts`). The umask is only read, never set, because the service's agents must inherit the person's own, and `process.umask()` is banned: its read sets the mask to 0 for a moment, in which a worker thread's new file gets every bit.
   - Tests that make a state or config folder give it an explicit mode, as the product does; the Linux CI job runs `pnpm verify` under umask 002. Tests: `A2.3.2.2.permissions.umask`, `.create`, `.rule`, `.repair`.
   - **Windows** (not built): folders under `%USERPROFILE%` inherit the profile ACL. The service does not read ACLs at start (a PowerShell start costs over a second). Doctor fails when another non-admin principal has access.
   - `<state>\secrets\` (A6 3.16.4, not built): inheritance disabled, only the user. The service sets it on creation, and doctor fails otherwise.
   - A custom install root that another account could change or rename away is refused before any candidate code runs from it (3.12.4).
   - **Reading a Windows ACL** (not built): by SID, never from `icacls` output (names are localised), with the owner (an owner can rewrite the DACL). Run `powershell.exe -NoProfile -NonInteractive -NoLogo` with an environment built from scratch and the paths passed as environment values, so no path becomes code, and call only `GetAccessControl` with `GetSecurityDescriptorSddlForm('Owner, Access')`, no cmdlet, so an inherited `PSModulePath` cannot break it. Parse the SDDL in TypeScript: unknown aliases and ACE types are never trusted, and a null DACL counts as Everyone. A check that cannot run fails with `cannot_inspect_permissions` (exit 71), never `unsafe_permissions`.
   - **Making a Windows folder or key user-only** (not built): `icacls /inheritance:r /grant:r *<SID>`, then remove every other explicit allow entry. Node's `mode` argument never makes anything owner-only on Windows. Inheritance alone is not private: a new object can get the token's default DACL as explicit entries, and `%TEMP%` and `%LOCALAPPDATA%` can grant other groups (an agent app's sandbox group). Administrators as owner, as on an elevated runner, is accepted.
6. **Synced and network folders** (A1 3.2 owns the signals; `hub/sync-folders.ts`, whose header lists every check, and `hub/sync-host.ts`). The service checks a space's folder and every folder above it, as given and as its real path, at every open. A network file system is never written. A synced folder is read-only until the person confirms it is excluded (`tasks space open <folder> --excluded`), per machine and per real path. **A check that cannot see never makes a space writable**: an unreadable fact leaves the folder unchecked, which counts as synced. The way out is a backup restored into a new local folder and claimed, which `tasks space` prints (`A1.5.sync.way-out`). There is no `space move` (6, item 12).

#### 3.2.3 Files in `<state>`

| File | Content |
|---|---|
| `service.lock` | Held while the service runs (3.4), never deleted |
| `service.json` | The running service's record, through which clients discover it |
| `ipc.key` | 32 random bytes as base64url, for the handshake and the HTTP probe |
| `service.sqlite` | `grants` (3.2.5), port-holder sightings (3.8.2), later update state and A6's rows |
| `execution.sqlite` | From L1: A6's execution journal behind A4's `ExecutionStore` |
| `ui-state.sqlite` | Seen and digest cursors (A5 3.14) |
| `machine.json` | Machine ID, name, creation time, later A6's fingerprint and keys |
| `secrets/` | Private machine keys (A6 3.16.4) |
| `spaces/<space_id>.json` | Machine-local settings of a space: backup folder, synced-folder confirmation, failed migrations |
| `sessions.json` | A3's session records and binding handles (3.7.5) |
| `setup/` | A3's setup record and lock (A3 3.13.1) |
| `t3/` | A4's T3 pairing, answers and launch plans, written only by the service |
| `env-snapshot.json` | A4's login-shell environment snapshot |
| `service-entry.json` | What `tasks service install` created (3.3.5) |
| `instances.json` | The `[[instance]]` entries `tasks setup instances` wrote, so its removal takes back only those (A4 3.2). Written only by the service |
| `install.json` | The install record: method, channel, root, install ID, versions, `previous`, `last_update`, and what the installer `created`, so an uninstall removes only that |
| `update.lock`, `update.json` | The update lock, which also covers `install --finish`, and the update journal (3.12.6) |
| `workdirs/`, `logs/`, `crash/`, `tmp/` | A4's work folders, 3.13 |

- **A damaged `machine.json`** is refused, never regenerated: a new machine ID would turn the spaces into read-only copies.
- Clients read `ipc.key` per connection, so `tasks service rotate-key` (a new key and a restart; not built) needs nothing more.

#### 3.2.4 `machine.toml`

One machine-local file, `<config>/machine.toml`, never synced or exported. This appendix owns `[service]`, `[http]`, `[ui]`, `[updates]`, `[log]` and `[[spaces]]`. A4 owns `[terminal]`, `[[instance]]`, `[[custom_target]]`, `[approvals]`, `[override.*]` and the run caps. A1 and A4 own `[roots]`. A3 owns `[setup]` (3.12). A6 owns `[remote]` and `[security]`. Code: `packages/service/src/config/` (`machine-toml.ts`, whose header states the rules; `toml.ts`, `edit.ts`). Tests: `A2.3.2.4.config.golden`, `.edit`, `A2.3.13.cli.doctor` (`doctor-config.test.ts`).

- The keys of this appendix: `[service] default_space`; `[http] port`; `[ui] open_mode` (`tab` or `app`); `[updates] channel`, `check`, `auto` (`auto = true` installs only while no run or launched session is active); `[log] level`; `[[spaces]]` with `id`, `path` and `enabled`.
- **Reading is strict and content-free** (the key and a fixed code, never the value). A bad entry is dropped, so a half-understood instance is never offered and an approval that is not exactly `allow` approves nothing. A problem in the file itself or in `[[spaces]]` refuses the start, because hosting another set of spaces than the person wrote is worse than not starting.
- The file names commands that run as this user, so its folder and the file follow 3.2.2 rule 5, and **a configuration file or folder that is a link is refused**: it would take the file out of the folder whose owner and mode are checked.
- **Reload** is not built: the file is read once per start, except that `tasks roots add` replaces the service's roots at once, and every `tasks setup instances` write or removal, succeeded or failed, ends by setting its instances to those the file holds then (A4 3.2). The planned rule: watch, reload changed sections after 500 ms of quiet, keep the last good version.
- **Editing never rewrites the file**: `editMachineToml` splices one change into the file's own text and refuses what it cannot place exactly. Its `remove` takes an `[[instance]]` element out only while it is byte for byte what `append` wrote, with the blank line `append` put beside it, so an append and its removal give the file back (`A2.3.2.4.config.edit-remove`); an element the person changed is never removed.
- **The product never writes `machine.toml` on its own**, apart from the UI port the first start persists (3.8.2). Every other edit is a user-only operation that runs in the service under `service.lock`.

#### 3.2.5 The `grants` table

One table in `service.sqlite` for every credential and registration on this machine: `ui` (a browser session), `agent_home` (A3's registration grant), later `device` (A6, from L1). A3 and A6 use it instead of their own tables. Code: `packages/service/src/http/grants.ts` (whose header states the rules), `http/service-db.ts`, `local/grants.ts`. Tests: `A2.3.6.local.grants`, `A2.3.8.http.tokens`.

- Only a token's SHA-256 is kept, and a token reaches a browser only after its row is on disk.
- A revocation takes effect at once and closes every connection tied to the row. A row is tied to a connection in the same synchronous step that checks it, so no revocation falls in between.
- An `agent_home` row has no token and no expiry. `tasks setup agents` (A3 3.13) keeps one per app and home through `setup/home_grant` and `setup/home_revoke` (`hub/agent-homes.ts`), made before the home is changed, and one home per instance. A3's grant gate reads the rows at every agent home's call (A3 3.7.8).
- An `agent_home` row ties no connection: its revocation refuses the home's next call instead, so the agent hears `forbidden` with `rule: "grant"` rather than a closed connection and failed rebinds.

### 3.3 Service lifecycle

#### 3.3.1 States and exit codes

`starting → binding → ready → draining → stopped`. Code: `packages/service/src/hub/service.ts` (its header walks the states), `serve.ts`, `exit.ts`, `identity.ts`. Tests: `A2.3.3.hub.exit-codes`, `A2.3.3.hub.refusals`, `A2.3.1.hub.startup`.

1. **starting.** Refusals (root, elevation, package identity, unsafe umask or folders, invalid configuration) exit 64 before anything is written, so a service manager does not restart into them. A second start finds `service.lock` held, exits 73 and touches nothing of the running service's, not even the log.
2. **binding.** Repair an interrupted update (3.12.6), listen on the socket or pipe, bind HTTP or record that the UI is blocked (3.8.2), write the MCP offline cache (3.7.3).
3. **ready.** Then each space's start-up runs (3.1). A space still opening answers `space_unavailable` with reason `opening`.
4. **draining.** Bounded, and always ending with its exit code. `service.lock` is released last. Every step that touches a path another start of the install would use (`service.json`, the socket, the runtime folder) first asks `stillOwned()` with nothing awaited in between, or a start that took over during the drain loses its socket or runtime folder (`A2.3.4.hub.drain-ownership`).

**Elevation on Windows** is read from the process token through the `whoami.exe` of the System32 the loader mapped `ntdll.dll` from, never from `SystemRoot` or `windir`, which a parent sets.

**Exit codes** (`hub/exit.ts`) are a contract with the three service managers (the systemd unit of `install/render.ts`, `tasksw.exe`, `tasks-launchd`), which map exactly these numbers: 0 clean stop, 64 refused, 70 crash or a lock lost (restart with backoff), 73 another service holds the lock, 75 restart requested (start again at once, re-reading `current`; also after a repair that may have replaced `tasksw.exe`, 3.12.6). Too many quick 75 restarts count as failures, so a service that always asks for a restart cannot loop.

#### 3.3.2 Windows: HKCU Run and `tasksw.exe`

**Why a Run value.** A Task Scheduler logon task often needs elevation, stops after 72 hours and on battery by default, and is hidden from the user. A Run value needs no admin rights, has no limits and is listed in Task Manager's Startup apps. `tasksw.exe` adds the restart after a crash. A Startup-folder shortcut is the fallback if a policy blocks Run values (built only if needed).

- The Run value holds one quoted path to `tasksw.exe`. When the user turned it off in Task Manager, status reports it, and install never turns it back on. Windows delays startup apps after sign-in, and bridges answer offline until the service is ready.
- **Registry access** (`install/registry.ts`, `A2.3.3.2.service-install.reg-export`) reads through `reg export`, never `reg query`, which prints through the console code page and alters non-ASCII paths. An unreadable value is never taken for an absent one.
- **`tasksw.exe`** (`launcher.c`, `A2.3.3.2.launcher-win.supervisor`) supervises only as a stable launcher: inside a version folder it would pin the service to that version. It makes no job, so processes the service starts detached (A4 runs) outlive both, and it is started through Explorer, whose job allows breakaway: a kill-on-close job would take it down. Its give-up record in `<state>\crash\` holds times and exit codes only. Limit: a same-user process that swaps `state` for a junction between the folder check and the write can redirect the record; trust assumption 1 (3.12.3) excludes that writer.
- **The hand-over** (`A2.3.3.2.launcher-win.handover`). An update or a repair renames a running `tasksw.exe` aside and puts the new one in its place while the old process goes on supervising, and the service cannot stop the process that supervises it. So `tasksw.exe` notes its own file's identity (volume and file index) when it starts supervising, and before every restart of the service (at once after a 75, after the wait after any other exit or a failed start), when `bin\tasksw.exe` is now another plain file, it starts that one with no arguments and no inherited handle and exits 0; the new one cleans its environment and finds its install as every launcher does. A start that fails is reported, and it goes on supervising and tries again before the next restart. The check is on every restart, not only on 75, because the repair removes the journal before the service exits 75 (3.12.6): a service that died in between, or an update that ran while the supervisor waited to restart a failed service, would otherwise leave the old supervisor until the next sign-in. A service exit 0 followed by a start through Explorer instead would race the new supervisor's service against the old one's `service.lock`. Limit: the identity is read when supervision starts, so an update that replaced the file in the milliseconds before leaves that supervisor on the old file, still supervising correctly, until the next sign-in.

#### 3.3.3 Linux: systemd user unit

`~/.config/systemd/user/tasks.service`, rendered by `install/render.ts` (golden units in `packages/service/test/golden/install/`, `A2.3.3.service-install.golden`).
- No `ProtectHome`, `PrivateTmp` or `NoNewPrivileges`: launched agents need the user's full home and tools.
- `KillMode=mixed` stops the service first and the rest of its cgroup later. Launched terminals and runs live in their own scopes (A4).
- Install runs `enable` and then a start, not `enable --now`, so a service already started by hand is not joined by a second one.
- Nothing enables linger. Status shows its state and the command to change it.
- Without a user manager (some WSL setups, containers) install refuses and writes nothing, and `tasks service start` runs the launcher detached (`manager: manual`).

#### 3.3.4 macOS: LaunchAgent

`~/Library/LaunchAgents/local.tasks.service.plist` (prefix: 6, item 6), rendered by `install/render.ts`, with `KeepAlive.SuccessfulExit = false` and `AbandonProcessGroup = true` (S5). **The wrapper** `bin/tasks-launchd` (`LAUNCHD_WRAPPER`, `A2.3.3.4.service-install.launchd-wrapper`) exists because launchd restarts every non-zero exit. It runs `tasks serve` as its child, so a restart re-reads `current`, and maps the exit codes. The wrapper is tested on Linux and macOS runners with a stub service. launchd itself is untested.

#### 3.3.5 Service commands

`tasks service install | uninstall | start | stop | status`. Code: `packages/service/src/install/` (`commands.ts`, whose header states the rules; `entries.ts`, `render.ts`, `registry.ts`, `context.ts`). Tests: `A2.3.3.5.service-install.commands`, `A2.3.3.*.service-install.*`. Not built: `restart`, `logs [-f]`, the Start menu shortcut and the Linux desktop entry.

- **Roots are parameters**: only `defaultServiceContext()` names the real ones, so no test enables a unit, touches linger or launchd, or writes a real Run value.
- **Preview, then apply** exactly the previewed steps, asking once (`--yes`, `--dry-run`). Each step acts only when the entry is still what the plan expects, compared just before the write (exit 4 otherwise). Not detected: a change between that read and the write, which only a same-user process can make (A6 3.15).
- **An entry is ours only when everything it makes its manager do is what install writes**, read as the manager reads it. Anything else is refused and nothing changes. Uninstall removes only what install noted in `service-entry.json`, each folder or key only when empty.
- **start** goes through the OS and succeeds only with a ready service. On Windows it starts `tasksw.exe` through Explorer (the path quoted, because explorer.exe splits an unquoted argument at commas), or detached in an SSH session. It never runs `tasks serve` in its own process tree. Every probe gets only the time left of the deadline, so a timeout is never read as "no user manager" or "no Explorer".
- Refusals come before anything is read or written: root, an elevated token on Windows, package identity (3.5), an agent's shell for install, uninstall and stop (3.6.5), an unsafe umask.
- **Open:** a supervisor in its 1 to 8 s back-off is not seen. A stop or uninstall then reports "not running", and the supervisor starts the service afterwards. A fix needs `tasksw.exe` to write its PID beside `service.json`, or a stop event the CLI can set.

#### 3.3.6 When the service is down

- The CLI exits 6 after one attempt, waiting up to 10 s only while `service.json` says `starting` for a live PID, with the hint `tasks service start`.
- The bridge answers offline (3.7.4) and reconnects in the background.
- The shim retries for 30 s, then waits for Enter (A4 3.6.3).
- A browser tab keeps its page and drafts, shows that the service is not running and retries every 5 s.
- `tasks open` starts the service as `tasks service start` does (3.9 step 1).

### 3.4 Single instance and locks

Code: `packages/service/src/hub/lock.ts` (its header states the rules), storage's `takeFileLock` and `writer-lock.ts`, `hub/spaces.ts`, `hub/service.ts`. Tests: `A2.3.4.hub.single-instance`, `.writer-lock`, `.lock-deleted`, `.stale-recovery`, `.two-installs`, `.drain-ownership`.

- **`service.lock`** is an empty SQLite file held by an exclusive transaction for the service's life. The OS releases it on any exit, power loss included, so it is the only single-instance guard: a stale `service.json` needs no cleanup and a restart after a hard kill is quick (measured: about 60 ms on Linux, 240 ms on Windows).
- **Never open a lock file twice in one process:** on Unix, closing any descriptor of the inode drops SQLite's POSIX lock. Doctor and tests read `service.json` instead.
- **`writer.lock`** belongs to storage, which holds `<space>/writer.lock` for every writer, so one writer per space holds across processes, services, state folders and OS accounts. A lock may outlive the connection it guards, never the reverse. A database with a second name (hard or symbolic link) is refused, because two names would give two locks and two `-wal` files.
- **Ownership watch.** A missing or replaced `service.lock` drains and exits 70. A missing or replaced `writer.lock` exits 70 at once, because another service could open the space while this writer runs and only the end of the process stops a hung worker. On Windows a held lock cannot be deleted, so the watch is a second line there.
- **Socket removal at stop.** libuv unlinks whatever file is at the path when the server closes. So the hub closes the server only while the path is still the socket it bound, and never after lost ownership.

### 3.5 Packaged parents (Windows MSIX)

For virtualised packaged apps (their manifest decides), new files under `AppData\Local` and `AppData\Roaming` go to a private per-package location, and `HKCU` writes are copied on write. Existing files open from the real location, and writes outside AppData happen in place. Processes a packaged agent app starts inherit its container.

**The rule.** Nothing depends on which packages virtualise.
1. Data and program live under `%USERPROFILE%` outside AppData (3.2). Nothing another process of the product must see is written to AppData, `%TEMP%` or `HKCU`, except the Run value, the user `Path` and the Start menu shortcut, which only `tasks service install` and the installer write.
2. The launchers pass `GetCurrentPackageFullName` to Node as `TASKS_PACKAGE`. It is the only signal.
3. `tasks serve` exits 64 with package identity and says to start it from the Start menu or a normal terminal.
4. Commands that write outside the data and install folders (service install and uninstall, the direct start, the installer's `Path` and shortcut steps) refuse in a packaged context. `tasks update` is allowed, with a logged warning.
5. `tasks service start` and `tasks open` start the service through Explorer (3.3.5), outside any package.
6. Bridges never start anything. If a package ever redirected the reads of `service.json` and `ipc.key`, the handshake would fail and the bridge report the service down, never make a second writer.
7. Every bind carries the client's `package`. The service records packaged clients of the last 7 days for doctor (not built).

**Real-machine check** (M0-S8, with the Claude desktop app and the Codex app, open): P-1 a probe MCP server logs `TASKS_PACKAGE` and the AppData, profile and temp folders. P-2 it writes markers in `%APPDATA%`, `%LOCALAPPDATA%`, a folder under `%USERPROFILE%` and `%TEMP%`: the profile marker must land at its real path. P-3 it reads a marker written beforehand by an unpackaged process. P-4 the bridge completes the handshake. P-5 with the service stopped a call is answered offline, `tasks serve` exits 64 from the package's shell, and `tasks service start` starts a service whose parent is `explorer.exe`. P-6 `tasks.exe --package-info` in everyday terminals is empty. If P-2 fails, A3's setup marks that app "needs check". If P-6 finds package identity, rule 4 hands install's registry writes to an unpackaged helper started through Explorer.

### 3.6 Local endpoint: `tasks-local/1`

The stable local protocol of the CLI, the shim (A4), the bridge and any native forwarder. **`docs/protocol/tasks-local-1.md` is its wire reference and part of this specification**: endpoint, framing, the handshake formulas, the bind, the modes, the forwarder contract, the classes and the client failure table live there. Code: `@tasks/bridge/protocol` (`constants.ts` holds every bound, `framing.ts`, `proofs.ts`, `jcs.ts`, `client.ts`) and `@tasks/service/local` (`server.ts`, `classes.ts`, `grants.ts`), with the hub's adapter in `hub/endpoint.ts`. Tests: `A2.3.6.local.*`, `A2.3.6.ops.*`.

#### 3.6.1 Endpoint and discovery

- A Unix socket in the private socket folder of 3.2.1, whose 0700 mode is the protection, or on Windows the pipe `\\.\pipe\tasks-<install-id>-<instance>` with a new instance ID per start.
- Clients discover the service per attempt from `service.json` and `ipc.key`.
- A forwarder hard-codes the few names discovery needs, and `packages/service/test/bridge-names.test.ts` checks them against the brand and the hub's `resolveLayout`, so a rename that misses the bridge fails `pnpm verify`.

#### 3.6.2 Framing

JSON-RPC 2.0, one message per line. No keepalives: the close is the liveness signal.
- Before the client's proof verifies, the service reads at most 1 KiB, and every refusal waits the same 200 ms, so the delay is no oracle.
- **Backpressure**, one rule for every writer of the service: while a peer's socket is backed up the service reads nothing more from it, and waiting output must move within 30 s or the connection closes. The clock restarts only when output moves, never on new output, so a producer cannot keep a non-reading peer alive and a slow but steady reader is never closed.

#### 3.6.3 Handshake (mutual HMAC, then an authenticated bind)

The service proves itself only after the client's proof verifies, and **the client sends nothing beyond its hello until it has verified the service**, then binds under a MAC over the transcript and checks the result's MAC before reading any field. So a squatter on a stale socket path or a pre-created pipe learns only the protocol, the mode, nonces and a proof it cannot use, never a context, ticket or handle.
- Primitives come from `node:crypto` only, compared in constant time, keyed with the 32 decoded bytes of `ipc.key`. Canonical JSON (RFC 8785) refuses lone surrogates and array holes, so no value hashes differently from its wire form.
- **What this protects.** Other OS users cannot use the endpoint: the 0700 folder stops them on Unix, and on every OS they cannot read `ipc.key`. Same-user processes can read the key and are inside the trust boundary (A6).

#### 3.6.4 Modes

**rpc mode** (CLI, shim). `RPC_METHODS` (`local/classes.ts`) is the one table of which class may call which method, and `handlerTable` (`hub/endpoint.ts`) the one place handlers are registered. User-only methods are also checked again by each handler.
- `service/shutdown {restart?}` answers before the drain. It is the graceful stop on Windows.
- `t3/pair` and `t3/pair_wait` are user-only because the service, holding `service.lock`, is the one writer of T3's token (`hub/t3.ts`). The shim's `launch.*` and `run.*` each need their own credential (A4 3.6.3, 3.17).
- A3's setup engine (`packages/service/src/setup/`) runs in the CLI, in the person's session, because the apps' commands must be the ones on the person's PATH, which a service started at boot does not have. The service keeps only the rows (`setup/home_grant`, `setup/home_revoke`, 3.2.5), and for `tasks doctor --live` the times of the tool calls it carried out per instance, in memory (`setup/seen`, every CLI class, A3 3.14).
- An internal error carries nothing from the failure, in the reply or the log.
- **Closing** (a revocation, a shutdown, a slow reader) makes a connection terminal before the socket's close event: nothing buffered is dispatched.

**mcp mode** (bridge, forwarder). The bind context carries the binding inputs (A3). The binding handle is 128 random bits, accepted only inside an authenticated bind and stored as its SHA-256. After the bind every line is an unchanged MCP message, and the service hosts one MCP SDK server per connection in both spec eras (`packages/service/src/mcp/`).
- **One tool list.** Every connection, bound or not, lists the same tools, and authorization is per call (A3). The list never changes, so no `tools/list_changed` is sent.
- **The MCP transport** (`mcp/transport.ts`) keeps a request's in-flight slot until the work its handler started has ended, not only until it is answered or cancelled, because a write cannot stop halfway: the bound is on work.

#### 3.6.5 Connection classes

The class comes from the authenticated bind (`local/classes.ts`): `ui` (an HTTP request with a live UI token), `cli-interactive` (both stdin and stdout are TTYs and no agent marker is set), `cli-script`, `cli-agent` (any marker of `AGENT_MARKERS`; A3 keeps the list), `bridge` and `shim`. The client never names a class or a principal, and A3 maps classes to principals. No connection can present the actor kind `import`.
- User-only operations (launches, runs, routines, policy, approvals, the space and roots verbs, the port) are open to `ui` and `cli-interactive` only. `tasks service install`, `uninstall` and `stop` also check the agent markers locally (exit 5), so `systemctl` and `launchctl` cannot bypass the rule the service enforces for `service/shutdown`.
- This guards well-behaved agents. It is not a security boundary: same-user code can fake a TTY or drop the markers (A6).
- Open: Windows variable names ignore case, but the marker list compares the spelling. The fix belongs in the shared marker selection.

#### 3.6.6 Versions

- `protocol` is an integer that changes only for incompatible changes. Additive features are capability strings.
- The service accepts `[min, max]`: `[1, 1]` now, `[current - 1, current]` from protocol 2, keeping the previous handlers for one release line (A4's one-minor-version promise for shims).
- Every bind result carries the service's MAC, refusals included, so a client tells "too old" from a squatter. A client too old must restart its session; a service too old must restart.

### 3.7 The bridge (D9)

Code: `@tasks/bridge/mcp` (`forwarder.ts`, `offline.ts`, `discovery.ts`, `args.ts`, `io.ts`), the offline capture in `packages/service/src/mcp/offline.ts`, the conformance suite in `tests/forwarder/`. Tests: `A2.3.7.bridge.*`, `A2.3.7.mcp.offline-cache`.

#### 3.7.1 What it is

`tasks mcp [--space <id>] [--instance <id>] [--app <name>]` forwards between the agent app's stdio and the service. It holds no task logic, registry or MCP server.
- **It can never start the service.** Its runtime imports only a fixed set of Node built-ins and its own modules, enforced by a test of the import graph, lint and dependency-cruiser. It may not import `packages/brand` or the hub. Only `io.ts` writes stdout.
- The CLI's entry hands `mcp` (and `shim`) to the bridge through one dynamic import before it loads anything else, so nothing else can write to stdout and the start costs only 2 to 3 ms more than the bridge alone.
- **Agent configs** (A3's setup) use the absolute stable command, never `npx` and never a version folder.
- The bind pins `--space` when it names exactly one served space, else the one served space. Otherwise the connection's first call pins the space it uses (3.10.5). A pinned connection never follows a later change of the default.

#### 3.7.2 Online path

1. Discover, handshake and bind in mcp mode (3.6).
2. Pipe lines both ways unchanged.
3. Track requests in flight, so a loss can answer them (3.7.5).
4. stdout carries only MCP messages; stderr only content-free warnings.

stdin pauses only while a peer stalls, or for a bounded time, because a paused stdin hides cancellations and the end of the session. The bridge never ends with requests unanswered by an empty event loop.

#### 3.7.3 What the service provides for offline use

- **Captured, not hand-written:** `mcp/offline.ts` runs the endpoint's own server in memory and records its answers in both eras, so the offline tools are the online tools. `pnpm gen` writes `packages/bridge/lib/mcp-offline.json`, each version folder carries it, and the service writes `<cache>/mcp-offline.json` for its build at every start. Tests hold them byte-identical.
- One text per offline reason says whether anything was saved and what the agent or user should do.
- The service never writes the cache into a folder others can write, because a planted file could put words into an agent's instructions.

#### 3.7.4 Offline responder

Offline the bridge answers `initialize`, `server/discover` and `tools/list` from the stored answers of the request's era, `tools/call` with a tool error carrying the current reason's text, and everything else as the live service would. **`mcp_init`**, the client's latest `initialize` or `server/discover`, goes into every later bind, so the service starts the connection in the client's era and never sees a request twice.

#### 3.7.5 Reconnect after a service restart

- After a loss every request in flight is answered at once: a tool call with the `connection_lost` tool error, and `initialize` with the offline answer, because an error for `initialize` would end the client's session.
- New requests are held up to 10 s and reach the new service after the bind, so a restart costs an agent at most the call in flight (10 s covers the 5 s drain and a new start).
- The bind result's handle is kept for `resume.handle` and never logged or shown. The service restores the binding and its pinned space for the same instance for up to 24 hours after the handle's last use, from `<state>/sessions.json`, so a binding survives a service restart (A3 3.7.3, `tests/forwarder/binding.test.ts`).

#### 3.7.6 Native replacement

The forwarder contract is 3.6.1 to 3.6.4 and 3.7.4 to 3.7.5, summarised in the protocol reference. **The conformance suite** `tests/forwarder/` runs the binary in `TASKS_BRIDGE_BIN`, else the Node bridge, as real processes against a scripted MCP peer, fake endpoints and the real hub.

If rule 3 of 3.7.7 fires, a Rust forwarder (F1 to F4: threads, `hmac`, `sha2`, `serde_json`) ships beside the launcher as the default, takes `tasks mcp`'s arguments and reads the offline file of its version folder. `tasks mcp --node` keeps the Node bridge.

#### 3.7.7 Measurements and the decision rule

| ID | Metric | Threshold | Measured p95 (Windows / Linux) |
|---|---|---|---|
| B01, B06, B07 | Spawn to the first byte of the `initialize` reply: service running, stopped, through `tasks shim` | p95 ≤ 250 ms Linux, ≤ 600 ms Windows | B01: 47–61 ms / 36 ms. B06, B07 warm: under 70 ms |
| B02 | Memory of one bridge after the handshake, 10 tool calls and 60 s idle | USS or Private Bytes ≤ 30 MiB, RSS or Working Set ≤ 60 MiB | Private Bytes 21.4, Working Set 46.4 MiB / USS 11.4, RSS 53.4 MiB |
| B03 | 10 bridges at once, 100 read calls each | Added private memory ≤ 300 MiB, call p95 ≤ 50 ms, no handshake failure | 239 MiB added, call 1.7 ms (Windows) |
| B04 | The same call through the bridge and through a direct client | p95 difference ≤ 5 ms | 0.08 ms |
| B05 | The service during B03 | RSS growth ≤ 30 MiB, no event-loop stall over 100 ms | Growth 3 to 9.5 MiB, loop maximum 25 ms |

A warm bridge start under 70 ms keeps Codex's `startup_timeout_sec` for the bridge at 20 s (A3 3.13.4), and the shim stays Node. Only a cold start over 2 s would raise the timeout.

**Protocol.** 20 runs per metric on fresh state folders, judged on the p95 across runs (nearest rank), with 0 handshake failures and call errors in every run. Every forwarder starts through the stable launcher with the packaged runtime, in a `TASKS_HOME` test install made by the release script. Memory is read from outside: Linux USS, PSS and RSS from `smaps_rollup`, Windows Private Bytes and Working Set of the launcher and `node.exe`, each and summed, beside a bare Node process sampled in the same window (a bare Node's Working Set swings by 20 MiB). The service's RSS is polled every 20 ms or finer. B05's stalls are raw `monitorEventLoopDelay` maxima at 10 ms resolution. Runs happen with ordinary applications open, plus one busier-machine run and cold runs after a reboot, reported apart.

**Rule.**
1. Every threshold passes on Windows and Linux: the Node forwarder ships.
2. A miss of up to 50 % in memory or start time: bridge-only Node flags (a small `--max-old-space-size`, `--v8-pool-size`) and the compile cache, then measure again.
3. Still failing, a larger miss, or a handshake failure that is not a product bug: the native forwarder before M7.
4. After v1, memory pressure reported from parallel sessions applies rule 3.

**Where it stands: rule 1, provisional.** The closest margins are memory: Linux RSS per bridge (p95 53.4 of 60 MiB, mostly shared pages of the Node binary) and ten bridges on Windows (239 of 300 MiB, about 250 with the launcher). About 6.6 MiB more RSS per bridge on Linux, or 5 MiB more Private Bytes on Windows, would miss. The rule is applied again after the protocol above runs on a release build on both systems. A7's bridge budget keeps watching.

### 3.8 HTTP and WebSocket for the browser UI

Code: `packages/service/src/http/` (`listener.ts`, `app.ts` (its header lists the routes), `checks.ts`, `csp.ts`, `page.ts`, `auth.ts`, `grants.ts`, `port.ts`, `holders.ts`, `ws.ts`, `feed.ts`, `launches.ts`, `limits.ts`; each header states its rules), `packages/cli/src/open.ts`, the page in `packages/web`. Tests: `A2.3.8.http.*`, `A2.3.8.3.e2e.strict-csp`, `A2.3.8.4.e2e.page-secrets`, `A2.3.9.cli.open`, `A2.3.13.cli.doctor-http`.

#### 3.8.1 Listener

- HTTP/1.1 on `127.0.0.1` only, not `::1`, so the web app's storage stays in one origin.
- Each connection is admitted paused, so the Linux peer check (3.8.4) runs before any byte is read. Every bound lives in `http/limits.ts`, and unauthenticated connections are capped at 64.
- `startService` binds no HTTP listener unless asked, so a test never binds a port of the range. `tasks serve` always asks.

#### 3.8.2 Port selection

The port must stay stable because the web app's identity and storage belong to `http://127.0.0.1:<port>`. The rule (`http/port.ts`, `http/holders.ts`) is a decision over injected facts:
1. `[http] port` set: use it.
2. Not set: the first free port of 7713 to 7733, persisted.
3. **Foreign holders** are checked before binding the persisted port and whenever a bind fails, without root or admin rights, and sightings are recorded in `service.sqlite`. A check that cannot run counts as no holder, because failing closed would remove the UI wherever `netstat` is missing.
4. **Blocked.** Another user seen on the port, now or before: no listener on any port, every `ui` row revoked, every connection closed. The socket keeps working. There is no fallback port then.
5. **`tasks service port <n> [--reuse]`** (the person only) writes `[http] port`, clears the sightings and restarts. Taking the blocked port again needs `--reuse`, which asks the person to confirm every tab and app window is closed.
6. **Moved.** This user's own process on the persisted port: an OS-chosen port for this run, `machine.toml` unchanged, and the persisted port taken back once free.
7. On Windows a bind error `EACCES` (a Hyper-V or WSL excluded range) counts as taken, and doctor names the range.

A holder that came and went while the service was stopped leaves no trace (3.8.6).

#### 3.8.3 Request checks

One pure function (`http/checks.ts`, whose header gives the order) runs before any route, and the first failure decides.
- No CORS header ever, so a cross-origin page can never send `Authorization`. `Host` must be the loopback name with the port, which stops DNS rebinding.
- **No response bypasses the checks or the security headers**, refusals, `100 Continue` and the WebSocket's 101 included. No unauthenticated path starts a process.
- A `tasks-build` header that differs from the service's build is 409, and the UI shows its reload bar. Header names come from `httpHeader()` in `packages/brand`, derived from the identifier, never from a display name: fetch refuses a header name with a space.
- The shell answers at `/` and the page's own route shapes, so a reload or a link works, with the service's build filled in per response.
- **Routes outside the registry**, under every check: the launch receipts, the switcher's space list and Make default (3.1). The default is machine configuration, not an operation on a space.

**Headers.** Every response carries the CSP of `http/csp.ts` (`script-src 'self'`, a per-response style nonce for React Aria, `worker-src 'none'`, `frame-ancestors 'none'`, Trusted Types; A5 3.26).
- Never in v1: `'unsafe-inline'`, `'unsafe-eval'`, `'wasm-unsafe-eval'` (the later phone client adds the last with its Wasm crypto). `worker-src 'none'` keeps v1 free of service workers.
- Every script, stylesheet and module preload carries a `sha384` integrity hash, so an asset another server planted in the HTTP cache does not load. The build adds them (`packages/web/build.ts`), and `loadUiFolder` (`http/page.ts`) refuses a UI folder that SRI does not fully cover.

#### 3.8.4 Getting a token into the browser

1. `tasks open` calls `ui/mint_code` over the socket for a 60-second single-use code.
2. It proves the listener first by an HMAC under `ipc.key`, so a squatter on the port never sees a code.
3. It opens `http://127.0.0.1:<port>/#k=<code>&to=<path>` (3.9). The fragment is never sent in a request.
4. The page redeems the code for a bearer token (`tasks_u_` and 256 random bits as 43 base64url characters, a `ui` grant row), stores it in `localStorage` and removes the fragment.
5. A 401 shows the signed-out page, which says to run `tasks open`.

- Codes and tickets are spent on their first lookup, found or not. No secret is logged, put in an error body or kept in clear. `tasks ui sessions [--revoke <id>]` (not built) and A5's preferences list and revoke tokens.
- **The change feed** (`http/feed.ts`) never sends a row as of another state than its batch: a row a later or hidden commit changed travels as `row: null` and the page refetches. A hidden commit still advances coverage. An audience filter (M3.12) also needs a row rule for snapshots. A revocation or expiry closes the grant's feeds and the page signs out.

**The cross-user code leak.** Other local users can read the browser's argv on Linux and macOS.
- **Linux:** every accepted connection's client socket must belong to the service's UID, else it is closed before any byte is read.
- **macOS:** redemption needs an `lsof` record of exactly the client's own socket with the service's UID. Never a PID-only match.
- **Windows:** standard users cannot read other users' command lines.

#### 3.8.5 What other local users can and cannot do

| | Linux | Windows | macOS |
|---|---|---|---|
| Connect to the socket or pipe | No | Open the pipe read-only and read a challenge, nothing more | No |
| Read `ipc.key`, `service.json`, tokens, spaces | No | No | No |
| Connect to the HTTP port | Closed at once | The static shell, `/healthz`, `/.well-known/tasks` | As Windows |
| Use the API | No | Only with a token | Only with a token. Redemption is UID-checked |
| Hold the port when the service starts, or be seen holding it | No UI and every token revoked (3.8.2) | same | same |
| Serve a page on the port while the service is stopped | **Not prevented in v1** (3.8.6) | same | same |
| Exhaust connections | Closed at accept | 64 unauthenticated, then closed | same |

- **Pipe availability.** Windows pipes keep Node's default security (S10). Another user's read-only opens each hold an unauthenticated slot for up to 5 s, so another user can starve the handshakes: an availability limit of v1's single-user machines. A pipe DACL without Everyone needs native code.
- Administrators, root and same-user processes can do everything (A6).

#### 3.8.6 The browser origin in v1, and the M10 gate

**What v1 cannot do.** It cannot authenticate the HTTP origin against another local user who binds the port while the service is stopped. That user's page runs as the product's origin in the victim's browser: it can read the token and drafts in `localStorage`, write values the UI later reads (A5 treats stored drafts as untrusted), and keep a tab open that calls the real service once it is back. **v1 assumes a single-user machine**, and A6 narrows T1 to match. This is a stated limit.

**Mitigations:** no service worker and integrity hashes (3.8.3), no UI and revoked tokens while another user holds the port (3.8.2), token expiry, doctor's warning about other accounts (3.13), and the Linux peer check.

**Hard gate for M10.** An authenticated UI origin, one of: (1) per-user HTTPS, with a key pair in the secrets folder and a certificate for `127.0.0.1` trusted only in the user's own browser profiles, Firefox's own store and the snap's profile included; (2) a desktop shell whose channel is authenticated like `tasks-local/1`. M10's gate includes the two-user test of section 5.

### 3.9 Opening the UI

**`tasks open [--space <id>] [--task <ref>] [--tab | --app] [--print-url]`** (`packages/cli/src/open.ts`, `A2.3.9.cli.open`)
1. If the service is not running (`not_running`: no `service.json`, or nothing at its endpoint), start it with `tasks service start`'s own start (`startService`: through the OS, only a ready service counts), say so in one line on stderr, then go on. A service that is starting, stopping, unreachable or untrusted is reported as every command reports it, never started a second time. A start that fails says why and names the command to look further (exit 6). An agent's shell never starts it: it is told to ask the user, as when the service runs (S6). Code: `packages/cli/src/open.ts`, test `A2.3.9.cli.open-start`.
2. Mint a code and prove the listener (3.8.4). `--space` and `--task` become the page's route.
3. Open the URL with the OS's own opener. In a packaged context Windows uses `explorer.exe "<url>"`, so the browser does not start inside the container. `--app` or `ui.open_mode = "app"` starts a Chromium-family browser with `--app=<url>`, else the default browser (not built; A4's opener module takes it over).
4. `--print-url` prints the URL and warns that it holds a one-time sign-in code.

- An agent's shell cannot mint a code and is told to ask the user.
- **Installable web app:** `/manifest.webmanifest` with `start_url` and `scope` `/`, `display` `standalone`, the brand's name and A5's colours and icons. Chromium-family browsers install it without a service worker on the secure loopback origin. Firefox shows a normal tab.
- **Linux desktop entry** (not built): `tasks service install` adds `~/.local/share/applications/tasks.desktop` (`Exec=<absolute command> open`, `Terminal=false`) and an icon under `~/.local/share/icons/hicolor/`, with no sudo. `gio open` hands the URL to the Firefox snap, which reaches `127.0.0.1` and keeps `localStorage` in its profile. No Electron and no bubblewrap, so the user-namespace restriction does not matter.
- **On Windows** the Start menu shortcut runs `tasksw.exe open` (not built).

### 3.10 The CLI

Code: `packages/cli/src/` (`main.ts`, `args.ts`, `verbs.ts`, `output.ts`, `connect.ts`, `space.ts`, `roots.ts`), the space verbs in `packages/service/src/hub/space-verbs.ts`, the space choice in `packages/service/src/ops/handlers.ts`. Tests: `A2.3.10.cli.*`.

#### 3.10.1 Entry point

One command, `tasks`, at the stable path. **Operation verbs** are generated from A3's registry (`cli-spec.json`). **Local commands** are owned here: `service`, `serve` (hidden), `open`, `mcp`, `doctor`, `space`, `roots`, `version`, `install --finish` (hidden), `update`, and, not built yet, `ui sessions` and `uninstall`. A4 adds `shim` (hidden), `setup t3` and `setup instances`, A3 `setup agents`, A6 `machine show` and `policy show`. `help`, `version`, `doctor` and `serve` work without the service; everything else goes through it.

**`tasks space`** verbs are rpc methods `space/*`, not registry entries, because a backup, restore or claim is no A1 operation. Only `space list` is open to scripts and agents. The CLI never opens a space database: create, backup and restore run in a worker of their own in the service.
- A new space goes under the install's own data folder, so a test install never writes into the daily folder.
- A restore in place keeps the old folder as `<slug>.replaced-*`, never removed automatically.
- **There is no `space move`.** Moving a space is a later step (6, item 12).
- Known gap: `recover` plays back a folder whose ID the hot journal kept from being checked. The open after it checks.
- Not built: `space add` and `remove` (keep a space in `[[spaces]]`) and `tasks space cleanup` for crash leftovers (it needs A1's age rule and a guard against a create or restore still running). A1 owns `import` and `export`, A6 `fork`, `transfer` and `resolve`.
- Tests: `A2.3.10.cli.space`, `A2.3.10.cli.space-use`.

**`tasks roots`.** `roots [list]` is open to every class. `roots add` is user-only, refuses a folder places would never resolve through, and replaces the service's roots at once (`hub/roots.ts`).

#### 3.10.2 Conventions

- `--json` prints exactly one document, the result or `{"error": …}`; streams print NDJSON. Diagnostics go to stderr and are never parsed.
- Any text argument can be `-` for stdin, so agents on Windows avoid PowerShell quoting.
- Human output names the space of every write.
- With `--request-id` the CLI first looks up an existing receipt (A1 3.8) in its stable writer scope (A3 3.7.9), and every retryable failure of a write prints its request ID.
- Usage errors name the option or verb, never a value.
- Colour, once there is any, appears only on a TTY without `NO_COLOR`.
- `main(io, options)` takes the process as one value, so tests run it in-process.

#### 3.10.3 Exit codes

Exit codes follow the error class of `packages/contracts/src/errors.ts` (`A2.3.10.cli.exit-codes`), so a script reads the class from the exit code. Transport conditions reach callers as A3's codes with a `reason`, and a read-only space answers writes with `read_only` and its reason.

#### 3.10.4 Finding the service

- The CLI finds `<state>` through `@tasks/service/paths`, which loads no storage. The CLI never imports storage, except doctor's gate (3.13), and never starts the service.
- **Sandboxes.** Inside Codex's sandbox (the unelevated Windows sandbox, bubblewrap on Linux) the connect fails with `EPERM`, so the CLI exits 6 and points to the MCP tools. MCP still works, because the agent app starts the bridge outside the shell sandbox. Codex's elevated Windows sandbox and Claude Code's sandbox are not tested yet (M0-S12).

#### 3.10.5 Which space a CLI call uses

1. `--space`, an ID or a name.
2. `TASKS_SPACE` (A4 sets it in launched sessions). Never for a bridge's connection.
3. The session a `cli-agent`'s `TASKS_TICKET` maps to, which also gives its default task (A3 3.7.4).
4. `[service] default_space`, when served. A default that is set but not served is `space_unavailable`.
5. The one space the service serves.

- **A binding comes before all of these** (A3 3.7.8): a call that names another space is `forbidden`, and a pinned space no longer served is `space_unavailable`, never another space.
- A restored copy keeps its original's ID and name, so two candidates are `ambiguous`, never the first listed. Only a folder names one of them for certain.
- `cli-agent` stops after step 3, so an unbound agent never writes into a default space by accident.

### 3.11 Upgrades with a running service

An update never kills a session. The service restarts through the OS after the new version passed its self-test (3.12.6), and spaces reopen, migrating on open behind A1's verified backup. Bridges, shims and runs keep running from the old version folder, which the updater never removes, and reconnect with their binding (a protocol too old gives `restart_session`). A CLI call in flight may get exit 6 and is repeated with the same request ID. A UI tab sees the new build and shows the reload bar (A5 3.15). The page never reloads by itself.

`tasks update` asks once at a terminal before it restarts a running service, and `--yes` answers for a script. Not built: the question names active runs and launched sessions and says they keep running, and `updates.auto = true` waits until none are active.

### 3.12 Packaging (D11)

#### 3.12.1 Runtime pin

- **Node 26.13.1** with its **SQLite 3.54.1** (FTS5), pinned in `.node-version` and `scripts/build/node-pin.json`. The shipped runtime is the official nodejs.org archive, never modified and never taken from a CI runner, so `node.exe` keeps the OpenJS Foundation's Authenticode signature. pnpm provides Node for development only.
- An archive is accepted only when its signed `SHASUMS256.txt` verifies against the pinned keyring and it equals the digest pinned per platform. The digest pin means even a release signed by a compromised releaser key fails. Code: `scripts/build/node-runtime.ts` (`A2.3.12.1.build.node-download`).
- **The runtime gate** (`packages/service/src/version/runtime-gate.ts`, doctor's `runtime` row, `A2.3.12.1.build.runtime-gate`) blocks a release whose Node, SQLite or `--report-exclude-env` differ from the pins.
- **Concurrent Sparkplug and Maglev are off in every product process** (`@tasks/bridge/safe-exit`, `A2.3.12.1.runtime.safe-exit`). A V8 compile job that allocates on a worker thread can wait for the main thread to collect garbage. `process.exit` joins the V8 workers before it tears down the isolate, so an exit that meets such a job hangs for good. The bridge, the shim, `tasks serve`, the service's crash exit and Ctrl+C end through `process.exit`. Two such jobs run on every compile: concurrent Sparkplug batches (the observed hang) and Maglev, which builds its code object and deoptimisation data on the worker. The module sets `--no-concurrent-sparkplug` and `--no-maglev` at run time, so it needs no launcher flag and also covers runs from source. Maglev is turned off as a whole because its flags for building on the main thread are read again when a job finishes, so changing them while a job runs is unsafe. Hot code goes from Sparkplug to TurboFan, which builds its code object on the main thread. Every script that loads the product's code and ends through `process.exit` imports the module before any other: the CLI's entries (`bin.ts`, `lib/tasks.mjs`), the bridge's and the service's script entries, the test scripts and `scripts/verify.ts`. The test finds those scripts through the import graph of `packages/`, `tests/` and `scripts/` and checks the order. A later Node pin re-checks the list: the test fails once the runtime stops handing batches to a worker or stops using Maglev.
- **What the run-time flags leave open** (not seen to hang): a TurboFan job folds constant strings on its worker and can allocate there, and TurboFan's concurrency is fixed when the isolate starts, so no run-time flag stops it short of turning TurboFan off. A job started before the module ran (Node's start-up, the loading of the entry's modules) is not stopped either. Two designs close both (not built): starting Node with `--no-concurrent-recompilation --no-concurrent-sparkplug` from every launcher and source-run script, or ending these processes at the end of their event loop instead of through `process.exit`.
- **Fallback** (not built; A1 decides when): first the last Node patch that passed, then the `better-sqlite3` driver. With it selected the gate queries that driver's own SQLite, never `process.versions.sqlite`, and a release carries only the platform's own prebuild in `native/`.
- **Platforms:** `linux-x64`, `linux-arm64`, `win-x64`, `darwin-arm64` (community-tested), later `win-arm64` and `darwin-x64`. glibc only, re-checked per pin.

#### 3.12.2 Layout of an install

```
<root>/
  current            -> versions/<v>     symlink (Linux, macOS) | text file "<v>" (Windows)
  versions/<v>/      bin/ (launchers), runtime/ (Node), lib/ (tasks.mjs, chunks/, bridge.mjs,
                     mcp-offline.json, shim.mjs), ui/, native/ (only with content), licences,
                     manifest.json (SHA-256 of every other file)
  bin/, home.marker  separate installs only: the stable command
```

- A version folder is immutable once in place, because running processes resolve files from it.
- Only built `.mjs` ships: type stripping costs about 20 ms per start and, for the bridge, 40 ms and 12 MiB of Private Bytes.
- `manifest.json` is one sorted `path: hex` line per file because the POSIX install script reads it with `sed`.
- **The load rule:** every built file loads only Node built-ins and files of `lib/` named by a literal, and a worker without a bundle entry fails the build. A bundle that starts but cannot find its own module is the classic failure.
- The entry turns on Node's compile cache in `<cache>/compile`. Children and workers do not inherit it, so tools the product starts never write into its cache.
- A build's version defaults to `<package version>-dev.<commits on HEAD>`, so every merged commit gets its own version folder. A release passes `--version`.
- Code: `scripts/build/bundle.ts`, `version-folder.ts`, `packages/service/src/version/folder.ts`, `packages/cli/src/entry.ts`. Tests: `A2.3.12.2.build.bundle`, `.version-folder`, `.version-manifest`.

#### 3.12.3 Launchers

A launcher inside a version folder runs that version, and the stable launcher runs the version `current` names. Trust assumptions: (1) the install belongs to the user, so a same-user writer that could replace `node.exe` is outside the boundary; (2) the launcher trusts its own location.

**Linux and macOS** (`POSIX_LAUNCHER` in `scripts/build/launchers.ts`, `A2.3.12.3.build.posix-launcher`): a POSIX `sh` script that applies step 3's environment rule and `exec`s Node, so a bridge stays one process. It first turns off xtrace and drops an exported `readlink` function, because bash as `/bin/sh` imports both from the caller: xtrace would print the environment into agent apps' logs, and a `readlink` function would pick the version.

**Windows: `tasks.exe` (console) and `tasksw.exe` (GUI)**, one C source in `packages/launcher-win/` (its README and `launcher.c` carry the details; tests `A2.3.12.3.launcher-win.*`).

1. **Mode.** Version-local when the launcher's parent folder sits in `versions` and holds `manifest.json`; `current` is never read. Otherwise stable-dispatch: a `home.marker` beside its folder makes a separate install, else the root is the fixed `share\tasks` beside the command folder. `current` must name a plain version folder.
2. **Resolve** `runtime\node.exe` and `lib\tasks.mjs`. No folder or file of the install below the root may be a link or junction.
3. **Environment** from the location only. `NODE_` variables (but `NODE_EXTRA_CA_CERTS`) and OpenSSL's loader variables are removed, because Node and OpenSSL read them before the entry runs and could load a DLL from outside the install. Node inherits only the standard handles.
4. **Command line:** the launcher's own tail, passed verbatim, never re-quoted and never through `cmd.exe`.
5. **`tasks.exe`** puts Node in a kill-on-close job before Node runs. If any job step is refused, Node never runs (exit 70); the fix for a host that refuses is `CREATE_BREAKAWAY_FROM_JOB`, never Node without the job. Ctrl+C is ignored by a handler, never by `SetConsoleCtrlHandler(NULL, TRUE)`, whose flag children inherit.
6. **`tasksw.exe`**: no console, no job, stable-dispatch only, the supervisor of 3.3.2.
7. `--package-info` prints the package identity.
8. `--port-owner <port>` (not built): `none`, `self` or `other` from `GetExtendedTcpTable` and the owners' tokens, with no admin rights, to replace `netstat` and `tasklist` in 3.8.2.
9. *(Removed. There is no `--replace`: Windows refuses to rename over a running launcher, and `fs.rename` replaces an idle one.)*
10. **Sibling repair** (`repair_sibling`, `A2.3.12.3.launcher-win.sibling`). Before anything else, a stable-dispatch launcher in a command folder named `bin` checks that its sibling (`tasks.exe` for `tasksw.exe`, and the other way round) is there: one file-attribute call, the only cost of a normal start. When it is missing **and an update's journal is there** (`<state>\update.json` in a plain `state` folder; only its existence is read), it puts back a copy of `<root>\versions\<v>\bin\<sibling>` for the version `current` names, then goes on as it would have.
    - **From the version folder `current` names, never from `<sibling>.new` or `<sibling>.old-<n>`:** those are files only the journal can vouch for, and checking them would need a JSON reader and SHA-256 in the program that decides what runs. The version folder adds no input, since the launcher already runs Node from it, and it is the journal's side for that launcher: the swap comes after `current` changed, and a rollback points `current` back before it restores the launchers.
    - **Only while a journal is there:** without one no update is under way, and what manages the command folder then (`install --finish` and its undo, an uninstall) writes no journal, so a repair would race it. A launcher missing without a journal (a cut-off `install --finish`, a deletion by hand) is not put back; running the installer again restores it.
    - `<state>` is the service's own: `<root>\state` in a separate install, else `%USERPROFILE%\.tasks\state`. `versions`, the version folder, its `bin` and the file must be plain, and from the daily install's command folder `share` and `share\tasks` too, before `current` is read. The copy is at most 16 MiB, goes to a new temporary file in the command folder (`CREATE_NEW`, no sharing), is flushed and renamed into place through its handle without replacing anything, so a sibling that appeared meanwhile is kept.
    - A failure is reported on stderr and never changes what the launcher runs. A sibling that is there but of another version is left alone: both still run, and the service's repair brings it to the journal's side. A folder or link at its name, and a version-local launcher, are left alone too.

**Path length.** Without a long-path manifest the launchers stop at `MAX_PATH`. The longest path below the root is 91 characters, so a root is at most 168 characters and install refuses a longer one. Recompute when a file name's length changes.

No `.cmd` shim: Node refuses to spawn one without a shell, and cmd.exe would re-parse agent text. No single executable: `node.exe` stays byte for byte official, signature included.

#### 3.12.4 Per-OS install

**Built:** the archives and their signing (`scripts/build/archive.ts`, `scripts/release/`), the install scripts for separate installs, and `tasks install --finish`. The templates `scripts/install/install.sh` and `install.ps1` are rendered by `render.ts`, and their header comments are the reference for the exact order and every check. `install --finish` is `packages/cli/src/install.ts` over `packages/service/src/version/install.ts`, `switch.ts` and `candidate.ts`. Tests: `A2.3.12.4.install.*`, `A2.3.12.6.install.finish`, `A2.3.12.6.candidate.checks`, and `pnpm smoke` (`scripts/install/smoke.ts`).

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
9. Hand over to the candidate's version-local launcher: `tasks install --finish`.

The Windows script must survive Windows PowerShell 5.1 started from PowerShell 7 (a byte order mark written into a child's stdin, a missing `Get-FileHash`, the console code page): its header names each workaround.

**`tasks install --finish`** runs the self-test (3.12.6 step 6) and only when every row passed switches `current`, the stable command and `install.json` under `<state>/update.lock`, after repairing an interrupted update, because a switch under a journal would let a later repair undo the install. From the switch on it is all or nothing. It prints `tasks service install` and never runs it.
- It places the stable launchers with two renames and no keeper (3.12.6 step 10), because its undo renames the old launcher back.
- A launcher's sibling repair runs during a finish only when a stuck update's journal is there (3.12.3 step 10). For that case the finish notes which stable launchers were there before the switch: one there afterwards that was not is this install's, recorded in `created` and given its undo before anything about it is hashed or can fail. The undo puts `current` back first, so a launcher started while it runs repairs from the version `current` named before, or with none repairs nothing, and never brings back a launcher the undo removes.
- **The race left open:** with a stuck update's journal during a finish that then fails, a sibling repair that read `current` before the undo removed it can still put its copy in after the undo. The leftover is one launcher in the failed install's command folder, which the next install run takes as its own. Closing it needs a lock that the C launcher shares with Node's `update.lock`.

**A failed run removes only what it made.** Once the root has a `current`, only the download and staging folders go: an update may already use a version folder this run placed.

**The root** is absolute, at most 168 long (3.12.3) and not a link. **Every folder the install runs code from or writes to is the user's and changeable by no one else, and no folder on the way to it lets anyone else rename it away**, because an account with delete-child above could swap the root after the checks. `%TEMP%` and `%LOCALAPPDATA%` can grant other accounts change rights (an agent app's sandbox group), so tests use roots under `%USERPROFILE%\.tasks-test\`.

**The release keys.** `RELEASE_PUBLIC_KEYS` in `packages/service/src/version/release-keys.ts` is the one value, a placeholder until the release key exists, which a release render and `pnpm release sign` refuse. A test build pins a throwaway key and says so, and no test-signed install script can be released.

**The daily install** (not built, M1.15) uses the default roots: the program in `~/.local/share/tasks` (`%USERPROFILE%\.local\share\tasks`) and the command in `~/.local/bin` (3.2.1). `install --finish` writes the link `tasks` → `../share/tasks/current/bin/tasks` on Linux and macOS, and both stable launchers on Windows (through 3.12.6's staged swap when they exist). Then:
- Linux and macOS: warn if `~/.local/bin` is not on `PATH`. Shell profiles are never edited.
- Windows: add `%USERPROFILE%\.local\bin` to the **user** `Path`.
- Offer `tasks service install`.
- **The download** comes with the first hosted release (M10): `curl -fsSL <release-base>/install-<ver>.sh | sh` (or a `latest` alias to a versioned script) and `irm <release-base>/install-<ver>.ps1 | iex`, fetching the archive, `SHA256SUMS`, `.sig` and `.sshsig` into the private download folder.
- A per-user graphical installer and winget and Scoop manifests come later.

**macOS** (not built): as Linux, once `install.sh` handles it (`mv -h`, `shasum`, `stat`). `ssh-keygen -Y verify` is built in, `curl` adds no quarantine attribute, and Gatekeeper sees only Node's binary, whose Developer ID signature CI checks.

**Trust.** A first install trusts the versioned install script fetched over HTTPS, whose SHA-256 is in the release notes and the README and which pins the keys. Later updates trust the keys of the installed version, never the network or the candidate. The candidate's self-test is a functional check after authenticity is settled.

**Uninstall** (not built). `tasks uninstall` first plans the service entry's removal (3.3.5), then lists the autostart entry, desktop entry or shortcut, `PATH` entry, stable command and what `install.json`'s `created` lists, and asks once. It removes nothing else from the install root, and never anything in the data folder or a space. Whether it leaves `install.json` and `update.lock` in `<state>` or moves them is decided when it is built. With agent integrations it asks for `tasks setup --uninstall` (A3) first. When it finds an update's journal (a stuck update), it removes `current` before the stable launchers, or a launcher started in between puts its removed sibling back (3.12.3 step 10).

#### 3.12.5 Updates and trust

- **Trust root:** Ed25519 public keys in `lib/` (`UPDATE_KEYS`, which is `RELEASE_PUBLIC_KEYS`), current and next. An installed version verifies a candidate with its own keys, offline, before running any of its code, through the raw signature `SHA256SUMS.sig` in `node:crypto`, so there is no signature format to parse. While the key is a placeholder every update is refused. `pnpm build` has no option to trust another key.
- **Signing** (`scripts/build/signing.ts`, `scripts/release/`, `A2.3.12.4.build.signing`, `A2.3.12.8.build.release-script`): CI only ever test-signs with a throwaway key. The release key is made once, passphrase-encrypted, kept outside the install and every checkout, with separate offline backups of the key and the passphrase. A `next` key is made the same way.
- **Channels** (not built): `stable` (tags) and `nightly` (prereleases from `main`). A release publishes the signed `channels/<channel>.json` (versions, dates, minimum upgrade-from version, notes URL, and per platform the URL, size and SHA-256) beside `SHA256SUMS`, its `.sig` and `.sshsig` (namespace and identity `tasks-release`), and the versioned install scripts.
- **Checking** (not built) at most once a day, sending only the version in the User-Agent: the product's only unprompted network call. `updates.check = false` turns it off. A new version shows in A5's health dot and in doctor.
- **Other channels** (not built): if `install.json` says `winget`, `scoop`, `brew` or `dev`, `tasks update` prints that channel's command and stops.

#### 3.12.6 `tasks update`

**Built:** `tasks update --from <archive> | --rollback | --repair [--yes]` from a local release archive, tested on separate installs, with the staged Windows launcher swap (steps 8, 10 and 14) and the launchers' sibling repair (3.12.3 step 10). Not built: the hosted channel (`--channel`, `--version`, steps 3 and 4: M10) and retiring old versions (step 14).

Code: `packages/service/src/version/` (`update.ts`, whose header gives the order; `release.ts`, `archive.ts`, `journal.ts`, `repair.ts`, and `switch.ts`, which `install --finish` shares), `packages/cli/src/update.ts`. The build imports the platform names, key parser, signature check and archive readers from there, so the build writes what the updater reads. Tests: `A2.3.12.6.update.verify`, `.switch`, `.lock`, `.repair`, `.kill`, `.installed`, `.stage` (the swap in-process, a running copy of a system program for the refusals on Windows) and `.launchers` (the Verify line of M6.13: real builds whose launchers differ, each launcher killed staged, aside and placed while both run, then started through the stable command and through the supervisor).

On Linux and macOS no launcher is swapped: the stable command is a link to `current/bin/tasks` that no update replaces, and a journal lists no launcher there. The swap and the clean-up run on fixture files on every system.

1. Only the install's own command runs it, so an installed version vouches for its successor. Never an agent's shell, because it restarts the service.
2. **`update.lock`** for the whole update. A second update waits, then repairs what the first left. `install --finish` does not wait.
3. *(M10)* Fetch and verify the channel manifest and pick the version.
4. **Verify** with the installed keys before anything of the archive is unpacked, loaded or run, hashing the same bytes it unpacks. *(M10: the download into `<cache>/updates/<ver>/`, with size, hash and signature.)*
5. **Unpack** into a staging folder that the journal names before it exists, and reuse an equal version folder as in 3.12.4 step 7.
6. **Self-test** through the candidate's version-local launcher: `integrity`, `runtime` and the candidate rows of `version/candidate.ts`. They use the library, not a service start, because the service refuses an elevated token (CI's Windows runners) and the old service still runs.
7. **Ask** once before restarting a running service (3.11).
8. **Journal** each stable launcher the switch changes, with its old and new SHA-256. Then, on Windows, **stage** each changed launcher as `bin\<name>.new`, hashed while it is copied (so what is written is what was checked) and flushed. All of it happens before `current` changes, so the window after the switch is two renames per launcher, and a staging failure is a failure before the switch: the staged copies and the journal go, `current` stays.
9. **Switch `current`.**
10. **Swap the Windows launchers one at a time**, `tasks.exe` first (`placeLauncher` in `switch.ts`):
    - **One rename** replaces the launcher when Windows allows it: it does not run, and a version folder holds a copy of it (the update passes the old version's folder, a repair both versions'), so nothing later needs the file the rename destroys. The stable path is then never missing.
    - **Otherwise two renames:** Windows refuses to rename over a running launcher but lets it be renamed, so the old one goes aside to `.old-<n>` and the new one is renamed in. Only between the two is the path missing. While `tasks update` runs, `bin\tasks.exe` runs (it started the updater), so it always takes two renames, and `tasksw.exe` does while the service runs under it. A kill between them leaves no `tasks` command until the supervisor's next start (at sign-in, whose sibling repair puts it back first), a running service's 10 s repair, or `versions\<v>\bin\tasks.exe update --repair`; the renames are microseconds apart.
    - **Decided by hashes, not journalled per rename:** a launcher already at the wanted SHA-256 counts as swapped, and a rename that fails while the path now holds the wanted hash (a sibling repair got there first) counts as done. So every swap and repair is safe to run again and against a sibling repair racing it.
    - A staged or aside copy is renamed into place rather than copied. Going forward a repair takes the staged copy first; going back it prefers the aside copy, because it is the old file itself, so a supervisor that still runs from it is the file at `bin\tasksw.exe` again.
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

**A replaced supervisor.** After a repair that may have replaced `tasksw.exe` (`supervisorReplaced` in `repair.ts`: a journal that names it, or on Windows any unreadable journal, which cannot say which launchers its update changed), a service that runs under `tasksw` exits 75 (`update.restart`, `why: supervisor`), so the supervisor still running from the old file hands over at once (3.3.2). When the supervisor already is the new file, that is one restart more than needed, once. `tasks update --repair` and an update's own repair bring the service back as a supervisor change on the same rule.

**`--rollback`** goes to the previous version, self-tested first. A space the newer version migrated opens as `unavailable(format_too_new)`, and doctor names A1's pre-migration backup.

**A person's data is never touched.** The updater writes only `versions/`, `current`, `bin/`, and in `<state>` its lock, journal, `install.json` and the self-test's folders.

**A damaged version folder** is recovered by hand: move it out of `versions` and reinstall. Doctor's `integrity` row reports it. `tasks update --repair` may move it aside only under lease exclusion (not built).

#### 3.12.7 Code signing (later)

- **Windows.** Unsigned launchers run while Smart App Control is Off, so signing is not needed before the first install (M0-S13). Before the first public Windows build, sign `tasks.exe`, `tasksw.exe`, a native forwarder and the graphical installer through SignPath Foundation. Node's binary is already signed.
- **macOS.** Notarisation needs an Apple Developer account, and only a native forwarder would be a product Mach-O binary.
- **Linux.** The Ed25519 release signature and build provenance.

#### 3.12.8 What CI builds

GitHub Actions in `.github/workflows/`, third-party actions pinned by commit SHA. `check` runs `pnpm verify` on Ubuntu and Windows. `build` runs `pnpm build --sign test --check-reproducible` on Linux x64 and arm64, Windows and macOS, and `smoke` installs a test-signed build through each verifier path, refuses each tampered download and runs `pnpm accept m1 --installed` on the result. Signing happens by hand, outside CI (`pnpm release sign`).

**The build guarantees** (`scripts/build/`, `packages/launcher-win/src/build.ts`): the gate in every version folder; reproducible folders and archives per platform and runner image; no build-machine path in any built file; archives by Node built-ins with fixed modes, so an archive written on Windows unpacks runnable; no test hook in a release binary (`assertReleaseBinary`); and a version folder is never rebuilt over an existing one.

**Not built:** a `web` job that builds the UI once for every platform; `publish` in a release environment (archives, `SHA256SUMS`, signatures, SBOM in CycloneDX, provenance, install scripts, the GitHub release); Authenticode signing once SignPath accepts; and in the smoke: two parallel CLI writes, a bridge handshake and `tools/list` with the official MCP client, Host, Origin and CORS refusals, update from the previous release with rollback, and on macOS the wrapper with a stub service.

### 3.13 Diagnostics

Code: `packages/service/src/hub/log.ts`, `hub/crash.ts`, `packages/cli/src/doctor.ts` (its header lists the rows), `doctor-http.ts`, `accounts.ts`. Tests: `A2.3.13.hub.logs-content-free`, `A2.3.13.hub.crash-files`, `A2.3.13.cli.doctor`, `.doctor-http`, `.doctor-page`, `.doctor-version`, `A2.3.8.http.tags`.

**Logs** are local and **content-free by construction**: every event is an entry of one catalogue (`EVENTS`) with typed fields, no field takes a path or a message string, and the log drops anything else again at run time. Never logged: operation inputs and outputs, task text, context, prompts, briefs, tokens, codes, keys, HTTP bodies, environment values. Only the `service.lock` holder rotates the file. Bridges log only to stderr (3.7.2). Planned: `TASKS_BRIDGE_LOG=1` writes `<state>/logs/bridge-<pid>.log` for one session.

**Crashes** write a record to `<state>/crash/` and exit 70 at once. The record never holds the error's message or function names, because a name can be data. Node's fatal reports exclude the environment. Nothing is uploaded.

**`tasks doctor [--json] [--self-test] [--live] [--bundle]`** works without a service and opens no space database. Every check is non-interactive, so `--self-test` (for CI, the build, install and update) runs them all. Every program doctor starts is a helper of A3 3.14's runner, which ends it with what it started at its deadline and when doctor exits. Rows not built yet show as skipped. A1, A3 and A4 add rows: A3's agent rows are in `doctor-agents.ts`, loaded only by doctor, and `--live`, which spends tokens, runs only when asked (A3 3.14).
- `paths` says where the hidden data folder is. `config` reads `machine.toml` as the service does, with the same rule and words.
- `runtime` is loaded by a dynamic import only doctor reaches, so no other command loads storage.
- `accounts` counts other interactive accounts, never names them, and leaves out an agent app's sandbox accounts. v1 assumes one user per machine (3.8.6), so the row warns on every run and cannot be acknowledged.
- `http` self-tests the live listener: `Host: evil.example` gets 421, and `index.html` carries a fresh nonce that its `<meta name="csp-nonce">` repeats. The page's tags are read as a browser reads them (any attribute order, case, quoting, a self-closed tag), by `http/tags.ts`, the same reader `loadUiFolder` checks a built page with, so the build's spelling and doctor's reading cannot drift apart. `A2.3.13.cli.doctor-page` runs the check against the web build's own output.
- **Not built:** Windows ACLs in `paths` (3.2.2 rule 5); lock holder, file system and free disk in `spaces`; autostart (unit, Run value, Startup apps, LaunchAgent, linger, a moved separate install's old entries), packaged context, Smart App Control and updates.
- `--bundle` (not built) zips the output, logs and crash files after showing the list, with `--redact-paths` (home as `~`, space paths as IDs). The person attaches it by hand.

### 3.14 Resource budgets

On Windows and Linux with two spaces at A1's design scale (5,000 open and 50,000 done tasks each) and up to 10 agent sessions. A1 owns the shared numbers.

| Budget | Target | If missed |
|---|---|---|
| Service idle memory | RSS ≤ 120 MB with two spaces | Over 200 MB: heap profile, A1 reviews cache sizes |
| Service idle CPU | ≤ 5 s per hour, no idle timer under 10 s | Remove the wake-ups |
| Start to `ready` | Warm ≤ 1 s Linux, ≤ 2 s Windows. Cold ≤ 3 s and ≤ 6 s | Profile loading, lazier chunks |
| Space open | ≤ 300 ms, migrations excluded | A1 reviews |
| CLI call (`tasks show`) | Warm p95 ≤ 250 ms Linux, ≤ 400 ms Windows | Compile cache, lazy imports |
| Bridge | 3.7.7 | 3.7.7 |
| UI first paint after `tasks open` | ≤ 1.5 s | A5 and this appendix review the bootstrap |
| Install size | About 45 MB compressed, 130 MB per version | Over 250 MB: review assets |

**The local endpoint's memory** is bounded in time, not size: a connection's waiting output can reach about 528 MiB (64 replies of 8 MiB plus 16 MiB of lines) for at most 30 s after the peer last read. The peers are same-user processes, so the bounds guard against broken clients. Lower it through the in-flight and line limits or A3's per-operation limits. A service-wide cap belongs to the hub.

### 3.15 Interfaces assumed from other appendices

| From | Interface |
|---|---|
| A1 | A storage adapter in a worker that opens a space by path: open, close, operations, feed cursors and batches, backup, restore, claim, recovery. It takes `writer.lock`, writes `writer.json` and keeps both out of backups and exports. It reports `format_too_new` and migrates on open behind its own backup. It owns the design-scale numbers |
| A1, A6 | A space records its ID and owning machine. Another machine's space opens read-only (`not_authority`) |
| A3 | Operation names, schemas, error codes with a class of 3.10.3, CLI verbs, the MCP content for both eras and the offline content. The same tools on every connection, `run_report` checked per call. Classes mapped to principals, bindings from the bind context, the agent marker list, `agent_home` grant rows written by setup and the grant gate that reads them, session records in `<state>/sessions.json`, transport conditions as `reason` values, the writer scopes |
| A4 | The shim in rpc mode with its methods and credentials. `launch.open` (Open, Copy, `tasks brief`) on one launch machine per space. Launched work outside the service's cgroup or job, the session environment at launch, the URL opener, instances and terminals in `machine.toml`, the launch folders the hub names, `<state>/workdirs/`, `<state>/t3/` and `<state>/env-snapshot.json` |
| A5 | Bootstrap from the fragment code, the token in `localStorage`, the style nonce, no service worker, integrity on every asset, stored values untrusted, the space in each tab's route and every call (`tasks-space`), "Make default", `tasks-build` and the reload bar, cursors in `ui-state.sqlite`, the manifest's colours and icons |
| A6 | Same-user processes inside the boundary, the class a guard. T1 narrowed to a single-user machine for v1, with the M10 gate. The secrets folder's ACL. `device` grant rows from L1 |
| A7 | The real-machine checks of section 5, the native forwarder if needed, M10's gate |

---

## 5. Verification

Every built part has its tests in the repository, each with an `A2.3.*` ID in `tests/manifest.json`. The sections above name the test IDs that pin them. This section names what is not built or not testable yet, and the checks that need real machines.

**To add with their steps.**
- The space worker restart: requests retried with the same ID return the stored result.
- With the retirement step: an update while bridges run on Windows, then garbage collection.
- A routine through a restart: a run whose bridge initialised offline reports with full coverage after the reconnect.
- **The Windows install bootstrap** under both conditions: Windows PowerShell 5.1 started from PowerShell 7 on code page 65001 with 5.1's own `PSModulePath`, and on code page 437 with PowerShell 7's inherited. `ssh-keygen` gets exactly the bytes of `SHA256SUMS`, the install completes, and four tampered downloads are refused. 5.1 is started with `Process.Start`, because PowerShell 7 rewrites `PSModulePath` only for a `powershell.exe` it runs itself, and the test never clears `PSModulePath` first. (The M0 spike's `A2.3.12.4.spike.install-verify` covers the first condition.)
- The UI in Chromium and Firefox: another loopback port cannot read the token, call the API or open the WebSocket; React Aria works under the production headers once the page uses it.

**Cross-user tests run only in CI** (`A2.3.8.http.cross-user`), on throwaway runners where the test creates the second account. No second account is made on a real test machine. Built: that account on the persisted port leaves no UI, every UI token revoked and the CLI working, and its connections to the UI port are closed. Still to add: it cannot reach the socket or redeem a code read from the process list, its planted assets never run in the first user's browser, and on Windows it opens the pipe at most read-only while the holder check sees its listener without admin rights.

**Not tested:** peer credentials (Node cannot read them, and nothing needs them), macOS (no machine), Linux arm64 installs (CI will), the install scripts' natural verifier choice on a machine with OpenSSH older than 8.1 or without OpenSSH (the tests force each path), the root refusal as root, two installers racing for one root (the tests hold the install lock from another process), the real release key. For the updater: a real systemd, launchd or Explorer restart (stand-in tools cover the routes; the supervisor is started as the Run value names it), a Windows ACL check of an existing version folder, power loss and fsync order (a process kill only), and a launcher's sibling repair racing a live updater in real processes (the swap's tolerance is tested in-process).

**M10 gate test** (CI only, with the authenticated origin in place). A signs in, uses the UI, installs the web app and stops the service. B binds A's port and serves a page that tries to read `localStorage`, register a worker, plant cached assets and stay open. A reloads, opens the bookmark and the app, and starts the service again. Pass: B gets no usable credential or draft, never runs as A's authenticated origin, and reaches A's service as A in no request. v1 is expected to fail it, which is why v1 is limited to single-user machines.

**Real-machine checks**, on a Windows machine and a Linux machine (Ubuntu 24.04 without sudo), same-user only:

| ID | System | Check | Pass |
|---|---|---|---|
| M0-S1 | Both | Runtime gate with the pinned Node | All items |
| M0-S2 | Both | Bridge measurements (3.7.7) | Rule applied |
| M0-S3 | Both | Budgets (3.14) | Met, or rule applied |
| M0-S4 | Linux | Release-script install into a `TASKS_HOME` folder without sudo, `tasks service install`, start before and after GUI login with linger, `systemctl --user restart` with a terminal and a run alive | Works, both survive |
| M0-S5 | Linux | `tasks open` into the Firefox snap: code, token, reload. Chrome `--app` and install without a service worker | All work, versions recorded |
| M0-S6 | Linux | Peer UID check with the Firefox snap | Own connections accepted |
| M0-S7 | Windows | `install.ps1`. The Run value starts `tasksw.exe` at sign-in without a console, survives sleep, runs 24 h, restarts after `taskkill /F` of `node.exe`, gives up after 5 failures. Turning it off in Task Manager is detected | All hold |
| M0-S8 | Windows | Packaged parents, P-1 to P-6 (3.5) | As stated there |
| M0-S10 | Both | The UI port held by this user's own process at start: fallback port, the notice, a squatter that fails the probe refused | All hold |
| M0-S11 | Both | Update to a newer test release and back, with a bridge running | Reconnects, rollback works |
| M0-S12 | Both | Socket or pipe reachability from inside Codex's and Claude Code's sandboxes | Recorded, the CLI hint matches |
| M0-S13 | Windows | Smart App Control before the first install | Recorded. On: signing moves before install |
| M0-S14 | Linux | A `TASKS_HOME` install beside the daily one, daily calls before, during and after | Different ID, folder, socket, port and unit; every daily call succeeds; the test install cannot open the daily spaces |
| M0-S15 | Both | Doctor's other-accounts check | Recorded and shown to the maintainer |

Open: M0-S5, S6 and S8; the boot and sign-in halves of M0-S4 and S7 (with the product's own service install); the rest of M0-S12 (Codex's elevated Windows sandbox, Claude Code's sandbox); M0-S2 on a release build; M0-S3 with the budgets of M1.15. The rest passed.

---

## 6. Open items

1. **Firefox web apps on Linux.** Nothing depends on them. M0-S5 records the state.
2. **Package identity of everyday terminals.** Expected none. If not, rule 4 of 3.5 changes (P-6).
4. **SignPath application**, possible once the repository is public. Not blocking while Smart App Control stays Off.
5. **macOS** is untested until a Mac is available: the LaunchAgent and wrapper under launchd, paths, the `lsof` checks. A socket-owner call without privileges would replace `lsof`.
6. **Reverse-DNS prefix** for the launchd label, chosen before M10 under the brand rules.
7. **Authenticated UI origin for M10** (3.8.6), chosen before M10 work starts. Per-user HTTPS needs a way to trust a local certificate in Firefox's own store and the snap's profile without sudo.
12. **Moving a space** is a later step (A7, section 6), built on A1's transfer and claim primitives rather than on checks followed by renames or deletes, which leave a window between the check and the act. Its rules:
    - The source is retired durably, and that is confirmed, before anything else. No moment has two writable copies.
    - The destination folder is created exclusively and becomes a space only when its manifest is written, last.
    - The product deletes or overwrites no file that may hold data.
    - An interrupted move leaves the space closed and names both folders and the two commands that finish or cancel it.
    - The old copy is kept until the person removes it.

    That step decides here how a move changes `[[spaces]]` (3.2.4), what the next start does with an interrupted move, and where `space list` and doctor report a kept old copy.
