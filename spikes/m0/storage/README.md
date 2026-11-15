# Storage bench (M0.04)

Lab code for rows R02 to R06 of A7 3.7. It is never shipped and nothing outside `spikes/` imports it. It uses `node:sqlite` from the pinned Node 26.13.1 and no dependencies.

## Run it

```text
pnpm exec node spikes/m0/storage/run.ts --scale <n> --out <folder> [--work <folder>] [--machine desktop|laptop]
```

| Option | Meaning |
|---|---|
| `--scale` | 1 = full scale (the lab), 0.01 = CI. Counts scale with it. R03 keeps at least 50 patches, R05 at least 50 queries |
| `--out` | Folder for the result files: a new or empty folder per run, created if missing. The bench refuses a folder that already holds files, so a failed rerun can never leave an earlier run's complete results behind |
| `--work` | An existing folder. The bench creates a temporary `tasks-storage-bench-*` folder inside it for the databases and removes it at the end. It never creates `--work` itself. Default: inside `--out` |
| `--machine` | Which R03 and R05 thresholds apply. Default: `desktop` on Windows, `laptop` elsewhere |
| `--seed` | Seed of the generators. Default `mira`. The same seed gives the same corpus on every machine |
| `--text` | Text profile: `default` (the calibrated corpus of the first runs) or `heavy` (longer and more notes and log entries, see below) |
| `--r04-seconds` | R04 duration. Default 300 at full scale, 3 at 1 %. A shorter run is indicative only |
| `--layout` | Also measure the history table in both layouts (`history-layout.json`, see below) |
| `--keep` | Keep the temporary folder for inspection |
| `--inject-fault generate` | Test hook: fail inside the primary's generation, to check the cleanup |

The CI test (`storage-bench.test.ts`) runs the whole bench at 1 % with `--layout` in a temporary folder in about 6 seconds on Windows 11, and kills it if it passes its 90-second budget.

**Failures.** Every database connection and worker is closed on every path, so a failed run never keeps a file open. The run folder is removed after a failure too. If removing it also fails, both errors are printed, the original first, with the folder to remove by hand.

## How M0.05 runs it

Run from a checkout of the merged commit after `pnpm install --frozen-lockfile`. Only fixture data is involved, so the bench is safe on a managed machine. A default full-scale run needs about 2.5 GB free in `--work` and takes about 4 minutes plus the 5 minutes of R04 on Windows 11. The heavy profile needs about 4 GB.

- **Windows 11 (PowerShell):** confirm Defender real-time protection is on (`(Get-MpComputerStatus).RealTimeProtectionEnabled`), then
  `pnpm exec node spikes/m0/storage/run.ts --scale 1 --machine desktop --layout --work $HOME\Tasks --out <results>\desktop`
  and the heavy profile into its own folder:
  `pnpm exec node spikes/m0/storage/run.ts --scale 1 --machine desktop --text heavy --layout --work $HOME\Tasks --out <results>\desktop-heavy`
- **Ubuntu 24.04:** the same two commands with `--machine laptop --work ~/Tasks --out <results>/laptop` and `<results>/laptop-heavy`.
- **Repeating a run:** give it a new `--out` folder (for example `<results>\desktop-2`). The bench refuses a folder that already holds files.

The row records come from the default profile, so they stay comparable with the first runs. The heavy profile's R03 to R05 are recorded beside them. R03 is defined in `~/Tasks` (A1 M0 item 2), so `--work` points there. The bench refuses a missing `--work` folder and never creates `~/Tasks`. Where `~/Tasks` does not exist, use another folder in the home directory on the same disk and record that in the row. Copy `--out` back as the row's evidence. The result files hold numbers and machine facts only: no paths, host names or task text.

## What each number decides

Every row prints n, p50, p95, p99 and max of its headline latency, then its threshold and verdict. **A row gets a verdict only when the run meets the row's prescribed conditions**, listed in the row's `conditions`. Any other run is indicative: `judged: false`, `indicative: true`, `pass: null`, and the console and `summary.json` (`unmet`) name the conditions it missed. A 1 % run, or a full-scale run with a shortened R04, proves the bench works, not the machine.

| Row | Headline number | Conditions for a verdict | Pass | Decides |
|---|---|---|---|---|
| R02 | Reader get-by-reference latency while 1 writer and 2 readers run on one WAL database. Plus `backupMs`, `integrityMs`, `backupSteps`, `integrity`, `consistencyErrors` | Scale 1, run at least 10 s | Works (integrity `ok`, every reader snapshot consistent, the backup in one step) and backup plus `integrity_check` ≤ 30 s | Thread model A1-4. A fail builds the fallback driver as the primary in M1.02 |
| R03 | Commit latency of one-task patches with `synchronous=FULL`. Plus receipt-only commits (`receiptOnly`) | Scale 1, exactly 1,000 patches | p95 ≤ 10 ms (`desktop` role), ≤ 25 ms (`laptop` role) | A1-3 engine settings |
| R04 | Request-to-reply latency of 10 writers (10 agent sessions) at 1 write/s through one writer worker and its queue | Scale 1, 10 writers, at least 300 s, every request answered | p95 ≤ 25 ms and `overloaded` = 0 | Writer queue limits |
| R05 | FTS5 top 20 with snippets, unicode61 index, broad queries. Plus selective and no-hit groups, and the trigram index (below) | Scale 1, 55,000 tasks, 1,000 broad queries | Broad p95 ≤ 50 ms (`desktop` role), ≤ 100 ms (`laptop` role), trigram present | Search design. The trigram default is decided in M3.16 |
| R06 | Per-file render and write time of a full projection rebuild. `totalMs` is the judged number | Scale 1, 55,000 files | ≤ 60 s Ubuntu, ≤ 180 s Windows with Defender on | A1 open item 3 if it fails |

**Timed writes.** R02 to R04 write what A1 3.7 says a commit writes, shaped as A1 shapes it: commit IDs are random A1 IDs (`op_` and 26 characters, A1 3.3), request IDs are A1 ID bodies (A1 3.8), and every commit belongs to an agent session whose record is also its writer scope, so the `commits_session` index and the unique keys see the product's insert pattern. R04 uses one session per writer. The IDs come from a seeded source, so runs repeat.

**R05 query groups.** `metrics.groups` (and `stressGroups` for the stress corpus) holds three groups of the same size, each with its own percentiles, hits and the matching documents of a sample of 50 queries (`matches`):
- `broad`: words of the fixture vocabulary, single, paired, as prefixes and as phrases. Many match most documents (the word "client" matches about 72,000 of them at full scale). This is the stress case and the row's verdict, unchanged from the first runs.
- `selective`: a task reference (`"M-1234"`), a ticket reference (`"LUM-512"`) or a title phrase with its qualifier. Each matches a handful of documents.
- `noHit`: words that never occur in the fixture text.

The lab can then tell a broad-term cost (ranking tens of thousands of matches) from a general one. The verdict is not tuned: if broad queries miss the limit, the row fails.

**Trigram size.** R05 reports three ratios against the unicode61 index, because A1 open item 4 ("under 2× the index size") does not say which one it means. **A1 must clarify which figure its 2× rule uses.**
- `trigramRatio`: the trigram table against unicode61, all shadow tables including the stored text.
- `trigramIndexRatio`: index pages only (`_data` and `_idx`).
- `combinedRatio`: unicode61 and trigram both installed, against unicode61 alone. This is the growth of the database's search part when the flag is on.

**R06 bookkeeping.** The timed rebuild includes the projection's database work of A1 3.13: each file's SHA-256, a `projection_files` row per task file with the catalogue line as rendered, and the writer-side acknowledgement of the processed `projection` outbox rows (step 5), one write transaction per batch of 200. The catalogue and the index are assembled from `projection_files`, and `.projection.json` carries the watermark (step 6). `bookkeepingMs` is the writer part. Still left out, and listed in the result as `omitted`: the rescue check of hand-edited files and the per-file temporary name and rename (both belong to incremental updates, a rebuild writes into `view.new/`), and the message round trip to the writer worker (the writer connection runs on the projection's thread here).

## What it builds

- **Primary space** "Mira" (prefix M): the design scale of A1 3.20, 5,000 open and 50,000 completed tasks, with notes, log entries, sources, the full history (commits, receipts, changes, `history_text`) and the search index. About 670 MB at full scale: this is the ~600 MB database. R02 to R06 run on it.
- **Second space** "Studio" (prefix S): the same design scale without history. R02's two reader workers read both spaces, since A1 3.9 shares them across spaces.
- **Stress corpus** "Mira": 10,000 open and 100,000 completed tasks without history. R05 also times its queries over it, for A3's stress-corpus targets.

The schema is the subset of A1 3.4 and 3.12 a realistic corpus needs, with A1's columns, constraints and indexes, plus `projection_files` for R06. A patch writes what A1 3.7 says a commit writes: receipt lookup, commit row, task row with versions, change row, search document, outbox rows, receipt and `space.last_seq`, in one `BEGIN IMMEDIATE` transaction. The projection follows A1 3.13 at spike level: front-matter Markdown files, read-only, written into `view.new/` in batches of 200 tasks per read transaction, then swapped in, with `catalog.jsonl`, `index.md` and `.projection.json`.

**`corpus.json`** records each corpus: counts, a SHA-256 digest of every row, the file size, the generation time, the text distributions per kind (`text`: count, median, p95 and total bytes of titles, summaries, contexts, outcomes, notes and log entries), and the primary database's size per group against the estimate in A1 3.20. The digests are equal across machines for the same seed: the CI test pins the digests of a tiny corpus and of the 1 % corpora, so the Windows and Ubuntu runners prove the same corpus.

**Text profiles.** The default profile is light: at full scale the median context is about 415 bytes, a note about 140 and a log entry about 170, and notes and log entries take about 21 MB against A1's 80 MB estimate. The `heavy` profile writes note bodies of 3 to 10 sentences and log bodies of 4 to 12, and adds a second note and a second log entry to some tasks. Notes and log entries then take about 80 MB, near A1's estimate. The history and the search index grow with them, so the heavy primary is about 1.1 GB, and its broad R05 queries take about twice as long. The default profile is unchanged and draws the same random numbers as before, so earlier numbers stay comparable.

## History layout (`--layout`)

The history is larger than A1 3.20 estimates (about 410 MB against 250 MB at full scale). With `--layout`, after the rows, the bench copies the generated rows of the primary's `changes` table (not the benchmarks' rows) into two fresh databases, once `WITHOUT ROWID` as A1 3.4 and the bench define it and once with a rowid, each with the same indexes, and writes `history-layout.json`: for each layout the table and every index with bytes, pages by type, overflow pages, overflow bytes, payload and unused bytes, and the same figures for the primary's own table (`inPlace`). It also records the largest payload a leaf keeps before the rest spills (`maxLocalPayload`): about 1,000 bytes for a `WITHOUT ROWID` table, which is an index b-tree, and about 4,060 for a rowid table, at 4 KiB pages. Change rows of one to a few KB therefore spill to overflow pages in the first layout and not in the second, and each spill takes a whole page for its tail. The copies are removed right after measuring.

The bench's schema does not change: A1 owns it, and the layout decision goes to M1's storage step with the Windows and Linux figures.

## Indicative Windows runs (not the lab rows)

All on Windows 11 with Defender on, default text profile. M0.05 records the real rows. R03, R04 and R06 now time more work than in the first run and the review run below (random A1 IDs, session metadata, projection bookkeeping), so those two runs' numbers are historical and not comparable with later runs.

**First run, 2026-11-12, by the bench's author,** with R04 shortened to 20 s, to check the bench works at full scale:

| Row | Result |
|---|---|
| Corpora | Primary 673.6 MB in 21.5 s, second 263.5 MB, stress 527.3 MB |
| R02 | Works. Backup 2.0 s plus integrity check 3.9 s. Reader get-by-reference p95 0.31 ms, open view p95 36 ms |
| R03 | p50 0.66 ms, p95 1.19 ms, p99 19 ms. Receipt-only p95 0.49 ms |
| R04 | p95 3.0 ms, none overloaded |
| R05 | p95 50.1 ms, just over the `desktop` role's limit. Trigram 1.7 times the unicode61 tables, 2.2 times its index pages. Stress corpus p95 103 ms |
| R06 | 27.1 s for 55,000 files |

**Review run, 2026-11-12, by the independent reviewer,** full scale with a full R04, before the fixes in this revision (sequential commit IDs, no session IDs, R06 without bookkeeping). Indicative, not the lab run:

| Row | Result |
|---|---|
| R02 | 6.93 s backup plus integrity check |
| R03 | p95 1.044 ms |
| R04 | p95 1.910 ms |
| R05 | p95 52.806 ms: fails the 50 ms limit of the `desktop` role. Trigram 1.701 times unicode61 with shadow tables, 2.178 times its index pages, 2.701 combined |
| R06 | 22.37 s |
| History | 409.6 MB. In `changes`, 20,336 overflow pages (83.3 MB) held 13.5 MB of payload. Controlled copies of the same rows and indexes: 200.8 MB `WITHOUT ROWID`, 139.2 MB with a rowid |

**Check run after the fixes, 2026-11-12,** full scale with `--layout`, R04 shortened to 20 s (so R04 is indicative), both profiles:

| Row | Default profile | Heavy profile |
|---|---|---|
| Corpora | Primary 673.6 MB in 22.5 s (notes and log 20.8 MB, history 409.6 MB), second 263.5 MB, stress 527.3 MB | Primary 1,074.4 MB in 35.4 s (notes and log 80.6 MB, history 619.9 MB), second 455.3 MB, stress 907.8 MB |
| R02 | Pass. Backup 2.1 s plus integrity check 4.8 s | Pass. Backup 3.3 s plus integrity check 7.6 s |
| R03 | Pass. p50 0.69 ms, p95 1.24 ms, p99 20.9 ms | Pass. p50 0.64 ms, p95 1.10 ms, p99 18.7 ms |
| R04 | Indicative (20 s). p95 2.05 ms, none overloaded | Indicative (20 s). p95 2.18 ms, none overloaded |
| R05 broad | Fail. p50 26.2 ms, p95 54.9 ms. Stress p95 109.8 ms | Fail. p50 49.9 ms, p95 101.0 ms |
| R05 selective | p50 0.26 ms, p95 18.5 ms (median 6 matches) | p50 0.41 ms, p95 29.8 ms (median 4 matches) |
| R05 no hit | p95 0.08 ms | p95 0.08 ms |
| Trigram ratios | 1.729 all tables, 2.235 index pages, 2.729 combined | 1.756, 2.302, 2.756 |
| R06 | Pass. 25.6 s for 55,000 files, of which 1.3 s bookkeeping | Pass. 28.5 s, of which 1.3 s bookkeeping |
| History layout | `changes` 203.0 MB `WITHOUT ROWID` (20,336 overflow pages, 83.3 MB, holding 13.5 MB) against 139.8 MB with a rowid (no overflow pages) | 320.0 MB (35,108 overflow pages) against 208.9 MB |

The selective group's p50 is far below a millisecond, but its p95 is not. The likely cause, not yet measured apart, is the title phrases, whose common words ("the", "for") have long position lists.

Observations for M1, not decisions:
- The history is larger than A1 3.20 estimates, mostly because `changes` is `WITHOUT ROWID`: its rows spill to overflow pages that stay mostly empty. `history-layout.json` measures the alternative on Windows and Linux.
- R03's p99 outliers are probably WAL auto-checkpoints running inside a commit.
- R05's broad queries match most documents, and ranking all matches dominates. The selective and no-hit groups show the cost without that. A3 owns the query design.
