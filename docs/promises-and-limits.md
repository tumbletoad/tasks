# What Tasks promises, and what it does not

The code and its tests say how Tasks works. This page says what a person can count on, and where
the protection stops. It lists only what is built. Change a line here in the same pull request as
the behaviour it describes, and keep each one to a sentence or two.

## Your tasks and their history

- An edit never silently overwrites a change to the same field that you had not seen. You are
  shown both values and choose.
- Changes sent together are saved together, or not at all.
- A change that was reported as saved survives a crash of Tasks.
- A change sent again with the same request ID after a lost reply is applied once. The page and the
  agent tools resend that way by themselves. At the command line, repeat the command with the
  `--request-id` that the failed command named.
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
  `tasks space backup`.
- While a space is open for changes, Tasks backs it up once a day. It keeps the backups of seven
  recent days and four recent weeks, and removes older scheduled ones. Backups you make by hand
  stay until you remove them.
- When a daily backup fails, or the newest backup does not pass a trial restore, `tasks doctor`,
  `tasks space list` and the page's space switcher say so and what to do, until a backup succeeds
  again.
- Clean-up never removes the newest backup that restores.
- Making a backup or an export never overwrites an existing file.
- A restore checks the backup first. A backup that is broken or too new leaves nothing half
  restored.
- Restoring over a space keeps what was there before.
- A restored copy cannot be edited until you make it the current copy.
- Apart from that clean-up of scheduled backups, Tasks never deletes your data or a backup as a
  side effect of something else.
- An export that holds text shaped like a known kind of secret, such as an access token or a
  private key, is still written, and says what kind it is and where, without printing it.
- A space is upgraded only after a backup of it has passed a trial restore. A failed upgrade
  leaves the old data readable.
- An older version of Tasks never writes a newer data format.

## Your spaces on this computer

- A space you create, open, restore or claim opens again after a restart, and one you close stays
  closed. Tasks never takes a space off its list by itself.
- Recording this keeps your own comments and settings in the configuration file. When the file
  cannot be written, Tasks says so and names the command that records it once the file is fixed.
- When several copies of one space are on this computer, a command without a folder reaches the
  copy that takes changes, and after a restart that is still the copy you last changed.

## Projects and folders

- A project has at most one folder on each computer, and a task may have its own. Two projects
  that are not deleted never share one folder on one computer: adding a folder that a project has
  answers with that project instead of making a second one.
- A new task that an agent files from its working folder, with no project named, joins the project
  whose folder holds that folder most closely. In an archived project's folder it joins no project,
  and the agent is told.
- When you move a folder on disk and then give its project or task the new folder, every folder
  Tasks knows inside the old one moves along, other projects' and tasks' included, as one undo
  step on that computer. When the old folder is still there, nothing else moves, and you are told
  which folders stayed. Tasks itself never moves files.
- An archived project keeps its folder, and a deleted one frees it.
- A project made for a folder is named after it unless you name it. The Git repository in a
  project's folder is shown by name only, never by its address.
- Tasks leaves a small `.tasks-marker` folder in each project's and task's folder, holding only
  which space and project or task it belongs to, and ignored by Git. Clearing the folder in Tasks
  removes it.
- Tasks never makes a folder for an agent. At the command line, `--create` makes it when you ask,
  and in the page's folder chooser "Make the folder" does; an undo leaves it on disk.
- The page's folder chooser lists the names of folders on this computer to you alone, never to an
  agent's tools, and never reads a file. A folder that answers slowly is listed as far as it read in
  two seconds, and a very large one up to its first 20,000 entries.
- No folder inside Tasks' own data is taken: an agent working there would change it.
- A folder is a local path, not a secret. It travels with sync, backups and exports, and a message
  or a history entry may name it.

## Agents

- An agent that uses Tasks cannot start other agents, raise its own permissions or change your
  settings for what agents may do.
- An agent's session stays in the space it started in when you switch space.
- An agent that reaches Tasks through its registered connection reaches only the spaces you
  granted it.
- A change by an agent or a script is never recorded as yours.
- Every note is visible to agents.

## Opening a task in an agent app

- Open uses the folder that was set, or says that it is not there. It never picks another folder
  silently.
- Open and a background run start nothing in a folder that this computer marked for the task or
  its project when its marker is gone or now names only other projects, tasks or spaces. Open says
  so, and you choose to use the folder, which marks it, or to give the task another folder. A
  folder this computer never marked for it is marked at its next Open without a question.
- Opening with a particular account uses that account's settings of the agent app.
- Tasks tells apart "asked the app to open" from "the agent connected", and says so when it does
  not know. An uncertain launch is never started a second time by itself.
- Restarting or updating Tasks does not end an agent session it opened. On Linux this needs
  systemd to give each terminal a scope of its own: where it cannot, a restart may end the sessions
  in the terminals Tasks opened, and `tasks doctor` warns of that.
- The brief an agent gets when a task opens holds the task's title and reference, not its notes or
  sources. An instruction too long for it is kept as a note, never cut.
- Tasks never changes another app's trust or approval settings.

## Background runs

- `tasks run` starts an agent on a task in the task's folder, the one Open uses, and only you can
  start one. A run may do whatever your agent setup allows, without asking: the network, other
  folders, other agents. An instance's `run_permission` narrows that.
- Your request reaches the agent over its own connection, never on a command line. A run's
  answer, or the agent's question when it needs you, is kept in the run's record. A question
  from a helper the agent started does not reach you: that helper hears that no one answered.
- Stop ends the agent and everything it started, and the run is called ended only once the system
  confirms none of it is left. Where no process group can hold a run, it starts anyway, and Stop
  ends what Tasks could find of it: a process the agent detached from it may live on.
- What a run's agent changes through Tasks' own tools is recorded as that run's.
- A run's folder on this computer keeps the agent's raw output and its answer, which are task
  text. It is removed after 14 days or past the newest 200 runs, once the answer is in the run's
  record. The agent's own history, such as Codex's sessions, keeps the run's conversation as it
  keeps any session of yours, and Tasks leaves it there.

## The page

- An edit that failed or conflicted stays visible until you decide what to do with it.
- What you are typing in a field stays when an agent changes that field or finishes the task.
- Task text cannot run scripts or load remote images.
- A website you visit cannot read or change your tasks through the page.
- Logs hold no task text, and there is no telemetry. Task text leaves Tasks only where you send it:
  the brief to the agent app you open a task in, and what an agent reads through its connection.
- The generated folder of readable files is not where tasks are stored. A file you edit or add
  there is kept or moved to a rescue folder, never deleted.

## Installing and updating

- Tasks installs for your account without administrator rights.
- Agent setup shows what it will change, changes only its own entry, and removes only what it
  wrote.
- An update is checked before it runs. A failed update returns to the version before it.
- An update does not end a background run unasked. It waits up to 15 minutes for running runs,
  then asks whether to stop them or give the update up; without anyone to ask, it gives up.
- An install over a running Tasks never restarts it unasked: it says that the old version still
  runs, and names the one command that restarts it. A restart ends background runs, which keep
  their answers so far.
- The updater leaves your spaces and settings alone. A new version may upgrade a space when it
  opens it, and rolling back the app does not undo that upgrade.

## Where the protection stops

- A program that runs as you, or an administrator of the computer, can read and change your
  spaces. Tasks guards against mistakes and against agents that are misled, not against software
  on your own computer that works against it on purpose.
- An agent with a shell can reach every space through the command line, also spaces outside its
  grant.
- Tasks cannot make an agent ignore instructions hidden in a task, a mail or another source it
  reads.
- Undo does not unsend a mail, reverse a commit or undo anything done outside Tasks.
- Undo steps back through your own changes. A change by an agent or a script is not on it, and
  nothing from before the last upgrade that changed the data format can be undone.
- Two copies of one space that both take changes, such as a restored copy and its original used
  in turn, give out references on their own: a task in one can get a reference a task in the
  other has. A restore over a space, or a claim of a copy, goes on from the backup's counter when
  the earlier space's database cannot be read at all.
- A command repeated without its request ID is a new change: a note added twice is there twice.
- Backups and exports are not encrypted. Their protection is that of the disk they are on.
- Backups sit beside the space on the same disk unless you set another folder for them or copy an
  export elsewhere. A lost disk then loses them with the space.
- A space in a synced folder or on a network drive opens read-only, because a live database there
  can be damaged. For a synced folder you confirm once that it is excluded from sync. When the folder
  could not be checked, Tasks checks it again by itself for a few minutes and opens a local one for
  changes.
- An editor that had the configuration file open while Tasks recorded a space, and saves it
  afterwards, writes its own list of spaces back, and the next start follows that list.
- On a computer that several people sign in to, another person could serve a page at Tasks'
  address while Tasks is stopped.
- An edit that could not be saved is kept in the open page. Reloading the page loses it.
- Undo, redo and restore compare folders by the text they were given in, not by what is on disk.
  One folder reached by two spellings, such as through a link, can end up on two projects that
  way.
- A folder on a drive or share that does not answer is refused after a few seconds, but the look
  at it keeps one of Tasks' file threads busy until the system gives up.
- A folder Tasks cannot write to, such as a read-only one, gets no marker and opens as before,
  without that check, and so does a folder whose marker cannot be read within two seconds. A
  marker deleted by hand, or by `git clean -x`, is missed once, at the next Open.
