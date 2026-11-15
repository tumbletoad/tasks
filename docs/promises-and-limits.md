# What Tasks promises, and what it does not

The code and its tests say how Tasks works. This page says what a person can count on, and where
the protection stops. It lists only what is built. Change a line here in the same pull request as
the behaviour it describes, and keep each one to a sentence or two.

## Your tasks and their history

- An edit never silently overwrites a change to the same field that you had not seen. You are
  shown both values and choose.
- Changes sent together are saved together, or not at all.
- A change that was reported as saved survives a crash of Tasks.
- Sending the same change again after a lost reply never applies it twice.
- Every change keeps what changed and who made it: you, an agent, or a script.
- Undo and redo never replace someone else's work that came in between.
- Your undo history survives a restart and is shared by your windows and the command line.
- Checking off a task completes it at once and can be undone.
- Wrapping up a task keeps its context, notes, activity and sources. Reopening keeps the earlier
  outcome and what was learned.
- Deleting a task keeps its contents and history recoverable. Nothing empties the trash by itself.
- A task's reference, such as M-14, is never given to another task.
- Adding work that is already recorded from the same source finds the existing task and keeps its
  fields.

## Backups, restore and export

- A backup stays consistent while people and agents change tasks.
- A backup that is called verified has passed a trial restore.
- A space gets a backup every day on the computer that owns it. Seven daily and four weekly
  backups are kept, and backups you make by hand stay until you remove them.
- Clean-up never removes the newest backup that restores.
- Making a backup or an export never overwrites an existing file.
- A restore checks the backup first. A backup that is broken or too new leaves nothing half
  restored.
- Restoring over a space keeps what was there before.
- A restored copy cannot be edited until you make it the current copy.
- Tasks never deletes your data or a backup as a side effect of something else.
- An export refuses text that looks like a secret and says what kind it is and where, without
  printing it.
- A space is upgraded only after a backup of it has been made and verified. A failed upgrade leaves
  the old data readable.
- An older version of Tasks never writes a newer data format.

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
- Opening with a particular account uses that account's settings of the agent app.
- Tasks tells apart "asked the app to open" from "the agent connected", and says so when it does
  not know. It never repeats an uncertain launch by itself.
- Restarting or updating Tasks does not end an agent session it opened.
- The brief an agent gets when a task opens holds the task's title and reference, not its notes or
  sources. An instruction too long for it is kept as a note, never cut.
- Tasks never changes another app's trust or approval settings.

## The page

- An edit that failed or conflicted stays visible until you decide what to do with it.
- What you are typing in a field stays when an agent changes that field or finishes the task.
- Task text cannot run scripts or load remote images.
- A website you visit cannot read or change your tasks through the page.
- Logs hold no task text. Nothing is sent anywhere: there is no telemetry.
- The generated folder of readable files is not where tasks are stored. A file you edit or add
  there is kept or moved to a rescue folder, never deleted.

## Installing and updating

- Tasks installs for your account without administrator rights.
- Agent setup shows what it will change, changes only its own entry, and removes only what it
  wrote.
- An update is checked before it runs. A failed update returns to the version before it.
- Updating and rolling back leave your data alone.

## Where the protection stops

- A program that runs as you, or an administrator of the computer, can read and change your
  spaces. Tasks guards against mistakes and against agents that are misled, not against software
  on your own computer that works against it on purpose.
- An agent with a shell can reach every space through the command line, also spaces outside its
  grant.
- Tasks cannot make an agent ignore instructions hidden in a task, a mail or another source it
  reads.
- Undo does not unsend a mail, reverse a commit or undo anything done outside Tasks.
- Backups and exports are not encrypted. Their protection is that of the disk they are on.
- Backups stay on the same computer unless you copy an export elsewhere. A lost disk loses them
  with the space.
- A space in a synced folder or on a network drive opens read-only, because a live database there
  can be damaged. For a synced folder you confirm once that it is excluded from sync.
- On a computer that several people sign in to, another person could serve a page at Tasks'
  address while Tasks is stopped.
- An edit that could not be saved is kept in the open page. Reloading the page loses it.
