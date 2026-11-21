# TTasks: plan

TTasks, by TumbleToad, is an open-source, agent-first task app between a plain task list and T3 Code: a calm task list that agents keep up to date, and a launch pad that sends each task to the right agent app, in the right folder, with the right account. Its identifier is `ttasks` everywhere. The site is `tumbletoad.com/tasks`.

This file holds the decisions, the architecture in overview, the milestone order and pointers. The specifications A1 to A7 in `appendix/` hold the detail and win on specifics. `AGENTS.md` sets how the work runs. `VISION.md` describes the intended experience.

---

## A. Decisions

### A.1 Decisions by the owner

These carry the most weight. The plan as a whole is a guide, not a contract (D21): an agent deviates only when something blocks or proves unachievable, with a solution faithful to the vision.

| # | Area | Decision |
|---|---|---|
| D1 | Storage | **SQLite is the single source of truth**, owned by one service process. |
| D2 | Runtime | **Node.js with TypeScript** for the service, CLI, MCP bridge and UI build. |
| D3 | UI | **Browser first.** The service serves the UI on localhost. No desktop shell in v1. An installable web app is allowed. A desktop shell can come later as a pure client. |
| D4 | First usable version | **v1 replaces the earlier Planning prototype** for the first user. It installs and runs for one user on a managed Linux machine (Ubuntu 24.04) without sudo. Task-list essentials (recurring tasks, reminders) come next. |
| D5 | Launching | **Opening a task in an agent app (interactive) is the top priority.** |
| D6 | Background runs | **Background runs are part of the foundation.** They serve tasks and power routines that rescan email, chat, tickets and other sources for new tasks. v1 includes them. |
| D7 | v1 launch targets | Native: **T3 Code, Claude Code CLI and Codex CLI**, with more than one Codex account. Best effort: Claude Desktop and the Codex app. Every other app: copy to clipboard. |
| D8 | Refresh | **On request first.** Scheduled routines come later as a user option. The routine model is designed for scheduling from the start. |
| D9 | MCP bridge | One bridge process per agent session, in Node, **kept replaceable** by a native forwarder through a stable, documented local protocol. |
| D10 | Files | A **read-only Markdown tree** of the space plus a compact `catalog.jsonl` for people and file-only agents. Edits come back through an **explicit, previewed import** with base revisions. No live two-way mirror in v1. |
| D11 | Packaging | A **pinned Node runtime bundled per OS and architecture**. Per-user install without admin rights. SQLite through `node:sqlite` behind a storage adapter, with a fallback binding. |
| D12 | Check-off | Checking off **completes the task at once, with undo**. A later wrap-up (by an agent, on request) writes outcome and learnings. Wrap-up destroys no data. |
| D13 | Autonomy | Autonomy is set per space, up to **Full**: agent-created tasks then go straight onto the list, with an Inbox as an option. New users choose a level during setup. |
| D14 | Notes | All notes are visible to agents in v1. An audience field lets "only me" notes come later without a migration. |
| D15 | Agent instructions | The MCP server carries its own instructions. A block in `CLAUDE.md` or `AGENTS.md` is optional and previewed. Managed instruction sources get the text to add by hand. |
| D16 | Data location | Spaces live under `~/.ttasks/spaces/` by default, outside project folders, or anywhere through `machine.toml`. One machine owns each space. Work and personal spaces stay separate. Sync comes later. |
| D17 | Licence and theme | **Apache-2.0.** A calm Zen theme, **dark by default**. |
| D18 | Testing | Tested regularly on **Windows and Linux**, on real machines as well as in CI. On a real Linux machine (Ubuntu 24.04 without sudo rights), test builds are user-level `TTASKS_HOME` installs: no sudo, nothing outside the home folder. No test creates a user account on a real machine: second-user tests run only in CI, on throwaway runners. |
| D19 | Real work use | Once TTasks is **mature enough** (a durable space with verified backups, the importer, Today and the lists with the expanded task, editing and check-off with undo, agents updating tasks through MCP, Open in T3 Code and Codex), the first user uses it for real work, before v1. From then on **every build must keep working for real spaces**: migrations run only after a verified backup, and a break is fixed before anything else. Real work data never enters the repository, fixtures, screenshots or logs. |
| D21 | Direction | The plan is **a guide, not a contract**. When something blocks, another solution faithful to the vision is found and written into the specification. A decision changes the specification it belongs to, in the same pull request as the code. Work goes on improving after the milestones. The core stays lean, and code is rewritten when a better solution appears. |
| D22 | Order, not dates | No calendar estimates. Milestones are ordered by dependencies. |
| D23 | Tool definitions | **No forced size limit on MCP tool definitions.** They stay lean, with every exception that is needed or makes sense. Their size is measured and reported. Limits on what a tool returns stay. |
| D24 | Name | **TTasks**, **by TumbleToad**, at `tumbletoad.com/tasks`. |
| D25 | Identifier and folders | The identifier is **`ttasks`** everywhere. All of a person's data and configuration live in `~/.ttasks` (`%USERPROFILE%\.ttasks`). The program is installed elsewhere, and removing it never removes data. |
| D26 | Limits | **Limits are guidelines until real use.** The targets for performance, latency, memory and token counts were chosen by feel. Implementers aim for them and reviewers flag a breach, but no feature is cut or reworked for a limit unless the result is clearly bad or damaging, and a feature that is better or more complete while over a limit stays. **Functionality, usability, stability, flexibility and maintainability come before performance.** The limits are re-evaluated when the product is close to maturity and can be tested for its final look and feel. |
| D27 | What quality work protects | **A person's work comes first.** Reviews, tests and hardening cover what a person does, in ordinary use and in unusual but plausible use, that could lose or damage their work or frustrate them: an edit at the wrong moment, a crash, a restore, two windows, a full disk, a sync tool, a wrong clock. Hostile code on the same machine is kept in mind and the cheap protections are taken, but not every such hole is closed: the specification says what is not covered. A small visual flaw or a minor bug ranks below all of that. |
| D28 | Folders | **Folders belong to projects and tasks.** Adding a project means choosing an existing folder or creating one, from the page or by an agent. A folder is an absolute path stored in the space with the machine it is on, and it travels with sync, backups and export bundles: a local path is not a secret. A task may have its own absolute folder, also inside a project, and needs no project and no folder. There are no roots and no relative paths. **TTasks sets no limit on where agents work**: only the person's own setup of an agent app does. Where a rule costs a person a concept, a step or a refusal and buys little, it goes. |

### A.2 Architecture decisions

| # | Area | Decision |
|---|---|---|
| R1 | Write path | Every change is a typed **operation**. State, history and the request receipt commit in **one SQLite transaction**. |
| R2 | Undo | Undo and revert are guarded by **field versions**, never by value equality. |
| R3 | Idempotency | Every mutating call carries a **request ID**. The stored result is returned on retry. |
| R4 | Dedupe | Tasks from a source carry a **source key**. `add_tasks` (operation `task.create`) upserts by it, so a refresh never duplicates. |
| R5 | One registry | One typed **operation registry** generates the MCP tools, CLI verbs, HTTP API and UI client types. Result budgets are enforced by tests. Definition sizes are reported (D23). |
| R6 | Service lifecycle | **The OS starts the service** (systemd user unit, Windows sign-in start, macOS LaunchAgent). Bridges never spawn it. Launched sessions and runs live in their own process scope, survive a service restart, and get the user's login environment. Packaged-app behaviour (for example MSIX virtualisation) is tested per package, never assumed. |
| R7 | Agent scope | Agents never launch agents, start runs, edit routines or change policy. Those actions belong to the user. |
| R8 | Launch records | A **launch intent is persisted before dispatch**. Outcomes: Dispatched, Confirmed, Failed or Unknown. An uncertain launch is never retried automatically. |
| R9 | Launch and run | **Launching** an app the user works in and **owning a run** are separate interfaces. A run's exit code never completes a task. |
| R10 | Targets and instances | Built-in **targets** are reviewed code. **Instances** (one per account or config home), terminals, custom targets and every executable command line live only in machine-local configuration. Space data holds only references. A definition that arrives with space data stays disabled until the user approves its exact command. |
| R11 | Exact folders | A launch uses the task's own **folder** on this machine, else its project's, else none here when either lives on another machine, else the space's TTasks work folder. A folder is `(owner, machine, absolute path)` (D28). TTasks never silently opens another clone, a parent folder, the current folder or the last folder used. |
| R12 | Search | SQLite **FTS5**, compact rows, details on request, cursors bound to a snapshot. Related learnings in the task digest. No embeddings in v1. |
| R13 | Local transport | Agents and the CLI use a **local socket or named pipe only the user's own processes can use**: a user-only folder plus a mutual handshake over a user-only key. The browser UI uses HTTP on 127.0.0.1 with a token and Host and Origin checks. No open TCP API for agents. |
| R14 | Brief | The text an agent session starts with is **short and points to the task**. It never embeds the task's content. |
| R15 | Multiple machines | **One authority per space** for now, with replicas and authority epochs later. An open sync protocol keeps self-hosting free. |
| R16 | Trust | TTasks never writes another app's trust settings silently. |
| R17 | Real machines first | Every launch route and the packaging are qualified **on real machines** (the M0 lab). Code that depends on them is built to the lab's findings, and is not accepted as done on real machines until the lab has qualified them (O). |
| R18 | Single-user machines (v1) | v1 assumes **one interactive user per machine**: a 127.0.0.1 origin cannot be authenticated against another local user who takes the port while TTasks is stopped. v1 ships no service worker, serves no UI and revokes UI tokens while another user holds its port (agents and the CLI keep working), expires UI tokens after 7 days unused and 30 days at most, and `ttasks doctor` warns on multi-user machines. An **authenticated UI origin is a hard gate for the public release** (M10). |
| R19 | Staged requests | Inside the writer transaction a request is first resolved into a staged plan (references, actual targets, dedupe, every operation). Preconditions are checked against the state at its start, and autonomy against the actual targets. Every outcome, no-ops included, gets a durable receipt. |
| R20 | Authority incarnation | Each space carries an **authority incarnation ID** next to its epoch. Reads, writes, cursors and receipts carry both, so two offline claims of one backup are detected, never silently merged. |

### A.3 Failure modes the design rules out

Each specification states how it avoids these: a state change without its operation record in the same transaction; a wrap-up or archive step that destroys the only copy of text; undo by value equality; a live editable mirror with a check-then-replace race; relying on hash checks against concurrent overwrites; Electron as the only UI where its sandbox needs root (D3); a service started by a bridge (R6); folder resolution that picks another clone or a containing project (R11); session binding by folder and time; rejecting an existing session's writes when the visible space changes (sessions stay pinned to their space); short machine codes inside immutable IDs; a first release without a hard definition of done.

---

## B. The product

**What matters most, in order:**
1. **Open a task in an agent app, in its exact folder, with a short brief.** One click, a visible session, and the user keeps talking to the agent (D5).
2. **Agents keep the list true** through one MCP server, so finished work gets marked and new work recorded without the user editing anything.
3. **A clean, calm overview.** Today first. Each fact shown once. The important actions right there.
4. **Background agents work for the user:** runs on tasks, and routines that rescan sources for new tasks (D6).
5. **Nothing is lost.** Completed work keeps its outcome and learnings. Every change has a history and can be undone or reverted.
6. **A foundation that grows:** sync, phone, teams, themes and more agent apps later, without rewriting the core.

**Deliberate choices:** the data is a SQLite database, not hand-editable files (D1), because concurrent agent writes must be correct and undo exact; the folder stays readable through the projection (D10). Agents cannot start agents (R7), so a planted instruction in an email cannot fan out into full-access runs. Context, outcome and learnings are mostly agent-written; due date, priority, effort, status and area are one click away. Sync, phone and teams come after v1, on hooks the foundation carries (section K).

**Beyond the prototype:** honest launch receipts, a Refresh routine that turns the morning email and chat sweep into one button, whole-session revert with a preview, and related learnings in each task digest.

## C. Users

- **At work**, on a managed Linux machine without sudo: many parallel agent sessions. Work arrives by email, chat and tickets.
- **At home**, on Windows: personal projects, in a separate space.
- **Developers** who run coding agents all day, and **non-developers** who use agents for documents, research and admin.

Tasks get in by quick capture (the search-or-add field), by agents through `add_tasks`, by the **Refresh** routine (deduplicated by source key), or once from the earlier Planning prototype's files. Usage ranges from a plain task list to an agent control centre where the user mainly reviews and launches.

## D. Feature map

| Phase | Contents |
|---|---|
| **Foundation (M0–M1)** | Space and store with operations, history, field versions and receipts. Service with OS start, local transports and the registry. Bridge, CLI, UI shell. Projection and backups. |
| **v1: retire the prototype** | Today and the status views, task row, expanded task, composer. Open in T3 Code, Claude Code CLI and Codex CLI, best effort for the desktop apps, Copy for the rest. Launch receipts. Background runs. Refresh and Wrap-up on request. Proposals and autonomy. Undo, redo, session revert. Search. Projection. Prototype importer. Sumi and Washi. |
| **M8** | Task-list essentials: recurrence, reminders and notifications, capture outside the app, natural-language dates, import of edited Markdown. |
| **M9** | The scheduler, as a user option. |
| **Later** | The public release gate (M10), an optional desktop shell, L1–L5 (section K), more targets, "only me" notes, custom themes. |

## E. Architecture

```
 Browser tab (React UI) ──HTTP + WebSocket, 127.0.0.1:7713, bearer token──┐
                                                                           │
 Agent app ── stdio ── ttasks mcp (bridge) ──┐                             ▼
 CLI (tasks …) ─────────────────────────────┼── socket / named pipe ──►  TTasks service (one per OS user)
 ttasks shim (in a terminal) ────────────────┘   ttasks-local/1, HMAC     ├─ hub: transports, auth, MCP, supervision
                                                                         ├─ one worker per space: SQLite writer + readers
                                                                         ├─ launch adapters (T3, CLIs, apps, Copy)
                                                                         ├─ run supervisor and routines (scheduler off)
                                                                         └─ projection writer (view/, catalog.jsonl)
```

- **One service per OS user**, started by the OS (R6), hosts every space. Each open space has its own worker thread, database and writer lock. A second lock guarantees one service (A2).
- **One write path.** UI, bridges and CLI call the same typed operations (R5). The service checks the caller's credential and autonomy, then commits state, history, receipt, search rows and outbox in one transaction (R1). The outbox drives the projection and live UI updates (A1, A3).
- **The bridge** is a thin stdio-to-socket forwarder. The MCP server runs in the service (D9, A2).
- **Launching and runs** are separate subsystems. Terminals and runs start in their own process scope (A4).
- **Extension** happens through data and reviewed code: the registry, the target catalogue, routines, preferences, feature flags and theme tokens. No code plugins before 1.0.
- **Names** that people, agents and the operating system see all come from `packages/brand`.

## F. The space (A1)

A space is a folder, by default `~/.ttasks/spaces/<slug>/`, holding `space.json` (marker `tasks_space`, identity, epoch, incarnation, schema version), `space.db` (the only truth: WAL, `synchronous=FULL`, STRICT tables), `attachments/`, `view/` (projection), `exchange/` (import working copies), `backups/` and `exports/`. Machine-local state (instances, keys, UI state) lives in `~/.ttasks/` and never in a space. The folders of projects and tasks are space data (D28).

Core rules: IDs are a type prefix plus 128 random bits in Crockford base32, with never-reused short references like `M-14`. Every write carries `base`, and a field changed since is a conflict. Undo, redo and revert follow each field's lineage and stop at another actor's change. Labels and source links are versioned rows. Wrap-up only adds, deletion is a restorable tombstone, and only a human-only `redact` destroys data. A copied or restored space opens read-only until claimed, transferred or forked. A space in a synced folder opens read-only until confirmed on that machine, a folder whose sync status cannot be checked counts as synced, and a network filesystem is never writable. Such a space leaves its folder by `ttasks space open <folder> --excluded`, once the person confirms the folder is excluded from sync, or by a verified backup restored into a new folder and claimed. The old folder stays as it was. A move command comes later, built on transfer and claim (A7 section 6). No operation deletes a person's data or a backup as a side effect: it reuses what exists, retires and keeps what it replaces, and says where it is. Removal outside the backup retention policy is the person's explicit act. Migrations run in one transaction, each attempt behind a verified backup of its own, and are additive within a major version after 1.0. A failed migration leaves the space at its old schema and read-only, and the same build does not try again on an unchanged database: another build, a restore or `ttasks space open <folder> --retry-migration` does. Schemas 0.1 and 0.2 are frozen. Backups: 7 daily, 4 weekly, plus one before every migration and restore. Scale target: 5,000 open and 50,000 completed tasks per space, 10 concurrent agent sessions.

## G. The agent interface (A3)

One MCP server named `ttasks`, registered once per agent home. Its name is a separate constant in `packages/brand`: if agents confuse it with an agent app's own task tools, only that name changes, to `tt-tasks`. Every connection sees the same 11 tools, online or offline: `status`, `search`, `get_task`, `add_tasks`, `update_task`, `add_entry`, `complete_task`, `reopen_task`, `organize`, `preferences` and `run_report` (accepted only from runs and routines). Permissions are checked per call.

- Every write needs a `request_id`, and a retry returns the stored result.
- Task content, source text and every editable name reach agents framed as data. Only notes the user addressed to agents are instructions.
- Autonomy (Full, Review, Suggest, with overrides) decides whether a change applies, applies with a mark, or becomes a proposal. New users start at Review.
- A session binds by credential first (a ticket, or a preset native session ID), else by the launch reference in the brief at the first `get_task`, or by an explicit choice. A folder only suggests candidates. A binding never changes space. A CLI call or a browser tab cannot hold a binding: it resolves a launch reference for that call only, so it never uses up the reference the agent needs.
- Server instructions: about 2 KB, at most 3,500 bytes, with the start rule self-contained in the first 240 characters, because Codex CLI shows its model only about that much. Guidance Codex needs beyond it is repeated in the tool descriptions.
- Tool definitions are measured and reported, not capped (D23). Every result is fitted to its budget, and a cut says what it left out and how to get the rest.
- Every brief names TTasks.
- `ttasks setup agents` registers the server in each agent home through the app's own command. Its preview shows the exact command and diff, apply does exactly what the preview showed (a plan token binds the two), and remove takes back only an entry that is still exactly the one setup wrote. The backup is an entry-level record, never a copy of the app's file. Setup never writes trust settings (R16).
- An agent home's calls reach only the spaces its registration names (the grant gate, M2.04b).

## H. Launching and runs (A4)

| Target | Primary route | Fallback | v1 |
|---|---|---|---|
| T3 Code | Paired once as an MCP client of T3: an idle thread in a project rooted exactly at the task folder, opened by link with the brief as an unsent draft | `t3 thread start` with the brief sent | Native |
| Claude Code CLI | A terminal runs `ttasks shim <ticket>`, which fetches argv and environment over the socket. Preset `--session-id`. Brief sent: "read the task, then wait" | `claude-cli://` link with the brief prefilled | Native |
| Codex CLI (work, personal) | The same shim route, per-account `CODEX_HOME`, ticket to the bridge through `env_vars` | Assisted prefill | Native |
| Claude Desktop, Codex app | Deep link | Copy | Best effort |
| Any other app | Copy the brief or a context pack | – | Copy |

- The folder a launch resolves (R11) must equal the target's working folder. A task with no folder of its own or its project's anywhere opens or runs in a **TTasks work folder** for that space on that machine, so any task can go to an agent.
- Terminals and runs run in their own process scope with the environment of a login-shell snapshot.
- The brief is about 400 characters: task ID, title and launch reference. Composer text replaces the "wait" line.
- **Runs** use `claude -p` and `codex exec` in v1 (a T3 run adapter after v1). Each has a parser, log, timeout and cancellation. Windows cancellation uses a small console-attach helper (M6.04h) with a forced kill after 10 seconds. Limits: 3 runs per machine, 2 per instance, 1 per task, 1 per folder. A run starts in the folder its task resolves to, or a routine's work folder: TTasks sets no limit on where agents work (D28).
- **Routines**: Refresh from sources (a run on the chosen agent instance that reads mail, calendar, documents, tickets and chat through the agent's own connectors and tools, and adds or updates tasks by source key) and Wrap-up. Both start on request. Each routine stores a schedule for M9. Agents cannot create, edit or start routines.

## I. Search (A1, A3)

One FTS5 table (`unicode61`, prefix indexes) over tasks, notes, log, learnings, projects and areas, updated in every commit. Hits roll up to their task. Tasks indexes what it stores and never fetches URLs or mail bodies. Rows are compact and cursors freeze the result at a snapshot. A trigram index stays off behind a flag. Targets on 10,000 open and 100,000 completed tasks: search p95 under 150 ms on Windows and 300 ms on Linux, `get_task` p95 under 50 ms. Broad queries miss the Windows target with plain bm25 ranking, so M3.16 adds a query design and re-measures on Windows and Linux.

## J. UI (A5)

A React app served on 127.0.0.1, for Firefox and Chromium. The mockup is `appendix/A5-mockup.html`. A sidebar with views, areas and the only task counts. One search-or-add field and a Refresh button. Today opens with a seven-day strip (the only place the date appears), then Focus, This week, Next and Changes, each task at most once. Rows expand in place. A composer strip holds Note, Open per pinned instance, Run and Copy. Agent changes show as a dot and on Today, with an Agents view that reverts. Live updates never move the focused row. Sumi (dark, default) and Washi (light) meet WCAG AA. Keyboard-first, screen-reader friendly, reduced motion respected. First run says where the person's data lives (`~/.ttasks`). No service worker in v1 (R18).

## K. Multiple machines, sync and phone (A6)

v1 is local only. Each space has one authority machine, nothing listens beyond loopback, and spaces move by backup, transfer or fork. Every authority change raises the epoch and creates a new incarnation (R20). The foundation carries the hooks for later phases: machine key pairs, one change feed keyed by epoch, incarnation and sequence, an `ExecutionStore` interface, operation records a replica can apply, actors split into principal, binding and machine, scoped grants, and registry flags for operations that may travel.

Later phases, in order: **L1** linked machines (pairing, read-only replicas, signed remote commands that expire within two minutes and are never queued), **L2** a phone web app served by the user's machine, **L3** the open protocol `ttasks-sync/1` with a self-hostable relay, **L4** the paid hosted relay (never authority, never plaintext), **L5** teams. A work space never copies to personal devices or the hosted relay by default.

## L. Security and privacy (A6)

Other local users cannot reach the socket or pipe (0700 folder, mutual HMAC, no context before the service proves itself); the browser origin is the exception R18 accepts for v1. Web pages cannot drive the local API (bearer token per origin, no cookies, strict Host, Origin and Sec-Fetch-Site checks, no CORS). Injected text reaches agents inside a delimited data block with provenance. Secrets never enter a space. The bundled Node is the official binary, verified. Updates are Ed25519-signed and self-tested, with rollback. TTasks accepts the user's own full-access agents and says "use at your own risk" once, where it matters. Autonomy is a guard rail, not a sandbox. Logs never contain task text, prompts or tokens. Tasks honours managed-machine policy and never works around IT controls.

## M. Technology and packaging (A2, A7 3.3)

| Layer | Choice |
|---|---|
| Runtime | Official Node 26.13.1, bundled per OS and architecture, unmodified and verified |
| Storage | `node:sqlite` (SQLite 3.54.1 with FTS5) behind a driver interface, `better-sqlite3` 13 as tested fallback with its own SQLite |
| Contracts | Zod 4 schemas in one registry package |
| Local protocol | `ttasks-local/1`: newline-delimited JSON-RPC 2.0 over a Unix socket or named pipe, mutual HMAC-SHA256 handshake |
| UI | React 19, Vite, TanStack Router, Query and Virtual, React Aria Components, CSS Modules, FormatJS |
| Bridge | The Node forwarder. A native forwarder (F1–F4) only if the bridge fails its start-time or memory thresholds. |

- **Data and configuration:** `~/.ttasks/` (`%USERPROFILE%\.ttasks\`) with `config/`, `state/` (logs in `state/logs` on every OS), `cache/` and `spaces/`. `ttasks doctor` and the first-run text say where it is. Every file and folder TTasks creates gets its exact mode whatever the umask (folders 0700, files 0600). A configuration file or folder that another user owns, that the group or others can write, or that is a link is refused: the refusal says what is wrong and, except for a link, gives the one command that repairs it. A umask that clears one of the owner's own bits is refused at start.
- **Program:** `~/.local/share/ttasks/` with `versions/` and `current`, the command in `~/.local/bin/` (the same under `%USERPROFILE%` on Windows, with `ttasks.exe` and `ttasksw.exe`, which find the program at a fixed path from their own folder). Never under `AppData`, where a process started from a packaged app gets its writes redirected.
- **Removing the program never removes data.** Install, update and uninstall change the program folder, the command and only the records they wrote themselves in `~/.ttasks/state`: an install followed by an uninstall leaves `~/.ttasks` as it was. No command removes anything under `~/.ttasks` unless the person names it.
- **Install** per user without admin rights: Linux a gzipped tarball and a systemd user unit; Windows a zip, the C launcher `ttasks.exe` and an HKCU Run entry for the `ttasksw.exe` supervisor; macOS a gzipped tarball and a LaunchAgent. The install scripts verify the signature and the archive before any file from it runs, then hand over to the new version's `ttasks install --finish`, which self-tests and only then switches `current`.
- **`TTASKS_HOME`** gives a separate test install with its own service, socket, port and unit, program, command and data under one root.
- **Updates.** `ttasks update --from <archive>` verifies the archive's signature with the installed version's own keys before running any of it, self-tests the candidate, switches `current` atomically under a journal that the next start repairs from, keeps the previous versions and never kills launched sessions. `--rollback` returns to the version before. A hosted update channel comes at M10.
- **Signing.** Release builds sign `SHA256SUMS` with an Ed25519 key only the owner holds. The install scripts verify it with `ssh-keygen -Y verify`, or a fallback verifier, before running candidate code. Tests and CI use a throwaway key. Builds from main are `0.1.0-dev.<commit count>`.
- **Distribution after v1:** GitHub releases, then winget and other package managers. Windows code signing through SignPath Foundation before a public Windows build. macOS stays "preview" until verified on a Mac.
- **Licence:** Apache-2.0. `NOTICE` names the copyright holder.

## N. Quality (A7 3.18)

Every step starts from a failing test and ends with `pnpm verify` and its Verify line. Kinds: unit; property and model-based (field versions, undo guards, session revert, receipts across restarts and epochs, source-key upsert, cursors, a reference model with 3–12 actors); crash injection (5 minutes per pull request, 30 nightly per OS); integration with real databases, sockets, pipes and service processes on Windows and Ubuntu; forwarder conformance; real agent CLIs by hand at M4, M6 and releases; `ttasks doctor --live` on a real Windows machine and a real Linux machine; Playwright in Firefox and Chromium with screenshot baselines in both themes, axe and keyboard flows; security (HTTP checks, DNS rebinding, XSS, injection fixtures, export secret scan, burst brake). Performance: Today interactive within 800 ms with 5,000 open tasks on Linux in Firefox, check-off to paint within 50 ms, commit p95 within 10 ms on Windows and 25 ms on Linux, service idle under 120 MB. CI runs Ubuntu 24.04 and Windows on every pull request that is not a draft, plus nightly long runs. macOS is build-only.

## O. Milestones

v1 is 110 steps across eight milestones (A7). A step starts when the code it builds on exists, on a branch if not yet merged: the milestone order is not itself a dependency. Independent steps run in parallel lanes. The interactive Open reaches the first user at the end of M2.

| Milestone | Goal | Depends on | Owner's part |
|---|---|---|---|
| **M0 Lab** | Qualify every fact the design depends on, on Windows and Linux. G1 (runtime, storage, bridge) unlocks core code. G2 (launch routes, agent apps, service lifecycle, Firefox, Refresh) qualifies launch and UI code. | – | Three lab sessions |
| **M1 Core slice** | One space, one writer, the socket transport, the CLI, verified backup and restore, per-user installs | G1 | An acceptance transcript |
| **M2 Walking skeleton** | Open a task in T3 Code, Claude Code CLI and Codex CLI in its exact folder, on Windows and Linux | M1, G2 | Try it, then use it for a few days |
| **M3 Durable space** | History, undo, revert, projection, backups, migrations, authority hooks | M2 (with M4) | A restore drill |
| **M4 Agent interface** | All tools, binding, autonomy and proposals, setup per app | M2 (with M3) | Setup previews, an eval report |
| **M5 Planner UI** | Today, the views, the expanded task, the composer, themes | M3, M4 (with M6) | Review every screen, use it daily |
| **M6 Runs and routines** | Runs, Refresh and Wrap-up, the TTasks work folder, every v1 target | M3, M4 (with M5) | Refresh on a real Linux machine |
| **M7 Switch-over = v1** | Import, rollback, a 10-working-day trial with the prototype read-only, retirement gate | M5, M6 | Rehearsal, cutover, the trial, the gate review |

- **Gates.** G1 has passed. G2 stays open until the lab sessions with the owner have run (the open sessions are listed in `planning/STATUS.md`). Steps behind a G2 predicate are built meanwhile, to the lab's findings, and list in their pull request what waits for a session. M1.15 and M2.15 are not claimed before the sessions. If a session contradicts what was built, the fix comes first.
- **Gates require working capabilities.** A recorded failure, Copy, an "experimental" label or a visible-session workaround never stands in for T3, Claude Code and Codex Open or background Refresh. Accepting less deviates from D6–D8: only when it still blocks after remediation, stated in the specification and put to the owner.
- **Conditional steps:** the native forwarder F1–F4 (not called for), the Windows cancel helper M6.04h (called for), the fallback driver as primary (not called for).
- **Real work use (D19)** typically starts after M3, M4 and the core of M5, with the importer pulled forward. Until M7 the prototype stays the source of truth, and re-imports never lose an edit made in TTasks.
- **Backups before real data.** M1 ships verified backup and restore, and migrations refuse to run without one. M3's first migration is drilled on an installed build before real spaces are upgraded.
- **The importer** reads a frozen copy of the prototype and never runs its code. Dry-run report, one undoable commit, each prototype task its own task, idempotent re-runs. Checked-off tasks become completed with wrap-up pending. No priority imports as P3.
- **Retirement gate:** 10 working days with five clean days after the last blocking fix, against 11 criteria. Rollback writes a complete prototype-format copy in a new folder with a marker map, so returning later neither duplicates nor loses changes.
- **Cut order for a smaller v1** (cuts ship in M8): the desktop-app links, the Agents view and session revert in the UI, first-run steps 2–5, Washi, projection files for completed tasks, Wrap-up. Never cut: Open in T3, Claude Code and Codex, Copy, runs on a task, Refresh, check-off with undo, the importer, rollback, backups, crash safety.

**After v1, in order:** M8 task-list essentials, M9 scheduled routines, M10 the public release gate (authenticated UI origin, Windows code signing, SBOM, docs), then L1 to L5, each with its own lab, and an optional desktop shell.

## P. Risks and settled questions

Risks (full register in A7 3.19): a required route fails on a real Linux machine (fix and re-test through the same path, else another route faithful to the vision); agent apps change (receipts per app version, isolated adapters, `doctor --live`); `node:sqlite` defects (driver interface, fallback tested in CI, exact pin); a heavy bridge (native forwarder through the same protocol); connector approvals block unattended Refresh (closest alternative, such as Refresh in a visible session); real work data leaking (repository rules, content-free logs, fixture checks).

| # | Question | Decision |
|---|---|---|
| 1 | Nested task folders as their own T3 projects | Yes, asked once per folder |
| 2 | CLI briefs sent or only prefilled | Sent, switchable per instance |
| 3 | A second Windows account for the pipe test | No. Second-user tests run only in CI (D18) |
| 6 | A separate Jira view | Not in v1: ticket sources and `source:ticket` cover it |
| 8 | Trial length | 10 working days, 5 clean after the last blocking fix |
| 9 | Scheduled Refresh for a work space | On request until the user opts in at M9 (D8) |
| 10 | The repository | `tumbletoad/tasks`, public |
| 11 | Native phone apps for self-hosters | Free |
| 12 | Work data on personal devices or the relay | Never, unless the employer's rules allow it |
| 13 | A hosted service holding a space's authority | No. A relay never holds authority (K) |
| 14 | When real work use starts | When TTasks is mature enough (D19) |

Smaller UI choices are in A7 section 6. Their defaults stand until M5 settles them.

---

## Specifications

| File | Covers |
|---|---|
| `appendix/A1-data.md` | Schema, operations, history and undo, receipts, IDs, migrations, the space folder, wrap-up, projection and import, preferences, folders, backups, search storage |
| `appendix/A2-service.md` | Process model, service lifecycle per OS, transports and their security, the bridge, the CLI, packaging, install and update, diagnostics |
| `appendix/A3-agent-interface.md` | Registry, MCP tools, server instructions, setup per app, autonomy and proposals, binding, search, briefs, sizes |
| `appendix/A4-launch-and-runs.md` | Targets and instances, launch routes, terminals and the shim, launch intents, runs, routines, scheduling, process scopes |
| `appendix/A5-ui.md` | Views, row, expanded task, composer, editing, themes, keyboard, first run, the mockup |
| `appendix/A6-machines-and-security.md` | Authority, later phases L1–L5, threat model, privacy |
| `appendix/A7-milestones.md` | Repository and toolchain, the M0 lab, every step with its Verify line, test strategy, the importer, the retirement gate |

---

## Q. Names

Every name people, agents and the operating system see comes from `packages/brand`.

| Term | Meaning |
|---|---|
| **TTasks** | The product's name, by TumbleToad: briefs, `ttasks --version`, the sign-in start entry's label, a desktop entry. |
| **`ttasks`** | The identifier: the command, `TTASKS_` variables, `~/.ttasks`, the MCP server name, pipe, socket, unit and label names, `tasks_space`, `tasks_backup`, `ttasks-local/1`, the install-ID prefix `ttasks-install`, package names. |
| **Space** | One user's planning data in a folder, by default under `~/.ttasks/spaces/`. |
| **Area**, **project** | The two grouping levels (renamable per space): lasting responsibilities, and bodies of work inside them. |
| **Task**, **summary**, **context** | The unit of work; the one line under its title (the next step when there is one); the agent-maintained understanding of it. |
| **Note**, **log** | An entry addressed to the user or to agents (only the user addresses notes to agents, agents write one only when asked); progress entries written by agents. |
| **Source**, **source key** | A link to where a task came from, with a meaningful title; its dedupe key. |
| **Folder** | A project's or a task's working folder on one machine: an absolute path, with the home folder shown as `~`. Areas have none. |
| **Machine** | A computer that runs TTasks. |
| **Target**, **instance** | An app TTasks launches into; a target bound to one account or config home ("Codex · work"). |
| **Open** | The button verb for starting an interactive session. |
| **Session**, **native session ID** | An agent conversation TTasks tracks; the agent app's own ID for it, needed for Resume. |
| **Run**, **routine** | A background execution TTasks owns; a saved run recipe not tied to one task. |
| **Brief**, **launch reference**, **ticket** | The short text a session starts with; a short code in it (`L7KQ2M`) that ties the session to its launch; a one-time credential in a launched process's environment. |
| **Task digest** | What `get_task` returns: a bounded view for an agent. |
| **Launch route**, **network route** | How a target is opened (A4); a path between machines (A6). |
| **Launch intent**, **receipt** | The record saved before a launch; its observed outcome. |
| **Operation**, **history** | One typed change to the space; the stored operations behind every change. |
| **Proposal** | An agent's suggested change waiting for the user. |
| **Inbox**, **Completed** | New unsorted tasks; finished tasks (completed or archived) with **outcome** and **learnings**. |
| **Wrap-up** | The step that writes outcome and learnings. It only adds. |
| **Autonomy** | What agents may change without approval: **Full**, **Review**, **Suggest**. |
| **Service**, **bridge** | The background program that owns the spaces; the per-session MCP process (`ttasks mcp`). |
| **Agent home** | One agent app config home where the MCP server is registered. |
| **Authority**, **epoch**, **incarnation** | The one machine allowed to write a space; the counter raised on every authority change; the ID that tells two claims of one backup apart. |
| **Replica**, **device**, **principal**, **grant** | Later phases (A6): a read copy, a paired device, the person or agent behind a change, a scoped permission. |
| **Remote command**, **presence**, **relay**, **mailbox** | Later phases (A6): a signed request to another machine, whether its desktop is available, the forwarding service, its encrypted store. |
| **Projection** | The generated read-only Markdown tree and `catalog.jsonl`. |
| **Sumi**, **Washi** | The dark (default) and light themes. |
