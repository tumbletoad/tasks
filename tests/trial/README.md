# The trial of the library

Step 1's trial: do agents use and keep the library when TTasks gives it to them? Twenty
scripted tasks run in order as background runs in one project of a temporary space, once with
the trail in `get_task` on and once with it off. CI never runs this.

## How to run

```
pnpm trial --stand-in
pnpm trial --instances agents.toml --agents claude,codex [--trail on|off|both] [--tasks 400]
           [--repeats 3] [--only 1,2,9] [--out DIR] [--keep]
```

`--stand-in` runs against the run tests' fake Claude Code, which makes each task's calls as
scripted in `tasks.ts`. It checks the trial itself, costs nothing, and takes about a minute.

For real agents, `agents.toml` holds machine.toml `[[instance]]` tables, for example:

```toml
[[instance]]
id = "claude"
target = "claude-cli"
label = "Claude Code"

[[instance]]
id = "codex"
target = "codex-cli"
label = "Codex"
```

The trial never writes into an agent's home. Each world is a new TTasks home in a temporary
folder. The agent's program keeps its own sign-in, and the run's tools come from the run's own
folder. Run it against a real agent only with the owner's word: it spends their subscription.

Every world seeds a space with `--tasks` tasks. It then adds project Trial in area Lumen, with:

- pages on the space, the area and the project;
- a finished sibling task whose log holds a decision no page has;
- two nodes without a brief and one with a poor one.

`--keep` keeps the worlds' folders. The trial writes into `--out`:

- `runs.jsonl`: one line per run, with the task, agent, condition, state, tokens, tool calls and
  each check;
- `summary.md`: the table;
- `pages-<agent>-<condition>.md`: the pages after the twenty tasks, for count (c).

## Cost

For each agent: 21 runs with the trail on, 21 with it off (task 15 is two runs), and `--repeats`
runs of task 1 alone in fresh worlds (3 by default), so rule (a) has ten runs. That is 45 runs
per agent, 90 for two. A run takes a few minutes. With two agents, plan on an afternoon and a
good part of a day's usage on each subscription.

## What each count means, and what it decides

- **(a) A rule above the task is applied without being told.** The area's page says how to write
  dates. Seven tasks ask for a line with dates given as 2026-12-03. The ten runs with the trail on
  count how often the line uses the page's form (applied) and how often the agent read the page
  (read). The bar is 9 of 10. Below it, the trail changes (what it shows, or how it points at a
  page) before step 2 builds on it.
- **(b) A wrong fact is corrected in place and used.** Task 2's request shows the export page
  names the wrong zone column. Task 9 must use the corrected column, from the page that was
  edited, with still one page on the export.
- **(c) The library stays useful.** The table shows the pages made, the edits and the pages with
  the same title. A person reads `pages-*.md` and judges the needless edits and the duplicates.
  Many of either means the skill `keeping-the-library` changes. The table also shows the bytes of
  history each page edit leaves (its change rows, the words before and after): what keeping every
  version costs a space.
- **(d) What the trail costs.** The table shows the input tokens of every run, from the agent's
  own report. If the runs with the trail off do as well on (a), (b), (e) and (f), the trail
  shrinks to page titles.
- **(e) Two edits at once both stand.** Task 15 is two runs at the same time. Each edits a
  different passage of the release checklist, and both must be there after.
- **(f) A decision only in a finished task's log is found.** Task 11 asks how invoices round. The
  answer is only in the sibling's log. The table shows whether the agent found it, whether it
  searched, and whether it put the rule on a page.

The stand-in passes every check by construction: its table only shows that the trial runs. The
counts that decide are those of real agents.

## The switches

The service reads two environment variables while the trial runs, and nothing else sets them.
`TTASKS_TRIAL_TRAIL=off` leaves the trail out of `get_task`. `TTASKS_TRIAL_CALLS` names a file
that gets each tool call's name and the references it named, never text. Both go once the trial
has decided (`packages/service/src/trial.ts`).
