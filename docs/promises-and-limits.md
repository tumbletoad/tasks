# What TTasks promises, and what it does not

The code and its tests say how TTasks works. This page says what a person can count on, and where
the protection stops. It lists only what is built. Change a line here in the same pull request as
the behaviour it describes, and keep each one to a sentence or two.

## Your tasks and their history

- An edit never silently overwrites a change to the same field that you had not seen. You are
  shown both values and choose.
- Changes sent together are saved together, or not at all.
- A change that was reported as saved survives a crash of TTasks.
- A change sent again with the same request ID after a lost reply is applied once: for an agent,
  through the same connection, or through the tools and the shell of one agent TTasks opened. Its
  answer says what that change did, also when it changed nothing or the space changed since, and
  is dated by that change, so an edit based on that date still meets every change that came after.
  The names and lists in it are as they are now. The page and the agent tools resend that way by
  themselves. At the command line, repeat the command with the `--request-id` that the failed
  command named. A change that was refused saved nothing: sent again, it is decided again.
- Every change keeps what changed and who made it: you, an agent, or a script.
- Activity lists every change an agent or a routine made, newest first, and one they make while it
  is open without a reload. A line names a task by its title now, and says that a text changed,
  not what it says.
- Undo and Redo take back what is a nuisance to put back by hand: checking off and reopening,
  moving to the Trash and restoring, a whole change from the Trash too, removing a note and putting
  it back, the words of a title, a summary, a context, a note or a log entry, a move out of the
  Inbox or into it, a task's first area, setting questions aside, a new project or area, and
  archiving or unarchiving one. Anything else you change back by doing it again, and Undo passes
  over it, in the page and at the command line alike.
- Undo and Redo never write over a change made since: not where what your change wrote was changed
  again, by anyone, you included, not where a wrap-up was written since a finish, and never by
  taking a task or a note out of sight that someone else worked on since. What counts is what a
  person sees, never when it was written. Then nothing changes, you are told who changed what, and
  that change of yours leaves your Undo and Redo, so the next one reaches the change before it. So
  does one that can no longer be applied, such as to a task in the Trash, which says why. A run you
  queued or stopped and a session you opened are yours; what a run did since, from its start on, is
  the run's work.
- Your undo history survives a restart and is shared by your windows and the command line.
- In the page, a change Undo is not for saves without Undo, and from then on that tab offers no
  Undo or Redo of what came before it, so Undo never takes back something you did not expect. An
  Undo or Redo that got no answer keeps its step to try again. Limit: the page offers only what
  that tab did since it opened; `ttasks undo` reaches the rest.
- Checking off a task completes it at once and can be undone. Undoing a reopen finishes the task
  again at the time it was finished, with its outcome. Neither Undo nor Redo checks a task off or
  archives it again when someone else added to it or changed it since.
- Wrapping up a task keeps its context, notes, activity and sources. Reopening keeps the earlier
  outcome and what was learned.
- Moving a task to the Trash deletes nothing: its notes, log, sources and history stay, nothing
  empties the Trash, and Restore brings it back as it was. A task whose project or area is gone
  comes back in its area, or the Inbox. A task someone changed since you looked is not moved, and
  neither Undo nor Redo puts a task back in the Trash when someone else added to it or changed it
  since.
- A task in the Trash changes only by Restore, and by a change of the effort levels that moves its
  size: its card is for reading, and what you typed for it stays as you typed it. A task whose
  creation an earlier version undid is not in the Trash.
- A restored task never takes a source back from a task that took it meanwhile: captures go on
  there, and the restored task lists the source as removed, saying where captures go.
- A run working on a task you move to the Trash goes on, and stays on the Agents page with its Stop
  as long as it would for any task. A run that finishes leaves the page as any task's does: its
  answer stays in the task's thread, which the Trash opens. An agent in a terminal that TTasks
  started for the task goes on until you stop it in its terminal, and shows on the Agents page until
  it ends, with or without the Agent Monitor.
- Agents can move tasks to the Trash and back. Their changes are not on your Undo: the Trash shows
  each one under the agent's name with Restore, and the Trash in the sidebar counts the tasks agents
  moved there that the Trash has not shown in that browser.
- A task's reference, such as M-14, is not given to another task when the task is deleted or its
  creation is undone, when a backup is restored over the space, or when a restored copy is claimed.
- Adding work by a source that an open task or a recently finished one already has finds that task
  and keeps its fields, and makes none of the areas or projects the work named. A task finished
  longer ago or a deleted one does not stand in the way of new work.
- A log entry given with such work, a finished task's follow-up included, goes on the one open task
  it found. When it found a finished task or several open ones, that request adds the entry to none
  of them, and the answer names the tasks it found and says so.
- Work recreated from another tool can keep when each task was created and finished and when each
  log entry was made. A time in the future is refused. Such a task finished long ago is still
  found by its source for the usual number of days after it was recorded here, so a second pass
  creates nothing.
- New work that also names a source of its own is never folded into the task that holds a shared
  one, such as a ticket two tasks are about: it becomes its own task, linked to the shared source,
  and the answer says which task holds that source.
- A source detached from a task, by you or an agent, no longer brings captures of its item there,
  and Put back brings the same link back. While another active task holds its key, captures go
  there and Put back on an active task is refused, naming that task. Adding the source again on
  purpose links it, and the answer says that a capture of it now asks which task.
- A finished task takes a detached source back even while an active task holds its key, and
  captures still go to the active one. Reopening that finished task makes them ask which of the two.

## Backups, restore and export

- A backup stays consistent while people and agents change tasks.
- A space's backups go to its own folder beside the TTasks home (`~/.ttasks-backups`), so removing
  the home folder leaves them. `ttasks space list` and `ttasks doctor` say where they are.
- Backups made before they went there stay in the space's `backups` folder: listed with their
  folder, restorable by name and as latest, and never moved or cleaned up.
- A backup that is called verified has passed a trial restore. So has every backup you make with
  `ttasks space backup`.
- While a space is open for changes, TTasks backs it up once a day. It keeps the backups of seven
  recent days and four recent weeks, and removes older daily ones. Backups you make by hand, and
  the one taken before an upgrade, stay until you remove them.
- A backup whose `.json` beside it went missing is kept: `ttasks space backups` lists it as
  `missing_sidecar`, and it restores again once its `.json` is back.
- When a daily backup fails, or the newest backup does not pass a trial restore, `ttasks doctor`,
  `ttasks space list` and the page's space switcher say so and what to do, until a backup succeeds
  again. A trial restore that has no room to run is said as that, never as a backup that does not
  restore, and clean-up then removes nothing.
- Each copy of a space keeps its own line of backups: a copy you claim, here or on another
  machine, and the space after a restore over it start a new one. One copy's backups never decide
  which of another's are kept, which is the newest, or whether its daily backup is due, also when
  several copies share one backups folder. A line no copy writes any more keeps what clean-up kept
  when it ended.
- Within a copy's backups, the newest is the one that holds your latest saved work, also after the
  clock was set back. Clean-up never removes it, nor the newest backup that restores.
- A space's backups folder that is not there, such as one you set on a drive that is not
  connected, or one TTasks cannot make, is said as not there, with its path. No backup goes to
  another folder in its place, and nothing is cleaned up. An upgrade does not wait for it: its
  backup goes to the space's own backups folder, and `ttasks space list` says where.
- Making a backup or an export never overwrites an existing file.
- A restore checks the backup first. A backup that is broken or too new leaves nothing half
  restored.
- `ttasks space restore latest` restores the newest backup of this copy that restores. When the
  folder holds none of this copy's, it takes the copy whose backups were made last and says which
  other copies it holds. When the disk has no room, fails, or a backup could not be checked for a
  reason that is not the backup's own, it says so and restores no older one in its place.
- `ttasks space rescue` writes every row saved before it began that can still be read, also while
  the space is in use. A space that keeps changing while its files are copied is refused.
- Restoring over a space keeps what was there before, and takes only a backup of that space, also
  when its files no longer say which space it was. A space's backup list, a restore by a backup's
  name, and a restore of a backup's file you name with a space keep to that space's backups.
- `ttasks space rescue` writes only the rows of the space you named. When the database is too
  damaged to say which space it holds, the rescue says so.
- A restored copy cannot be edited until you make it the current copy.
- To look inside a backup, restore it into a new folder, close the space, open that folder, look,
  close it, and open the space again. TTasks never opens two copies of one space together, so the
  page and the command line always show and change the copy you opened, and a restored copy says
  so, with its folder and the backup it came from. An agent or a run that was working when the
  backup was made is shown as working then, never as working now.
- A restore over a space, or a claim of a restored copy, never starts or resumes a background run
  the backup held open, and never takes an agent session the backup held open for one of today:
  each is shown as interrupted by the restore as soon as the restore or the claim is done.
- An agent you opened from a task writes only into the copy of the space it was opened in. After a
  restore over the space or a claim of a copy, it is told so and changes nothing: open it again
  from the task.
- Apart from that clean-up of scheduled backups, TTasks never deletes your data or a backup as a
  side effect of something else.
- An export that holds text shaped like a known kind of secret, such as an access token or a
  private key, is still written, and says what kind it is and where, without printing it.
- A space is upgraded only after a backup of it has passed a trial restore. A failed upgrade
  leaves the old data readable.
- An older version of TTasks never writes a newer data format.
- TTasks offers a space's own effort sizes, also when a newer version wrote the list; only a list
  it cannot read at all falls back to its default levels.
  Every space holds its own list: a new space, or one without levels, has the five default
  levels stored when it opens, so each such version offers the same levels for it.
- Agents read your effort levels, with their times and descriptions, and never change them.
- Renaming, merging or removing an effort level moves the tasks on it in the same change, finished
  ones and those in the Trash too. A level that tasks hold is never dropped without saying where
  they go. Settings are not on Undo: you change them back by changing them again.
- Settings changes a space's effort levels only when this version can keep them: a list a newer
  version wrote, or one it cannot read, shows there read-only and is never written over.

## Your spaces on this machine

- A space you create, open, restore or claim opens again after a restart, and one you close stays
  closed, also when a restore over it fails. TTasks never takes a space off its list by itself.
- Recording this keeps your own comments and settings in the configuration file. When the file
  cannot be written, TTasks says so and names the command that records it once the file is fixed.
- When several copies of one space are on this machine, TTasks opens one of them at a time:
  opening another is refused, with what is open and how to switch. After a restart the copy you
  last changed opens.
- In a space that takes no change, such as a restored copy or one another machine owns, the page
  says why before you act and keeps what you typed there to copy, never offering a Try again that
  cannot work, and never sends it later by itself.
- A tab whose space was closed, restored or claimed since it loaded says so and saves no more
  changes to that space; what you typed there stays to copy.
- What you typed for a task and did not send stays in the browser, also when the copy of the space
  you open does not hold that task, such as an older backup you claimed: TTasks never deletes it
  because a task is missing.

## Projects and folders

- A project has at most one folder on each machine, and a task may have its own. Any number of
  projects may share one folder: setting it tells you which others have it, and an agent working
  there sees the tasks of all of them, each with its project.
- A new task that an agent files from its working folder, with no project named, joins the project
  whose folder holds that folder most closely. When several projects share that folder, it joins
  the project of the agent's own task, else it goes to the Inbox and the agent is told which
  projects it could join. In an archived project's folder it joins no project, and the agent is
  told.
- When you move a folder on disk and then give its project or task the new folder, every folder
  TTasks knows inside the old one that is there in the new one moves along, other projects' and
  tasks' included, as one change on that machine. TTasks takes it as a move only when the old
  folder is gone and the new one is it: the same folder, or a copy whose marker names the owner and
  that was not already there as the owner's earlier folder. Otherwise nothing else moves, and you
  are told which folders stayed and why. TTasks itself never moves files.
- An archived project keeps its folder, and a deleted one leaves it to the others.
- Archiving an area or a project keeps its tasks open and in your views. The page then lists it
  under Archived in the sidebar, with its open tasks counted, and offers it for no new work; its
  own page brings it back with Unarchive. A new project whose area turns out to be archived is
  added there, and the page says so and offers that area's Unarchive.
- A project made for a folder is named after it unless you name it. The Git repository in a
  project's folder is shown by name only, never by its address.
- TTasks leaves a small `.ttasks-marker` folder in each project's and task's folder, holding only
  which space and projects or tasks it belongs to, and ignored by Git. Clearing the folder in
  TTasks removes it. Limit: it can keep naming a project that left the folder another way, such as
  by a delete; TTasks's own record says who has the folder now.
- TTasks never makes a folder for an agent. At the command line, `--create` makes it when you ask,
  and in the page's folder chooser "Make the folder" does; Undo of the new project leaves it on
  disk.
- The page's folder chooser lists the names of folders on this machine to you alone, never to an
  agent's tools. It reads no file, apart from a Git checkout's settings for its repository's name. A
  folder that answers slowly is listed as far as it read in two seconds, and a very large one up to
  its first 20,000 entries.
- No folder inside TTasks's own data is taken: an agent working there would change it.
- A folder is a local path, not a secret. It travels with sync, backups and exports, and a message
  or a history entry may name it.

## Agents

- An agent that uses TTasks cannot start other agents, raise its own permissions or change your
  settings for what agents may do.
- An agent that TTasks opened in a terminal, and a background run, works on its task without naming
  it. What it changes through its tools and through `ttasks` in its shell is that task's session,
  also across a restart of TTasks.
- Every other agent names its task on each change, and its changes are recorded as its app's. Two
  chats of one app cannot act on each other's task.
- An agent works in one space from the moment it connects: its task's, or the one its connection
  named or the default space then. Switching space in the page or changing the default does not
  move it.
- An agent that reaches TTasks through its registered connection reaches only the spaces you
  granted it.
- A change by an agent or a script is never recorded as yours.
- An agent that asks what is on for today or this week is told the tasks your Today shows under
  Focus and This week, in the same order, when your browser and TTasks's service are in the same
  time zone: the agent's day is the service machine's, the page's day is the browser's. Its stars
  and counts are the ones your page shows, except that a status of the space's own has its own
  count for an agent, while the sidebar counts it in Open.
- Every note is visible to agents until you take it back.
- You can take back any note on a task, in its thread or with `ttasks note <task> --remove <n>`:
  from then on no agent and no search reads it, the task's readable file loses it within about a
  second, a launch it was the request of says the request was taken back, and Put back brings it
  back as it was. Only you take notes back, and nothing is deleted for good.
- You can correct the words of a task's summary and context and of any note or log entry in its
  thread, whoever wrote them, behind the pen beside them. The words before stay in the history and
  Undo puts them back; a corrected note or entry says that you corrected it. Agents read the
  corrected words from then on, and no agent tool rewrites what someone else wrote. A correction
  always holds the whole text, and one refused because the words changed meanwhile is never sent
  again: your words wait under the text as not saved, to copy or discard.
- A question an agent logs on a task, or a background run ends with, waits for you under Needs you
  on the Agents page, also once the task is finished or dropped, until you write a note on the task
  after it or dismiss it. A run's question is also answered by a run you start after it that gets
  to work; a logged one is not. A note you take back answers nothing. Dismiss sets aside every
  question up to the newest one the row shows, also those past the ten it shows; one asked after
  that still waits, and Undo brings them back. A task in the Trash whose run asks shows there with
  its question and no Dismiss: Restore brings it back to answer.
- Your skills, the files in `skills/` of TTasks's folder, are your instructions to every agent that
  uses TTasks, as a note for agents is. No agent tool creates or changes one. A file over 16 KB, an
  empty one, one that cannot be read or a link is not used at all, and agents and `ttasks skills`
  say why. `ttasks skills copy` never replaces a copy you edited.
- Agents are told to give a task they add the priority your `setting-priority` skill describes,
  and to change the priority, due date or star of a task that exists only when you ask. It is an
  instruction, not a lock: TTasks does not refuse such a change.

## Agents on this computer

- With an Agents page open, TTasks runs the Agent Monitor (TTAM). It asks TTAM at most every second
  while you look at that page, every 30 seconds while the page is only visible, and not at all
  otherwise, and ends it ten minutes after the last question and when TTasks stops. When TTAM says
  it is still looking, TTasks asks again after a second, at most three times in a row.
- A picture of the agents that is no longer current, because TTAM stopped answering or the page
  lost its connection to TTasks, is shown muted with its age, never as what runs now.
- TTAM reads the agent apps' own session files on this computer, for every space, and opens each
  app's sign-in file to tell accounts apart, keeping no secret from it. While you look at the page,
  it asks how much of each account's plan is left, at most once a minute (a Claude account every
  five minutes): with the saved sign-in at the app's own usage service, or by starting the app's
  own program for a few seconds, which may then renew its own sign-in. No model turn is started.
- An agent shows with its task only when its agent app, its home and its session are those of a
  launch or a background run TTasks started for that task on this computer, within the last day or
  still running. After `/clear` in Claude Code the conversation is a new one and shows without a
  task, as does a Codex launch whose session was not found in its first two minutes. A conversation
  resumed within a day, in any terminal or folder, shows with the task it was started for.
- What TTAM reports about your agents, other projects' too, stays in TTasks and your own page: it
  is not given to agents' tools, not written into a space, a log or the browser's storage, and
  never leaves this machine.

## Opening a task in an agent app

- Open uses the folder that was set, or says that it is not there. It never picks another folder
  silently.
- Open and a background run start nothing in a folder that this machine marked for the task or
  its project when its marker is gone or now names only other projects, tasks or spaces. Open says
  so, and you choose to use the folder, which marks it, or to give the task another folder. A
  folder this machine never marked for it is marked at its next Open without a question, and so
  is the very folder that was marked when only its marker went (`git clean -x`) or changed. A
  folder made again at the same path, such as a fresh clone, asks, also when the machine was too
  busy to write the marker when the folder was set, and so does any folder whose marker went on a
  file system that records no creation time. A marker write given up after two seconds changes
  nothing in the folder afterwards. A folder replaced at its path while Open looks at it opens
  nothing, and the next Open asks about the new one.
- Opening with a particular account uses that account's settings of the agent app, and the agent
  is started with that home. A Claude Code instance with a home of its own gets none of your
  environment's variables that say which account or endpoint to use (every `ANTHROPIC_*`, and
  `CLAUDE_CODE_USE_*` and `CLAUDE_CODE_OAUTH_*`), so it works with the account signed in to that
  home; set one in the instance's `env` to use it there. The default home gets them as your setup
  gives them. Codex keeps its account in its home, and TTasks takes nothing away from a Codex
  instance's environment. Not protected: a federation profile shared by all homes can still
  outrank a home's own sign-in, and a cloud provider's own credentials (`AWS_*`, `GOOGLE_*`) stay,
  so an instance that selects that provider can use them.
- Open puts the brief in the agent's prompt box and waits for you to send it, so you can switch
  the model or add a word first: Claude Code, T3 Code, Claude Desktop and the Codex app. Codex has
  no way to wait, so Open sends the brief there as its first turn. So does a Claude Code older than
  2.1.332, or one whose version Open cannot read, and Open says so in the terminal and on the page.
  A background run starts working at once.
- Open sends a prompt to an agent only with everything its instance sets: its permission, extra
  arguments, environment and home. Where no way of opening here carries them, as a link or a
  desktop app, it opens without them, leaves the prompt for you to send, and says what it left
  out. A Claude Code instance with a home of its own never opens in the default account instead:
  where no terminal can start, Open starts nothing and says so. The desktop apps open with their
  own account, and Open says so.
- Open in T3 Code opens one thread on the task, in exactly its folder, with the brief in the
  composer unsent and the task's reference and title as its name. It opens on T3 Code's default
  profile and model, which you change in T3 Code. A folder that is no T3
  project's root or worktree is added to T3 Code's projects as it is, never opened in a project
  that only contains it, and removing it there is yours to do.
- That thread is the task's: Open again brings it forward, and the words you typed stay on the
  task as your note. The task's entry and the Agents page say whether its agent works, needs you
  or is idle, as T3 Code tells, with or without the Agent Monitor. A thread you delete or archive
  in T3 Code is noticed at the next Open, which makes a new one, and its entry says it ended. Not
  protected: a thread made in T3 Code itself is not the task's.
- A pairing with T3 Code is approved on T3 Code's own page and lasts the 30 days T3 Code gives it;
  then Open asks to pair again. TTasks keeps the pairing's token in its own state and never reads
  T3 Code's.
- An instance set for some spaces is offered, opens and runs only in those: a run queued before
  its spaces changed does not start.
- TTasks tells apart "asked the app to open" from "the agent connected", and says so when it does
  not know. An uncertain launch is never started a second time by itself.
- Restarting or updating TTasks does not end an agent it opened, and the agent stays its task's
  session. Nor does it end an app TTasks asked the system to open, such as the file manager. On
  Linux this needs systemd to give each terminal and each such app a scope of its own: where it
  cannot, a restart may end them, and `ttasks doctor` warns of that.
- The brief an agent gets when a task opens holds the task's reference and title, not its notes or
  sources, and Claude Code names its session after them. So the title stands on the agent's
  command line and in its session history, never in a link. A title changed later does not rename
  a session already open. Copy's words too long for it are kept as a note, never cut.
- The launch reference in a brief, such as `L7KQ2M`, is never given to another launch of the
  space, so an old brief never names a newer launch.
- What you type before Open never goes on a command line or into a link. It is saved on the task
  at the click, as your request to that agent, before anything starts: a launch that fails or a
  TTasks that stops does not lose it, and you take it back as any note. The agent reads it with the
  task.
  When Open gets no answer, pressing it again, also after a reload or in another tab of the
  browser, saves the words once and opens the agent once. The browser keeps that for a day.
- TTasks never changes another app's trust or approval settings.

## Background runs

- `ttasks run` starts an agent on a task in the task's folder, the one Open uses, and only you can
  start one. A run may do whatever your agent setup allows, without asking: the network, other
  folders, other agents. An instance's `run_permission` narrows that.
- A run starts in the space you named, with `--space` or `TTASKS_SPACE`, else in the default
  space, and `--wait` keeps following it there when the default changes. An answer longer than
  TTasks keeps is kept as its start, and showing it says so. A message of the agent is read whole
  up to 64 MiB, a text in it longer than 8 MiB as its start; a longer message, or a long one
  TTasks cannot read, ends the run at once as failed, with what the agent had said.
- Your request reaches the agent as you typed it: every character and line break inside it, every
  line's indent kept. The blank lines around it and spaces and tabs at its very end go, and so do
  characters that do not show, such as zero-width and direction marks. The composer clears only
  when it still holds what you sent, so an edit made meanwhile stays.
- Your request reaches the agent over its own connection, never on a command line. A run's
  answer, or the agent's question when it needs you, is kept in the run's record, and so is what
  the agent had written of its answer when Stop, a restart or its own end cut it short. A question
  from a helper the agent started does not reach you: that helper hears that no one answered.
- A run you start while an earlier run's question waits starts a new conversation with the agent,
  and is given the questions that waited when you started it, each quoted as the agent asked it,
  then your words; one dismissed or answered after that stays in it. Nothing else of the earlier
  run's conversation comes along.
- Stop ends the agent and everything it started, and the run is called ended only once the system
  confirms none of it is left. Where no process group can hold a run, it starts anyway, and Stop
  ends what TTasks could find of it: the run is called ended once the agent itself is gone, and a
  process the agent started that TTasks could not find may live on. On Linux and macOS such a
  run's process group is signalled once more the moment the agent's exit is seen; if the group
  had emptied by then, its number could in that instant belong to another program. After a
  restart of TTasks nothing of such a run can be found: it is called ended without being
  confirmed.
- A run that could not be confirmed stopped keeps its place until it is: the next run of its task
  waits for it, and Stop tries again.
- What a run's agent changes through TTasks's own tools is recorded as that run's.
- A Claude Code run gets TTasks's tools in a file in the run's folder. The file holds the run's
  ticket, which opens your space only while the run runs.
- A Claude Code run answers nothing for you: a question, an MCP tool's question, or an approval
  your Claude Code setup asks for under a narrower `run_permission`, ends the run as needing you,
  with what was asked and what it would act on. That permission uses Claude Code's own modes with
  your own tools and settings, so a tool you approved there stays approved. TTasks's own tools are
  allowed in every mode: the run reads its task and reports through them.
- A Codex run answers nothing for you either: a question ends the run as needing you, with what
  was asked. Codex is never asked for an approval: under a narrower `run_permission` its own
  sandbox refuses what that mode does not allow, the agent goes on without it, and the run says
  how many of its requests were refused.
- A run is done when its work is: work the agent left running in the background holds it until
  the agent reported on it, and a server it left running holds it until you stop it.
- No time limit ends a run unless you set one (`max_minutes`, `max_quiet_minutes` under `[runs]`
  in `machine.toml`). A run a limit ended is recorded so, also when TTasks restarts while it
  ends. A working run shows how long it has said nothing and what it said last, so
  you can use a server it keeps running, or stop it.
- A run's folder on this machine keeps the agent's raw output and its answer, which are task
  text. It is removed after 14 days or past the newest 200 runs, once the answer is in the run's
  record. The agent's own history, such as Codex's or Claude Code's sessions, keeps the run's
  conversation as it keeps any session of yours, and TTasks leaves it there.

## The page

- A field edit that failed or conflicted stays visible until you decide what to do with it, also
  after a reload, and so does one still waiting behind your previous edit when the page closed.
  Each tab's is kept on its own: two tabs' edits of one field both show under it, with their words.
  Try again sends it against what you saw when you made it, so a change made since is shown to you
  first. Another tab's edit, or a closed tab's, shows with Copy and Discard: to send its words,
  copy them into the field.
- A button on a task's row or card (the box, the star, a move, a status, the area, Move to Trash),
  a search result's included, changes the task as that row shows it. If someone changed it since,
  also while the row stayed under your focus, nothing is overwritten: the page says who changed it.
  An open card whose task the page cannot tell after it was away says so and offers nothing until
  it can.
- A field sends only what you typed in it. Going in and out of a field without typing sends
  nothing, and it then shows what is saved, also a change someone made while you were in it.
- Pressing Note or Run again after its answer was lost, also after a reload, makes one note or
  run. For Note this holds in the same browser under the same sign-in; for Run in the same browser
  within a day of the first press, also after signing in again.
- What you are typing in a field stays when an agent changes that field or finishes the task.
- A title you are typing and have not saved comes back in its editor after a reload or a crash of
  the tab, in that tab, and is saved only when you save it. Another tab shows it as typed there
  and does not erase it; on a task finished meanwhile it stays with Copy and Discard.
- A page left open moves on to a new day by itself: at midnight, within a minute of the computer
  waking, and when the tab is shown again, its views, a search and its dates follow the new day,
  and what you are typing, an open card and your place stay. The page counts days on the
  browser's calendar, its searches included; the command line and agents count them on the
  service machine's.
- Today's Changes and the Agents page list the tasks agents changed in the last seven days, read
  from the space when the page opens: a reload or another tab shows the same.
- Task text cannot run scripts or load remote images.
- A website you visit cannot read or change your tasks through the page.
- Logs hold no task text, and there is no telemetry. Task text leaves TTasks only where you send it:
  what you copy, and what an agent reads through its connection.
- What you type in the top field, a search included, stays out of the page's address, so a copied
  link and the browser's history list hold the search page but not your words. A reload, Back and
  Forward bring the search back in that tab; the search's link opened in another tab is an empty
  search.
- A paste into the top field that is more than a title loses no word: its first line becomes the
  title, and the rest is shown under the field and goes in the new task's context, also after a
  reload. A search keeps the first 500 characters and says so.
- The generated folder of readable files is not where tasks are stored. A file you edit or add
  there is kept or moved to a rescue folder, never deleted. A generated file that goes missing,
  removed by hand or by a sync, is written again within seconds while TTasks runs.

## Installing and updating

- TTasks installs for your account without administrator rights.
- Agent setup shows what it will change, changes only its own entry, and removes only what it
  wrote. What it gives you to add or take out by hand is the file and the entry, never a command,
  which would act on whatever account the shell you paste it into selects.
- An agent app gets TTasks's tools only once its entry is in place, and only from the change you
  asked for: a setup that did not finish is finished later only by taking its entry out, and the
  access too when that setup was the one turning it on. Turning them off takes the access away
  first, also when you changed the entry or its file cannot be read or written, and says what stays
  in each file; when TTasks's service does not confirm it, nothing else changes and you are told
  that it could not be confirmed, with what to do.
- An agent app's tools show as on only while they can start: its entry is there, the program it
  runs is there and its access is on. Otherwise the app says which is missing, and turning it on
  puts that back where it can be done from there; while a setup that did not finish may still take
  the access back, only turning it off is offered, which finishes it. While its access may still
  be on, or an entry setup wrote is still there, turning it off is offered, whatever else is
  missing.
- When setup cannot read its own record of an agent home, it changes no file that record covers:
  turning the tools off still takes the access away, and names each time the file whose entry stays
  and the record it cannot read. `ttasks doctor` says how to clean up.
- Claude Code reads its default folder's settings from `~/.claude.json`, and from
  `~/.claude/.claude.json` when a program starts it with that folder as its home. Setup puts its
  entry into each of the two that is there and takes it out of each, never creating the second;
  the app's row says which file lacks it and why.
- Applying writes what you were shown: when a settings file, `machine.toml` or an app's access
  changed since, nothing is written there and you see how it stands now.
- An update is checked before it runs. A failed update returns to the version before it.
- An install or an update that was cut off is finished or undone by the next one, or by the
  service. However often it is run again, and whatever is installed over it, `ttasks update
  --rollback` still goes back to the version that was current before it, passing over any
  version the service never ran. A version from before this rule cannot say whether it ran, and
  counts as one that did.
- Every update ends by asking the service, for up to 2 minutes, how each space opened. It names
  each space that is not usable now in the service's own words, which name the backup of a failed
  migration, says how to go back, and then exits 8. When the service stops answering, also before
  its first answer, it says the spaces could not be checked, and exits 8. When the service is not
  running, it says the spaces were not checked and what to run once it runs. It does not roll
  back by itself.
- An update restarts the service only once you agreed, asked before anything is stopped; without
  anyone to ask it stops before it changes anything. A repair you did not agree to restart leaves
  the service running, and the new version takes effect at its next start.
- An update does not end a background run unasked. It waits up to 15 minutes for running runs,
  then asks whether to stop them or give the update up; without anyone to ask, it gives up.
- An install over a running TTasks never restarts it unasked: it says that the old version still
  runs, and names the one command that restarts it. A restart ends background runs, which keep
  their answers so far.
- The updater leaves your spaces and settings alone. A new version may upgrade a space when it
  opens it, and rolling back the app does not undo that upgrade.

## Where the protection stops

- A program that runs as you, or an administrator of the machine, can read and change your
  spaces. TTasks guards against mistakes and against agents that are misled, not against software
  on your own machine that works against it on purpose.
- An agent with a shell can reach every space through the command line, also spaces outside its
  grant.
- An agent with a shell can edit your skill files, and every agent then follows the change.
- TTasks cannot make an agent ignore instructions hidden in a task, a mail or another source it
  reads.
- Undo and Restore do not unsend a mail, reverse a commit or undo anything done outside TTasks.
- Undo steps back through your own changes. A change by an agent or a script is not on it, and
  nothing from before the last upgrade that changed the data format can be undone.
- A new project or area whose creation you undid is archived, not gone: it is under Archived, and
  a new one of the same name in the same place finds it.
- Undo of a task's first area puts it back without an area at the end of that list, not at its
  earlier place.
- Undoing a reopen finishes the task again as yours; its wrap-up dates from its finish when it has
  outcome words, else from the Undo, as a dropped task's drop does.
- One copy of a space at a time holds for one TTasks service. Two services with homes of their own
  on one machine each keep their own list of spaces, and each can open a copy of the same space.
- Two copies of one space that both take changes, such as a restored copy and its original used
  in turn, give out references on their own: a task in one can get a reference a task in the
  other has. A restore over a space, or a claim of a copy, goes on from the backup's counter when
  the earlier space's database cannot be read at all.
- A command repeated without its request ID is a new change: a note added twice is there twice.
- A change that another version of TTasks saved, sent again with its request ID, is answered only
  as already applied, with the tasks and rows it made or changed: it writes nothing, whatever tool
  or body it is sent with, and the answer does not say what the change did to them.
- A project that is moved or reordered past the place a list of areas and projects has reached,
  while that list is read page by page, can be listed twice or not at all.
- Everything started inside a terminal agent while it runs counts as that task's session: a new
  conversation in the same window, a helper agent, or a program it leaves running.
- Changes by Claude Desktop, the Codex app, T3 Code for now, or an agent a brief was pasted into
  are recorded as that app's, not as a session of the task. Two hand-made entries of one app on
  different homes cannot be told apart.
- When another program, such as a virus scanner, holds the file of an agent TTasks opened for more
  than a few seconds as TTasks starts, that agent is not its task's session until TTasks starts
  again: a change it repeats after a lost reply can be written twice.
- A change retried after TTasks recorded its agent's end is a new change. A program the agent left
  running that connects after that, or a shell command, is recorded as the agent app or as an
  unknown agent, and has to name its task.
- A program an agent left running that was connected when the agent ended stays that agent's
  session until it disconnects. One that connects before TTasks has recorded the end does too.
  While the agent's space is closed, recording the end waits until it opens.
- An agent that sends a change with its tools and repeats it with `ttasks` in its shell is
  recognised only when TTasks opened that agent and both got its ticket. Otherwise the change can
  be written twice.
- When agent setup changes who an agent connects as while that agent runs, a change repeated
  through the new connection can be written twice.
- Chats of one agent app that are not sessions share their request IDs. A change sent with an ID
  another chat used is refused when it differs, and counted as already done when it is the same.
- An entry without a space uses the default space when its bridge process starts. If that process
  restarts after you change the default, the same task reference can mean a different task.
- A change retried after a restore that removed its earlier result is a new change.
- What you typed before Open is a note on the task: every agent that loads the task later reads it,
  marked as the request of that launch, and backups and exports hold it.
- Retracting a note does not reach an agent that already read it, a session that already has it,
  or what you copied. The history, backups and exports keep it.
- When the service or the machine crashes during a run, the run keeps its answer as of the agent's
  last finished message. What the agent was still writing is only in the run's raw output.
- Backups and exports are not encrypted. Their protection is that of the disk they are on.
- Backups are on the same disk as the TTasks home unless you set another folder for them or copy
  an export elsewhere. A lost disk, or removing both folders or the folder above them, loses them
  with the space.
- A space in a synced folder or on a network drive opens read-only, because a live database there
  can be damaged. For a synced folder you confirm once that it is excluded from sync. When the folder
  could not be checked, TTasks checks it again by itself for a few minutes and opens a local one for
  changes.
- An editor that had the configuration file open while TTasks recorded a space, and saves it
  afterwards, writes its own list of spaces back, and the next start follows that list.
- Claude Code started with `~/.claude` as its home may read an older settings file of its own there
  (`.config.json`) in place of `.claude.json`. Setup does not write that file, so a program that
  starts Claude Code that way may get no tools.
- Agent setup reads an agent app's settings file again just before it replaces it, and leaves a
  file that changed alone; a save another program makes in the instant between that read and the
  replacement is lost. For that read and the replacement setup holds Claude Code's own lock, for
  milliseconds: a Claude Code session that saves then waits, but Claude Code's start-up stops
  waiting after about 1.5 seconds, and for it only that last read protects the file.
- A file TTasks creates (its own `machine.toml`, an agent app's settings file) never replaces one
  that another program made meanwhile, except on a drive without hard links (FAT, exFAT, some
  network shares): there a file that appears in the instant before TTasks puts its own in place is
  replaced.
- On a machine that several people sign in to, another person could serve a page at TTasks's
  address while TTasks is stopped.
- Words you typed and did not send for a task in the Trash, or for one the space does not have now,
  stay in this browser, listed at the foot of the Trash with drafts, notes and field edits, until
  you discard them.
- A field edit that could not be saved is kept in this browser. Another browser does not have it,
  clearing the browser's data for the page loses it, and a browser whose storage is blocked or full
  keeps it only until the page is reloaded or closed.
- Restore compares folders by the text they were given in, not by what is on disk.
  One folder reached by two spellings, such as through a link, can end up on two projects that
  way.
- A folder on a drive or share that does not answer is refused after a few seconds, but the look
  at it keeps one of TTasks's file threads busy until the system gives up.
- A folder TTasks cannot write to, such as a read-only one, gets no marker and opens as before,
  without that check, and so does a folder whose marker cannot be read within two seconds. When
  Open asked about such a folder and you chose to use it, it does not ask again while it stays
  that folder.
- On a file system that records no creation time, a folder whose marker could not be written
  within two seconds when it was set is not protected: its next Open marks whatever folder is at
  the path then.
