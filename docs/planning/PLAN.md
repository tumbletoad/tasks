# Plan

TTasks grows from a task list that agents keep up to date into a task list with a library of
knowledge that agents keep current. This file says what the product becomes and in which order
it is built. [`VISION.md`](../../VISION.md) says how it should feel. [`STATUS.md`](STATUS.md) holds
the state of each step. The code and its tests are the record of what is built.

Words used here: a *node* is the space, a project or a task. A *brief* is a node's one-line
summary. A *page* is a knowledge page. A *reference* is a short name such as `M-14`. A *link* is a
pointer from a node to a page or a source that lives on another node.

## The model

A space is one tree. The space is the root. Projects nest in the space and in projects. Tasks sit
under the space, a project or another task.

| Kind | What it is | Has |
|---|---|---|
| Space | The root node: what TTasks opens, backs up and, later, hosts | title, brief, description, folders, notes for agents, its reference prefix, effort levels, statuses |
| Project | A lasting place for work. It is archived, never finished | title, brief, description, folders, notes for agents, colour |
| Task | Work that ends | title, brief, description, folders, status, priority, effort, due date, star, waiting on, outcome, a reference |
| Page | Knowledge written in TTasks, in Markdown | title, brief, body, a reference |
| Source | Something from outside: a mail, a ticket, a document | title, brief, optional body, kind, address, sender, date, the key that recognises it again, a reference |
| Note | A message in time order, from a person or an agent | body, author, kind |
| Link | A pointer to a page or a source elsewhere in the space | nothing of its own: it shows its target's title and brief |

- **What contains what.** The space and a project hold projects, tasks, pages, sources, links and
  notes. A task holds the same, except projects. A page holds notes, which are its comments.
  Pages do not contain pages: the tree of projects is the only hierarchy.
- **Depth is not limited.** The app is laid out for three levels of projects and two of tasks,
  and indents deeper ones. A move that would make a loop is refused.
- **The summary is the node's brief and description.** The brief is one line of at most 400
  characters, the description is Markdown of any length. A node needs only a title. A person may
  leave both empty. An agent must give a brief on a page or a source it makes, and is told "no
  brief" when it works on a node without one.
- **One set of references.** A page and a source take the next number of the space's counter,
  as a task does, so `M-180` may be a task, a page or a source, and one resolver opens any of them.
  Task numbers then have gaps.
- **A project's status and workload are derived, never stored.** They are read from the open
  tasks below it at any depth: counts per status, the nearest due date, how many are overdue, the
  last change, and the time still to do. The time sums open tasks that have no open subtask, and
  tasks without a size are counted as "not sized". The only stored state is `archived`.
- **Finishing a task that has open subtasks asks first.** A dialog names the open subtasks and
  offers Cancel, this task only, or this task and all its subtasks. A task without open subtasks
  finishes at the click. An agent's `complete_task` on such a task is answered with the open
  subtasks and must say which it means. Trash and Restore take a subtree as one unit.
- **The Inbox stays a flag** that means "not looked at yet", apart from where a task sits.
- **One space at a time.** Search, references, moves and the trail never cross a space, and
  nothing in a space points into another one.
- **The name "project" is used for every level.** Areas become top-level projects.

Today's two-level model maps onto the tree as follows: an area becomes a top-level project and
its projects nest under it; a task's summary and context become its brief and description; notes
and log entries become one notes table; learnings become notes of the kind `learning`, and new
lessons go to pages; a source lives on the task of its earliest link, with its other task links
kept as links, and a source whose last task link is gone sits on the space; the folders table
serves any node, and places are retired with the folders work of step 2; proposals, exchanges
and attachments, which nothing writes, are dropped.

## How knowledge reaches agents and grows

**The trail is handed over without asking.** `get_task` answers as today and adds one line per
level from the space down to the task: its title and brief, the person's notes for agents on that
level, and the list of its pages, sources and links, each with its reference, title, brief, last
writer and age. Never a body. `read` on a project or on the space gives the same for that node.

```
Studio: client and own work; how we quote and report.                 3 pages · 1 source
  M-103 Glossary: terms used with every client                         (agent, 12 d)
Client work > Bakery > Website relaunch: a new site before the spring menu.
  for agents (you, 3 Nov): never mail the client directly, drafts come to me.
  M-180 Hosting notes: where the site runs and the two known pitfalls  (agent, 2 d)
  M-197 Mail "launch timing": their dates and who decides              (5 Nov)
M-214 Fix the menu layout ...  (the task as today)
```

- **One budget for the whole first answer,** the task and the trail together. It starts at 2,500
  tokens, and step 1's trial sets the final number from what Claude Code and Codex receive. The
  person's request and notes for agents come first and are never cut. The nearest levels are
  listed in full. A far level with many items shrinks to a count and a pointer to `read`.
- **Only a person's notes for agents and skills are instructions.** A project's notes for agents
  hold for every task below it, and only a person writes them. Pages, descriptions and sources
  are knowledge: the tools frame them as data, as they frame task text now. A poisoned mail
  therefore cannot become an order to every later agent through a page.

**Bodies are fetched when needed.** The index is pushed because an agent cannot ask for what it
does not know exists. Bodies are pulled because most of them do not matter for a given task, and
an agent judges that well from a brief.

1. `read` (new): a page, a source or a node's description by reference, whole or one heading's
   section.
2. `search` (widened): pages, sources and notes too, with the task's own trail and subtree first.
3. The readable files on disk hold the same content, read-only, so an agent with a shell can use
   its own search tools. The tools stay complete for agents that have no files.

**Agents write pages directly.** `write_page` creates a page or a source on a node, edits it,
appends to it, moves it up or down the tree, adds a link, or moves it to the Trash. Every write
carries one line that says what changed and why, and that line is what Activity and History show.
`update_task` and `organize` set the brief and description of tasks and projects.

- **An edit replaces old words with new words,** the form coding agents already use for files.
  It applies while the old words still stand in the page, whatever else changed, so two agents
  that edit different passages both succeed. When the old words are gone, the answer gives the
  page as it is now and keeps the agent's words for another try. Appending needs no base.
- **Finishing asks about the library.** `complete_task` takes, in place of `learnings`, the
  references of the pages this work updated, or an explicit "nothing reusable". The page writes
  go through `write_page` before the finish. An agent is never made to manufacture a lesson.
- **Knowledge another task can use goes on the project.** The trail walks upward only, so a page
  on one task is invisible to its sibling. `write_page` therefore puts a new page on the nearest
  project unless the agent names the task. A task with no project above it keeps its own new
  pages. A project's Library also lists the pages of its tasks, open and finished.
- **A shipped skill, `keeping-the-library`,** holds the judgement: fix a wrong sentence in place,
  one page per subject, cite the task or source behind a change, move a page up when a second
  project needs it.

**The library does not start empty.** The knowledge sits in existing tasks: notes, outcomes and
learnings. A harvest is an ordinary task in a project, "Build this project's library", which the
app offers on a project without pages. The agent reads the project's tasks, finished ones
included, writes the pages a next agent would want, gives the project a brief and a description
if it has none, and says in its outcome what it made. It changes nothing in the tasks.

**What keeps the library from rotting or bloating.** Age and author stand in the trail. A page
over 16 KB, or a node with more than 12 pages and sources, makes the write's answer say so and
suggest splitting, merging or moving up; nothing is refused. The trail's budget keeps a bloated
node from costing tokens everywhere. Tidying is a task a person starts on a project: merge
duplicates, drop what finished tasks made untrue, move knowledge to the right level.

**What a person sees and can take back.** Every change of every field is kept from the first
day, with who made it and when: the change log does that today, and nothing thins it. A page shows
"changed by Codex, 2 days ago" with History: its earlier versions, each with Restore. Restoring
is a new edit, so nobody's later work disappears unseen. A page moved to the Trash keeps every
version and comes back with them. A task's card shows no list of changes to its fields. The
difference between two versions is built last.

**Folders.** Each node may have one default folder per machine and any number of other folders,
each with an optional label. An agent starts in the node's default folder, else the nearest
ancestor's, else in the agent app's own start folder, normally the home folder. When a folder is
set only on another machine, Open says so and offers to choose one here. Other folders are hints
listed in the trail. A folder is stored as text with room for a scheme, so an address can be
added later.

## Storage

**SQLite stays the only truth, and the readable files mirror the tree.** One writer process
changes a space, one transaction per request. That gives what files cannot: a change across
several things that lands whole or not at all, a request sent twice that is applied once, a check
per field that no edit overwrites a change its writer had not seen, counts and full-text search
from indexes, and a consistent backup while agents write.

- **The tree on disk.** A project is a folder inside its parent's folder. A task is one Markdown
  file, or a folder with an index when it has pages, sources or subtasks of its own. Pages go in
  `pages/` and sources in `sources/` of their owner's folder. Each folder has an `_index.md` with
  the node's brief, description and contents. Finished tasks move to `done/<year>/`. File names
  carry the reference. Folder names are short slugs, kept well inside the Windows path limit.
- **The files are written only by TTasks.** A file a person edits there is kept in a rescue folder,
  as today. The files may lag the app by a moment and carry a stamp of how fresh they are.
- **What would reopen the choice:** agents doing the same work with clearly fewer tokens or turns
  when they may edit files, or people asking to keep spaces in Git. The cheap answer would then
  be to take an edit of a page's file in as an edit of that page, with the version check.
- **The write path is rebuilt as named commands.** Today a request is a list of small operations
  that the writer first works out in memory and then applies. Each tool entry becomes one named
  command under the same lock, receipts and transaction, where each statement reads what the one
  before it wrote. Kept: one writer, whole or nothing, receipts by request ID, field versions, and
  who changed what.
- **Old versions of a text come from the change log.** There is no table for them. If history
  grows large, two remedies stay open: store only the passage an edit changed, or thin old
  versions by age as a stated rule. Neither is built until a measurement asks for it.
- **Spaces made before the tree are not carried over by a shipped migration:** TTasks has no
  outside users yet. From the first release that another person uses for real work, every change
  of format is a supported upgrade behind a backup that has passed a trial restore, as
  `docs/promises-and-limits.md` promises.

## Other devices, hosting and teams

One rule carries every stage: **a space has one home, and only the home writes.** Every other
device is a client of the home. Two written copies are never merged.

**The phone reaches the computer.** A phone app for iOS and Android, built with Expo and React
Native, shares with the web app what is not a screen: the typed client, how Today is grouped and
the capture parser.

- The computer is the home and the only place agents run. Nothing is stored in a cloud.
- The first version needs no account and no server: on the home network, or a private VPN, the
  computer shows a short-lived code as a QR code, and the phone scans it. The code names the space
  and carries the computer's key, so the phone knows it talks to that computer.
- Rights are given per phone on the computer, each for one space and each revocable, on an
  endpoint of their own. Reading and editing is one right. Starting and stopping a run is a second
  right, off until the person switches it on for that phone.
- The first screens: Today, capture, check off, read a page, watch a run.
- With the computer out of reach the app shows what it last saw, with its age. Capture still
  works: the task waits on the phone, shown as waiting for the computer, and is sent with the same
  request ID until the computer confirms it, so it is never made twice. No launch is queued.
- Later: a relay for use away from home, with encryption that ends on the phone and on the
  computer, so the relay passes bytes it cannot read. Push messages when a run needs the person.
  A browser on another device through the same endpoint and rights.

**A hosted space, later.** The home moves to a server that runs the same service with one SQLite
file per space. Each computer keeps a read copy, made from a snapshot and kept current by a stream
of every commit's changes, and writes go to the home with their request ID and version. Phones,
browsers and hosted assistants read the home. Offline, reads work and writes wait as drafts.
Moving a space's home, in either direction, is one stated procedure: the old home stops taking
writes, a final snapshot is restored at the new home as a trial, and the old copy is retired.
Connectors let hosted assistants such as Claude and ChatGPT reach a hosted space, beside the local
MCP server.

**A team's space, later.** The home is a server that is always on. Each member signs in as
themselves, and every commit already separates whose authority from which agent made it. Tasks
and projects get an assignee. Rights are owner, member or viewer, per space. Agents run on each
member's own computer.

**What the local design keeps true now:** one home recorded in each space; every change an
operation with a request ID, an actor and a commit number; the app reaches a space only through
the service's API; new tables name actors, never "the user"; references come from the home only;
bodies are text in rows, and attachments, when they come, are files named by their hash. Two jobs
that share one process today are kept apart in the code: the space service (read, write, search,
the feed) and the device service (folders, starting and stopping agents, the agent apps'
sign-ins).

**Encryption.** In transit, always. On the computer, the disk's own protection, as today. Backups
kept on a server are sealed on the computer with a key only the person holds. A hosted space is
readable by its server and encrypted at rest, because search on the server and connectors need
that. A person who wants no server to read their work stays local.

## The app

- **Stays as it is:** Today, quick capture, the status views with their fixed places, the task row
  and the expanded card with its thread and composer, Agents, Completed, Trash, the themes.
- **The sidebar becomes the tree.** The fixed views stay on top. Below them the projects, nested
  and foldable, each with its open count.
- **A project screen**, and the same screen for the space: breadcrumbs, the brief, the derived
  status line and the folder, then Tasks (subtasks indented, subprojects as groups), Library (the
  description, pages, sources, what comes from above and from finished tasks) and Notes (notes
  for agents pinned on top).
- **A page screen:** title, brief, the rendered body, a pen that edits the Markdown with a
  preview, "changed by …" with History and Restore, and the page's notes below.
- **The expanded task changes least.** Summary and Context become Brief and Description.
  Breadcrumbs show the trail, a Knowledge row lists the task's pages and sources, and subtasks are
  a short list with a box each.
- **Activity:** one screen for the space, one line per change an agent or a routine made, newest
  on top, live while agents work. Each line names who, what it touched and what happened, and
  opens what it names.

## The steps

Each step ships and is useful on its own. The order follows what each step needs.

### Step 0. Undo thinned, and the feedback from use

- **A person gets:** Undo and Redo only where they help, and the corrections and fixes asked for
  in daily use.
- **Done:** the page offers Undo only for what is a nuisance to put back by hand, with Redo beside
  it, and a check-off leaves at once (#218). A pen corrects a task's summary and context and the
  words of any note or log entry (#223). The card's small controls (#216), Open with the brief
  waiting in the prompt box (#217), a search result that stays open while typing (#219) and edits
  that wait out a stalled page (#222).
- **Left:** the service keeps Undo, also for `ttasks undo`, for exactly what the page offers it
  for: a check-off and a reopen, a move to the Trash and out of it, a removed note, a correction
  of words, a move out of the Inbox, a task's first filing from no area, a change of many tasks
  at once, a new project or area, and an unarchive. A new project or area that is undone is
  archived. Any other change is no step on the person's stack, and Undo and Redo pass over an
  older stored step of a kind that lost Undo. Each kept kind is undone by an ordinary operation
  that is its opposite, and keeps today's check for newer work. Then the general inversion engine
  goes, with `partial` in the contract, the command line and the app, and the tests and promises
  that held it.
- **Needs:** nothing. **Beside it:** step 1b, and the design of step 1.

### Step 1. Knowledge above the task, with its trial

- **A person gets:** pages on the space, areas, projects and tasks; a brief and a description for
  the space; a description for projects; notes for agents on the space, areas and projects. Agents
  are handed the trail and keep the pages current. A project screen with its Library, a page
  screen with History and Restore, and page edits listed under Changes.
- **Storage:** one migration step beside today's tables, and no more than the trial needs. The
  page edit is the first named command of the new write path. The search tables are rebuilt for
  the new kind. Before this step indexes pages, the trial restore that guards every migration
  must rebuild an older backup's search index by that backup's own version, so older backups keep
  restoring.
- **Agents:** `read`, `write_page` (create, edit, append, move), the trail in `get_task` inside one
  measured budget, search over pages, `complete_task` asking for the pages updated or "nothing
  reusable", the first version of `keeping-the-library`, and a brief explained as "what this is",
  not "the next step".
- **The trial, before step 2 starts.** Twenty scripted tasks in one project of a temporary space
  of a few hundred tasks, with Claude Code and Codex. It counts: (a) a rule two levels up is
  fetched and applied without being told, in 9 runs of 10, else the trail changes first; (b) a
  fact corrected in task 2 is used in task 9 from the same page; (c) needless edits and duplicate
  pages after twenty tasks; (d) tokens per task with the trail on and off, and if off is as good
  the trail shrinks to titles; (e) two tasks that edit different passages of one page at once
  both stand. Some nodes have a poor brief or none. One case has a decision that exists only in a
  finished sibling's note: does the agent find it and put it on a page? The trial also measures
  the bytes of history per page edit.
- **Then:** the harvest of one real project, as an ordinary task, and one walk through it as a
  person: Open, the agent works and finishes, Changes, History, Restore.
- **Needs:** the contract agreed first. **Beside it:** two lanes once the contract stands, storage
  with the service, and the app.

### Step 1b. The Activity log

- **A person gets:** the Activity screen, live, on today's model. Pages appear in it once step 1
  has them.
- **Needs:** only the change log and the live feed. **Beside it:** anything.

### Step 2. One tree

- **A person gets:** projects inside projects, subtasks with the finishing dialog, notes on
  projects and the space, comments on a page, links, sources on any node, the sidebar tree, and a
  project's derived status line. Areas are gone.
- **First a short design, reviewed before code,** chooses between two ways. (a) Move every writer
  to named commands on today's tables, then move the tables to the tree. (b) Write the new tables
  and their small writer fresh, as the schema of 1.0, and move every caller over. Either way every
  caller moves before the old write path is deleted, also those without a tool entry (Open and Run
  record launches and runs straight through the writer, and storage fills missing preferences
  itself), and Open and a background run are tried through to their end first. The reads are
  ported in the same step, and the crash harness runs on the new write path.
- **The tables:** one table for what every node has, the `tasks` table for what only a task has
  (so launches, sessions and runs keep pointing at it), one `notes` table, `links`, and sources on
  any node with a brief, a body and a reference.
- **Folded in:** the folders on any node, places retired, the same folders on another machine
  after a restore, Settings > Folders, a project's rename and archive in the app.
- **Needs:** step 1 and its trial. **Beside it:** one storage and service lane whose parts follow
  one another, and the app lane. Step 3's projector is built beside the first half.

### Step 2b. Routines

- **A person gets:** tasks that come back on a schedule, and agent runs that start by themselves
  on a schedule, such as Refresh or tidying a library. Refresh in the top bar, and Continue
  interactively from a run.
- **Needs:** the new writer of step 2, because routines add kinds of writes that should be built
  once. A short design comes first.

### Step 3. The tree on disk, and folders

- **A person gets:** the readable files in the shape of the tree, and folders that are inherited:
  a task without a folder opens in its project's, or the nearest one above. Other folders listed as
  hints. Open in T3 Code never registers the home folder as a project when no folder is set.
- **The projector** renders from a snapshot after changes settle and compares hashes. It goes
  live with step 2's migration.
- **Measured here:** the trial's tasks once more, tools only against tools with the tree, in tokens
  and tool calls; and a rebuild after a top-level project is renamed, on Windows with Defender on.
- **Needs:** step 2's tables.

### Step 4. The library keeps itself

- **A person gets:** budgets that speak in the write's answer, tidying a project's library as a
  task, sources filled by ingestion, and the skill's later versions from what the trial showed.
  Ingestion is a run that reads the person's sources (mail, tickets, notes) by itself and makes
  tasks and sources from them, never twice.
- **Needs:** step 2b for runs on a schedule.

### Step 5. The phone

- **A person gets:** the phone app on their own phone: Today, capture, check off, read a page,
  watch a run, against their own computer on the home network.
- **Parts, in order:** the space service apart from the device service; an endpoint for paired
  devices with its rights; pairing by a QR code; the app as a development build. Its first proof,
  on a throwaway space: pair with the computer's key pinned and load Today; let the computer
  sleep, capture, close and reopen the app, wake the computer; drop the computer's answer after it
  saved, so the phone sends again with the same request ID; find exactly one new task. Then Run is
  refused with the default rights, and a revoked phone gets nothing. Then the stores' test tracks,
  then the relay for use away from home, and push messages.
- **Needs:** nothing of steps 2 to 4. It can start any time after step 1.

### Step 6. Differences between versions

- **A person gets:** the difference between two versions of a page, and of a project's or a
  task's description, opened from the list of earlier versions.
- **Needs:** step 1's History. Built last on purpose: reading and finding pages comes first.

### Before 1.0, beside the steps

- Scale on Windows and Linux, and a quality pass over the app, after steps 2 and 3, on the new
  model and screens.
- A run's report through the run's own connection, and asking the person about an approval in
  Codex's narrower modes.
- Retiring old versions after an update.
- The checks on real machines that need a person at a Windows and a Linux computer. They are run
  when a session can be held, and they hold back no step.

### Later, in this order

1. **Sealed backups** kept on a server.
2. **Hosted spaces,** after a short trial: one hosted space gives a computer a snapshot, sends it
   a later page edit, answers a search on that copy and a connector call at the same time. Its
   result decides between a full read copy and reads from the home. Moving a space's home, and a
   way to remove something for good from the history, come with it.
3. **Connectors** for hosted assistants.
4. **Teams.**

## What this plan does not do

- **No merging of two written copies:** one home serves every stage.
- **Nothing across spaces.**
- **No block editor and no live co-editing:** Markdown with versions is enough for a library that
  agents mostly write.
- **No importer:** agents recreate work from other tools through TTasks's own tools.
- **No approval queue before agents may write:** agents act, and a person takes back.
- **No turning a task into a project yet:** move its subtasks and pages instead.
- **No pages private to one team member yet,** and no attachments or folders that are addresses
  yet: the stored shapes leave room for them.
- **No revert of one earlier change:** Undo and Redo in order, and a page's earlier versions, are
  enough.

## What could make this fail

1. **Agents do not keep the library useful.** Step 1's trial is the earliest test.
2. **The move to one tree stalls.** Step 1 tries the first named command on pages, where a mistake
   costs little, and step 2 starts with a reviewed design.
3. **The phone is harder than it looks:** two stores and their review of an app that controls a
   computer, how a phone treats an app in the background, and a relay's idle connections. The
   development build of step 5 tests it without a store or a server.
4. **The product becomes a wiki with a task list attached.** The test is a week of use after step
   1: does the app still open on Today, and is a task still one click from an agent?
