# The trial of the library

Step 1's trial: do agents use and keep the library when TTasks gives it to them? Twenty
scripted tasks run in order as background runs in one project of a temporary space. CI never
runs this. Its result is in `docs/planning/STATUS.md`, and step 3.3 runs its tasks again.

## How to run

```
pnpm trial --stand-in
pnpm trial --instances agents.toml --agents claude,codex [--tasks 400] [--repeats 3]
           [--only 1,2,9] [--out DIR] [--keep]
```

`--stand-in` runs against the run tests' fake Claude Code, which makes each task's calls as
scripted in `tasks.ts`. It checks the trial itself, costs nothing, and takes about a minute.

For real agents, `agents.toml` holds machine.toml `[[instance]]` tables, for example:

```toml
[[instance]]
id = "claude"
target = "claude-cli"
label = "Claude Code"
run_permission = "read-only"

[[instance]]
id = "codex"
target = "codex-cli"
label = "Codex"
run_permission = "read-only"
args_prefix = ["--disable", "apps"]
```

The trial refuses an instance that is not read only, and a Codex instance without
`"--disable", "apps"`: the agent works in the person's own profile, where write access once let it
edit a repository of theirs and Codex's app connectors searched the account's connected services.
A model goes in `args_prefix` too (`"--model", "..."` for Claude Code, `"-c", 'model="..."'` for
Codex). Read only, Claude Code stops at a read outside the run's folder: `--add-dir` there names the
folders its own instructions read. The trial never writes into an agent's home. Each world is a
new TTasks home in a temporary folder. The agent's program keeps its own sign-in, and the run's
tools come from the run's own folder. Run it against a real agent only with the owner's word: it
spends their subscription.

Every world seeds a space with `--tasks` tasks. It then adds project Trial in area Lumen, with:

- pages on the space, the area and the project;
- a finished sibling task whose log holds a decision no page has;
- two nodes without a brief and one with a poor one.

The checks read what each run left in the space, and the TTasks tool calls in the agent's own
output as the run kept it. `--keep` keeps the worlds' folders. The trial writes into `--out`:

- `runs.jsonl`: one line per run, with the task, agent, state, tokens, tool calls and each check;
- `summary.md`: the table;
- `pages-<agent>.md`: the pages after the twenty tasks, for count (c).

## Cost

For each agent: 21 runs (task 15 is two), and, when task 1 is among them, `--repeats` runs of
task 1 alone in fresh worlds (3 by default), so rule (a) has ten runs. A run takes a few minutes.

## What each count means

- **(a) A rule above the task is applied without being told.** The area's page says how to write
  dates. Seven tasks ask for a line with dates given as 2026-12-03. The ten runs count how often
  the line uses the page's form (applied) and how often the agent read the page (read). The bar is
  9 of 10.
- **(b) A wrong fact is corrected in place and used.** Task 2's request shows the export page
  names the wrong zone column. Task 9 must use the corrected column, from the page that was
  edited, with still one page on the export.
- **(c) The library stays useful.** The table shows the pages made, the edits and the pages with
  the same title. A person reads `pages-*.md` and judges the needless edits and the duplicates. The
  table also shows the bytes of history each page edit leaves (its change rows, the words before
  and after): what keeping every version costs a space.
- **(d) What the runs cost.** The table shows the input tokens of every run, from the agent's own
  report.
- **(e) Two edits at once both stand.** Task 15 is two runs at the same time. Each edits a
  different passage of the release checklist, and both must be there after.
- **(f) A decision only in a finished task's log is found.** Task 11 asks how invoices round. The
  answer is only in the sibling's log. The table shows whether the agent found it, whether it
  searched, and whether it put the rule on a page.

The stand-in passes every check by construction: its table only shows that the trial runs. The
counts that decide are those of real agents.
