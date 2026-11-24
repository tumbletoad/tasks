# Status

One row per step of `planning/appendix/A7-milestones.md` (sections 3.7 to 3.14). The step's work, its Verify line and the sections it cites live there. This file only tracks state.

**Done so far:** 80 of 101, and M2.04b, M4.01b, M4.05b and M6.04h outside the base count. The rows were checked against the code on 2026-11-23.

**Base steps per milestone:** M0 12 · M1 15 · M2 15 · M3 16 · M4 11 · M5 14 · M6 16 · M7 2 · total 101. Plus the gates G1 and G2, the grant gate M2.04b, the rows that hold what a merged step left (an ID that ends in `b`, `t` or `r`), and the conditional steps listed apart.

## How to read and use it

**States.**

| State | Meaning |
|---|---|
| `todo` | Not started. Some dependency is not done yet. |
| `ready` | Every dependency is done. The step can start. |
| `doing` | Someone works on it, on its own branch. |
| `review` | Its pull request is open, waiting for checks or review. |
| `done` | Merged. |
| `blocked` | Waiting on a gate, a real-machine session or a decision. The row says which. |
| `conditional` | Applies only when an M0 measurement calls for it. Not in the base count. |

**Sizes.** `S` is one focused session, `M` one long session. `RM` marks a step that ends with a check on a real machine. A step that turns out larger than its size is split before work starts, and the split is recorded here.

**Taking a step.** Pick a `ready` row, set it to `doing` in your branch and name the step in your pull request. "Needs" names the code a step builds on, not a milestone: a step can start on top of an unmerged branch it needs. Rows keep their IDs: never renumber or reuse one.

## Real-machine sessions

Some checks need the owner at a real machine, on Windows 11 or on Ubuntu 24.04 without sudo rights. These are open:

| Session | Machine | What it checks | Rows and steps |
|---|---|---|---|
| Lab session 1 | Windows | Launch routes opening the exact folder with the brief, agent apps, the UI in Firefox | L01–L09, L12, A03–A06, U02–U04, U06, S05 (M0.07 to M0.10) |
| Lab session 2 | Linux | The same, plus the Claude Code parts | L01–L09, L11, L12, A03–A06, U01, U03, U04, U06, S11, and the Claude Code parts of A01, A06, E02 and N01 (M0.07 to M0.11) |
| Lab session 3 | Both | Boot and sign-in start through the product's own `ttasks service install`, cold bridge starts after a reboot, the unattended Refresh path | S01, S02, S03, B01, B06, B07, E01's boot and sign-in halves, N04 |
| Acceptance | Both | The `RM` steps once their code exists | M1.15, M2.15, M3.16, M4.08, M5.13, M6.14, M6.15, M7.09, M7.10 |

Gate G2 stays open until lab sessions 1 to 3 have run. Steps behind a G2 predicate are built meanwhile, to the lab's recorded findings, and their pull requests list what waits for a session. M1.15 and M2.15 are not claimed before the sessions.

Merged steps left these checks for a session:
- `ttasks setup agents`, then `--apply`, then `--remove` in the real agent homes on a real Windows and a real Linux machine: the apps' own `mcp add` commands write the entry exactly as asked, `codex mcp remove` drops the patched keys with the table, and Codex loads `startup_timeout_sec` and `env_vars` (M2.15).
- The installed-build migration drill (`pnpm accept m3 --part migration --installed <folder>`) against an installed build on Windows 11. CI runs it against an installed build on Ubuntu 24.04.
- The modes T3 Code gives its runtime file and `userdata` folder under umask 002, when the session that observes T3 runs (L05).
- Open that joins a running session, and Open again after a session ended, with a real terminal and a real agent app (M2.15).
- Settings > Agent apps in the page against real agent homes (M4.05).
- A background run with the real Codex and the real Claude Code on Ubuntu 24.04, and Stop on a real agent there (M6.15).
- `ttasks update --rollback` after a migration on a real install (M6.15).

The session plans for lab sessions 1 to 3 were written before background runs and the product's new name: they are brought up to date before a session is held.

## M0: the real-machine lab

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M0.01 | Repository bootstrap | none | S | done |
| M0.02 | Spike kit | M0.01 | M | done |
| M0.03 | Packaging spike | M0.01 | M | done |
| M0.04 | Storage bench | M0.01 | M | done |
| M0.05 | Lab run R (R01–R12) | M0.03, M0.04 | S RM | done |
| M0.06 | Lab run B (B01–B07), bridge decision | M0.02, M0.03 | S RM | done |
| G1 | Gate: R and B rows against G1 predicates | M0.05, M0.06 | | done |
| M0.07 | Lab run S and E ● | M0.02, M0.03 | M RM | done |
| M0.08 | Lab run U ● | M0.02 | S RM | done |
| M0.09 | Lab run A ● | M0.02 | M RM | done |
| M0.10 | Lab run L ● | M0.02, M0.07 | M RM | done |
| M0.11 | Lab run N, stream fixtures | M0.02, M0.07 | S RM | done |
| M0.12 | Lab report, decisions, plan deltas | all | S | done |
| G2 | Gate: every M0 row observed, G2 predicates qualified | M0.05–M0.11, recorded in M0.12 | | blocked: lab sessions 1 to 3 |

● = the step's unattended rows have run. Its rows that need the owner at a machine are in lab sessions 1 to 3 above.

## M1: core slice (after G1)

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M1.01 | Contracts registry and generator | M0.01 | M | done |
| M1.02 | Storage driver | G1 | S | done |
| M1.03 | Space folder, IDs, schema 0.1 | M1.02 | M | done |
| M1.04 | Write path and writer worker | M1.03 | M | done |
| M1.05 | Receipts and skeleton operations | M1.04 | M | done |
| M1.06 | Migration runner and minimal backups | M1.03 | M | done |
| M1.07 | Crash harness v1 | M1.05, M1.06 | S | done |
| M1.08 | Service hub | M1.05 | M | done |
| M1.09 | `ttasks-local/1` protocol | M1.08 | M | done |
| M1.10 | CLI | M1.01, M1.09 | M | done |
| M1.11 | Windows launchers | M0.03 | S | done |
| M1.12 | Service install | M1.08, M1.11 | S | done |
| M1.13 | Build and signed `SHA256SUMS` | M1.10, M1.11 | M | done |
| M1.14 | Install bootstrap and test installs | M1.12, M1.13 | M | done |
| M1.15 | Real machines: install, drills, budgets | M1.12, M1.14 | S RM | blocked: lab session 3 |

## M2: walking skeleton (after M1 and G2)

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M2.01 | Bridge forwarder | M1.09 | M | done |
| M2.02 | MCP endpoint, both eras | M1.01, M1.09 | M | done |
| M2.03 | The first five tools | M2.02, M1.05 | M | done |
| M2.04 | Binding v0 | M2.03, M2.05 | M | done |
| M2.04b | Grant gate: an agent home reaches only the spaces its registration names | M2.04, M2.14 | M | done |
| M2.05 | Launch records | M1.05 | S | done |
| M2.06 | Machine configuration and targets | M1.08 | S | done |
| M2.07 | Places | M1.05, M2.06 | S | done |
| M2.08 | Shim and attachment | M2.05, M2.06 | M | done |
| M2.09 | Terminals, scopes, environment | M2.08 | M | done |
| M2.10 | Brief and CLI routes | M2.07, M2.09 | M | done |
| M2.11 | T3 primary route | M2.05, M2.07 | M | done |
| M2.12 | HTTP and WebSocket | M1.09 | M | done |
| M2.13 | Skeleton page | M2.12, M2.05 | M | done |
| M2.14 | Setup v0 | M2.03 | S | done |
| M2.10t | T3 Open from the page, the part of M2.10 not built | M2.10, M2.11, M4.06 | M | done |
| M2.15 | Real-machine acceptance | all | S RM | todo |

M2.04b and M2.10t are not in the base count. Open on a T3 instance opens a thread through the paired route, its one route: T3's command line cannot open a thread with an unsent brief, and T3 gives no refresh token, so a pairing that ran out is paired again. M2.07's places were replaced by folders (M4.09, M4.10, M6.16), and M4.11 retires what is left of them. M2.04's binding is replaced under M4.06.

## M3: durable space (parallel with M4)

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M3.01 | Schema 0.2 and migration | M2.01–M2.14, M1.06 | M | done |
| M3.02 | Undo and redo | M3.01 | M | done |
| M3.03 | Revert commit and session | M3.02 | S | ready |
| M3.04 | Lifecycle | M3.01 | S | done |
| M3.05 | Search | M3.01 | M | done |
| M3.06 | Source keys and dedupe | M3.01 | S | done |
| M3.07 | Export bundles and restore | M3.01, M1.06 | M | done |
| M3.08 | Authority, transfer and claim | M3.07 | M | blocked: the owner's decision on its scope |
| M3.09 | Synced and network folder detection, read-only modes | M1.08 | S | done |
| M3.10 | Projection | M3.01 | M | done |
| M3.11 | Preferences and feature flags | M3.01 | S | done |
| M3.12 | Hooks for later phases | M3.08, M2.12, M2.05 | S | todo |
| M3.13 | Fallback driver | M1.02 | S | ready |
| M3.14 | Redaction | M3.04, M3.05, M3.10 | S | todo |
| M3.15 | Full crash and model suites | M3.02–M3.14 | M | todo |
| M3.16 | Scale on Windows and Linux | M3.05, M3.10 | S RM | todo |

M3.13 relies on a CI job that the local checks do not cover. M3.05's search tables come with schema 0.4. Of M3.08 the claim is built, and transfer and the detection of two writing copies are not. Of M3.15 the crash harness runs on every pull request and every night, and the disk-full test, the outside-write check and the model with 3 to 12 actors are not built. A task's move to the Trash and its restore (M3.04) reach a person through the page and `ttasks delete`, `restore` and `trash`. No agent tool reaches them yet.

## M4: agent interface (parallel with M3)

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M4.01 | Remaining tools | M3.05, M3.06 | M | done |
| M4.01b | What M4.01 left: area and project operations in the writer, and organize's create, rename, move and archive | M4.01 | M | done |
| M4.02 | Autonomy and proposals | M3.01 | M | ready |
| M4.03 | Digest v1 and framing | M3.01, M3.05 | M | ready |
| M4.04 | Final server instructions | M4.01 | S | done |
| M4.05 | Setup for remaining apps, doctor | M2.14 | M | done |
| M4.05b | What M4.05 left: doctor's launch rows and sessions row, a free instance ID in setup | M4.05, M2.04b | S | done |
| M4.06 | Binding complete | M2.04, M2.04b | M | done |
| M4.07 | Source ingestion | M4.01 | S | ready |
| M4.08 | Interactive agent evals | M4.01–M4.07 | S RM | todo |
| M4.09 | Folders in the space: storage and operations | M4.01b | M | done |
| M4.10 | Agent and command-line fields for folders | M4.09 | M | done |
| M4.11 | Folder follow-ups, the old places retired | M4.10, M6.16, M3.10 | S | todo |

M4.05b and M4.01b are not in the base count. M4.06 was built as a redesign in four slices (pull requests 118, 120, 121 and 124) and not as the plan's step: a connection is a launch's or a run's session, or none, decided from the value TTasks issued for it. What stays for the build before the switch (an older bridge's handle, `bridgeUsed` in a launch file) goes once the owner's install is moved. Of M4.03 the framing, the budgets and the user's notes kept whole are built. Notes and log entries name their writer, and the summary, the context, the outcome and the sources carry no such label yet. Related learnings and the secret warning on a write are not built. Until M4.02 lands every agent change is applied in full, and no route changes the autonomy level.

## M5: the planner UI (parallel with M6)

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M5.01 | App shell | M2.13 | M | done |
| M5.02 | Live store | M2.12 | M | done |
| M5.03 | Task row and virtual list | M5.01, M5.02 | M | done |
| M5.04 | Today | M5.03 | S | done |
| M5.05 | Status, area, Completed, Agents views | M5.03 | S | done |
| M5.06 | Expanded task | M5.03 | M | done |
| M5.07 | Composer and action strip | M5.06 | S | done |
| M5.08 | Editing, check-off, undo | M5.06, M3.02 | M | done |
| M5.09 | Receipts, proposals, digest | M5.06, M4.02 | M | todo |
| M5.10 | Quick capture and search | M5.03, M3.05 | S | done |
| M5.11 | Settings, flags, keyboard | M5.01, M3.11 | M | done |
| M5.12 | First-run setup | M5.11, M4.05 | S | done |
| M5.13 | UI quality pass | M5.01–M5.12 | M RM | todo |
| M5.14 | Add project and folders in the page | M4.09, M6.16, M5.06 | M | done |
| M5.14b | What M5.14 left: the same folders on another machine after a restore, Settings > Folders, a project's rename and archive in the page | M5.14 | M | ready |

M5.14b is not in the base count. M5.12 merged as a first space and an agent-apps step, not as the plan's seven steps. Of M5.09 the launch receipts and the states of a session and a run are in the thread, and the proposals, the changed dot and the stored digest wait for M4.02 and M4.03. Of M5.14b an archived area's or project's page has Unarchive, and archiving from the page is not built.

## M6: runs, routines and every v1 target (parallel with M5)

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M6.01 | Run records and states | M2.05 | M | done |
| M6.02 | Supervisor and limits | M6.01 | M | done |
| M6.03 | Run shim | M6.01, M2.08 | M | done |
| M6.04 | Cancellation | M6.03 | M | done |
| M6.05 | Stream parsers | M0.11 | S | done |
| M6.06 | Run adapters | M6.04, M6.05, M4.01 | M | done |
| M6.06b | What M6.06 left: `run_report` on a run's connection, and asking the person about an approval in Codex's narrower modes, where the driver answers each request itself today | M6.06, M4.06 | S | ready |
| M6.07 | Routines: Refresh and Wrap-up | M6.06, M4.07 | M | todo |
| M6.08 | The TTasks work folder | M6.06, M2.11 | S | done |
| M6.09 | Run and Refresh UI | M5.07, M6.07, M6.08 | M | done |
| M6.09b | What M6.09 left: Refresh in the top bar, Continue interactively | M6.09, M6.07 | S | todo |
| M6.10 | T3 CLI fallback route | M2.11 | S | done |
| M6.11 | Best-effort targets, context pack | M2.10 | S | done |
| M6.12 | Update from a local archive | M1.14 | M | done |
| M6.12r | Version retirement, the part of M6.12 not built | M6.12 | M | ready |
| M6.13 | Stable Windows launchers | M6.12 | S | done |
| M6.14 | Real-run contract evals | M6.07, M4.08 | S RM | todo |
| M6.15 | Real machines: Refresh, cancel, receipts | M6.01–M6.14 | S RM | todo |
| M6.16 | Launch and service on folders | M4.09 | M | done |

M6.06b, M6.09b and M6.12r are not in the base count. M6.10's route was built and then removed: T3's command line cannot open a thread with an unsent brief. M6.03 was built another way: the service hosts each run and no run shim exists, so a run ends with the service and keeps its last saved answer. M6.06 became two drivers of the product's own, one for the Codex app server and one for Claude Code, and the Codex parser of M6.05 left with it. M6.02's limits are guidelines a person sets, and no folder lease exists.

## M7: switch-over (v1)

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| M7.09 | Rehearsal on the machine that holds the real work data | M5, M6 | S RM | todo |
| M7.10 | Cutover and 10-day trial | M7.09 | S RM | todo |

The prototype importer and the steps built on it (M7.01 to M7.08 and M7.11) left the plan: agents recreate the first user's tasks with the product's own tools. Their IDs are not reused. The first user's tasks were recreated that way on 2026-11-17, so the cutover's data move is done. In M7 the work is fixing what the rehearsal and the trial find.

## Built outside the plan's steps

Not in the base count. No step of the plan holds this work, so the rows have no ID.

| Work | Pull requests | State |
|---|---|---|
| Skills: the person's guidance for agents, read through the MCP server, `ttasks skills` | 127, 131 | done |
| Effort sizes a person sets: `ttasks prefs set` for the effort scale and the dedupe window, any list of 1 to 10 sizes | 128, 133 | done |
| The Agents page shows every coding agent on this computer and each account's plan usage, read from the Agent Monitor | 129, 135 | done |
| The Agents page links an agent to the task TTasks started it for, and shows each agent once | 138 | done |
| The command line and the texts offer only what this build does: `ttasks prefs set --reset`, and a key this build does not read (`projection.dir` in `machine.toml` too) says what is in force | 140, 149 | done |
| Today by one rule: an agent's `status`, its counts and the digest's star follow the page's Today and This week | 142 | done |
| Every area and project listed in pages, archived ones on request, and a new area made from the area picker | 144 | done |
| An archived area or project leaves the sidebar for Archived, says so on its page, and comes back with Unarchive | 151 | done |
| A wrong source detached from a task and put back, by a person and by an agent (the Trash, step 1) | 145 | done |
| A person who comes back sees what agents changed in the last 7 days and the questions they wait on | 147 | done |
| The Trash: a person moves tasks to it and restores them, in the page and on the command line (the Trash, step 2) | 148 | done |
| The Trash, step 3: agents remove tasks, and the keyboard shortcut | none | ready |
| The Trash, step 4: retracting a note | 154 | done |
| A folder's marker keeps protecting when the machine is slow or the service is held up | 152 | done |
| One copy of a space served at a time, and a restored copy that says so | 146 | done |

A space's statuses, the page's Settings for the sizes and an agent's `set` (M3.11's part for agents) are not built: `ttasks prefs set` and the `preferences` tool refuse them.

## Conditional steps

Not in the base count. Each applies only when an M0 measurement calls for it.

| Step | Title | Needs | Size | State |
|---|---|---|---|---|
| F1 | Native forwarder: framing, handshake, bind | M2.01 | M | conditional |
| F2 | Native forwarder: offline responder, reconnect | F1 | M | conditional |
| F3 | Native forwarder builds per platform | F2 | S | conditional |
| F4 | Native forwarder re-measured, default switched | F3 | S RM | conditional |
| M6.04h | Windows console-attach cancel helper | M6.04 | S | done |
| M1.02 (fallback) | Fallback driver `better-sqlite3` as primary | G1 | S | conditional |

F1 to F4 apply only if bridge rule 3 fires (A2 3.7.7). The Node forwarder ships, and lab session 3's cold bridge starts re-check that. M6.04h applied and is built: the helper that holds a run's job on Windows also sends the Ctrl+C. The fallback driver as primary applies only if R01 or R02 fail, and both passed.
