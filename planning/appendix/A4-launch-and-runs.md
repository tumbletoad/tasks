# A4. Launching agents and background runs

> What is left in this document is background for parts that are not built yet. The code and its tests are the source of truth for everything that is built, and `docs/promises-and-limits.md` says what a person can count on. Do not add to this document.

## 3. Specification

### 3.2 Targets, instances and approval (R10)

**Built** in `packages/launch/src`: the catalogue (`catalogue.ts`: targets, routes, budgets, permission flags, tested versions), the `machine.toml` sections A4 owns (`sections.ts`: `[terminal]`, `[[instance]]`, `[approvals]`), detection (`detect.ts`) and approval hashes (`approval.ts`). Tests: `[A4.3.2.catalogue.invariants]`, `[A4.3.2.detect.golden]`, `[A4.3.2.detect.real]`, `[A4.3.2.approval.hash]`.

- **`[roots]` and `[roots.*]` are no longer used** (A1 3.15). The reader still accepts a file that holds them and ignores them, `ttasks doctor` names them once as no longer used, and TTasks never edits them away: the file is the person's. Until M6.16 the reader parses them and `root_rev` (`packages/service/src/config/root-revs.ts`, `<state>/roots.json`, `[A4.3.2.root-rev]`) is kept; M6.16 retires both and leaves an existing `roots.json` where it is.

- **The catalogue is code**, so the user never types bypass flags. Custom targets are `custom:<slug>`. `[[custom_target]]` and `[override.*]` are passed by unread until the route steps read them.
- **Instances** live only in `machine.toml`, never synced or exported. A bad entry is dropped, never guessed, so a half-understood instance is never launched.
- **`manual` is no instance ID.** It is the instance of an MCP entry without `--instance` (A3 3.7.4, 3.7.8), so the reader refuses it (`invalid_value`): an instance of that name would share that entry's actor, writer scope and grant rows.
- **One home rule.** `instanceHome` in `detect.ts` decides which home an instance runs, and the link route, Codex's `env_vars` check, the reference match and `ttasks setup agents` all call it, so they cannot disagree. Never add a second rule. The reader drops an instance whose `env` would make the agent's home differ from the rule (two names differing only in case on Windows, a relative home variable).
- **Detection proposes, the user confirms**, and detection writes nothing. A second home is a folder `.claude-<suffix>` or `.claude_<suffix>` (the same for `.codex`) whose suffix can be part of an instance ID; `_` is the form T3 Code's documentation suggests. Both give the instance `claude-<suffix>`. It never opens a file in an agent home and never reads or runs a wrapper or a `.cmd` shim, because a wrapper may select a home that must not be used on that machine. T3's `.cmd` shim on Windows is proposed as the T3 instance's `exec` (`FoundCommand.shim`), which only the T3 CLI route reads (3.4.1). Its caller passes the agent environment of 3.8, never the service's. App-bundled CLIs are never proposed, but a copy on PATH is not yet excluded (6.12).
- **`ttasks setup instances`** is how the person confirms from the command line (A5 3.17 step 3's counterpart, which A7 3.6's cut leaves to the CLI). Code: `packages/cli/src/setup-instances.ts`, the service's `instances/add` and `instances/remove` in `packages/service/src/hub/instances.ts`. Tests: `[A4.3.2.setup.instances]`, `[A4.3.2.setup.instances-service]`, `[A4.3.2.setup.instances-follow]`, `[A2.3.2.4.config.edit-remove]`.
  - The preview (the default) runs detection in the person's session and environment, shows each agent command with its version and each home, the instances `machine.toml` names, and the exact `[[instance]]` blocks it would add, with the apply command and its plan token. It writes nothing. `--apply --plan <token>` adds exactly those blocks, or changes nothing when the proposal changed. The same apply run again after it worked says the entries are there and exits 0: the plan's entries, proposed as if `machine.toml` named no instance, are each in the file exactly as the apply wrote them. `--remove [--instance <id>]` takes out what it added.
  - It proposes Claude Code and Codex homes whose command was found (`instanceEntry` of a proposal with no needs). A wrapper without a home of its suffix and a home without a command are named with what is missing, for the person to write by hand. There is no question and no wizard.
  - **T3 Code** gets one complete instance per enabled `codex` or `claudeAgent` provider instance in T3's settings, read as A3 3.13.6 reads them (`t3Proposals` in `packages/service/src/setup/hosts.ts`): ID `t3-codex` and `t3-claude` for T3's default instances, else `t3-<provider instance>` in instance-ID form; label T3's display name, else T3's own name for the driver (`Codex`, `Claude`); account the home folder's suffix, else `default`; `t3_environment = "local"`, `t3_provider_instance` and `t3_model`; the detected `t3` command as `exec` when there is one. T3 is there when its command is, or its folder: the one `T3CODE_HOME` names when that is an absolute path, else `~/.t3`, the rule setup reads T3's settings by, so a T3 kept elsewhere without a command on PATH is still found. One whose provider instance a T3 instance of `machine.toml` names already is not proposed. With none enabled, T3 is named with what to do.
  - **The model** a T3 instance needs (the paired route refuses a provider instance without one, 3.4.1) is T3's own `defaultModelSelection` when it names that provider instance, else the catalogue's default for the driver (`t3Models`: T3's own defaults at commit `f82162f`, `gpt-6-astra` for Codex and `claude-opus-5-5` for Claude). The preview says which, and that another model is a change to `t3_model` in `machine.toml`. A default can go stale as models change. That costs one failed launch with T3's own message and a one-line fix, while asking every person for a model would stop the proposal being complete.
  - The service's `instances/add` takes a T3 entry only with all three T3 keys, and the T3 keys only on a T3 entry.
  - A home `ttasks setup agents` registered first keeps the instance ID its entry names, so the entry, the grant row and the instance agree. An ID `machine.toml` already has is never proposed.
  - Apply and remove run only for a person at a terminal, and the service checks the class again. The service writes through A2's splice editor (exact modes, no link followed, a file another user can change refused), refuses an entry the reader would drop before anything is written, records each entry in `<state>/instances.json` before the write, and removes an element only while it is byte for byte as written: one the person changed is left (`edited`, exit 10), and one gone from the file loses its record. **Every `instances/add` and `instances/remove` ends, whether it succeeded or failed, by setting the service's instances to those `machine.toml` holds then**, read as at start (a file that cannot be read keeps them), so Open offers them at the page's next snapshot without a restart, and what it offers is the file's also after a write whose bookkeeping failed (`[A4.3.2.setup.instances-follow]`). The record is taken back only when the file was not written; a record entry the file lacks is harmless (a retry records it again, a removal reports it `missing` and drops it), so a retry of the same command ends consistent.
  - It changes nothing in any agent app. Registering the product's tools in a home is `ttasks setup agents` (A3 3.13), which an agent needs to read and update the task. Doctor's `instances` row says which is missing: no instance (run `ttasks setup instances`), or an instance whose home has no entry (run `ttasks setup agents`).

**Instance rules** (to build in the UI):
- The action strip shows the first 14 characters of a label (1 to 40). The permission shows on hover and in the accessible name: "Open in Codex · work (full access)".
- **Account check.** When the task's space is not in the instance's `spaces`, or its area's allowed accounts exclude the instance's `account`, Open asks "This task is in Work. Codex · personal is for personal work. Open anyway?" A strict area blocks it.
- Two enabled instances never share glyph and colour ring (A5), and the label always names the account.
- **Reserved for L1.** A6 lets a remote command use only an instance with `remote_allowed = true`.

**Space references** (A1 preferences) hold only the default instance per space and area, pinned instances and their order, hidden targets and the brief template choice. An instance ID unknown on this machine shows "Not set up on this machine" and offers Copy.

**Definitions that arrive with data** (a custom target or a routine) are executable intent:
1. The approval hash covers a domain line, the kind and the definition's canonical JSON (built). The kind keeps a routine's hash from approving a target with the same JSON.
2. Without a matching hash the item shows "Needs approval on this machine". Preferences shows the exact argv for a sample task, with Allow and Deny.
3. `[approvals]` stores `<hash> = "allow" | "deny"`. Only an exact `allow` approves. Deny keeps the same content from asking again. Any change re-disables the item, and the card shows a diff.
4. Approval is user-only (UI session or interactive TTY CLI). Agents cannot approve (R7). It writes `machine.toml` through A2's splice editor.
5. A space opened from an import or a copy starts with every space-defined target and routine disabled on every machine.

**Fixes without a release.** `machine.toml` may override single fields of a built-in route, for example `[override.claude-desktop.link] url = "claude://code/new?folder={cwd}&q={brief}"` or a `budget`. Doctor shows every override.

Custom targets in `machine.toml` need no approval: the user wrote them. Their templates follow 3.6.4. `shell = true` is allowed only there, and TTasks then exports values as `TTASKS_*` variables instead of substituting them into the shell string.

### 3.3 Exact folders (R11)

A launch's folder is the one A1 3.15's `resolve` gives on this machine: the task's own folder, else its project's, else none here because one of them lives on another machine, else the space's TTasks work folder. **Built** on the old model, a root and a relative path: `resolvePlace` and `checkWorkingFolder` in `packages/launch/src/places.ts`, whose header states the guarantee and its residual, and `packages/launch/src/shim/folder.ts`. Tests: `[A1.3.15.places.*]`, `[A4.5.shim.folder]`, `[A4.5.shim.work-folder]`, `[A4.5.launch.open-replay]`. M6.16 replaces the place resolution with `resolve` and keeps the in-folder check.

Before any route runs:
1. `resolve` names a folder on this machine. When the task's or its project's folder lives only on another machine, the slot shows "Opens on <machine>" and only Copy works (`other_machine`).
2. **The launch check**, at the click and again right after Dispatching commits: the path, `~` expanded with this machine's home, exists and is a directory. Otherwise the instance is unavailable with "Folder not found on this computer" (`folder_missing`, `not_a_directory`) or "Folder did not answer" (`not_answering`, a look bounded at 2 s, A1 3.15), and the expanded task offers Choose folder. Nothing else is checked: TTasks uses whatever folder is at the path, as T3 Code does, and keeps no record of which folder was there before.
3. The route lands in exactly this folder.
   - **`cwd` routes** (the shim). The plan names the folder row (or the work folder) and its path. The path and the identity the launch check saw reach the process in the claim reply, never in argv, where Windows Terminal splits on `;` (L10), or the environment, which the agent inherits. The process enters the folder itself, because terminals and their profiles may override a start folder, runs `checkWorkingFolder` before anything else (the folder it entered is the directory the launch check saw a moment before), and starts the agent without a working-directory option. Never resolve the path again after that check: it may name another directory by then. The check is about that moment, not a record kept with the folder.
   - **`param` routes** and T3 get step 2 plus their own checks (T3 compares the thread's folder by identity, 3.4.1). `claude-cli` rejects UNC paths, so a UNC folder disables that route.
4. If no route of the instance can land in the exact folder, the instance is disabled for this task with a one-line reason. Other instances and Copy stay. TTasks never substitutes a parent, a sibling clone, another clone of the repository, a scratch folder, the home folder, the current folder or the last folder used, and never the project's folder for a task's own that is missing.

**Tasks without a folder** (`none`, decided by `resolve` like `other_machine`) use the space's TTasks work folder on this machine.
- It is never inside a space or a project folder: it lives under `<state>`, inside the TTasks home, where no folder binds (A1 3.15). `ensureWorkFolder` checks it more strictly than the state folder, because an agent works there with the person's rights, and makes nothing through a link. Then it takes the launch check like any folder.
- TTasks never empties or removes a work folder or a routine's work folder. What an agent made there stays until the person removes it.
- Every route treats it as the task's folder. T3 asks "Register TTasks work folder in T3?" once (3.4.1). Steps 2 to 4 apply.
- No folder lease. Per-task and machine caps apply (3.11.7).
- The resolution's `kind` is `task`, `project` or `work_folder`. A5 and the pointer brief call the last "TTasks work folder".
- A task whose resolution names a folder uses exactly it. A folder that is missing or on another machine stays unavailable with its reason and never falls back to the work folder.
- Agents still cannot launch (R7).

### 3.4 Launch routes per target

#### 3.4.1 T3 Code (native, priority)

**What T3 offers** (the parts the built route encodes are in `t3-*.ts`):
- A thread's folder is `thread.worktreePath ?? project.workspaceRoot`. There is no per-thread folder, so a thread runs only at a project root or in a git worktree.
- `t3 thread start <project|path> <message|-> [--title --provider --model --json]` resolves a path to the **deepest containing project** and always sends the message. So the CLI is given a project ID, never a path. T3's command line has `project add`, `project remove` and `project rename`, and **no `project list`** (commit `f82162f`).
- `t3code://new` resolves only GitHub slugs and is never used.
- `providerInstances` give each provider instance its own home (T3 sets `CODEX_HOME` or `CLAUDE_CONFIG_DIR`). A3 3.13.6 has their shape.
- `t3_thread_read` returns status, `worktreePath`, runs and messages. `t3_thread_wait` long-polls up to 60 min. `t3_thread_interrupt` stops a run.
- A project can be created for any existing folder, nested or not, without git. The only conflict is another active project with the same root. Creating projects needs full access.
- No trust prompt: registering a project is the trust step.

**Built** (the `t3-mcp` route and pairing): `packages/launch/src/t3-*.ts` (`T3Route` in `t3-route.ts`, `t3-binding.ts`, `t3-oauth.ts`, `t3-client.ts`, `t3-state.ts`), the rpc methods in `packages/service/src/hub/t3.ts`, `ttasks setup t3` in `packages/cli/src/setup.ts`, the fake T3 server in `packages/testkit/src/fake-t3.ts`. Tests: `[A4.3.4.1.t3.*]`, `[A4.3.16.t3.state]`, `[A4.5.t3.*]`. No T3 server has been observed yet (M0-L05, M0-L06): answer shapes, the runtime file's field, the discovery paths and the MCP era are assumed, and the fake follows them. Neither T3 route is connected to Open: a T3 instance is `no_route`, no T3 intent can be made, and recovery treats a T3 intent as unpaired (Unknown). 3.9.1 lists what connects them.

**Exact-folder binding (R11).** Tasks maps a resolved folder `P` to a binding by directory identity and never uses T3's path resolution, which T3 does not normalise.
1. List all projects, all pages, without archived and deleted ones.
2. **Exact root:** a project whose root has `P`'s identity binds as `root`.
3. **Existing worktree:** `P` is a linked worktree that a project's repository lists. Git is read from its files, never started. A main checkout with a `.git` file and a bare repository are never bound as an existing worktree, so their cases ask.
4. **Otherwise** (a plain subfolder, an unregistered clone, a new folder) the Prepared step asks once: **"Register tidy-logs › docs as a T3 project?"** with Register and Not now. Register calls `t3_project_create {workspaceRoot: P, title: <the TTasks project's name, else the folder's last name>}` and binds again. A folder that still binds nothing is unavailable, never bound elsewhere. Not now makes the instance unavailable for this task ("T3 opens only registered folders"), remembered per folder for 30 days.
5. There is no binding cache: every Prepared step lists the projects again.

TTasks never registers a project without asking, never uses a containing project, and never uses T3's undocumented WebSocket launch route, which skips the worktree check. Step 4's question goes once T3 offers a per-thread working folder (6.1).

**Primary route: `t3-mcp`.**
1. Resolve the binding (Prepared). An instance with a provider instance and no model is refused (`model_required`): without a model, T3 would silently use the project's default account.
2. Write the call's plan to machine state, so a repeat after a restart sends the same call, then commit Dispatching with the current grant ID. Call `t3_thread_launch` with **no message** and the launch ID as `clientRequestId`: an idle thread, no agent turn. The token is compared with the intent's grant in one synchronous step, never refreshed there.
3. A returned `threadId` is Dispatched. **Only an answer that proves no tool ran is `refused`** (a refused connection, a 401, an HTTP 4xx, a JSON-RPC error to `initialize`). Everything else is `unknown` and repeated once under the same grant. A wrong `refused` would make the launch Failed, and the next click a second thread.
4. Read the thread. Its folder with `P`'s identity confirms the launch. A mismatch fails it with `folder_mismatch` ("T3 bound a different folder") and keeps the thread for inspection.
5. Open the thread link with the prefilled brief (3.6.5). A brief over 8,000 characters is left out. If opening fails, the launch stays Confirmed and the receipt offers "Open in T3".

**Pairing.** `ttasks setup t3` (or Preferences › Targets) registers TTasks as an OAuth client of the local T3 server and asks the user to grant full access.
- The service runs the flow, so the service lock's holder is the one writer of T3's state and every launch sees a new grant at once. The CLI only opens the authorization URL, because only the CLI surely runs in the desktop session.
- The token lives only in `<state>/t3/pairing.json` and the Authorization header. Every endpoint that receives a secret must be on loopback.
- A 401 means "Reconnect T3" only when the refused token had not yet expired: an expired token explains the 401 while its refresh token may still work.
- Doctor's `launch.t3` row (A3 3.14) reports the pairing from `t3/status`, which gives the token's expiry (`expires_at`) and whether the pairing renews it (`renews`: it holds a refresh token), also while T3 is not running. It warns 5 days before a token that cannot renew itself runs out, and after. A token that renews is not warned about: the route refreshes it before each call, and an access token's own short life would otherwise warn at every run.
- TTasks never reads T3's secrets or database and never mints T3 sessions.

**T3's origin** is read from `<T3 home>/userdata/server-runtime.json` for every connection, because T3 may change port. On Linux and macOS the file is judged by its descriptor, and its folder too, by A2 3.2.2 rule 5 (the person's own, no link, no write by every user, and no group write unless the group is the person's own private group, which an app that sets no mode makes under umask 002), because it says where the token goes. A file that fails reads as `not_running` ("Start T3 Code") with no word of why (6.14).

**Grant identity.** T3 derives an idle thread's ID from the OAuth session's namespace and `clientRequestId`. A new authorization makes a new namespace, so the same key would make a second thread. Each authorization therefore gets a grant ID, recorded on every T3 intent at Dispatching, and a repeat is sent only while the pairing still holds that grant. A refresh also starts a new grant ID (`REFRESH_KEEPS_GRANT = false`) until M0-L05 shows that a refresh keeps T3's namespace (6.6).

**Fallback route: `t3-cli`: off.** T3's command line has no `project list` (commit `f82162f`), so this route can never bind a folder to a project: every Prepared step would fail closed. Until a T3 has one, the paired route set up by `ttasks setup t3` is the only T3 route. `chooseT3Route` takes the CLI route only when `T3_CLI_ROUTE` (in `t3-cli.ts`) is on, and it is off: an unpaired instance is `not_paired`, "Pair TTasks with T3 Code first: ttasks setup t3", whether or not it names a `t3` command, also when the person picks the CLI. The route's code and its tests stay, run with the route turned on, because a T3 that adds a project list would make it work as specified below. Keeping it costs less than rebuilding it, and turning it on is then one change after a real-machine check of the list's output (M0-L06).

The route as built (not paired, exact-root bindings only; it cannot attach a worktree). **Built:** `T3CliRoute`, `chooseT3Route`, `parseT3Shim`, `t3CliCommand` and `runT3Cli` in `packages/launch/src/t3-cli.ts`, the CLI's reasons in `T3Unavailable` and `T3_TEXT` (`t3-route.ts`), and a fake `t3` (`packages/testkit/src/fakes/t3-cli.ts`, `FAKE_T3_CLI`) that needs a running `FakeT3` and lets it do the work. Tests: `[A4.5.t3.cli-route]`, `[A4.3.4.1.t3.cli-command]`. No T3 command line has been observed yet (M0-L06). Assumed: `t3 project list --json` exists and prints `{projects: [{id, workspaceRoot, archivedAt?}]}` or the bare list, `thread start`'s flags and answer as below, that the CLI needs T3's server, and the shim's form. Each assumption fails closed: an unreadable list or answer is `no_answer` or Unknown, and a shim of another form makes the route unusable.
1. **Prepared** lists T3's projects through the CLI and binds with the paired route's `bindFolder`, so "exact root" is the same fact on both routes. A project whose root has the folder's identity binds with its ID. An existing-worktree binding is `worktree_needs_pairing`. Any other folder asks Register as in step 4 above, and Not now is the same 30-day answer in the same file.
2. **Register** runs `t3 project add <P>` with the folder's real path, then lists again. Its own answer is not trusted: a folder that still binds no exact root is `not_registered`.
3. **Stage**, after the click and in the same call as the dispatch: the command line, its environment and the brief, kept in memory only (at most 64 launches), so a service restarted in between leaves the intent to expire in Prepared. The project's root as the CLI last listed it and the task's folder must still have the bound identity (`folder_changed`).
4. **Dispatch** reads T3's project list again (within 8 s), because T3 may change a project's root or archive it after the stage, and starts the thread only if the project is still listed and its current root and the folder still have the bound identity. Then `t3 thread start <projectId> - --json --title <reference> [--provider <provider instance> --model <model>]`, with the sent brief on stdin, within 20 s, so both fit the machine's 30 s step deadline. The answer is `{threadId, projectId, runId}`. The staged command is taken at the dispatch, so a launch's CLI runs once. 3.9.2 gives the states.
5. Open `t3code://threads/<environmentId>/<threadId>` without a prompt when an environment ID is known (the CLI's answer, else a pairing's, also one that needs reconnecting). Otherwise the thread is not linked, and T3 lists it.

What reaches the command line:
- An argument array spawned without a shell, in T3's home, never in a project of the person's. `thread start` gets only the bound project's ID, checked against the evidence-ID pattern, so it never reads as an option or a path.
- **The thread's title is the task reference only** (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), never the task's title, because other local users can read a command line. The sent brief carries the title.
- The provider instance and model go only together (`model_required`, `provider_required`) and only as one word that cannot start with `-` (`invalid_instance`). The brief is non-empty, well-formed and within the route's `maxPrompt` (`too_long`). It is sent, so it ends with "Read the task, then wait for my instructions".
- **A permission the CLI cannot keep is refused** (`mode_needs_pairing`). The CLI has no runtime-mode flag, and the thread gets the project's default, T3's `full-access` unless set otherwise. So only `inherit` and `full-access` instances use the CLI: a `read-only` or `auto-edit` instance would get more access than it asks for.
- The environment is built as an agent's (3.8), then gets `ELECTRON_RUN_AS_NODE` only when the shim sets it, and `T3CODE_HOME` set to the T3 home the route reads, so the CLI speaks to the T3 whose runtime file decided availability. A shim that names another home is `cli_unusable`.
- Refused before anything starts: a folder path with a control character or a lone surrogate (it could not reach the CLI as the same bytes), a project ID or reference that is not an ID, and a launch with nothing staged.

**T3's `.cmd` shim on Windows** (`%USERPROFILE%\.t3\bin\t3.cmd`, proposed as the instance's `exec` by detection, 3.2) is never run: cmd.exe re-parses its arguments, and `%`, `^`, `&` and `!` in a folder name would change meaning, which no escaping makes exact. The route reads it when it uses it (16 KiB at most) and accepts only a strict form, or the route is unusable (`cli_unusable`):
- `@echo off`, `setlocal`, `endlocal`, `rem` and `::` lines; at most `T3CODE_HOME` and `ELECTRON_RUN_AS_NODE` (`1` only), set with `set "NAME=value"` or `set NAME=value`; exactly one command `"<exe>" ["<arg>" …] %*`; then optionally `exit /b [%errorlevel%]`. `%~dp0` may start a value or a word. No other `%`, none of `^ & | < > !`, no trailing blank, ASCII only (cmd reads the file in the console's code page), and an absolute executable that is no script.
- The command is one of T3's forms: `node.exe <entry>` (npm's), `<app>.exe <entry>` with `ELECTRON_RUN_AS_NODE=1` (the T3 app's Electron, run as Node), or `t3.exe` alone, where the entry is one absolute JavaScript file. Never a command processor or script host (`cmd`, `powershell`, `pwsh`, `wsl`, `bash`, `cscript` and the like) and nothing under `<drive>:\Windows\`: cmd.exe re-parses its arguments even when started directly.
- An instance's own `exec` on Windows ends in `.exe` exactly, because Windows completes `…\cmd` to `cmd.exe` and trims trailing dots, and is no command processor either. A `.ps1` exec is refused.
- The executable is spawned directly with the shim's arguments and `args_prefix`. Node quotes each argument by the MSVC rules that `CommandLineToArgvW` and Electron read, so every name a Windows folder can have arrives exactly. When M0-L06 shows the real shim, the parser may gain a form, never a looser one.
- On Linux and macOS `exec` runs as it is: a script runs through its own `#!`, which receives the arguments as an array.

**Native ID:** the returned thread ID. Resume opens the thread link. TTasks never resumes a T3 session through the provider's CLI. **Binding input for A3:** the launch reference, the returned thread ID, and `T3CODE_THREAD_ID` if the bridge sees it.

**Availability.** A T3 target needs a reachable server. On Windows the server lives in the T3 desktop app, so with the app closed the instance offers "Start T3 Code", which starts it through the OS shell, outside any app container. On Linux T3 may run as a user service (`t3code.service`) that the desktop app reaches through T3 Connect.

**The choice of route** (`chooseT3Route`) uses only what both routes already read: machine state, T3's runtime file and the instance. It makes no request, starts no process and does not poll. With the CLI route off (above) it is `t3-mcp` when paired and T3 runs, else the paired route's reason. With it on:
- The person picked the CLI: `t3-cli`, or why it cannot be used.
- Paired and T3 running: `t3-mcp`. Paired and T3 not running: `not_running` ("Start T3 Code"). A pairing to reconnect: `reconnect`, and the person may pick the CLI.
- Not paired: `t3-cli` when it can be used, `not_running` when it could once T3 runs, `not_paired` when the instance names no `t3` command, else the CLI's reason. Only this case takes the fallback by itself (3.4: unavailable before dispatch).

`t3/status` reports whether T3 runs and, for each enabled T3 instance, the route a click would take or why none, and `ttasks setup t3 --status` prints one line per instance.

### 3.6 Terminals and the launch shim

#### 3.6.5 Opening URLs

**Built:** `packages/launch/src/opener.ts`, `[A4.5.routes.opener]`. The URL is always one argv element, with no shell, and never `cmd /c start`, which mangles `&`. A fallback opener runs only when the one before it never started, so a link never opens twice.
- **gio's non-zero exit is `unknown`.** gio gives one code for "no handler" and for a handler it gave up waiting for, which may still open. A code the lab proves to mean "no handler" (M0-L09) may become `no_handler`.
- The service opens only URLs whose scheme belongs to an enabled target. MSIX link budgets stay at 2,000 until measured (M0-L09).
- To build: `ttasks open` (`packages/cli/src/open.ts`) and `ttasks setup t3` still carry minimal openers of their own, and `T3Route` takes its opener as an option. All three move to this module.

### 3.8 The agent's environment

The service may have started before login with a minimal environment, and Windows Terminal ignores the caller's environment. So the service computes the agent's environment at the claim, and the shim applies it as it is.

**Built:** `packages/launch/src/environment/` (the layers, the snapshot and its bounds) and `packages/launch/src/shim/environment.ts` (the home rule, the scrub and the additions). Tests: `[A4.5.environment.*]`, `[A4.5.shim.environment]`.

- **The base** is the person's own environment, taken whole, because what a profile exports is what the agent needs: on Linux and macOS the session layer over a login-shell snapshot, on Windows the registry's environment. The service's own environment through an allow-list is the last resort. A user unit's own environment lacks CLIs installed through nvm, which is why the snapshot exists (M0-L11 measured it).
- **The snapshot** runs in a minimal environment, so nothing of the service's own comes back in it, and is refreshed in the dispatch step, so the claim never waits for a shell. Doctor's `launch.env` row (A3 3.14) warns when the last attempt did not succeed, with the age of the snapshot still in use or none. `ttasks doctor --live` takes one now, fresh or not, and keeps it when it succeeds. Plain doctor never runs the person's login shell, so a test or a script that runs doctor runs no profile (`UserEnvironment.check`, test `A4.5.environment.doctor`).
- **The registry layers** are read at each claim by Windows PowerShell 5.1 in a minimal environment of system names, within 5 s. Its script calls .NET only, never a cmdlet: PowerShell finds a cmdlet by searching the modules on its module path, and in that environment the search took 12 s on GitHub's Windows runner, with a few hundred modules installed, so every launch there fell back to the service's environment. A read that fails makes the claim fall back to the service's environment, never a partial one: the script reads keys and values through the shared reads of `packages/launch/src/windows-reads.ts` (A1 3.2's pitfalls say why `OpenSubKey` and `GetValue` alone cannot tell a failure from absence), and the parse takes only complete output that ends in `end`, after every byte of it was checked to be one the script writes (`scriptOutput`: decoding first would turn bytes that are no text into valid lines).
- **Home variables** (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) are removed from the base, so only the instance selects a home (3.2). Pinning the default home instead is not equivalent for Claude Code, whose `.claude.json` moves into a named folder.
- **The scrub** runs after merging, over the instance's own values too. A leftover `CLAUDECODE=1` makes Claude refuse a nested session, and a leftover session ID binds the wrong session.
- **Added:** `TTASKS_TICKET` (bridge role), `TTASKS_TASK` and `TTASKS_SPACE` as hints. Never a token.
- **`via_login_shell = true`** (default false, Linux and macOS) takes a snapshot of its own in the task's resolved folder in the dispatch step. It is never a shell around the agent: a profile run there would run after the folder check and the scrub, so a `cd` in `.bashrc` would move the agent out of the checked folder and an exported `NODE_OPTIONS` or `CODEX_HOME` would undo the scrub.

To build: `ttasks doctor --live` asks the user to run `ttasks doctor env-capture` in their own terminal and compares names and value hashes with what the shim would build.

### 3.9 Launch intents and receipts (R8)

#### 3.9.1 State machine

| State | Meaning |
|---|---|
| **Prepared** | Written at the click. The UI may ask questions (account warning, "Register in T3?", trust). Nothing external has happened |
| **Dispatching** | Committed immediately before the external call. The crash boundary |
| **Dispatched** | The OS or API accepted the call. Proves nothing about folder, account or session |
| **Confirmed** | Route evidence that a session exists in the exact folder (3.9.2) |
| **Failed** | Definite evidence that the launch gave no usable session in the exact folder |
| **Unknown** | TTasks cannot tell. Never retried, and never leads back towards a dispatch |

What the code guarantees, and why (`machine.ts` and `intents.ts` state the rest):
- **A record holds IDs, states, instants, counts, flags and fixed codes only.** Evidence takes only its listed keys and kinds, because a shape check alone would let a key like `prompt` carry text. No task text goes into a log, a terminal's argv, a URL other than the link route's, an error or a snapshot.
- **A double click opens one session.** Launch operations are non-undoable, from a human or the system only (R7), and touch neither the task's `touched` nor its projection.
- **A repeated request replays from its receipt** before the task or `machine.toml` is read again. Never rebuild its fingerprint from the task as it is now: the fingerprint holds the task's version and the brief's hash, so a retry after any edit would become `request_id_conflict`. The composer text is not part of a request's identity.
- **A launching entry** (Open, routines) is user-only and goes through `LaunchMachine` and the execution store, never through `submit`.
- **One call at a time per intent.** Never act on a record read outside the intent's section: guards or holds that other paths are meant to respect are not enough, because a path that read before it owned the intent acts on its old read.
- **Windows of time** never use commit instants, which A1 3.9 holds still while the clock is behind.

**One launch machine per space** (`LaunchService` in `packages/service/src/launch/service.ts`). Under A2's service lock the hub runs one `LaunchMachine` per space open as this machine's, so the page's click, the shim's claim, recovery and the sweep are sections of the same intent. `LaunchMachine.report` throws when the store is unavailable, so every caller keeps its observation and sends it again.

**`launch.open`** (`packages/contracts/src/entries/launch-open.ts`) is the one door for Open and Copy: user-only (R7), the CLI verb `brief`, remote `never` until L1. It carries the composer text, which never reaches the space. The over-budget note (3.15.3) is saved under a request ID derived from the click's, so a repeated click replays it, and only after the click's checks, so a refused click saves nothing. The page's tiles and receipts are `packages/service/src/http/launches.ts` (`[A4.3.9.http.launch-tile]`).

**To build.**
- The tiles in the space references' pinned order, with the area's default and then the space's first (3.2). Today they are `machine.toml`'s enabled instances in file order.
- A5 3.8's questions (the account check, Register in T3, trust) between `open` and `dispatch`. Until then a click dispatches at once. The account check reads the instance's `spaces` and the area's allowed accounts.
- A launch into a space the instance's agent home is not granted is refused before dispatch (A3 3.7.8). Until then it goes out, its ticket binds nothing at the bridge and its agent's calls are refused.
- **Connecting T3.** `LaunchService` takes the hub's `T3Route` and chooses `t3-mcp` for a T3 instance. The click runs `availability()`, the folder resolution and launch check (3.3), `prepare`, the question when asked, `machine.open`, `route.plan`, `machine.dispatch(id, {grant})`, then `route.confirm` on a Dispatched intent, and `route.openThread` with the prefilled brief through the opener (3.6.5). The dispatch step and recovery's `grant` and `replay` call the route, and a T3 intent that recovery made Dispatched needs the same `confirm`. An intent whose question was declined stays Prepared until the sweep closes it as `expired`, unless a cancel is added.
- **Connecting the T3 CLI route.** The click asks `chooseT3Route(route, cli, instance, pick?)`. For `t3-cli` it runs the folder resolution and launch check, `cli.prepare`, the Register question (`cli.register` or `cli.notNow`), `machine.open` with the route `t3-cli`, `cli.stage(id, …)` with the folder the Prepared step bound and the sent brief, and `machine.dispatch(id)` with no grant. On a Dispatched intent it reports `cli.observe(intent)` and calls `cli.openThread(intent)`. The dispatch step sends a `t3-cli` intent to `T3CliRoute.dispatch`, and recovery needs nothing new. The CLI route is built with the launch service's person's environment (`environment.base()`, 3.8), not the service's own: the hub's `t3Host` builds one only for `t3/status`, which starts no CLI. A refused stage or Prepared step shows `T3_TEXT[reason]`.

### 3.10 Sessions and resume

A **session** groups the launches of one agent conversation.

**Built: session records in machine state** (`packages/service/src/binding/sessions.ts`, A3 3.7, tests `[A3.3.7.binding.*]`), and the space's `sessions` table (schema 0.3), which nothing writes yet. Until binding writes the table, it keeps session records and binding handles in `<state>/sessions.json`. The file holds no task text, ticket or handle. Everything a session does in a space still goes through the write path, under its actor `agent:<instance>:<session>`.
- A launch's session is made at its first binding, not with the launch intent (A3 3.7.7).
- **Live:** an open connection bound to it, or its launch's agent running. **Ended:** none of these and no call for 24 hours. Its record stays 30 days (`bindings.ts`).
- Until binding writes the table, a session record lost with the state folder leaves its launch's `bound_at` in the space, so its reference answers `launch_used`.

**To build: the move into the `sessions` table** (M4.06, with native-ID binding, the session list and Resume). The table exists (schema 0.3, `packages/storage/migrations/0003-schema-0.3.ts`) and the crash harness checks its rows. The move brings the execution store's `upsertSession` and `session.*` operations through the writer, and takes each record of `sessions.json` (id, space, task, instance, kind, how it bound, launches, native IDs, created, ended) with no schema change: what A1's columns do not hold (how it bound, its launches, every presented native ID, the instance's label and account) goes in `sessions.detail`, which the writer checks key by key. The last-seen time and the handles stay in machine state (A2), so a call never writes the space. The record's shape:

```ts
type Session = {
  id: string;
  space_id: string;
  task_id: string | null;        // null for routine runs
  kind: "interactive" | "run";
  instance_id: string;           // with a snapshot of label and account
  machine_id: string;
  native_id: string | null;
  native_id_source: "preset" | "returned" | "bridge" | "reference-match" | null;
  state: "opening" | "live" | "ended" | "unknown";
  end_reason?: "exit" | "error" | "terminal-closed" | "lost" | "stale";
  exit_code?: number;
  bound: boolean;                // A3: an agent call was attributed to it
  launches: string[];            // launch intent IDs, first open then resumes
  created_by: "user";            // R7
};
```

A session has no folder field: its folder is its launches', each of which records the folder it opened in (A1 3.15).
- **Live** comes from the shim's connection, the bridge's connection or T3's thread state. Link and clipboard sessions show only "opened" until an agent binds.
- Once sessions are made with the launch intent, one that never bound and saw no activity for 7 days ends `stale`.
- **Resume** is offered only with a `native_id` and an existing instance. It creates a new intent in the same session and never replays the original brief. Otherwise the button reads "Open".

| Target | Resume | Native ID source |
|---|---|---|
| Claude Code CLI | `claude --resume <uuid>` through the shim, same folder | preset |
| Codex CLI | `codex resume <id>` through the shim, same folder and home | reference match or bridge |
| T3 | Open the thread link (not a new session) | returned |
| Codex app | `codex://threads/<id>` | bridge, if reported |
| Claude Desktop, clipboard | Not offered; "Open new session" | none |

### 3.11 Background runs (D6, R9)

#### 3.11.3 Commands

The run shim (`ttasks shim --run <ticket>`) checks the folder as in 3.3 step 4 and starts the agent with `shell: false`, the brief on stdin then closed, stdout to a pipe it parses and appends to `stdout.jsonl`, stderr to `stderr.log`. On Unix the agent is `detached` (its own session and group). On Windows it starts through the console helper (3.11.8).

| Adapter | argv after `{exec}` | Native ID |
|---|---|---|
| `claude-print` | `-p --session-id <uuid> --output-format stream-json --verbose --permission-mode <mode> --permission-prompts none --max-turns <n> [--max-budget-usd <x>] <extra>` | preset, confirmed by `system/init` |
| `codex-exec` | `exec --json -C <folder> <permission args> [--skip-git-repo-check] -o <run dir>/last-message.txt <extra> -` | `thread.started` |

**`claude-print`:**
- `-p` skips the trust dialog, so runs start only in allowed folders. With no mode set it starts in Manual, so `--permission-mode` is always passed. `--permission-prompts none` denies anything that would prompt. `--verbose` is required for stream-json.
- `--max-turns` (50 for task runs, 150 for routines) works although `--help` does not list it. `--max-budget-usd` is optional per instance, an estimate that can overshoot.
- SIGTERM exits 143 and leaves the turn unfinished. SIGINT, or Ctrl+C through the console helper, ends the turn cleanly: a tool-result error, then `result` with `is_error: true`, exit 0 after about 1 s. On Windows only Ctrl+C gives Claude a final `result`. TerminateProcess (Node's `kill()`) gives none.
- Claude Code defers MCP tools behind ToolSearch. TTasks' `status` and `get_task` carry `_meta["anthropic/alwaysLoad"] = true` (A3), so they load at start. A call to any other TTasks tool follows a ToolSearch call.

**`codex-exec`:**
- `-` reads the prompt from stdin. `exec` never prompts: it rejects approval requests and cancels MCP elicitations. Its default sandbox is read-only, so the permission arguments are always passed.
- Outside a git repository it exits 1 without `--skip-git-repo-check` (full access skips the check too). TTasks adds it.
- A required MCP server that fails to start makes `exec` fail. A3's entry is not required, so a missing bridge means "without TTasks tools".
- Ctrl+C (Windows) or SIGINT to the group (Linux) exits 1 after about 0.3 s with no further event and no `-o` file. So a cancelled run ends from the exit code and the missing `turn.completed`, never from `-o`. SIGTERM ends it at once. Exit 0 is success, 1 failure or interrupt.
- With full access TTasks' tools run without `default_tools_approval_mode`. In other modes the run passes `-c mcp_servers.ttasks.default_tools_approval_mode="approve"`.
- `codex exec resume <id> -` continues non-interactively. It has no `-C` (it runs in the process's folder) and repeats `thread.started` with the same ID. `codex resume <id>` continues in a terminal.

Every cancel leaves the stream ending on a whole line. On Windows no process of the tree is left after exit.

#### 3.11.5 Logs and results

- Per run, `<state>/runs/<run-ref>/` holds `meta.json` (shim PID and start time, agent PID and group ID, unit name), `stdout.jsonl`, `stderr.log`, `events.jsonl`, `checkpoint.json` and `exit.json`, all 0600.
- **Raw logs are for people.** `stdout.jsonl` is capped at 20 MB and `stderr.log` at 2 MB, then a truncation marker. Parsing goes on.
- **The journal is for the service.** Every event goes to `events.jsonl` with a `seq` from 1, bounded at 4 MB. Past that, `progress` and `message` stop and one `journal_truncated` event is written. `native-id`, `session`, `usage` and `finished` are always appended.
- **Checkpoint.** On every change, `checkpoint.json` is rewritten atomically (temporary file, fsync, rename): last `seq`, native ID, latest usage, last message (8 KiB), progress count.
- **Final outcome.** After exit and drain, the shim writes `exit.json` atomically from `end()`: exit code, signal, duration, `finished`, final result (8 KiB), usage, native ID, last `seq`. Then it sends `run.exited` with the same content. Recovery trusts `exit.json`. Raw-log truncation never touches it.
- The native ID, usage and outcome survive log caps and restarts. Labels and messages past the journal cap may be lost.
- Retention: 14 days or the newest 200 runs, whichever keeps more. Deleting a log never touches the run record.
- The run record keeps the request text, the result (8 KiB), usage, state, reason, timings and native ID. Up to 50 progress labels are kept per run, in the run files or also in the run record (6.13). The result shows in the task's activity. The agent's own TTasks calls are the only changes to the task, under the space's autonomy (A3).
- Logs may contain source text and secrets. They stay in machine state, are never exported, and doctor redacts them.

#### 3.11.6 Permission per instance

**Built:** the Claude and Codex flags for each permission, for open and for run, are the catalogue's `permissionArgs` (`catalogue.ts`, `[A4.3.2.catalogue.invariants]`). `inherit` adds nothing, so a run with `inherit` is refused: Claude would start in Manual and Codex read-only. Codex's `-a` takes only `on-request` and `never`, and `--full-auto` no longer exists. T3 takes a runtime mode per thread instead (`t3-route.ts`).

The first Run in an instance with `inherit` asks for a mode: "Runs in Codex · work use full access and nobody watches them. Use at your own risk. Run / Cancel".
- TTasks never raises a mode because a run failed. A routine, a brief, a space file or an agent can never set one. Only the instance does.
- Codex's sandbox may fail where unprivileged user namespaces are restricted. Doctor tests the instance's chosen mode and warns only when it fails.

#### 3.11.7 Preconditions, concurrency and leases

- **User only.** Run, routine runs, Stop and Continue are user operations (R7), never agent tools. Tasks that agents create never trigger runs.
- **An instruction is required.** Run with an empty composer focuses the composer and asks what the agent should do.
- **Folders.** A task's run starts in the folder its task resolves to (3.3), the TTasks work folder included, and a routine's run in its routine's work folder. TTasks sets no limit on where agents work (L20).
- **Caps,** machine-local settings in `machine.toml`: `runs.max_concurrent` (default 3), `runs.max_per_instance` (default 2), and one per task. Extra runs wait in `queued`, first in first out.
- **Folder lease** on the folder's real path: a second run waits. A live interactive session there asks "Codex · work is open in this folder. Run anyway?" The hover says a lease cannot stop agents TTasks does not know about. Work folders take no lease.
- **Timeouts**, enforced by the shim so they hold while the service is down: 30 min wall time for task runs, 60 min for routines, 10 min idle without a stdout line. A timeout runs 3.11.8 and ends `timed_out`. A run stuck on a login or trust prompt shows as idle, and the message says so.

#### 3.11.10 Continue interactively

"Continue in terminal" creates a launch intent in the same session with the resume argv (`claude --resume <uuid>` or `codex resume <thread_id> -C <folder> --no-daemon`). If the run is still going, the UI first asks "Stop the run and continue in a terminal?", because two processes on one session would corrupt it.

#### 3.11.11 The message box

The composer (A5) feeds four actions: Note (no inference), Open per instance (the text replaces the brief's last line), Run (the text is the request) and Copy (the pointer brief with the text in its last line, or the context pack with Shift). There is no "Ask" mode. Open and Run work for every task (3.3).

### 3.12 Routines (D6, D8)

A routine is a saved run recipe not tied to one task. It uses the same adapters, shim, caps and logs as a task run. Its session is bound to the space (A3 binding kind `routine`), and its changes are attributed to "routine: <name>", so Today can group them.

#### 3.12.1 Routine record

```ts
type Routine = {
  id: string;
  space_id: string;
  name: string;                         // "Refresh from sources"
  kind: "refresh" | "wrap-up" | "custom";
  template: string;                     // brief template (3.15)
  params: Record<string, string>;       // kind-specific, for example the source list
  home_machine_id: string;              // runs only on the machine that owns the space (D16)
  instance_id: string;                  // an instance on that machine
  limits: { wall_min: number; idle_min: number; max_turns: number; max_budget_usd?: number };
  schedule: Schedule | null;            // 3.13; evaluated only from M9
  enabled: boolean;
  watermark: string | null;             // refresh: start of the last fully successful run
  last_run_id: string | null;
  created_by: "user";                   // R7
};
```

- **Approval.** The hash (3.2) covers the template, `params`, the instance ID and that instance's `run_permission` at approval. A routine saved in the UI on its home machine is approved at save. One that arrives with an import, or whose instance's permission was raised, shows "Changed since you approved it" and does not run until approved.
- **Work folder.** `<state>/workdirs/routine-<routine-id>/`, empty and allowed for runs. Never inside a space folder (a full-access agent must not sit next to the database) or a project.
- **One at a time.** Pressing Refresh while it runs focuses the running one.

#### 3.12.2 "Refresh from sources" (v1)

Started by the Refresh action. It scans the user's sources through the instance's own connectors and records new and changed work through the agent interface. TTasks holds no connector credentials. The instance is one whose account has the connectors, for example Codex · work. Each source is read through the instance's own agent tools: its connectors or an MCP server configured in its home. Which sources Refresh reads, and through which tools, is settled when Refresh is built (M6.07). Setup asks for the sources once and stores them in `params.sources`, for example:

```
Mail: inbox and sent mail. Calendar: the next 14 days.
Documents: comments and shares addressed to me. Issue tracker: issues assigned to me, mentioning me or watched by me.
Wiki: pages and comments that mention me. Chat: spaces and direct messages.
```

| Rule | How |
|---|---|
| Read only on sources | The template forbids sending, replying, accepting, reacting, commenting, transitioning or editing in a source. TTasks cannot enforce it inside the connectors, and the first-run confirmation says so |
| No duplicates | Every task carries a source key (R4), and the agent upserts by source key, so overlapping windows are harmless |
| Incremental | `since` = the watermark minus 2 h, or 3 days on the first run |
| Coverage | The run ends with `run_report`: one row per source, `ok`, `partial` or `unreachable`, with a count. The routine shows "Refreshed 09:12 · Issue tracker unreachable" |
| Watermark | Moves only when the run succeeded and every source is `ok` |
| No completions by inference | The template says to set review with a log entry instead. Full autonomy still lets interactive agents complete tasks |
| Source text is data | A template line, plus A3's labels |

Limits: 60 min wall, 10 min idle, 150 turns. A run that hits a limit keeps what it recorded (each upsert is its own operation) and shows "Stopped after 60 min, partly refreshed".

Each connector's read tools must run under `codex exec` without an approval request, which `exec` would reject. Agents never change approval settings, so the person sets the needed read overrides (6.3).

#### 3.12.3 "Wrap-up" (v1)

Check-off completes a task at once (D12). Wrap-up writes the outcome and learnings later.
- **Input:** the selected completed tasks, or all completed tasks without an outcome, at most 10 per run, fixed at the start and passed as IDs.
- **Instance:** the space's default routine instance. No connectors.
- **Per task:** read the task, log, notes and sessions through A3, look at the task's folder read-only if useful (for example `git log`), write outcome and learnings through A3's wrap-up operation.
- **Safety:** the wrap-up operation keeps every original text (D12). The routine never reopens, deletes or moves a task. Each task is its own operation.
- **Folder:** the routine's work folder. Reading a task's folder is allowed, without a lease.

#### 3.12.4 Custom routines

Any task-less run can be saved as a routine ("Every Friday: draft my weekly status from Completed"), `kind = "custom"`, with the same approval and limits. Part of the v1 data and API. The UI to create them can follow later.

### 3.13 Scheduler (ships in M9)

#### 3.13.1 The schedule field

```ts
type Schedule = {
  rule: string;            // RRULE subset: FREQ=DAILY|WEEKLY|HOURLY, INTERVAL, BYDAY, BYHOUR, BYMINUTE
  tz: string;              // IANA zone, for example "Europe/Lisbon"
  window_min: number;      // how late a due occurrence still counts as on time (default 120)
  catch_up: "once" | "skip";   // after a longer gap: one catch-up run, or none (default "once")
  quiet: { from: string; to: string } | null;   // local times when nothing starts
};
```

Recurring tasks use the same RRULE subset and parser (D4).

### 3.14 Workspace trust and pre-trust (R16)

TTasks never writes another app's trust settings silently. Every change is a user-confirmed step for one folder and one target, with a preview of the exact change and an exact undo. TTasks never trusts `$HOME`, a drive root or the filesystem root. Pre-trust ships after v1 (L23). Until then the user accepts each app's own dialog.

| App | When it asks | Where trust is stored | TTasks' offer |
|---|---|---|---|
| Claude Code CLI | First interactive start in an untrusted folder. `-p` never asks. `--bg` refuses with "Workspace not trusted" | `projects["<path>"].hasTrustDialogAccepted = true` in the instance's `.claude.json` (the documented pre-trust) | **Trust in Claude Code**, written only while no Claude process of that instance runs, after reading the file again |
| Codex CLI and app | Onboarding or `/permissions`. `exec` never asks | `[projects.'<path>'] trust_level = "trusted"` in `$CODEX_HOME/config.toml` | **Trust in Codex · work** |
| T3 Code | Never. Registering a project is the trust step | T3's project list | "Register this folder in T3" (3.4.1) |
| Claude Desktop | Every link launch | none | Nothing. The hover says it asks each time |

- Runs have no trust rule of TTasks' own: the first Run per instance and machine names its folder and asks once (A5 3.8), and the person's setup of the agent app decides what the agent may do.
- The offer appears in the Prepared step of the first Open in a folder whose trust reads as missing. Doctor lists the entries TTasks wrote and can remove them. A declined or failed trust check never starts another target.
- **Key spelling.** Claude Code: the launch working folder with `/` separators and its case kept exactly. Codex: the folder as the OS spells it, matched without case on Windows, so a table in another case is the same folder. In a git repository both key the repository root, and outside one a parent's key does not trust a child. On Linux both look up a symlinked folder's real path and keys are case-sensitive, so TTasks resolves links first. Whether each CLI's own dialog writes the same spelling is open (M0-L02, L04, L18). TTasks can read trust read-only from the same keys.
- **A text-level patch.** A scanner finds the key's span and one splice writes it in the file's own style (line endings, indentation, spacing). No parse and re-serialise (it loses comments, key order and spacing) and no whole-file backup (it copies unrelated configuration). The whole file is validated with a real parser for its format (JSON for Claude Code, TOML for Codex) before the splice.
- **The scanner refuses what it cannot account for**, because a misread string or bracket misplaces every later table: a string that does not end on its line, unmatched brackets, anything but a comment after a complete top-level value, a top-level bare value outside TOML 1.0 (booleans, the integer and float forms, `inf`/`nan`, dates and times), a value-less key, a CR not before an LF, and a table or key twice (a table under an array of tables counts per element). It honours escapes in a multi-line basic string. An unsupported layout is refused untouched. It is a locator, not a validator: `[1 2]` passes but cannot move a table or key.
- **Links.** A trust file or its folder that is a symbolic link (or on Windows a junction) is refused, never followed: a link could make the splice write another file.
- **Encoding.** Strict UTF-8: invalid bytes are refused, a byte order mark is kept, so the bytes written back are the bytes read. A previous trust value is kept only when plain (`false` or `null` in JSON, a string in TOML). Anything else is refused.
- **Undo.** The record holds only the splice (TTasks' text and the previous value) and the file hashes, never a copy. While the hash is unchanged the undo restores the exact bytes. Otherwise it reverts only TTasks' key, and when the key no longer holds `true` or `"trusted"` it leaves the file alone and reports `key changed`. A Codex table TTasks created is removed whole only while its header is exactly TTasks', and a comment put after the value stays as a comment line.
