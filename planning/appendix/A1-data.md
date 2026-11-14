# A1. The data layer

This appendix owns the space folder, the SQLite schema, IDs and references, the operation model and the write path, history with undo, redo and revert, request receipts, completion and wrap-up, the read-only projection and the explicit import, machine-bound places, preferences and feature flags, schema versions and migrations, backups and restore, the storage adapter and the change feed.

It builds on PLAN.md section A (D1, D10, D11, D12, D14, D16, R1 to R4, R11, R12, R15) and uses the section Q terms. Instances and root paths live in machine-local configuration (A4 L1, A6 3.3). Operations carry principal, writer scope, machine and kind (A6). Cursors carry an epoch and an authority incarnation (A6 3.5). Interfaces assumed from other appendices are in 3.21.

For a part that is built, this text is the contract: the guarantee, the interface, the limits and the reasons. The code and its tests carry the rest. For a part not built yet, it holds what is needed to build it. Examples use the invented fixture (Mira Okafor). Her space is "Mira" with reference prefix `M`.

---

## 1. Summary

1. A space is a folder `~/.tasks/spaces/<slug>/` holding `space.json`, one SQLite database `space.db` (WAL), attachments, a generated read-only projection in `view/`, import working copies in `exchange/`, and backups. Machine-local state lives outside it.
2. The database is the only truth. One writer per open space owns the only write connection, in a storage worker. Reads run on reader connections. The main thread never holds a SQLite connection to a space.
3. Every change is a request of 1 to 50 typed operations. Inside one `BEGIN IMMEDIATE` transaction the writer checks the request, looks up its receipt, resolves it into a staged plan, checks it against the state at its start, judges it by policy on its actual targets, and only then executes it. That transaction writes the state, the history (`commits`, `changes`), the receipt, the search rows and the outbox rows. There is no other write path.
4. Every field has a physical version: the sequence number of the commit that last wrote it, which only grows. Operations that change existing fields carry a `base`, and removals or revivals of link rows carry a link version or a base. A field newer than the base is a conflict. Each field also records its provenance: the commit whose write it holds. Undo, redo and revert apply only where a field still holds the write they would invert.
5. Every request the writer decides gets a durable receipt, no-ops, `existing` results and conflicts included. A retried request ID returns the stored result, with no expiry.
6. Check-off completes at once. Wrap-up only adds an outcome and learnings. Deletion is a restorable tombstone. A human-only, explicit `redact` is the single destructive operation.
7. IDs are 128 random bits with a type prefix. Tasks also get a short reference such as `M-14`, allocated by the single writer and never used as identity.
8. Places are `(machine, root, relative path)` and resolve exactly or not at all.
9. `node:sqlite` sits behind a small driver interface, checked for FTS5 at every worker start. `better-sqlite3` is the tested fallback.

## 2. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| A1-1 | Space folder | `~/.tasks/spaces/<slug>/` with `space.json`, `space.db`, `attachments/`, `view/`, `exchange/`, `backups/`, `exports/`. No product name inside the folder. | Self-contained and safe to rename (D16). |
| A1-2 | Synced and network folders | Detected at create and open. Synced folder, or one the check cannot read: read-only until the user confirms on that machine. Network file system: never writable. The projection or backups may go to a synced folder instead. | SQLite plus file sync corrupts databases. |
| A1-3 | Engine settings | WAL, `synchronous=FULL`, `foreign_keys=ON`, STRICT tables, SQLite ≥ 3.45. | An acknowledged commit survives power loss. Strict types catch bugs early. |
| A1-4 | Threads | One writer per open space, reader connections, a maintenance worker. All in worker threads. | The event loop stays responsive. |
| A1-5 | IDs | Type prefix plus 26 Crockford base32 characters encoding 128 random bits. No time or machine part. | A collision needs 128 random bits to repeat. Meets A6's 122-bit floor for machine IDs. |
| A1-6 | Short references | Tasks: `<PREFIX>-<n>`, allocated in the creating transaction, never reused. Notes and log entries: per-task ordinals `n3`, `l5`. Areas and projects: slugs. All are aliases. | Easy to type and say. A wrong prefix is detected instead of resolving a task in another space. |
| A1-7 | Field versions | A JSON map `fv` on each row: logical field → commit `seq`, which only grows. A second map `fp` holds each field's provenance. | ABA-proof (R2). Read with the row. |
| A1-8 | Precondition | One token, `base`: the `as_of` (epoch, incarnation, seq) of the caller's read. Each touched field must have a version ≤ base at the start of the request. Inserts of new rows need no base. Removing or reviving a link row carries its version. | Agents carry one token per read. |
| A1-9 | Commit | `BEGIN IMMEDIATE` → space, authority and actor checks → receipt lookup → base → staged plan → policy → preconditions → execute → state, `commits`, `changes`, search rows, outbox rows, receipt → `COMMIT`. | R1. One transaction, so no crash window between state and history (X11). |
| A1-10 | Receipts | A `receipts` table keyed by `(scope_id, request_id)`, one row for every outcome the writer decides, kept forever. The fingerprint covers the intent, never a base. | R3, X12: an unreceipted no-op can turn into a change on retry. |
| A1-11 | Dedupe | `source_key` is unique per space on `sources`. `task.create` upserts by its draft's keys against active tasks, then tasks finished within `tasks.dedupe_window_days` (30). A match takes only the draft's entries. | R4. |
| A1-12 | Sets | Labels and source links are rows with their own versions. No set-valued fields. | A set-valued field has no associative merge. |
| A1-13 | Undo | Per-actor stack stored as `undo_status` on commits. Each field keeps its physical version (`fv`) and its provenance (`fp`). Inverting a change is guarded by provenance. Atomic. Partial only on explicit choice. | R2. Survives restarts. Consecutive undos of one field both work without resetting versions. |
| A1-14 | Revert | Any commit, or a whole agent session in one atomic commit with a preview. A session revert walks each field's provenance chain back and stops at the first foreign write. | Never overwrites intervening human work. |
| A1-15 | Lifecycle | `active` → `completed` (check-off) or `archived` (won't do). `wrap_state` `pending` or `wrapped` for completed tasks. Tombstone via `deleted_at`. | D12. |
| A1-16 | Wrap-up | Additive. Writes outcome and learnings and may clear short planning scalars. Never edits context, notes, log or sources. | D12. Wrap-up never destroys the only copy of text. |
| A1-17 | Destruction | Only `redact`: human-only, explicit, recorded. No automatic purge of anything the user wrote. | D12, A6 3.16.4. |
| A1-18 | History size | Kept by default. Explicit, previewed payload compaction. Commit rows always stay. | Bounded growth with an honest, chosen loss. |
| A1-19 | Search tables | One FTS5 table with its own content and a `search_docs` map carrying audience and lifecycle. Updated in the write transaction. | R12. Snippets work. D14 filtering from the start. |
| A1-20 | Projection | `view/` regenerated from the outbox. Files are read-only and labelled with `seq`. Never imported. | D10. |
| A1-21 | Import | `export-edit` writes a working copy and stores its base in the database. Preview, per-field three-way merge, apply as one commit, conflicts as proposals. Only a human applies an import. | D10, X15. |
| A1-22 | Places | Rows `(owner, machine_id, root_id, rel_path)`. Root paths only in machine-local config. Exact resolution, no fallback. | R11, A4 3.3, A6 3.3. |
| A1-23 | Preferences | Space keys in the database, changed by operations and undoable. Machine keys in machine-local config. One registry in code. Flags gate behaviour, never schema. | The vision's "enabling and disabling features". |
| A1-24 | Migrations | Numbered steps on `user_version`. A released schema is frozen and every change is a new step. Each attempt behind its own verified backup, one transaction, verify. A failed migration is not tried again by the same build on an unchanged database. Breaking steps allowed before 1.0, additive-only within a major after 1.0. Agent migration prompts for judgement calls only. | Real spaces depend on every step. |
| A1-25 | Backups | Backup API from a read-only connection in one step, verified, gzipped. 7 daily and 4 weekly. A verified barrier backup before migrations, forks and large imports. | A single step gives a consistent snapshot while writes continue. |
| A1-26 | Driver | `node:sqlite` behind `SqliteDriver`. The `better-sqlite3` fallback passes the same contract tests. | D11. `node:sqlite` is a release candidate. |
| A1-27 | Staged requests | Resolve every request into a staged plan before preconditions and policy. Execute with read-your-writes. Coalesce history to one change per field per commit. | X11. |
| A1-28 | Authority incarnation | A random incarnation ID next to the epoch. Claims, transfer imports and restore claims create a new one. `as_of`, `base`, cursors, receipts and the change feed carry it. | X6. Two authorities can reach the same epoch. |
| A1-29 | Change feed | Batches with a coverage interval `(from, through]` and an applied-through cursor. Empty batches allowed. The format is final, unfiltered for now. | X8. A later filtered feed needs no format change. |
| A1-30 | Bundle limits | One shared policy bounds expanded bytes, entries and per-file sizes for backups and bundles. No compression-ratio rule. The exporter never writes what the importer would refuse. | DA-17. |

---

## 3. Specification

### 3.1 The space folder

```text
~/.tasks/spaces/<slug>/        one space; the folder name is the space slug
  space.json                   bootstrap manifest
  space.db, -wal, -shm         the authoritative database
  writer.lock, writer.json     the cross-process writer lock and its holder (3.9)
  attachments/sha256/…         content-addressed, immutable blobs (staging/ during ingestion)
  view/                        the projection: generated, read-only (3.13)
  exchange/                    import working copies (3.14), the only place meant for hand edits
  backups/, exports/           verified snapshots and the bundles the user asked for (3.18)
```

A space may live in any folder `machine.toml` registers (A2). Only `space.db` and `attachments/` are irreplaceable: `space.json` is rebuilt from the database and `view/` from the outbox. `exchange/` holds files people may have edited, the projection's rescued files among them (3.13), so nothing removes them automatically. Machine-local state (A2) is never inside a space folder; the per-space local settings are `<state>/spaces/<space_id>.json` (`packages/service/src/hub/space-settings.ts`), `projection.dir` and the projection's rescues among them (3.13). Not built yet there: `last_seq` in `spaces_seen` (A6), the last clean-shutdown marker (3.2) and `transfers_imported[]`, the transfer IDs this machine has imported, so a second import of one transfer bundle is refused (3.18).

**Rules.**
- **Exact modes whatever the umask:** every file and folder storage creates gets 0700 or 0600 through a descriptor, because the mode given to `open` or `mkdir` is masked by the umask. Only what this call created gets a mode; what already exists keeps its own. One implementation, `packages/files`, used through storage's `files.ts`; tests `[A2.3.2.2.permissions.*]`. An existing space folder is not judged for who else can write it (open item 16).
- Only the service writes `space.json`, `space.db*`, `attachments/`, `view/` and `backups/`.
- **Nothing is deleted as a side effect.** No operation deletes a person's data or a backup on the way to something else: it keeps what it replaces and reports where. Removal outside the retention policy (3.18) is the person's explicit act.
- Only a **closed** space (checkpointed, no open connection, `tasks space close`) may be copied or zipped as a plain folder.
- A space path's last component is its slug, valid on every OS (`space-path.ts`, `[A1.5.space.path-rules]`).

**Create** (`createSpace` in `space.ts`, `[A1.5.space.create-open]`) builds the space in a hidden staging folder and renames it into place, so a space exists complete or not at all and never replaces a folder with content. A new space has epoch 1, a random incarnation, no commits, and two actors, the owner and `system`, because migrations need a principal. Crash leftovers are listed by `tasks space list`, never removed by create or open (open item 7).

**`space.json`** (`manifest.ts`, `[A1.5.space.manifest]`, `[A1.5.space.lineage-bound]`) lets tools identify a space and refuse a too-new format before SQLite opens it. The database wins on every field except `space_id`. A valid safety field (`space_id`, `format`, `min_reader`, `min_writer`) is honoured however damaged the rest is, and **a damaged manifest is never rewritten** (`SPACE_MANIFEST_DAMAGED`): the value a writer would overwrite could be the one that should have stopped it (open item 12). The lineage it carries is cut from the database alone, so an open never rewrites an unchanged file.

**Open** (`space.ts`, `open.ts`; the rules are in `space.ts`'s header) decides every refusal on a read-only connection whose pragmas write nothing, and for a writer again before `journal_mode = WAL`, the only writer pragma that writes the file (`SPACE_CHANGED`). A refusal leaves the database unchanged; a read-only connection may leave a 0-byte `-wal` and a 32 KiB `-shm`, never deleted, because another connection may use them. `WRITER_REFUSALS` is typed so a new read-only reason does not compile without its writer refusal.

**Pitfalls.**
- Any `space.db-journal` makes open refuse with `SPACE_NEEDS_RECOVERY`, decided from the file system before SQLite reads, because SQLite acts on a hot journal at a connection's first read. Recovery is `recoverSpace`'s (3.18), never open's.
- An empty `space.db` is refused before SQLite opens it: SQLite deletes a `-wal` beside an empty database at the first read, even read-only.
- Never open with `immutable=1`: it ignores the WAL and the locks and can read a stale header while a writer works.

### 3.2 Synced folders and network drives

Never put a live space in a folder a sync client copies: a client can copy `space.db` without its `-wal`, or replace it mid-transaction, and SQLite's WAL needs shared memory on one host.

**Built.** The check (`packages/service/src/hub/sync-folders.ts`, whose header lists every signal, pure over an injected `SyncHost`; the real host is `sync-host.ts`) and the read-only modes (`spaces.ts`). Tests: `[A1.5.sync.detect]`, `[A1.5.sync.statfs]`, `[A1.5.sync.read-only]`, `[A1.5.sync.way-out]`.

**What it guarantees.**
- At create, open and restore the service checks the folder and every folder above it, as given and as its real path.
- **Synced:** `PRAGMA quick_check` runs first (a failure is `read_only(check_failed)`), then the space is `read_only(synced_folder)` until the person confirms on this machine that the folder is excluded from sync (`tasks space open <folder> --excluded`). The confirmation is keyed by the folder's canonical real path, so another folder asks again.
- **Network:** `read_only(network_filesystem)`, never writable, never confirmable. A network signal wins over a synced one.
- **Unchecked:** a machine fact the check cannot read at all, or a fault in the check, is served as synced. A check that cannot see never makes a space writable.
- Create and restore refuse a network folder. A restore in place is also refused in an unconfirmed synced folder and for a database that failed its check. A recovery (3.18) is refused on a network file system only, since in a synced folder it is the only way out of a rollback journal. A backup is allowed everywhere.
- The way out has no move command: `tasks space` prints the backup, restore into a new local folder and claim (3.18), which leave the old folder untouched.

**Pitfalls.**
- A stale `%OneDrive%` still counts: a false warning costs little, a corrupted database a lot.
- The Drive for desktop `SyncTargets` value is protobuf-shaped: decoding it whole as UTF-16 runs past a path into the next field.
- The detector never lists inside a provider root, never reads a provider's private databases and needs no admin rights. A network drive's label is never read on Windows: `IsReady` on a disconnected drive waits for the network's time-out.
- The projection and the backups may go to a synced folder (`projection.dir`, `backup.dir`), which gives a readable copy on other devices without risk to the database.

**Not built yet.**
- The same `quick_check` after an unclean shutdown and after an outside write (3.9).
- When the check fails, the two actions **Restore the latest verified backup** into a new folder and **Rescue readable data**, which exports the rows that can still be read into an `exchange/rescued/` JSONL file for review. Conflict copies are never deleted automatically.

### 3.3 IDs and references

**Immutable IDs** (`packages/storage/src/ids.ts`, `[A1.5.ids.property]`) are a type prefix (`ID_PREFIXES`) and 26 lower-case Crockford base32 characters encoding 128 random bits, never derived from time, titles, paths or host names. Clients may supply the ID of a new entity, so the UI can show it before the reply. The writer checks prefix, length, alphabet and uniqueness; once redaction exists (3.11.4) also against the `redactions` table, so a redacted ID is never reused.

**Short references** (`packages/storage/src/refs.ts`, `[A1.5.refs.short]`) are aliases, never identity.
- **Tasks:** `M-14`, the space's `ref_prefix` and a number allocated in the creating transaction, never reused, also after delete. Only the authority allocates them, so a later replica cannot create tasks offline. A reference with another space's prefix is `SPACE_MISMATCH`, never a task here.
- **Notes and log entries:** a per-task ordinal, `M-14 n2`, `M-14 l1`, never reused.
- **Imported legacy IDs** are aliases in namespace `planning` (A7).
- Resolution order is in `resolveTask` and `resolveGroupRow` (`write/writer.ts`).

**Not built yet.**
- Areas, projects and labels get a slug unique among live rows, and a rename keeps the old slug as an alias.
- Changing the prefix (`space.patch`) keeps the old one as an alias, so `M-14` still resolves.
- An ambiguous alias returns `AMBIGUOUS_REFERENCE` with candidates.

### 3.4 Schema

Schemas 0.1 and 0.2 are built and frozen (3.17). The SQL in `packages/storage/migrations/` (`0001-schema-0.1.ts`, `0002-schema-0.2.ts`) is the definition, and the facts code branches on (`APP_ID`, `FORBIDDEN_COLUMN_WORDS`, `CLOSED_ENUMS`, `OPEN_SETS`) are in `src/schema.ts`. The schema lint (`[A1.5.schema.lint]`) checks each against a fresh database, including STRICT, the foreign keys and the closed sets. Schema 0.2's tables `attachments`, `proposals`, `exchanges`, `exchange_items`, `labels`, `task_labels` and `learnings` exist, but no operation writes them yet (3.6).

**Conventions.**
- Every mutable row has `created_seq`, `version` and two JSON maps over its logical fields: `fv`, each field's physical version, and `fp`, its provenance (3.5, 3.10). A missing key means `created_seq`. The planned `sessions` and `runs` tables have no maps yet and `routines` only `fv` (open item 13). The logical fields are `TASK_FIELDS` and `CHILD_FIELDS` in `write/fields.ts`; `ext.<key>` is one field per key, and writers keep `ext` keys they do not know.
- No column holds an executable path, argv, environment, shell text or credential (R10, A6 L4).
- `application_id` is random, not derived from the product name, so a rename keeps every space readable.
- **WITHOUT ROWID** only for small, bounded rows whose key is not one INTEGER (`aliases`, `outbox`, `task_sources`, `task_labels`). Such a table keeps at most 1,002 bytes of a row on a 4 KiB leaf and spills the rest: the same 224,684 change rows took 203 MB without a rowid against 140 MB with one. So `changes`, `receipts`, `launches`, `exchange_items` and `history_text` keep a rowid.
- **Open sets have no CHECK.** A set other appendices extend is validated by the writer, because changing a CHECK rebuilds the table and `commits` and `changes` are the largest. `tasks.status` and `tasks.effort` hold keys of the preferences `tasks.statuses` and `tasks.effort_scale` (3.16).
- **Integer domain.** Every INTEGER fits a JavaScript number and the contracts' wire patterns; the row decoders (`rows.ts`, `[A1.5.space.row-domain]`) refuse anything else with `SPACE_INVALID`, naming the column, never the value.
- **Positions** are fractional indexes (`write/positions.ts`, `[A1.5.write.positions]`), so a move updates one row. There is no rebalancing. They are computed with `max` and `min` over a group, which no index serves: M1.15's design-scale budgets show whether `tasks` needs an index on group and position.
- `priority` P4, the default, means "no priority", so clearing it sets 4. `space.hold` is the user-only hold (3.6).

**Change rows.** Every column of every replicated table changes only through a `changes` row, except `version`, `touched`, `fv` and `fp`, so a replica applies `changes` without business logic (A6); the crash checker replays every row from its history. A commit has at most one change row per `(entity, entity_id, field)`. Delete, restore, unlink and relink are `set` changes of `deleted` or `removed`. `commits.ops` holds the staged operations with references resolved, and `commits.affected` counts the tasks the plan completes, archives, moves or deletes, for A6's burst brake.

**System commits** are written only by `writeSystemCommit` (3.7), by the system actor in scope `system`, with no receipt: `machine.register`, `actor.register`, `schema.migrate` and `space.claim`. Their request ID names the row or incarnation, so each happens once. The space row has no history.

**Tables for later steps**, from step 0003 on: the search tables (3.12) and these. The projection's record of its files is no table: it is a file in the projection's folder, which it describes (3.13).

```sql
CREATE TABLE history_text (hash TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT;   -- text of 1 KiB or more

CREATE TABLE redactions (                        -- IDs removed by entity redaction, never content
  entity_kind TEXT NOT NULL, entity_id TEXT PRIMARY KEY, seq INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (                          -- A4 3.10
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('interactive','run')),
  instance_id TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES machines(id),
  native_id TEXT, native_id_source TEXT,
  state TEXT NOT NULL CHECK (state IN ('opening','live','ended','unknown')), end_reason TEXT, exit_code INTEGER,
  bound INTEGER NOT NULL DEFAULT 0, actor_id TEXT REFERENCES actors(id),
  created_at INTEGER NOT NULL, ended_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL
) STRICT;

CREATE TABLE runs (                              -- A4 3.11
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), routine_id TEXT, session_id TEXT,
  instance_id TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES machines(id),
  state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  result TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result)),
  queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL
) STRICT;

CREATE TABLE routines (                          -- A4 3.12.1; spec holds template, params, limits, watermark
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('refresh','wrap-up','custom')),
  home_machine_id TEXT NOT NULL REFERENCES machines(id), instance_id TEXT NOT NULL,
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  schedule TEXT CHECK (schedule IS NULL OR json_valid(schedule)),
  enabled INTEGER NOT NULL DEFAULT 1, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL, fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv))
) STRICT;
```

- From the step that adds `history_text`, text values of 1 KiB or more are stored there once by SHA-256 and referenced as `{"$t": hash}` in `changes` and `commits.ops`, so the after-value of one edit and the before-value of the next share storage.

**Records whose lifecycle A4 owns.** A4 writes launch intents, sessions and runs only through its `ExecutionStore` interface (X7). In v1 that interface writes these tables in the space database as A1 operations with their history; from L1 a machine without authority keeps them in a machine-local journal and publishes observations to the authority (A6). `launches` is built (0.1). A launch names its place, never an absolute path; a session's absolute folder stays in machine state (A4 3.10).

**Sessions until their table exists.** Session records and binding handles live in `<state>/sessions.json` (`packages/service/src/binding/sessions.ts`, A3 3.7). Everything a session does in a space still goes through the write path: its actor joins with `actor.register`, every commit carries `session_id` from the credential, and a launch's `bound_at` is a launch operation. The step that adds the table moves each record into it, adds `sessions` to the crash harness's tables and leaves handles in machine state. Until then a session record lost with the state folder leaves its launch's `bound_at` in the space, so that launch's reference answers `launch_used`.

### 3.5 Versions and the base

Built in the write path (`write/request.ts` parses the base, `write/writer.ts` checks it); tests `[A1.5.write.operations]`, `[A1.5.write.read-your-writes]`, `[A1.5.write.lost-update]`.

**What it guarantees.**
- Every commit has a gapless `seq`. Each field it sets gets that `seq` as its physical version (`fv`), which only grows and is never reset, and as its provenance (`fp`; undo, redo and revert set it differently, 3.10). A task's `touched` moves on any change to the task or a child row; its `version` stays for a child-only change.
- **`as_of`** is `(epoch, incarnation, space.last_seq)` of one read transaction, on the wire `<epoch>.<seq>.<tag>` with the first 8 characters of the incarnation's body (40 bits). Callers copy it verbatim. Cursors, receipts, feed batches and signed commands carry the full incarnation ID.
- **The base** is always the `as_of` of a read. A write that changes existing fields applies only if every logical field it touches has `version ≤ base.seq` at the start of the request. A field the caller did not touch never blocks the write. There is no blind write for agents; a human CLI command reads first and sends that read's `as_of`.
- **Epoch and incarnation are compared first** (`EPOCH_CHANGED`), then `base.seq` (`BASE_FROM_FUTURE` beyond `last_seq`). After a claimed restore sequence numbers are reused and two incarnations can share an epoch: without both checks an old read could overwrite a change it never saw. A tag match with another full incarnation needs a 40-bit collision within one epoch, a risk accepted for the agent-carried token only (open item 6). A version written under an earlier incarnation is at most the incarnation's `authority_since`, so the comparison stays sound across a restore claim.
- **Base-free inserts.** Operations that only insert a row (a note, a log entry, a source link, `task.context_append`, and once built a learning, an attachment or a label link) need no base: they commute and fail only if the parent is missing or deleted. Operations on a task the same request creates need no base.
- **Link versions.** Removing or reviving a link row needs its `link_version` or a base. A revival without either is `BASE_REQUIRED` with who removed the link and when, so a delayed removal cannot remove a link the user deliberately added again.
- A conflict names each field, its current value, who set it and when, and the `as_of`. Callers never retry a conflict blindly: they re-read and decide.

### 3.6 The operation set

A1's operations are the writer's internal interface, not Zod schemas. Each kind is listed once in `packages/contracts/src/operations.ts` with who may emit it, the scopes it may need and whether it always needs `base`, and a test checks the writer against that table. A registry handler (A3, R5) expands its input into operations, resolving relative dates, names and A3's `focus: true`; the writer takes ISO dates, IDs and slugs only.

**Built** (`write/request.ts` checks, `write/writer.ts` executes; tests `[A1.5.write.operations]`, `[A1.5.write.children]`, `[A1.5.write.clear-append]`, `[A1.5.write.launches]`, `[A1.5.write.dedupe]`, `[A3.3.7.actors.first-act]`): `task.create` (with dedupe by source key), `task.patch`, `task.context_append`, `task.move`, `task.complete`, `task.reopen`, `note.add`, `log.add`, `source.add`, `place.set`, `place.clear`, `launch.create`, `launch.transition`, `machine.register` and `actor.register`. What is not obvious from the code:
- `task.context_append` writes the `context` field without a base, so two appends both land while a stale replace conflicts with it.
- **Initial children** of a new task are child operations in the same request naming the draft's client ID. There is no nested form of `task.create`, so each row kind has one implementation.
- `machine.register` runs once, when a space's writer first opens on its authority machine. A writer on another machine registers nothing and refuses every request (`not_authority`). The writer refuses a principal without an `actors` row; the CLI's `script` and `agent:unknown` actors and A4's session actors join a space with `actor.register` on their first act.
- **Launch operations** (A4 3.9, 3.16) write `launches` with history, but a launch is not a child of its task: it moves neither the task's `touched` nor its projection. Only a human or the system writes them, and they are never undoable (R7). The focus rule (a second click within `FOCUS_MS` returns the intent in flight) is checked in the transaction, because two tabs could both create an intent, and is measured on the wall clock, because commit instants stand still while the clock is behind the newest commit (3.9). A launch request stores no free text, so it never goes through the request path's `submit` (A3).

**Not built yet.**

| Operation | Main input | Precondition | Effect |
|---|---|---|---|
| `task.wrap_up` | `outcome`, `learnings {add[], remove[]}`, `clear_planning` | base | 3.11.2. Only for completed or archived tasks. |
| `task.archive` | `reason` | base on `lifecycle` | `active` → `archived` (won't do). |
| `task.delete`, `task.restore` | | base on `deleted` | Tombstone, or clear it. |
| `note.patch`, `note.delete` | body, addressee | base | Edit or tombstone. An agent changes only notes it wrote. |
| `log.delete` | | base | Tombstone. An agent deletes only its own entries. |
| `source.patch` | fields | base | Affects every task linked to that source. |
| `source.unlink` | task, source, `link_version` | link version or base | Sets the link's `removed_at`. An already removed link is `unchanged`. |
| `task.label` | `add[]`, `remove[{label, link_version}]` | none for new links, link version or base to remove or revive | Per-label link rows. Unknown slugs create labels. |
| `area.*`, `project.*` | create, patch, move, archive, delete, restore | base for changes | As for tasks. Archiving a project with active tasks returns `HAS_ACTIVE_TASKS`. |
| `label.patch`, `label.delete` | | base | |
| `pref.set` | key, value | base on the preference | 3.16. An agent writes only keys whose declaration lists it. A policy key needs a human actor and the `admin` scope, else `forbidden` with rule `policy` (A3 3.4.11, 3.8.3, A6 3.6.3). |
| `proposal.accept`, `proposal.reject` | proposal, optional fresh `base` | human only | 3.10.5. |
| `attachment.add` | task, sha256, size, media type, file name | none | The blob is published first (3.18). |
| `space.patch` | name, ref prefix | human only | The old prefix is kept as an alias. |
| `space.hold`, `space.release` | reason | human only | Set or clear the hold `{by, at, reason, exchange_id?}`. While held, every write except `space.release` returns `SPACE_READ_ONLY` with reason `held`. Reads, search, backups and exports keep working. An `exchange.create` for an export can set the hold in the same commit (3.14). |
| `session.*`, `run.*`, `routine.*` | A4's records and transitions | as A4 defines, routines human only (R7) | Not undoable. |
| `exchange.create`, `exchange.apply`, `exchange.abandon` | 3.14 | human only (X15) | |
| `undo`, `redo`, `revert`, `revert_session` | 3.10 | | |
| `redact` | entity or text hash | human only, typed confirmation | 3.11.4. |

- A later operation in a request may touch a field an earlier one wrote, such as `task.complete` followed by `task.wrap_up` in an import: the base is checked once against the start state (3.7).
- The operation table records only unconditional preconditions. Handlers and the writer own the conditional ones (link versions, author rules, `pref.set`'s writers, a proposal's fresh base, `redact`'s confirmation, dedupe).
- Exchange, launch, session, run, machine and actor operations are never on an undo stack.

**Dedupe by source key (R4).** Built (`write/dedupe.ts`, staged in `write/writer.ts`; tests `[A1.5.write.dedupe]`, `[A1.5.write.dedupe-sessions]`). It runs after the receipt lookup, while the request is staged (3.7), so a retry replays its first answer whatever its keys hold now, also after the window. A draft's keys are those of the request's `source.add` operations that name its client ID; a draft without a client ID has none. `task.create.dedupe` picks the mode:
- `source_key`, the default, matches by the steps below.
- `new` creates a task beside finished matches, and refuses the request (`VALIDATION_FAILED` on `dedupe`) when an active task holds a key, so a caller never makes two active tasks for one item (A3's `create_new`).
- `none` never looks, as the importer creates each legacy task (A7 3.15.3).

1. A key's **holders** are the tasks linked to the live source with that key by a live link, that are not deleted: a removed link or a deleted task never matches. The request's own work counts as execution will see it: the links it adds before the draft, a draft it creates (which holds its keys from its create on, whatever the order of its source operations), and a task its earlier `task.reopen` makes active. A task its earlier `task.complete` finishes is the one finished last, and no match: a draft after it is new work, as `complete_task`'s follow-up of the same ticket is (A3 3.4.8), so it is created rather than matched to that task or to an earlier finish.
2. One **active** holder is the match: op status `existing` with the task, `matched_by: "source_key"` and its `lifecycle`. Several active holders: `existing` naming the first by reference, with `ambiguous: [refs]` listing them all, lowest first.
3. Otherwise a holder finished (completed or archived) within `tasks.dedupe_window_days` (default 30) of the request's instant is the match, the one finished last, with its lifecycle. A task finished at its `completed_at`, else at the commit that last wrote its lifecycle. Commit instants never go back (3.9), so two finishes can share one: the later commit is then the one finished last. The caller decides whether to reopen it or create anew with `new`.
4. Otherwise the task is created. A source whose key exists is linked, never duplicated; the unique index guarantees one row per key.

**Rebinding.** A draft **may match** when its create has a client ID, the default `dedupe` and a keyed `source.add` that names it. Only its entries (`log.add`, `note.add`, `task.context_append`), its sources (`source.add`) and its place (`place.set`) may name it, and never as a sibling (`after`, `before`). Any other operation that names it (`task.patch`, `task.move`, `task.complete`, `task.reopen`, `place.clear`) is `VALIDATION_FAILED` on its `task` or sibling field, checked from the input before the transaction, so whether a request is valid never depends on what the space holds under its keys. Applied to a match, such a change would hit a task the caller never read as this one, and left out it would be dropped unseen. A caller that wants both sends the change in a later request, or creates the draft with `new` or `none`.

A matched draft writes nothing of its own: not its values, its place or its sources. Its later operations:
- Its entries go on with the one active match. "Create or find, then add a log entry" is therefore one request, which A4's refresh routine needs.
- Its `source.add` operations go on with it only when the create has `link_sources` (A3's `add_sources`). Reviving a removed link still needs its link version or a base (3.5).
- Its `place.set` is left out, and still checked as a created draft's is (the request's machine has its record).
- Nothing follows an ambiguous or a finished match: the caller picks one, or reopens or creates anew first.
- A left-out operation's result is `existing` with the matched task. `commits.ops` records it and the matched create as `{existing: true}` with the matched task as target, holding no text of the draft. A request of only matched drafts writes no commit and is `unchanged`, with its receipt.

Policy (M4.02) sees the matched task and its actual area and project (the staged operation's `existing.match`), never the area the draft named. The single writer makes it safe: two refresh runs that report the same email cannot both create a task. A request that names an existing key reads its holders once: the sources by their unique index, then one pass over `task_sources`, which has no index on `source_id` in schema 0.2 (open item 17).

### 3.7 The write path

All writes go through the space's writer. The only writes that bypass history are bookkeeping: receipts of requests that changed nothing (3.8), the projection's outbox rows (marked rendered, or queued for a rebuild, `write/outbox.ts`, 3.13), search maintenance and incremental vacuum. All but those receipts are derivable.

**Where it lives.** `packages/storage/src/write/`: `request.ts` (types, `WRITE_LIMITS`, `WRITE_ERROR_CODES`, the checks before the transaction), `writer.ts` (`SpaceWriter`, `writeSystemCommit`), `fields.ts`, `positions.ts`, `receipts.ts`, `canonical.ts`, `launches.ts`. Storage keeps Zod out, because it would load in every worker. Tests: `[A1.5.write.*]`, including the model test `[A1.5.write.lost-update]`. Contracts map every storage code to a public code (`packages/contracts/src/a1-errors.ts`).

**What it guarantees.**
- One `BEGIN IMMEDIATE` transaction holds the checks, the receipt lookup (3.8), the base checks, staging, policy, execution and every write: state, `commits`, `changes`, the receipt, search rows and outbox rows. No window holds state without its history, and an acknowledged commit survives power loss (`synchronous=FULL`).
- Checks that depend only on the input run before the transaction and store nothing. Checks that depend on the space run inside it, so their refusal is decided and has a receipt.
- Every decided outcome is a value (`applied`, `unchanged`, `conflict`, `rejected`, later `proposed`), never an error. A conflict names the origin of the commit that set each field, so text applied through an import is labelled `import`, never the user. Storage failures stay `StorageError` and leave the request undecided.
- Problems name the operation and the field, never a value or a key, because a key is input too.
- Not built yet: `policy(plan, scope)` and proposals (M4.02), search rows (M3.05), the secret scan on written text (A6 3.16.4), and these limits: a learning at most 1 KiB and 20 per task, at most 20 labels per task, and internal importers (A7) committing up to 10,000 operations in one commit.

**Reasons and pitfalls.**
- Stored text is normalised before its limit is checked (`normaliseStored`), lone surrogates first, because SQLite stores UTF-8 and the row would otherwise differ from `commits.ops`.
- **Trusted statements only.** Every statement is a constant in `write/` with bound values. A space's writer handle refuses every raw SQL request (`STORAGE_MISUSE`): SQLite runs some pragmas while it compiles a statement (`prepare("PRAGMA foreign_keys=OFF; SELECT 1")` has changed the setting before it is refused), and transaction-control SQL could escape the worker's transaction.
- Commit rows come only from `SpaceWriter.submit` or `writeSystemCommit`: one format and one clock rule (3.9).
- **Staging (X11)** reads only the start state, and the base is checked once per (row, field) against it, so an operation never conflicts with its own request.
- **Execution** runs the operations in order after a `SAVEPOINT`, each seeing the writes before it, one `UPDATE` per operation (the CHECKs require a reopen to clear `wrap_state` in the statement that sets `lifecycle`). Coalescing leaves one change row per changed (row, field). A request that changed nothing rolls back, takes no seq and is `unchanged`.

**Not built yet.**
- **Policy** sees the actual targets: each task's current area and project, the matched task for a deduped draft, and both source and destination for a move. A cross-area move takes the more restrictive level. A6's machine and managed ceilings apply in the same evaluation. A caller-supplied draft area never selects the policy for an existing task elsewhere. The plan's count of tasks it would complete, archive, move or delete is added to the writer scope's recent count before A6's burst brake decides (X13).
- **Proposals** use the same staging and preconditions without executing. The proposal stores the staged operations, references resolved and dates fixed, so acceptance applies what the user reviewed. Its commit holds only the proposal row.
- **Outbox consumers.** `outbox(topic, key, first_seq, seq, …)` collects post-commit work that must not be lost, and commits already upsert it: `seq` becomes the newest commit and `first_seq` keeps the oldest unprocessed one. A consumer that processed a row as of snapshot T deletes it `WHERE … AND seq <= T`, so a newer upsert survives, and otherwise sets `first_seq = T + 1`. `last_error` is a code, never a message. Topics: `projection` (key: task ID, or `*` for indexes and the catalogue) and `redact` (3.11.4). Work that must happen **before** a change, such as a pre-import backup, never goes through the outbox (3.18).

**Change feed (X8).** The UI, bridges and later replicas follow a space through one feed contract. A1 owns its format, A2 carries it locally and A6 between machines. The compact form is built (`packages/service/src/http/feed.ts`); the full form for replicas and audience filtering are not.
- A batch covers the interval `(from, through]`: every commit in it is accounted for, whether carried or left out because the subscriber may not read it. An empty batch still advances coverage, so hidden commits never look like a gap and their content never leaks.
- The subscriber keeps an applied-through cursor `(epoch, incarnation, seq)` and accepts a batch only when `from` equals the cursor's `seq` and the epoch and incarnation match, applying it and moving the cursor in one step. A `from` beyond the cursor is a gap: ask for `changes(after = cursor)`, else take a fresh snapshot. Events at or below the cursor are skipped. An epoch or incarnation change always means a fresh snapshot. Gaps are judged by coverage, never by consecutive `seq` values.
- The coverage fields are part of the authenticated frame (A2's local channel, A6's device session). A subscriber never infers coverage from the events.
- The compact form carries `entities` with their post-change rows; the full form adds the `changes` rows (3.4). A child's event carries the child's row, and a subscriber that holds the task sets its `touched` itself. A launch moves nothing.
- A redact commit's event names the redacted IDs and carries no content (3.11.4).

**Crash behaviour.** Before `COMMIT` nothing of the request exists and a retry applies once; after it, a retry returns the stored result with `replayed: true`. The crash harness checks both (5). After `COMMIT`, before the projection, the outbox rows exist and the projection catches up at start; a crash during a projection write leaves `.tmp-` files and a journal, which the next start removes and plays forward (3.13, `[A1.5.projection.kill]`). Not built yet:
- An unreferenced attachment blob from a crash during staging is removed by `tasks space gc`.
- A transfer interrupted in `preparing` or `published` is reconciled at start (3.18). A redact commit whose cleanup did not run has its `redact` outbox row, and the cleanup runs at start.
- Disk full or an I/O error rolls back with `DURABILITY_FAILED`. The space then turns read-only until at least 200 MB are free and a `quick_check` passes (M3.15; today the error only reaches the caller). The UI keeps the unsaved edit visible.

### 3.8 Request IDs and receipts

Built: `write/receipts.ts` (its header states the fingerprint and what a receipt stores), `write/canonical.ts`, the lookup in `writer.ts`; tests `[A1.5.write.receipts]`, the crash invariants `receipt-per-commit`, `retry-applies-once` and `retry-replays-identically`, and the CLI retry in `packages/cli/test/accept.test.ts`.

**What it guarantees.**
- Every mutating request carries a `request_id`, generated once per intended change and reused only to retry it. The bridge never invents one (A3).
- Receipts are keyed by the writer scope A3 3.7.9 assigns (which names the machine, because receipts travel with the space) and the request ID. The lookup also tries the connection's earlier scope, so a retry after binding finds its first result.
- **One receipt per decided request (X12)**, no-ops and `existing` results included, written in the transaction of its commit and never deleted, not even by history compaction: an unreceipted no-op could turn into a change on retry. A request that stays undecided (shape and limit errors, busy, overload, timeout, durability, read-only, transport) stores none.
- **The lookup comes before the base, staging and policy,** so a replay returns the stored result whatever the state is now: a no-op unlink stays a no-op after a relink, and `existing` stays `existing` after the dedupe window. Another fingerprint is `REQUEST_ID_REUSED`.
- The fingerprint covers the intent, never the base, request ID, credential, `undoable` or scope. With a registry `intent` it covers the entry and its input as sent (A3 3.4.1), so a relative date that now resolves differently still replays. The service leaves `cwd` out unless a field resolves against it.
- **Strings are hashed exactly as sent:** `café` in NFC and NFD can be two different folders, and folding them would replay one intent for another.
- The receipt's key leaves the epoch and incarnation out, so a retry across a local claim finds it instead of applying twice.
- **Retry versus reconciliation.** A retry repeats one intent with one ID. A change made after re-reading, for example after a conflict, is a new decision with a new ID. The writer never aborts because the caller timed out.
- **CLI.** For a verb whose base the CLI fills (`set`, `done`, `reopen`) with `--request-id`, the CLI first calls `receipt.get` and resends the same input with the receipt's `as_of`, so a repeated command after a lost reply never re-expands with a fresh base.

### 3.9 Concurrency and threads

```text
main thread (event loop): HTTP, socket and pipe, bridges, UI streams      no SQLite connection to a space
   ├── storage worker per open space: the space's only write connection, its claim and writer.lock
   ├── reader connections: read-only, short transactions
   └── maintenance workers: the projection (one per open space, its own reader), backups,
       retention, exports, import diffs, rebuilds
```

**Workers** (`packages/storage/src/worker/`; tests `[A1.5.writer.worker]`, `[A1.5.driver.worker]`). A space is reached only through `StorageWorker.openSpaceWriter` and `openSpaceReader`, and the main thread never loads `node:sqlite`. A request that outlives `REQUEST_TIMEOUT_MS` may still be decided, so the caller retries with the same ID. A request keeps its queue place until the worker answers it, so timeouts cannot grow the real queue.

**Connections** (`open.ts`). The writer opens before the readers: with a busy timeout of 0, three workers opening one database at once failed 59 times in 40 rounds with `database is locked`. Each read is one transaction that also reads `as_of`, so read-your-writes needs no fencing. Long reads run on the maintenance worker in batches of at most 200 tasks per transaction: they delay WAL checkpoints, never writes.

**One writer per space within a process** (`worker/client.ts`, `[A1.5.writer.file-names]`, `[A1.5.writer.named-space]`). A writable connection is used only once its claim, in one registry in the main thread, holds the opened file's real path, its identity (device and file number, shared by hard links) and the space ID (`SPACE_WRITER_TAKEN`). The space ID is claimed before the open, because the open could already rebuild a copy's `space.json`. Neither driver exposes the opened file's handle, so the identity is a `stat` right after the open; on Linux and macOS a file renamed over the path in that moment is not detected. The in-thread `migrateSpace`, `restoreInPlace` and `recoverSpace` claim nothing and are not exported.

**One writer per space across processes** (`writer-lock.ts`, `[A1.5.writer.cross-process]`). Every route that writes a space holds its `writer.lock` for the writer's life (`SPACE_LOCKED_ELSEWHERE`).
- The lock is SQLite's own (`BEGIN EXCLUSIVE` with a memory journal on a connection that runs nothing else), so a holder that dies frees it at once and a hard kill leaves no `-journal`.
- When a writer's close fails, the lock stays until the worker's thread ends: the lock outlives the connection it guards, never the reverse.
- A database file with a second name is `SPACE_DATABASE_LINKED`: two folders naming one database would have two locks, and SQLite would keep a `-wal` beside each name.

**Not guaranteed:** an outside program that replaces the files of a live space.

**Busy handling.** `SQLITE_BUSY` can come only from outside, for example a `sqlite3` shell. After `busy_timeout` the request fails with `STORAGE_BUSY`, retryable with the same ID. `STORAGE_OVERLOADED` will carry `retry_after_ms` (open item 8).

**Outside writes.** Not built yet. Before each `BEGIN IMMEDIATE`, and every 5 s when idle, the writer reads `PRAGMA data_version`. Our own readers never write, so any change means another process wrote the database. The space then turns read-only, runs `quick_check` and a domain check (every `fv` value ≤ `last_seq`, every `version` matches a commit, references intact), records a system commit `external_write_detected`, and shows "Changed outside Tasks" (A6 3.16.3). If the checks pass, writes resume. If they fail, the user is offered a restore. Such writes are detected, never attributed or undone.

**Clock.** `commits.at` is `max(now, previous at)`, so history stays ordered if the clock steps back. Ordering always uses `seq`.

**Event loop target.** Main-thread event-loop delay p99 under 20 ms during the 10-session load test (3.20).

### 3.10 History, undo, redo and revert

Not built yet (M3.02, M3.03), except the `undoable` flag of 3.10.1. The history is `commits` plus `changes`. Every commit records principal, author, writer scope, machine, session, run, origin and reason. Agents' changes appear in the UI's history with their session (A5).

**Two numbers per field.**
- `fv[f]`, the **physical version**: the seq of the last commit that wrote f. It only grows. Bases and conflicts use it (3.5).
- `fp[f]`, the **provenance**: the seq of the commit whose write f currently holds. An ordinary write sets it to its own seq; an inversion sets it back to the provenance that stood before the inverted change.
- Invariant: a field's value always equals the after-value its provenance commit wrote for it. A field can hold commit C's provenance only while it holds exactly C's write and every later write to it has itself been inverted.

**Inverting a change.** Undo, redo and revert all invert change rows. Inverting change row `ch` of field f in a new commit N:
- **Guard:** `fp[f] = ch.after_prov`.
- **Effect:** the value becomes `ch.before`, `fp[f]` becomes `ch.before_prov`, and `fv[f]` becomes N. N's change row records `before_prov = ch.after_prov` and `after_prov = ch.before_prov`, so inverting N's row re-applies `ch` under the same kind of guard.
- **A `create`** is inverted by tombstoning the row. Its guard: every field of the row has a provenance from the creating commit, or from commits inverted together with it in a session revert, and every child row (note, log entry, learning, link, attachment, place) was created by those commits or is already tombstoned. Inverting a tombstone is a restore.

Physical versions never move backwards, so a stale base still conflicts after an undo. Value equality is never used (R2): a field set away and back by someone else would otherwise be overwritten without notice. For example, if Codex sets Mira's due date away and back, the value matches her write but its provenance does not, and her undo returns `UNDO_CONFLICT`.

#### 3.10.1 The undo stack

- Each human principal has one stack: the principal's commits with a non-null `undo_status`. A request with `undoable: true` (human principals only) sets its commit's `undo_status` to `done` and marks the principal's `undone` commits `dead`, so they can no longer be redone. Agents' commits, system commits, A4's record commits and migration commits keep it null.
- **Undo** takes the principal's newest commit C with `undo_status = 'done'` and `seq ≥ undo_floor_seq` and inverts each of its change rows. If all guards pass, a new commit U (kind `undo`, `undo_of = C.seq`) writes the inversions, and C becomes `undone` with `undone_by = U.seq`. If any guard fails, nothing is written: `UNDO_CONFLICT` lists each field with the value C wrote, the current value, who changed it and when. The UI then offers **Undo the rest** (a partial U), **Keep it**, or a new edit.
- **Redo** takes the oldest `undone` commit newer than the principal's newest `done` commit and inverts U's change rows as commit R (kind `redo`, `redo_of = C.seq`). The guard is the provenance U restored, and C's after-values return with C's own provenance. C becomes `done` again, so a later undo of C uses exactly the first undo's guards. A partial U redoes only what it undid.
- Two undos of one field both work: each inverts its own commit's row under its own provenance guard, without resetting any version.
- The stack lives in the database, so it survives restarts and works from the UI and the human CLI alike. The UI may show only the last 50 entries.
- Text inputs keep the browser's own undo while focused. The app's undo applies after the field is committed (A5).

#### 3.10.2 Revert one commit

Any commit, by any actor, can be reverted by a human from the history. The revert inverts the target's change rows under the guards above, as commit V (kind `revert`, `revert_of = target.id`), and the target records `reverted_by`. V joins the human's undo stack; undoing V re-applies the reverted change under the usual guards.

#### 3.10.3 Revert an agent session

`revert_session(session_id, {dry_run, allow_partial})` reverts everything one agent session did, as one atomic commit.
1. Collect the session's commits S by `session_id`. Accepted proposals from the session count, because their commits carry the session ID.
2. For each `(entity, field)` that S set, walk the provenance chain back from the current state: while `fp[f]` is a commit in S, plan the inversion of that commit's change row and continue from its `before_prov`. The walk stops at the first provenance outside S. If that is the provenance the field had before S's earliest change to it, the field is fully restored. Otherwise another actor's write stands between or on top of S's writes: the field is a conflict, and the walk never inverts past the foreign write. Example: S writes `initial → A` at 10, Mira `A → H` at 11, S `H → B` at 12. The walk inverts 12 back to H and stops; S's change at 10 stays unresolved.
3. A field whose provenance is already the one it had before S is skipped as done.
4. Rows S created are tombstoned only when the create guard passes with S as the creating set. A task that S created and Mira later annotated is a conflict and is not tombstoned.
5. `dry_run` returns the plan: fields restored, rows tombstoned, and each conflict with the foreign change that blocks it. The UI shows it before applying (A5).
6. Without `allow_partial`, any conflict blocks the whole revert. With it, the passing parts apply, including the partial walk of a conflicting field, and the result lists what stays unresolved.

Launch, session and run records are never reverted. Undo cannot recall an email the agent sent or a commit it pushed, and the UI says so (A5).

#### 3.10.4 Undo floor

Migrations that change a field's representation set `space.undo_floor_seq` to the migration commit's `seq` (the runner already does this for a step with `undoFloor`). Commits below the floor cannot be undone or reverted (`UNDO_BEFORE_FLOOR`), because their before-values have the old shape. History compaction moves the floor too (3.11.5).

#### 3.10.5 Proposals

Not built yet (M4.02). When A3's policy decides `propose`, the writer stages the request and checks its preconditions without executing it (3.7), stores the staged operations with their base in `proposals`, and commits only the proposal row. **Accept** re-runs the staged operations with the proposal's base; a field changed since then is shown as a conflict with both values, and the user may accept anyway with a fresh base. The applying commit has the human as `principal_id`, the proposer as `author_id`, the proposer's session and `proposal_id`, and it is on the human's undo stack. **Reject** marks the proposal and writes nothing else. A proposal becomes `superseded` when its task is deleted, or when the same session proposes new values for the same fields. Nothing expires on its own.

### 3.11 Completion, wrap-up, deletion and retention

#### 3.11.1 Check-off (D12)

`task.complete` (built) sets `lifecycle = 'completed'`, `completed_at`, `completed_by` and `wrap_state`: `wrapped` at once when the call carries an outcome (Full autonomy, D13), else `pending`. The task leaves every active view and every default agent query in the same commit. Not built yet: a human check-off is on the undo stack, so Ctrl+Z reopens the task under the usual guard; an agent completion is reverted from the history. A5's "checked off" list shows completed tasks with `pending`, and Completed shows the rest. Under Review autonomy, A3 turns an agent completion into a proposal and the task stays active until accepted.

#### 3.11.2 Wrap-up

`task.wrap_up` is additive.
- It writes `outcome` (at most 4 KiB) and adds or removes learning rows, then sets `wrap_state = 'wrapped'`, `wrapped_at` and `wrapped_by`.
- With `clear_planning: true` it also clears the short planning scalars `focus_on` and `planned_for`. Their old values stay in `changes`.
- It never changes `context`, notes, log entries, sources, places or attachments. A later wrap-up may rewrite the outcome or learnings with a base.

The vision's "planning context can be cleared" is met by retrieval, not by removal. For completed tasks, A3's default retrieval and the projection lead with outcome and learnings, and put context, notes and log under a "Record" section fetched only on request. A4's wrap-up routine calls this operation once per task.

#### 3.11.3 Reopen and archive

`task.reopen` (built) returns the task to `active`, clears `wrap_state`, `completed_at` and `completed_by`, and keeps the outcome and learnings as the previous result, which A5 shows as such. `task.archive` (not built) sets `archived` with a reason for work that will not be done; an archived task may be wrapped up like a completed one. Both keep the same ID and reference.

#### 3.11.4 Deletion and redaction

Not built yet (M3.04, M3.14).
- `task.delete` sets a tombstone. The task leaves views, search, the projection and the catalogue; its rows and history stay, and `task.restore` brings it back at any time. Trash lists tombstoned tasks. Nothing empties it automatically.
- Under Full autonomy an agent may delete, because deletion is recoverable. A6's destructive-burst brake turns a burst into proposals. It counts affected tasks per writer scope, not commits: each commit stores `affected`, `commits_scope` sums them over the window, and the staged plan's own count is added before the decision (3.7, X13).
- `redact` is the only destructive operation: human-only (UI with a typed confirmation, or an interactive CLI), never available to agents, never automatic.
  - **Entity mode** removes a task or note and its children from state. Launch, session and run rows keep their history with `task_id` set to null. The task's reference is never reused, and its IDs go into `redactions`.
  - **Text mode** replaces a literal string with `[redacted]` wherever it occurs.
  - The `redact` commit stores the affected IDs, and for text mode the SHA-256 and length of the string, never the text. Both modes record who and when.

**One traversal over every store.** Redaction is one procedure over a registry of stores. Every store that can hold task text registers a handler, and a test fails when a table or file store has none. Inside the redact transaction, with `PRAGMA secure_delete = ON`:

| Store | Entity mode | Text mode |
|---|---|---|
| Current rows: tasks, notes, log entries, learnings, sources linked only to this task, attachments rows, places | Deleted | String replaced in every text column, including titles, slugs, `ext` and source fields |
| `changes.before` and `after`, `history_text` | Values become `{"$redacted": true}`. Unreferenced `history_text` rows are deleted | String replaced. Each `history_text` row is rewritten under its new hash, and references follow |
| `commits.ops` and `commits.reason` | Payloads of the entity's operations become `{"$redacted": true}` | String replaced |
| `receipts.result` | Nothing to scrub: receipts hold no task text (3.8) | Same |
| `proposals.ops` and `alternatives` | Proposals that touch the entity become `superseded` (reason `redacted`) and their payloads are scrubbed | String replaced. Pending proposals that contained it become `superseded` |
| `exchanges`, `exchange_items.base` | Items for the entity are deleted. Open exchanges that held it become `abandoned` | String replaced. Open exchanges that held it become `abandoned` |
| `search_fts`, `search_docs`, `search_tri` | Documents deleted | Documents re-indexed |
| The projection's record and files, outbox rows | Rows for the entity deleted; its files go through the outbox (3.13) | Affected tasks marked dirty |

After the commit, the outbox topic `redact` finishes the rest, so a crash only delays it:
- The FTS index is rewritten with `optimize`, still with `secure_delete` on, so no deleted text survives in old segments or freed pages. Then a WAL checkpoint with `TRUNCATE` and an incremental vacuum remove old page images.
- Projection files are deleted or re-rendered. Copies under `exchange/rescued/` that contain the text are deleted.
- Files owned by other appendices go through their registered handlers, for example A4's run logs and event journals.
- In-memory caches drop the entities through the change feed: A3's digest and related-learning caches, search cursors (whose entries become `redacted` placeholders, 3.12) and A5's working sets. Replicas from L1 receive the redact event (A6).
- Blobs of deleted attachments are deleted at once when no other row references them.

**What stays outside reach.** Working-copy files of open exchanges may have been edited or moved: the confirmation screen lists their paths, deletes those inside `exchange/` when the user confirms, and lists the others. Existing backups and exports still hold the data: the screen says so and offers to delete those backups. Text an agent already read or sent elsewhere cannot be recalled.

#### 3.11.5 Retention and compaction

| Data | Default retention | Explicit action |
|---|---|---|
| Tasks, notes, log entries, learnings, sources (including tombstones) | Forever | `redact` only |
| Commit rows (history headers) and receipts | Forever | none |
| `changes` payloads and `history_text` | Forever | `tasks history compact --before <date>` |
| Proposals | Forever | none |
| Launch, session and run records | Forever (small) | A4 may define pruning of `detail` |
| Outbox rows | Until processed | none |
| Backups | 3.18's retention | `tasks space backups prune` |
| Exchange working copies | Until the user removes them | `tasks exchange clean` (applied or abandoned, older than 30 days) |

**History compaction** (not built) is human-only and previewed. `--dry-run` reports the commits affected, the bytes saved and the earliest commit that could still be undone. Applying it deletes `changes` rows of commits before the cutoff, marks those commits `compacted = 1`, strips long text from their `ops`, deletes unreferenced `history_text` and raises `undo_floor_seq`, because inversions need the removed before-values. Commit rows, receipts and attribution remain, and current state is never touched. The UI suggests it only when history passes 500 MB.

### 3.12 Search index tables

Built (M3.05) up to the schema step that creates the tables: released schemas are frozen and 0.2 does not hold them (3.4), so no space has an index until that step runs. The code is `packages/storage/src/search/`; tests `[A1.5.search.index]`, `[A1.5.search.rows-by-ids]`. A3 owns query syntax, ranking, result shape, budgets and cursors (R12). This appendix owns the tables and keeps them consistent.

```sql
CREATE TABLE search_docs (
  doc       INTEGER PRIMARY KEY,                 -- explicit rowid alias, stable across VACUUM; the FTS rowid
  kind      TEXT NOT NULL CHECK (kind IN ('task','note','log','learning','project','area')),
  entity_id TEXT NOT NULL UNIQUE,
  task_id   TEXT,                                -- owning task, to group hits
  lifecycle TEXT,                                -- owning task's lifecycle, for filters
  audience  TEXT NOT NULL DEFAULT 'all',         -- copied from the note; 'all' for everything else
  seq       INTEGER NOT NULL                     -- commit that last wrote this document
) STRICT;
CREATE INDEX search_docs_task ON search_docs(task_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, extra,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

-- What a change to an existing source, area or project reads to find the tasks that show it
-- (task_labels_label serves labels since 0.2).
CREATE INDEX task_sources_source ON task_sources(source_id);
CREATE INDEX tasks_area ON tasks(area_id);
CREATE INDEX tasks_project ON tasks(project_id);
```

| Document | `title` | `body` | `extra` |
|---|---|---|---|
| task | title | summary, context, outcome | source titles, `who`, `ref`, labels, project and area titles, reference `M-14` |
| note, log entry | owning task title | body | author label |
| learning | owning task title | body | project title |
| project, area | title | brief | slug |

**What it guarantees.**
- Once a space holds the tables (`hasSearchTables`, read when the writer attaches), every commit writes the documents its change rows reach, inside its own transaction (`indexChanges`). One function derives a document from the current state for both the commit and the rebuild, and a document whose content did not change keeps its row and its `seq`. So after any history the index equals a fresh rebuild, document numbers and seqs aside, and every FTS row has its `search_docs` row (`expectedDocuments`, `storedDocuments`).
- A document exists for every live row and only for it: a tombstoned task has none, and neither have its notes, log entries and learnings, nor any deleted row. `lifecycle` is the owning task's (null for areas and projects) and `audience` the note's. A restore re-adds the documents.
- What a change reaches: a task's title, lifecycle, tombstone or group (area and project) reaches its children's documents as well as its own, since a learning shows the task's project; its summary, context and outcome only its own; a source or a label every task that shows it; an area or a project its own document and its tasks' (a project's learnings too). A new source, label, area or project reaches no other task, because the links and tasks its commit adds have change rows of their own, so a commit that creates one reads no other task; a change to an existing one finds its tasks through the indexes above. Places, launches, preferences, proposals and exchanges hold no search text.
- The FTS table stores its own copy of the text, so snippets and highlights work and deletes need no old values, unlike external-content tables. A rewritten document keeps its number, so `doc` stays its FTS rowid.
- Agent queries join `search_docs` with `audience = 'all'`, so "only me" notes (D14) are excluded from agent search, agent reads and the projection with no migration.
- `rebuildSearchIndex` empties and refills both tables in the caller's write transaction, every document with the space's `last_seq`.
- **Pages by frozen IDs** (`search/rows.ts`). A3's cursors freeze an ordered list of task or learning IDs at a snapshot. A1 serves each page with `rows_by_ids(ids)` (`ROWS_BY_IDS_SQL`, `decodeRowsByIds`) in one read transaction, which returns the page's own `as_of` and one entry per ID, in order, never fewer: the current row with its `version`, `touched` and lifecycle; `{id, ref, state: "deleted"}` for a tombstoned task, or a deleted learning or one whose task is tombstoned; `{id, state: "redacted"}` for an ID with no row, with no content. Only entity redaction removes a row (3.11.4), so a missing row is a redacted one without a `redactions` lookup, and every ID in `redactions` has no row. Rows may be newer than the cursor's snapshot; the page's `as_of` is the base for writes. A3 invalidates a cursor when the space's epoch or incarnation differs from the cursor's.

**Limits.**
- **Broad queries are the cost.** A broad term matches a median of about 36,000 of the 108,000 documents at design scale (p95 about 72,000), so bm25 ranking of every match and snippets dominate. Selective queries (p95 about 20 ms) and no-hit queries (under 0.1 ms) are far below the target. M3.16 chooses a query design for broad terms (3.20).
- **Trigram.** An optional `search_tri` table with the `trigram` tokenizer, for substring and CJK search, stays behind `features.search_trigram`, off by default: its broad p95 is above the unicode61 index on Windows and Linux. Open item 4 decides the default.

**The schema step that adds the tables** runs `SEARCH_TABLE_STATEMENTS` (`search/tables.ts`, the DDL above) and then `rebuildSearchIndex` in its `up`, so a migrated space starts with a complete index, and adds `search_docs.kind` to `CLOSED_ENUMS`. Its `verify` counts `type = 'table'` rows only, as 0002's does, so FTS5's shadow tables are not judged as STRICT tables. Until it runs, the writer keeps no index and A3's search answers filters but not words (A3 3.9.2).

**Not built yet.** The `tasks index rebuild` verb; the maintenance worker's `INSERT INTO search_fts(search_fts, rank) VALUES ('merge', 500)` when idle and the FTS `integrity-check` weekly; and, with `space.patch`, re-indexing every task document when the reference prefix changes (each task's `extra` holds its reference).

### 3.13 The projection (D10)

Built (M3.10): `packages/projection`, each module's header holding its rules, run by the service in a worker thread per open space (`packages/service/src/hub/projection*.ts`); the writer's side is `write/outbox.ts`. Tests `[A1.5.projection.*]`. A generated, read-only Markdown tree plus a compact catalogue for people and file-only agents. Never a source of truth, never imported.

```text
view/
  README.md                         what this is, grep recipes, how to propose edits (3.14)
  catalog.jsonl                     one line per task that is not deleted
  index.md                          open tasks grouped by area, then project, one line each
  .projection.json                  {"space_id", "epoch", "incarnation", "seq", "generated_at", "format": 1}
  .projection-files.json            the record: every file written, its hash, each task's catalogue line
  open/M-14-fix-appointment-time-zones.md
  completed/2026/M-9-migrate-ci-to-the-new-runner.md
  archived/2026/…
```

- **File names** are `<reference>-<slug>.md`, with an ASCII slug of at most 48 characters cut at a word (`task` when the title has no ASCII letter or digit), so an agent finds a task with `view/open/M-14-*.md`. A completed or archived task goes under the year of its completion (of its creation when it has none) in the machine's time zone, as its dates do. A rename or a state change moves the file. Nothing links to projection paths by contract.
- **Sequence labels.** Each file's front matter carries `seq`, the commit of the task's last change (its `touched`), and `version`: what a fresh render gives, so a file is rewritten only when what it shows changed. `.projection.json` and the catalogue header carry the **watermark** W: every commit up to it is reflected in every file, and every path the catalogue names exists. Single files may be newer. A reader compares W with `tasks status` to see staleness. A folder without `.projection.json` claims nothing.
- **Content.** Front matter starts with `generated: true` and has fixed keys on their own lines (`space`, `ref`, `id`, `status`, `lifecycle`, `priority`, `effort`, `due`, `area`, `project`, `place` as `machine:root/path`, `version`, `seq`), each a value that reads back as the same string (plain where it can, double-quoted where not, empty for none), so `rg '^status: waiting' view/open` works. Then the title as H1, the summary line, and the sections Context, Sources, Notes and Log, each item a line such as `- n2 · 2026-11-10 · Mira Okafor → agents: …`, an item's text of more lines fenced under it. A section without items is left out. For completed and archived tasks, Outcome and Learnings come first and the rest goes under "Record". Notes with an audience other than `all` are never read, so never written.
- **Task text is shown, never run.** Agents write most of it, some from mail and tickets, so a Markdown viewer must show it and run or load nothing: no HTML, no link or image whose target is not the text shown, no entity, no structure (a heading, a list, a quote, a rule, a fence, a table) the projection did not write. A text of one line (a title, a summary, a name, a source's fields, an area's or a project's title in `index.md`) has a line break turned into a space and escaped with a backslash: `<`, `[`, the `&` of an entity reference, a backslash before punctuation, a block marker at the line's start and a heading's closing run of `#`. A text of more lines (context, outcome, a note, a log entry, a learning) goes verbatim into a fenced block one backtick longer than its longest run of backticks, so no line of it closes the block. Emphasis and code spans in a one-line text, and a GFM viewer's link on a bare URL or address, which shows its own target, may still render: no escape stops GFM's autolinks, and escaping every delimiter would bury the text in backslashes for the agents that read it raw. The catalogue holds every text exactly.
- **`catalog.jsonl`.** A header line `{"kind":"header","space","epoch","incarnation","seq","generated_at"}`, then one line per task sorted by lifecycle, then reference, with `ref`, `id`, `title`, `summary`, `status`, `lifecycle`, `priority`, `effort`, `due`, `area`, `project`, `labels`, `path` and `version`.
- **Read-only.** Files are 0400, or carry the Windows read-only attribute, from their creation: they hold task text, which every other file of a space keeps private (3.1).

**Regeneration.**
1. Commits upsert `projection` outbox rows: one per affected task, plus `*` when an index or the catalogue changes. Each row keeps `first_seq`, its oldest unrendered commit (3.7).
2. The projection's worker looks at the outbox every 100 ms, waits 500 ms after the last change, at most 5 s while changes keep coming, and runs the next batch at once while a backlog waits. A batch reads up to 200 dirty tasks, oldest `first_seq` first, in one read transaction at snapshot `T`. A failing batch is tried again after a pause that doubles up to 30 s.
3. For each task it renders the content. A file it replaces or removes must hash to what the record says it wrote there; anything else at that path (an edited file, a file of the person's, a folder, a link) is moved first to the space's `exchange/rescued/<stamp>/`, under its path in the tree, and the service records the batch's rescue in the space's machine-local settings (`projection_rescues`) for the UI to show once. This is best effort: a save between the check and the replace is lost, and nothing claims otherwise. The supported edit path is 3.14.
4. A journal (`.projection-journal.json`) names every file the batch is about to place. Each file is written to `.<name>.tmp-<random>`, read-only from its creation, and renamed over the old one, whose read-only flag is cleared just before on Windows; a rename retries 5 times over 1 s on Windows sharing violations. The new file is written before anything at its path is rescued, and what was rescued is put back when the rename then fails, so a failed write leaves a path the catalogue names in place. Across volumes (a `projection.dir` on another volume than the space) a rescued file is copied, then removed, and the copy goes again when the original cannot; a folder or a link there cannot be moved, so the task whose path it blocks fails, logged with its code, and W stays below it until the person moves it away. A file a task left (it moved, or the task is gone) is retired, not removed: the catalogue on disk still names it.
5. Through the writer (`write/outbox.ts`, a bookkeeping write, 3.7) it marks the tasks whose file is in place: their rows go `WHERE seq <= T`, and rows that changed again after `T` get `first_seq = T + 1`. A task that failed keeps its row, and the next batch takes it first.
6. **Watermark.** In the same transaction the writer answers `W`: `T` when no task row with `first_seq ≤ T` remains, otherwise the smallest remaining `first_seq` minus 1. The worker then writes `README.md`, `index.md` and `catalog.jsonl` from the catalogue lines stored in the record, which are exactly what was rendered, and `.projection.json` last, both headers with `seq = W`. Only then do the retired files go, each when it still holds what was written (rescued otherwise), so every path the catalogue names exists at every moment. A retired file that cannot be removed (open on Windows) fails the batch and stays retired, and every later batch publishes again and tries it until it goes. The record follows, then `*` is marked. `W` never moves backwards and never claims an unrendered commit. A commit that touches no task, such as a launch's, still moves it to `last_seq`.

**The record** (`.projection-files.json`) lives in the projection's folder, not in a table of the database: it describes the files of the folder it is in, so a moved, emptied or replaced folder cannot disagree with it, a new `projection.dir` starts a fresh tree, and no migration is needed. Every path it names is checked against the tree's grammar before it is used, so an edited record cannot reach outside the folder. **It describes the disk, or the tree is rebuilt.** A record that cannot be written fails its batch and keeps the journal; it is written before anything else, and no batch starts, so no journal is replaced, while the record on disk is behind. A journal that cannot be read, or a folder of the tree the record has files in that is missing or not a real folder, rebuilds the tree: the record no longer knows what is on disk. The folders are checked with `lstat` before every batch and at every look at the outbox, so a folder removed while nothing changes is noticed too.

**A kill** leaves at most `.tmp-` files, which the next start removes, and the journal, which it plays forward against the disk: a file that reached its place goes into the record and the path it replaced is retired, as is the file of a task the batch found gone. The outbox renders the rest. A kill never makes the projection rescue its own files, and never moves W past an unrendered commit.

**A full rebuild** (no record, an empty `view/`, a record of another space, epoch, incarnation or format, a journal that cannot be read, or a lost folder) removes `.projection.json` first, so the folder claims nothing, then `catalog.jsonl` and `index.md`, which name the old tree (one that cannot be removed is replaced at the rebuild's end), has the writer queue every task with `first_seq = 1`, and renders them as batches like any other. The old tree's files are retired, and go at the end only where they still hold what was written. It runs in place, not in a `view.new/` swapped in beside the folder: `projection.dir` may be a folder the person chose, where a sibling would appear, and a swap fails on Windows while a file is open. A file the projection cannot prove it wrote is never removed; where it blocks a file the projection writes, it is rescued.

**Where it runs.** Into the space's `view/`, or the machine-local `projection.dir` (3.16; read from `<state>/spaces/<space_id>.json`): an absolute folder outside the space's folder that does not hold it, checked as written and where the folders are on disk (links, junctions and other names of a folder resolved), so a link on the way changes nothing. One inside it, or holding it, is refused and nothing is written. A link where the folder or one of its folders goes is never followed: the folder itself is refused, before anything is written in it, the record included; every folder of a path is checked with `lstat` at each read, removal or write, never from an earlier look, since a batch waits on the writer meanwhile; a read or a removal finds nothing behind a link, a write rescues it, and where the record has files in that folder the tree is rebuilt. A write never makes such a folder again before the rebuild, so a kill in between cannot hide the loss from the next start. The service runs the projection only while the space is open as this machine's, in a worker thread with its own reader connection (3.9); a close stops it, after its batch in progress or at once after 5 s, before the writer it asks for its bookkeeping.

**Not built yet:** `projection.enabled` (3.16, M3.11), `tasks view rebuild`, `projects/<slug>.md` (a project's brief and its task references), a rebuild queued by every migration (3.17), and redaction's pass (3.11.4, M3.14). Redaction reaches the projection through the outbox like any change: a task the reads no longer find renders as no file, so its file and its catalogue line go, and a changed text is rendered again; the record holds catalogue lines, so the same pass rewrites it. The copies under `exchange/rescued/` are the one store it leaves to redaction. An operation that changes what a task's file shows without touching the task (a project's or an area's slug, a source's fields, the reference prefix) upserts the outbox row of every task it shows in.

**Never re-imported.** The importer accepts only working copies with an exchange manifest (3.14) and rejects any file with `generated: true`: "This is a generated view. Use `tasks export-edit` to get an editable copy."

### 3.14 Explicit import

Not built yet, except its tables (schema 0.2, 3.4). Direct file edits go through a previewed import with a stored base (D10). There is no watcher and no automatic ingestion. Every `exchange.*` operation is human-only (X15): the UI or an interactive CLI creates, previews and applies an exchange. Anyone, an agent included, may edit the working-copy files in between, but only a human applies them.

**1. Export a working copy.** `tasks export-edit M-14 M-15 [--query …] [--to <dir>]` creates an exchange: a commit `exchange.create` with an `exchanges` row and one `exchange_items` row per task, each with its `file` and its `base` (field values and note bodies as exported), stored in the database, not in the file. The folder is `exchange/<id>/` by default, or any folder the user names, such as the task's own folder when an agent's sandbox only writes there. The space holds no absolute path (3.4), so the export step decides how `exchanges.dir` names a folder outside the space. The folder holds `manifest.json` (`{exchange, space_id, base_seq, files: {...}}`), one file per task, and an empty `new/` folder for new tasks.

**Prototype exports (A7)** are exchanges of the same kind: one `exchange.create` commit whose `base_seq` is the export snapshot and one item per task, whose `file` holds the prototype marker. The commit changes no task; with a hold, it also sets the space hold (3.6). A return import from that folder uses these items as its base and its marker map.

**Working-copy grammar** (format 1):
- Front matter: a restricted YAML 1.2 core-schema subset of top-level keys, scalars and flow lists, at most 16 KiB. Anchors, aliases, tags and multi-document streams are rejected. Keys: `ref`, `id`, `exchange` (identity, never changed), and the editable `status`, `priority`, `effort`, `due`, `planned`, `labels`, `project`, `lifecycle`.
- Body: the H1 is the title. The paragraph before the first H2 is the summary, joined into one line. Then the known H2 sections `Context`, `Notes`, `Outcome` and `Learnings`, English and case-sensitive. Any other heading is content of its section.
- Notes: each existing note starts with a marker line `<!-- n2 -->` or `<!-- n2 to:agents -->`. A block without a marker is a new note. Learnings: one bullet each.
- Sources, log entries and places are not in the working copy. Agents change them through the agent interface (A3).

**2. Preview.** `tasks import <dir> --preview` parses every file and compares per logical field the stored base B, the current value C and the edited value E.

| Edited | Current | Result |
|---|---|---|
| E = B | any | No change |
| E ≠ B | unchanged since the export (field version ≤ `base_seq`) | Apply E |
| E ≠ B | changed since the export, and C = E | No change (already the same) |
| E ≠ B | changed since the export, and C ≠ E | Conflict, even if C happens to equal B again |
| New note block | | `note.add` |
| Edited note text | | `note.patch` with base `base_seq`, or a conflict |
| Missing note block, missing file | | Ignored and reported. Import never deletes. |
| `lifecycle: completed`, with Outcome and Learnings | | `task.complete`, then `task.wrap_up` |
| File in `new/` | | `task.create` with dedupe |

Long text such as Context is compared as a whole, never merged line by line. Unparseable files, duplicate IDs, a wrong `space` or `exchange`, conflict markers and files over 256 KiB are diagnostics, and nothing from that file applies. The preview prints a table per task and returns a `preview_token`: a hash of the planned operations and the current `seq` of the affected tasks.

**3. Apply.** `tasks import <dir> --apply --token <preview_token>` is human-only. It recomputes the plan and stops for a new preview if it differs.
- **Backup first.** When the plan has more than 50 changes, the writer takes the import request at the head of its queue and holds the queue. The maintenance worker takes and verifies a backup (3.18) of exactly that state while the writer waits. A failed backup stops the import with `BACKUP_FAILED` and nothing applies. Requests that arrive meanwhile wait, or get `STORAGE_OVERLOADED` or a timeout, both retryable.
- All non-conflicting changes commit as **one** commit, one undo step, staged like any other request (3.7).
- Each conflict becomes a proposal with `origin = 'import_conflict'` and `alternatives = {base, current, edited}`, which A5 shows for resolution. The exchange becomes `applied`. The request ID derives from the exchange ID and the token, so applying twice applies once.
- **Attribution.** The commit has origin `import` and the human who applied it as principal and author, with actor kind `human`. Origin `import` is provenance only: it never changes the actor kind policy sees, and no connection can claim the actor kind `import`, which only A7's internal importer uses (3.21).

### 3.15 Machines, roots and places (R11)

**Machines.** Each machine that writes a space as its authority gets a `machines` row (`machine.register`, 3.6) with the ID from its `machine.json` (A6 3.4). Identity is the ID, never the display name. A machine record is never deleted, and a retired machine keeps its places for history.

**Roots** are named base folders in `machine.toml` (A4 L1, A6 3.3). The database never stores a root's absolute path: places refer to `(machine_id, root_id)`, so another machine shows the place without being able to resolve it. A root that is itself a link is followed but stored as given, so retargeting the link moves the root.
- **Root revisions** (`<state>/roots.json`, `packages/service/src/config/root-revs.ts`) keep, per root ID, a revision and a hash of its path, never a path; a moved root rises by one and a removed root keeps its record. A damaged file restarts revisions at 1 (open item 9).
- **`tasks roots add`** is user-only: only the user adds roots, in setup or settings (A2, A5). It refuses a folder a place could not resolve exactly and a folder another root names, and appends through `editMachineToml`, so every other byte stays. Code: `packages/service/src/hub/roots.ts`, `packages/cli/src/roots.ts`; test `[A1.3.15.roots.add]`.
- Not built yet: `tasks roots rename <old> <new>`, which updates `machine.toml` and rebinds every place under it in one commit.

**Places.** A place is a row `(owner, machine_id, root_id, rel_path)`, at most one per owner and machine. Code: `packages/launch/src/places.ts` (`resolvePlace`, `checkWorkingFolder`, `placeOf`), `git-remote.ts`, and the binding in `packages/service/src/ops/places.ts`. Tests: `[A1.3.15.places.*]` (`packages/launch/test/places*.test.ts`, `working-folder.test.ts`, `git-config.test.ts`; `packages/service/test/places*.test.ts`).
- A place's logical field `folder` is root, path, kind and identity together, so binding another folder to an owner that already has a place on this machine needs a base.
- The writer does no file I/O. The service resolves an absolute folder or `cwd` with `placeOf` and reads the Git remote, and the operation carries the result.
- The relative path is checked as sent, before text normalisation, which would silently drop a control instead of refusing it. Structured place fields never take an absolute path (A6 3.3).
- A folder under no root is `PLACE_OUTSIDE_ROOTS`: a new task is created without a place with a warning, an update refuses (A3).

**Resolution** for a launch. Built: the task's own place, and the task work folder `<state>/workdirs/space-<space_id>/` (`packages/launch/src/shim/folder.ts`) for a task with no place anywhere. A place on another machine never falls back to the work folder (R11). The work folder is checked like a place with the state folder as its root, and held to more because Tasks owns it (its header states the rules). Not built yet: the project's and the area's places.

```text
resolve(task, M = this machine):
  for owner in [task, task.project, task.area]:          # nearest wins; paths are never joined
    p = live place of owner with machine_id = M
    if p: return resolvePlace(p, roots of M)
  if any place of task, project or area exists on another machine: return {status: "other_machine", machine}
  return {status: "none"}                                # A4 then uses the task work folder (X9)
```

There is no fallback to another clone, a containing project, a parent folder, the same root name on another machine, the current directory or the last folder used. A failed resolution names its reason, and A4 disables the route with it. A resolved place's **version** is the newer of the task's place-field version and the version of the place record that resolved; A6 binds it into remote authorizations (A6 3.8).

**Exactness in two parts** (stated in `places.ts`'s header). A path cannot be checked and used at one moment from Node, so `resolvePlace` promises only that at one stat the place named a directory with this identity inside the root, and `checkWorkingFolder`, run by the process that works in the folder after it entered it and before it starts anything, checks through `.` and `..` the folder's and the root's identity and the remote.
- **Use.** A route whose process Tasks starts in the folder calls `resolvePlace` right before the launch and hands that process the folder and the check in its claim's reply (A4 3.6.3), never in argv, which a process listing shows, or the environment, which the agent inherits. Routes where none of our processes is in the folder get only the first part (A4).
- **Windows** reads `.` and `..` through the path, not the held handle; what ties path to directory there is that a folder a process is in, and every folder above it, cannot be renamed or removed. Residual, asserted by a test: a junction put into the path before the process entered and removed before the check. The check passes, but the process holds the link's target, so a later change of the path could move a later child. Untested: a reparse point set on the held folder itself.
- **Identity, never spelling.** Inside the root is confirmed by identity, so `C:\workshop` is never inside `C:\work`. A volume without file numbers gives `identity_unavailable`, and `tasks roots add` refuses it, because comparing paths instead would make two folders `A` and `a` one. Unstable file numbers (FAT) are not detected.
- **A link to a file is `not_a_directory`** on every platform, and a dangling link `path_missing`: the reason is the one Linux's own stat gives. Linux and macOS follow a link to a file, so there a failed stat is `path_missing`. Windows cannot follow a junction or a directory link to a file, and its stat calls the path missing. So on Windows, after a failed stat, `resolvePlace` (for a folder place) and `placeOf` read the link's own chain with lstat and readlink, at most 40 links as Linux follows them (41 is a loop). A relative target is taken from the real folder its link lies in, never from the path's spelling, because a link reached through another link leads where the file system takes it. A chain that ends at something other than a folder is `not_a_directory`, anything else `path_missing`. That read only picks the refusal, so it never makes a place resolve. Links in the path's earlier segments are not counted toward the 40. Tests: `[A1.3.15.places.resolve]`, `[A1.3.15.places.prop]`.
- **The Git remote is an observation, not an identity**, read by a port of git's own config parser (`git-remote.ts`); the product never starts git. What the parser cannot read exactly records no remote, never a guess, and the place is bound with a warning (A3). Credentials are removed as text and nothing else changes, so two addresses git keeps apart are never recorded as one.

**Limits of exactness.** A process may change its own working directory after the check. Two names of one directory by a hard link cannot be told apart. The Windows residual above. A repository changed while its remote is read. A place bound by `{root, path}` is not checked against the folder, so its remote is recorded only when the folder resolves at bind time.

**Rebind folders** (not built yet). Moving a space to a new machine leaves places bound to the old one. `tasks places rebind --from <machine> --map work=work,oss=code` previews, for each old place, the new `(machine, root, rel_path)` on this machine and whether it resolves. On apply, one commit creates the new places; the old ones stay as the other machine's bindings.

### 3.16 Preferences and feature flags

Not built yet (M3.11), except that the writer already checks status and effort against `tasks.statuses` and `tasks.effort_scale` or their defaults, and reads `tasks.dedupe_window_days` for dedupe (3.6), taking its default for a value that is not a whole number of days from 0 to 3,650. One registry in code declares every preference:

```ts
pref("ui.theme",              { scope: "space",   schema: { enum: ["sumi", "washi", "system"] }, default: "sumi", writers: ["human", "agent"], since: "0.1" });
pref("tasks.statuses",        { scope: "space",   schema: StatusList, default: ["open", "waiting", "review", "backlog"], writers: ["human", "agent"] });
pref("tasks.effort_scale",    { scope: "space",   schema: EffortScale, default: [{key: "S"}, {key: "M"}, {key: "L"}] });
pref("tasks.dedupe_window_days", { scope: "space", schema: { type: "integer", minimum: 0, maximum: 3650 }, default: 30 });
pref("grouping.names",        { scope: "space",   schema: GroupNames, default: {area: "Area", project: "Project"} });
pref("autonomy.level",        { scope: "space",   policy: true, schema: { enum: ["full", "review", "suggest"] }, default: "review" });  // setup asks (D13)
pref("targets.default",       { scope: "space",   schema: InstanceRef, default: null });       // A4: references only
pref("projection.enabled",    { scope: "space",   schema: { type: "boolean" }, default: true });
pref("projection.dir",        { scope: "machine", schema: PathString, default: null });
flag("features.search_trigram", { default: false, stability: "preview" });
```

- **Space scope** lives in the `preferences` table. `pref.set` is an ordinary operation: in history, undoable, with a base. It travels with backups and exports.
- **Machine scope** lives in the machine-local config (A2), with the same registry and validation. It never travels.
- **Writers.** `policy: true` keys (autonomy and its overrides, A3 3.8.2) change only through a human principal with the `admin` scope (R7). An agent writes only keys whose declaration lists it. Run permissions and the burst limit are machine-local (A4 3.11.6, A6 3.16.3). A managed-machine policy file (A6 3.16.5) can lock keys.
- **Versioning.** Each key has a schema version, and an entry may declare an upgrade function that a migration step runs. A stored value with a newer `schema_ver` than this build knows is kept unchanged and treated as read-only, and the default is used. Unknown keys are kept, so an older build never drops a newer build's settings. A removed key's name is never reused.
- **Feature flags** are boolean or enum keys under `features.`. They gate behaviour only: schema migrations always run in full. A flag for a graduated feature stays readable and is ignored.
- Settings never carry CSS, HTML, scripts, SQL or command lines.
- **The theme until then.** The UI keeps the theme per browser (A5). The settings step decides whether `ui.theme` stays a space key: a theme per space would change the colours when a tab switches space, so a machine or browser scope may fit better.

### 3.17 Schema versions and migrations

**Version numbers kept apart:** the app version (SemVer); the space format `major.minor` (`space` row and `space.json`); the schema revision (`PRAGMA user_version`, `major × 1000 + minor`); the operation schema `v` in `commits.ops`; the projection format; the working-copy format. A2 owns the wire and API versions.

**App versions** (`manifest.ts`) are compared by SemVer precedence. `min_reader` and `min_writer` persist in `space.json` and every later app must parse them, so the accepted syntax may only widen and today's order must stay.

**Schema steps** are `SchemaStep`s in `packages/storage/migrations/`, listed in `migrations/index.ts`. The runner, open and restore read one step chain (`migrate/steps.ts`). Creating a space runs every step, so a new and a migrated space have the same schema.

**Released schemas are frozen.** Real spaces exist at 0.1 and 0.2, so `0001` and `0002` are never edited and every change is a new step, the next being `0003`. Testkit pins each released schema (`RELEASED_SCHEMAS`) and the 0.1 sample's rows (`FIXED_SAMPLE_0_1`), never updated. Older revisions' fixtures are built from their step chain, never checked in. The runner's tests and the crash harness use one stand-in step above the real ones, which a new real step rebases.

**How a migration runs** is in the header of `migrate/runner.ts` (tests `[A1.5.migration.*]`): inside the writer's open, under its claim and `writer.lock`, before the write path attaches; never by open itself, and only on the authority (`SPACE_NEEDS_MIGRATION` elsewhere). A copy from another machine is claimed first, then migrated, so no migration commit extends the old incarnation's history in a second folder.

**Reasons and pitfalls.**
- **Every attempt makes its own barrier backup** and never reuses or removes one (3.1): a copy the attempt did not make could vanish by its producer's rollback, by retention or by the person.
- The runner proves the backup is the state it changes through `data_version`, instead of holding `BEGIN IMMEDIATE` across the asynchronous backup, which would break the driver's synchronous-transaction rule.
- **All pending steps run in one transaction:** one per step would leave an intermediate revision the barrier backup no longer matches. A step that rebuilds a table follows SQLite's twelve-step ALTER procedure, with foreign keys off around the transaction.
- A failure leaves the space `read_only(migration_failed)` at its old revision, with a message that names the barrier backup, never a path, in status and `tasks space list`, never in the log.
- **A failed migration is not tried again by itself** (`spaces.ts`, `space-settings.ts`, `[A2.3.1.hub.failed-migration]`), else every open would add a barrier backup. It is tried again only when the build, the database's state or the person (`--retry-migration`, user classes only) changed. A record that cannot be read or written errs towards trying. A source build is always `0.0.0 (source)`, so a fix made in source needs the person's retry.
- **The open's bound** (`SPACE_OPEN_TIMEOUT_MS`, `[A2.3.1.hub.migration-timeout]`). Past it the service stops the open's worker, and an uncommitted migration goes with it. A timeout records nothing, so a migration that always runs past the bound and then fails adds a barrier backup at every open (open item 15).

**Compatibility rules.**
- **Before 1.0** (format `0.x`): any step may be breaking. Every step still ships with a migration, a backup and tests, because real spaces depend on them.
- **0.2 and older builds.** A 0.1 build reads a 0.2 space and never writes it, and restores no 0.2 backup (`[A1.5.migration.older-build]`). Schema 0.2's `min_reader` and `min_writer` stay `0.0.0`, because no release version exists to name as the floor: the writer's refusal of any newer revision is what stops an older build.
- **After 1.0**: within a major, steps are additive. New columns have defaults. New enum values are added only where older builds treat unknown values safely. Unknown preference keys and `ext` keys round-trip. Breaking steps only in a new major.
- **Opening a newer space:** a build never writes a schema revision it does not know, whatever `min_writer` says. It reads one only with a manifest that vouches for it and app ≥ `min_reader`. On a known revision, app < `min_writer` opens read-only. Below `min_reader` open refuses, naming the version needed.
- **Downgrade** is a restore of the pre-migration backup, with a warning that later work is lost, or an export and import into a new space.
- Not built yet: a step that asks for it rebuilds the search tables, and every migration queues a full projection rebuild.

**The agent migration prompt** (not built yet). Deterministic code always does the structural work; agents never edit the database or write SQL. A step that needs judgement, for example splitting "waiting" into "waiting" and "delegated", migrates mechanically and creates `migration_review` proposals for the affected tasks. Its `reviewPrompt` ships in the release notes and is printed by `tasks migrate --prompt`, telling the agent to list those proposals, read each task, accept or patch, and change nothing else. The agent works through the agent interface, under the usual autonomy and history.

### 3.18 Backup, export, restore and moving a space

**Built:** the verified backup with its sidecar, the barrier backup before every migration, daily backups and retention, listing and leftovers, restore into a new folder and in place with a restore claim, the read-only copy and its claim, recovery of a rollback journal, and the bundle limits on backups. Code: `packages/storage/src/backup/` and `restore/`, each module with its rules in its header; the service's maintenance in `packages/service/src/hub/maintenance*.ts`. Tests: `[A1.5.backup.*]`, `[A1.5.restore.*]`, `[A1.5.writer.cross-process]` for the swap guard. **Not built:** export bundles, transfer, fork, bundle import, attachments and `tasks space gc` (M3.07, M3.08).

**Backups: reasons and pitfalls** (`backup/`, each module's header states its rules).
- A backup is a single-step copy from a separate read-only connection: `node:sqlite` restarts a multi-step backup whenever another connection writes, so only one step gives a consistent snapshot while the writer continues.
- **The sidecar is the commit point:** a `.db.gz` without one is a leftover, never a backup. **Verified** is defined once (`backup/verify.ts`) as every check a restore makes, and retention never uses a cheaper one.
- **Publishing still replaces.** The writer publishes by renames onto reserved names, and removes the pair it just published when its last step fails. Both act only on its own output, and a barrier backup is its attempt's own, so neither can remove a backup a migration runs behind. A hardening step (M3.07) publishes without replacing.
- **Leftovers.** A backups folder can be shared with other programs, so only a backup's own names are removed, file by file, once untouched for an hour. The age rule is no lock, so cleanup runs only in a space's own `backups/` while its service holds `writer.lock`; a machine-local `backup.dir` is never cleaned.
- Backups are plaintext, owner-only files (A6 3.16.6) of `space.db` only; the export bundle adds the attachment blobs.

**When.** Daily for a space open as this machine's, then retention (`backup/retention.ts`; it unpacks backups to verify them, so it never runs hourly). **Barrier backups** come before a change, never after it: before every migration attempt (built), every fork and every import of more than 50 changes. The writer holds its queue, so no write runs between the snapshot and the change, and a failed backup stops the change with `BACKUP_FAILED`. Barrier backups never go through the outbox. A claim takes none (its commit writes only the space row), nor does a restore in place (the replaced folder is its barrier). Not built: the export bundle is the off-machine copy, so the app reminds the user once a week to export one.

**Bundle limits (DA-17).** One frozen `BUNDLE_POLICY` (`backup/policy.ts`) serves every side that writes or reads an archive, so nothing writes an archive it would refuse to read. It bounds what extraction produces, counted while streaming, never what a header claims. The compression ratio is not a rule: text-heavy data compresses about 180:1, so a high ratio is only logged. The values are first choices (open item 5). Not built: the exporter checks the same limits before it writes.

**Restores: guarantees and pitfalls** (`restore/`).
- A restore into a new folder is verified in staging, marked read-only and renamed into place, so a crash cannot leave a writable copy under the target's name.
- **A restored copy is read-only until claimed.** The mark is `space.transfer` in the database, so a copy of `space.db` alone keeps it and `space.json` cannot change it. M3.08's roles replace `restored_copy` with A6's `read_only_copy`.
- **Restore in place** claims the verified copy in staging before swapping it in, so no crash leaves the unclaimed old incarnation under the space's name. The live folder is kept as `<slug>.replaced-<stamp>`. Local sessions get `EPOCH_CHANGED` and re-read.
- **The swap guard** renames nothing unless `writer.lock` is still the file this holder took. Windows refuses to rename a folder with an open file, so there the lock ends right before the swap and the guard compares the database files' sizes and times. A space path whose last part is a link is refused: renaming the link would leave the folder in place, and a second recovery would make two writable copies of one incarnation.
- Between the swap's two renames no folder has the space's name, so open refuses rather than opening a wrong space, and `finishInterruptedRestore` completes or undoes the swap before a space opens.
- **Recovery of a rollback journal** (`recoverSpace`) never touches the live files: it plays the journal back in a copy, judges it as a writer's open would, and swaps it in without a claim, since it is the space's own last committed state.

**Restore and import of a bundle** (not built; `tasks space restore <backup>`, `tasks space import <bundle>`) never overwrite a live space except by an explicit restore in place.
1. Reject absolute paths, `..`, links and device files, and enforce the bundle limits while streaming.
2. Unpack into a new folder. Verify checksums and sizes, `integrity_check`, `user_version`, and `space_id` against `space.json`.
3. The space opens with the role from A6 3.5. A transfer bundle becomes `authority` only when its statement verifies, its `to` is this machine, and its transfer ID is not in this machine's `transfers_imported`; the import then records the transfer ID there. A backup, a copied folder or a transfer bundle for another machine becomes `read_only_copy` until the user claims or forks it.

**Export bundle** (not built; `tasks space export --mode backup|fork`, or `--mode transfer --to <machine_id>`, A6 3.5): a zip built in a temporary folder.

```text
export.json            {mode, space_id, epoch, incarnation, seq, created_at, files: {path: {sha256, size}}, transfer_statement?}
space.json
space.db               consistent snapshot, as for a backup
attachments/…          exactly the blobs that snapshot references
view/…                 projection regenerated from the snapshot, so the bundle reads without the app
data.jsonl             optional (--with-jsonl): every table, one record per line, for other tools
```

The exporter checks that no file comes from the secrets folder and no string matches the secret patterns (A6 3.16.4), verifies every checksum, and only then renames the zip into place.

**Transfer states** (not built). A transfer moves authority, so it cannot be one atomic step across the database and the file system. It is a durable state machine in `space.transfer` with restart reconciliation. `--mode transfer` requires `--to <machine_id>`, the destination's ID from `tasks machine show` (X6).

| State | Entered when | Writes | On restart |
|---|---|---|---|
| none | | Accepted | |
| `preparing` | The writer quiesces, waits for active runs (A4) and commits `{id: tr_…, state, to, through_seq, path, started_at}` | Refused, `SPACE_READ_ONLY` with reason `transfer_pending` | If a file at `path` verifies against this transfer ID, advance to `published`. Otherwise delete temporary files, clear `transfer` and accept writes again, with "The transfer did not finish. Nothing was published." |
| `published` | The verified zip was renamed to `path` and the folder fsynced, then the writer committed the bundle's SHA-256 | Refused, `SPACE_READ_ONLY` with reason `transfer_pending` | Continue to `finalized` |
| `finalized` | The role `transferred_out` and the lineage are committed and `space.json` is rewritten | Refused, `space_transferred` | Nothing to do |

- A6's role is `transfer_pending` in `preparing` and `published`, and `transferred_out` from `finalized` on.
- The single rename into the final local path is the publication point. Any failure before it (checksum, secret scan, disk full, fsync, the rename itself) aborts to the writable state and removes temporary files. If the rename's outcome is uncertain, reconciliation checks the final path.
- Copying the bundle elsewhere is a later step by the user. A transfer is never published straight to a network or removable path.
- After `published` the source never becomes authority again on its own. **Cancel transfer** needs the user's confirmation that the bundle was imported nowhere. The bundle is kept and its path reported (3.1), and the space resumes with a new epoch and incarnation of kind `transfer_cancelled`, so a stray copy imported later shows up as a competing branch (A6).
- The transfer statement carries the transfer ID and `to`. A6 signs and verifies it.

**Claims and new incarnations (X6).** A claim, a restore claim and a transfer import each create a new random incarnation and a new epoch in one commit (`space.claim`, 3.4). The new epoch is one more than the highest epoch known on this machine: the copy's own and its lineage's, the live space's when a restore in place can read it, and `spaces_seen`. Two claims of one backup on two machines therefore produce two incarnations, possibly with the same epoch, which A6 detects as competing branches. Claim and restore claim are built (`restore/claim.ts`); the transfer import is not.

**Moving a space to another folder.** There is no move command: a space leaves a folder by a backup restored into a new folder and claimed (3.2 prints the commands), and the person changes the path in `machine.toml`. A move command is a later step (open item 14), built on the export, restore, transfer and claim primitives, and must keep these rules:
1. The source is retired durably first, and that is confirmed before anything else is done: from then on it takes no write. No moment has two writable copies.
2. The destination folder is created exclusively, never by a rename that could replace what is there, and it is not a space until its manifest is written, last.
3. The product deletes or overwrites no file that may hold data.
4. An interrupted move leaves the space closed, and names both folders and the two commands that resolve it: finish into the new folder, or cancel back to the old one.
5. The old copy is kept until the person removes it.

A check followed by a delete or a rename on a path cannot be made atomic from Node, and a rename replaces an empty folder at its destination on Linux and macOS. So a move that makes the new folder a space before the old one is retired, or that settles an interruption by inspecting folders afterwards, can lose an acknowledged write or leave two writable copies.

**Moving a space to another machine** (not built). On the new machine run `tasks machine show` and note its ID; on the old one run `tasks space export --mode transfer --to <id>`; on the new one run `tasks space import <bundle>`. The new machine becomes the authority with a new epoch and incarnation. Then Rebind folders (3.15). A closed space folder copied by hand opens as a `read_only_copy` and needs Claim or Fork (A6 3.5).

**Attachments** (not built). Ingestion writes to `attachments/staging/<random>`, flushes, hashes, then renames to `attachments/sha256/<first two hex>/<hash>`, and only then commits the `attachments` row, so a committed row never points at an incomplete blob. `tasks space gc --dry-run` lists blobs no row references that are older than 24 hours; applying it deletes them, except blobs a running backup or export holds. The default size limit is 25 MB per file (at most 1 GiB). Links remain the normal way to point at documents. A restore in place carries `attachments/` across the swap.

### 3.19 The storage adapter (D11)

Domain code uses the interfaces in `packages/storage/src/driver.ts`, whose comments state each rule. Only `packages/storage` imports `node:sqlite` (`node-sqlite.ts`). The driver contract suite (`test/driver-contract.ts`, exported as `@tasks/storage/driver-contract`, `[A1.5.driver.*]`) pins every rule below on Linux and Windows and never assumes one SQLite version for both drivers.

**Drivers.**
- **Primary: `node:sqlite`** in the pinned Node runtime (A2), a release candidate. Builds made with `--shared-sqlite` can lack FTS5, which is why the start-up check runs at every worker start.
- **Fallback: `better-sqlite3`** from the 13 line (not built yet, M3.13), pinned to the newest 13-line release at least a day old when added (A6 3.16.7). Since 13.0 it has no install script and ships prebuilt N-API binaries, so nothing is compiled at install time; A2's archive carries only the platform's own `prebuilds/<platform>-<arch>.node`. It bundles its own SQLite, which can differ from Node's. It must pass the same contract suite. One driver ships per release; `TASKS_SQLITE_DRIVER` overrides it, for tests only.
- **Switching to the fallback**, if a Node update shows a defect (missing FTS5, crashes, an API break, write latency far above target), is a change of the build's driver choice. The file format is plain SQLite either way, so no data migration is needed.
- Replication uses `changes` rows (A6 K7). Nothing depends on SQLite's session extension.

**Start-up check** (`startup-check.ts`). No space opens unless the driver reports SQLite ≥ 3.45.0, working FTS5, `json_valid`, STRICT tables and a single-step backup (A2 3.12.1's gate). It asks the driver itself on a private in-memory connection: never `process.versions.sqlite`, which reports Node's SQLite even when the fallback runs, and never a space connection, where a corrupt file would look like an unsupported build. Space connections open only through a `CheckedDriver`, so a look-alike object opens no file. `tasks doctor` prints the driver, the SQLite version and the compile options.

**Reasons and pitfalls.**
- `create` defaults to false and the open mode enforces it, so a space whose database went missing never reopens empty; an existence check before the open would race.
- **One way into SQLite** (`sqlite-uri.ts`, `[A1.5.writer.file-names]`): every file name reaches SQLite only as the `file:` URI `sqliteUri` builds, so SQLite opens exactly the path given. `pathToFileURL` is not used: it makes `\\server\share` an authority SQLite refuses and drops `\\?\`. A new route of a file name into SQLite must meet this rule and get a test.
- **SQL cannot name a file.** An authorizer refuses `ATTACH` of any name but the empty one, `VACUUM INTO` and the directory pragmas, so a second database is opened through the driver, never through SQL. `limits.attach = 0` is not used, because it also refuses `VACUUM`.
- **Transactions are synchronous** and do not nest. Not detectable: a function that starts async work and does not return it; its continuation runs after the commit.
- `prepare()` refuses text after its first statement, which SQLite would silently drop. Reusing a statement while an earlier iteration is open is refused, because the old iteration's cleanup could reset the new execution (an `INSERT … RETURNING` inserted twice).
- `node:sqlite` has no `sqlite3_bind_parameter_name`, so placeholders are parsed by a scanner that follows SQLite's tokenizer (`sql-text.ts`) and confirmed against `sqlite3_expanded_sql`.
- **Integers** are read as bigints and returned as numbers within ±(2^53 − 1), so nothing rounds and no conversion can fail after an implicit commit. Every integer as a bigint is not used: domain code would then handle bigints for timestamps and counts.
- **Errors carry no data.** A binding's message is never passed on, because it can hold a bound value (a `RAISE(ABORT, NEW.title)`, an FTS5 query, SQL text), and neither is a trigger's `RAISE` message: a later step that needs a reason from a trigger registers public constants and checks that its triggers raise literals only. Errors cross the worker boundary as codes only.

### 3.20 Scale and performance targets

This section is the plan's one definition of scale and performance targets (P2). Other appendices refer to it and do not restate the numbers. Real use stays far below the design scale, so these are headroom targets, measured on two reference machines: one running Windows and one running Linux.

**Two corpora.**
- **Design scale**, per space: 5,000 open and 50,000 completed tasks, 10 concurrent agent sessions.
- **Stress corpus**, for tests: 10,000 open and 100,000 completed tasks. A7 builds it as a fixture generator from the sample profile.

**Targets owned here (the data layer, inside the service).**

| Quantity | Estimate or target |
|---|---|
| Database size at design scale | About 600 MB: tasks 110 MB, notes and log 80 MB, history 250 MB, search 150 MB |
| Database size at personal scale | Under 50 MB per year |
| Commit latency, `synchronous=FULL`, one-task patch | p50 under 3 ms, p95 under 10 ms (Windows). Under 25 ms p95 (Linux) |
| Sustained writes | 10 sessions × 1 write per second with p95 under 25 ms, and no `STORAGE_OVERLOADED` |
| Get a task by reference with children | Under 2 ms |
| Today and open-view query, 5,000 open | Under 30 ms |
| Raw FTS query, top 20 with snippets, design scale | p95 under 50 ms (Windows), under 100 ms (Linux) |
| Undo or revert of one commit | Under 10 ms. Session revert of 500 commits under 500 ms |
| Incremental projection of one task | Visible in `view/` within 1 s of the commit |
| Full projection rebuild, 55,000 files | Under 60 s on Ubuntu, under 180 s on Windows with Defender |
| Backup at 600 MB | Under 30 s including the integrity check, about 150 MB compressed |
| Search index rebuild | Under 30 s |
| Event-loop delay on the main thread | p99 under 20 ms during the 10-session test |

**Measured** (M0 rows R02 to R06, Node 26.13.1 with SQLite 3.54.1).
- Met on Windows and Linux: backup plus `integrity_check` at 600 MB (5.0 s and 5.5 s), commit latency (p95 1.02 ms on Windows, 20.1 ms on Linux: a small margin, so M1.15 measures again on the installed build; a p99 near 20 ms on Windows is probably WAL checkpoints inside commits, open item 11), sustained writes, and the full projection rebuild (28.6 s and 12.2 s).
- History measured about 410 MB against the 250 MB estimate, partly from a WITHOUT ROWID `changes` table, which the schema does not use (3.4). The bench measures other layouts beside its own schema (`--layout`), never by changing the schema.
- **Not met: the raw FTS target for broad queries on Windows** (p95 57.6 and 52.3 ms against 50 ms; the 54.6 ms on Linux passed its 100 ms; the heavy-text profile missed on both, about 102 to 105 ms). The tighter Windows limit, not a slow machine, is what fails. Until a re-measure passes on Windows and Linux (M3.16, after it chooses a query design for broad terms, 3.12), the Windows FTS target and A3's stress-corpus `search` targets count as unmet.

**Targets other appendices own, using these corpora.**

| Owner | Target |
|---|---|
| A3 | `search` tool call end to end: p95 under 150 ms (Windows) and 300 ms (Linux), on the stress corpus. `get_task` p95 under 50 ms. |
| A5 | List interaction targets at design scale (5,000 open tasks). |
| A2 | The service handles two spaces at design scale at once. |

### 3.21 Interfaces this appendix assumes

- **A2** provides the service process lock (`service.lock`) that makes one service own its registered spaces, the `config`, `state` and `cache` folders under `~/.tasks`, `machine.json` creation, the space states the service reports (`read_only(reason)`, `unavailable(reason)`), the CLI front end for the commands named here (generated from the registry, R5, with the `space` verbs as service methods), and the authenticated local channel that carries the change feed (3.7). Each request reaching the writer carries `scope_id`, any earlier scope of the same connection, `principal_id`, `actor_kind`, an optional `author_id`, `machine_id`, `origin` and optional `session_id` and `run_id`, all taken from the credential. No connection can present the actor kind `import`. A2 serves `receipt.get` for the CLI's receipt-first retry (3.8). Storage takes each space's `writer.lock`, and the service watches it (3.9).
- **A3** owns the operation registry and the tools, and the writer scope per connection class (A3 3.7.9). It supplies `policy(plan, scope)`, evaluated on the staged plan's actual targets with the more restrictive level for cross-area moves (autonomy, burst brake, R7, X11). It decides who generates request IDs; the bridge never invents one. It maps the write path's error codes (`WRITE_ERROR_CODES`, 3.7), passes the caller's intent with the operations it expanded (3.8), tells agents to take a new `request_id` after a conflict, and leads completed-task retrieval with outcome and learnings (3.11.2). A handler refusal that depends only on the input stores no receipt; one that depends on the space's state is the writer's and stores one. Its names match A1: `task.context_append`, `link_version` on removals and revivals, `rows_by_ids` placeholders for cursors (3.12). All `exchange.*` entries are user-only.
- **A4** owns the states of launches, sessions, runs and routines, the `ExecutionStore` interface that writes them (X7), the task work folder (X9), and the roots and instances in `machine.toml`. It calls `resolve()` and `checkWorkingFolder` (3.15), runs every transition as an operation, and registers a redaction handler for run logs and event journals (3.11.4).
- **A5** owns how history, conflicts, proposals, Trash, the checked-off list and the read-only reasons look. Its task route reads one task by ID in every lifecycle, including a deleted task that is still restorable (`task.get`). It reads the compact form of the change feed and treats empty batches and coverage gaps as 3.7 defines.
- **A6** owns roles, epochs, the meaning of incarnations and competing branches, claims, forks, transfer statements (signed, with the transfer ID and `to`), stale-restore detection and the replica protocol. It consumes `commits`, `changes` and the feed keyed by `(epoch, incarnation, seq)`, and carries the full feed form between machines from L1. Its burst brake counts the `affected` tasks per writer scope.
- **A7** owns the prototype importer. It writes through internal operations in large commits, with origin `import`, the human who starts it as principal, the `import` actor as author and aliases in namespace `planning`. It builds the stress-corpus generator (3.20).

---

## 5. Verification

Every test carries its ID from `tests/manifest.json` (`[A1.5.…]`, `[A1.3.15.…]`). Unit and contract tests run in CI on Linux and Windows, and against both drivers once the fallback exists (M3.13).

**Built and pinned by tests.** Each group's cases live in its test files; the section that states the rule names them.

| Area | IDs | Files |
|---|---|---|
| Driver, start-up check, workers | `driver.*` | `packages/storage/test/driver-contract.ts`, `test/node-sqlite.test.ts`, `test/checked-driver.test.ts`, `src/*.test.ts` |
| One writer per file, file names, cross-process lock | `writer.*` | `test/writer-worker.test.ts`, `test/file-names.test.ts`, `test/writer-lock.test.ts` |
| Space folder, manifest, IDs, references, row domain | `space.*`, `ids.property`, `refs.short` | `test/space.test.ts`, `test/manifest.test.ts`, `test/files.test.ts`, `test/refs.test.ts`, `src/*.test.ts` |
| Schema lint | `schema.lint` | `test/schema-lint.test.ts` |
| Write path, receipts, launches, dedupe | `write.*` | `test/write-path.test.ts`, `children`, `clear-append`, `receipts`, `launches`, `write-model`, `dedupe` |
| Errors | `errors.codes` | `test/errors.test.ts`, `packages/contracts/src/a1-errors.test.ts` |
| Search index, pages by frozen IDs | `search.*` | `test/search-index.test.ts`, with the stand-ins of later operations in `test/search-helpers.ts` |
| Migrations | `migration.*`; `A2.3.1.hub.failed-migration`, `A2.3.1.hub.migration-timeout` | `test/migrate.test.ts`, `tests/migration/`, `packages/service/test/migration-open.test.ts`, `packages/cli/test/migration-drill.test.ts` |
| Backups and restore | `backup.*`, `restore.*` | `test/backup.test.ts`, `test/retention.test.ts`, `test/restore.test.ts` |
| Synced and network folders | `sync.*` | `packages/service/test/sync-folders.test.ts`, `synced-spaces.test.ts` |
| Projection | `projection.*` | `packages/projection/test/`, `packages/storage/test/outbox.test.ts`, `packages/service/test/projection.test.ts` |
| Places and roots | `A1.3.15.*` | `packages/launch/test/places*.test.ts`, `working-folder.test.ts`, `git-config.test.ts`, `packages/service/test/places*.test.ts`, `packages/cli/test/roots.test.ts` |
| Crash harness | `crash.*` | `tests/crash/` |

**The crash harness** (`tests/crash/`) kills real processes in a loop during a 10-session workload, and an invariant checker judges what each kill left. Rules that keep it honest:
- Only a worker entry module can set the fault seams; the product's `entry.ts` passes none, and no request, setting or environment variable reaches them.
- **Every check compares the database with a record the database did not write** (requests sent, results seen, decisions the write seam reported, replaced folders on disk). A check of the database against itself passes a half-applied request.
- **The ledger is a lower bound:** a request in flight at the kill may have committed.
- **What a process kill cannot show:** power loss, a torn sector, a lying disk, an OS crash, so fsync order and `synchronous` are not tested (a planted `synchronous = OFF` runs clean). Not covered yet: a full disk, an outside write, two processes or state folders (`writer.lock` has its own tests), recovery from a rollback journal (open item 10), retention, leftover cleanup, macOS.

**The migration tests** migrate each released revision's fixture to current (`[A1.5.migration.from-0.1]`) and fail every statement boundary of the migration's transaction in turn (`[A1.5.migration.statement-faults]`), and a new schema step adds its fixture and its fault sweep. The installed-build drill (`[A1.5.migration.drill]`, `pnpm accept m3 --part migration --installed <folder>`) runs against an unmodified signed build, with a trigger as its fault because a product build has no fault hook, before a build with a new schema step reaches a real space.

**Still to add with their steps.**
- **Schema lint:** every replicated column changes only through `changes` (an audit trigger log compared with the `changes` rows of a random workload). Every store that can hold task text has a registered redaction handler (M3.14).
- **Staged execution (X11).** The import recipe `task.complete` then `task.wrap_up` with the exported base applies. A draft naming a Full area that dedupes to a task in a Suggest area becomes a proposal. A draft whose project belongs to another area than the one it names is judged by the project's area. A move between areas takes the more restrictive level. Proposals store resolved operations with fixed dates.
- **Receipts with unlink.** A retry of a no-op `source.unlink` after someone relinked the source returns `unchanged` and leaves the new link.
- **Link versions.** An agent reads, the user removes and re-adds a source, then the agent's delayed removal arrives: `VERSION_CONFLICT`, and the link stays.
- **Change feed (X8).** A run of hidden-only commits produces empty batches that advance coverage. A batch whose `from` skips the cursor triggers `changes(after)`, then a snapshot. An epoch or incarnation change forces a snapshot. Every commit appears exactly once.
- **Incarnations (X6).** A cursor from another incarnation returns `EPOCH_CHANGED`. A transfer bundle for another machine opens read-only. A second import of the same transfer bundle is refused.
- **Bundle limits** for export bundles: a highly compressible export round-trips with a ratio above 100; archives over the entry, per-file or total limit stop during extraction and leave no folder behind; the exporter refuses what the importer would refuse.
- **Undo, redo and revert lineage**, fixed scenarios before the property tests: two edits of one field, then two undos and two redos, all matching each step; partially overlapping field sets (C1 `{summary, due}`, C2 `{due, status}`: undo C2, then C1, then redo both); repeated undo and redo cycles keep passing while `fv` only grows; a foreign edit gives `UNDO_CONFLICT`, and after the foreign commit is reverted the original action's revert passes; session revert with S, Mira, S on one field (blocked without `allow_partial`, Mira's value with it and S's first change unresolved); session revert of a task S created and Mira annotated (no tombstone, a conflict naming her note; without the note, tombstoned).
- **Property and model-based tests (fast-check).** The built model test (creates, patches with fresh and stale bases, moves, lifecycle changes, three actors) grows to 3 to 12 actors with appends, link removals and revivals, wrap-ups, deletes, undo, redo, revert and session revert, and these properties: no lost update; undo, redo and revert never change a field whose provenance differs from the guard, and undo then redo restores the original values; every field's `fv` is the `seq` of its latest change row and `fp` that row's `after_prov`; every field's value equals its provenance commit's after-value; search rows match a fresh rebuild; the projection after quiescence matches a fresh render; the import table of 3.14 holds for random B, C and E, and nothing is deleted.
- **Redaction.** A unique sentinel goes into a task title, its context, a note, a log entry, a source title, a learning, a commit reason, a pending proposal and an open exchange, then a redaction in each mode. A byte scan of `space.db`, its WAL and every file under the space and state folders finds no sentinel, free pages and FTS segments included. The proposal is `superseded`, the exchange `abandoned`, and neither can bring the text back. Cursor pages show `redacted` placeholders.
- **Projection.** Deletes crossing batch boundaries join `[A1.5.projection.fresh]`'s moves with `task.delete` (M3.04). The process crash harness gains the projection's rename (below); `tests/crash/checker.ts` then accepts outbox rows the projection consumed.
- **Crash points added with their features:** during the projection rename, during attachment staging, during a barrier backup before an import, and after a redact commit before its cleanup; after each restart the projection catches up. **Pre-import backup:** a kill after the backup and before the import commit leaves the backup equal to the state before the import, and the import not applied; a failing backup stops the import with `BACKUP_FAILED`. **Transfer:** a kill at each step (before `preparing`, during the build, after the rename before `published` is committed, before `finalized`) ends, after reconciliation, either writable with no valid bundle at the final path or transferred out with exactly one; never writable with a valid bundle, never refusing writes with none. Disk full and a failed secret scan during the build return to writable. **Disk full** on a small loop or VHD file system: `DURABILITY_FAILED`, read-only, no partial commit. **Outside write:** a second process writes a row, and the service detects it within 5 s and turns read-only until checks pass.
- **Scale tests.** The generator builds both corpora (3.20). The benchmark records each target on both reference machines and fails the build when a target regresses by more than 50 percent.
- **Real-machine checks (D18, R17)** on both reference machines, user-level only: create a space under `~/.tasks/spaces`, run the 10-session load test, run a backup, export and restore, kill the service mid-load, and confirm with the detector that the file system is local and unsynced.
- **M0 checks.** M0-1 to M0-5 are done (3.20). M0-6 is not measured yet: the cost of `PRAGMA secure_delete = ON` for a redaction at design scale, so the redact step can state its expected time (M3.14).

## 6. Open items

Item numbers are stable and never reused, so a settled item leaves a gap.

2. **History size at the design point.** If real agent use writes much more history than estimated, suggest compaction earlier than 500 MB. Receipts of no-ops add rows too; M1.15 measures their share.
3. **Projection of completed tasks at 50,000.** If the Windows full rebuild misses its target, project completed tasks only into `catalog.jsonl` and yearly index files, and render their files on demand.
4. **Trigram search.** Enable `features.search_trigram` by default only if its size stays under 2× the unicode61 index and it meets the search target (M3.16). Which size the rule measures is not decided: all FTS5 shadow tables of each index (1.70 in M0), index pages only (2.18), or both indexes installed against unicode61 alone (2.70, the growth of the database when the flag is on). M3.16 decides it before it judges the default.
5. **Bundle limit values.** The numbers in `BUNDLE_POLICY` are first choices. M3 checks them against the stress corpus with attachments and adjusts them in the shared policy, never in one side only.
6. **Incarnation tag length.** The agent-carried `as_of` uses an 8-character tag (40 bits). If A3's token-budget tests show that a shorter tag matters, a shorter one still needs a collision only between two incarnations of the same epoch. The full ID stays in every internal token either way.
7. **Removing crash leftovers.** `tasks space list` lists `.<slug>.creating-*` folders and `.space.json.tmp-*` files (3.1). Removing them (`tasks space cleanup`) needs the backup leftovers' age rule (3.18) and a guard against a create or restore still running.
8. **`retry_after_ms`.** `STORAGE_OVERLOADED` does not carry it yet (3.9).
9. **Root revision floor.** A damaged `roots.json` restarts revisions at 1, which could repeat a revision L1 has seen. L1 adds a floor, for example the time (3.15).
10. **Recovery fault seam.** `RecoverSeams` needs a `faults.recover` in the worker's `ServeOptions` before the crash harness can kill a recovery at its seams (5).
11. **WAL checkpoints inside commits.** The writer leaves SQLite's automatic checkpoint on, so a commit that crosses the threshold runs the checkpoint itself, the likely cause of R03's p99 near 20 ms (3.20). Whether to move checkpoints out of commits (for example `wal_autocheckpoint = 0` on the writer and a passive checkpoint on the maintenance worker when idle) is not decided. M1.15's measurement on the installed build decides it.
12. **Repairing a damaged `space.json`.** A damaged manifest stops every writer (3.1), and today the person repairs or removes the file by hand. An operator command that repairs it from the database while keeping the original file is not built yet.
13. **Field maps of A4's records.** The planned `sessions` and `runs` tables carry no `fv` and `fp`, and `routines` only `fv` (3.4). The steps that build them decide whether these rows get both maps, as every other row with history has, or why they need none.
14. **A move command.** A space leaves a folder by backup, restore into a new folder and claim (3.2). A later step builds `tasks space move` on the transfer and claim primitives, under the five rules in 3.18, and decides how the `[[spaces]]` entry in `machine.toml` follows it.
15. **Backups of a space whose migration keeps failing.** Retention never runs for a space whose migration failed, and a timeout records nothing because its outcome is not known when the open ends (3.17). So a migration that always runs past the open's bound and then fails adds a barrier backup at every open. Recording the late failure when it arrives would bound that case too.
16. **Who else can write a space folder.** Storage writes `writer.lock`, `writer.json` and the databases into an existing space folder, and the folder that holds spaces, without judging their owner or mode (3.1), while A6's threat model expects space folders to be checked at start. That check needs its own step and a rule for spaces on removable or synced drives, where every file can show mode 0777 and another owner.
17. **An index for a source's links.** Dedupe reads a key's holders through `task_sources`, whose key is `(task_id, source_id)`, so a request that names an existing key passes over every link once (3.6), and so will `source.patch` and the importer's shared sources. The default is to add `CREATE INDEX task_sources_source ON task_sources(source_id)` in the next schema step (0003); M3.16's scale run shows whether the pass matters before then.
