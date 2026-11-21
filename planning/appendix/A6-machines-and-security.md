# A6. Machines, sync, phone, teams, the hosted service, security and privacy

> What is left in this document is background for parts that are not built yet. The code and its tests are the source of truth for everything that is built, and `docs/promises-and-limits.md` says what a person can count on. Do not add to this document.

## 3. Specification

### 3.3 Foundation hooks that v1 must contain

Each hook is cheap in v1 and prevents a rewrite later. The owner implements it. A built hook's shape lives in its code. Later phases rely on what the table says it carries.

| Hook | v1 content | Owner | Built |
|---|---|---|---|
| Space envelope | `space_id`, `authority` (machine, epoch, incarnation, start `seq`, later `sign_public`) and `lineage` (fork origin and one entry per incarnation with its kind and parent) (3.5) | A1 | Yes, without `sign_public` until machine keys exist. `packages/storage/src/rows.ts` |
| Committed sequence | One monotonic `seq` per space that continues across transfers. `as_of`, `base` and cursors carry `(epoch, incarnation, seq)` | A1 | Yes |
| Applicable operation records | Each operation stores after-values and field versions for every field it touches, so a replica applies it without business logic | A1 | Yes, `[A1.5.write.coalesce]` |
| Actor model | Principal, author, writer scope, `machine_id` and actor kind on every operation, from the credential, never from client JSON. No connection can present `import` | A1, A3 | Yes, `packages/contracts/src/define.ts` |
| Machines and folders | A `machines` table. A folder is `(owner, machine_id, path)`, an absolute path with the home as `~`, which only its own machine expands (A1 3.15). Paths travel with the space | A1, A4 | Machines yes, folders with M4.09 (today: places of a root and a relative path) |
| Receipts | A durable receipt per terminal result, keyed by writer scope and `request_id`, storing the epoch and incarnation it was committed in. Uniqueness leaves both out, so a retry across a local claim finds its receipt (A1 3.8) | A1 | Yes, `[A1.5.write.receipts]` |
| Grants | One `grants` table in `service.sqlite` for every credential, from L1 also `device` (A2 3.2.5) | A2 | Yes, for `ui` and `agent_home`. `packages/service/src/local/grants.ts`. The grant gate reads the `agent_home` rows at every agent home's call (3.16.3) |
| Registry metadata | Per operation: required scope (3.6.3), allowed actor kinds, a `remote` class (`never`, `read`, `write`, `execute`) and an audience filter | A3 | Yes, `packages/contracts/src/define.ts` |
| Change feed | A snapshot, then batches carrying `(epoch, incarnation)` and a coverage interval. Empty batches advance coverage. v1 sends every operation, but the batch format is final (3.7.1) | A1 (format), A2, A5 | Yes, `packages/service/src/http/feed.ts` |
| Execution store | Launch intents, sessions and runs go through `ExecutionStore`. The v1 backend writes to the space database | A4 | Partly: launch intents and runs (`packages/launch/src/store.ts`). Session records sit in machine state (`<state>/sessions.json`) until binding writes A1's `sessions` table, which schema 0.3 adds |
| Note audience | D14's field: `all`, later `owner` and `members` | A1 | Yes |
| Machine keys | Ed25519 and X25519 key pairs and a host fingerprint, created at the first start (3.4) | A2 | No |
| Copy detection | Read-only copies, stale-restore and competing-branch detection, claim, fork and transfer states (3.5) | A1, A2 | Partly: a restored copy opens read-only until claimed |
| Presence fields | `desktop` (`unlocked`, `locked`, `none`, `unknown`) and executor readiness, reported locally for the UI first | A2, A4 | No |
| Remote envelope types | In the registry's type package, exposed by no transport | A3 | Yes, types only: `packages/contracts/src/remote.ts`, named by no entry or generated face (`[A6.3.3.remote-envelope]`) |

### 3.5 Authority, epochs, incarnations, copies and restores

**Epoch and incarnation (R20).** The epoch is an integer that rises every time authority changes hands or a restore is accepted as current. It orders authority changes but does not identify one. The incarnation is a random ID that names one stretch of authority. Every create, claim, transfer import, restore claim and cancelled transfer starts a new incarnation with a lineage entry of that kind (`packages/storage/src/rows.ts`). Copies with the same incarnation share one history. Copies with different incarnations never match silently, even at the same epoch.

**Built:** create, the claim of a read-only copy, the restore claim of a restore in place, and export bundles in backup and fork mode with their restore as a read-only copy (A1 3.18). **Not built:** transfers, fork import, the full role model, and stale-restore and competing-branch detection (M3.08).

**Local role of a space on a machine:**

| Role | Meaning | Writes |
|---|---|---|
| `authority` | `space.authority.machine_id` is this machine and no descendant incarnation is known | Accepted |
| `read_only_copy` | A backup restored into a new folder, a folder owned by another machine, a stale restore, or a transfer bundle made for another machine | Refused: `SPACE_READ_ONLY_COPY` for a restored copy, `SPACE_READ_ONLY` with reason `not_authority` for another machine's folder |
| `transfer_pending` | A transfer export in A1's state `preparing` or `published`, or an uncertain publication | `SPACE_READ_ONLY`, reason `transfer_pending` |
| `transferred_out` | This machine published a transfer bundle | `space_transferred`, naming the destination |
| `superseded` | A descendant incarnation is known (in v1 from an opened folder or bundle, from L1 also from a connected machine) | `space_superseded` |

A copy whose incarnation competes with another known copy keeps its role and is flagged `competing`.

**A restored copy is read-only until claimed** (A1 3.18). The mark lives in the space's database, so no copy of the folder loses it. The role model (M3.08) replaces its `restored_copy` value with the `read_only_copy` role and fork. Until then every transfer state must keep treating that value as read-only. `packages/storage/src/restore/restore.ts`, `[A1.5.restore.read-only-copy]`.

**Claiming a copy** (`ttasks space claim`) commits a new incarnation of kind `claim`, an epoch above every one known on this machine and the end of the mark, in one transaction. It is refused while the original's writer is open in the process, because the claim is a writer of the same space ID. The claim runs on the copy's own revision and the next writer open migrates it, never the other way round, because a migration commit under the old incarnation would fork its history. So a schema step that changes `space` or `commits` must keep the claim working on the revisions it migrates from. The warning says "If another computer still has this space, its later changes will not appear here." The claim's answer carries it, and `ttasks space claim` prints it (`packages/service/src/hub/space-verbs.ts` `CLAIM_WARNING`). A claim records the copy in `machine.toml` as a space of this machine, and every other entry of the space that serves nothing now as closed. At a start the copy that last opened as this machine's writer opens first (`writer_folder` in the space's machine-local settings), so an original listed before the claimed copy never takes the writer back, also when its record failed or the person opened the original again (A2 3.1). Until M3.08's transfer, another machine's folder (`not_authority`) is not claimed where it is: the refusal names the way that works, export it, close it, restore the bundle into a new folder and claim that copy. `packages/storage/src/restore/claim.ts`, `[A1.5.restore.one-writer]`, `[A1.5.restore.claim]`, `[A2.3.10.cli.space-words]`.

**Highest epoch seen.** Each space's machine-local settings hold `seen` (`spaces_seen`), the highest `{epoch, incarnation}` this machine has seen. Every claim and restore claim goes above it. Stale-restore detection adds its freshness floors with M3.08 (below). `packages/service/src/hub/space-settings.ts`, `[A2.3.1.hub.startup]`.

**Transitions.** All are user-only operations. A2 implements the CLI.

| Event | Effect |
|---|---|
| Create | `authority`, epoch 1, incarnation of kind `create`, `seq` 0 |
| `ttasks space export --mode backup` | A consistent copy through the SQLite backup API, marked `backup`. Role unchanged |
| `ttasks space export --mode transfer --to <machine_id>` | From `authority` only. `--to` is required. Writes are quiesced and active runs awaited (A4), then the space is exported through `seq` N with a **transfer statement** signed by the machine key: `{transfer_id, space_id, from_machine, epoch, incarnation, through_seq: N, to, issued_at}`. Role `transfer_pending`, then `transferred_out` |
| Import of a transfer bundle on the machine named in `to` | Verify the statement against the issuing incarnation's `sign_public` in the lineage. `authority` with an epoch one above the highest known here and a new incarnation of kind `transfer` whose parent is the issuing incarnation at N. `transfer_id` is recorded as consumed |
| The same bundle on another machine, or imported a second time | `read_only_copy`. The screen says "This transfer was made for <machine>" or "This transfer was already imported here", and offers View, Claim or Fork |
| Restore into a new folder, a backup bundle, a copied folder | `read_only_copy` with View, Claim or Fork |
| Restore in place | A restore claim (kind `restore_claim`) in the staging folder before the swap, epoch above every one known (A1 3.18) |
| `ttasks space fork <space>` | A new space: new `space_id`, epoch 1, new incarnation, `lineage.forked_from = {space_id, incarnation, seq}` |
| Descendant incarnation seen | `superseded`. The service offers "Export changes made here since <seq>" as an import file for review (A1's previewed import). Nothing merges automatically |

**Transfer states.** A1 persists them and reconciles at restart:
1. **Prepare.** Writes refused (`transfer_pending`). The bundle goes to a temporary file. A failed checksum, a secret-scan hit, a full disk, or a failed write, rename or fsync before the rename removes the temporary file and returns the space to `authority`. No bundle exists at the final path.
2. **Publish.** The bundle is renamed into place and its folder synced.
3. **Finalize.** The space records `transferred_out` (A1's `finalized`).

At restart a `transfer_pending` space with no bundle at the final path returns to `authority`. A complete bundle whose checksums and statement verify gives `transferred_out`. Anything else, such as a bundle that fails verification or sits on a detached drive, is an uncertain publication: the space stays `transfer_pending`, and the UI offers Finish transfer and Cancel transfer (`ttasks space transfer --finish|--cancel <space>`). Cancel is also offered in `transferred_out` until the destination reports an import. A cancel after a bundle may exist starts an incarnation of kind `transfer_cancelled` (epoch + 1), and the source accepts writes again. Importing the old bundle anyway gives competing branches, never a silent supersession.

**When two copies meet** (a folder or bundle of a known space opened or imported, and from L1 machines and devices connecting):
- **Same incarnation:** one history. A lower `seq` is behind (stale restore).
- **One descends from the other** through parent links, each transfer link backed by its signed statement and from L1 by a signed handover (3.6.5): the ancestor becomes `superseded` if it holds operations after the fork point, and those are offered as an import file for review.
- **Neither descends** (two Claims of one backup on disconnected machines, at any epochs): a **competing branch**. TTasks merges nothing and supersedes neither, and the epoch alone never decides. Both copies show "Another copy of this space also acts as its main copy" with the other machine and its last activity. With `ttasks space resolve <space>` the user picks the copy that continues (the other becomes `superseded` and offers its operations since the common ancestor for review) or forks one into a new space. Until then each copy accepts writes on its own machine, and devices stay with the authority they are pinned to.

**Stale restores** (not built, M3.08). A folder with an incarnation this machine has seen and a `seq` below the highest it saw of it, or with an ancestor incarnation, opens read-only with "Use this restore as current" (a restore claim with an epoch above every one known locally) and "Close". The judgement is made before the writer opens, so a stale copy is never migrated, registered or backed up, and against the space's registered ID, never one found through `space.json`, which can be missing. An epoch alone never judges a folder: it orders and says nothing of descent (two claims of one backup are siblings). One `seen` record per space cannot carry this, so the detection needs three things:
- **A freshness floor per copy:** the highest `seq` seen of each incarnation, not of the latest one only, so a sibling seen later does not erase the first sibling's floor.
- **Ancestry that is never cut off:** a true ancestor is still known after any number of claims, never only the newest entries of a lineage.
- **A durable claim intent:** a claim records its intent (the new incarnation and its parent) durably before it commits, and a start-up reconciles an intent whose claim committed without its record, so a crash between the two never leaves the ancestor's folder writable.

**Why the incarnation matters.** After a restore at `seq` 100 is claimed, numbering continues at 101 even if an older copy reached 150, so two operations can share a `seq`. `as_of`, `base`, cursors, receipts and signed commands therefore carry epoch and incarnation, and a mismatch means a resnapshot or a conflict. A new incarnation invalidates every replica cursor (resnapshot), every pending remote command (`epoch_mismatch`), every agent search cursor (A3), and every remote device grant whose pin does not follow a signed handover (3.6.5). Local bindings on the authority survive a local incarnation change, so a claim never cuts off a running session. Their next write carries an old base and gets `EPOCH_CHANGED` (A1).

**Guarantees.** Nothing on one disk can stop two disconnected machines from both becoming authority: two Claims of one backup do it, and so does a database copied by hand and forced open. TTasks does not promise a single writer across disconnected disks, and the docs say so. It guarantees:
- no `(incarnation, seq)` position is shared by two histories, and no cursor, base, receipt or command from one branch is accepted by another,
- a transfer bundle becomes authority only on its destination, at most once,
- a claim's epoch is above every epoch known on that machine,
- copies that meet are classified as same, descendant or competing, never silently matched,
- a stale copy opens read-only.

**Other commands:** `ttasks space export --mode fork`, `ttasks space import <bundle>` and `tasks machine show`, which prints the `machine_id` a transfer needs.

### 3.7 Read replicas and remote writes (phase L1)

#### 3.7.1 Feed protocol

A1 owns the batch format, which v1's UI already uses. Replicas add:
1. After the handshake: `changes.subscribe {space_id, epoch, incarnation, applied_through}`. A different epoch or incarnation, or a cursor older than the feed can serve, gets `resnapshot`.
2. `snapshot.get {space_id}` streams `{epoch, incarnation, through_seq, schema_version}`, 256 KiB record chunks and a final SHA-256. The client swaps the new replica file in only after the hash checks.
3. The authority pushes `changes` messages, each one of A1's full batches `{space_id, epoch, incarnation, from, through, events[]}` whose events carry their `changes` rows, of at most 500 operations or 1 MiB. A batch covers `seq` after `from` through `through`, and every event's `seq` lies in that range. `from` equals the previous `through`. `events` holds only what the device may read (3.7.2) and may be empty, so hidden operations advance coverage without revealing anything.
4. The replica applies a batch and sets its cursor to `through` in one SQLite transaction. A batch ending at or below the cursor is a duplicate. Operations at or below the cursor in an overlapping batch are skipped. A `from` above the cursor is a gap: `changes.get {from: cursor}`, then a resnapshot if that fails. Gaps come from coverage, never from missing `seq` numbers. The cursor never passes applied content.
5. A record that becomes readable arrives as a full-row upsert. One that stops being readable arrives as `forget {record_id}`, revealing only an ID the device already held.

Coverage is authenticated by the Noise session live and by the signed blob header in the mailbox (3.11.2). Full replicas receive applicable operation records. The UI's compact rows are A1's and A5's projection of the same batches.

#### 3.7.2 Filtering

The authority filters by grant and audience before sending. Unreadable records never leave it: not in history values, counts, snapshot metadata, search snippets or attachments. Filtering commits is not enough, because a row shows every change made to it: the filter applies to every row and snapshot too. Search on a replica runs on its own FTS index (R12), built from what it received. The authority never searches for remote clients in L1 to L5. The mailbox applies the same rule with keyed audience streams, because the relay cannot filter.

#### 3.7.3 Storage

A desktop replica is `<cache>/replicas/<space_id>.sqlite` (A2's `<cache>`): never in the spaces folder, never opened as a space, deleted on revocation or removal. The UI shows a remote space with its machine's name and, while the authority is unreachable, one "as of" time (A5 places it).

#### 3.7.4 Writes from a replica

- **Human writes** go as `command.submit {space_id, epoch, incarnation, request_id, operation, args, base}` and return the local results (A1 3.7). The UI may show pending for up to 10 seconds, then an error. It never commits optimistically. Concurrency is decided only by the authority's field versions.
- **Agent writes.** When a task's folder is on machine B and its authority is A, the agent uses B's bridge and service. B forwards task operations to A over its device session (flag `agent_relay: true`, machine devices only), with the agent's binding as actor and its ceiling, which A can only narrow. A applies autonomy (D13), the agent ceiling and the burst brake (3.16.3) to its own staged plan, as for a local agent. `execute`-class operations are never forwarded for agents. Request IDs are namespaced by writer scope before they leave B.
- **Authority unreachable:** every write fails with `authority_unreachable`, which A3 maps to a clear tool error. Nothing is queued.
- **Offline text** stays a local draft, marked unsent.

#### 3.7.5 A machine as a pure client

A machine may hold only replicas. It still runs its service for its own folders, targets and runs, recorded in its execution journal (3.8.6), never in the replica.

### 3.8 Remote commands (phase L1)

#### 3.8.1 Envelope

The origin device signs the **request** (what the user asked). The authority signs the **authorization**, binding it to its own epoch, incarnation and the folder row `resolve` gives for the target machine (A1 3.15). A client never chooses the folder.

```json
{
  "v": 1,
  "type": "remote.execute",
  "request": {
    "command_id": "rc_5h8m2qk7x9d3w4t6b1n0c8v2fj",
    "space_id": "sp_7c0h…",
    "principal_id": "ac_9d1c…",
    "origin_device": "dv_6k2p…",
    "target_machine": "m_3q7k…",
    "action": "open",
    "task_id": "t_7h2m…",
    "seen_folder": { "kind": "project", "folder_id": "fo_…", "version": 38 },
    "instance_id": "claude-code",
    "user_text": "Check whether the mobile app has the same bug.",
    "issued_at": "2026-11-12T10:00:00Z",
    "expires_at": "2026-11-12T10:01:00Z"
  },
  "origin_sig": "ed25519:…",
  "authorization": {
    "request_hash": "sha256:…",
    "epoch": 3,
    "incarnation": "ai_…",
    "as_of_seq": 412,
    "folder": { "folder_id": "fo_…", "kind": "project", "machine_id": "m_3q7k…", "path": "~/work/lumen/portal", "version": 38 },
    "authorized_at": "2026-11-12T10:00:01Z"
  },
  "authority_sig": "ed25519:…"
}
```

- `action`: `open` and `open_folder` expire after 60 s, `run` and `routine_run` after 120 s. Receivers reject any envelope valid for more than 300 s.
- **Never** an executable, argv, environment or permission flag (R10). The target resolves `instance_id` from its own configuration and launches in its own folder: it expands the path's `~` with its own home. The instance must be one the target advertises in `machine.instances`, with A4's `remote_allowed` (default false).
- `seen_folder` is the whole selection the device showed: `kind` (`task`, `project` or `work_folder`), and for a folder row its `folder_id` and `version`. A version alone is not enough, because clearing a task's own folder makes its project's older row the selection.
- `authorization.folder` comes from the authority's state, never from the request: the folder row `resolve` gives for `target_machine`, its path and its version (A1 3.15). A task that uses the work folder gets `{"kind": "work_folder", "machine_id": …}`, the target's work folder for the space (A4).
- `user_text` (at most 4,000 characters) goes to the brief as data, never through a shell (A4).
- Signatures are Ed25519 over the RFC 8785 canonical JSON of the signed part. The authority checks the device grant and signs `authorization` with `request_hash`, the SHA-256 of the request's RFC 8785 canonical JSON. The target checks `authority_sig` against its pin and `request_hash` against the request, so the command stays verifiable along any path.

### 3.16 Security and privacy policies

#### 3.16.2 Prompt injection (A3 frames it)

1. Everything except the notes the user addressed to agents (A3 3.10) is untrusted data, every user- or agent-editable name included, and tool results label each text with its author kind and provenance. Framing helps the model. It is not a boundary. A note counts as addressed to agents only when the space's human wrote it directly, never through an import (`packages/service/src/mcp/`, `[A3.3.10.mcp.framing]`, `[A3.3.4.tools.five]`).
2. **The brief is the boundary for task text** (R14, A4 3.15). It carries the task's reference, its sanitised title, the folder and fixed instructions, nothing else of a task, each value in a fence it cannot leave. Over budget, the composer text becomes a note and nothing is cut. `packages/launch/src/brief/`, `[A4.5.brief.sanitiser]`, `[A4.5.brief.renderer]`.
3. Agents have no operation that launches, runs, schedules, edits routines or policy, pairs, grants, exports or updates (R7), so injected text cannot fan out into unattended work.
4. Every text input passes A3's SafeText at the registry boundary, for every face and for imports. It never rejects input. ZWJ and ZWNJ stay, because emoji and some scripts need them (`packages/contracts/src/safe-text.ts`, `[A3.3.10.safe-text]`).
5. TTasks never fetches a source URL by itself. Previews show stored data only.
6. Under Review and Suggest, completions and field changes become proposals. Under Full, every change is reversible through history.
7. TTasks and its docs never claim to prevent prompt injection.
8. **No task text in a terminal or a shell.** A terminal's argv holds its fixed flags, the product's command, `shim` and the launch ticket, nothing else. The shim gets the folder and title over the authenticated socket. Windows Terminal re-splits its argv on `;`, so an element holding `;` or `"` is refused before anything starts. The one URL that carries a brief is Claude Code's `claude-cli://` route, passed to the OS opener as one argv element without a shell (A4 3.6.5). `packages/launch/src/terminals/commands.ts`, `packages/launch/src/opener.ts`, `[A4.5.terminal.command-lines]`, `[A4.5.terminal.hostile]`, `[A4.5.routes.golden-argv]`, `[A4.5.routes.opener]`.
