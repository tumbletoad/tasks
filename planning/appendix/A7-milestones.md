# A7. Milestones, quality and retirement

This appendix owns the repository layout, the step mechanics, the M0 real-machine lab, the milestones from M0 to v1 with their steps and definitions of done, the Planning prototype importer, the retirement gate, the roadmap after v1, the test strategy, the delivery risks and the open items. The repository's `AGENTS.md` owns how agents work (3.5).

It schedules what PLAN.md section A and A1 to A6 specify. Every step names the sections it implements. `planning/STATUS.md` tracks which steps are merged. A merged step keeps only its ID and title here, plus what a later step still needs from it: its code and tests are the reference. Step IDs are never reused.

Examples use the fixture world: Mira Okafor, space "Mira", reference prefix `M`. No prototype content appears here.

---

## 1. Summary

1. **M0 is a real-machine lab** on a real Windows machine and a real Linux machine (Ubuntu 24.04, no sudo rights). Gate G1 (runtime, storage, bridge) has passed. Gate G2 (lifecycle, browser, agent apps, launch routes, runs, connectors) stays open until three lab sessions with the owner have run. Steps behind a G2 predicate are built meanwhile, and the gate decides whether they may be called done on real machines (3.7).
2. **Seven milestones lead to v1.** M1 core slice, with a verified backup and restore before any real data. M2 walking skeleton: Open a task in T3 Code, Claude Code CLI and Codex CLI on Windows and Linux. M3 durable space. M4 agent interface. M5 planner UI. M6 runs and routines. M7 imports the prototype and runs the retirement trial. Milestones group steps. Their order is not a dependency: a step starts when the code it needs exists (3.6).
3. **Open reaches the first user at the end of M2,** as the first usable result after the core. An early demo opens Claude Code on Windows once M2.08 to M2.10, M2.12 and M2.13 are merged.
4. **v1 retires the earlier prototype for the first user** after a trial of 10 working days with the prototype frozen. v1 includes runs on tasks through the Claude Code and Codex CLI adapters, the Refresh and Wrap-up routines on request (D6, D8), and Open and Run for tasks without a folder through the Tasks work folder. Release archives are Ed25519-signed. Recurrence, reminders, scheduled routines, explicit file import, the T3 run adapter, pre-trust, the hosted public update channel, an authenticated UI origin and any desktop shell come after v1.
5. **104 base steps to v1, each sized for one agent session.** No calendar estimates: order, dependencies and lanes only. Conditional work (a native forwarder, the fallback driver as primary) applies only when a measurement calls for it. The Windows cancel helper M6.04h applies.
6. **The importer** is a pure TypeScript parser of a frozen copy. It never runs prototype code. It maps every field to A1's model, keeps distinct legacy tasks distinct even when they share a source, previews a report, writes one import commit and re-imports idempotently through A1's exchange bases. It is ready by the real-use point (3.6), so the first user has a real work space on the Linux reference machine that stays current with the prototype until the M7 switch-over.
7. **Rollback** exports the space's current state into a new folder in the prototype's format, with check-offs and stars as fresh prototype events and without the frozen ones. The export is recorded as an exchange, so the return re-imports without duplicates. New work in Tasks is never thrown away.
8. **Agents verify their own steps** with `pnpm verify`, the step's Verify line, CI on Ubuntu and Windows and, for platform code, a `TASKS_HOME` test install on the Linux reference machine. A v1 acceptance manifest names the tests each milestone owns. A pull request merges when its checks and its review pass. From the real-use point, every verified build also goes to the first user's daily install and is checked against the real work space.

---

## 2. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| P1 | Milestone shape | M0 lab, then M1 core, M2 skeleton, M3 and M4, M5 and M6, M7 switch-over = v1 | Open early (D5). Each milestone has a hard definition of done and an acceptance script |
| P2 | Walking skeleton | M2, on the real write path, with all three native targets and a bare page | A thin end-to-end slice on the production core (D5) |
| P3 | Two M0 gates | G1 covers runtime, storage and bridge. G2 covers launch, binding, lifecycle and UI transport. A step behind a failing predicate is built, but not called done on real machines until a re-test passes | R17. A recorded failure is not a qualification |
| P4 | v1 scope | In: A1 except explicit import, compaction and attachment ingestion. A2 except the hosted public update channel and the authenticated UI origin. A3 complete. A4 except scheduler evaluation, the T3 run adapter and pre-trust. A5's v1 scope. A6's local phase | D4, D6, D7, D8, R18 |
| P5 | Scheduler | The `schedule` field ships in v1, stored and validated. Evaluation ships in M9 with M8's RRULE parser | D8 asks for the design now, scheduling later |
| P6 | Explicit file import (A1 3.14) | M8, applied only by a human | Retirement needs no file edits, and the projection is read-only, so nothing is lost meanwhile |
| P7 | Pre-trust offers (A4 3.14) | After v1 | Each app's own trust prompt appears once per folder |
| P8 | Native forwarder | Steps F1–F4, built only if bridge rule 3 fires (A2 3.7.7), then before M7 | D9 |
| P9 | Signing and updates in v1 | Release archives are Ed25519-signed with a key that only the owner holds, never in CI. The install bootstrap (M1.14) and `tasks update --from <archive>` (M6.12) verify the signature before running any candidate code (A2 3.12.4). The hosted public update channel comes at M10 | A candidate never vouches for itself, and updates are needed during the trial |
| P10 | Repository | pnpm monorepo, one package per area, generated contracts checked in, dependency rules enforced | R5 and one owner per concern |
| P11 | Step tracking | `planning/STATUS.md`, one row per step | Merge-friendly with several agents |
| P12 | Merging | A pull request merges when its checks and its review pass. Review depth follows risk (3.18.5) | AGENTS.md |
| P13 | Importer | Pure parser of a copy, one import commit applied by a human, distinct legacy tasks created with `dedupe: none`, idempotent re-import through A1's `exchanges` bases | A1 3.14 and 3.21. A shared source must not merge two legacy tasks |
| P14 | Checked-off prototype items | Completed at once with wrap-up pending | D12. In the prototype a check-off is the user's completion signal |
| P15 | Trial | 10 working days, prototype frozen, one writer. After a blocking fix, 5 clean consecutive days | Two weeks cover a weekly rhythm |
| P16 | Rollback | Export to the prototype format into a new folder, as an exchange, with the space held read-only while the prototype is the writer (3.15.8, 3.16.4) | Never discard the trial's work. Frozen events must not override the export, and the return must not duplicate tasks |
| P17 | Real data | Never in the repo, fixtures, PRs, screenshots or reports. The importer, Refresh and the deploy check touch real data only on the Linux reference machine (3.4) | AGENTS.md |
| P18 | Test installs | `TASKS_HOME` installs on the Linux reference machine. From the real-use point it also has a daily install on the latest verified build (3.4, 3.6) | The install ID isolates runtime folder, socket, launch folders, unit and port (A2 S28) |
| P19 | Real-agent tests | By hand on the real machines, never in CI | They cost tokens and need signed-in agent apps |
| P20 | Backups before real data | The migration runner and A1's minimal backup set ship together (M1.06). An installed-build migration failure and restore drill passes in M1.15, before real tasks go into M2. Bundles, transfer and fork come in M3 | A1 requires a verified backup before every migration |
| P21 | Acceptance manifest | One manifest names every test, the milestone that owns it and its kind (CI, installed build, manual). Cuts are named scope profiles | Milestones must not depend on later scope |
| P22 | Scope and order | Base steps sized for one agent session each, conditional steps kept apart, a step started when its code dependencies exist, as many lanes as the dependencies allow. No calendar estimates | AI agents implement the product, so only order and dependencies matter |
| P23 | Tasks without a place | Open and Run use the space's Tasks work folder on that machine, from M6 | Copy alone left daily tasks without an agent path |
| P24 | Browser origin in v1 | Single-user machines, no service worker, expiring UI tokens, a doctor warning about other accounts, and no UI while another user holds the UI port (A2 S15, S18). An authenticated UI origin is a hard gate at M10 | R18 |
| P25 | Real work use | The product moves to real work tasks once enough of the core works, without waiting for M7 (3.6). The importer is ready by then. The M7 rehearsal, trial and gate stay the formal switch-over | Real use finds problems early, and the prototype stays the source of truth until M7 |

---

## 3. Specification

### 3.1 Assumptions

- AI agents implement the steps in parallel lanes, one agent session per step. Lab sessions and the trial, which need the owner at a machine, are the likely limit (D5).
- Development happens on Windows. The second test machine runs Linux (Ubuntu 24.04, no sudo rights) (D18). Machine facts are kept outside the repository.
- Agent app versions are recorded with each lab result and each qualification receipt, not here.

### 3.2 Repository layout

One package per area under `packages/`, named `@tasks/<name>`, private and never published. `spikes/m0/` holds lab code that is never shipped (3.7). `fixtures/` holds the signed Node release files, the synthetic prototype folder (3.14) and the recorded streams. `local/` is git-ignored (3.5).

| Package | Holds | Specified in |
|---|---|---|
| `brand` | Every name: TT Tasks, the in-app name Tasks, the publisher, the identifier `tasks` with everything derived from it (command, `TASKS_` prefix, HTTP header names), and the MCP server name as its own constant, so it alone can change (`[A7.3.2.brand.names]`) | – |
| `contracts` | Registry entries, Zod schemas, error codes, the checked-in `generated/` | A3 3.2 |
| `files` | Creating files and folders with an exact mode | A2 3.2.2 |
| `core` (planned) | Pure domain logic with no I/O: operation rules, validation, undo planning, the autonomy table, digest rendering, the write-time sanitiser | A1, A3 |
| `storage` | The SQLite driver, schema, migrations, writer and readers, backups, restore, recovery, the `launches` table | A1 |
| `projection` | The `view/` renderer and `catalog.jsonl`, the outbox's consumer | A1 3.13 |
| `service` | The hub, the local protocol server, HTTP and WebSocket, the MCP endpoint, binding, `machine.toml`, the service install, the request path, the launch service, T3 pairing, agent setup, install and update | A2 |
| `bridge` | The wire library and the `tasks mcp` forwarder | A2 3.7 |
| `launch` | Launch states and routes, targets, places, the shim's server side, terminals, the brief, the URL opener, the T3 client | A4 3.2–3.10, 3.15 |
| `runs` | Stream parsers and fake agents. Later the run adapters, supervisor, routines and scheduler | A4 3.11–3.13 |
| `cli` | The `tasks` entry and its commands, the shim client | A2 3.10 |
| `web` | The page in Vite and React | A5 |
| `importer-planning` | Prototype importer and exporter | 3.15 |
| `launcher-win` | `tasks.exe` and `tasksw.exe` in C | A2 3.12.3 |
| `testkit` | Seeded generators, the Mira sample, the synthetic prototype, test installs and the launch fakes | 3.18.1 |

**Where code lives, and why.** Each placement keeps a dependency rule true.
- **Wire protocol.** `packages/bridge/src/protocol/` holds the wire code that the CLI, the shim and the bridge share, with Node built-ins only, so the bridge bundle stays small (A2 3.7.1). The server side is `packages/service/src/local/`, which imports it. `docs/protocol/tasks-local-1.md` documents the protocol.
- **Files.** `packages/files` is a package of its own because `launch` and the shim need it and may import neither `service` nor `storage`. Storage uses its own `files.ts`, built on it behind the `FileIo` seam its tests inject failures into. `packages/service/src/hub/permissions.ts` holds the one rule for who else may write what the product trusts.
- **Projection.** `packages/projection` reads a space through a reader connection and writes its outbox only through the writer's two bookkeeping calls (`projected`, `queueProjection`), so it needs no operation. The service runs it in `hub/projection-entry.ts`, one worker per open space.
- **Hub.** `serve.ts` is the only code that touches process-wide state (crash handlers, signals, fatal reports), so tests run the lifecycle (`service.ts`) in-process. `paths.ts` is pure over the host's facts, so every OS's layout is tested on every OS.
- **HTTP.** The CLI imports only `@tasks/service/http/shared`, which loads no storage.
- **Machine configuration.** `@tasks/launch` reads the plain values of the `machine.toml` sections A4 owns, with no TOML dependency. The file itself is A2's (`@tasks/service/config`).
- **Launch records.** `launch` reaches the writer through a port, so it never imports storage. Its store contract suite (`@tasks/launch/execution-store-contract`) is what the later L1 journal must pass.
- **Shim.** The shim client (`packages/cli/src/shim/`, built alone as `lib/shim.mjs`) loads only `@tasks/launch/shim-wire`, `/process` and `/places`, the bridge's protocol and discovery, and `brand`, so `tasks mcp` and the CLI load none of it. `[A4.5.shim.entry]` checks the list.
- **Build and install.** `scripts/build/`, `scripts/install/` and `scripts/release/` are tooling. What the installed product runs is product code: the version folder's manifest format lives in one module (`packages/service/src/version/folder.ts`) that the build writes with and doctor, install and update check with, and the install scripts hand over to `tasks install --finish`, which the updater reuses.

**Dependency rules.** `.dependency-cruiser.cjs` holds them with their reasons, and `pnpm verify` checks them. `[A7.3.2.dependency-rules]` proves on a fixture tree that each rule fires. In short: `brand`, `contracts` and `files` depend on nothing in the repository. `core` depends on `contracts` only and does no I/O. `web` imports only `contracts` and `brand`. Only `storage` imports a SQLite driver, and `launch`, `runs` and `importer-planning` change state only through operations sent to the writer. `bridge` uses a few Node built-ins only, so it cannot start the service. Production code never imports `testkit`, and nothing imports `spikes/`. Test files are exempt from the layering rules, but not from the storage, spikes and driver rules.

### 3.3 Toolchain and commands

`package.json`, `pnpm-workspace.yaml` and `.node-version` hold the pins and the supply-chain settings, `package.json`'s scripts the commands. What they do not say:
- **Node** 26.13.1, the same build that ships (A2 S19), provided by pnpm through `devEngines.runtime`, so every `pnpm <script>` runs on it with no version manager and no machine-wide install. Run everything through pnpm. A pin change also updates `scripts/build/node-pin.json` and the offline fixtures in `fixtures/node-v<version>/`. The tests that verify Node's real signature from those fixtures need `gpgv` (present on Ubuntu and with Git for Windows).
- **pnpm 12** reads only registry, auth, TLS and proxy settings from `.npmrc`, so install-script policy and supply-chain settings belong in `pnpm-workspace.yaml` (A6 L6).
- **TypeScript 6**, not 7: typescript-eslint 8 needs the classic compiler API, which TypeScript 7's package no longer ships. Revisit when typescript-eslint supports it.
- **Tests:** Vitest and fast-check. happy-dom for the page's component tests, with React's `act` and no Testing Library. Playwright with Chromium and Firefox from Playwright's own cache.
- **Markdown is not formatted,** because Prettier would pad the plan's compact tables on every edit.
- **Scripts are Node scripts** with no shell, because development happens on Windows too.
- **Native code:** MSVC for `launcher-win`. Rust only if the native forwarder is needed (A2 S13).

**Custom lint rules** (`eslint.config.js`, `scripts/eslint/no-shell-exec.js`, `[A7.3.3.lint.custom-rules]`) carry their reasons in their messages. Gaps they cannot see, covered by review: a single word kept in a variable, words split around a template's placeholders, a `.cmd` spawn through a variable, and `exec` reached through a value the rule cannot follow statically.

**Lab tests in `pnpm verify`.** `vitest.config.ts` has a parallel `product` project and a serial `lab` project (`spikes/**`), because the lab self-tests start services, compile C and install archives, and under a parallel run they timed out on the Windows runner. Verify runs the lab tests only when asked, when the base commit is unknown, or when a lab file or a shared file changed (`decideLab` in `scripts/lab-tests.ts`, `[A7.3.3.verify.lab-selection]`). When `spikes/m0/` is removed (3.7), the `lab` project and this rule go with it.

**Signing.** `pnpm release` generates the release key and signs, by the owner only and never in CI (A2 3.12.8).

### 3.4 Rules for implementing agents

The repository's `AGENTS.md` (3.5) owns how implementing agents work. This section holds only the step mechanics.

**Steps.** Each step in 3.7 to 3.14 has an ID (`M2.10`), the work and the sections it implements, its dependencies, a Verify line and a size. **S** is one focused session, about 150 to 600 changed lines with tests. **M** is one long session, about 600 to 1,200 lines. A step that turns out larger is split before work starts, and the split is recorded in `STATUS.md`. A part that a merged step left unbuilt becomes a step of its own, with that step's ID and a letter (M2.04b), counted within its milestone. **RM** marks a step that ends with a check on a real machine. A step's dependencies name the code it builds on, never a milestone. An agent edits only its own row in `STATUS.md`, and a row becomes `done` when its pull request merges.

**Stacked branches.** A step may start on top of the branch that holds the code it needs, before that branch merges. Its agent is told which branch it stands on, and the step is rebased or merged when its base changes in review. When several open pull requests change `packages/contracts`, the reviewing agent resolves the merge and runs `pnpm gen` again.

**PR checklist.** Every pull request description ends with:

```markdown
### Done: M?.?? <title>
- [ ] Matches <appendix §>. Deviation: none | the section is updated in this PR
- [ ] Stacked on: main | <branch>
- [ ] Verify line run on <Windows | Ubuntu | both>. Output below
- [ ] pnpm verify green on Windows and Linux, on the branch merged with main
- [ ] Tests added: unit | property | integration | crash. Fixture data only
- [ ] Manifest IDs of new tests and their owner milestone (tests/manifest.json)
- [ ] Contracts and generated files: unchanged | regenerated
- [ ] Migration: none | <number>, with a fixture-database test
- [ ] UI: none | Sumi and Washi screenshots at 1,440 px, axe clean, keyboard path tested
- [ ] RM step: TASKS_HOME test install on <machine>, result below
- [ ] Gate: none | what waits for a lab session (3.7)
- [ ] Review: rounds and depth (3.18.5), every finding fixed or answered
- [ ] Not tested, and why:
- [ ] New dependencies: none | name, version, licence
```

**Real data.** Real work data is touched only on the Linux reference machine: the deploy check, the real-use import and its re-imports (3.6), and Refresh. Their reports stay in that space. Problems from real use are reported with `tasks doctor --bundle --redact-paths`, which holds no task text (A2 3.13).

**Real-machine steps.** Build the archive on Windows, copy it to the Linux reference machine, and install it with the build's install script as a `TASKS_HOME` test install into a root that does not exist yet. Its install ID gives it its own runtime folder, socket, launch folders, unit and port (A2 S28), and it keeps program, command and data under its one root. Run the Verify line there. Afterwards remove the root only when its `install.json` says the installer made it. No sudo, nothing outside the home folder.

**The daily install.** From the real-use point (3.6) the Linux reference machine also has a daily install (M1.15), kept on the latest verified build. After every merged batch that passes verification it is deployed: back up, upgrade (migrations run only after a verified backup), then check that the space opens, the main views load, search works and Open works. Before the first build with a new migration step is deployed, the installed-build migration drill (3.10) runs on the Linux reference machine against that build, because its first writer migrates the real spaces. A break is fixed before any other work.

### 3.5 The repository's `AGENTS.md` and `CLAUDE.md`

The repo-root `AGENTS.md` is the single source for how people and coding agents work on the repository. It wins over conflicting process rules in this plan, and this appendix does not copy it. `CLAUDE.md` imports it, and also the git-ignored `local/AGENTS.md` when that exists, so every agent app reads the same rules. A checkout's machine setup, workflow and real-machine notes live in `local/`, never in the repository.

### 3.6 Milestone map and order

| Milestone | Goal | Base steps | Owner |
|---|---|---|---|
| **M0** Lab | Observe and qualify every load-bearing fact | 12 | Three lab sessions, report review |
| **M1** Core slice | One space, one writer, one CLI, a verified backup and restore, installed on Windows and Linux | 15 | Acceptance transcript |
| **M2** Walking skeleton | Open a task in T3, Claude Code and Codex on Windows and Linux | 15 | Acceptance on each machine, then 3–5 days of use |
| **M3** Durable space | A1 complete for v1 | 16 | Restore drill, projection, scale note |
| **M4** Agent interface | A3 complete | 8 | Setup previews, eval report |
| **M5** Planner UI | A5's v1 scope | 13 | Every screen, five days of use |
| **M6** Runs and routines | A4 runs, Refresh, Wrap-up, the Tasks work folder, every v1 target | 15 | Refresh on the Linux reference machine |
| **M7** Switch-over | Import, rollback tooling, trial, retirement = **v1** | 10 | Rehearsal, cutover, a daily check during the trial, gate review |
| **Total to v1** | | **104** | |

**Order.** A milestone groups steps and owns a definition of done. Its position is not a dependency: a step starts when the code it needs exists (its Needs column), on main or on a branch (3.4). The importer (M7.03 to M7.05), for example, is ready by the real-use point, long before M7. A milestone closes when every step in it is merged, its definition of done holds, `pnpm accept m<N>` passes from source in CI and against an installed build on a real Windows machine and a real Linux machine for the active profile, its `manual` entries are in the qualification record, and its review list has been offered to the owner.

**Lanes.** Agents work in as many parallel lanes as the dependencies allow. Rules that keep lanes apart: one open migration at a time, additive contract changes (3.4), and one UI lane during M5, with the other lanes on runs and the importer. The Owner column is owner-only work. It does not hold other steps or a milestone open: what needs the owner is noted, and independent steps go on. An "Owner reviews" list names what the owner looks at after a milestone.

**Scope.** The base is every step in 3.7 to 3.14. Conditional steps are kept apart.

| Part | Steps | When it applies |
|---|---|---|
| Base steps | 104 | Always. The M0 rows marked ● need the owner's lab sessions. 2 are the rehearsal and the trial |
| Native forwarder F1–F4 | 4 | Only if bridge rule 3 fires (A2 3.7.7). Rule 1 applies provisionally (3.7), so they are not scheduled and `tasks mcp --node` and `tasks-bridge` do not appear in M6 |
| Windows cancel helper M6.04h | 1 | Applies: N03 showed it is needed |
| Fallback driver as primary | 1 | Not now: `node:sqlite` stays the primary (3.7, R08) |

**Real-use point.** The agents decide when the product is mature enough for the first user's real work tasks, and mark it in `STATUS.md`. It need not be stable, but the core must be there. Guideline: a durable space with verified backups, the prototype importer (M7.03–M7.05), Today and the task lists with the expanded task, editing and check-off with undo, agents updating tasks through MCP, and Open in T3 Code and Codex on the Linux reference machine. From that point that machine has a daily install with a work space imported from the prototype (3.4). Until the M7 switch-over the prototype stays the source of truth and TT Tasks only reads it. Re-imports are idempotent and never lose an edit the first user made in TT Tasks (3.15.6). The M7 rehearsal, trial and retirement gate stay the formal switch-over.

**If the owner wants a smaller v1**, cut in this order, and ship the cut parts in M8:
1. Claude Desktop and Codex app links (Copy covers them).
2. The Agents view and session revert in the UI (the CLI keeps both).
3. First-run UI steps 2 to 5 (the CLI setup covers the first user).
4. The Washi theme (tokens stay).
5. Projection files for completed tasks (`catalog.jsonl` keeps them).
6. The Wrap-up routine (D12 holds without it).

Each cut is applied as a named scope profile (3.18.6), which changes the acceptance scripts, the definitions of done and the retirement criteria together. The owner chooses a profile, or the agents do when a step blocks, and write it into the specification.

Not on the cut list, and changed only by a deviation written into the specification when one blocks: Open in T3, Claude Code and Codex, Copy, runs on a task, Refresh, check-off with undo, the importer, the rollback, backups and crash safety.

### 3.7 M0: the real-machine lab

**Goal.** Turn every fact that product code depends on into an observation on Windows and Linux (R17), and record the decision it drives.

**State.** M0.01 to M0.12 are merged and gate G1 has passed. G2 stays open until the three lab sessions have run. Rows marked **●** need the owner at the machine. Rows marked ↻ are unattended re-runs. `planning/STATUS.md` lists what is open.

**Lab rules.** They hold for every remaining run.
- Lab code lives in `spikes/m0/` and is removed after its last user: the last lab session and M3.16's re-run of R05 with the storage bench. Only `fixtures/streams/` survives.
- **Windows lab machine:** a key-level before and after record of every configuration file a check touches, restored the same day.
- **Linux lab machine:** no sudo, nothing outside the home folder, scratch folders only. Configuration changes go into scratch homes (a new `CLAUDE_CONFIG_DIR` or `CODEX_HOME`) with a key-level record, removed the same day. Native Codex launches use the default home with per-launch flags and no configuration writes. Any other Codex home is detected only, never launched. Managed instruction files and skill folders are never written. Claude Code runs there only in an attended session.
- **Agent homes:** no sign-in file or token is copied, read, printed, hashed or moved, and no API key is looked for. No trust or approval setting is written in a real home. A registration in a real home happens only in an attended session: preview, entry backup, apply, exact removal.
- A check that cannot run is recorded "not run" with its reason, and its fail branch applies until it is re-run. A result that changes a design choice is written into the section it belongs to. Screenshots from the Linux lab machine are not committed. Run dates, OS builds and app versions stay outside the repository.

**Lab code.** `spikes/m0/README.md` and the folder READMEs describe each tool. The code enforces the lab's safety rules: closed, structured logs (`kit/probe-log.ts`), fixed classifications in place of any program's own words, allow-listed child environments with process-group shutdown (`agents/spawn.ts`), removal only inside the run's marked scratch folder (`agents/scratch.ts`), run-only settings in signed-in homes (`agents/lab.ts`, `runs/lab.ts`) and the Linux lab machine guard (`runs/guard.ts`). Two reasons bind any change to it: logs are closed by construction because redaction heuristics leaked short values and paths, and nothing a CLI, a model or the OS says in its own words is kept, because account names, paths and credentials hide in it. The storage bench (`storage/run.ts`) judges a row only when the run meets the scale and durations that `spikes/m0/storage/README.md` lists. Any other run is indicative.

**Sessions with the owner present** (●): watching a window, clicking a trust or approval prompt, signing in, rebooting.
1. Windows launch and apps: L01–L09, L12, A03–A06, U02–U06, S05, N02's interactive resume, the tool-choice check.
2. Linux launch and apps: L01–L09, L11, L12, A01's sessions, A03–A06, E02's Claude Code part, U01, U03, U04, U06, U07 visible, S11, N01, N02's interactive resume, the tool-choice check.
3. Reboots and sign-in, on Windows and Linux: S01, S02, S03, B01, B06 and B07 cold after a reboot, E01's boot and sign-in halves, and N04.

Session 3 registers the service with the product's own `tasks service install` (M1.12) in a `TASKS_HOME` test install made with M1.14's install script from a test build (3.4), never with a lab script. If the mechanism fails, M1.12 is fixed and the session runs again. S02 is checked through the product service's own reading of its secrets folder at boot, and S03 describes the product's supervisor in `tasksw.exe`. The cold runs are three per machine, one per reboot (`forwarder_online` for B01 and B06, `forwarder_offline` for B01, `shim_claim` for B07), timed by a non-Node supervisor that times the installed launcher directly (`spikes/m0/lifecycle/`), and reported apart from the warm runs. A cold start far above the warm numbers is a reason to re-run B01 and revisit the bridge rule.

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
| B01, B06, B07 ● | Cold after a reboot, Defender on (A2 3.7.7): forwarder to the first byte of the `initialize` reply p95 ≤ 250 ms Linux, ≤ 600 ms Windows. Bridge start ≤ 2 s. `tasks shim` to its claim ≤ 300 ms. Warm runs pass with wide margins | The bridge rule. B07 fail: the shim follows the native-forwarder rule |
| S01 ● | Linux: the unit from `tasks service install` starts at boot before login, and a terminal in a scope and a run in a transient unit survive `restart` and `stop` while a control child dies, and a SIGINT to the run's group does not reach the shim [M0-S4, A4 M0-L10]. A pre-test passed | A4 L11. Fail: transient units for terminals too (A4 3.7) |
| S02 ● | Linux: the service started at boot reads its secrets folder before login | A6 L4 |
| S03 ● | Windows: the Run value from `tasks service install` [M0-S7] | A2 S4 |
| S05 ● | Windows: packaged parents P-1 to P-6 [M0-S8] | Packaged-context rules. P-2 fail: A3 marks the app "needs check" |
| S09 | Linux: a test install beside a daily install [M0-S14]. Passes at spike level and in CI | M1.15 on the real machines |
| S11 ● | Linux: the peer UID check with the Firefox snap [M0-S6] | A2 S17 |
| E01 ● | The login-shell snapshot of a boot- or sign-in-started service finds the same tools as a hand-opened terminal, within 2 s or cached [A4 M0-L11]. The unattended halves pass (736 ms on Linux, 36–47 ms on Windows) | A4 L12's layers and the `via_login_shell` default |
| E02 ● | Linux: the socket from inside Claude Code's sandbox [M0-S12] | The sandbox hint for Claude Code |
| U01, U02 ● | `tasks open` into Firefox on Windows and Linux and Chrome on Windows [M0-S5, A5 M0-1, M0-6]. The page checks pass headless | A2 S15, S16 |
| U03 ● | No Local Network Access prompt for the loopback page in current Firefox and Chrome | Fail: document the one-time permission |
| U04 ● | Firefox's keys [A5 M0-2] | The A5 keymap |
| U05 ● | Firefox on Windows renders the bundled fonts [A5 M0-3] | A5 U16 |
| U06 ● | Source links and the reveal button [A5 M0-5] | `place.reveal` |
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
| L12 ● | The three native targets in a stand-in Tasks work folder [A4 M0-L18] | The work-folder route per target (A4 3.3, M6.08) |
| N01 ● | Linux: `claude -p` streams [A4 M0-L12]. Windows passed | The `claude-print` adapter |
| N02 ↻● | `codex exec --json` with full access on Linux ↻ (it ran in the default sandbox only), and the interactive resume of an exec thread on Windows and Linux ● [A4 M0-L13] | The `codex-exec` adapter, Continue |
| N04 ● | Linux: every read operation the Refresh template needs per source (A4 3.12.2: mail inbox and sent mail, calendar, documents, issue tracker, wiki, each search or list with a since-time and each fetch) runs without an approval request [A4 M0-L15] | Fail: agents never change approval settings, so the needed read overrides go to the owner to set and N04 re-runs through the same path. Still failing: the gate rules apply |

**N04's topology.** The product's service cannot start runs before M6.03, so session 3 runs N04 with the lab's stand-in service in a transient unit that the user manager starts after the reboot, before anyone signs in. It starts `codex exec` through the lab's run shim in its own transient unit, with the default Codex instance, E01's login-shell environment, the routine work folder as cwd, and the planned per-launch flags and timeout. A sign-in imports the desktop session's variables into the user manager, so a run started after it is only a pre-test. The recorder compares the names of the run unit's environment variables with E01's before-login snapshot. M6.15 repeats N04 through the product.

**Bridge rule.** A2 3.7.7: rule 1 ships Node, rule 2 retries with bridge-only Node flags, rule 3 adds the forwarder steps F1–F4 (3.13) before M7. **Rule 1 applies, provisionally.** It is re-checked (↻) by B01 to B07 through the product's own bridge, from a `TASKS_HOME` test install of the release build on each machine, by A2 3.7.7's protocol, and again by session 3's cold starts.

**Gate rules.** A row is *observed* when it has a recorded result. A required capability is *qualified* when a passing run of its row, through the path the product will use and after any remediation, shows it works on the machines that need it. A gate passes when every row it covers is observed and every required predicate below is qualified. G1 covers the R and B rows. G2 covers every row.
- A required predicate whose row has not run counts as failed. A route is never qualified by its unattended parts alone (D6–D8).
- A failed predicate is remediated, and its rows are re-run on the same machine through the same path. The results keep both runs.
- Copy, an "experimental" label or a visible session never qualifies a required capability (D6–D8). Accepting less deviates from the owner's decisions: it happens only when the capability still blocks after remediation, and it is recorded in the specification with the scope profile and acceptance scripts (3.18.6).
- Rows without a required predicate (thresholds, best-effort apps, recorded behaviour) drive the decision in their row. A miss is decided and recorded before the dependent step starts.
- If S01 or S04 shows a scope or a detached process dying with the service, the placement changes in A4 and in the terminal adapters, and the row is re-run.
- Every row is repeated before each release as `tasks doctor --live` or an acceptance check, with a qualification receipt (A4 5.3).

**What a gate holds.** A step behind a G2 predicate is built and merged once its code dependencies exist, to the lab's unattended findings. Its pull request lists what waits for a session. The gate decides whether the step may be called done on real machines, so M1.15 and M2.15 are not claimed before the sessions. If a session contradicts what was built, the fix comes first. G1 is qualified: R01 and R08, R02, R09 after remediation, R10, and bridge rule 1 provisionally.

| Required G2 predicate | Rows | State | What waits for it |
|---|---|---|---|
| The service starts at boot on Linux and at sign-in on Windows, through `tasks service install` | S01, S03 | Pre-tests only | M1.15's reboot part and M1's definition of done item 4 |
| A terminal and a run survive a service restart | S04, S01 | Windows yes. Linux provisionally, from the S01 pre-test | M2.09 and M6.01 rely on it until session 3 re-runs S01 through the product's unit |
| Two installs on one machine never share an endpoint, and a stale lock recovers | S06, S09 | Yes at spike level and in CI | M1.15 on the real machines |
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
- The release key does not exist yet. `RELEASE_PUBLIC_KEYS` (`packages/service/src/version/release-keys.ts`) holds a placeholder, so release rendering, `pnpm release sign` and `tasks update` refuse, and only test builds, whose install scripts say so on every run, can be installed.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M1.15 | The daily install and real machines. The install scripts' default roots: the program in `~/.local/share/tasks/` (`versions/`, `current`) and the command in `~/.local/bin/` on every OS (on Windows both stable launchers, which find the root at `<their folder>\..\share\tasks` with `share` and `share\tasks` checked as plain folders, A2 3.12.3; elsewhere the link `tasks` → `../share/tasks/current/bin/tasks`), with A2 3.12.4's PATH warning on Linux and the user `Path` entry on Windows. Data and configuration stay in `~/.tasks`, with `install.json` and `update.lock` in `<state>`. `tasks uninstall` plans the service entry's removal first (A2 3.3.5), then removes only what `install.json`'s `created` lists, and never anything in the data folder. Then the real machines: the Windows install with the Run value, a Linux test install with the unit and linger, A2 3.14's budgets with two generated spaces at the design scale (5,000 open and 50,000 completed tasks each), commit latency included, a backup and restore drill, and M3.01's installed-build migration drill (3.10) on Windows and Linux before any real space is upgraded to 0.2 (A1 5). The budgets and both drills run before the lab sessions. The reboot and sign-in part runs as lab session 3 and shares its reboots | M1.12, M1.14 | With the home folder set to a temporary folder: a default install puts the program, the command and the data in their places, and install then uninstall leaves the data folder as it was. The budgets and both drills pass on Windows and Linux and their numbers are recorded with the session. `pnpm accept m1 --installed` passes on Windows and Linux | M RM |

**Definition of done.**
1. The manifest entries owned by M1 (3.18.6) pass on CI (Ubuntu, Windows) and against the installed build on Windows and Linux: create a space, then add, patch, note, complete and reopen through the CLI, then back up and restore it. The migration drill passes on the installed build.
2. 10 CLI writers making 100 patches each on overlapping fields: every acknowledged write is present, every stale write returns a conflict, nothing is lost.
3. The 30-minute crash harness is clean on both OSes.
4. The service starts at sign-in on Windows and at boot on Linux, restarts after a kill, and a second instance exits 73. A test install beside it changes nothing for it. This item waits for lab session 3.
5. A2 3.14 targets for start-to-ready, idle memory and CLI p95 hold, or a decision is recorded before M2 is accepted.
6. No fixture text appears in any log.

**Owner reviews:** the acceptance transcript from Linux and `tasks doctor` output.

### 3.9 M2: walking skeleton (Open)

**Goal.** From a bare page in Firefox, the first user opens a task in T3 Code, Claude Code CLI or Codex CLI in the task's exact folder, with the brief, on Windows and Linux. The agent reads the task and logs progress through the product's tools, and the page shows it live. This is D5's walking skeleton, standing on the production core.

**Merged.** M2.01 to M2.14, and M2.04b the grant gate. What later steps take from them:
- Tool definitions are measured and reported, not capped, and kept lean: a field or description earns its place by preventing a wrong call (A3 3.2.5).
- A field or section the request path cannot serve yet is refused with the step that brings it (`unsupported()` in `packages/service/src/ops/errors.ts`), and each LATER example of the contract suite (`packages/service/test/contract/suite.ts`) names its step. The step that builds one moves its example to VERIFIED.
- M2.08 to M2.11 are built against fakes. Real terminals, T3's server and the boot-started snapshot are qualified only by the lab sessions (3.7), and M2.10's routes also rest on L02 to L04 and L09. Each assumption fails safe: a refused or unknown answer is a defined launch state, and a rollout file of another shape matches nothing.
- **Binding** (`packages/service/src/binding/`, A3 3.7). Nothing an agent chooses, a folder or an environment variable, ever binds. Session records live in `<state>/sessions.json` until migration step 0003 adds A1's `sessions` table (3.10). Tests `A3.3.7.binding.*`, and `tests/forwarder/binding.test.ts` for a real service restart through a real bridge.
- **Setup** (`packages/service/src/setup/`, A3 3.13). The engine runs in the CLI, in the person's session, so each app's command is the one on the person's PATH. It takes everything it reads and runs as input (`SetupInput`), so the service can run it for the first-run screen (M5.12).
- **The grant gate** (`packages/service/src/ops/grant.ts`, `hub/home-gate.ts`, A3 3.7.8, 3.7.9). An agent home reaches only the spaces its live agent-home rows name, keyed by its entry's `--instance`, and its unbound writer scope is its row. Tests `A3.3.7.grant.*`. A test that opens MCP connections registers its agent homes as setup does. A4's refusal of a launch into an ungranted space is still to build (A4 3.9).
- **Brief and routes** (`packages/launch/src/brief/`, `src/routes/`, A4). Tests `A4.5.brief.*`, `A4.5.routes.*`, `A7.3.9.m2-10.e2e.copy`.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M2.10t | T3 Open from the page and the questions before dispatch, the part of M2.10 not built (A4 3.4.1; A5 3.8). `LaunchService` takes the hub's `T3Route`, and a click on a T3 instance runs availability, prepare, the Register question for a nested folder, plan, dispatch with the grant, and `confirm` after Dispatched and after recovery. Recovery's grant and replay call the route. The thread opens through A4 3.6.5's opener with the prefilled brief within T3's 8,000 characters and the title `<reference> <title>` through the sanitiser. The account check reads the instance's `spaces` and the area's accounts. The opener also replaces the minimal openers of `tasks open` and `tasks setup t3`. Until this lands, a T3 instance answers `no_route` | M2.10, M2.11 | From the page with a fake T3 server: Open on a task in an exact root reaches Confirmed. A nested folder asks Register, and Not now makes T3 unavailable for that task. A service restart after dispatch confirms or leaves Unknown and never dispatches again | M |
| M2.15 | Real-machine acceptance with the owner on each machine: the definition of done below, then 3–5 days of use. Before real tasks, a backup of each space is verified (M1.06). The work space comes only at the real-use point (3.6). With the owner, `tasks setup agents`, then `--apply`, then `--remove` in the real homes the owner names (on Linux only the default Codex home): the real `claude mcp add` and `codex mcp add` write the entry exactly as asked, `codex mcp remove` drops the patched keys with the table, and Codex loads `startup_timeout_sec` and `env_vars` | M2.01–M2.14, M2.04b, M2.10t, M1.15, lab sessions 1 and 2 | One pass or fail per target and machine, recorded with the session | S RM |

**Carried into the remaining route steps (M2.10t, M6.10, M6.11 and custom targets).** Routes build on the target catalogue and `Instance`, and check the reserved `[[custom_target]]` and `[override.*]` sections. A space-carried target definition is checked against the approvals in `machine.toml`. A space opened from an import starts with every space-defined target disabled, and the approved content is kept so the approval card can show a diff (A4 3.2). The `machine.toml` reader marks `{cwd}` and `{title}` in a custom terminal line as problems, which today only the launch refuses.

**Early demo.** After M2.08 to M2.10, M2.12 and M2.13, the first user can open a task in Claude Code on Windows from `pnpm tasks`.

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

**Merged.** M3.01 schema 0.2 and its migration, M3.09 synced and network folders and the read-only modes. A1 states what they guarantee: released schemas are frozen and the next change is migration step 0003, which also adds the `sessions` table and rebases the stand-in steps; a migration never touches a backup but its own, and a failed one is not retried by the same build on an unchanged database (A1 3.17); the folder check never makes a space writable when it cannot see (A1 3.2). The importer's tables (`exchanges`, `exchange_items`, `proposals` with origin `import_conflict`, `space.hold`, `aliases`) are in 0.2. There is no `space move` (section 6, item 27). Still to build from A1 3.2: the two actions for a failed check with M3.07, `quick_check` after an unclean shutdown and after an outside write with M3.15, and their buttons on the read-only bar (A5).

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M3.02 | Undo and redo per actor with per-field provenance lineage, the field-version guard and the undo floor. Physical versions stay monotonic. `tasks undo\|redo` (A1 3.10.1, 3.10.4) | M3.01 | ABA property test: undo never changes a field whose version moved. Undo then redo restores the values the commit wrote. Consecutive same-field edits, overlapping field sets, undo and redo cycles and foreign edits each give A1's result | M |
| M3.03 | Revert one commit and revert a session, both with preview (A1 3.10.2–3.10.3) | M3.02 | A 500-commit session revert takes under 500 ms. The preview equals the applied result. A session revert never removes a later human change | S |
| M3.04 | Lifecycle: complete, reopen, archive, additive wrap-up, tombstone delete and restore (A1 3.11.1–3.11.3, 3.11.4 without `redact`) | M3.01 | Property test: wrap-up never changes context, notes, log or sources. Restore brings back a tombstoned task with its history | S |
| M3.05 | Search: FTS5 table and `search_docs` written in the commit, query parser with escaping, ranking, compact rows, snapshot cursors that carry the incarnation, cursor entries that survive tombstones and redaction as placeholders, `tasks find` (A1 3.12; A3 3.9.1–3.9.5) | M3.01 | Random query strings never raise an SQLite error. Cursor pages under random writes, deletions and redactions have no gaps or duplicates, and a removed entry never shows its old text. Search rows equal a fresh rebuild | M |
| M3.06 | Source keys and dedupe: unique keys, upsert against active tasks and tasks completed in the last 30 days, rebinding rules. Receipts are checked before dedupe (A1-11; A3 3.11.1) | M3.01 | Property test: overlapping keys from concurrent sessions leave at most one task per key. A request that returned `existing`, retried after the 30-day window, replays `existing` | S |
| M3.07 | Export bundles and restore: backup rotation, export modes (backup, transfer, fork), stale-restore detection, zip hardening through M1.06's `BundlePolicy`, extended to bundles, which bounds expanded bytes, entry count and file sizes and is shared by the exporter, the backup writer, the restorer and the importer, the export secret scan (A1 3.18; A6 3.4, 5). The backup writer publishes its data file and its sidecar without replacing anything at their names (an exclusive create or a link in place of a rename), and leaves a published pair to the reader's checks instead of removing it when its last step fails | M3.01 | Restore drill in CI. A pair planted under a backup's reserved names while the backup runs is never replaced. A zip with `..`, symlinks, too many entries, too many expanded bytes or an oversized file is refused. The largest stress-corpus bundle passes | M |
| M3.08 | Authority: machine keys and host fingerprint, a new `ai_` incarnation and lineage entry on every claim, transfer import and restore-claim, a claim epoch of one more than the highest known locally, `tasks space export --mode transfer --to <machine>` with a `tr_` transfer ID, durable `preparing`, `published` and `finalized` states, restart reconciliation, `tasks space transfer --finish\|--cancel` and a `transfer_cancelled` incarnation, `transfers_imported`, two Claims of one backup detected as competing branches for the user to resolve with `tasks space resolve`, fork (A1 3.18; A6 3.5) | M3.07 | Random export, import, claim, fork and restore sequences: two Claims of one backup, at the same or at different epochs, are detected, never merged. A duplicate or misdirected transfer import never becomes authority. A crash at each transfer state reconciles on restart | M |
| M3.10 | Projection: outbox consumer, `view/` Markdown, `catalog.jsonl`, read-only marking, rescue of edited files, `projection.dir`. The watermark moves only through a fully rendered prefix (A1 3.13; A3 3.9.8) | M3.01 | After quiescence the projection equals a fresh render. One task shows within 1 s. A kill during the rename leaves a valid tree, and the watermark never covers an unrendered task | M |
| M3.11 | Preferences registry, feature flags, machine preferences (A1 3.16) | M3.01 | Policy keys refuse agent writers. Each flag has a default and a test | S |
| M3.12 | Hooks for later phases: the `ExecutionStore` contract suite that a later machine-local journal must pass, incarnation checks on `as_of`, `base`, cursors and receipts, and the filtered change-feed batches tested with a synthetic audience filter, which needs a row-level visibility rule applied to the snapshot and to every row as well as the commit filter, because a row shows every change ever made to it. v1 still sends every operation (A6 3.3, 3.7; A1) | M3.08, M2.12, M2.05 | A long interleaving of hidden and visible operations, dropped batches and reconnects keeps coverage gapless through empty batches and never reveals a hidden operation. The filtered batches pass the page's `LiveCore` interleaving property (`packages/web/src/store/core.test.ts`). A base, cursor or receipt from another incarnation gives a resnapshot or a conflict, never a match | S |
| M3.13 | Fallback driver: `better-sqlite3` in `loadDriver()` behind the same `driverContract()` suite, plus a CI job with the driver switched (A1 3.19). It needs `safeIntegers(true)` with the same exact-integer conversion, the same parameter check (`sql-text.ts`), the same fixed error messages, and the same file-name, backup-target and authorizer rules: opens through the literal path, backups into a new file only, `ATTACH` and `VACUUM INTO` of a named file refused, the folder pragmas refused. This step finds how `better-sqlite3` enforces the last | M1.02 | The full storage suite passes with the other driver on both runners | S |
| M3.14 | Redaction: human-only `redact` in entity and text mode, through one traversal of every store: state, `changes`, `commits.ops`, `history_text`, proposals, exchanges, receipts, the search tables, the projection, the outbox and caches (A1 3.11.4) | M3.04, M3.05, M3.10 | Sentinel text redacted in each mode is absent from every store and every read path afterwards. An agent gets `forbidden` on `redact` | S |
| M3.15 | Full crash and model suites: every fault point of A1 5 that v1 owns, disk full on a small filesystem, outside-write detection, the model test with 3–12 actors, and the harness additions of 3.18.1 | M3.02–M3.14 | Nightly 30 minutes per OS clean. Disk full gives `DURABILITY_FAILED` and read-only, with no partial commit | M |
| M3.16 | Scale on Windows and Linux: the design scale (5,000 open, 50,000 completed) and the stress corpus (10,000 open, 100,000 completed) against A1 3.20 and A3 3.9.9. Decide A1 open items 2–4. M0's R05 failed on Windows for broad queries: this step first chooses a query design for broad terms (capped candidates, a cheaper order past a match-count limit, or a restated broad-query target) and re-runs R05 on Windows and Linux with the storage bench (3.7). The search targets stay unmet until that re-run passes | M3.05, M3.10 | The targets hold or their decisions are written into A1 and A3. The numbers are recorded with the session | S RM |

**Carried into M3 from the write path.** `history_text` and the `{"$t": hash}` form for text of 1 KiB or more. Learnings on `task.complete`. `ext.<key>` fields, which `fv` decoding must then accept. Labels. Undo and revert on the change rows M1.04 writes. A6 3.16.4's secret scan of written text adds warnings to the result. A1 3.6's space hold and transfer states become `SPACE_READ_ONLY` reasons. A1 3.9's outside-write check on `PRAGMA data_version` before each `BEGIN IMMEDIATE`. The operations `source.unlink`, `source.patch`, `note.patch`, `note.delete` and `log.delete`, whose fields join `CHILD_FIELDS`. `place.clear`, and `tasks roots rename` with its rebind commit (A1 3.15).

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

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M4.01 | Remaining tools: `search`, `add_tasks` (upsert), `reopen_task`, `organize`, `preferences` (non-policy keys), and `run_report` in the list. Every connection, online or offline, now advertises the same eleven tools. `run_report` outside a run or routine binding returns `not_permitted`. The user-only class and R7 refusals. Remote envelope types in the registry's type package only. `search` and `add_tasks` join the server instructions and the renderers (every listed tool has one). `preferences` takes null to reset a key, added narrowly with declared preference-value schemas, never an unrestricted `unknown`. `organize` and `preferences` get a rule for mixed read and write actions and conditional request IDs (A3 3.2.3, 3.4; A6 3.3) | M3.05, M3.06, M2.03 | `mcp-tools.json` equals the agent-allowed class. `tools/list` is byte-identical on bound, unbound and offline-cache connections in both eras. `run_report` on an unbound or task-bound connection writes nothing. Every user-only entry returns `forbidden` to an agent actor | M |
| M4.02 | Autonomy and proposals on the staged plan's actual targets: levels, per-action and per-area overrides, the stricter of source and destination for moves, the decision table, proposals with base versions, user-only accept and reject, the writer's `policy(plan, scope)`. The burst brake at 51 affected records, counted from `commits.affected` per writer scope from a writer's first call (A3 3.7.9: the session, else the agent home's grant, else `agent:unknown`, `script` or the user's scope). Defines the proposal section payload of `task.get` (A3 3.7.9, 3.8; A1 3.10.5; A6) | M3.01, M2.03, M2.04b | Exhaustive decision-table test over actual targets. Binding after 10 unbound completions does not reset the count. Accepting a proposal whose base field moved fails as stale | M |
| M4.03 | Digest v1 and framing: provenance labels, nonce-delimited data block whose markers are drawn after checking the whole rendered payload, every user- or agent-editable name framed as data, up to three related learnings, notes from the user for agents never silently cut (an overflow line and paging through `get_task` sections), the sanitiser on write, the secret pattern warning (A3 3.9.6–3.9.7, 3.10; A6 3.16.2, L4) | M3.01, M3.05, M2.03 | Digest property test: never over the cap, `+N more` when cut, the marker never in content, a user note whole or behind the overflow line. An injection sentence as an area or label name appears only inside data blocks. Tag characters removed | M |
| M4.04 | Final server instructions and the optional instruction block with preview and the managed-source overlay (A3 3.6, 3.12) | M4.01 | About 2 KB, within 3,500 bytes, with the trigger and start rule self-contained in the first 240 characters, because Codex CLI shows its model only the first 246 to 295 (3.7 row A06). Every tool it names exists. `print-block` writes nothing | S |
| M4.05 | Setup for Claude Desktop, the Codex app and T3 homes (read-only), on M2.14's engine and its rules: each home judged by setup's own rule (another owner or a file anyone can write is refused, group write is allowed), the entry-level record, the ownership check before every take-back. `print`, `print-block`, the `block` and `approve-tools` parts and `--parts`, and managed rules 3 (another git repository tracks the file) and 4 (`setup.managed.paths`). `tasks doctor` agent checks, including `--live`: `mcp.<home>`, `codex.engines.<home>` and `grants` read `agents.json` and `setup/homes`, and an entry whose recorded command is missing shows (A3 3.13.3–3.13.7, 3.14). Doctor also gains the launch rows the merged steps left: the scope probe (`TerminalLauncher.scopes()`, a warning when terminals start without scopes), the login-shell snapshot's outcome and age (`UserEnvironment.take()`), and T3's pairing from `t3/status` with A4's warning five days before the token expires | M2.14 | Apply and remove on scratch homes leave files key-identical. Doctor checks pass against fakes | M |
| M4.06 | Binding complete, on M2.04's binding service, with every input from the authenticated bind frame: bind frame rule 3, native IDs alone, on the IDs M2.04 records (Claude preset, Codex reference match, T3 thread ID). Shared hosts beyond M2.04's guard: host detection from ancestors, Claude Desktop chat without a session ID, per-call binding by native ID, `durable: false` with its hint. User-only `session.unbind\|rebind\|end`, which end a session and its handles. The session list and Resume rules. The session record made with the launch intent before dispatch (A3 3.7.7), so a `cli-agent` call before any bridge bound maps to its session. The result says "this session is bound to M-14" for an explicit task on a bound connection. Defines the session section payload of `task.get` (A3 3.7; A4 3.10) | M2.04 | A3 section 5 binding tests. Resume is offered only with a trusted native ID | M |
| M4.07 | Source ingestion: key namespaces, the refresh guide in `status`, coverage shapes for `run_report` (A3 3.11) | M4.01 | A refresh fixture run twice through fakes creates nothing the second time | S |
| M4.08 | Interactive agent evals: a harness for headless Claude Code and Codex on temporary spaces, run by hand on Windows. A3 section 5 scenarios 1, 3, 4 and 5, and scenario 2 in its ingestion form: an interactive session ingests a fixture inbox twice through `add_tasks`, with no run adapter and no `run_report`. Scenario 2 as a real routine run is M6.14 | M4.01–M4.07 | Pass or fail per scenario and app, with the tokens used, recorded with the run | S RM |

**Definition of done.**
1. Every manifest entry owned by M4 passes: A3 section 5 unit, property, crash and binding tests, without the real-run and routine cases that M6 owns.
2. Evals: scenarios 1, 3, 4 and 5 and the ingestion form of scenario 2 pass in Claude Code and Codex at Full, and scenario 1 also passes at Suggest.
3. `tasks setup agents --apply` and then `--remove` on the owner's real homes on Windows change only the product's keys, shown by a key-level record. Each preview is shown and saved, with an entry backup, before it applies.
4. `tasks doctor` is green on Windows and Linux for every registered home.
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
| M5.04 | Today: week strip, Focus, This week, Next, Changes, with disjoint sets (A5 3.4). Its sections and membership replace `ViewPage`'s list through `contextFor(view, grouping)`, with the counts and disjoint membership in `src/app/views.ts` | M5.03 | Property test: no task in two sections. The date appears once | S |
| M5.05 | Status views, area views, Completed and Agents, with grouping (A5 3.5): Inbox and Review flat, Waiting by person, the area view by project. Completed is built on `usePagedQuery`. The snapshot's compact row carries when a task's current wait began, so Waiting shows the time spent waiting (`RowInput.waitingSince`) instead of the task's age | M5.03 | Counts add up across disjoint views. No view has a heading element. End to end: a task that starts to match Completed appears or offers a refresh | S |
| M5.06 | Expanded task: content without section labels, facts panel, sources with their own text, thread of notes, log, sessions and runs, learnings. It replaces `src/task/Expanded.tsx` and `Thread.tsx` and keeps their props, with the expanded row's header (collapse, title editing), the task route's host view and the URL while a task is expanded. The task route resolves a task in any lifecycle: active, completed, archived, Inbox without an area, and restorable deleted. The detail refetches on `onTouched`. The snapshot's compact row carries each task's source kinds with their text and URL, and its place's state on this machine, which the row's columns also show (A5 3.7) | M5.03 | No fact string twice in one expanded task. A link to a task in each lifecycle opens it. Keyboard path passes | M |
| M5.07 | Composer and action strip: Note, Open per instance, Run (shown, wired in M6.09), Copy and Shift+Copy (A5 3.8). The strip replaces the expanded row's toolbar of instances and Copy | M5.06 | Composer keys including IME composition. Open passes the composer text to A4 | S |
| M5.08 | Field editing, check-off, toast, undo and redo, the "Restore mine" conflict (A5 3.11, 3.12). It enables the row's checkbox, drawn disabled until check-off has its hold, toast and undo, and the star's edit joins undo and conflicts | M5.06, M3.02 | Flow: edit due, priority and effort, check off, undo, redo. Agent-only fields start a composer request | M |
| M5.09 | Receipts and run status, proposals and the review card, changed marker and digest. `ui.mark_seen` and `ui.clear_digest` as user-only calls outside history (A5 3.9, 3.10, 3.14, open item 6). The row's marker (`RowInput.marker`), receipts and run states on the tile. The snapshot carries each task's latest launch per instance, so a tile shows Connected after a reload, and the feed's launch entities carry their `task`, so the list refreshes only that task | M5.06, M4.02 | Each receipt and run state renders from fakes. Unknown never re-dispatches. Partial accept of a proposal | M |
| M5.10 | Quick capture and search in the top bar, with the capture parser (A5 3.13). The top field becomes search-or-add. Search is built on `usePagedQuery` with its filter and sort fields as `QueryDef.fields`, and the service's expired cursor calls `refresh()` | M5.03, M3.05 | Parser tests for dates, `p1`–`p3`, `#area/project`, `@person` and `*`. End to end: a task that starts to match an open search offers a refresh | S |
| M5.11 | Settings, feature flags, keyboard and the shortcut sheet (A5 3.18, 3.21). The other Settings sections beside Appearance. Single-letter keys behind `ui.keys.single`, and the sheet lists the list's keys. The tooltip component of A5 3.22, which reads the row's `data-tip`. Once `pref.set` exists the theme leaves `localStorage`. This step decides whether it becomes A1's per-space `ui.theme` or a machine-level choice: a per-space theme changes the colours when a tab switches space | M5.01, M3.11 | Each flag off removes its UI and keys without gaps. No keymap conflicts | M |
| M5.12 | First-run setup steps 0–5, with a slot for step 6 (M7.04) (A5 3.17). Its agent step calls M2.14's engine in the service through `SetupInput`, once the service has A4 3.8's agent environment. New space and Open folder in the space switcher | M5.11, M4.05 | First run end to end with fake detection, including a managed source and Skip | S |
| M5.13 | Quality pass: axe on every screen in both themes, the list included, the XSS suite, screenshot baselines at 1,440, 1,280 and 390 px, the 5,000-task performance test in CI and on Linux (the sweep of `list.e2e.ts` records frame times), NVDA and Orca passes, the pseudo-locale on every message and the compact dates (A5 5). The list derives every item again when the store publishes: this step measures that against A5 3.25 and derives per event where a budget fails. The app icon replaces the placeholder ring | M5.01–M5.12 | The owner approves the baselines. The Linux numbers meet A5 3.25 and are recorded with the session | M RM |

**Definition of done.**
1. Every manifest entry owned by M5 passes in Firefox and Chromium: A5 section 5, including the repetition rules (the date appears once, counts appear only in the sidebar, no uppercase, no view heading).
2. The screenshot set is checked against `A5-mockup.html` in Sumi and Washi (Sumi only under a profile that cuts Washi), the result is recorded and the set is offered for the owner's review.
3. A5 3.25's targets hold on Linux in the Firefox snap with 5,000 open tasks.
4. Every flow works keyboard-only.
5. The first user uses the UI as the daily list in a space of their own on Windows for five days.

**Owner reviews:** every screen in both themes, Today with real tasks, the keyboard flow, the font (A5 open item 1) and the monograms (A5 open item 3).

### 3.13 M6: runs, routines and every v1 target

**Goal.** A4's runs through the two CLI adapters, the two routines on request, the Tasks work folder for tasks without a place, the remaining targets and a safe update path. The T3 run adapter comes after v1. T3's interactive Open is unchanged.

**Merged.** M6.05 stream parsers and fake agents (3.18.1), M6.12 update from a local archive (A2 3.12.6). What later steps take from them:
- M6.01 moves `RunEvent`, `RunOutcome`, `Usage`, `ProgressLabel`, `AppToolsState`, `OutcomeReason` and the caps from `packages/runs/src/streams/events.ts` into `packages/contracts`, and settles the label-key and `session` changes there. M6.03's shim feeds stdout bytes to `push()` (or whole lines to `line()`), journals the events and writes `exit.json` from `end()`. M6.06 compares `session.cwd` with the run's folder, marks the run "without Tasks tools" when `appTools` is not `connected`, and uses `counts.declined` and `counts.permissionDenials` in the run's message.
- The updater refuses every archive while `RELEASE_PUBLIC_KEYS` holds the placeholder. It writes only the program's own files and never removes a version folder, so versions accumulate until M6.12r.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M6.01 | Run records and states: `runs` migration, the state machine, transitions written through the `ExecutionStore`, restart recovery (A4 3.11.1–3.11.2, 3.11.9; A6 3.3) | M2.05 | Run state property test, including cancel in every state and a crash at each boundary | M |
| M6.02 | Supervisor and limits: caps (3 per machine, 2 per instance, 1 per task), folder leases, roots with runs allowed, executor presence, wall and idle timeouts that the shim enforces while the service is down (A4 3.11.7) | M6.01 | Random starts never exceed a cap or share a lease. A timeout fires with the service stopped | M |
| M6.03 | Run shim: `run.attach` with the attachment credential of M2.08 and `run.event`, on M2.08's shim host and records, the service-to-shim `cancel`, a bounded normalized-event journal with sequence numbers and an atomic final outcome, independent of raw-log truncation, and replay from the journal cursor (A4 3.11.5, 3.11.9) | M6.01, M2.08 | Service lost before the 20 MB raw-output cap, agent finishing after it: the final outcome, native ID and usage survive the restart. Reattaching after both ticket windows never gives a second claim | M |
| M6.04 | Cancellation: each run in its own Unix process group and session, the shim outside it, SIGINT, then a timeout, then SIGKILL against the group, descendant cleanup after the leader exits, on Linux of the whole run unit (cgroup), since an MCP server outlived a SIGTERM to the group. Windows cancel: Ctrl+C through the console-attach helper (M6.04h), then `taskkill /T /F` after 10 s, with no `taskkill /T` step without `/F` (A4 3.11.8). A fake agent that starts a grandchild joins the fakes for A4 5.1's cancellation tests | M6.03 | A run that starts a grandchild and ignores SIGINT ends with no process left on Linux and Windows, and the shim records the exit | M |
| M6.06 | Run adapters `claude-print` and `codex-exec`: transient units on Linux, detached processes on Windows, logs and results, permission per instance, `run_report` permitted on run and routine bindings (A4 3.11.3, 3.11.5–3.11.6; A3 3.4.12) | M6.04, M6.05, M4.01 | Fake-agent runs end to end. A run's exit never changes its task. `run_report` succeeds on a run binding and returns `not_permitted` on a task binding | M |
| M6.07 | Routines: record, approval hash, work folders, one at a time, `schedule` stored and validated but never evaluated. Refresh from sources (template, source list, watermark, coverage) and Wrap-up (up to 10 tasks) (A4 3.12, 3.13.1) | M6.06, M4.07 | A Refresh fixture run twice creates nothing the second time. The watermark moves only on full success. Wrap-up keeps every original text | M |
| M6.08 | The Tasks work folder: one per space on each machine, `<machine state>/workdirs/space-<space-id>/`, allowed for runs by default, never a project folder or inside a space. M2.08 built the folder with its checks, and a launch with no place already works in it. Place resolution returns `{folder, kind}` with `kind` `place` or `work_folder`. Open and Run for a task without a place use it, along the routes L12 recorded. A task with a place always uses exactly that place (A4 3.3; A5; R11) | M6.06, M2.11 | A task without a place opens in each native target and runs in its space's work folder. A task with a place never uses it. An agent still cannot launch (R7) | S |
| M6.09 | UI: Run from the composer, the message box, Continue interactively, Refresh in the top bar with routine status, run entries in the thread, "Tasks work folder" shown for tasks without a place (A4 3.11.10–3.11.11; A5 3.8, 3.9) | M5.07, M6.07, M6.08 | Playwright with fakes: Run, Stop and Continue. Refresh shows "Refreshed 09:12 · Jira unreachable" from a fixture. Open on a task without a place shows the work folder | M |
| M6.10 | T3: the `t3-cli` fallback launch route and "Start T3 Code" availability (A4 3.4.1). It reuses M2.11's binding, held to exact roots, and its reading of T3's home. Reading T3's `.cmd` shim on Windows is this step's | M2.11 | Fake T3: the CLI route serves exact roots only | S |
| M6.11 | Best-effort targets and the context pack: Claude Desktop and Codex app links with the clipboard copy, receipts that wait for the bridge's folder check, Shift+Copy, and the clipboard tools of `tasks brief --copy` (`wl-copy`, `xclip`, `xsel`, `Set-Clipboard`; until then `tasks brief` prints) (A4 3.4.4–3.4.6, 3.15.5) | M2.10 | Golden URLs per OS. The context pack stays within budget | S |
| M6.12r | Version retirement, the part of M6.12 not built (A2 3.12.6 step 14). Garbage collection keeps `current`, its two predecessors, `install.json`'s `previous` and every version a journal names, and retires a version only under exclusive version-use leases, because a process may still run from it. This step settles the lease's form per OS, who takes it at launch, how garbage collection acquires it exclusively and how a crashed holder's lease is released, and A2 3.12.6 states that rule before garbage collection is built. Retirement is journalled and resumes after a crash | M6.12 | On the Windows runner and on Linux: a version in use is never retired, a retirement killed between the move and the last delete, a partial deletion retried, and a held file in the garbage folder each end clean. The leases hold for the stable launchers of M6.13 | M |
| M6.13 | Stable launchers on Windows: replacement launchers staged as `bin\<name>.new` before the switch, always two renames (one rename over a running launcher is refused), a swap that keeps the stable path valid where Windows allows it, `launcher.c`'s sibling repair (A2 3.12.3 step 10), and startup repair of a half-replaced `bin` folder from the journal, on M6.12's journal `launchers` and its Node repair (A2 3.12.6). Also the case the service's own repair leaves: a changed `tasksw.exe` whose old process still supervises the service | M6.12 | Crash injection between the rename and the copy of `tasks.exe` and of `tasksw.exe`: the next start repairs to a complete version | S |
| M6.14 | Real-run contract, by hand on Windows: A3 eval scenario 2 as a real Refresh routine on a fixture inbox through both CLI adapters, and the routine whose MCP host initializes from the offline cache during a service restart, then calls `run_report` with full coverage (A3 5) | M6.07, M4.08 | Pass or fail per adapter, with the tokens used, recorded with the run | S RM |
| M6.15 | Real machines: Refresh twice on Linux through Codex into a trial space, along the path N04 qualified, now through the product, a Wrap-up, cancel on both OSes, a task without a place opened and run, `tasks doctor --live` qualification receipts for every v1 target on Windows and Linux | M6.01–M6.14, lab session 3 (N04) | Receipts and pass or fail only, no content, recorded with the session | S RM |

**Conditional steps (not in the base).**

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| F1 | Native forwarder `tasks-bridge` in Rust, only if bridge rule 3 fires: framing, the handshake order of M2.01 and the bind frame (A2 3.7.6) | M2.01 | The handshake and pre-authentication parts of the conformance suite pass with `TASKS_BRIDGE_BIN` | M |
| F2 | Offline responder with the cached tool list, reconnect and `resume.handle` | F1 | The full conformance suite passes with `TASKS_BRIDGE_BIN` | M |
| F3 | Builds for linux-x64, linux-arm64 and win-x64 in the version folder, selected by the bridge rule | F2 | CI builds and smoke-tests each | S |
| F4 | B01–B05 re-measured on Windows and Linux, then the default switched | F3 | Thresholds of A2 3.7.7 hold, recorded with the session | S RM |
| M6.04h | Windows console-attach helper for graceful cancel (applies): a small native executable with a start mode that re-enables Ctrl+C for the agent (or the shim's launcher does it), and a cancel mode that sends Ctrl+C to the run's own console after checking its process list, with every API result checked and process identity as PID plus creation time. On Windows a graceful cancel can be tested only through this helper, because Node's `kill()` there is `TerminateProcess` | M6.04 | Graceful cancel of both CLIs on the Windows runner, under a detached parent. A foreign process on the console makes the helper refuse | S |

**Definition of done.**
1. Every manifest entry owned by M6 passes: A4 sections 5.1 and 5.2 without the scheduler and T3 run tests, so crash injection at every run boundary, no second agent, no lost or doubled stream event.
2. Runs and open sessions survive a service restart and an update, including a crash between a launcher's rename and its copy.
3. On Linux, Refresh run twice creates no task the second time, reports one coverage row per source, and moves the watermark only on full success.
4. Cancel works on both OSes, gracefully or through the recorded fallback, and leaves no process of the run's group.
5. Wrap-up writes outcome and learnings and leaves context, notes, log and sources byte-identical.
6. A qualification receipt exists for T3, Claude Code and Codex on Windows and Linux, and for Claude Desktop and the Codex app unless the scope profile cuts them. A best-effort target whose check failed shows "experimental". A required target never does.
7. A task without a place opens and runs in its Tasks work folder on Windows and Linux.

**Owner reviews:** the trial space after Refresh (on Linux only), run entries in the thread, one Wrap-up result, a task opened from the work folder, and how Claude Desktop and the Codex app behave.

### 3.14 M7: switch-over

**Goal.** Import the prototype, rehearse, cut over and run the trial. When the gate in 3.16 passes, v1 is done.

**Merged.** M7.01 synthetic prototype fixture, M7.02 pure parsers. What later steps rely on:
- **Fixture.** `packages/testkit/src/planning.ts` generates the synthetic prototype folder and its index from a fixed seed, in Mira's world with RFC 2606 hosts only. `pnpm seed --planning` writes it into `fixtures/` (`[A7.3.14.planning-fixture.deterministic]`): change the generator and regenerate, never the committed files.
- **Index** (`fixtures/planning-prototype.index.json`). It sits beside the folder, not in it, so the importer's input copy holds only prototype files. It names every edge case with its location and gives the ledger `counts` that M7.04's dry run must report (`[A7.3.14.planning-fixture.index]`). The fixture covers every mapping row of 3.15.3, because M7.03's Verify needs a fixture case per row.
- **The shared key.** The index's task is the Mira sample's M-1, which holds `jira:LUM-1000`, and `planning.test.ts` checks that it still does. If a change to Mira's random sequence breaks that test, keep Mira's first source a `jira:LUM-1000` ticket or move the fixture's key to Mira's first ticket.
- **Parsers** (`packages/importer-planning`). Not covered by a test: the file-link refusal on Windows without the symlink privilege. The Ubuntu job runs it, and the folder-link refusal uses a junction and runs on both.

| Step | Work | Needs | Verify | Size |
|---|---|---|---|---|
| M7.03 | Mapping to internal operations from `PrototypeParse`: areas, projects, statuses, owners, sources and keys, roots and places, aliases. Every task create uses `dedupe: none`, and shared sources are upserted by key and linked (3.15.3). It decides the focus day, uses the body's `Next:` clause (`task.next`) when metadata has no `next`, and maps `extra` to `ext.planning.<key>`. The importer's shapes that cross the service boundary move to `packages/contracts` with this step and M7.04 | M3.01, M3.06, M7.02 | Each mapping row has a fixture case and an assertion. Two legacy tasks with one key become two tasks linked to one source row. The fixture task with the same key is untouched | M |
| M7.04 | Dry-run report, preview token, first-run step 6 and Settings › Data import card (3.15.4). It decides which error codes block a preview, calls `verifySource` before it returns a token, and lists warnings under needs attention | M7.03. The UI parts also need M5.12 | `tasks import planning <fixture> --dry-run --json` counts equal the fixture index's `counts`, with zero source-hash changes | S |
| M7.05 | Apply, undo of an import, idempotent re-import through `exchange_items` bases (3.15.5, 3.15.6). It calls `verifySource` again before the applying transaction | M7.04 | Property test: random prototype edits between imports apply exactly the changed fields, conflict where the space changed the same field, and give zero operations for unchanged input. A failed pre-import backup aborts the apply before its transaction starts | M |
| M7.06 | Export to the prototype format: ledgers, metadata, the canonical event set and the export exchange with its marker map and base values (3.15.8). For an export folder outside the space, it decides what the exchange's `dir` holds instead of the absolute path | M7.03 | Round trip: import, export, import into a fresh space gives equal titles, statuses, areas, projects, aliases, places, sources, due dates, check-offs and stars. An independent parser of the export gives the space's state at the export for every task | M |
| M7.07 | Rollback tooling: `tasks space hold\|release` with the operations on 0.2's `space.hold` column, the `held` refusal and its decoding, `tasks export planning --hold --rollback-from`, and the return import through the export exchange (3.15.6, 3.16.4) | M7.05, M7.06 | Overlay test with the independent parser (3.15.8). Same-space return: create a task in the space, export, edit the copy in the prototype format, re-import: same task IDs, no duplicates, conflicts only for fields the space changed after the export | M |
| M7.08 | Trial tooling: `tasks trial check` (doctor, verified backup, integrity, counts, the daily export, the active scope profile) and `docs/switch-over.md` with the checklist in 3.16.2 | M7.07 | Runs green on the fixture space and prints one line per criterion of the active profile | S |
| M7.09 | Rehearsal on the Linux reference machine with the owner, including a rollback and return on the trial space (3.16.2) | M5.13, M6.15, M7.08 | Rehearsal clean, findings fixed | S RM |
| M7.10 | Cutover and the 10-day trial, run by the first user (3.16) | M7.09 | The gate in 3.16.3 passes | S RM |

M7.03 to M7.05 come before the real-use point (3.6), so the importer is ready when the first user starts real work.

**Definition of done:** the retirement gate in 3.16.3.
**Owner reviews:** the dry-run report, the rehearsal, the cutover, a daily check during the trial and the gate review.

### 3.15 The prototype importer

#### 3.15.1 Inputs and rules

The prototype folder holds `TODO.md` (open work), `DONE.md` (completed work), `data/metadata.json` (fields per task ID), optional `data/jira.json` and `data/audit.json`, `events/` (browser check and focus events), `context/`, `reviews/`, `snapshots/`, the page source (`assets/`, `index.html`), `planning.py`, tests and its agent instruction files.

Rules:
- The importer **never executes, imports or evaluates** any prototype file, including `planning.py` and `assets/app.js`. The importer package has no `child_process`, no `vm` and no dynamic `import()` of input paths, and a test checks it.
- It lives in `packages/importer-planning`. Every parser takes text or bytes and returns a typed result and a list of problems (3.15.4). None throws, reads a clock or does I/O. The input copy (`input-copy.ts`) is the only file I/O. The importer and `testkit` import nothing from each other (3.15.8 Tests).
- It reads a **copy**. A run first copies the inputs (the ledgers, the three `data/` files, `tasks-export.json` for a return import, and every `events/*.json` and `events/*.ready`) into `<space>/exchange/planning/<run-id>/input/`. Code, agent files, `context/`, `reviews/` and `snapshots/` stay in the frozen folder (3.15.7).
- **The copy** is the source's state at one instant, or the run stops with `source-changed`. `verifySource` repeats the source check at later points of a run and fails closed (`[A7.3.15.importer.input-copy]`). Residual limits: a change undone between the copy read and the re-hash is not seen, and a path swapped for a link between listing and opening is followed for that read (on Windows for a file or its folder, on POSIX for a replaced `data/` or `events/` folder). Closing that window needs descriptor-relative opens, which Node does not offer.
- Counts are taken from the copy at run time, never from earlier reports.
- All imported text passes the same write-time sanitiser as agent text (A3 3.10). The report counts what it changed.
- It runs in the service as user-only entries (`import.planning.preview`, `.apply`, `.undo`), which the CLI and the UI call. Only the user principal applies it, from the UI or an interactive CLI, never through an agent tool. The `import` origin confers no privileged actor.
- The prototype stays read-only for TT Tasks, and the source of truth until the M7 switch-over. TT Tasks reads the prototype folder only to copy it.

#### 3.15.2 Grammar

The prototype's rules, read from `planning.py` and the page's event handling. The importer's parsers implement them (`ledger.ts`, `events.ts`, `metadata.ts`, `optional.ts`, `fallback-id.ts`; tests [A7.3.15.importer.grammar], [A7.3.15.importer.fallback-id], [A7.3.15.importer.total], [A7.3.15.importer.fixture]). This section stays the source for the export (3.15.8) and for the independent test parser, which must not be written from the importer's code.

- **Text.** Input is UTF-8. A byte order mark stays in the text, because `planning.py` reads with the platform's UTF-8, not `utf-8-sig`, so a first line that starts with U+FEFF before `## A` is no heading. `\s` and `strip()` use Python's whitespace: JavaScript's set plus U+001C to U+001F and U+0085, minus U+FEFF.
- **Lines.** The ledger is split as Python's `str.splitlines()` splits: at LF, CR, CRLF, U+000B, U+000C, U+001C, U+001D, U+001E, U+0085, U+2028 and U+2029. Each piece is matched on its own, and lines are numbered in that split. So U+2028 inside a title leaves no task line, and inside a body it cuts the body and its marker off.
- **Groups.** A line starting `## ` sets the group to the rest of the line, trimmed. The group before any heading is `Other`.
- **Task line.** `^- \[([ xX])\] \*\*(.+?)\*\*\s*(.*)$`. The title is the bold text with every trailing dot stripped. Every task line in `DONE.md` is done whatever its checkbox says. In `TODO.md`, `x` or `X` means done.
- **Marker.** `<!-- task:<id> -->` with `<id>` matching `[a-z0-9_-]+`. The first marker anywhere in the line, the title included, gives the ID. The body is the rest of the line after the title with every marker removed, then trimmed.
- **Fallback ID.** Without a marker, the ID is `t-` plus eight lower-case hexadecimal digits of 32-bit FNV-1a (offset basis 2166136261, prime 16777619, modulo 2^32) over the Unicode code points of `<group>|<title>`, the title without its trailing dots. Each whole code point is XORed in, then multiplied: not UTF-16 units, not UTF-8 bytes.
- **Duplicate IDs** across `TODO.md` and `DONE.md` are an error, as in the prototype's build. The importer reports each later line and still returns every task line. M7.04 decides what an error blocks.
- **Clauses.** Body conventions: a current state, `Next: …`, `Refs: …`, `(added YYYY-MM-DD, <agent>)`. `DONE.md` lines add `(done YYYY-MM-DD; <evidence>)` before the marker. The body keeps every clause verbatim (3.15.3), and the importer also parses them:
  - A task carries the first `(added …)` clause in its body.
  - A `(done …)` clause counts only when it closes the body, which is where reconcile writes it. A clause quoted inside the evidence stays evidence. Evidence with an unbalanced `(`, such as `see (draft`, gives no completion, which M7.03 treats like a line without the clause.
  - The `Next:` clause runs up to the first dot before whitespace or the end, or up to an `(added` or `(done` clause.
  - A clause whose day is no calendar date keeps its agent or evidence and drops the day, with a warning.
- **Events.** Every `events/*.json` is read in sorted file-name order, by code point, as Python sorts. A file whose name starts with `web-` counts only if `events/<same stem>.ready` exists. Any other file counts as soon as it exists. An event is `{id, task, action, at}`:
  - `action` is `check`, `uncheck`, `focus` or `unfocus`. `id` has 1 to 100 characters from `[a-zA-Z0-9_-]`. `task` is any ID of `[a-zA-Z0-9_-]+`, since a ledger marker has no length bound. Extra keys are allowed.
  - `at` is an RFC 3339 time with a zone. It may leave out the seconds and may carry a fraction of up to nine digits. It must be a real calendar time, as Python's `fromisoformat` checks. Instants keep microseconds and cut further digits, as Python's `datetime` does.
  - Counted events apply in order of the instant of `at`, then `id` as text, as `planning.py` orders them (the page orders by `Date.parse` milliseconds, then `localeCompare`). The last `check` or `uncheck` per task wins, and the last `focus` or `unfocus` sets the star. Duplicate event IDs give a warning and both apply.
  - The page writes `events/web-<lower-case UUID>.json` and then the `.ready` file. The prototype's import command writes `<id>.json` as two-space JSON with a final newline, and a `.ready` file only for a `web-` ID.
  - An invalid event file fails the prototype's read of the whole folder. The importer leaves the file out with an error instead, so the report can name every bad file at once. A `web-` file without its `.ready` is not validated, because it may be half written.
  - The page also folds the events in its own browser storage, keyed by the page's folder path, and writes any it does not find on disk into `events/` when the folder is connected. The rebuilt page embeds the events it was built with.
- **reconcile.** The prototype's `reconcile` moves every checked task from `TODO.md` to `DONE.md`. Its DONE line is the TODO line with its marker removed, `- [ ]` turned into `- [x]`, right-trimmed, then ` (done YYYY-MM-DD; <evidence>) <!-- task:<id> -->`. New lines go after the first line of `DONE.md`, separated by blank lines, so they sit in group `Other`. A reconciled unmarked line carries its old fallback ID as the marker.
- **Metadata.** `data/metadata.json` is one object keyed by task ID (missing: `{}`), with `category`, `project`, `status` (`open`, `waiting`, `needs_review`, `delegated`, `backlog`), `owner`, `priority` (`P1`–`P3`), optional `rank`, `next`, `evidence`, `source_date`, `reviewed`, `confidence` (free text), optional `due`, `sources` (`label`, `url`) and `paths` (absolute). The importer drops a value of the wrong type, an unknown status or a priority outside `P1` to `P3` with a warning, so M7.03 applies the prototype's defaults. A JSON number `confidence` is dropped too, because `JSON.parse` has already rounded it, and a boolean is kept as its JSON text. A source needs a non-empty `url`. A path that is not absolute is kept and reported, so `paths[0]` stays the first path. Dates are `YYYY-MM-DD` calendar dates only. Unknown keys go to `extra` with their JSON values, which M7.03 maps to `ext.planning.<key>`.
- **Optional files.** `data/jira.json` is a list of ticket rows (missing: `[]`). `key` and `url` (`/browse/<KEY>`) are read, and a row's `summary` is its ticket title until a real file shows otherwise (the page reads only `key` and `url`). A row without a non-empty `key` is skipped and reported. `data/audit.json` is one free-form object (missing: `{}`) with a scalar `reviewed` time and nested objects or lists that the page only displays. A missing `TODO.md` or `DONE.md` is an error. A missing metadata, jira or audit file is the prototype's default with no problem.
- **Bounds.** Every input is bounded (`LIMITS` in `limits.ts`, [A7.3.15.importer.bounds]), each bound with its own problem code, and a count bound counts every item examined, kept or left out.

#### 3.15.3 Mapping to the space model (A1)

| Prototype | TT Tasks | Rule |
|---|---|---|
| ID marker | New `t_` ID and `M-n` reference. Alias `(planning, <id>)` | `tasks show <legacy-id>` resolves it (A1 3.3 order) |
| No marker | The fallback ID, computed as the prototype does | Imported with a warning: this ID changes if the title changes |
| Title | `title` | Over 300 characters: cut at a word boundary, the full text kept at the top of `context`, reported |
| `## Group` | Area, only when metadata has no category | |
| Body without the marker | `context`, verbatim | `Next:`, `Refs:` and `(added …)` stay in the text |
| `(added YYYY-MM-DD, <agent>)` | `created_at` on that day at 09:00 local. `ext.planning.added_by` | `created_by` is the user who applied the import. Without the clause, `created_at` is the import time |
| `category` | Area: slug from the text, title as written, order of first appearance in `TODO.md` | |
| `project` | Project in that area | The slug ignores a trailing `(…)`. The full text stays the title |
| `status` `open`, `waiting`, `backlog` | The same status | |
| `status: needs_review` | `review` | |
| `status: delegated` | `waiting`, with `waiting_on` set to the owner and `ext.planning.status = "delegated"` | Keeps the distinction for a later status split (A1 3.17) |
| No status | `waiting` when the title starts "Waiting on ", else `open` | The prototype's default |
| `owner` | The user (given with `--me`): no owner. Another person: `waiting_on` for waiting or delegated tasks, else `owner` | The report lists every distinct owner |
| `priority` `P1`–`P3` | `priority` 1–3 | No `priority`: 3, because the prototype page shows a missing priority as P3. The space's default 4 means no priority (A1) |
| `rank` | `ext.planning.rank`. Position within the project by rank, then by file order | Tasks without a rank sort after ranked ones |
| `next` | `summary`, one line | No `next`: the `Next:` clause of the body, else empty |
| `evidence` | One log entry of kind `evidence`, dated `source_date` | Verbatim |
| `source_date`, `reviewed` | `source_at`, `reviewed_at`, that day at 09:00 local | Invalid dates are dropped and reported |
| `confidence` | `ext.planning.confidence` | Kept as written |
| `due` | `due_date` | Invalid dates are dropped and reported. No due date is ever invented |
| `sources` | `sources` rows, linked with role `origin` | Kind from the URL: mail → `email`, chat → `chat`, `/browse/<KEY>-<n>` → `ticket` with `ref`, documents and drive → `doc`, calendar → `calendar`, code hosts → `pr` or `issue`, else `web`. The title is the label, unless the label only names the kind ("Email", "Chat"). Then the title is a short form of the URL, flagged "generic" so a later Refresh can improve it |
| Source keys | Jira: `jira:<KEY>` from the URL. Others: `url:<normalised URL>` (A3 3.11.1) | `gmail:` and `gchat:` keys are derived only after the rehearsal shows that the URL token equals the connector's thread ID (risk D11) |
| Shared sources | One `sources` row per key, linked to every task that names it | Every create uses `dedupe: none`, so a shared key never merges two legacy tasks or attaches one to an existing task. The report lists shared keys under needs attention. Refresh keeps A1's source-key dedupe |
| `paths[0]` | A place `(machine, root, relative path)` | Longest matching root from `--roots` or the proposed roots. A path under no root is reported, and no place is created |
| `paths[1…]` | `ext.planning.paths` | Reported. A5 shows one folder per task |
| `[x]` in `TODO.md`, or a folded `check` | `lifecycle = completed`, `wrap_state = pending`, `completed_by` the user, `completed_at` the event time or the import time | D12: the user's check-off completes. `--checked-as review` keeps such tasks active in Review instead |
| Folded `focus` | `focus_on` = the event's day | The parser gives `day` as the event's own time writes it. M7.03 chooses between that date and the import machine's local day. `unfocus` clears it |
| Line in `DONE.md` with `(done YYYY-MM-DD; <evidence>)` | Completed on that day. `outcome` = the evidence. `wrap_state = wrapped` | |
| Line in `DONE.md` without it | Completed at the import time with `ext.planning.done_date_unknown`. `wrap_state = pending` | A later Wrap-up can add an outcome and learnings |
| Every imported task | `ext.planning = {legacy_id, file, line, imported_at}` and one log entry "Imported from the Planning prototype" | No changed marker in the UI |
| Unknown metadata keys | `ext.planning.<key>`, from the parser's `extra` | Never collide with the space's fields |

#### 3.15.4 Dry run and preview

```
tasks import planning <folder> --space <space> --dry-run
      [--me "<name>"] [--roots work=/home/mira/work,oss=/home/mira/oss]
      [--actions <prototype-export.json>] [--checked-as completed|review]
      [--include-orphans] [--json]
tasks import planning --apply <run-id> --token <preview-token>
tasks import planning --undo <run-id>
```

A dry run copies the inputs, parses the copy, builds the operation plan, writes `report.md` and `report.json` beside the input copy, prints a summary, and returns a preview token: a hash of the plan, the input hashes and the current `seq` of the affected tasks. Without `--roots` it proposes roots from the common folders of the paths, and the user names them.

**Problems** (`problems.ts`) are codes from one fixed table with a severity and places that can never carry input text, so reports and logs hold no task text. A bad value is dropped with a warning, so one dry run lists every problem.

The report has these sections:
1. **Counts and reconciliation:** task lines in TODO and DONE, metadata entries, tasks to create (active and completed), aliases, areas, projects, sources by kind, places by root. One line states whether active plus completed equals the task lines. Two lines count metadata entries without a task line and task lines without metadata.
2. **Status mapping:** count per prototype status and its status in the space.
3. **Roots:** proposed names and folders, places resolved, paths missing on this machine.
4. **Needs attention:** fallback IDs, checked items, completions without a date, invalid dates, paths outside every root, orphans, lines without metadata, generic source titles, shared source keys, long titles, sanitised text, owners, and every warning.
5. **Per task:** legacy ID, new reference, area and project, status, place, due date, focus.
6. **Not imported**, with reasons (3.15.7).

The report stays inside the space on its machine. The UI's import card (first-run step 6, Settings › Data) shows the summary, the needs-attention list and Apply.

#### 3.15.5 Apply and undo

- A verified backup completes before the applying transaction starts, under a writer barrier that fixes the protected snapshot. If the backup fails, the apply stops (A1 3.14, 3.18).
- The source is verified again (`verifySource`), and the plan is recomputed. If it differs from the preview, apply stops and asks for a new preview (A1 3.14 rule).
- Everything commits as **one** commit with origin `import`, the user as the principal, the `import` actor as author and a request ID derived from the run ID and the token, so applying twice applies once. A1 3.21 allows import commits above 50 operations.
- Every `task.create` in the commit uses `dedupe: none`, because each legacy ID is its own task. A source whose key already exists is linked, never duplicated (A1 3.6).
- The commit writes one `exchanges` row (its folder is the input copy) and one `exchange_items` row per task, whose `base` holds the values this import wrote.
- `--undo <run-id>` reverts that commit with A1's revert guard. Tasks changed since then stay as they are and are listed.

#### 3.15.6 Idempotent re-import

- Tasks match by alias `(planning, <legacy id>)`. When the input folder holds a `tasks-export.json` that names an export exchange of this space (3.15.8), markers match through that exchange's items first, which covers tasks created in TT Tasks.
- Each logical field compares the new prototype value E, the base value B and the current value C, using A1 3.14's table. B is the value the exchange recorded: the last import's `exchange_items.base`, or the export exchange's base for a return from rollback. E equals B: nothing. E differs from B and C is unchanged since that exchange: apply E. Otherwise: a proposal with origin `import_conflict`.
- Check-off and star state is E folded from every counted event (3.15.2), compared with the lifecycle and `focus_on` in B.
- A new legacy ID is created with `dedupe: none`. A legacy ID missing from the new input deletes nothing and is reported as "gone from the prototype".
- A task that moved to `DONE.md` is completed if its lifecycle field is unchanged since that exchange, else it becomes a proposal.
- After a return import, each exported task created in TT Tasks gains the alias `(planning, <marker>)`, so later imports match it without the export record. The export exchange becomes `applied`.
- The same input twice gives zero operations and the status `unchanged`.

Re-import keeps the work space current from the real-use point until the switch-over (3.6), re-imports the rehearsal's inputs after fixes, and brings back prototype changes made during a rollback (3.16.4). It never loses an edit made in TT Tasks: a field changed on both sides becomes a proposal.

#### 3.15.7 What is not imported

| What | Why | Where it goes |
|---|---|---|
| `planning.py`, `assets/`, `index.html`, `tests/` | Code | Stays in the frozen folder. Never executed |
| The prototype's `AGENTS.md`, `CLAUDE.md` and agent skill folders | Agent rules | The user moves the rules that still matter into the Refresh source list and the managed instruction source by hand (D15) |
| `snapshots/` | Old ledger copies | Frozen folder |
| `data/jira.json` | A ticket inventory, not tasks | Its ticket titles fill the titles of matching ticket sources. The file is copied into the run folder |
| `data/audit.json` | Review times and coverage | Copied. The last complete review time is offered as the Refresh watermark |
| `context/`, `reviews/` | Background notes and refresh reports | Frozen folder. The user can attach a file to a task later |
| `web-*` events without `.ready` | Unfinished browser writes | Ignored and reported, as the prototype does |
| Browser-only check-offs and stars | Held in the prototype page's browser storage, keyed by the page's folder path | Exported from the page before the freeze and passed with `--actions` |
| Raw events | Folded into state | Copied into the run folder |
| Metadata entries without a task line | No task text | Reported. `--include-orphans` creates them in Backlog |

#### 3.15.8 Export to the prototype format

```
tasks export planning --space <space> --out <new-folder>
      [--hold] [--rollback-from <frozen-folder>]
```

The export reads one snapshot at `seq` S and writes into a new folder, never into the frozen one. It is a service entry, so the service stays up while writes are held.

**Files.** The prototype's state lives in the ledgers, the metadata and `events/` together, so the export writes all of them.
- `TODO.md`: active tasks, and completed tasks whose wrap-up is pending, as `- [ ]` lines under `## <area>` headings. A completed task stays here with a `check` event, because in the prototype a check-off waits in TODO until `reconcile` moves it.
- `DONE.md`: wrapped tasks with `(done YYYY-MM-DD; <outcome>)` before the marker, and archived tasks with `(done YYYY-MM-DD; archived: <reason>)`. Deleted tasks are not exported and are listed in the report by reference.
- `data/metadata.json`: summary becomes `next`, the latest evidence or progress entry becomes `evidence`, area and project become category and project. Statuses map back: `review` to `needs_review`, `waiting` with `ext.planning.status = "delegated"` to `delegated`. Places become absolute paths on this machine.
- `events/`: the canonical current event set. One `check` event per completed task in `TODO.md` and one `focus` event per starred task, timed at the change (`completed_at`, the time the star was set), never after S. Event IDs are `tasks-<export>-<n>`, never `web-`, so they need no `.ready` marker. Each file is written under a temporary name that does not end in `.json`, flushed and renamed. Browser writes made later in the copy keep the prototype's `.ready` rule.
- Legacy IDs become the markers again. Tasks created in TT Tasks use their lower-case reference (`m-142`) as the marker.
- `tasks-export.json`: the space ID, the export exchange ID and S, so a return import finds its base. The prototype does not read this file.
- `export-report.md`: anything the format cannot hold (notes, older log entries, sessions, runs, learnings, proposals), listed per task, plus S.

**The export exchange.** The export is a durable A1 exchange (A1 3.14, prototype exports): one `exchange.create` commit with an `exchanges` row (`base_seq` = S) and one `exchange_items` row per exported task, whose `file` holds the marker and whose `base` holds the exported value of each logical field. This is the marker → task ID map, including tasks created in TT Tasks. The commit changes no task. Each export, including the daily one during the trial, records its exchange. `tasks exchange clean` removes old open ones.

**`--hold`.** The same commit also holds the space through A1's user-only `space.hold` (A1 3.6): writes return `SPACE_READ_ONLY` with the reason `held`. While held, every write is refused except `tasks space release`. Reads, search, backups and exports go on. Nothing can change after S. `tasks space hold` and `tasks space release` also work alone.

**`--rollback-from <frozen-folder>`.** The new folder becomes a writable prototype copy. It takes every file of the frozen folder except `TODO.md`, `DONE.md`, `data/metadata.json`, `events/` and `index.html`, which come from the export or are rebuilt. The frozen events are quarantined: they stay in the frozen folder and are not copied, because they would otherwise fold over the exported state. The old `index.html` is left out because it embeds the frozen events. Files are copied only, and prototype code never runs.

**Tests.** A small independent parser in `testkit`, written from 3.15.2 and sharing no code with the importer, folds a prototype folder the way the page and `reconcile` would. On synthetic cases it checks the rollback copy against the space's state at S. The tests never execute prototype code.
- A task checked in the prototype and reopened in the space stays open.
- An uncheck, a focus and an unfocus made in the space hold.
- A task created in the space appears.
- A frozen `web-` event without `.ready` changes nothing.
- A simulated `reconcile` moves exactly the completed tasks awaiting wrap-up.

### 3.16 The retirement gate

#### 3.16.1 Parity

Parity means the first user can do every daily thing done with the prototype, in TT Tasks, on the Linux reference machine.

| Prototype | TT Tasks v1 | Checked by |
|---|---|---|
| A morning page: due soon, focus, suggested next | Today (A5 3.4) | The first user confirms by trial day 5 that Today replaces the morning page |
| Views: all open, waiting and delegated, needs review, checked off, completed | Open, Waiting, Review, Backlog, Completed, Agents and area views | Daily use |
| A Jira view built from `jira.json` | No separate view. Ticket sources on tasks and the search filter `source:ticket` (A3 3.9.2) | An explicit exception the owner accepts |
| Grouping by category, then project | Area, then project | Import report |
| Row icons open the email, chat, ticket and folder | Source icons and the folder button | Five random tasks a day |
| `/` search over titles, next steps, evidence, people, paths and links | Top-bar search (FTS5) | Finds a completed task by a word in its evidence |
| Check-off, archived later by an agent | Check-off completes at once, with undo. Wrap-up on request | Daily use |
| A star for focus | Star | Daily use |
| Refresh from mail, sent mail, chat and the issue tracker on request | Refresh through Codex | Daily |
| Agents in any project update the ledger | The product's tools and server instructions in every agent app | Sessions log through the tools |
| Bookmarkable views | A URL per view and task | Once |
| No unattended sending or ticket changes | A read-only Refresh template, nothing scheduled | Run review |
| No account, no network | Local service | Built in |

Beyond parity, TT Tasks adds what the prototype lacks: Open in agent apps, notes, field edits, undo and history.

#### 3.16.2 Rehearsal and cutover

**Rehearsal, before day 0 (M7.09).**
1. Update the daily install on the Linux reference machine, in use since the real-use point (3.6), to the release candidate. `tasks doctor` and `tasks doctor --live` are green.
2. Make a dated archive of the prototype folder inside the user's home folder.
3. Dry run against a frozen copy. The first user resolves the needs-attention list and names the roots.
4. Apply into a trial space. Open five tasks with places in each native target, and one task without a place. Run Refresh twice and count duplicates of imported tasks. Run Wrap-up on two completed tasks.
5. Rehearse the rollback on the trial space (3.16.4) against the dated archive, never the live prototype folder: export with `--hold --rollback-from` into a new folder, rebuild its page, check off one task and star another in the copy, release, return-import, and confirm the same task IDs, no duplicates and the expected conflicts.
6. Fix the findings and repeat until the rehearsal is clean. The trial space and the rehearsal copy are archived afterwards.

**Cutover, day 0.**
1. In the prototype page, connect the folder or export, so no browser-only check-offs or stars remain.
2. Freeze the prototype: make its folder read-only and archive a copy.
3. Dry run on the frozen folder, review, then re-import it into the work space from the real-use point (3.15.6). From here TT Tasks, not the prototype, is the source of truth.
4. Reconcile: counts and ID sets match the report. Three random legacy IDs resolve. Five folder buttons open the right folders.
5. `tasks setup agents` for the machine's default Codex home and Claude Code, each granted the work space. The first user adds a second Codex home if needed. T3 needs nothing.
6. The first user replaces the prototype's global agent rule in the managed instruction source with the product's overlay, or removes it. The server instructions suffice (D15).
7. Save the Refresh source list, approve the routine and run it once.
8. Run the first daily export to the prototype format, outside the frozen folder. It uses `--rollback-from`, so each daily export is a complete rollback copy with its own exchange. The last three are kept.
9. Create a task "Switch-over log" and record day 0 there.

**Each trial day (1 to 10).**
- Morning: Refresh, then Today.
- During the day: Open tasks in T3, Claude Code and Codex as work requires.
- Evening: `tasks trial check`, then one pass or fail line per criterion in the switch-over log.

**Day 10:** gate review with the owner. **Day +30:** the daily export stops unless the first user keeps it. The frozen folder stays archived. Deleting it is the first user's separate decision.

#### 3.16.3 Criteria

All must hold at the end of the trial. A criterion that the active scope profile removes (3.18.6) does not apply, and `tasks trial check` prints which profile is active.
1. **Import reconciled.** Counts and ID sets match the frozen snapshot. Every needs-attention item is resolved or accepted. Every legacy ID resolves.
2. **No lost work.** No acknowledged write is lost. `tasks trial check` is green every evening: doctor, `integrity_check`, a verified backup. One restore into a new folder during the trial matches the live space.
3. **Launch.** The first user opened tasks on every trial day, across T3 and at least one CLI. Every receipt shows the exact folder and the intended account. Nothing was retried automatically. No launch opened a wrong folder or account.
4. **Refresh.** It ran unattended, through Codex, on at least eight of the ten days. Repeats created no duplicates. Coverage was reported per source. The watermark advanced on full success.
5. **Agents.** Sessions in Claude Code, Codex and T3 updated tasks through the tools, with no file edits to the space's data.
6. **Daily use.** Today was the morning page, and check-offs and stars happened only in TT Tasks, on every trial day.
7. **Undo and conflicts.** Undo or revert was used on a real agent change and worked. A scripted same-field race on a copy of the space produced a conflict, not an overwrite.
8. **Wrap-up** ran at least once and left every original text intact.
9. **Operations.** The service survived at least one reboot and one `tasks update` with sessions open.
10. **Speed.** Today becomes interactive within 800 ms on Linux. The service stays within A2 3.14 at idle.
11. **Boundaries.** No sudo, no managed policy changed, no work data left the Linux reference machine.

**Trial length.** Ten working days. A blocking failure pauses the trial. After its fix, at least five consecutive clean working days must follow before the gate review. Other defects are filed and fixed without pausing.

**Blocking failures:**
- an acknowledged write lost or corrupted
- a launch in a wrong folder or account
- the service unavailable for more than an hour of working time
- Refresh failing on two consecutive days
- the default Open target failing for a whole day

#### 3.16.4 Rollback

**Triggers:** data loss that undo or restore cannot repair, a blocking failure without a fix within two working days, or the first user deciding the overview is worse than before.

**Steps.** The service stays up throughout, because the export is a service entry.
1. Quiesce: end open agent sessions and runs, and run `tasks setup agents --remove` for the agent homes registered at cutover.
2. `tasks export planning --space <work> --hold --rollback-from <frozen-folder> --out <new-folder>` (3.15.8). One commit records the export exchange and holds the space, so nothing changes in it after the export. The new folder is the frozen folder with the exported ledgers, metadata and canonical events, without the frozen events and the old page.
3. The first user rebuilds the copy's page with the prototype's own tool, opens it from the new folder, connects the folder, and checks five tasks: state, check-off and star. The new path matters. Opened from a file, the page keys its stored events and folder handle by its folder path, so a new path starts clean. At the frozen folder's path, the browser's events from before the freeze would be folded in again and written back into `events/`.
4. Restore the prototype's agent rule in the managed source, pointing at the new folder.
5. Leave the space held and untouched for diagnosis. File the cause without task content.
6. Return after the fix: repeat cutover steps 1 and 2 on the rollback copy (no browser-only events left, then freeze it), run `tasks space release`, then re-import (3.15.6) from it. The export exchange is the base, so tasks created in TT Tasks keep their IDs and only fields changed on both sides conflict. The trial starts again at day 1.

**If the service cannot run at step 2,** the newest daily export is the rollback copy as it stands: it has the same layout and its exchange was recorded when it was made. Work done in the space after it stays there, and the return import treats it as changes on the space's side. When the service runs again during the rollback, `tasks space hold` comes first.

The rollback loses only what the prototype format cannot hold. The export report lists it, and it stays in the space.

### 3.17 After v1

| Milestone | Adds | Foundation hooks already in v1 | Scope |
|---|---|---|---|
| **M8** Task-list essentials | Recurring tasks with the RRULE subset that the scheduler shares (A4 3.13.1). Reminders: the service evaluates due times, notifies through the installed web app, and applies a missed-while-asleep rule. Quick capture outside the app: a PWA shortcut, `tasks add` with natural-language dates, an optional OS hotkey. Natural-language dates everywhere. Explicit file import (A1 3.14), applied only by a human. Anything cut from v1, with the manifest entries its scope profile moved here | `due_at` and `due_tz`, `planned_for`, `parent_id` reserved, the preferences registry and flags, the outbox, the capture parser, the `exchanges` tables | about 15 steps, plus cut items |
| **M9** Scheduled routines | `routines.scheduling` turned on, the scheduler of A4 3.13.2 with persistent occurrence states, a durable `eligible_at`, and the final decision, queued run and next cursor committed in one transaction, the schedule UI in Settings › Routines, quiet hours, the catch-up rule. A4's scheduler tests move here. The owner decides about scheduled Refresh for work spaces (A4 open item 8) | The `schedule` field, approval hashes, caps and leases, M8's RRULE parser | about 6 steps |
| **M10** Public release gate (A6 3.14) | **An authenticated UI origin (R18), without which M10 cannot pass**: for example a per-user HTTPS certificate trusted in the user's browser profiles, or a desktop shell with its own authenticated channel. The gate includes the two-user port-squatting test, run only in CI on throwaway runners: stop the service, serve a page from a second user that the test creates on its port, reload, and fail to recover or use the old credential. Also the hosted public update channel with signed channel manifests and release-environment signing, Authenticode through SignPath, SBOM and provenance, the managed policy reader, `tasks security check`, macOS community builds, docs. The public contact in package metadata and `SECURITY.md` is set in this pass | Version folders, manifests with hashes, Ed25519-signed releases and the bootstrap's `ssh-keygen -Y verify` check, `tasks doctor`, the policy keys, the multi-user warning | about 16 steps, plus external steps outside the repo |
| **M11+** Phases L1 to L5 (A6) | Linked machines, phone PWA, open protocol and self-hosted relay, hosted service, teams. Each starts with its own lab like M0. L1 adds the machine-local execution journal behind the `ExecutionStore`, with A6's journal crash tests, and starts using `remote_allowed` and `root_rev` | A6 3.3: machine keys, epochs and incarnations, the filtered `(epoch, seq)` feed with coverage intervals, applicable operations, grants, registry `remote` flags, presence fields, the `ExecutionStore` contract suite | estimated at each phase's start |
| **Desktop shell** (optional, at or after M10) | Electron or Tauri as a pure client of the same HTTP and WebSocket API and fragment-code bootstrap. Never `--no-sandbox` by default (A5 4). One way to meet M10's authenticated-origin gate | Browser-first UI, PWA manifest, `tasks open` | estimated when chosen |

**The T3 run adapter** comes in M8 or later. It first needs durable launch correlation, reconciliation before declaring a failure, a deadline owner independent of the hub, and a reservation kept while a start is uncertain. Its own lab rows cover a lost first reply and the service down past a deadline.

Smaller items after v1, in no fixed order: pre-trust offers (A4 3.14), a UI for custom routines, a separate Ask verb (A5 open item 4), a Stop reminder hook (A3 open items), restrictions on agent homes (A3 open items), payload compaction (A1-18), attachments in the UI, importers from other task apps, saved views, slimmer agent-facing tool shapes.

### 3.18 Test strategy

#### 3.18.1 Kinds of tests

| Kind | What it proves | Lives in | Runs |
|---|---|---|---|
| Unit | Pure logic, registry examples, golden argv and URLs | `*.test.ts` beside the code | Every PR |
| Property (fast-check) | Field versions and no lost update. Undo, redo and revert guards, including change-away-and-back. Session revert. The import three-way merge, re-import and the return from rollback. Idempotent receipts for every outcome: same ID replays, a different intent is refused, across restarts, epoch and incarnation changes. Source-key upsert. Search cursors. Launch and run state machines. Live-store ordering over filtered batches. Sanitiser idempotence. Digest caps | `*.prop.test.ts` | 200 runs per PR. 20,000 runs nightly, plus a fixed seed corpus |
| Model-based | The store against a plain TypeScript reference model with 3–12 actors (A1 5) | `packages/storage/test/model/` | Short per PR, long nightly |
| Integration | Real temporary SQLite databases, sockets and pipes, a real service process | `tests/` and package `test/` folders | Every PR, both OSes |
| Crash injection | Real processes killed at fault points and at random during a workload, then recovery invariants (A1 5, A2 5, A3 5, A4 5.2) | `tests/crash/`, `pnpm crash` | A slice in verify, 5 minutes per PR, 30 minutes per OS nightly |
| Forwarder conformance | Any forwarder binary against the bridge contract (A2 3.7.6) | `tests/forwarder/` | Every PR |
| Real agent CLIs | Headless Claude Code and Codex on temporary spaces: A3's evals, the real-run contract, the run adapters' stream formats, setup commands | `tests/evals/`, `pnpm evals` | By hand on Windows at M4 (M4.08), M6 (M6.14), before releases and after major agent updates |
| Prototype format | The rollback copy and the importer against an independent parser of the prototype's rules (3.15.8). Never prototype code | `packages/importer-planning/` tests | Every PR touching the importer |
| Real-machine qualification | `tasks doctor --live` routes and receipts per target | Windows and Linux | Each release, and after agent app updates |
| UI end to end | Playwright with Firefox and Chromium against a real service and a seeded space, fakes for agents | `tests/e2e/` | PRs touching `web`, `service`, `launch` or `runs` |
| Screenshots | Every screen in Sumi and Washi at 1,440, 1,280 and 390 px | `tests/e2e/screens/` | Diffs attached to PRs |
| Accessibility | axe on every screen, keyboard-only flows, NVDA and Orca by hand | `tests/e2e/` | axe per PR, manual at M5 and before releases |
| Security | HTTP checks, DNS rebinding, the XSS suite, injection fixtures, zip hardening, the export secret scan, root refusal, the burst brake, pre-authentication bytes, token expiry (7 days unused, 30 days old), no service worker, a port held by another account giving no UI and revoked tokens while the socket keeps working, the doctor's other-accounts warning (A6 5). The two-user port-squatting test joins at M10 | integration and e2e | Every PR |
| Performance | The budgets in 3.18.3 | `tests/perf/`, `pnpm bench` | Relative nightly, absolute at milestone close on the real machines |

**Conventions** that `pnpm verify` does not check:
- A test that makes a state or config folder or a `machine.toml` gives it the product's mode (0700, 0600) explicitly: under umask 002 a default-mode folder is group-writable, and the service refuses it. A new product path that creates files joins `[A2.3.2.2.permissions.umask]`. The Linux reference machine runs the suite under its own umask, never one set for the run, because that is where a mode the product does not set shows.
- A test starts storage workers only through the hub, as the service does. A plain `StorageWorker` handed to the hub crashed the Windows test process (heap corruption) in about one run in five, cause unknown.
- The end-to-end tests of one Playwright worker share one world. A test that changes a task's launch state uses its own task.
- Tests own their processes. Every child, detached agent and extra service a test starts is terminated and awaited in `finally` and in `afterAll`, before any files are deleted. Tests of environment handling or redaction run children with an explicit minimal environment.
- A test of "a timer exists, is cleared or fires" observes the connection's own timers through the injected clock (`packages/service/test/clock.ts`), never wall-clock bounds or process-wide timer counts. Each behaviour keeps one test with real sockets and real time. "No timer keeps the process alive" is shown by a child process that must exit on its own.

**The Mira sample** (`packages/testkit/src/mira.ts`) is built through the real write path, so a sample space is a real space. Record kinds without an operation yet go in through a narrowed `StandIn`. The known sample's digest (`FIXED_SAMPLE` in `known.ts`) changes whenever the schema or the generator changes, and is updated in the same commit.

**Fake agents** (`@tasks/runs/fake-agents`) replay a recorded stream from `fixtures/streams/` byte for byte and report argv, cwd, variable names and the brief's size and hash, never its text. Still to come:
- M6.04 adds a fake that starts a grandchild.
- A later testkit step moves `fake-agent*.ts` and `fixtures.ts` into `packages/testkit` beside the launch fakes of `src/fakes/`, and adds A4 5.1's argv and environment checks. No test starts a real terminal, agent or `systemd-run`.
- The Linux `claude -p` and full-access Codex streams join `fixtures/streams/` after lab session 2, and the parser tests must pass on them.

**The crash harness** (`tests/crash/`, `pnpm crash`) kills a real child process at storage's crash seams and at random during a workload, then checks the recovery invariants. A kill is a real kill of a real process, because mocking SQLite or the file system, or a self-kill, would test a different code path. The seams are set only by a worker entry module, never by a request, setting or environment variable of the product. A run is replayable from its seed and prints names, codes and numbers only. Tests `A1.5.crash.*`. **Still to add:**
- Killing the real service process over the local protocol instead of `child.ts`.
- The maintenance worker's daily backup, retention and cleanup in the workload, with kills during retention.
- `tasks space recover` with an outside rollback-mode writer that dies, and recovery under `RecoverSeams.at`, checked by `old-folder-kept`.
- The CLI's `--request-id` retry among the retries.
- M3's fault hooks (projection rename, after a redact commit before its cleanup, transfer steps) and the invariant "the projection catches up".
- `history_text` in the value comparison.
- M8's barrier backup before an import.
- `launches` among the history tables, and launch writes in the workload. `sessions` among them once migration step 0003 adds the table.

**Installed-build acceptance.** `pnpm accept m<N> --installed <root or folder>` runs the `installed` entries against a real install root or a built version folder, which `layoutTestInstall` (`packages/testkit/src/install.ts`, a test layout, not an installer) lays out as a test install (`packages/cli/test/accept.test.ts`, `[A4.5.shim.installed]`).

#### 3.18.2 Screenshot review against the mockup

The first baselines come from the Mira sample space. In M5.13 they are compared side by side with `A5-mockup.html` at the same width and theme, approved and offered for the owner's review. From then on, a PR that changes a baseline attaches before and after images, and the change is checked before the merge. A diff above 0.1 % of pixels without an approved baseline fails CI. Agents open their own screenshots before handing back, because a passing test does not show clutter.

#### 3.18.3 Performance budgets

| Budget | Target | From |
|---|---|---|
| Today interactive with 5,000 open tasks | ≤ 800 ms on Linux in Firefox | A5 3.25 |
| View switch | ≤ 100 ms | A5 3.25 |
| Check-off, star, priority, input to paint | ≤ 50 ms p95 | A5 3.25 |
| Burst of 100 events | ≤ 16 ms of main-thread work per frame | A5 3.25 |
| Open-set snapshot | ≤ 300 KB compressed | A5 3.25 |
| Commit latency, one-task patch | p95 ≤ 10 ms on Windows, ≤ 25 ms on Linux | A1 3.20 |
| Raw FTS query inside the service, at the design scale (5,000 open, 50,000 completed) | p95 < 50 ms on Windows, < 100 ms on Linux. Unmet for broad queries until M3.16 | A1 3.20 |
| `search` tool call end to end, on the stress corpus (10,000 open, 100,000 completed) | p95 < 150 ms on Windows, < 300 ms on Linux | A3 |
| `get_task` tool call | p95 < 50 ms | A3 |
| Service at idle | RSS ≤ 120 MB, ≤ 5 s CPU per hour | A2 3.14 |
| Service start to ready (warm) | ≤ 1 s Linux, ≤ 2 s Windows | A2 3.14 |
| CLI call end to end | p95 ≤ 250 ms Linux, ≤ 400 ms Windows | A2 3.14 |
| Bridge | The thresholds of A2 3.7.7 | A2 |
| Tool definitions | Measured in the generated definitions and reported, not capped | A3 3.2.5 |

CI runners are noisy. CI fails a build when a budget regresses by more than 50 % against the stored baseline of the same runner type (A1 5). Absolute targets are measured on the two real machines at each milestone close. Headless Firefox keeps a 1366x768 window whatever `--window-size` says and reports `performance.now()` in whole milliseconds, so performance tests that run headless in Firefox must account for both.

#### 3.18.4 CI matrix

Built: `check` (`pnpm verify` on Ubuntu, under umask 002, and Windows, then a 5-minute crash run), `build` (a test-signed, reproducible build per platform, with the build part of M2's acceptance on the two Linux runners; Windows runners are elevated and the service refuses to run elevated, so that acceptance runs on a real Windows machine; macOS is build only), `smoke` (the real install script through each verifier path, then M1's acceptance and M3.01's migration drill on Linux), `nightly` (the 30-minute crash run per OS) and `m0-packaging`. Still to add:

| Job | Runners | Trigger | Contents |
|---|---|---|---|
| `smoke` | As now | As `build` | `pnpm accept m<latest> --installed` for the active profile |
| `nightly` | As now | Nightly on main | Long property and model runs, the scale bench, relative performance, the fallback-driver suite |
| `e2e` | ubuntu-24.04 with Firefox and Chromium, windows-2025 with Chromium and Firefox | Pull requests touching `web`, `service`, `launch`, `runs` | `pnpm e2e`: flows, later screenshots, axe and the security suites |
| `release` | Manual | Tags | Archives, `SHA256SUMS`, SBOM. A version number is never built twice. In v1 the owner signs `SHA256SUMS`, outside CI, with the Ed25519 release key. Its public line replaces the placeholder in `RELEASE_PUBLIC_KEYS` in a reviewed commit. Signing in a release environment, signed channel manifests and Authenticode come with the hosted channel at M10 |

The workflows in `.github/workflows/` carry the details and their reasons. Rules that bind every job:
- `check` has no path filters: a filter would skip the whole job, so verify's own lab rule could not report what it skipped.
- **Cross-user tests** run only on GitHub-hosted runners, where the test creates and removes its second account itself (`packages/service/test/http-cross-user.test.ts`, Linux, skipped everywhere else). It has not run yet. Not written yet: the Windows runner's cases (B's pipe, B's listener seen without admin rights) and B redeeming a code read from A's process list.
- **When GitHub Actions cannot start jobs,** the same checks run locally on the branch merged into main, on Windows and on Linux, with the pinned pnpm and nothing else changed. A local run cannot replace the tests that need a throwaway runner (a second user, the M10 port test) or the CI-only jobs, so a change to `spikes/m0/packaging` waits for CI. When Actions works again, the check runs on main once.
- Two full test runs never share one machine at the same time. After a batch of merges, the suite runs on main on Windows and Linux. Time limits stay generous for tests that open several spaces, because the Windows runner is slower than a development machine.

#### 3.18.5 How an agent verifies its own work

`AGENTS.md` lists the steps (failing test first, `pnpm verify`, the Verify line's output in the pull request, what was not tested). In addition:
1. UI steps run `pnpm e2e`, and the agent looks at the screenshots in `tests/e2e/results/` (git-ignored). RM steps need the Linux test install.
2. "Not run" is an acceptable answer. A configuration readback is never evidence of a launch.
3. A flaky test is quarantined only with an issue and a recorded reason.
4. **Review by risk.** An independent review checks the step against its sections before the merge. Storage, protocol, security and migration steps get two deep rounds. Every other substantial step (launch, or more than a few hundred lines) gets one round, and a second only when a high-severity finding changed the design. Every finding is fixed or answered.
5. **Merge-ready hand-over.** The review agent ends by merging main into the branch and running both checks on the merged result, Windows first and Linux after it. The pull request merges on that evidence.

#### 3.18.6 The v1 acceptance manifest

Appendix sections 5 describe tests by area, and an area often spans several milestones. `tests/manifest.json` makes the split explicit, so no milestone depends on scope that comes later.

- **Entries.** An entry names its test ID, title, plan source, owning milestone (`M0` to `M99`), kind and scope profiles. Entries arrive with their tests: an entry for a later milestone is added in the step that writes its test, never listed ahead. The check (`scripts/manifest.ts`, `[A7.3.18.6.manifest-check]`) states how a test carries its ID and what fails.
- **Kinds.** `ci` runs on CI from source. `installed` also runs against an installed build (the `build` and `smoke` jobs). `manual` covers real-agent evals, `doctor --live` receipts, M0 rows, NVDA and Orca passes and the owner's reviews. Manual results are recorded per release, apart from the CI and installed-build results.
- **Acceptance.** `pnpm accept m<N>` runs every `ci` and `installed` entry owned by M1 to M<N> in the profile (only the `installed` ones with `--installed`) and lists the open `manual` ones, so it never runs an entry owned by a later milestone. Each definition of done refers to its milestone's entries, never to a whole appendix section.

**Owners where a section spans milestones.**

| Tests | Owner |
|---|---|
| The repository bootstrap, the verify conventions and the M0 lab self-tests | M0 |
| A1 §5: operations, receipts, staged plan, migrations runner, minimal backup set. A3 §5: the CLI retry with `--request-id` | M1 |
| A1 §5: the 0.2 migration and its installed-build drill, undo, revert, lifecycle, redaction, search, dedupe, bundles, claim and transfer, projection, scale | M3 |
| A1 §5: the three-way merge property test | M7 (its first user is the prototype importer) |
| A1 §5: the explicit file import (working copies, preview, apply) | M8 |
| A1 §5: attachment staging and ingestion | After v1, with attachments in the UI |
| A2 §5: framing, handshake and pre-authentication bytes | M1 (transport), M2 (bridge) |
| A2 §5: HTTP checks, the port held by another account | M2 |
| A2 §5: launcher modes, install IDs, install bootstrap and its signature check, the `tasks-launchd` exit mapping with a stub service | M1 |
| A2 §5: update journal, lock, startup repair, launcher crash windows | M6 |
| A2 §5: the LaunchAgent under real launchd | `manual`, when a Mac is available |
| A2 and A6: the two-user port-squatting test and the authenticated origin | M10 |
| A3 §5: registry, parity, scope, eras, receipts, staged plan, framing, binding | M2 for the first five tools, M4 for the rest |
| A3 §5: the routine that initializes offline and then calls `run_report` | M6 |
| A3 evals 1, 3, 4, 5 and the ingestion form of 2 | M4 (`manual`) |
| A3 eval 2 as a real routine run | M6 (`manual`) |
| A4 §5.1 and §5.2: launch, shim, terminals, T3 Open, places | M2 |
| A4 §5.1 and §5.2: runs, cancellation, routines, the work folder | M6 |
| A4 §5.1: scheduler with a fake clock, occurrence states | M9 |
| A4: T3 run adapter tests | With the adapter, after v1 |
| A5 §5 | M2 (skeleton page), M5, M6 (run UI and the work folder) |
| A6 §5: local-phase tests, including two Claims of one backup and duplicate or misdirected transfer imports (M3) and the doctor's other-accounts warning (M2) | The milestone of each feature, M1 to M7 |
| A6 §5: mailbox audiences, recovery wrapping, remote execution, the L1 execution-journal crash tests | Their phase, M11 onwards |
| A7: importer, export, rollback, trial tooling | M7 |

**Scope profiles.** The default profile is `v1`. Each cut in 3.6 adds one profile, cumulative in the cut order. A profile moves its manifest entries to M8 and changes the definitions of done and the retirement criteria with them. `pnpm accept` and `tasks trial check` read the same profile.

| Profile | Adds the cut | Changes |
|---|---|---|
| `v1-cut-1` | Claude Desktop and Codex app links | M6.11 moves to M8. M6 definition of done 6 covers T3, Claude Code and Codex only |
| `v1-cut-2` | The Agents view and session revert in the UI | Their A5 entries move to M8. Retirement criterion 7 is met through the CLI |
| `v1-cut-3` | First-run UI steps 2 to 5 | Their part of M5.12 moves to M8. The import card stays in Settings › Data |
| `v1-cut-4` | The Washi theme | Screenshot baselines and contrast tests in Sumi only. M5 definition of done 2 in Sumi |
| `v1-cut-5` | Projection files for completed tasks | Those projection entries move to M8. Under M3 definition of done 6, completed tasks appear only in `catalog.jsonl` |
| `v1-cut-6` | The Wrap-up routine | Wrap-up's part of M6.07, M6 definition of done 5, the rehearsal's Wrap-up and retirement criterion 8 move to M8 |

A required capability of D6, D7 or D8 has no profile. Changing that scope deviates from the owner's decisions and is recorded in the specification (3.7 gate rules).

### 3.19 Delivery risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| D1 | A required route fails on Linux in M0 (T3 pairing, Codex environment, Claude terminal) | Medium | High | Fallback routes, remediation and a re-test through the same path. Until one route qualifies, that target blocks M2's definition of done. Copy does not count. Changing D7's scope is recorded in the specification. Upstream requests |
| D2 | Agent apps change during the build (monthly releases, T3 before 1.0, Codex's rollout layout) | High | Medium | Qualification receipts per version. Adapters isolated in `launch`. The reference match fails safe. L rows re-run after updates |
| D3 | `node:sqlite` defect or API change (release candidate) | Low to medium | High | Driver interface, an exact Node pin, the fallback driver in CI from M3 |
| D4 | Bridge thresholds fail | Medium | Medium | Forwarder steps F1–F4: four conditional steps outside the base |
| D5 | Lab sessions and the trial need the owner at a machine | Medium | Medium | Agents never wait: gated steps are built and independent steps go on. Batched lab sessions |
| D6 | Scope pressure from a broad plan | High | High | The v1 scope in section 2, recorded deviations, the cut list in 3.6 |
| D7 | Contract and migration churn with parallel agents | Medium | Medium | One open migration at a time, additive contract changes (3.4). Schema freeze at M3.01 |
| D8 | Managed-machine changes: Firefox snap refreshes, the user-namespace restriction, app versions set by the machine's managers | Medium | Medium | Isolated test installs, doctor checks, M0 rows re-run on change |
| D9 | Connector approvals block Refresh under `codex exec` | Medium | High | N04 early, through the real Refresh path and every read operation. Fallback: read overrides set by the user (agents never change approval settings), re-tested through the same path. A visible-session Refresh needs a recorded change of D8's scope |
| D10 | The importer meets surprises in real data, which exists only on the Linux reference machine | Medium | Medium | A synthetic fixture with every edge case, the dry run, the real-use import and its re-imports long before M7, the rehearsal, the needs-attention list |
| D11 | Imported source keys differ from the connectors' keys, so the first Refresh duplicates | Medium | Medium | `url:` keys plus A3 3.11.2's possible-duplicate attach. The rehearsal counts duplicates. Connector-style keys only when proven |
| D12 | Real work data leaks into the repo, fixtures, screenshots or logs | Low | High | `AGENTS.md` rules, the content-free log test, a CI check that fixtures use only fixture names, reports kept in the space |
| D13 | Windows-only or Linux-only bugs found late | Medium | Medium | Both OSes in CI from the first commit, RM steps on a real Linux machine |
| D14 | The trial fails | Medium | Medium | Rollback without loss, rehearsed in M7.09: canonical events, a new folder path, the export exchange as the return base, the frozen prototype, a restart after the fix |
| D15 | The owner's time for the M0 lab | Medium | Medium | Three batched sessions with prepared kits and plans |
| D16 | Token cost of evals and runs | Low | Low | Evals by hand, small corpora, run limits (turns, wall time) |
| D17 | UI speed on Linux in the Firefox snap | Low to medium | Medium | U07 in M0, M5.13, A5 3.25's fallbacks |
| D18 | Agents colliding in UI files | Medium | Low | One UI lane in M5, the other agents on runs and the importer (3.6) |
| D19 | A build breaks the real work space during early real use | Medium | High | A verified backup before every upgrade, the deploy check after every deploy, a break fixed before other work, the prototype as source of truth until M7 |

---

## 6. Open items

Nothing decides these yet. Until a step takes one, read it as open, not as a rule.

| # | Item | Default until decided |
|---|---|---|
| 3 | The reverse-DNS prefix and SignPath | Settled at the public release gate (M10) |
| 27 | Moving a space to another folder | No move command. A later step builds one on export, restore, transfer and claim, under the rules in A1 3.18. Until then a backup restored into a new folder and claimed does it |
| 29 | A place binding refused by the request handler (`path_missing`, `outside_roots`, `not_a_directory` and the other resolve reasons) depends on this machine's folders and has no receipt, so a retry after a lost refusal is decided again and applies once the folder exists | Nothing is applied twice or lost. The direction: the handler's refusal travels in the write request, so the writer stores it as a rejected receipt that every retry replays. It changes the write protocol of every write entry and needs its own reviewed step |
| 30 | Service parts that A2 and the merged steps leave "not built" and that no step above names: worker restart with backoff and `locked_elsewhere` recovery, the 500 ms configuration reload that keeps the last good version, `tasks space add` and `remove`, `tasks space cleanup` for crash leftovers, `STORAGE_OVERLOADED`'s `retry_after_ms`, `tasks service restart` and `logs`, `tasks open` starting a stopped service, the Start menu shortcut and the Linux desktop entry, and `tasks ui sessions [--revoke <id>]`. Each, and the `secrets/` folder when a step adds it, creates its files through `packages/files` and judges a folder of its own before it first writes into it | Each joins the first step that needs it, at the latest the last step of the milestone whose definition of done depends on it, and that step names it in its Work column |
| 31 | A space whose migration failed gets no retention, and a migration that always runs past the open's bound and then fails records nothing, so each open tries it again behind a new barrier backup | Backups pile up only in that case, and nothing is removed. Recording a late failure when it arrives would bound it. It needs its own reviewed step, because it touches the migration path |
| 32 | Space folders, and the folder that holds them, are not judged by the ownership rule that guards the state and configuration folders: the product writes `writer.lock`, `writer.json` and its databases into a space folder without checking who else can write it (A6 T1 says they are checked and repaired at start) | Not judged. A step of its own adds the check, with a rule for spaces on removable or synced drives, where every file can show mode 0777 and another owner |

**Decided by measurement, not by the owner:** A1 open items 2–4 (M3.16), A2 open items 1, 2 and 5 (U01, S05, untested macOS), A3's shared hosts (A03–A05), A4 open items 3–7 (N04, L07, L08, N03, L05, L04), and A6 open items 4–6 (at L1 and L4).
