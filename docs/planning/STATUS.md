# Status

The state of each step of [`PLAN.md`](PLAN.md). A row is a part that can be built and merged by
itself. States: `todo` (something it needs is not done), `ready` (it can start), `doing` (with what
has merged and what comes next), `done` (merged). A row says what is on main: it changes when a
pull request has merged, in a change of its own, and never on a branch that builds the step.

## Built before this plan

The local product as it stands: a space in SQLite with one writer, receipts, migrations, verified
backups, restore and export; the service with the `ttasks` command line, the MCP server and the
bridge that agents use, and `ttasks setup agents` for the agent apps; the page with Today, the
status views, areas and projects, search, the expanded task with its thread, Undo and Redo, the
Trash and Settings; Open in Claude Code, Codex and T3 Code in a task's folder, background runs,
the Agents page; the readable files on disk; skills; the Windows launchers, signed builds and
`ttasks update`. The code is the record of it.

## The steps

| Row | Work | State |
|---|---|---|
| 0.1 | Undo only where it helps in the page, Redo beside it, a check-off leaves at once (#218) | done |
| 0.2 | The pen: a person corrects a summary, a context, a note or a log entry (#223) | done |
| 0.3 | The rest of the feedback from use: card controls (#216), Open with the brief waiting (#217), search keeps an opened result (#219), edits outlast a stalled page (#222) | done |
| 0.4 | Undo thinned in the service: only kept kinds become steps, older steps of other kinds are passed over, each kept kind undone by its opposite operation | done (#225) |
| 0.5 | The general inversion engine and `partial` removed from the service, the contract, the command line and the app | done (#225) |
| 1b | The Activity log (#224) | done |
| 1.1 | The contract for pages, the trail, `read` and `write_page` | done (#229, #231) |
| 1.2 | Storage: the migration step for pages and the new fields, the search tables rebuilt, an older backup's index rebuilt by its own version | done (#240) |
| 1.3 | The page edit as the first named command of the new write path | done (#240) |
| 1.4 | Agent tools: `read`, `write_page`, the trail in `get_task` within one budget, search over pages, `complete_task` asking for pages updated | done (#251) |
| 1.5 | The skill `keeping-the-library`, and a brief explained as "what this is" | done (#251) |
| 1.6 | The app: the project screen with its Library, the page screen with History and Restore, page edits under Changes | done (#255, #257) |
| 1.7 | The trial: twenty scripted tasks with Claude Code and Codex, and the bytes of history per page edit | done (#275, #278): the result is under [Step 1's trial](#step-1s-trial) |
| 1.8 | The harvest of one real project, and a walk through it as a person | ready: the owner's, on a real space |
| 2.1 | The short design for one tree, reviewed before code (#237) | done |
| 2.2 | (i) The feed sends a tree, today's areas and projects as parent rows at its edge, and the page's store reads it | done (#261, #268) |
| 2.3 | (ii) The tree's schema and command core beside today's storage, used by nothing yet: add, read and finish in a disposable tree space, Undo's walk, the crash test | done (#244, #256, #260) |
| 2.4 | (iii) The remaining commands in families (tasks, notes and pages, projects, folders, preferences, Open and Run), each tried through its real caller and through both backends; ordinary spaces stay on today's writer | doing: a tree space is served by the same handlers, held by a replay through both backends that is also generated (#266, #280, #290): tasks, notes with Undo and Redo, areas and projects, pages, dates, search, the finished list, the status and the feed; next: folders, preferences, Open and Run |
| 2.5 | (iv) The projector on the tree, the finishing dialog, the new tool shapes with the skills, instructions and hints, behind the tree backend | todo: 2.4, 3.1 |
| 2.6 | (v) The switch: new spaces are trees, old formats are named before anything changes, the owner's carry-over on a trial copy first | todo: 2.5 |
| 2.7 | (vi) Deletion: the feed's adapter, today's writer, the old migration chain, the old projector and places | todo: 2.6 |
| 2.8 | The app: the sidebar tree, the project screen, breadcrumbs, the derived status line, the expanded task's Brief, Description, Knowledge and subtasks | doing: the side menu as the tree at any depth, one project screen with its Tasks and Library tabs, breadcrumbs, the status line and one address for a project, reading only (#284); a task's Brief and Description, added, corrected and previewed in its card (#294); next: the brief in the project screen's head, and the page opened on a tree space; subtasks' boxes, the finishing dialog, the Notes tab and the labels that still say "area" todo: 2.5 |
| 2.9 | Folders on any node in the app, Settings > Folders, a project's rename and archive | todo: 2.6 |
| 2b.1 | The short design for routines | done (#235) |
| 2b.4 | The schedule calculator: the stored form, the next date and due time through daylight saving, the claim after an absence, and a schedule's words | done (#241, #253) |
| 2b.2 | Routines: one task of a kind of its own that comes back on a schedule, its runs logged under it, a page of the active ones | doing: the node kind, its tables and commands with Undo in the tree's storage (#269); next: the service's entries for a routine a person does, then the app |
| 2b.3 | Agent runs on a schedule (Refresh, tidying), Refresh in the top bar, Continue interactively | todo: 2.4 |
| 3.1 | The projector for the tree on disk, written on the tree schema of 2.3 and switched on in 2.5 | done (#276, #281, #285): rendered, written by a pass with its record, and run by the service for a tree space; switched on for every space in 2.6 |
| 3.2 | Inherited default folders, other folders as hints, Open says when a folder is set only on another machine | todo: 2.4 (the folders and Open and Run families) |
| 3.3 | The trial's tasks again, tools only against tools with the tree, and a rename's rebuild timed on Windows | doing: a rename's rebuild timed on Windows (in the design's pull request, #271); the trial's tasks with file tools todo: 2.4 |
| 4.1 | Budgets that speak in a write's answer, and tidying a project's library | done (#292): the budgets in a write's answer, and Tidy as a task a person starts; tidying on a schedule todo: 2b.3 |
| 4.2 | Ingestion: a run makes tasks and sources from the person's sources by itself | todo: 2b.3 |
| 4.3 | The library skill's later versions, from the trial | done (#278, #292, #293): the trail with every `get_task` answer, a library search that says where else to look, an agent's search by some of its words; a decision found only in a finished task's log reaches a page by the harvest and by Tidy |
| 5.1 | The phone's listener apart from the page's, in the same process: it reaches only the operations, the feed and a task's runs | done (#245) |
| 5.2 | An endpoint for paired phones over pinned TLS, with rights per phone and space, and pairing by a QR code from Settings > Phones | done (#245, #252) |
| 5.3 | The phone app as a development build in the workspace, and its first proof; Today and capture shared with the page once step 1's page work has merged | doing: Today, capture and the feed's store shared in `packages/client` (#264); the app with its pinned link, built in CI and tried on an emulator against the real service (#270); scan, name and reopen (#283); Today, live, with check-off, Undo and capture kept while the computer is away (#291); a task's card to read (#296); next: what agents did (Changes, a run on the card), then the owner's first week of use |
| 5.4 | The stores' test tracks, the relay for use away from home, push messages | todo: 5.3 |
| 6.1 | Differences between versions of a page and of a description | todo: 2.8 |

## Step 1's trial

Run on 2026-11-28 on Windows 11, on the owner's subscriptions, with each agent's own sign-in and
global instructions, read only: Claude Code with Haiku and Codex with Luna, 45 runs each, and a
few runs on Sol and Sonnet to settle (a) and (b).

| agent | trail | runs | succeeded | checks passed | (a) applied | (a) read the area page | (b) task 9 | (c) made / edits / same titles | (c) history bytes per edit | (d) median input tokens | (e) both stand | (f) found, searched, on a page |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code, Haiku | on | 24 | 23/24 | 17/24 | 9/10 | 10/10 | no | 1 / 4 / 0 | 479 | 433,024 | yes | no, yes, no |
| Claude Code, Haiku | off | 21 | 14/21 | 5/21 | 1/7 | 1/7 | no | 1 / 3 / 0 | 468 | 408,139 | no | no, yes, no |
| Codex, Luna | on | 24 | 24/24 | 14/24 | 3/10 | 3/10 | no | 3 / 4 / 0 | 351 | 464,129 | yes | yes, yes, no |
| Codex, Luna | off | 21 | 21/21 | 9/21 | 0/7 | 0/7 | no | 2 / 6 / 0 | 405 | 451,971 | yes | no, yes, no |
| Codex, Sol (tasks 1, 4, 6) | on | 3 | 3/3 | 0/3 | 0/3 | 0/3 | - | - | - | 371,822 | - | - |
| Claude Code, Sonnet (tasks 2, 9) | on | 2 | 2/2 | 2/2, task 2 by the corrected check | - | - | yes | 0 / 1 / 0 | 510 | 271,536 | - | - |

The trail works when an agent sees it: Haiku with it applied the area's rule in 9 of 10 runs and
without it in 1 of 7, and without it went searching the disk instead of the library. Codex
almost never sees it: it reads `get_task` with `sections` (Luna in 17 of 21 runs, Sol in all 3),
and only the digest carries the trail, so the trail must reach every `get_task` answer before
step 2 builds on it. The trail stays whole rather than shrinking to titles: it adds about 940
characters to a digest, and the runs without it did worse on (a), (e) and (f). The library stayed
clean (no duplicates, no needless edits), but no agent put the decision found in a finished
task's log on a page, which is what `keeping-the-library` should ask next.

The second run, the same day, after `get_task` with `sections` carries the trail, library search
finds pages by any word and `keeping-the-library` names a decision from a finished task's log
(#278). Read only, with the trail on, on the tasks that decide:

| agent | tasks | runs | succeeded | checks passed | result |
|---|---|---|---|---|---|
| Codex, Luna | 1, 4, 6, 10, 13, 16, 19, and 1 in three fresh worlds | 10 | 10/10 | 10/10 | (a) applied 10/10, read the area page 10/10 |
| Codex, Luna | 2, 9 | 2 | 2/2 | 2/2 | (b) corrected in place, then used from the page |
| Codex, Luna | 3, 7, 8, 11, 17, 18 | 6 | 6/6 | 5/6 | the searches that found nothing now find it; (f) found, searched, not on a page |
| Claude Code, Haiku | 11, 18 | 2 | 2/2 | 0/2 | (f) searched the library only, not found |

Codex still reads with `sections`, and now gets the trail there: (a) reaches 10 of 10 and (b)
holds, so step 2 builds on the trail as it is. Nobody put the decision on a page: Codex found it
in the finished task's log, logged it and left the task open to ask for the visit data, and Haiku
searched only the library, which does not hold a log's decisions. Whether a finished task's
decisions should count as lessons in a library search is the next question for the skill and
search (row 4.3); it does not hold the trail.

## Before 1.0, beside the steps

| Work | State |
|---|---|
| Scale on Windows and Linux, on the new model | todo: steps 2 and 3 |
| A quality pass over the app, on the new screens | todo: steps 2 and 3 |
| A run reports through its answer and what it logs, and logs a decision it leaves the person as a question | done |
| A run that stopped at a permission prompt goes on with Continue, in the agent app, on the run's own conversation | done (#247) |
| Retiring old versions after an update | done |

## Checks on real machines

They need a person at a Windows 11 and an Ubuntu 24.04 computer, and they hold back no step.

- Install, the service started at boot and at sign-in, cold bridge starts after a reboot, and the
  unattended Refresh path.
- Open with the exact folder and the brief in each agent app, and the page in Firefox.
- `ttasks setup agents`, `--apply` and `--remove` in real agent homes: each app's own `mcp add`
  writes the entry as asked, `codex mcp remove` drops the patched keys, and Codex loads
  `startup_timeout_sec` and `env_vars`.
- The installed-build migration drill (`pnpm accept m3 --part migration --installed <folder>`) on
  Windows 11. CI runs it on Ubuntu 24.04.
- Open that joins a running session, and Open again after a session ended, with a real terminal
  and a real agent app.
- Settings > Agent apps against real agent homes.
- The modes T3 Code gives its runtime file and `userdata` folder under umask 002.
- A background run with the real Codex and the real Claude Code on Ubuntu 24.04, and Stop there.
- `ttasks update --rollback` after a migration on a real install.

## Later

Sealed backups on a server; the trial before hosting; hosted spaces with read copies, moving a
space's home, and removing something from the history for good; connectors; teams, with a model
test of many actors.
