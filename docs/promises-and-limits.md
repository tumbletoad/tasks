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
  through the same connection, or through the tools and the shell of one agent TTasks opened. The
  page and the agent tools resend that way by themselves. At the command line, repeat the command
  with the `--request-id` that the failed command named.
- Every change keeps what changed and who made it: you, an agent, or a script.
- Undo and redo never replace someone else's work that came in between, also when that work set a
  value and set it back.
- Your undo history survives a restart and is shared by your windows and the command line.
- Checking off a task completes it at once and can be undone.
- Wrapping up a task keeps its context, notes, activity and sources. Reopening keeps the earlier
  outcome and what was learned.
- Deleting a task keeps its contents and history recoverable. Nothing empties the trash by itself.
- A task's reference, such as M-14, is not given to another task when the task is deleted or its
  creation is undone, when a backup is restored over the space, or when a restored copy is claimed.
- Adding work by a source that an open task or a recently finished one already has finds that task
  and keeps its fields. A task finished longer ago or a deleted one does not stand in the way of
  new work.
- Work recreated from another tool can keep when each task was created and finished and when each
  log entry was made. A time in the future is refused. Such a task finished long ago is still
  found by its source for the usual number of days after it was recorded here, so a second pass
  creates nothing.
- New work that also names a source of its own is never folded into the task that holds a shared
  one, such as a ticket two tasks are about: it becomes its own task, linked to the shared source,
  and the answer says which task holds that source.

## Backups, restore and export

- A backup stays consistent while people and agents change tasks.
- A backup that is called verified has passed a trial restore. So has every backup you make with
  `ttasks space backup`.
- While a space is open for changes, TTasks backs it up once a day. It keeps the backups of seven
  recent days and four recent weeks, and removes older scheduled ones. Backups you make by hand
  stay until you remove them.
- When a daily backup fails, or the newest backup does not pass a trial restore, `ttasks doctor`,
  `ttasks space list` and the page's space switcher say so and what to do, until a backup succeeds
  again.
- Clean-up never removes the newest backup that restores.
- Making a backup or an export never overwrites an existing file.
- A restore checks the backup first. A backup that is broken or too new leaves nothing half
  restored.
- Restoring over a space keeps what was there before.
- A restored copy cannot be edited until you make it the current copy.
- Apart from that clean-up of scheduled backups, TTasks never deletes your data or a backup as a
  side effect of something else.
- An export that holds text shaped like a known kind of secret, such as an access token or a
  private key, is still written, and says what kind it is and where, without printing it.
- A space is upgraded only after a backup of it has passed a trial restore. A failed upgrade
  leaves the old data readable.
- An older version of TTasks never writes a newer data format.

## Your spaces on this machine

- A space you create, open, restore or claim opens again after a restart, and one you close stays
  closed. TTasks never takes a space off its list by itself.
- Recording this keeps your own comments and settings in the configuration file. When the file
  cannot be written, TTasks says so and names the command that records it once the file is fixed.
- When several copies of one space are on this machine, a command without a folder reaches the
  copy that takes changes, and after a restart that is still the copy you last changed.

## Projects and folders

- A project has at most one folder on each machine, and a task may have its own. Two projects
  that are not deleted never share one folder on one machine: adding a folder that a project has
  answers with that project instead of making a second one.
- A new task that an agent files from its working folder, with no project named, joins the project
  whose folder holds that folder most closely. In an archived project's folder it joins no project,
  and the agent is told.
- When you move a folder on disk and then give its project or task the new folder, every folder
  TTasks knows inside the old one moves along, other projects' and tasks' included, as one undo
  step on that machine. When the old folder is still there, nothing else moves, and you are told
  which folders stayed. TTasks itself never moves files.
- An archived project keeps its folder, and a deleted one frees it.
- A project made for a folder is named after it unless you name it. The Git repository in a
  project's folder is shown by name only, never by its address.
- TTasks leaves a small `.ttasks-marker` folder in each project's and task's folder, holding only
  which space and project or task it belongs to, and ignored by Git. Clearing the folder in TTasks
  removes it.
- TTasks never makes a folder for an agent. At the command line, `--create` makes it when you ask,
  and in the page's folder chooser "Make the folder" does; an undo leaves it on disk.
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
- Every note is visible to agents.
- Your skills, the files in `skills/` of TTasks's folder, are your instructions to every agent that
  uses TTasks, as a note for agents is. No agent tool creates or changes one. A file over 16 KB, an
  empty one, one that cannot be read or a link is not used at all, and agents and `ttasks skills`
  say why. `ttasks skills copy` never replaces a copy you edited.
- Agents are told to give a task they add the priority your `setting-priority` skill describes,
  and to change the priority, due date or star of a task that exists only when you ask. It is an
  instruction, not a lock: TTasks does not refuse such a change.

## Agents on this computer

- TTasks runs the Agent Monitor (TTAM) only while it is asked for what agents run here, and ends it
  ten minutes after the last question and when TTasks stops.
- What TTAM reports about your agents, other projects' too, stays in TTasks and your own page: it
  is not given to agents' tools, not written into a space or a log, and never leaves this machine.

## Opening a task in an agent app

- Open uses the folder that was set, or says that it is not there. It never picks another folder
  silently.
- Open and a background run start nothing in a folder that this machine marked for the task or
  its project when its marker is gone or now names only other projects, tasks or spaces. Open says
  so, and you choose to use the folder, which marks it, or to give the task another folder. A
  folder this machine never marked for it is marked at its next Open without a question, and so
  is the very folder that was marked when only its marker went (`git clean -x`). A folder made
  again at the same path, such as a fresh clone, asks, and so does any folder whose marker went on
  a file system that records no creation time.
- Opening with a particular account uses that account's settings of the agent app.
- TTasks tells apart "asked the app to open" from "the agent connected", and says so when it does
  not know. An uncertain launch is never started a second time by itself.
- Restarting or updating TTasks does not end an agent it opened, and the agent stays its task's
  session. On Linux this needs systemd to give each terminal a scope of its own: where it cannot, a
  restart may end the agents in the terminals TTasks opened, and `ttasks doctor` warns of that.
- The brief an agent gets when a task opens holds the task's reference, not its title, notes or
  sources. Copy's words too long for it are kept as a note, never cut.
- The launch reference in a brief, such as `L7KQ2M`, is never given to another launch of the
  space, so an old brief never names a newer launch.
- What you type before Open never goes on a command line or into a link. It is saved on the task
  at the click, as your request to that agent, before anything starts: a launch that fails or a
  TTasks that stops does not lose it, and one undo takes it back. The agent reads it with the task.
  When Open gets no answer, pressing it again, also after a reload or in another tab of the
  browser, saves the words once and opens the agent once. The browser keeps that for a day.
- TTasks never changes another app's trust or approval settings.

## Background runs

- `ttasks run` starts an agent on a task in the task's folder, the one Open uses, and only you can
  start one. A run may do whatever your agent setup allows, without asking: the network, other
  folders, other agents. An instance's `run_permission` narrows that.
- Your request reaches the agent over its own connection, never on a command line. A run's
  answer, or the agent's question when it needs you, is kept in the run's record. A question
  from a helper the agent started does not reach you: that helper hears that no one answered.
- Stop ends the agent and everything it started, and the run is called ended only once the system
  confirms none of it is left. Where no process group can hold a run, it starts anyway, and Stop
  ends what TTasks could find of it: a process the agent detached from it may live on.
- What a run's agent changes through TTasks's own tools is recorded as that run's.
- A Claude Code run gets TTasks's tools in a file in the run's folder. The file holds the run's
  ticket, which opens your space only while the run runs.
- A Claude Code run answers nothing for you: a question, an MCP tool's question, or an approval
  your Claude Code setup asks for under a narrower `run_permission`, ends the run as needing you,
  with what was asked and what it would act on. That permission uses Claude Code's own modes with
  your own tools and settings, so a tool you approved there stays approved. TTasks's own tools are
  allowed in every mode: the run reads its task and reports through them.
- A run is done when its work is: work the agent left running in the background holds it until
  the agent reported on it, and a server it left running holds it until you stop it.
- No time limit ends a run unless you set one (`max_minutes`, `max_quiet_minutes` under `[runs]`
  in `machine.toml`). A working run shows how long it has said nothing and what it said last, so
  you can use a server it keeps running, or stop it.
- A run's folder on this machine keeps the agent's raw output and its answer, which are task
  text. It is removed after 14 days or past the newest 200 runs, once the answer is in the run's
  record. The agent's own history, such as Codex's or Claude Code's sessions, keeps the run's
  conversation as it keeps any session of yours, and TTasks leaves it there.

## The page

- A field edit that failed or conflicted stays visible until you decide what to do with it, also
  after a reload, and so does one still waiting behind your previous edit when the page closed. Try
  again sends it against what you saw when you made it, so a change made since is shown to you
  first.
- Pressing Note or Run again after its answer was lost, also after a reload, makes one note or
  run. For Note this holds in the same browser under the same sign-in; for Run in the same browser
  within a day of the first press, also after signing in again.
- What you are typing in a field stays when an agent changes that field or finishes the task.
- Task text cannot run scripts or load remote images.
- A website you visit cannot read or change your tasks through the page.
- Logs hold no task text, and there is no telemetry. Task text leaves TTasks only where you send it:
  what you copy, and what an agent reads through its connection.
- The generated folder of readable files is not where tasks are stored. A file you edit or add
  there is kept or moved to a rescue folder, never deleted.

## Installing and updating

- TTasks installs for your account without administrator rights.
- Agent setup shows what it will change, changes only its own entry, and removes only what it
  wrote.
- An update is checked before it runs. A failed update returns to the version before it.
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
- Undo does not unsend a mail, reverse a commit or undo anything done outside TTasks.
- Undo steps back through your own changes. A change by an agent or a script is not on it, and
  nothing from before the last upgrade that changed the data format can be undone.
- Two copies of one space that both take changes, such as a restored copy and its original used
  in turn, give out references on their own: a task in one can get a reference a task in the
  other has. A restore over a space, or a claim of a copy, goes on from the backup's counter when
  the earlier space's database cannot be read at all.
- A command repeated without its request ID is a new change: a note added twice is there twice.
- Everything started inside a terminal agent while it runs counts as that task's session: a new
  conversation in the same window, a helper agent, or a program it leaves running.
- Changes by Claude Desktop, the Codex app, T3 Code for now, or an agent a brief was pasted into
  are recorded as that app's, not as a session of the task. Two hand-made entries of one app on
  different homes cannot be told apart.
- An agent running across the one update that brought this rule comes back as its app and names
  its task. One whose entry names no space works in no space after the update, and after a later
  restart of TTasks it can take the default space of that moment: restart agent apps after this
  update.
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
  marked as the request of that launch, and backups and exports hold it. Undo takes it back while
  it is your newest change; the page has no way yet to remove an older note.
- Backups and exports are not encrypted. Their protection is that of the disk they are on.
- Backups sit beside the space on the same disk unless you set another folder for them or copy an
  export elsewhere. A lost disk then loses them with the space.
- A space in a synced folder or on a network drive opens read-only, because a live database there
  can be damaged. For a synced folder you confirm once that it is excluded from sync. When the folder
  could not be checked, TTasks checks it again by itself for a few minutes and opens a local one for
  changes.
- An editor that had the configuration file open while TTasks recorded a space, and saves it
  afterwards, writes its own list of spaces back, and the next start follows that list.
- On a machine that several people sign in to, another person could serve a page at TTasks's
  address while TTasks is stopped.
- A field edit that could not be saved is kept in this browser. Another browser does not have it,
  clearing the browser's data for the page loses it, and a browser whose storage is blocked or full
  keeps it only until the page is reloaded or closed. When two tabs hold different unsaved values
  for the same field of a task, the browser keeps one of them.
- Undo, redo and restore compare folders by the text they were given in, not by what is on disk.
  One folder reached by two spellings, such as through a link, can end up on two projects that
  way.
- A folder on a drive or share that does not answer is refused after a few seconds, but the look
  at it keeps one of TTasks's file threads busy until the system gives up.
- A folder TTasks cannot write to, such as a read-only one, gets no marker and opens as before,
  without that check, and so does a folder whose marker cannot be read within two seconds.
