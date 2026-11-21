# A7. Milestones, quality and retirement

> What is left in this document is the list of steps that are not built yet, with the background that was written for them before the code. The code and its tests are the source of truth for everything that is built, and `planning/STATUS.md` says which steps are done. Do not add to this document.

> What is left in this document is the list of steps that are not built yet, with the background that was written for them before the code. The code and its tests are the source of truth for everything that is built, and `planning/STATUS.md` says which steps are done. Do not add to this document.

> What is left in this document is the list of steps that are not built yet, with the background that was written for them before the code. The code and its tests are the source of truth for everything that is built, and `planning/STATUS.md` says which steps are done. Do not add to this document.

> What is left in this document is the list of steps that are not built yet, with the background that was written for them before the code. The code and its tests are the source of truth for everything that is built, and `planning/STATUS.md` says which steps are done. Do not add to this document.

This appendix owns the repository layout, the step mechanics, the M0 real-machine lab, the milestones from M0 to v1 with their steps and definitions of done, the retirement gate, the roadmap after v1, the test strategy, the delivery risks and the open items. The repository's `AGENTS.md` owns how agents work (3.5).

It schedules what PLAN.md section A and A1 to A6 specify. Every step names the sections it implements. `planning/STATUS.md` tracks which steps are merged. A merged step keeps only its ID and title here, plus what a later step still needs from it: its code and tests are the reference. Step IDs are never reused.

Examples use the fixture world: Mira Okafor, space "Mira", reference prefix `M`. No prototype content appears here.

---

## 3. Specification

### 3.6 Milestone map and order

| Milestone | Goal | Base steps | Owner |
|---|---|---|---|
| **M0** Lab | Observe and qualify every load-bearing fact | 12 | Three lab sessions, report review |
| **M1** Core slice | One space, one writer, one CLI, a verified backup and restore, installed on Windows and Linux | 15 | Acceptance transcript |
| **M2** Walking skeleton | Open a task in T3, Claude Code and Codex on Windows and Linux | 15 | Acceptance on a real Windows and a real Linux machine, then 3–5 days of use |
| **M3** Durable space | A1 complete for v1 | 16 | Restore drill, projection, scale note |
| **M4** Agent interface | A3 complete | 11 | Setup previews, eval report |
| **M5** Planner UI | A5's v1 scope | 14 | Every screen, five days of use |
| **M6** Runs and routines | A4 runs, Refresh, Wrap-up, the TTasks work folder, every v1 target | 16 | Refresh on a real Linux machine |
| **M7** Switch-over | Trial, retirement = **v1** | 2 | Rehearsal, cutover, a daily check during the trial, gate review |
| **Total to v1** | | **101** | |

**Order.** A milestone groups steps and owns a definition of done. Its position is not a dependency: a step starts when the code it needs exists (its Needs column), on main or on a branch (3.4). A milestone closes when every step in it is merged, its definition of done holds, `pnpm accept m<N>` passes from source in CI and against an installed build on a real Windows machine and a real Linux machine for the active profile, its `manual` entries are in the qualification record, and its review list has been offered to the owner.

**Lanes.** Agents work in as many parallel lanes as the dependencies allow. Steps that play heavily into each other (the same tables, the same write path, one guarantee kept by both) go to one implementing agent as one lane, or the shared structure is written down first and given to both, and steps on one write path run one after another. Rules that keep lanes apart: one open migration at a time, additive contract changes (3.4), and one UI lane during M5, with the other lanes on runs.

**The folder steps (D28)** form one order. M4.01b, then M4.09, then M4.10 are one lane for one implementing agent: they share the `projects` and `folders` tables and the write path, and M4.09 owns the next migration step. M6.16 needs M4.09 only and may run beside M4.10: it writes folders only through M4.09's operations, and uses M4.09's `resolve` and deepest-project function, never a rule of its own. M5.14 needs M4.09 and M6.16. M4.11 comes last. M4.09 alone changes no caller: the writer still takes `place.*`, and nothing binds a folder yet. **M4.10 and M6.16 merge as one batch** (stacked, checked together on both platforms), because each alone leaves a build that writes a task's folder one way and launches from the other: agents binding folders while launches still resolve places, launches resolving folders while agents still write places. M4.11 then makes the writer refuse `place.*`. The Owner column is owner-only work. It does not hold other steps or a milestone open: what needs the owner is noted, and independent steps go on. An "Owner reviews" list names what the owner looks at after a milestone.

**Scope.** The base is every step in 3.7 to 3.14. Conditional steps are kept apart.

| Part | Steps | When it applies |
|---|---|---|
| Base steps | 101 | Always. The M0 rows marked ● need the owner's lab sessions. 2 are the rehearsal and the trial |
| Native forwarder F1–F4 | 4 | Only if bridge rule 3 fires (A2 3.7.7). Rule 1 applies provisionally (3.7), so they are not scheduled and `ttasks mcp --node` and `ttasks-bridge` do not appear in M6 |
| Windows cancel helper M6.04h | 1 | Applies: N03 showed it is needed |
| Fallback driver as primary | 1 | Not now: `node:sqlite` stays the primary (3.7, R08) |

**Real-use point.** The agents decide when the product is mature enough for the first user's real work tasks, and mark it in `STATUS.md`. It need not be stable, but the core must be there. Guideline: a durable space with verified backups, Today and the task lists with the expanded task, editing and check-off with undo, agents updating tasks through MCP, and Open in T3 Code and Codex on Linux. The M7 rehearsal, trial and retirement gate stay the formal switch-over.

**If the owner wants a smaller v1**, cut in this order, and ship the cut parts in M8:
1. Claude Desktop and Codex app links (Copy covers them).
2. The Agents view and session revert in the UI (the CLI keeps both).
3. First-run UI steps 2 to 5 (the CLI setup covers the first user).
4. The Washi theme (tokens stay).
5. Projection files for completed tasks (`catalog.jsonl` keeps them).
6. The Wrap-up routine (D12 holds without it).

Each cut is applied as a named scope profile (3.18.6), which changes the acceptance scripts, the definitions of done and the retirement criteria together. The owner chooses a profile, or the agents do when a step blocks, and write it into the specification.

Not on the cut list, and changed only by a deviation written into the specification when one blocks: Open in T3, Claude Code and Codex, Copy, runs on a task, Refresh, check-off with undo, backups and crash safety.

### 3.7 M0: the real-machine lab

**Goal.** Turn every fact that product code depends on into an observation on Windows and Linux (R17), and record the decision it drives.

**State.** M0.01 to M0.12 are merged and gate G1 has passed. G2 stays open until the three lab sessions have run. Rows marked **●** need the owner at the machine. Rows marked ↻ are unattended re-runs. `planning/STATUS.md` lists what is open.

**Lab rules.** They hold for every remaining run.
- Lab code lives in `spikes/m0/` and is removed after its last user: the last lab session and M3.16's re-run of R05 with the storage bench. Only `fixtures/streams/` survives.
- **On Windows:** a key-level before and after record of every configuration file a check touches, restored the same day.
- **On Linux:** no sudo, nothing outside the home folder, scratch folders only. Configuration changes go into scratch homes (a new `CLAUDE_CONFIG_DIR` or `CODEX_HOME`) with a key-level record, removed the same day. Native Codex launches use the default home with per-launch flags and no configuration writes. Any other Codex home is detected only, never launched. Managed instruction files and skill folders are never written. Claude Code runs there only in an attended session.
- **Agent homes:** no sign-in file or token is copied, read, printed, hashed or moved, and no API key is looked for. No trust or approval setting is written in a real home. A registration in a real home happens only in an attended session: preview, entry backup, apply, exact removal.
- A check that cannot run is recorded "not run" with its reason, and its fail branch applies until it is re-run. A result that changes a design choice is written into the section it belongs to. Screenshots from a machine that holds real work data are not committed. Run dates, OS builds and app versions stay outside the repository.

**Lab code.** `spikes/m0/README.md` and the folder READMEs describe each tool. The code enforces the lab's safety rules: closed, structured logs (`kit/probe-log.ts`), fixed classifications in place of any program's own words, allow-listed child environments with process-group shutdown (`agents/spawn.ts`), removal only inside the run's marked scratch folder (`agents/scratch.ts`), run-only settings in signed-in homes (`agents/lab.ts`, `runs/lab.ts`) and the guard for Linux runs (`runs/guard.ts`). Two reasons bind any change to it: logs are closed by construction because redaction heuristics leaked short values and paths, and nothing a CLI, a model or the OS says in its own words is kept, because account names, paths and credentials hide in it. The storage bench (`storage/run.ts`) judges a row only when the run meets the scale and durations that `spikes/m0/storage/README.md` lists. Any other run is indicative.

**Sessions with the owner present** (●): watching a window, clicking a trust or approval prompt, signing in, rebooting.
1. Windows launch and apps: L01–L09, L12, A03–A06, U02–U06, S05, N02's interactive resume, the tool-choice check.
2. Linux launch and apps: L01–L09, L11, L12, A01's sessions, A03–A06, E02's Claude Code part, U01, U03, U04, U06, U07 visible, S11, N01, N02's interactive resume, the tool-choice check.
3. Reboots and sign-in, on Windows and Linux: S01, S02, S03, B01, B06 and B07 cold after a reboot, E01's boot and sign-in halves, and N04.

Session 3 registers the service with the product's own `ttasks service install` (M1.12) in a `TTASKS_HOME` test install made with M1.14's install script from a test build (3.4), never with a lab script. If the mechanism fails, M1.12 is fixed and the session runs again. S02 is checked through the product service's own reading of its secrets folder at boot, and S03 describes the product's supervisor in `ttasksw.exe`. The cold runs are three per machine, one per reboot (`forwarder_online` for B01 and B06, `forwarder_offline` for B01, `shim_claim` for B07), timed by a non-Node supervisor that times the installed launcher directly (`spikes/m0/lifecycle/`), and reported apart from the warm runs. A cold start far above the warm numbers is a reason to re-run B01 and revisit the bridge rule.

**The tool-choice check** (sessions 1 and 2): with the MCP server named `tasks` beside an agent app's own task tools, an agent picks the server's tools for a task. If it confuses them, only the MCP server name changes, to `tt-tasks`.

**Closed rows that still drive a design.** Each decision is written in the section named.
- R01: Node 26.13.1 passes the runtime gate through both launchers. The Node pin.
- R02: a one-step `backup()` plus `integrity_check` of the 600 MB database takes 5.0 s on Windows and 5.5 s on Linux. Thread model A1-4.
- R03: one-task patch p95 is 1.02 ms on Windows and 20.1 ms on Linux against 25 ms. The margin is small, so M1.15 measures again on the installed build.
- R08: `better-sqlite3` 13.0.3 installs for the pinned ABI without a compiler and passes the driver smoke test. The fallback is installable, not the primary: becoming the primary first needs R02's qualification in the packaged build.
- R09: the per-user install passes only since the Windows installer stopped depending on the console code page (A2 3.12.4).
- R12: Smart App Control does not block the unsigned launchers on Windows. Authenticode signing stays before the first public Windows build.
- B02: 53.4 MiB RSS per bridge on Linux against 60 MiB, the closest bridge margin. B06: the slowest warm start is 68.3 ms, so A3's 20 s `startup_timeout_sec` stays.
- S08: one rename over a running launcher is refused on Windows (A2 3.12.6, M6.12, M6.13).
- S12: the v1 doctor warning about other accounts (`packages/cli/src/accounts.ts`) has no acknowledgement of a known account yet.
- E02: Codex reaches the socket or pipe only outside its sandbox, which fails with `EPERM` on Windows and Linux, so `EPERM` gives the sandbox hint and doctor tests the sandbox (A2 3.10.4, A4 3.11.6).
- A02: Codex delivers the ticket only through `env_vars`, and the thread ID in `_meta.threadId` of `tools/call` (A3 3.7, 3.13.4).
- A06 (headless): Codex CLI shows its model at least the first 246 and fewer than 296 characters of the server instructions, so the start rule fits in the first 240 and the rest is repeated in the tool descriptions (A3 3.6).
- A07: 2025-11-25 and 2026-07-28 MCP clients both work through the bridge, with one SDK server per connection from one factory (A3 3.3).
- A08: 3 bytes per token underestimates. The estimates are 2.0 bytes per token for definitions and 1.5 for results (A3 3.2.5). No counting API confirms them.
- A09: Claude Code loads a tool at start with `_meta["anthropic/alwaysLoad"] = true`, set for `status` and `get_task`.
- L10: trust writes and their exact undo work on scratch homes (`spikes/m0/launch/trust-patch.ts`, A4 3.14). Pre-trust stays after v1.
- N03: graceful cancel on Windows needs the console-attach helper, so M6.04h applies (A4 3.11.8).
- N05: 22 Windows and 6 Linux recorded streams are in `fixtures/streams/`, checked by `tests/stream-content.test.ts`.
- Passed with no design change: R04, R06, R10, R11, B03–B05, S04, S06, S07, A01 on Windows.

**Open rows.** The full pass criteria are in the source item named in brackets (A2's M0-S table, A3 and A5's M0 tables, A4 5.3). Session numbers are those above.

| ID | Check | Decides |
|---|---|---|
| R05 | FTS5 top 20 with snippets over 55,000 tasks: p95 ≤ 50 ms on Windows, ≤ 100 ms on Linux (A1 3.20). Windows failed on broad queries (52.3 and 57.6 ms), Linux reached 105.2 ms with heavy text | M3.16 chooses a query design for broad terms, decides the trigram default and re-runs it on Windows and Linux |
| R07 ↻ | The sync detector on real synced folders on Windows, run again | A1 3.2 |
| B01, B06, B07 ● | Cold after a reboot, Defender on (A2 3.7.7): forwarder to the first byte of the `initialize` reply p95 ≤ 250 ms Linux, ≤ 600 ms Windows. Bridge start ≤ 2 s. `ttasks shim` to its claim ≤ 300 ms. Warm runs pass with wide margins | The bridge rule. B07 fail: the shim follows the native-forwarder rule |
| S01 ● | Linux: the unit from `ttasks service install` starts at boot before login, and a terminal in a scope and a run in a transient unit survive `restart` and `stop` while a control child dies, and a SIGINT to the run's group does not reach the shim [M0-S4, A4 M0-L10]. A pre-test passed | A4 L11. Fail: transient units for terminals too (A4 3.7) |
| S02 ● | Linux: the service started at boot reads its secrets folder before login | A6 L4 |
| S03 ● | Windows: the Run value from `ttasks service install` [M0-S7] | A2 S4 |
| S05 ● | Windows: packaged parents P-1 to P-6 [M0-S8] | Packaged-context rules. P-2 fail: A3 marks the app "needs check" |
| S09 | Linux: a test install beside a daily install [M0-S14]. Passes at spike level and in CI | M1.15 on real machines |
| S11 ● | Linux: the peer UID check with the Firefox snap [M0-S6] | A2 S17 |
| E01 ● | The login-shell snapshot of a boot- or sign-in-started service finds the same tools as a hand-opened terminal, within 2 s or cached [A4 M0-L11]. The unattended halves pass (736 ms on Linux, 36–47 ms on Windows) | A4 L12's layers and the `via_login_shell` default |
| E02 ● | Linux: the socket from inside Claude Code's sandbox [M0-S12] | The sandbox hint for Claude Code |
| U01, U02 ● | `ttasks open` into Firefox on Windows and Linux and Chrome on Windows [M0-S5, A5 M0-1, M0-6]. The page checks pass headless | A2 S15, S16 |
| U03 ● | No Local Network Access prompt for the loopback page in current Firefox and Chrome | Fail: document the one-time permission |
| U04 ● | Firefox's keys [A5 M0-2] | The A5 keymap |
| U05 ● | Firefox on Windows renders the bundled fonts [A5 M0-3] | A5 U16 |
| U06 ● | Source links and the reveal button [A5 M0-5] | `folder.reveal` |
| U07 ● | Linux, visible in the Firefox snap: 5,000 rows [A5 M0-4]. Headless, the burst's script work reached 12–15 ms of 16, because the spike re-derives all tasks per burst | A miss reopens the A5 stack choice before M5.13 |
| A01 ● | Linux: Claude Code's session ID and ticket with `--session-id`, after `--resume`, and with `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1` [A3 M0-1] | A3 3.7 |
| A03–A05 ● | T3 Code, Claude Desktop and the Codex app: what each loads, its home, and one bridge per thread or shared [A3 M0-3 to M0-5] | The shared-host rule, A3 3.13.3, 3.13.5 |
| A06 ● | By hand in Claude Desktop (both tabs), the Codex app and T3: the model states the `request_id` rule | A3 3.6 |
| L01 ● | Each terminal opening the shim [A4 M0-L01] | The primary terminal per OS and each adapter's acceptance rule. An exit code shown to mean "nothing opened" joins that adapter's pre-activation errors |
| L02 ● | Claude Code direct, then `--resume` [A4 M0-L02] | The Claude primary route, Resume |
| L03 ● | `claude-cli://` [A4 M0-L03] | The Claude fallback and its 1,000-character budget |
| L04 ● | Codex direct, on Linux with the default home only [A4 M0-L04] | The Codex route, one instance per account |
| L05 ● | T3 pairing and threads [A4 M0-L05], with the T3 desktop app's local environment off on Linux | The T3 primary route (A4 L6) and the grant lifetime. If a token refresh keeps the request namespace, it may keep the grant ID. If T3 writes its runtime file or `userdata` folder with the umask's mode, the route gets its own state and a line that names the file and the repair |
| L06 ● | T3 CLI with a project ID [A4 M0-L06] | The T3 fallback |
| L07, L08 ● | Claude Desktop and Codex app links [A4 M0-L07, M0-L08] | Best-effort status per machine |
| L09 ● | URL openers [A4 M0-L09] | The opener, link budgets, error texts. A `gio` code proved to mean "no handler" may map to `no_handler` |
| L11 ● | Linux: window focus on GNOME Wayland from a linger-started service [A4 M0-L17] | The receipt wording |
| L12 ● | The three native targets in a stand-in TTasks work folder [A4 M0-L18] | The work-folder route per target (A4 3.3, M6.08) |
| N01 ● | Linux: `claude -p` streams [A4 M0-L12]. Windows passed | The `claude-print` adapter |
| N02 ↻● | `codex exec --json` with full access on Linux ↻ (it ran in the default sandbox only), and the interactive resume of an exec thread on Windows and Linux ● [A4 M0-L13] | The `codex-exec` adapter, Continue |
| N04 ● | Linux: every read operation the Refresh template needs per source (A4 3.12.2: mail inbox and sent mail, calendar, documents, issue tracker, wiki, each search or list with a since-time and each fetch) runs without an approval request [A4 M0-L15] | Fail: agents never change approval settings, so the needed read overrides go to the owner to set and N04 re-runs through the same path. Still failing: the gate rules apply |

**N04's topology.** The product's service cannot start runs before M6.03, so session 3 runs N04 with the lab's stand-in service in a transient unit that the user manager starts after the reboot, before anyone signs in. It starts `codex exec` through the lab's run shim in its own transient unit, with the default Codex instance, E01's login-shell environment, the routine work folder as cwd, and the planned per-launch flags and timeout. A sign-in imports the desktop session's variables into the user manager, so a run started after it is only a pre-test. The recorder compares the names of the run unit's environment variables with E01's before-login snapshot. M6.15 repeats N04 through the product.

**Bridge rule.** A2 3.7.7: rule 1 ships Node, rule 2 retries with bridge-only Node flags, rule 3 adds the forwarder steps F1–F4 (3.13) before M7. **Rule 1 applies, provisionally.** It is re-checked (↻) by B01 to B07 through the product's own bridge, from a `TTASKS_HOME` test install of the release build on each machine, by A2 3.7.7's protocol, and again by session 3's cold starts.

**Gate rules.** A row is *observed* when it has a recorded result. A required capability is *qualified* when a passing run of its row, through the path the product will use and after any remediation, shows it works on the machines that need it. A gate passes when every row it covers is observed and every required predicate below is qualified. G1 covers the R and B rows. G2 covers every row.
- A required predicate whose row has not run counts as failed. A route is never qualified by its unattended parts alone (D6–D8).
- A failed predicate is remediated, and its rows are re-run on the same machine through the same path. The results keep both runs.
- Copy, an "experimental" label or a visible session never qualifies a required capability (D6–D8). Accepting less deviates from the owner's decisions: it happens only when the capability still blocks after remediation, and it is recorded in the specification with the scope profile and acceptance scripts (3.18.6).
- Rows without a required predicate (thresholds, best-effort apps, recorded behaviour) drive the decision in their row. A miss is decided and recorded before the dependent step starts.
- If S01 or S04 shows a scope or a detached process dying with the service, the placement changes in A4 and in the terminal adapters, and the row is re-run.
- Every row is repeated before each release as `ttasks doctor --live` or an acceptance check, with a qualification receipt (A4 5.3).

**What a gate holds.** A step behind a G2 predicate is built and merged once its code dependencies exist, to the lab's unattended findings. Its pull request lists what waits for a session. The gate decides whether the step may be called done on real machines, so M1.15 and M2.15 are not claimed before the sessions. If a session contradicts what was built, the fix comes first. G1 is qualified: R01 and R08, R02, R09 after remediation, R10, and bridge rule 1 provisionally.

| Required G2 predicate | Rows | State | What waits for it |
|---|---|---|---|
| The service starts at boot on Linux and at sign-in on Windows, through `ttasks service install` | S01, S03 | Pre-tests only | M1.15's reboot part and M1's definition of done item 4 |
| A terminal and a run survive a service restart | S04, S01 | Windows yes. Linux provisionally, from the S01 pre-test | M2.09 and M6.01 rely on it until session 3 re-runs S01 through the product's unit |
| Two installs on one machine never share an endpoint, and a stale lock recovers | S06, S09 | Yes at spike level and in CI | M1.15 on real machines |
| The service's login-shell snapshot finds the agent CLIs | E01 | Partly run | M2.09, M6.06 |
| For each required native target (T3 Code, Claude Code CLI, Codex CLI through the default Codex home) on each machine, a route opens the exact folder with the brief, and the session binds | L02, L04, L05 or L06, A01–A03 | No route row has run. Binding holds for Claude Code (A01, Windows) and Codex CLI (A02, both) | That target's route step (M2.10, or M2.11 with M2.10t) and M2's definition of done |
| Firefox on Windows and Linux: fragment-code bootstrap, token, WebSocket, strict CSP, clipboard | U01, U02 | Page parts pass headless | M2.12, M2.13 |
| Both CLI run adapters parse their streams and stop on request | N01, N02 | Windows yes. Linux: Codex in the default sandbox only | M6.06. The Linux streams join `fixtures/streams/` and the parser tests must pass on them |
| The Refresh path runs unattended | N04 | Not run | M6.07, M6's definition of done and the trial |

Go or no-go per required native target and machine is no-go until its route rows have run. Claude Desktop and the Codex app are best effort, decided by their rows.

**Definition of done.** Every row has a result and a decision. Every required predicate of G1 and G2 is qualified, or a recorded decision has changed the scope. All temporary registrations are removed, shown by key-level records. Each decision is written into its section.
**Owner reviews:** the results and the three lab sessions.

### 3.8 M1: core slice

**Goal.** The production write path, service and CLI, with a verified backup and restore, installed per user on Windows and Linux. No UI and no agents yet. The schema covers only what the skeleton needs, but every invariant is real: a staged plan and one transaction per request, a receipt for every outcome, field versions, a backup before every migration.

**Merged.** M1.01 to M1.14. What later steps take from them:
- M1.06's `BundlePolicy` (`packages/storage/src/backup/policy.ts`), which M3.07 extends to bundles. M1.02's driver contract suite (`packages/storage/test/driver-contract.ts`), which M3.13's fallback must pass. M1.07's crash harness, which grows with each storage step (3.18.1).
- Lab session 3 is M1.12's real-machine qualification (3.7).
- M1.14's scripts build only separate installs from local files: they take a root and a folder of release files, write nothing outside the root, and have no download code, so no test can reach the real user's install, PATH or registry.
- The release key does not exist yet. `RELEASE_PUBLIC_KEYS` (`packages/service/src/version/release-keys.ts`) holds a placeholder, so release rendering, `pnpm release sign` and `ttasks update` refuse, and only test builds, whose install scripts say so on every run, can be installed.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M1.15 | The daily install and real machines. The install scripts' default roots: the program in `~/.local/share/ttasks/` (`versions/`, `current`) and the command in `~/.local/bin/` on every OS (on Windows both stable launchers, which find the root at `<their folder>\..\share\ttasks` with `share` and `share\ttasks` checked as plain folders, A2 3.12.3; elsewhere the link `tasks` → `../share/ttasks/current/bin/ttasks`), with A2 3.12.4's PATH warning on Linux and the user `Path` entry on Windows. Data and configuration stay in `~/.ttasks`, with `install.json` and `update.lock` in `<state>`. `ttasks uninstall` plans the service entry's removal first (A2 3.3.5), then removes only what `install.json`'s `created` lists, and never anything in the data folder. Then on real machines: the Windows install with the Run value, a Linux test install with the unit and linger, A2 3.14's budgets with two generated spaces at the design scale (5,000 open and 50,000 completed tasks each), commit latency included, a backup and restore drill, and M3.01's installed-build migration drill (3.10) on Windows and Linux before any real space is upgraded to 0.2 (A1 5). The budgets and both drills run before the lab sessions. The reboot and sign-in part runs as lab session 3 and shares its reboots | M1.12, M1.14 | With the home folder set to a temporary folder: a default install puts the program, the command and the data in their places, and install then uninstall leaves the data folder as it was. The budgets and both drills pass on Windows and Linux and their numbers are recorded with the session. `pnpm accept m1 --installed` passes on Windows and Linux | M RM |

**Definition of done.**
1. The manifest entries owned by M1 (3.18.6) pass on CI (Ubuntu, Windows) and against the installed build on Windows and Linux: create a space, then add, patch, note, complete and reopen through the CLI, then back up and restore it. The migration drill passes on the installed build.
2. 10 CLI writers making 100 patches each on overlapping fields: every acknowledged write is present, every stale write returns a conflict, nothing is lost.
3. The 30-minute crash harness is clean on both OSes.
4. The service starts at sign-in on Windows and at boot on Linux, restarts after a kill, and a second instance exits 73. A test install beside it changes nothing for it. This item waits for lab session 3.
5. A2 3.14 targets for start-to-ready, idle memory and CLI p95 hold, or a decision is recorded before M2 is accepted.
6. No fixture text appears in any log.

**Owner reviews:** the acceptance transcript from Linux and `ttasks doctor` output.

### 3.9 M2: walking skeleton (Open)

**Goal.** From a bare page in Firefox, the first user opens a task in T3 Code, Claude Code CLI or Codex CLI in the task's exact folder, with the brief, on Windows and Linux. The agent reads the task and logs progress through the product's tools, and the page shows it live. This is D5's walking skeleton, standing on the production core.

**Merged.** M2.01 to M2.14, and M2.04b the grant gate. What later steps take from them:
- Tool definitions are measured and reported, not capped, and kept lean: a field or description earns its place by preventing a wrong call (A3 3.2.5).
- A field or section the request path cannot serve yet is refused with the step that brings it (`unsupported()` in `packages/service/src/ops/errors.ts`), and each LATER example of the contract suite (`packages/service/test/contract/suite.ts`) names its step. The step that builds one moves its example to VERIFIED.
- M2.08 to M2.11 are built against fakes. Real terminals, T3's server and the boot-started snapshot are qualified only by the lab sessions (3.7), and M2.10's routes also rest on L02 to L04 and L09. Each assumption fails safe: a refused or unknown answer is a defined launch state, and a rollout file of another shape matches nothing.
- **Binding** (`packages/service/src/binding/`, A3 3.7). Nothing an agent chooses, a folder or an environment variable, ever binds. Session records live in `<state>/sessions.json` until binding writes A1's `sessions` table, which migration step 0003 adds (A4 3.10). Tests `A3.3.7.binding.*`, and `tests/forwarder/binding.test.ts` for a real service restart through a real bridge.
- **Setup** (`packages/service/src/setup/`, A3 3.13). The engine runs in the CLI, in the person's session, so each app's command is the one on the person's PATH. It takes everything it reads and runs as input (`SetupInput`), so the service can run it for the first-run screen (M5.12).
- **The grant gate** (`packages/service/src/ops/grant.ts`, `hub/home-gate.ts`, A3 3.7.8, 3.7.9). An agent home reaches only the spaces its live agent-home rows name, keyed by its entry's `--instance`, and its unbound writer scope is its row. Tests `A3.3.7.grant.*`. A test that opens MCP connections registers its agent homes as setup does. A4's refusal of a launch into an ungranted space is still to build (A4 3.9).
- **Brief and routes** (`packages/launch/src/brief/`, `src/routes/`, A4). Tests `A4.5.brief.*`, `A4.5.routes.*`, `A7.3.9.m2-10.e2e.copy`.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M2.10t | T3 Open from the page and the questions before dispatch, the part of M2.10 not built (A4 3.4.1; A5 3.8). `LaunchService` takes the hub's `T3Route`, and a click on a T3 instance runs availability, prepare, the Register question for a nested folder, plan, dispatch with the grant, and `confirm` after Dispatched and after recovery. Recovery's grant and replay call the route. The thread opens through A4 3.6.5's opener with the prefilled brief within T3's 8,000 characters and the title `<reference> <title>` through the sanitiser. The account check reads the instance's `spaces` and the area's accounts. The opener also replaces the minimal openers of `ttasks open` and `ttasks setup t3`. The click takes `chooseT3Route` and also connects M6.10's CLI route when T3 is not paired (A4 3.9.1). Until this lands, a T3 instance answers `no_route` | M2.10, M2.11 | From the page with a fake T3 server: Open on a task whose folder is a T3 project's root reaches Confirmed. A nested folder asks Register, and Not now makes T3 unavailable for that task. A service restart after dispatch confirms or leaves Unknown and never dispatches again | M |
| M2.15 | Real-machine acceptance with the owner on Windows and Linux: the definition of done below, then 3–5 days of use. Before real tasks, a backup of each space is verified (M1.06). The work space comes only at the real-use point (3.6). With the owner, `ttasks setup agents`, then `--apply`, then `--remove` in the real homes the owner names (on Linux only the default Codex home): the real `claude mcp add` and `codex mcp add` write the entry exactly as asked, `codex mcp remove` drops the patched keys with the table, and Codex loads `startup_timeout_sec` and `env_vars` | M2.01–M2.14, M2.04b, M2.10t, M1.15, lab sessions 1 and 2 | One pass or fail per target and machine, recorded with the session | S RM |

**Carried into the remaining route steps (M2.10t, M6.11 and custom targets).** Routes build on the target catalogue and `Instance`, and check the reserved `[[custom_target]]` and `[override.*]` sections. A space-carried target definition is checked against the approvals in `machine.toml`. A space opened from an import starts with every space-defined target disabled, and the approved content is kept so the approval card can show a diff (A4 3.2). The `machine.toml` reader marks `{cwd}` and `{title}` in a custom terminal line as problems, which today only the launch refuses.

**Early demo.** After M2.08 to M2.10, M2.12 and M2.13, the first user can open a task in Claude Code on Windows from `pnpm ttasks`.

**Definition of done.**
1. On each machine, for each native instance (T3, Claude Code, and Codex through the machine's default Codex home), Open on a sample task opens the app visibly in exactly the task's folder. T3 shows the brief as an unsent draft. The CLIs show the sent brief ending "Read the task, then wait for my instructions". When setup detects a second Codex home (a wrapper with its own `CODEX_HOME`), it proposes it as an instance of its own. Only the user adds it, and agents never launch it.
2. The receipt moves from Dispatched to Confirmed when the agent calls `get_task`. The agent's `add_entry` appears in the page within 1 s with the instance's label.
3. A task in a nested folder of a T3 project asks "Register … as a T3 project?". Not now makes T3 unavailable for that task. No route ever opens a containing project.
4. Copy puts the pointer brief on the clipboard. Pasting it into a session with the product's tools binds through the launch reference.
5. Killing the service during a launch leaves the receipt Unknown and never re-dispatches. Restarting the service leaves open terminals alive, shims reattach, and bridges reconnect.
6. Every manifest entry owned by M2 passes, on CI and against the installed build on Windows and Linux.

**Owner reviews:** the page in Firefox on Windows and Linux, every Open, the brief wording, the receipts and the monogram tiles (A5 open item 3). The first user then uses the skeleton for 3–5 days and notes friction without task content.

### 3.10 M3: durable space

**Goal.** A1 complete for v1: undo and revert, the full lifecycle, redaction, search, dedupe, export bundles, transfer and claim, sync detection, the projection, preferences, the hooks later phases need, the fallback driver and the full crash suite, measured at scale.

**Merged.** M3.01 schema 0.2 and its migration, M3.09 synced and network folders and the read-only modes. A1 states what they guarantee: released schemas are frozen, migration step 0003 (schema 0.3, M6.01) added the `sessions` and `runs` tables and rebased the stand-in step to 0.4, and the next change is step 0004; a migration never touches a backup but its own, and a failed one is not retried by the same build on an unchanged database (A1 3.17); the folder check never makes a space writable when it cannot see (A1 3.2). The importer's tables (`exchanges`, `exchange_items`, `proposals` with origin `import_conflict`, `space.hold`, `aliases`) are in 0.2. There is no `space move` (section 6, item 27). Still to build from A1 3.2: the two actions for a failed check with M3.07, `quick_check` after an unclean shutdown and after an outside write with M3.15, and their buttons on the read-only bar (A5). Stale-restore detection moved from M3.07 to M3.08: one `seen` record per space cannot keep a sibling's freshness or a long ancestry, and a claim's record must survive a crash, which is M3.08's authority work (A6 3.5).

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M3.03 | Revert one commit and revert a session, both with preview (A1 3.10.2–3.10.3) | M3.02 | A 500-commit session revert takes under 500 ms. The preview equals the applied result. A session revert never removes a later human change | S |
| M3.08 | Authority: machine keys and host fingerprint, a new `ai_` incarnation and lineage entry on every claim, transfer import and restore-claim, a claim epoch of one more than the highest known locally, `ttasks space export --mode transfer --to <machine>` with a `tr_` transfer ID, durable `preparing`, `published` and `finalized` states, restart reconciliation, `ttasks space transfer --finish\|--cancel` and a `transfer_cancelled` incarnation, `transfers_imported`, two Claims of one backup detected as competing branches for the user to resolve with `ttasks space resolve`, fork, and stale-restore detection with its three requirements: a freshness floor per copy, ancestry that is never cut off, and a claim intent that is durable before the claim commits and reconciled after a crash (A1 3.18; A6 3.5) | M3.07 | Random export, import, claim, fork and restore sequences: two Claims of one backup, at the same or at different epochs, are detected, never merged. A duplicate or misdirected transfer import never becomes authority. A crash at each transfer state reconciles on restart. A stale copy opens read-only: an older copy of a sibling after a later sibling was seen, an ancestor after any number of claims, and the ancestor's folder after a crash between a claim's commit and its record | M |
| M3.12 | Hooks for later phases: the `ExecutionStore` contract suite that a later machine-local journal must pass, incarnation checks on `as_of`, `base`, cursors and receipts, and the filtered change-feed batches tested with a synthetic audience filter, which needs a row-level visibility rule applied to the snapshot and to every row as well as the commit filter, because a row shows every change ever made to it. v1 still sends every operation (A6 3.3, 3.7; A1) | M3.08, M2.12, M2.05 | A long interleaving of hidden and visible operations, dropped batches and reconnects keeps coverage gapless through empty batches and never reveals a hidden operation. The filtered batches pass the page's `LiveCore` interleaving property (`packages/web/src/store/core.test.ts`). A base, cursor or receipt from another incarnation gives a resnapshot or a conflict, never a match | S |
| M3.13 | Fallback driver: `better-sqlite3` in `loadDriver()` behind the same `driverContract()` suite, plus a CI job with the driver switched (A1 3.19). It needs `safeIntegers(true)` with the same exact-integer conversion, the same parameter check (`sql-text.ts`), the same fixed error messages, and the same file-name, backup-target and authorizer rules: opens through the literal path, backups into a new file only, `ATTACH` and `VACUUM INTO` of a named file refused, the folder pragmas refused. This step finds how `better-sqlite3` enforces the last | M1.02 | The full storage suite passes with the other driver on both runners | S |
| M3.14 | Redaction: human-only `redact` in entity and text mode, through one traversal of every store: state, `changes`, `commits.ops`, `history_text`, proposals, exchanges, receipts, the search tables, the projection, the outbox and caches (A1 3.11.4) | M3.04, M3.05, M3.10 | Sentinel text redacted in each mode is absent from every store and every read path afterwards. An agent gets `forbidden` on `redact` | S |
| M3.15 | Full crash and model suites: every fault point of A1 5 that v1 owns, disk full on a small filesystem, outside-write detection, the model test with 3–12 actors, and the harness additions of 3.18.1 | M3.02–M3.14 | Nightly 30 minutes per OS clean. Disk full gives `DURABILITY_FAILED` and read-only, with no partial commit | M |
| M3.16 | Scale on Windows and Linux: the design scale (5,000 open, 50,000 completed) and the stress corpus (10,000 open, 100,000 completed) against A1 3.20 and A3 3.9.9. Decide A1 open items 2–4. M0's R05 failed on Windows for broad queries: this step first chooses a query design for broad terms (capped candidates, a cheaper order past a match-count limit, or a restated broad-query target) and re-runs R05 on Windows and Linux with the storage bench (3.7). The search targets stay unmet until that re-run passes | M3.05, M3.10 | The targets hold or their decisions are written into A1 and A3. The numbers are recorded with the session | S RM |

**Carried into M3 from the write path.** `history_text` and the `{"$t": hash}` form for text of 1 KiB or more. `ext.<key>` fields, which `fv` decoding must then accept. Labels. Revert on the change rows M1.04 writes, with M3.02's inversion engine (`write/history.ts`). A6 3.16.4's secret scan of written text adds warnings to the result. A1 3.6's space hold and transfer states become `SPACE_READ_ONLY` reasons. A1 3.9's outside-write check on `PRAGMA data_version` before each `BEGIN IMMEDIATE`. The operations `source.unlink`, `source.patch`, `note.patch`, `note.delete` and `log.delete`, whose fields join `CHILD_FIELDS`. The folder operations are M4.09's.

**Definition of done.**
1. Every manifest entry owned by M3 (3.18.6) passes on CI with both drivers.
2. Nightly crash injection stays clean on both OSes for seven consecutive nights.
3. Restore drill on Windows and Linux: backup, restore into a new folder, `integrity_check`, the same `last_seq` and counts. A copied folder opens read-only (A6 K2). Two Claims of one fixture backup, made on Windows and on Linux, are reported as competing when one copy reaches the other machine (A6 5).
4. The installed-build migration drill passes on Windows and Linux before real spaces move to 0.2.
5. Scale targets hold, or the decision is recorded.
6. The projection of the sample space reads well in a file manager, and `catalog.jsonl` lists every task.

**Owner reviews:** the `view/` folder of a real space, the restore drill output and the scale note.

### 3.11 M4: agent interface

**Goal.** A3 complete: all ten tools plus `run_report`, autonomy and proposals, the full digest, setup for every app, complete binding, doctor and the agent evals.

**Merged.** M4.05 setup for the remaining apps and doctor's agent side. What later steps take from it:
- **Setup** (`packages/service/src/setup/`, A3 3.13). One table of apps with two writers: the app's own command (Claude Code, Codex) and one entry spliced into the file (Claude Desktop, `json-edit.ts`), with one survey, plan token, record and ownership check for all. The Codex app and T3 Code are hosts of the CLIs' homes, kept on the agent-home row, and T3's settings are only read. Managed rules 3 and 4 (`managed.ts`) judge the configuration file, and M4.04 uses them for instruction targets. `approve-tools` only prints the change, and `print --app` prints a hand-made entry, which the grant gate lets use the machine's default space. Tests `A3.3.13.setup.apps`, `A3.3.13.setup.json-edit`, `A3.3.12.setup.managed`.
- **Doctor's agent side** (`packages/cli/src/doctor-agents.ts`, A3 3.14). It reads no agent home until setup has a record. Every program setup, detection and doctor start is a helper of one runner (`@ttasks/launch` `helpers.ts`), which ends it with what it started at its deadline and synchronously when the process exits, and their modules import no `child_process` (dependency-cruiser). `--live` asks `setup/seen`, which the service feeds after each tool call it carried out. Tests `A3.3.14.doctor.*`.
- The first-run screen (M5.12) asks which of several Claude Desktop files the app uses (`--home`), and stores a declined T3 home before doctor's `t3.homes` can leave it out.
- The real apps' folders, formats and headless flags wait for a lab session (A3 5, "Setup and doctor for the other apps").

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M4.02 | Autonomy and proposals on the staged plan's actual targets: levels, per-action and per-area overrides, the stricter of source and destination for moves, the decision table, proposals with base versions, user-only accept and reject, the writer's `policy(plan, scope)`. The burst brake at 51 affected records, counted from `commits.affected` per writer scope from a writer's first call (A3 3.7.9: the session, else the agent home's grant, else `agent:unknown`, `script` or the user's scope). Defines the proposal section payload of `task.get` (A3 3.7.9, 3.8; A1 3.10.5; A6) | M3.01, M2.03, M2.04b | Exhaustive decision-table test over actual targets. Binding after 10 unbound completions does not reset the count. Accepting a proposal whose base field moved fails as stale | M |
| M4.03 | Digest v1 and framing: provenance labels, nonce-delimited data block whose markers are drawn after checking the whole rendered payload, every user- or agent-editable name framed as data, up to three related learnings, notes from the user for agents never silently cut (an overflow line and paging through `get_task` sections), the sanitiser on write, the secret pattern warning (A3 3.9.6–3.9.7, 3.10; A6 3.16.2, L4) | M3.01, M3.05, M2.03 | Digest property test: never over the cap, `+N more` when cut, the marker never in content, a user note whole or behind the overflow line. An injection sentence as an area or label name appears only inside data blocks. Tag characters removed | M |
| M4.06 | Binding complete, on M2.04's binding service, with every input from the authenticated bind frame: bind frame rule 3, native IDs alone, on the IDs M2.04 records (Claude preset, Codex reference match, T3 thread ID). Shared hosts beyond M2.04's guard: host detection from ancestors, Claude Desktop chat without a session ID, per-call binding by native ID, `durable: false` with its hint. User-only `session.unbind\|rebind\|end`, which end a session and its handles. The session list and Resume rules. The session record made with the launch intent before dispatch (A3 3.7.7), so a `cli-agent` call before any bridge bound maps to its session. The result says "this session is bound to M-14" for an explicit task on a bound connection. Defines the session section payload of `task.get` (A3 3.7; A4 3.10) | M2.04 | A3 section 5 binding tests. Resume is offered only with a trusted native ID | M |
| M4.07 | Source ingestion: key namespaces, the refresh guide in `status`, coverage shapes for `run_report` (A3 3.11) | M4.01 | A refresh fixture run twice through fakes creates nothing the second time | S |
| M4.08 | Interactive agent evals: a harness for headless Claude Code and Codex on temporary spaces, run by hand on Windows. A3 section 5 scenarios 1, 3, 4 and 5, and scenario 2 in its ingestion form: an interactive session ingests a fixture inbox twice through `add_tasks`, with no run adapter and no `run_report`. Scenario 2 as a real routine run is M6.14 | M4.01–M4.07 | Pass or fail per scenario and app, with the tokens used, recorded with the run | S RM |
| M4.11 | Folder follow-ups. The projection's `folder` front matter and a project file's folders (A1 3.13), the remote envelope types in `packages/contracts/src/remote.ts` on A6 3.8.1's `folder` shape with `folder.check`, the old `place.*` history shown as text in the page (A1 3.4), the writer's refusal of new `place.*` operations, and the retired test IDs taken out of `tests/manifest.json` once no test carries them (A1 5) | M4.10, M6.16, M3.10 | `pnpm verify` with no manifest entry of a retired ID and no product code that emits `place.set`. A request with `place.set` is `VALIDATION_FAILED` on `kind`, and a commit in history that holds one still undoes. The projection of a fixture task shows its folder on each machine | S |

**The folder lane.** M4.01b, M4.09 and M4.10 go to one implementing agent, in that order (3.6). M4.09's pull request owns the migration step.

**Definition of done.**
1. Every manifest entry owned by M4 passes: A3 section 5 unit, property, crash and binding tests, without the real-run and routine cases that M6 owns.
2. Evals: scenarios 1, 3, 4 and 5 and the ingestion form of scenario 2 pass in Claude Code and Codex at Full, and scenario 1 also passes at Suggest.
3. `ttasks setup agents --apply` and then `--remove` on the owner's real homes on Windows change only the product's keys, shown by a key-level record. Each preview is shown and saved, with an entry backup, before it applies.
4. `ttasks doctor` is green on Windows and Linux for every registered home.
5. Definition sizes are reported from the generated definitions, not capped (A3 3.2.5).

**Owner reviews:** the setup previews, the eval report and the doctor output.

### 3.12 M5: the planner UI

**Goal.** A5's v1 scope in Firefox and Chromium, replacing the skeleton page. Every UI step's brief cites `VISION.md`.

**Merged.** M5.01 app shell, M5.02 live store, M5.03 task row and virtualised list, specified as built in A5 (the shell and space per tab in 3.3, the row and the list in 3.6 and 3.15, themes in 3.19, the build in 3.24). What later steps rely on:
- **The live store** (`packages/web/src/store/`) is one plain module without React, proven by a model-based property over a lossy, reordering network (`core.test.ts`, `test/feed-model.ts`) and against the service's own snapshot and batches. A change to its rules keeps both tests passing. Views read rows only through `useLive()` and hold no copy of them.
- **A view hands its rows to the list,** never draws its own, so the list's rule that nothing moves under focus (A5 3.15) holds in every view.
- Until `pref.set` and the snapshot's preferences exist, the theme is kept per browser in `localStorage`, read as untrusted.
- The row shows what the page has. Its sources, folder and marker columns stay empty at their width, and a tile is Ready after a reload until the task's receipts are read, until the steps below bring that data.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M5.07 | Composer and action strip: Note, Open per instance, Run (shown, wired in M6.09), Copy and Shift+Copy (A5 3.8). The strip replaces the expanded row's toolbar of instances and Copy | M5.06 | Composer keys including IME composition. Open passes the composer text to A4 | S |
| M5.09 | Receipts and run status, proposals and the review card, changed marker and digest. `ui.mark_seen` and `ui.clear_digest` as user-only calls outside history (A5 3.9, 3.10, 3.14, open item 6). The row's marker (`RowInput.marker`), receipts and run states on the tile. The snapshot carries each task's latest launch per instance, so a tile shows Connected after a reload, and the feed's launch entities carry their `task`, so the list refreshes only that task | M5.06, M4.02 | Each receipt and run state renders from fakes. Unknown never re-dispatches. Partial accept of a proposal | M |
| M5.12 | First-run setup steps 0–5 (A5 3.17). Step 5 opens M5.14's Add project, and until M5.14 merges it is left out. Its agent step calls M2.14's engine in the service through `SetupInput`, once the service has A4 3.8's agent environment. New space and Open folder in the space switcher | M5.11, M4.05 | First run end to end with fake detection, including a managed source and Skip | S |
| M5.13 | Quality pass: axe on every screen in both themes, the list included, the XSS suite, screenshot baselines at 1,440, 1,280 and 390 px, the 5,000-task performance test in CI and on Linux (the sweep of `list.e2e.ts` records frame times), NVDA and Orca passes, the pseudo-locale on every message and the compact dates (A5 5). The list derives every item again when the store publishes: this step measures that against A5 3.25 and derives per event where a budget fails. The app icon replaces the placeholder ring | M5.01–M5.12, M5.14 | The owner approves the baselines. The Linux numbers meet A5 3.25 and are recorded with the session | M RM |
| M5.14 | Add project and folders in the page: the Add project flow with device, source and the folder browser, `folder.browse` (bounded entries and time, links not followed, hidden folders marked, the drives on Windows), `folder.make`, `folder.reveal`, the project card, the expanded task's folder with Change, Choose folder and Clear, Use the same folders here (`folder.adopt`) in Settings › Folders, and the sidebar's Add project (A5 3.3, 3.7, 3.11, 3.18, 3.29; A1 3.15) | M4.09, M6.16, M5.06 | Playwright against a temporary home: A5 5's Add project cases, keyboard only included. A listing that does not answer within 2 s shows "Did not answer" and the page stays usable; after ten listings of a folder on a share that never answers (a fake that blocks), at most two workers wait for that share, and a folder on another drive still lists at once. A restored space whose project has paths of two machines that both exist here offers one of them. A restored fixture space with another machine's folders binds the chosen existing paths in one commit, and one undo takes them back | M |

**Definition of done.**
1. Every manifest entry owned by M5 passes in Firefox and Chromium: A5 section 5, including the repetition rules (the date appears once, counts appear only in the sidebar, no uppercase, no view heading).
2. The screenshot set is checked against `A5-mockup.html` in Sumi and Washi (Sumi only under a profile that cuts Washi), the result is recorded and the set is offered for the owner's review.
3. A5 3.25's targets hold on Linux in the Firefox snap with 5,000 open tasks.
4. Every flow works keyboard-only.
5. The first user uses the UI as the daily list in a space of their own on Windows for five days.

**Owner reviews:** every screen in both themes, Today with real tasks, the keyboard flow, the font (A5 open item 1) and the monograms (A5 open item 3).

### 3.13 M6: runs, routines and every v1 target

**Goal.** A4's runs through the two CLI adapters, the two routines on request, the TTasks work folder for tasks without a folder, folder resolution by task and project, the remaining targets and a safe update path. The T3 run adapter comes after v1. T3's interactive Open is unchanged.

**Merged.** M6.05 stream parsers and fake agents (3.18.1), M6.10 T3's `t3-cli` fallback route and the choice between T3's routes (A4 3.4.1), M6.12 update from a local archive (A2 3.12.6), M6.13 stable launchers on Windows (A2 3.12.3 step 10, 3.12.6 steps 8, 10 and 14, 3.3.2). What later steps take from them:
- M6.01 moves `RunEvent`, `RunOutcome`, `Usage`, `ProgressLabel`, `AppToolsState`, `OutcomeReason` and the caps from `packages/runs/src/streams/events.ts` into `packages/contracts`, and settles the label-key and `session` changes there. M6.03's shim feeds stdout bytes to `push()` (or whole lines to `line()`), journals the events and writes `exit.json` from `end()`. M6.06 compares `session.cwd` with the run's folder, marks the run "without TTasks tools" when `appTools` is not `connected`, and uses `counts.declined` and `counts.permissionDenials` in the run's message.
- The T3 CLI route is built against a fake T3 and a fake `t3`, and is not connected to Open: M2.10t connects it with the paired route (A4 3.9.1). Nothing of T3's command line has been observed. Each assumption fails closed, and M0-L06 records what A4 5.3 lists. Tests `A4.5.t3.cli-route`, `A4.3.4.1.t3.cli-command`.
- The updater refuses every archive while `RELEASE_PUBLIC_KEYS` holds the placeholder. It writes only the program's own files and never removes a version folder, so versions accumulate until M6.12r.
- **Stable launchers** (`switch.ts` `placeLauncher` and `cleanLaunchers`, `launcher.c` `repair_sibling` and the supervisor's hand-over). An update stages each changed launcher before the switch and swaps it by one rename where Windows allows it, else two; a launcher puts back its missing sibling from the version `current` names, only while an update's journal is there; a replaced `ttasksw.exe` hands the service over before any restart. Tests `A2.3.12.6.update.stage`, `.launchers`, `A2.3.12.3.launcher-win.sibling`, `A2.3.3.2.launcher-win.handover`. The real-install helpers of the updater's tests are in `tests/update/installed.ts`. An uninstall that finds a journal removes `current` before the stable launchers (A2 3.12.4), and M6.12r's leases cover the stable launchers too.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M6.02 | Supervisor and limits: caps (3 per machine, 2 per instance, 1 per task), folder leases, executor presence, wall and idle timeouts that the shim enforces while the service is down (A4 3.11.7) | M6.01 | Random starts never exceed a cap or share a lease. A timeout fires with the service stopped | M |
| M6.06 | Run adapters `claude-print` and `codex-exec`: transient units on Linux, detached processes on Windows, logs and results, permission per instance, `run_report` permitted on run and routine bindings (A4 3.11.3, 3.11.5–3.11.6; A3 3.4.12) | M6.04, M6.05, M4.01 | Fake-agent runs end to end. A run's exit never changes its task. `run_report` succeeds on a run binding and returns `not_permitted` on a task binding | M |
| M6.07 | Routines: record, approval hash, work folders, one at a time, `schedule` stored and validated but never evaluated. Refresh from sources (template, source list, watermark, coverage) and Wrap-up (up to 10 tasks) (A4 3.12, 3.13.1) | M6.06, M4.07 | A Refresh fixture run twice creates nothing the second time. The watermark moves only on full success. Wrap-up keeps every original text | M |
| M6.08 | The TTasks work folder: one per space on each machine, `<machine state>/workdirs/space-<space-id>/`, never a project folder or inside a space. M2.08 built the folder with its checks, and a launch with no place already works in it. The resolution returns `{folder, kind}` with `kind` `task`, `project` or `work_folder` (A1 3.15's `resolve`, from M6.16; before it, today's places with `place`). Open and Run for a task with no folder of its own or its project's anywhere use it, along the routes L12 recorded. A task with a folder always uses exactly that folder (A4 3.3; A5; R11) | M6.06, M2.11 | A task without a folder opens in each native target and runs in its space's work folder. A task with a folder, its own or its project's, never uses it. An agent still cannot launch (R7) | S |
| M6.09 | UI: Run from the composer, the message box, Continue interactively, Refresh in the top bar with routine status, run entries in the thread, "TTasks work folder" shown for tasks without a folder (A4 3.11.10–3.11.11; A5 3.8, 3.9) | M5.07, M6.07, M6.08 | Playwright with fakes: Run, Stop and Continue. Refresh shows "Refreshed 09:12 · Jira unreachable" from a fixture. Open on a task without a folder shows the work folder | M |
| M6.12r | Version retirement, the part of M6.12 not built (A2 3.12.6 step 14). Garbage collection keeps `current`, its two predecessors, `install.json`'s `previous` and every version a journal names, and retires a version only under exclusive version-use leases, because a process may still run from it. This step settles the lease's form per OS, who takes it at launch, how garbage collection acquires it exclusively and how a crashed holder's lease is released, and A2 3.12.6 states that rule before garbage collection is built. Retirement is journalled and resumes after a crash | M6.12 | On the Windows runner and on Linux: a version in use is never retired, a retirement killed between the move and the last delete, a partial deletion retried, and a held file in the garbage folder each end clean. The leases hold for the stable launchers of M6.13 | M |
| M6.14 | Real-run contract, by hand on Windows: A3 eval scenario 2 as a real Refresh routine on a fixture inbox through both CLI adapters, and the routine whose MCP host initializes from the offline cache during a service restart, then calls `run_report` with full coverage (A3 5) | M6.07, M4.08 | Pass or fail per adapter, with the tokens used, recorded with the run | S RM |
| M6.15 | Real machines: Refresh twice on Linux through Codex into a trial space, along the path N04 qualified, now through the product, a Wrap-up, cancel on both OSes, a task without a folder and a task in a project's folder opened and run, `ttasks doctor --live` qualification receipts for every v1 target on Windows and Linux | M6.01–M6.14, M6.16, lab session 3 (N04) | Receipts and pass or fail only, no content, recorded with the session | S RM |
| M6.16 | Launch and service on folders. A1 3.15's `resolve` in place of the place resolution for Open, Run, the row's tile and the digest; A4 3.3's launch check ("Folder not found on this computer"); the plan and the claim reply carrying the folder row and its path; `checkWorkingFolder` kept for the moment between the check and the agent's start, and the Git remote no longer read. `here`, `status`, `on:cwd` and the cwd boost by the deepest project folder. Roots retired: `[roots]` and `[roots.*]` ignored and named once by doctor, `ttasks roots` the pointer, `root_rev` and `roots.json` no longer read or written (an existing file left where it is). T3's Register titled by the project. Runs in any folder, with no runs flag (A1 3.15; A2 3.2.4, 3.10.1; A3 3.4.2, 3.9.2; A4 3.2, 3.3, 3.11.7, 3.14) | M4.09 | With fakes: a task with its own folder opens there in each native target, one without opens in its project's folder, one whose project's folder is on another machine shows "Opens on <machine>" and never the work folder, and one with neither opens in the work folder. A folder removed between the click and dispatch fails the launch with `folder_missing` and starts nothing. `here` in a nested project's folder names the deepest project. A `machine.toml` with `[roots.work]` parses, doctor names it once, and no command changes the file | M |

**Conditional steps (not in the base).**

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| F1 | Native forwarder `ttasks-bridge` in Rust, only if bridge rule 3 fires: framing, the handshake order of M2.01 and the bind frame (A2 3.7.6) | M2.01 | The handshake and pre-authentication parts of the conformance suite pass with `TTASKS_BRIDGE_BIN` | M |
| F2 | Offline responder with the cached tool list, reconnect and `resume.handle` | F1 | The full conformance suite passes with `TTASKS_BRIDGE_BIN` | M |
| F3 | Builds for linux-x64, linux-arm64 and win-x64 in the version folder, selected by the bridge rule | F2 | CI builds and smoke-tests each | S |
| F4 | B01–B05 re-measured on Windows and Linux, then the default switched | F3 | Thresholds of A2 3.7.7 hold, recorded with the session | S RM |

**Definition of done.**
1. Every manifest entry owned by M6 passes: A4 sections 5.1 and 5.2 without the scheduler and T3 run tests, so crash injection at every run boundary, no second agent, no lost or doubled stream event.
2. Runs and open sessions survive a service restart and an update, including a crash between a launcher's rename and its copy.
3. On Linux, Refresh run twice creates no task the second time, reports one coverage row per source, and moves the watermark only on full success.
4. Cancel works on both OSes, gracefully or through the recorded fallback, and leaves no process of the run's group.
5. Wrap-up writes outcome and learnings and leaves context, notes, log and sources byte-identical.
6. A qualification receipt exists for T3, Claude Code and Codex on Windows and Linux, and for Claude Desktop and the Codex app unless the scope profile cuts them. A best-effort target whose check failed shows "experimental". A required target never does.
7. A task without a folder opens and runs in its TTasks work folder on Windows and Linux, and a task of a project with a folder opens and runs in that folder.

**Owner reviews:** the trial space after Refresh (on Linux only), run entries in the thread, one Wrap-up result, a task opened from the work folder, and how Claude Desktop and the Codex app behave.

### 3.14 M7: switch-over

**Goal.** Rehearse, cut over and run the trial. When the gate in 3.16 passes, v1 is done.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M7.09 | Rehearsal with the owner on the machine that holds the real work data (3.16.2) | M5.13, M6.15 | Rehearsal clean, findings fixed | S RM |
| M7.10 | Cutover and the 10-day trial, run by the first user (3.16) | M7.09 | The gate in 3.16.3 passes | S RM |

**Definition of done:** the retirement gate in 3.16.3.
**Owner reviews:** the rehearsal, the cutover, a daily check during the trial and the gate review.

### 3.16 The retirement gate

#### 3.16.1 Parity

Parity means the first user can do every daily thing done with the prototype, in TTasks, on Linux, on the machine that holds the real work data.

| Prototype | TTasks v1 | Checked by |
|---|---|---|
| A morning page: due soon, focus, suggested next | Today (A5 3.4) | The first user confirms by trial day 5 that Today replaces the morning page |
| Views: all open, waiting and delegated, needs review, checked off, completed | Open, Waiting, Review, Backlog, Completed, Agents and area views | Daily use |
| A Jira view built from `jira.json` | No separate view. Ticket sources on tasks and the search filter `source:ticket` (A3 3.9.2) | An explicit exception the owner accepts |
| Grouping by category, then project | Area, then project | Daily use |
| Row icons open the email, chat, ticket and folder | Source icons and the folder button | Five random tasks a day |
| `/` search over titles, next steps, evidence, people, paths and links | Top-bar search (FTS5) | Finds a completed task by a word in its evidence |
| Check-off, archived later by an agent | Check-off completes at once, with undo. Wrap-up on request | Daily use |
| A star for focus | Star | Daily use |
| Refresh from mail, sent mail, chat and the issue tracker on request | Refresh through Codex | Daily |
| Agents in any project update the ledger | The product's tools and server instructions in every agent app | Sessions log through the tools |
| Bookmarkable views | A URL per view and task | Once |
| No unattended sending or ticket changes | A read-only Refresh template, nothing scheduled | Run review |
| No account, no network | Local service | Built in |

Beyond parity, TTasks adds what the prototype lacks: Open in agent apps, notes, field edits, undo and history.

#### 3.16.2 Rehearsal and cutover

**Rehearsal, before day 0 (M7.09).**
1. Update the first user's daily install, in use since the real-use point (3.6), to the release candidate. `ttasks doctor` and `ttasks doctor --live` are green.
2. Open five tasks with folders (their own or their project's) in each native target, and one task without a folder. Run Refresh twice and count duplicates. Run Wrap-up on two completed tasks.
3. Fix the findings and repeat until the rehearsal is clean.

**Cutover, day 0.**
1. In the prototype page, connect the folder or export, so no browser-only check-offs or stars remain.
2. Freeze the prototype: make its folder read-only and archive a copy. From here TTasks, not the prototype, is the source of truth.
3. `ttasks setup agents` for the machine's default Codex home and Claude Code, each granted the work space. The first user adds a second Codex home if needed. T3 needs nothing.
4. The first user replaces the prototype's global agent rule in the managed instruction source with the product's overlay, or removes it. The server instructions suffice (D15).
5. Save the Refresh source list, approve the routine and run it once.
6. Create a task "Switch-over log" and record day 0 there.

**Each trial day (1 to 10).**
- Morning: Refresh, then Today.
- During the day: Open tasks in T3, Claude Code and Codex as work requires.
- Evening: one pass or fail line per criterion in the switch-over log.

**Day 10:** gate review with the owner. The frozen folder stays archived. Deleting it is the first user's separate decision.

#### 3.16.3 Criteria

All must hold at the end of the trial. A criterion that the active scope profile removes (3.18.6) does not apply.
1. **No lost work.** No acknowledged write is lost. Doctor, `integrity_check` and a verified backup are green every evening. One restore into a new folder during the trial matches the live space.
2. **Launch.** The first user opened tasks on every trial day, across T3 and at least one CLI. Every receipt shows the exact folder and the intended account. Nothing was retried automatically. No launch opened a wrong folder or account.
3. **Refresh.** It ran unattended, through Codex, on at least eight of the ten days. Repeats created no duplicates. Coverage was reported per source. The watermark advanced on full success.
4. **Agents.** Sessions in Claude Code, Codex and T3 updated tasks through the tools, with no file edits to the space's data.
5. **Daily use.** Today was the morning page, and check-offs and stars happened only in TTasks, on every trial day.
6. **Undo and conflicts.** Undo or revert was used on a real agent change and worked. A scripted same-field race on a copy of the space produced a conflict, not an overwrite.
7. **Wrap-up** ran at least once and left every original text intact.
8. **Operations.** The service survived at least one reboot and one `ttasks update` with sessions open.
9. **Speed.** Today becomes interactive within 800 ms on Linux. The service stays within A2 3.14 at idle.
10. **Boundaries.** No sudo, no managed policy changed, no work data left its original machine.

**Trial length.** Ten working days. A blocking failure pauses the trial. After its fix, at least five consecutive clean working days must follow before the gate review. Other defects are filed and fixed without pausing.

**Blocking failures:**
- an acknowledged write lost or corrupted
- a launch in a wrong folder or account
- the service unavailable for more than an hour of working time
- Refresh failing on two consecutive days
- the default Open target failing for a whole day

### 3.17 After v1

| Milestone | Adds | Foundation hooks already in v1 | Scope |
|---|---|---|---|
| **M8** Task-list essentials | Recurring tasks with the RRULE subset that the scheduler shares (A4 3.13.1). Reminders: the service evaluates due times, notifies through the installed web app, and applies a missed-while-asleep rule. Quick capture outside the app: a PWA shortcut, `ttasks add` with natural-language dates, an optional OS hotkey. Natural-language dates everywhere. Explicit file import (A1 3.14), applied only by a human. Anything cut from v1, with the manifest entries its scope profile moved here | `due_at` and `due_tz`, `planned_for`, `parent_id` reserved, the preferences registry and flags, the outbox, the capture parser, the `exchanges` tables | about 15 steps, plus cut items |
| **M9** Scheduled routines | `routines.scheduling` turned on, the scheduler of A4 3.13.2 with persistent occurrence states, a durable `eligible_at`, and the final decision, queued run and next cursor committed in one transaction, the schedule UI in Settings › Routines, quiet hours, the catch-up rule. A4's scheduler tests move here. The owner decides about scheduled Refresh for work spaces (A4 open item 8) | The `schedule` field, approval hashes, caps and leases, M8's RRULE parser | about 6 steps |
| **M10** Public release gate (A6 3.14) | **An authenticated UI origin (R18), without which M10 cannot pass**: for example a per-user HTTPS certificate trusted in the user's browser profiles, or a desktop shell with its own authenticated channel. The gate includes the two-user port-squatting test, run only in CI on throwaway runners: stop the service, serve a page from a second user that the test creates on its port, reload, and fail to recover or use the old credential. Also the hosted public update channel with signed channel manifests and release-environment signing, Authenticode through SignPath, SBOM and provenance, the managed policy reader, `tasks security check`, macOS community builds, docs. The public contact in package metadata and `SECURITY.md` is set in this pass | Version folders, manifests with hashes, Ed25519-signed releases and the bootstrap's `ssh-keygen -Y verify` check, `ttasks doctor`, the policy keys, the multi-user warning | about 16 steps, plus external steps outside the repo |
| **M11+** Phases L1 to L5 (A6) | Linked machines, phone PWA, open protocol and self-hosted relay, hosted service, teams. Each starts with its own lab like M0. L1 adds the machine-local execution journal behind the `ExecutionStore`, with A6's journal crash tests, and starts using `remote_allowed` and the folder selection of A6 3.8.1's authorization | A6 3.3: machine keys, epochs and incarnations, the filtered `(epoch, seq)` feed with coverage intervals, applicable operations, grants, registry `remote` flags, presence fields, the `ExecutionStore` contract suite | estimated at each phase's start |
| **Desktop shell** (optional, at or after M10) | Electron or Tauri as a pure client of the same HTTP and WebSocket API and fragment-code bootstrap. Never `--no-sandbox` by default (A5 4). One way to meet M10's authenticated-origin gate | Browser-first UI, PWA manifest, `ttasks open` | estimated when chosen |

**The T3 run adapter** comes in M8 or later. It first needs durable launch correlation, reconciliation before declaring a failure, a deadline owner independent of the hub, and a reservation kept while a start is uncertain. Its own lab rows cover a lost first reply and the service down past a deadline.

Smaller items after v1, in no fixed order: pre-trust offers (A4 3.14), a UI for custom routines, a separate Ask verb (A5 open item 4), a Stop reminder hook (A3 open items), restrictions on agent homes (A3 open items), payload compaction (A1-18), attachments in the UI, importers from other task apps, saved views, slimmer agent-facing tool shapes.
