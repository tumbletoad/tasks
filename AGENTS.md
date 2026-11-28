# TTasks

Agent-first task app by TumbleToad: Node 26 and TypeScript in a pnpm
monorepo. These notes are for people and coding agents alike.

If the git-ignored `local/AGENTS.md` exists, read it first: it holds this checkout's own setup.

## What to read
- `VISION.md`: how the product should feel and behave. Where two solutions both work, choose by
  it. Only the owner changes it.
- The code and its tests. They are the source of truth for how things work.
- `docs/promises-and-limits.md`: what a person can count on, and where the protection stops.
- `planning/PLAN.md`: what the product becomes and the steps there. `planning/STATUS.md`: the
  state of each step. The plan is a direction, never a reason to build or keep something you
  would not defend.

## How we work
- Build the best solution you can defend. When a plan, a rule, a comment, a test or existing code
  stands in the way of a better product, say so. Change it when it is yours to change. Propose it
  in your pull request when it is outside your task, also for code that was written earlier.
- Serve the common use, and leave the rare corner. A small, intuitive solution that serves how
  the product is normally used beats a complicated one that covers a little more: lean and 98%
  over ten times the rules and 99%. An unlikely corner case is left unhandled and stated as a
  limit in one line. A complicated solution is justified only where it gives near-complete
  coverage.
- Protect a person's work first. What ordinary use can turn into loss, damage or frustration is
  always fixed. For a case that needs two unlikely things at once, or a program on the same
  machine working against the product on purpose, take the cheap protection or none: no
  machinery, and no refusal, warning or extra step that every other person then meets.
- Fewer concepts, fewer steps, fewer refusals. Before you add a rule, a check, a setting or a
  warning that a person meets, ask who it helps in ordinary use and what it costs everyone else.
- Fix the cause. A workaround with a comment that explains it is still a defect.
- When a mistake keeps coming back, make it impossible, or make a type, a lint rule or a test catch
  it. A written rule is the last resort.
- When a second review finds more of the same kind of defect, change the design. After a second
  failed fix, ask whether the feature or the cleverness is needed at all.
- Limits on performance, memory and size are guidelines until real use. Functionality, usability,
  stability and maintainability come first.
- Rewrite when you find a better solution. Clean up what is finished, after looking at it, and
  only what this project made.

## Writing things down
- No new specification text. Behaviour lives in code and tests.
- Write prose only for what code cannot say: a promise to the person about their data, a limit
  (what is not protected), or how something should feel. One or two sentences, where a reader
  will look for it.
- A comment says why, when the code cannot: an invariant, a constraint that is not obvious. No
  history, no review stories, no restating the code, no citing plan sections. Remove comments that
  fail this in the files you touch.
- A test checks behaviour a person or a caller depends on, and survives a refactor that keeps that
  behaviour. A test that pins a detail of the implementation, a wording, or a rule that no longer
  makes sense holds the product back: change or remove it and say so in the pull request. Never
  weaken a test to hide a real defect.

## Doing the work
- Run everything through pnpm, never a bare `node`.
- Shapes live in `packages/contracts`. After changing one, run `pnpm gen` and commit the output.
- Every change to a space goes through an operation. There is no other write path.
- A schema change is a new migration step. One open pull request touches
  `packages/storage/migrations` at a time.
- Create files and folders through `packages/files`, so each gets its exact mode whatever the umask.
- No task text, prompts or tokens in logs, command lines or URLs; a task's title may stand in the
  session name and the brief of a session the person opens.
- A test that fails only under load assumes something about time or the machine: remove the
  assumption, not the assertion.
- Name a new dependency with its version and licence in the pull request.
- Work in your own folder. Delete it by its full name, and stop only processes you started.

## Verify and merge
- `pnpm verify` passes, on Windows from PowerShell 7. CI runs `pnpm e2e`; UI work runs it on Windows too.
- While you work, `pnpm check` runs what your change can affect, in about a minute, and lists what
  it did not run. It is not a verify: push, and CI runs everything.
- The pull request says what changed for a person and shows the evidence: the check's output with
  the OS, and for UI work screenshots of the states that changed. Say what you did not test.
- A question for the owner goes in the pull request with the default you chose. Carry on with it.
- Substantial changes get an independent review. It ranks findings by how likely a person is to
  run into them and what it costs them. It holds a change only for what ordinary use meets, and
  notes a rare corner in one line.
- Work on branches and merge through pull requests. Merge main into the branch first. Name the
  files in every commit: never `git add -A`.
- A pull request lands on main as one commit (a squash merge), so every commit on main is a
  state that passed CI. Its title becomes that commit's subject and its description the body:
  write both to be read in the history. Start a branch from main, not from a branch that has
  not merged.
- Names come from `packages/brand`.

## Never
- push to main, rewrite published history or skip hooks;
- make, move or delete a release tag (`v*`), or start a release in any other way: only the owner releases;
- delete a person's data or a backup as a side effect of something else;
- put real task data, real names of people or organisations, or facts about a person's machines,
  accounts or paths in the repository, its logs, fixtures, screenshots or pull requests;
- open, copy, move or print an agent app's sign-in file or token, or look for an API key;
- change another app's trust or approval settings;
- create a user account on a real machine.
