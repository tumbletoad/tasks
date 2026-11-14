# TT Tasks

Agent-first task app by TumbleToad, called Tasks inside the app: Node 26 and TypeScript in a pnpm
monorepo. The rules below are for people and coding agents alike.

If the git-ignored `local/AGENTS.md` exists, read it first: it holds this checkout's machine setup
and workflow.

## Start here
- `planning/PLAN.md`: the decisions, an architecture overview and the milestone order. The owner's
  decisions (A.1) carry the most weight.
- `planning/appendix/`: the specifications A1 to A7, which win on specifics. A7 lists every step.
- `planning/STATUS.md`: one row per step, and the open real-machine sessions with the owner.
- `VISION.md`: the intended experience. Where the plan is silent, or two options both fit it,
  choose by the vision. It adds no features. Only the owner changes it.
- This file wins over conflicting process rules in a specification.

## Principles
- The plan is a guide, not a contract. When something blocks, find another solution faithful to
  the vision and write it into the specification.
- Keep the core lean: a feature outside the plan needs a clear reason in its pull request and
  specification.
- Limits on performance, latency, memory and token counts are guidelines until real use (PLAN
  D26). Aim for them and report a breach, but keep a feature that is better or more complete over
  a limit. Functionality, usability, stability, flexibility and maintainability come first.
- Rewrite when you find a better solution. Do not keep a weaker design for history.
- Clean up what is finished (merged branches, worktrees, scratch folders, test installs, files
  that only served a finished step), after looking at it, and only what this project made.
- Work in your own folder. Delete it only by its full name, never its parent, and stop only
  processes whose PID you recorded.

## Decisions
- A decision changes the specification section it belongs to, in the same pull request as the
  code (a new choice gets a section in the closest one). The documents state current rules only,
  with no history. A reason that prevents a likely mistake stays as one sentence beside its rule.
- Section numbers and IDs (D, R, step and test IDs) are cited by code and tests: never renumber or
  reuse one. A section that code, tests or `tests/manifest.json` cite stays, if only short.
- Put a question for the owner in the pull request with the default you chose, and continue on it.

## Do a step
1. Pick a `ready` step in `planning/STATUS.md` (or one whose code exists on a branch) and set it
   to `doing`. Read the step in A7, then only the sections it cites.
2. One step per branch (`m<N>/<nn>-<slug>`), one worktree and one pull request.
3. Write the failing test from the step's Verify line first.

- Run everything through pnpm, never a bare `node`: a system Node may be another version.
- Shapes live only in `packages/contracts`. After changing an entry, run `pnpm gen` and commit the
  output. Keep contract changes additive: other open pull requests may touch contracts too.
- Only one open pull request may touch `packages/storage/migrations` at a time. Released schemas
  (0.1, 0.2) are frozen: a schema change is a new migration step.
- Create files and folders through `packages/files` (in storage, its own helpers): each new object
  gets its exact mode whatever the umask. Never call `process.umask()`.
- Every change to a space goes through an operation (A1 3.7). There is no other write path.
- Every new test carries its ID from `tests/manifest.json`. One without fails `pnpm verify`.
- A test file creates nothing at module level: Vitest's collection runs the top level without its
  hooks. Make temporary folders in `beforeAll` and remove them in `afterAll`.
- No task text, prompts, briefs or tokens in logs, argv, URLs or snapshots.
- Name every new dependency with its version and licence in the pull request.
- Real-machine results and committed recordings hold facts only (an exit code, a yes or no, a
  count, a class), never a CLI's, model's or OS's own output: account names,
  paths and credentials hide in it.
- A test that fails only under load assumes something about time or the machine: remove that,
  never the assertion.
- When a second review round finds more of one class of defect, change the design.
- A step behind an open lab gate (A7 3.7) is built to the lab's findings, and its pull request
  lists what waits for a real-machine session.
- Browser automation uses a scratch profile and leaves others' tabs alone.

## Verify and merge
- `pnpm verify` passes. On Windows, run it from PowerShell 7 (`pwsh -NoProfile`).
- UI steps: `pnpm e2e` passes and you looked at the screenshots.
- CI runs the checks on Ubuntu and Windows for every pull request. Platform code (paths,
  processes, sockets, terminals, install, launch) is also checked by the owner on a real Linux machine.
- Paste the Verify output into the pull request, with the OS, and say what you did not test.
- Substantial changes get an independent review before merging: storage, protocol, security,
  migrations, launch, and anything over a few hundred lines. Fix or answer every finding.
- Before merging, merge main into the branch: merge `tests/manifest.json` by entry ID, keeping both
  sides, and run `pnpm install` after a lockfile merge.

## Git
- Work on branches and merge through pull requests. Commit messages are short and imperative.
- Name the files in every commit and look at `git status` first. Never `git add -A`.
- Every name comes from `packages/brand`: visible ones from its display names, the rest (HTTP
  headers too) from the identifier `tasks`.

## Never
- push directly to main, rewrite published history or skip hooks;
- weaken or delete a test to make it pass;
- delete a person's data or a backup as a side effect of another operation. Reuse what exists,
  retire and keep what is replaced, and report where it is. Removal outside the stated retention
  policy is the person's explicit act;
- accept a configuration file or folder that is a symbolic link: a suggested repair would change
  the link's target;
- put real task data, or real names of people, employers or customers, in the repository, logs,
  fixtures, screenshots, prompts to outside services or web searches. Tests use fixture data and
  a temporary `TASKS_HOME`;
- put machine or personal facts in the repository: addresses, logins, machine names, paths under
  a user's profile;
- open, copy, move or print an agent app's sign-in file or token, or look for an API key. A copy
  that refreshes its token can sign out live sessions;
- change another app's trust or approval settings, or a managed instruction file. Tasks registers
  its MCP server only through `tasks setup agents`, with a preview and exact removal;
- create a user account on a real machine. Second-user tests run only in CI;
- plan in calendar time: plans give order, dependencies and parallel lanes.
