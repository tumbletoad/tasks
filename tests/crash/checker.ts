// The invariant checker: it opens what a kill left and checks every guarantee of A1 5 and of
// A1 3.7, 3.8 and 3.18 that a process kill can test. It reports violations as data (the
// invariant's name and a detail of names, codes and numbers, never a value or task text), so the
// harness can stop with the seed and the round.
//
// It runs in two phases. Before the restart, it looks at the folders as the kill left them (a
// restore in place may be between its two renames). Then the harness runs what the service runs
// before a space opens (finishInterruptedRestore), and the checker opens the space read-only and
// checks the database, the backups and every folder a restore replaced.
//
// It checks the database against two independent records, not only against itself: the requests
// the harness sent (every commit must hold what its request asked) and the results the child saw
// or the write seam reported (every one must stay true). A check that compared the database only
// with itself would pass a request applied in part or a decision lost with its reply.
//
// The invariants, by name:
// - space-present: the space's folder is there, or a swap is between its two renames with both
//   folders complete, which the restart completes. Never neither.
// - space-opens, integrity: the space opens with no reason to refuse its next writer but an older
//   revision, and passes integrity_check and foreign_key_check.
// - migration-atomic: the schema revision is one the build reaches by whole migrations (0.1 or
//   0.7, never one between), the schema is exactly that revision's, the format matches, and the
//   history holds one migration commit per step it went through. At 0.7 the search index equals
//   a rebuild of the space's tasks: it is written in the same transaction as what it indexes.
// - seq-gapless: commits are numbered 1 to last_seq without a gap.
// - counters-monotonic: within an incarnation, last_seq and the next task reference never go back
//   between checks; a task keeps its reference; references and entry ordinals are unique.
// - incarnation: the epoch never goes down along the history, the incarnation changes only at a
//   claim commit, the space's authority is the newest commit's, and the lineage ends with it. A
//   new replaced folder means a swap, which must have put the restore's claimed incarnation in
//   place; every restore's claim names the backup it was asked for; and no replaced folder holds
//   the space's own incarnation.
// - receipt-per-commit: every commit of a request has its receipt (applied, its seq and commit
//   ID), every applied receipt has its commit, no other receipt has one, and the system scope has
//   none.
// - system-commit: every commit the space wrote for itself (scope `system`) is one of the writer's
//   own operations and holds exactly what it writes: `machine.register` its machine's create
//   change, `actor.register` no change row and the agent actor it names, with that kind, label and
//   time, and a claim or a migration step no change row. Every actor but the human and the system
//   a space starts with joined through its own `actor.register`, before its first commit, and no
//   two agent actors share a label.
// - request-whole: every applied or no-op decision is of a request the harness sent and holds what
//   it asked (checkIntents): an applied one by the request's principal (the human, or the agent of
//   its label), each created row with the content sent and the writer's defaults, each field set
//   to the request's last value, each lifecycle and move, and no change row its operations do not
//   account for; a no-op the same end state at the state it was judged on. Its operations and its
//   receipt's results agree in number.
// - acked-present (no lost committed write): every result the child acknowledged, or the write
//   seam reported after COMMIT, is still there: its receipt with the whole result it answered, an
//   applied one's commit with the same ID, and every row it created with its reference.
// - rolled-back: a decision the write seam reported before COMMIT left no receipt and no commit.
// - history: per commit at most one change row per (row, field), none with an unchanged value;
//   each field's changes chain (before = the previous after, before_ver = its seq); fv is the
//   field's latest change, fp the same, every row is exactly its history played back (every
//   column), every row the history names is there, version and touched follow, and every changed
//   task and every request commit (`*`) waits in the outbox.
// - old-folder-kept: every folder a restore in place replaced is still there, opens, holds every
//   result acknowledged before that restore and passes the live space's content checks, again
//   after every round.
// - backup-complete-or-absent: every backup with a sidecar is complete and verifies as a restore
//   would (again whenever its bytes change), every backup that completed is still there, and only
//   leftovers and a data file whose sidecar was never published are incomplete.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listBackups, verifyBackup } from "../../packages/storage/src/backup/list.ts";
import type { Connection } from "../../packages/storage/src/driver.ts";
import { StorageError } from "../../packages/storage/src/errors.ts";
import { DATABASE_FILE, MANIFEST_FILE } from "../../packages/storage/src/manifest.ts";
import { decodeSpaceRow, type SpaceRow } from "../../packages/storage/src/rows.ts";
import { encodeRevision } from "../../packages/storage/src/schema.ts";
import { expectedDocuments, storedDocuments } from "../../packages/storage/src/search/documents.ts";
import { openSpaceWith } from "../../packages/storage/src/space.ts";
import type { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import {
  CHILD_FIELDS,
  DERIVED_COLUMNS,
  TASK_FIELDS,
} from "../../packages/storage/src/write/fields.ts";
import { formatAsOf, type WriteResult } from "../../packages/storage/src/write/request.ts";
import type { Ledger, Violation } from "./ledger.ts";
import {
  backupsBeside,
  differingParts,
  reduce,
  sameResult,
  type Acked,
  type PlannedRequest,
} from "./protocol.ts";
import {
  HARNESS_STEPS,
  REVISION_0_1,
  REVISION_0_2,
  REVISION_0_3,
  REVISION_0_4,
  REVISION_0_5,
  REVISION_0_6,
  REVISION_0_7,
  TABLES_0_2,
  TABLES_0_3,
  TABLES_0_4,
  TABLES_0_5,
  TABLES_0_6,
} from "./steps.ts";

const BUSY_TIMEOUT_MS = 60_000;

/** What the check read: the next plan starts from it. */
export interface Observed {
  space: SpaceRow;
  revision: number;
  base: string;
}

class Found {
  readonly list: Violation[] = [];
  add(invariant: string, detail: string): void {
    this.list.push({ invariant, detail });
  }
}

const isDirectory = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/** A file's SHA-256, or `absent`. */
function fileHash(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
}

const STAMP = String.raw`\d{8}T\d{6}\.\d{3}Z`;

/** The `<slug>.replaced-<stamp>` folders beside the space, by stamp. */
function replacedFolders(parent: string, slug: string): Map<string, string> {
  const pattern = new RegExp(`^${slug}\\.replaced-(${STAMP})$`);
  const out = new Map<string, string>();
  for (const name of readdirSync(parent)) {
    const stamp = pattern.exec(name)?.[1];
    if (stamp !== undefined) out.set(stamp, join(parent, name));
  }
  return out;
}

/**
 * Phase 1, before the restart: the folders as the kill left them. The space's folder is there, or
 * a swap stopped between its renames, with the replaced folder and the complete new folder of the
 * same stamp both there (A1 3.18), which the restart completes.
 */
export function checkFolders(ledger: Ledger): Violation[] {
  const found = new Found();
  if (existsSync(join(ledger.folder, DATABASE_FILE))) return found.list;
  for (const stamp of replacedFolders(ledger.parent, ledger.slug).keys()) {
    const staging = join(ledger.parent, `.${ledger.slug}.restoring-${stamp}`);
    if (
      isDirectory(staging) &&
      existsSync(join(staging, DATABASE_FILE)) &&
      existsSync(join(staging, MANIFEST_FILE))
    ) {
      return found.list;
    }
  }
  found.add("space-present", "neither the space nor a swap between its renames is there");
  return found.list;
}

const codeOf = (error: unknown): string =>
  error instanceof StorageError ? error.code : error instanceof Error ? error.name : "unknown";

/**
 * Phase 2, after the restart's own repair: opens the space read-only and checks it, then the
 * replaced folders and the backups. Returns what it read, or undefined when the space did not open.
 */
export async function checkSpace(
  checked: CheckedDriver,
  ledger: Ledger,
  verified: Set<string>,
): Promise<{ violations: Violation[]; observed: Observed | undefined }> {
  const found = new Found();
  let observed: Observed | undefined;
  let opened;
  try {
    opened = openSpaceWith(
      checked,
      ledger.folder,
      { role: "reader", busyTimeoutMs: BUSY_TIMEOUT_MS },
      { steps: HARNESS_STEPS },
    );
  } catch (error) {
    found.add("space-opens", `the space does not open (${codeOf(error)})`);
    return { violations: found.list, observed };
  }
  const { conn } = opened;
  // The next writer must be able to open what the kill left: a reader's reason other than the
  // older revision the writer migrates (A1 3.17) would refuse it, which a reader alone hides.
  const allowed = encodeRevision(opened.revision) < REVISION_0_7 ? ["older_revision"] : [];
  for (const reason of opened.readOnlyReasons) {
    if (!allowed.includes(reason)) {
      found.add("space-opens", `the space opens read-only for its writer (${reason})`);
    }
  }
  try {
    observed = conn.transaction("deferred", () => checkDatabase(conn, ledger, found));
  } catch (error) {
    found.add("space-opens", `reading the space failed (${codeOf(error)})`);
  } finally {
    conn.close();
  }
  checkReplaced(checked, ledger, observed?.space.authority.incarnation, found);
  await checkBackups(checked, ledger, verified, found);
  return { violations: found.list, observed };
}

const one = (
  conn: Connection,
  sql: string,
  params: Record<string, string | number> = {},
): unknown => Object.values(conn.prepare(sql).get(params) ?? {})[0];

function checkDatabase(conn: Connection, ledger: Ledger, found: Found): Observed {
  const integrity = conn.pragma("integrity_check");
  if (integrity !== "ok") found.add("integrity", "integrity_check does not pass");
  if (conn.prepare("PRAGMA foreign_key_check").all().length > 0) {
    found.add("integrity", "foreign_key_check finds rows");
  }
  const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
  const revision = Number(conn.pragma("user_version"));
  reconcile(space, ledger, found);
  checkMigration(conn, space, revision, found);
  checkSequence(conn, space, found);
  checkCounters(conn, space, ledger, found);
  checkReceipts(conn, found);
  checkSystemCommits(conn, ledger, found);
  checkExpected(conn, ledger.expected, found, "acked-present");
  checkUncommitted(conn, ledger, found);
  const history = readHistory(conn);
  checkHistory(conn, history, found);
  checkIntents(conn, history, ledger, found);
  return {
    space,
    revision,
    base: formatAsOf({
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      seq: space.lastSeq,
    }),
  };
}

/**
 * Whether a restore in place the kill interrupted took effect, from two independent records: the
 * file system and the database. A swap leaves a new `<slug>.replaced-<stamp>` folder, one per
 * restore since the last check; restores that reported their end account for theirs. One more
 * means the interrupted restore swapped, and then the space must hold a new incarnation whose
 * claim names the restored backup (A1 3.18: the copy is claimed before the swap, so no crash
 * leaves the old incarnation under the space's name). No new folder means it did not swap, and the
 * incarnation must be the one the ledger holds. Anything else is a violation.
 *
 * Every restore applied since the last check, the ones that reported their end included, is then
 * found in the lineage by the incarnation its claim took, and that claim must name the backup the
 * harness asked for (its incarnation and seq): a restore of another backup that holds as much
 * would pass every other check. A round plans at most one restore, so its claim is in the lineage.
 */
function reconcile(space: SpaceRow, ledger: Ledger, found: Found): void {
  const stamps = new Set(replacedFolders(ledger.parent, ledger.slug).keys());
  const fresh = [...stamps].filter((stamp) => !ledger.replacedSeen.has(stamp)).length;
  const swapped = fresh - ledger.swapsSinceCheck;
  ledger.replacedSeen = stamps;
  ledger.swapsSinceCheck = 0;
  const sameIncarnation = space.authority.incarnation === ledger.incarnation;
  if (swapped === 1 && ledger.pending !== undefined) {
    // The interrupted restore swapped: its claim must be what now holds the space's name.
    if (sameIncarnation) {
      found.add("incarnation", "a restore swapped in a copy it had not claimed");
    } else {
      for (const v of ledger.applyRestore(space.authority.incarnation, space.authority.epoch)) {
        found.add(v.invariant, v.detail);
      }
    }
  } else if (swapped < 0) {
    found.add("old-folder-kept", "a restore in place reported its end and left no replaced folder");
  } else if (swapped > 0) {
    found.add("incarnation", "a folder was swapped in without a restore");
  } else if (!sameIncarnation) {
    found.add("incarnation", "the space's incarnation changed without a swap");
  }
  // The interrupted restore did not take effect, or a violation stops the run.
  ledger.pending = undefined;
  for (const claim of ledger.claimsSinceCheck.splice(0)) {
    const entry = space.lineage.incarnations.find((e) => e.incarnation === claim.incarnation);
    if (
      entry?.kind !== "restore_claim" ||
      entry.parent?.incarnation !== claim.backup.incarnation ||
      entry.parent.through_seq !== claim.backup.seq
    ) {
      found.add("incarnation", "a restore's claim does not name the backup it was asked for");
    }
  }
}

function checkMigration(conn: Connection, space: SpaceRow, revision: number, found: Found): void {
  if (revision !== REVISION_0_1 && revision !== REVISION_0_7) {
    found.add(
      "migration-atomic",
      `the schema is at revision ${String(revision)}, between whole migrations`,
    );
    return;
  }
  const at = revision === REVISION_0_7 ? { major: 0, minor: 7 } : { major: 0, minor: 1 };
  if (space.format.major !== at.major || space.format.minor !== at.minor) {
    found.add("migration-atomic", "the space's format is not its revision's");
  }
  const tables = (names: readonly string[]): unknown[] =>
    names.map((name) =>
      one(conn, "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = $name", {
        name,
      }),
    );
  // The real 0.2 (M3.01): its tables and the space's hold.
  const hold = one(conn, "SELECT count(*) FROM pragma_table_info('space') WHERE name = 'hold'");
  const atLeast02 = revision >= REVISION_0_2;
  if (tables(TABLES_0_2).some((n) => (n === 1) !== atLeast02) || (hold === 1) !== atLeast02) {
    found.add("migration-atomic", "the 0.2 step's tables and column do not match the revision");
  }
  // The real 0.3 (M6.01): its tables.
  const atLeast03 = revision >= REVISION_0_3;
  if (tables(TABLES_0_3).some((n) => (n === 1) !== atLeast03)) {
    found.add("migration-atomic", "the 0.3 step's tables do not match the revision");
  }
  // The real 0.4: the search index, which always equals a rebuild of the space.
  const atLeast04 = revision >= REVISION_0_4;
  if (tables(TABLES_0_4).some((n) => (n === 1) !== atLeast04)) {
    found.add("migration-atomic", "the 0.4 step's tables do not match the revision");
  } else if (atLeast04) {
    const strip = (docs: Iterable<object>): string[] =>
      [...docs].map((doc) => JSON.stringify({ ...doc, doc: undefined, seq: undefined })).sort();
    const stored = storedDocuments(conn);
    if (
      stored.stray !== 0 ||
      strip(stored.docs.values()).join("\n") !== strip(expectedDocuments(conn).values()).join("\n")
    ) {
      found.add("migration-atomic", "the search index differs from a rebuild of the space");
    }
  }
  // The real 0.5: the folders table.
  const atLeast05 = revision >= REVISION_0_5;
  if (tables(TABLES_0_5).some((n) => (n === 1) !== atLeast05)) {
    found.add("migration-atomic", "the 0.5 step's table does not match the revision");
  }
  // The real 0.6: the pages and the texts of a node.
  const atLeast06 = revision >= REVISION_0_6;
  if (tables(TABLES_0_6).some((n) => (n === 1) !== atLeast06)) {
    found.add("migration-atomic", "the 0.6 step's tables do not match the revision");
  }
  // The stand-in 0.7: its table, column and index.
  const table = one(
    conn,
    "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'test_labels'",
  );
  const column = one(
    conn,
    "SELECT count(*) FROM pragma_table_info('tasks') WHERE name = 'test_flag'",
  );
  const index = one(
    conn,
    "SELECT count(*) FROM sqlite_schema WHERE type = 'index' AND name = 'test_labels_name'",
  );
  const at07 = revision === REVISION_0_7;
  if ((table === 1) !== at07 || (column === 1) !== at07 || (index === 1) !== at07) {
    found.add(
      "migration-atomic",
      "the 0.7 step's table, column and index do not match the revision",
    );
  }
  const steps = conn
    .prepare("SELECT seq, incarnation, ops FROM commits WHERE kind = 'migration' ORDER BY seq")
    .all<{ seq: number; incarnation: string; ops: string }>();
  const targets = steps.map((s) => {
    const entry = (JSON.parse(s.ops) as { input?: { to?: string } }[])[0];
    return entry?.input?.to ?? "?";
  });
  const expected = revision === REVISION_0_7 ? ["0.2", "0.3", "0.4", "0.5", "0.6", "0.7"] : [];
  if (targets.join() !== expected.join()) {
    found.add(
      "migration-atomic",
      `the history holds migrations to [${targets.join(", ")}] at revision ${String(revision)}`,
    );
  } else {
    const first = steps[0];
    if (
      first !== undefined &&
      steps.some((s, i) => s.seq !== first.seq + i || s.incarnation !== first.incarnation)
    ) {
      found.add("migration-atomic", "the migration commits are not one migration");
    }
  }
}

function checkSequence(conn: Connection, space: SpaceRow, found: Found): void {
  const count = one(conn, "SELECT count(*) FROM commits");
  const max = one(conn, "SELECT coalesce(max(seq), 0) FROM commits");
  const min = one(conn, "SELECT coalesce(min(seq), 1) FROM commits");
  if (count !== space.lastSeq || max !== space.lastSeq || min !== 1) {
    found.add(
      "seq-gapless",
      `last_seq ${String(space.lastSeq)}, ${String(count)} commits from ${String(min)} to ${String(max)}`,
    );
  }
  const orphans = one(
    conn,
    "SELECT count(*) FROM changes WHERE seq NOT IN (SELECT seq FROM commits)",
  );
  if (orphans !== 0) found.add("seq-gapless", `${String(orphans)} change rows belong to no commit`);
}

function checkCounters(conn: Connection, space: SpaceRow, ledger: Ledger, found: Found): void {
  const high = ledger.highWater.get(space.authority.incarnation);
  if (high !== undefined && (space.lastSeq < high.seq || space.nextRef < high.nextRef)) {
    found.add(
      "counters-monotonic",
      `last_seq ${String(space.lastSeq)} and next_ref ${String(space.nextRef)} went below ${String(high.seq)} and ${String(high.nextRef)} in one incarnation`,
    );
  }
  const maxRef = Number(one(conn, "SELECT coalesce(max(ref), 0) FROM tasks"));
  if (space.nextRef <= maxRef) {
    found.add(
      "counters-monotonic",
      `next_ref ${String(space.nextRef)} is not above the highest reference ${String(maxRef)}`,
    );
  }
  for (const table of ["notes", "log_entries"]) {
    const next = conn
      .prepare(
        `SELECT count(*) AS n FROM ${table} GROUP BY task_id HAVING count(*) <> max(ordinal)`,
      )
      .all();
    if (next.length > 0)
      found.add("counters-monotonic", `${table} ordinals have a gap or a repeat`);
  }
  // The epoch never goes down along the history, the incarnation changes only at a claim, and the
  // authority is the newest commit's.
  let epoch = 0;
  let incarnation: string | undefined;
  for (const c of conn
    .prepare("SELECT seq, epoch, incarnation, ops FROM commits ORDER BY seq")
    .iterate<{ seq: number; epoch: number; incarnation: string; ops: string }>()) {
    if (c.epoch < epoch) found.add("incarnation", `the epoch goes down at seq ${String(c.seq)}`);
    if (incarnation !== undefined && c.incarnation !== incarnation) {
      const op = (JSON.parse(c.ops) as { op?: string }[])[0]?.op;
      if (op !== "space.claim") {
        found.add("incarnation", `the incarnation changes at seq ${String(c.seq)} without a claim`);
      }
    }
    epoch = c.epoch;
    incarnation = c.incarnation;
  }
  if (incarnation !== undefined && incarnation !== space.authority.incarnation) {
    found.add("incarnation", "the authority is not the newest commit's incarnation");
  }
  const last = space.lineage.incarnations.at(-1);
  if (last?.incarnation !== space.authority.incarnation || last.epoch !== space.authority.epoch) {
    found.add("incarnation", "the lineage does not end with the authority");
  }
}

interface CommitJoin {
  seq: number;
  id: string;
  scope_id: string;
  ops: number;
  status: string | null;
  rseq: number | null;
  rcommit: string | null;
  results: number | null;
  changes: number;
}

function checkReceipts(conn: Connection, found: Found): void {
  const rows = conn
    .prepare(
      `SELECT c.seq, c.id, c.scope_id, json_array_length(c.ops) AS ops, r.status, r.seq AS rseq,
              json_extract(r.result, '$.commit') AS rcommit,
              json_array_length(r.result, '$.results') AS results,
              (SELECT count(*) FROM changes WHERE changes.seq = c.seq) AS changes
         FROM commits c LEFT JOIN receipts r
           ON r.scope_id = c.scope_id AND r.request_id = c.request_id
        WHERE c.scope_id <> 'system'`,
    )
    .all<CommitJoin>();
  for (const c of rows) {
    if (c.status === null) {
      found.add("receipt-per-commit", `the commit at seq ${String(c.seq)} has no receipt`);
      continue;
    }
    if (c.status !== "applied" || c.rseq !== c.seq || c.rcommit !== c.id) {
      found.add(
        "receipt-per-commit",
        `the receipt of seq ${String(c.seq)} does not name its commit`,
      );
    }
    if (c.changes === 0)
      found.add("request-whole", `the commit at seq ${String(c.seq)} changed nothing`);
    if (c.results !== c.ops) {
      found.add(
        "request-whole",
        `the commit at seq ${String(c.seq)} has ${String(c.ops)} operations and ${String(c.results)} results`,
      );
    }
  }
  const lonely = one(
    conn,
    `SELECT count(*) FROM receipts r LEFT JOIN commits c ON c.seq = r.seq
      WHERE r.status = 'applied'
        AND (c.seq IS NULL OR c.scope_id <> r.scope_id OR c.request_id <> r.request_id)`,
  );
  if (lonely !== 0)
    found.add("receipt-per-commit", `${String(lonely)} applied receipts have no commit`);
  const undecided = one(
    conn,
    `SELECT count(*) FROM receipts r JOIN commits c
        ON c.scope_id = r.scope_id AND c.request_id = r.request_id WHERE r.status <> 'applied'`,
  );
  if (undecided !== 0)
    found.add("receipt-per-commit", `${String(undecided)} unapplied receipts have a commit`);
  if (one(conn, "SELECT count(*) FROM receipts WHERE scope_id = 'system'") !== 0) {
    found.add("receipt-per-commit", "the system scope has receipts");
  }
}

interface SystemCommit {
  seq: number;
  at: number;
  kind: string;
  actor_kind: string;
  ops: string;
  changes: number;
  machine_creates: number;
}

/** The commit kind of each operation the writer, a claim or a migration writes as the system. */
const SYSTEM_OPERATIONS: Readonly<Record<string, string>> = {
  "machine.register": "ops",
  "actor.register": "ops",
  "space.claim": "ops",
  "schema.migrate": "migration",
};

/**
 * Every commit the space wrote for itself is accounted for, as every request's commit is by its
 * receipt and its request: one of the system's own operations, holding exactly what that operation
 * writes. `machine.register` creates its machine's row with its change (A1 3.6). `actor.register`
 * (decision M1.10) adds the agent actor it names, with the kind, label and time of its commit, and
 * writes no change row: actors carry no versions. A claim and this build's migration steps change
 * no row with history. And every actor is accounted for: the human and the system a space is created
 * with, and each agent through its own `actor.register`, before any commit of its, one per label.
 */
function checkSystemCommits(conn: Connection, ledger: Ledger, found: Found): void {
  const commits = conn
    .prepare(
      `SELECT c.seq, c.at, c.kind, c.actor_kind, c.ops,
              (SELECT count(*) FROM changes WHERE changes.seq = c.seq) AS changes,
              (SELECT count(*) FROM changes WHERE changes.seq = c.seq AND entity = 'machines'
                  AND action = 'create'
                  AND entity_id = json_extract(c.ops, '$[0].target')) AS machine_creates
         FROM commits c WHERE c.scope_id = 'system' ORDER BY c.seq`,
    )
    .all<SystemCommit>();
  const actor = conn.prepare("SELECT kind, label, created_at FROM actors WHERE id = $id");
  /** The agent actors their `actor.register` added, with that commit's seq. */
  const registered = new Map<string, number>();
  for (const c of commits) {
    const where = `the system commit at seq ${String(c.seq)}`;
    const ops = JSON.parse(c.ops) as { op?: unknown; target?: unknown; input?: unknown }[];
    const [entry] = ops;
    const op = typeof entry?.op === "string" ? entry.op : "";
    const expectedKind = SYSTEM_OPERATIONS[op];
    if (ops.length !== 1 || entry === undefined || expectedKind === undefined) {
      found.add("system-commit", `${where} holds no single operation of the system's`);
      continue;
    }
    if (c.kind !== expectedKind || c.actor_kind !== "system") {
      found.add("system-commit", `${where} (${op}) is not the system's ${expectedKind} commit`);
    }
    if (op === "machine.register") {
      if (c.changes !== 1 || c.machine_creates !== 1) {
        found.add("system-commit", `${where} (${op}) does not create exactly its machine`);
      }
      continue;
    }
    if (c.changes !== 0) {
      found.add("system-commit", `${where} (${op}) has change rows`);
    }
    if (op !== "actor.register") continue;
    const target = typeof entry.target === "string" ? entry.target : "";
    const input = entry.input as Record<string, unknown> | undefined;
    const row = actor.get({ id: target });
    if (
      input === undefined ||
      Object.keys(input).sort().join() !== "kind,label" ||
      input["kind"] !== "agent" ||
      row === undefined ||
      row["kind"] !== input["kind"] ||
      row["label"] !== input["label"] ||
      row["created_at"] !== c.at
    ) {
      found.add("system-commit", `${where} (${op}) does not hold the actor it registers`);
    }
    if (registered.has(target)) {
      found.add("system-commit", `${where} (${op}) registers an actor a second time`);
    }
    registered.set(target, c.seq);
  }
  const actors = conn
    .prepare("SELECT id, kind FROM actors ORDER BY created_at, id")
    .all<{ id: string; kind: string }>();
  let systems = 0;
  for (const a of actors) {
    if (a.kind === "system") systems += 1;
    else if (a.id !== ledger.owner && !registered.has(a.id)) {
      found.add("system-commit", `an actor of kind ${a.kind} joined without its actor.register`);
    }
  }
  if (systems !== 1 || !actors.some((a) => a.id === ledger.owner && a.kind === "human")) {
    found.add("system-commit", "the space does not hold its own human and system actors once");
  }
  // The writer adds an agent only when none has its label, in one IMMEDIATE transaction.
  const shared = one(
    conn,
    "SELECT count(*) FROM (SELECT 1 FROM actors WHERE kind = 'agent' GROUP BY label HAVING count(*) > 1)",
  );
  if (shared !== 0) found.add("system-commit", "two agent actors share a label");
  const early = conn.prepare(
    "SELECT count(*) AS n FROM commits WHERE principal_id = $id AND seq <= $seq",
  );
  for (const [id, seq] of registered) {
    if (early.get({ id, seq })?.["n"] !== 0) {
      found.add("system-commit", `an agent acted before its actor.register at seq ${String(seq)}`);
    }
  }
}

const ENTITY: Record<string, string> = { n: "notes", l: "log_entries" };

/** Every acknowledged result in `expected` is still in the database on `conn`. */
function checkExpected(
  conn: Connection,
  expected: ReadonlyMap<string, Acked>,
  found: Found,
  invariant: string,
): void {
  const receipt = conn.prepare(
    "SELECT status, seq, epoch, incarnation, json_extract(result, '$.commit') AS commit_id, " +
      "result FROM receipts WHERE scope_id = $scope AND request_id = $request",
  );
  const commit = conn.prepare("SELECT id, scope_id, request_id FROM commits WHERE seq = $seq");
  // A created row's create change: the row's own, or for source.add on a known source, the link's
  // (`<task>|<source>`), since the operation names the source.
  const created = conn.prepare(
    "SELECT count(*) AS n FROM changes WHERE seq = $seq AND action = 'create' " +
      "AND (entity_id = $id OR (entity = 'task_sources' AND substr(entity_id, -length($id)) = $id))",
  );
  const taskRef = conn.prepare("SELECT ref FROM tasks WHERE id = $id");
  for (const [key, acked] of expected) {
    const [scope = "", request = ""] = key.split(" ");
    const where = `${acked.status} at seq ${String(acked.seq)}`;
    const r = receipt.get({ scope, request });
    if (r === undefined) {
      found.add(invariant, `the receipt of an acknowledged request (${where}) is gone`);
      continue;
    }
    if (
      r["status"] !== acked.status ||
      r["epoch"] !== acked.epoch ||
      r["incarnation"] !== acked.incarnation
    ) {
      found.add(invariant, `the receipt of an acknowledged request (${where}) changed`);
      continue;
    }
    // The whole stored result, as a replay would return it, every round: a retry samples only a
    // few, and a space's last round has none.
    const stored = reduce(JSON.parse(String(r["result"])) as WriteResult);
    if (!sameResult(stored, acked)) {
      found.add(
        invariant,
        `the receipt of an acknowledged request (${where}) holds another result (${differingParts(stored, acked).join(", ")})`,
      );
    }
    if (acked.status !== "applied") continue;
    if (r["seq"] !== acked.seq || r["commit_id"] !== acked.commit) {
      found.add(invariant, `the receipt of an acknowledged commit (${where}) names another commit`);
    }
    const c = commit.get({ seq: acked.seq });
    if (
      c === undefined ||
      c["id"] !== acked.commit ||
      c["scope_id"] !== scope ||
      c["request_id"] !== request
    ) {
      found.add(invariant, `an acknowledged commit (${where}) is gone`);
      continue;
    }
    for (const op of acked.ops) {
      if (op.status !== "created") continue;
      const n = created.get<{ n: number }>({ seq: acked.seq, id: op.id })?.n ?? 0;
      if (n === 0) {
        found.add(
          "request-whole",
          `a row the commit at seq ${String(acked.seq)} created has no create change there`,
        );
      }
      if (op.ref !== undefined && op.id.startsWith("t_")) {
        const ref = Number(op.ref.slice(op.ref.lastIndexOf("-") + 1));
        if (taskRef.get<{ ref: number }>({ id: op.id })?.ref !== ref) {
          found.add(
            "counters-monotonic",
            `a task created at seq ${String(acked.seq)} lost its reference`,
          );
        }
      }
      if (op.entry !== undefined) {
        const table = ENTITY[op.entry.charAt(0)];
        const ordinal = Number(op.entry.slice(1));
        const row =
          table === undefined
            ? undefined
            : conn
                .prepare(`SELECT ordinal FROM ${table} WHERE id = $id`)
                .get<{ ordinal: number }>({ id: op.id });
        if (row?.ordinal !== ordinal) {
          found.add(
            "counters-monotonic",
            `an entry created at seq ${String(acked.seq)} lost its ordinal`,
          );
        }
      }
    }
  }
}

/**
 * Every decision a kill stopped before its COMMIT left nothing: no receipt and no commit of its
 * request. The next round retries it, so this holds only now.
 */
function checkUncommitted(conn: Connection, ledger: Ledger, found: Found): void {
  const receipt = conn.prepare(
    "SELECT 1 AS n FROM receipts WHERE scope_id = $scope AND request_id = $request",
  );
  const commit = conn.prepare(
    "SELECT 1 AS n FROM commits WHERE scope_id = $scope AND request_id = $request",
  );
  for (const [key, decided] of ledger.uncommitted) {
    const [scope = "", request = ""] = key.split(" ");
    if (
      receipt.get({ scope, request }) !== undefined ||
      commit.get({ scope, request }) !== undefined
    ) {
      found.add(
        "rolled-back",
        `a request killed before its COMMIT (${decided.status}) left its receipt or commit`,
      );
    }
  }
  ledger.uncommitted.clear();
}

/** One operation's result as a receipt stores it, for the intent check. */
interface StoredOp {
  i: number;
  status: string;
  id: string;
  entry?: string;
  /** A source made without its key, which this active task holds. */
  held_by?: string;
}

/** The value of a task's field right after commit `seq`: its change there, or the one before. */
function valueAt(history: History, task: string, field: string, seq: number): unknown {
  const changes = history.byRow.get(rowKey("tasks", task)) ?? [];
  let value: string | undefined;
  for (const change of changes) {
    if (change.seq > seq) break;
    if (change.action === "create") {
      const columns = TASK_FIELDS[field as keyof typeof TASK_FIELDS];
      value = valueText(JSON.parse(change.after) as Record<string, unknown>, columns);
    } else if (change.field === field) value = change.after;
  }
  return value === undefined ? undefined : (JSON.parse(value) as unknown);
}

/** A planned `set` value as `changes.after` holds its field. */
function storedValue(field: string, value: unknown): unknown {
  if (field === "due") {
    const date = (value as { date?: string } | null)?.date ?? null;
    return { due_date: date, due_at: null, due_tz: null };
  }
  return value;
}

/**
 * Every column of a task the workload creates (A1 3.7's defaults for what the input leaves
 * out: status open, priority 4, the inbox flag off, empty text, no group), but its ID, reference,
 * position and time, which the writer chooses.
 */
function createdTask(op: { title: string; priority?: number }, owner: string): Row {
  return {
    title: op.title,
    summary: "",
    context: "",
    lifecycle: "active",
    status: "open",
    inbox: 0,
    priority: op.priority ?? 4,
    effort: null,
    due_date: null,
    due_at: null,
    due_tz: null,
    planned_for: null,
    focus_on: null,
    owner: null,
    waiting_on: null,
    area_id: null,
    project_id: null,
    parent_id: null,
    source_at: null,
    reviewed_at: null,
    completed_at: null,
    completed_by: null,
    archived_reason: null,
    wrap_state: null,
    outcome: null,
    wrapped_at: null,
    wrapped_by: null,
    created_by: owner,
    created_session: null,
    deleted_at: null,
    deleted_by: null,
  };
}

type Row = Record<string, unknown>;

/** Whether `row` holds every column of `expected` with its value. */
const holds = (row: Row | undefined, expected: Row): boolean =>
  row !== undefined &&
  Object.entries(expected).every(([c, v]) => JSON.stringify(row[c] ?? null) === JSON.stringify(v));

/**
 * Every decision that claims a state holds what the harness asked, independently of the database's
 * own record of the request (A1 3.7: a request applies whole or not at all; A1 3.8:
 * a no-op is decided on the state at its as_of). Judged with the operation results its receipt
 * stores, so for every decision, acknowledged or not:
 * - applied: each created task, note, log entry, source and link with the content sent and the
 *   writer's defaults, each field the request set holding its last value right after the commit, a
 *   completed or reopened task in that lifecycle, a moved task after its sibling in its group, and
 *   no change row the request's operations do not account for (another row, or another field);
 * - unchanged: the same end state already true at the state it was judged on, and no operation
 *   that creates a row.
 * Conflicts and rejections claim no state.
 */
function checkIntents(conn: Connection, history: History, ledger: Ledger, found: Found): void {
  const decided = conn
    .prepare(
      `SELECT r.scope_id, r.request_id, r.status, r.result, c.seq AS commit_seq,
              c.principal_id, c.actor_kind
         FROM receipts r LEFT JOIN commits c
           ON c.scope_id = r.scope_id AND c.request_id = r.request_id
        WHERE r.status IN ('applied', 'unchanged') ORDER BY r.rowid`,
    )
    .all<{
      scope_id: string;
      request_id: string;
      status: string;
      result: string;
      commit_seq: number | null;
      principal_id: string | null;
      actor_kind: string | null;
    }>();
  // An agent's actor by its label. system-commit holds each to its own actor.register, one per
  // label, so the label names one actor.
  const agents = new Map(
    conn
      .prepare("SELECT label, id FROM actors WHERE kind = 'agent'")
      .all<{ label: string; id: string }>()
      .map((a) => [a.label, a.id]),
  );
  for (const d of decided) {
    const planned = ledger.requests.get(`${d.scope_id} ${d.request_id}`);
    const result = JSON.parse(d.result) as { seq: number; results?: StoredOp[] };
    const applied = d.status === "applied";
    // receipt-per-commit names an applied receipt without its commit.
    if (applied && d.commit_seq === null) continue;
    const seq = applied ? (d.commit_seq ?? 0) : result.seq;
    const where = applied ? `the commit at seq ${String(seq)}` : `a no-op at seq ${String(seq)}`;
    if (planned === undefined) {
      found.add("request-whole", `${where} is of no request the harness sent`);
      continue;
    }
    // The request's principal: the space's human, or the agent actor of its label.
    const author = planned.agent === undefined ? ledger.owner : agents.get(planned.agent);
    const kind = planned.agent === undefined ? "human" : "agent";
    if (author === undefined) {
      found.add("request-whole", `${where} is of an agent that never joined the space`);
      continue;
    }
    if (applied && (d.principal_id !== author || d.actor_kind !== kind)) {
      found.add("request-whole", `${where} is not by its request's ${kind} actor`);
    }
    const problems = requestIntent(history, seq, planned, result.results ?? [], {
      owner: author,
      applied,
    });
    for (const problem of problems) found.add("request-whole", `${where} ${problem}`);
  }
}

/**
 * What decision `seq` of `planned` lacks, as fixed phrases. `owner` is the request's principal,
 * who authors what it creates.
 */
function requestIntent(
  history: History,
  seq: number,
  planned: PlannedRequest,
  results: readonly StoredOp[],
  { owner, applied }: { owner: string; applied: boolean },
): string[] {
  if (results.length !== planned.ops.length) {
    return [`has ${String(results.length)} results for ${String(planned.ops.length)} operations`];
  }
  const problems: string[] = [];
  const changes = applied ? (history.bySeq.get(seq) ?? []) : [];
  const createdHere = (entity: string, id: string): Row | undefined => {
    const change = changes.find(
      (c) => c.entity === entity && c.entity_id === id && c.action === "create",
    );
    return change === undefined ? undefined : (JSON.parse(change.after) as Row);
  };
  const existsAt = (entity: string, id: string): Row | undefined => {
    const change = (history.byRow.get(rowKey(entity, id)) ?? []).find((c) => c.action === "create");
    return change === undefined || change.seq > seq ? undefined : (JSON.parse(change.after) as Row);
  };
  // The change rows the operations account for, by `<entity> <id> <field or create>`.
  const allowed = new Set<string>();
  const allow = (entity: string, id: string, field: string): void => {
    allowed.add(`${entity} ${id} ${field}`);
  };
  // The request's last value per (task, field), as its patches set it.
  const sets = new Map<string, { task: string; field: string; value: unknown }>();
  const lifecycle = new Map<string, string>();
  const creates = "has an operation that creates a row";
  planned.ops.forEach((op, i) => {
    const result = results[i];
    const at = `operation ${String(i)} (${op.kind})`;
    if (result === undefined) return;
    switch (op.kind) {
      case "task.create": {
        if (!applied) {
          problems.push(creates);
          return;
        }
        const id = op.id ?? "";
        allow("tasks", id, "create");
        const row = createdHere("tasks", id);
        if (result.status !== "created" || result.id !== id || row === undefined) {
          problems.push(`did not create the task of ${at}`);
        } else if (!holds(row, createdTask(op, owner))) {
          problems.push(`created the task of ${at} with other content`);
        }
        return;
      }
      case "note.add":
      case "log.add": {
        if (!applied) {
          problems.push(creates);
          return;
        }
        const entity = op.kind === "note.add" ? "notes" : "log_entries";
        allow(entity, result.id, "create");
        const row = createdHere(entity, result.id);
        const ordinal = Number(result.entry?.slice(1));
        const expected: Row = {
          task_id: op.task,
          body: op.body,
          author_id: owner,
          ordinal,
          deleted_at: null,
          // The defaults for what the workload leaves out: a note to oneself, a progress entry.
          ...(entity === "notes"
            ? { addressee: "self", audience: "all", edited_at: null }
            : { kind: "progress", session_id: null, run_id: null }),
        };
        if (result.status !== "created" || row === undefined) {
          problems.push(`did not add the entry of ${at}`);
        } else if (!holds(row, expected)) {
          problems.push(`added the entry of ${at} with other content`);
        }
        return;
      }
      case "source.add": {
        const sourceId = result.id;
        const link = `${op.task}|${sourceId}`;
        allow("sources", sourceId, "create");
        allow("task_sources", link, "create");
        // A new source has the content sent; one found by its key keeps its own (A1 3.6). A key an
        // active task holds stays that task's: the new task's source is made without it.
        const fresh = createdHere("sources", sourceId);
        const source = fresh ?? existsAt("sources", sourceId);
        const key = result.held_by === undefined ? (op.source.key ?? null) : null;
        const content: Row = { source_key: key, deleted_at: null };
        if (fresh !== undefined) {
          Object.assign(content, {
            kind: op.source.kind,
            title: op.source.title,
            created_by: owner,
          });
        }
        if (!holds(source, content)) problems.push(`does not hold the source of ${at}`);
        const linked =
          result.status === "created"
            ? holds(createdHere("task_sources", link), { added_by: owner, removed_at: null })
            : result.status === "unchanged" && existsAt("task_sources", link) !== undefined;
        if (!linked) problems.push(`does not hold the link of ${at}`);
        return;
      }
      case "task.patch":
        for (const [field, value] of Object.entries(op.set ?? {})) {
          allow("tasks", op.task, field);
          sets.set(`${op.task} ${field}`, {
            task: op.task,
            field,
            value: storedValue(field, value),
          });
        }
        return;
      case "task.move": {
        allow("tasks", op.task, "grouping");
        const sibling = "after" in op ? op.after : undefined;
        if (typeof sibling !== "string" || sibling === op.task) return;
        const mine = valueAt(history, op.task, "grouping", seq) as Row | null;
        const theirs = valueAt(history, sibling, "grouping", seq) as Row | null;
        if (
          mine?.["area_id"] !== theirs?.["area_id"] ||
          mine?.["project_id"] !== theirs?.["project_id"] ||
          String(mine?.["position"]) <= String(theirs?.["position"])
        ) {
          problems.push(`does not leave the task of ${at} after its sibling`);
        }
        return;
      }
      case "task.complete":
      case "task.reopen":
        allow("tasks", op.task, "lifecycle");
        allow("tasks", op.task, "wrap");
        lifecycle.set(op.task, op.kind === "task.complete" ? "completed" : "active");
        return;
      default:
        problems.push(`holds ${at}, which the harness does not plan`);
    }
  });
  for (const { task, field, value } of sets.values()) {
    if (JSON.stringify(valueAt(history, task, field, seq)) !== JSON.stringify(value)) {
      problems.push(`does not hold the request's last ${field} for its task`);
    }
  }
  for (const [task, state] of lifecycle) {
    const value = valueAt(history, task, "lifecycle", seq) as Row | null;
    if (
      value?.["lifecycle"] !== state ||
      (state === "completed" && value["completed_by"] !== owner)
    ) {
      problems.push(`does not leave its task ${state}`);
    }
  }
  for (const change of changes) {
    if (!allowed.has(`${change.entity} ${change.entity_id} ${change.field ?? "create"}`)) {
      problems.push(`has a change its request does not account for (${change.entity})`);
    }
  }
  return problems;
}

interface ChangeRow {
  seq: number;
  entity: string;
  entity_id: string;
  task_id: string | null;
  action: string;
  field: string | null;
  before: string | null;
  after: string;
  before_ver: number | null;
  before_prov: number | null;
  after_prov: number | null;
}

/** Every change row of the space, by row and by commit, each list in (seq, n) order. */
interface History {
  byRow: Map<string, ChangeRow[]>;
  bySeq: Map<number, ChangeRow[]>;
}

const rowKey = (entity: string, id: string): string => `${entity} ${id}`;

function readHistory(conn: Connection): History {
  const history: History = { byRow: new Map(), bySeq: new Map() };
  for (const change of conn
    .prepare(
      "SELECT seq, entity, entity_id, task_id, action, field, before, after, before_ver, " +
        "before_prov, after_prov FROM changes ORDER BY seq, n",
    )
    .iterate<ChangeRow>()) {
    const key = rowKey(change.entity, change.entity_id);
    history.byRow.set(key, [...(history.byRow.get(key) ?? []), change]);
    history.bySeq.set(change.seq, [...(history.bySeq.get(change.seq) ?? []), change]);
  }
  return history;
}

type Fields = Readonly<Record<string, readonly string[]>>;

/** A field's value as a change row holds it: one column's value, else an object of its columns. */
function valueText(row: Record<string, unknown>, columns: readonly string[]): string {
  return JSON.stringify(
    columns.length === 1
      ? (row[columns[0] ?? ""] ?? null)
      : Object.fromEntries(columns.map((c) => [c, row[c] ?? null])),
  );
}

/** The tables with history (A1 3.4), the expression of their `changes.entity_id`, their fields. */
const HISTORY_TABLES: readonly { table: string; key: string; fields: Fields }[] = [
  { table: "tasks", key: "id", fields: TASK_FIELDS },
  { table: "task_sources", key: "task_id || '|' || source_id", fields: CHILD_FIELDS.task_sources },
  { table: "places", key: "id", fields: CHILD_FIELDS.places },
  { table: "learnings", key: "id", fields: CHILD_FIELDS.learnings },
  { table: "notes", key: "id", fields: {} },
  { table: "log_entries", key: "id", fields: {} },
  { table: "sources", key: "id", fields: {} },
  { table: "machines", key: "id", fields: {} },
  // Schema 0.3 (M6.01): there from that revision on. The workload writes none yet.
  { table: "sessions", key: "id", fields: {} },
  { table: "runs", key: "id", fields: CHILD_FIELDS.runs },
  // Schema 0.5: there from that revision on. The workload writes none yet.
  { table: "folders", key: "id", fields: CHILD_FIELDS.folders },
  // Schema 0.6: there from that revision on. The workload writes none yet.
  { table: "pages", key: "id", fields: CHILD_FIELDS.pages },
  { table: "node_texts", key: "owner_id", fields: CHILD_FIELDS.node_texts },
];

const DERIVED = new Set<string>([...DERIVED_COLUMNS, "entity_id"]);

/**
 * The change history of one table's rows (A1 3.4, 3.5, 3.7): it starts with the row's create, each
 * field's changes chain, fv and fp name the latest change, version and touched follow, and the row
 * is exactly its history played back: its create change's columns with every later field change
 * applied, every column but the derived ones (DERIVED_COLUMNS). So no column, immutable content
 * such as a note's body included, can differ from what the commits that wrote it recorded.
 * Returns the row keys it found.
 */
function checkRows(
  conn: Connection,
  history: History,
  table: string,
  key: string,
  fields: Fields,
  found: Found,
): Set<string> {
  const seen = new Set<string>();
  const rows = conn
    .prepare(`SELECT ${key} AS entity_id, * FROM ${table}`)
    .all<Record<string, unknown> & { entity_id: string; fv: string; fp: string }>();
  for (const row of rows) {
    seen.add(rowKey(table, row.entity_id));
    const changes = history.byRow.get(rowKey(table, row.entity_id)) ?? [];
    const create = changes[0];
    const where = `${table} created at seq ${String(row["created_seq"])}`;
    if (create?.action !== "create" || create.seq !== row["created_seq"]) {
      found.add("history", `a row of ${where} does not start with its create change`);
      continue;
    }
    if (changes.filter((c) => c.action === "create").length !== 1) {
      found.add("history", `a row of ${where} has more than one create change`);
    }
    const createdRow = JSON.parse(create.after) as Record<string, unknown>;
    const played: Record<string, unknown> = { ...createdRow };
    const fv = JSON.parse(row.fv) as Record<string, number>;
    const fp = JSON.parse(row.fp) as Record<string, number>;
    let version = create.seq;
    for (const change of changes) {
      if (change.action === "create") continue;
      if (change.field === null || !(change.field in fields)) {
        found.add("history", `a change of ${where} names no field of its table`);
      }
    }
    for (const [field, columns] of Object.entries(fields)) {
      let value = valueText(createdRow, columns);
      let at = create.seq;
      for (const change of changes.filter((c) => c.field === field)) {
        if (
          change.action !== "set" ||
          change.before !== value ||
          change.before_ver !== at ||
          change.before_prov !== at ||
          change.after_prov !== change.seq
        ) {
          found.add("history", `${table}.${field} does not chain at seq ${String(change.seq)}`);
        }
        value = change.after;
        at = change.seq;
      }
      const latest = JSON.parse(value) as unknown;
      if (columns.length === 1) played[columns[0] ?? ""] = latest;
      else for (const c of columns) played[c] = (latest as Record<string, unknown> | null)?.[c];
      const versionAt = at === create.seq ? undefined : at;
      if (fv[field] !== versionAt || fp[field] !== versionAt) {
        found.add("history", `fv.${field} is not its latest change row (${where})`);
      }
      version = Math.max(version, at);
    }
    // Every column the row had when it was created. A column a migration added since (the 0.7
    // step's test_flag) has no history to compare with.
    for (const column of Object.keys(played)) {
      if (DERIVED.has(column)) continue;
      if (JSON.stringify(row[column] ?? null) !== JSON.stringify(played[column] ?? null)) {
        found.add("history", `${table}.${column} is not what its history wrote (${where})`);
      }
    }
    for (const field of Object.keys(fv)) {
      if (!(field in fields)) found.add("history", `fv names an unknown field (${where})`);
    }
    if (row["version"] !== version)
      found.add("history", `the version of a row of ${where} is not its latest change`);
    if (table === "tasks") {
      const touched = Math.max(
        version,
        Number(
          one(conn, "SELECT coalesce(max(seq), 0) FROM changes WHERE task_id = $id", {
            id: row.entity_id,
          }),
        ),
      );
      if (row["touched"] !== touched)
        found.add("history", `touched is not the latest change (${where})`);
      const outbox = one(conn, "SELECT seq FROM outbox WHERE topic = 'projection' AND key = $id", {
        id: row.entity_id,
      });
      if (outbox !== touched) found.add("history", `the projection outbox lags a task (${where})`);
    }
  }
  return seen;
}

function checkHistory(conn: Connection, history: History, found: Found): void {
  const doubled = one(
    conn,
    "SELECT count(*) FROM (SELECT 1 FROM changes GROUP BY seq, entity, entity_id, coalesce(field, '') HAVING count(*) > 1)",
  );
  if (doubled !== 0)
    found.add("history", `${String(doubled)} (commit, row, field) pairs have two change rows`);
  const same = one(conn, "SELECT count(*) FROM changes WHERE action = 'set' AND before = after");
  if (same !== 0) found.add("history", `${String(same)} change rows change nothing`);
  const rows = new Set<string>();
  for (const { table, key, fields } of HISTORY_TABLES) {
    // A space at an older revision (created, or a barrier backup restored) has none of the later
    // revisions' tables.
    const present = one(
      conn,
      "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = $table",
      { table },
    );
    if (present === 0) continue;
    for (const row of checkRows(conn, history, table, key, fields, found)) rows.add(row);
  }
  // And the other way: every row the history names is there. This build deletes no row, so a
  // change of a row that is gone is half a request, or a row lost after its commit.
  let orphans = 0;
  for (const row of history.byRow.keys()) if (!rows.has(row)) orphans += 1;
  if (orphans > 0) found.add("history", `${String(orphans)} rows with change rows are not there`);
  // Every request's commit waits in the outbox under `*` too (A1 3.7, 3.8).
  const star = Number(
    one(conn, "SELECT coalesce(max(seq), 0) FROM outbox WHERE topic = 'projection' AND key = '*'"),
  );
  const newest = Number(
    one(conn, "SELECT coalesce(max(seq), 0) FROM commits WHERE scope_id <> 'system'"),
  );
  if (star !== newest) found.add("history", "the projection outbox's `*` lags the history");
}

/**
 * Every folder a restore in place moved aside is still there and holds what it held, checked
 * again after every round (a later restore or a cleanup could harm it), and none holds the
 * incarnation that now has the space's name (A1 3.18: the copy is claimed before the swap).
 * M1.10's recovery swaps without a claim and must be told apart here when it joins the workload.
 */
function checkReplaced(
  checked: CheckedDriver,
  ledger: Ledger,
  live: string | undefined,
  found: Found,
): void {
  const folders = [...replacedFolders(ledger.parent, ledger.slug).values()];
  if (ledger.replaced.length === 0 && folders.length === 0) return;
  const byIncarnation = new Map<string, string>();
  for (const folder of folders) {
    try {
      const conn = checked.driver.open(join(folder, DATABASE_FILE), {
        readOnly: true,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
      });
      try {
        const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
        byIncarnation.set(space.authority.incarnation, folder);
      } finally {
        conn.close();
      }
    } catch (error) {
      found.add("old-folder-kept", `a replaced folder does not open (${codeOf(error)})`);
    }
  }
  if (live !== undefined && byIncarnation.has(live)) {
    found.add("incarnation", "the space has the incarnation of a folder it replaced");
  }
  for (const replaced of ledger.replaced) {
    const folder = byIncarnation.get(replaced.incarnation);
    if (folder === undefined) {
      found.add("old-folder-kept", "the folder a restore in place replaced is gone");
      continue;
    }
    try {
      const conn = checked.driver.open(join(folder, DATABASE_FILE), {
        readOnly: true,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
      });
      // The whole content, as for the live space: the replaced folder is the state before the
      // restore byte for byte, so its history, receipts and requests must hold as they did.
      const inner = new Found();
      try {
        conn.transaction("deferred", () => {
          if (conn.pragma("integrity_check") !== "ok") {
            inner.add("integrity", "integrity_check does not pass");
          }
          const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
          checkSequence(conn, space, inner);
          checkReceipts(conn, inner);
          checkSystemCommits(conn, ledger, inner);
          checkExpected(conn, replaced.expected, inner, "acked-present");
          const history = readHistory(conn);
          checkHistory(conn, history, inner);
          checkIntents(conn, history, ledger, inner);
        });
      } finally {
        conn.close();
      }
      for (const v of inner.list) {
        found.add("old-folder-kept", `in a replaced folder, ${v.invariant}: ${v.detail}`);
      }
    } catch (error) {
      found.add("old-folder-kept", `reading a replaced folder failed (${codeOf(error)})`);
    }
  }
}

/** Every backup with a sidecar is complete and verified; every completed backup is still there. */
async function checkBackups(
  checked: CheckedDriver,
  ledger: Ledger,
  verified: Set<string>,
  found: Found,
): Promise<void> {
  const present = new Set<string>();
  try {
    for (const backup of listBackups(backupsBeside(ledger.folder)).backups) {
      // A kill between the publication of the data and of its sidecar leaves this.
      if (backup.state === "missing_sidecar") continue;
      if (backup.state !== "ok" || backup.sidecar === undefined) {
        found.add("backup-complete-or-absent", `a backup is ${backup.state}`);
        continue;
      }
      present.add(backup.name);
      // Verified once per content: the key holds both files' SHA-256 (cheap at the harness's
      // sizes), so a backup whose bytes changed after its check, by any means, is checked again.
      const id = [backup.name, fileHash(backup.file), fileHash(backup.sidecarFile)].join(" ");
      if (verified.has(id)) continue;
      const verdict = await verifyBackup(checked, backup, { steps: HARNESS_STEPS });
      if (verdict.state === "failed") {
        found.add("backup-complete-or-absent", "a complete backup does not verify");
      } else if (verdict.state === "unchecked") {
        found.add(
          "backup-complete-or-absent",
          `a complete backup could not be trial restored (${verdict.code ?? "a bug"})`,
        );
      } else verified.add(id);
    }
  } catch (error) {
    found.add("backup-complete-or-absent", `reading the backups failed (${codeOf(error)})`);
  }
  for (const name of ledger.backups.keys()) {
    if (!present.has(name))
      found.add("backup-complete-or-absent", "a backup that completed is gone");
  }
}
