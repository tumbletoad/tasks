// The tree's writer: one request is one named command, run inside one BEGIN IMMEDIATE on the
// space's writer connection:
//
//   space checks → receipt lookup → SAVEPOINT → commit row → the command, each statement reading
//   what the one before wrote → change rows, field versions → Undo's mark → receipt → COMMIT
//
// A command writes rows through its Tx (tx.ts) and never touches commits, changes or receipts. A
// command may call another inside the same request (a finish's follow-ups): one commit and one
// receipt answer all of it, and a failure anywhere leaves nothing. Table and column names reach SQL
// text only from fields.ts, so no input can.
import type { Connection } from "../driver.ts";
import { newId, osRandom, type Id, type RandomSource } from "../ids.ts";
import { RowReader } from "../rows.ts";
import { intentFingerprint } from "../write/receipts.ts";
import { formatAsOf, incarnationTag, parseAsOf } from "../write/request.ts";
import { COMMANDS } from "./commands.ts";
import { TreeProblem } from "./fields.ts";
import { planHistory, STEP_SQL } from "./steps.ts";
import { Tx, type HistoryRun, type SpaceState, type TreeConflict, type TreeRequest } from "./tx.ts";

export type { TreeActor, TreeRequest } from "./tx.ts";

const SQL = {
  space: "SELECT * FROM space WHERE one = 1",
  receipt: "SELECT * FROM receipts WHERE scope_id = $scope AND request_id = $request",
  insertReceipt:
    "INSERT INTO receipts (scope_id, request_id, fingerprint, status, seq, epoch, incarnation, " +
    "result, at) VALUES ($scope, $request, $fingerprint, $status, $seq, $epoch, $incarnation, " +
    "$result, $at)",
  actor: "SELECT kind FROM actors WHERE id = $id",
  insertCommit:
    "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, author_id, " +
    "scope_id, machine_id, session_id, run_id, origin, request_id, kind, ops, affected, reason, " +
    "undo_of, redo_of) VALUES ($seq, $id, $epoch, $incarnation, $at, $actor_kind, $principal, " +
    "$author, $scope, $machine, $session, $run, $origin, $request, $kind, $ops, 0, $reason, " +
    "$undo_of, $redo_of)",
  insertChange:
    "INSERT INTO changes (seq, n, entity, entity_id, node_id, action, field, before, after, " +
    "before_ver, before_prov, after_prov) VALUES ($seq, $n, $entity, $entity_id, $node, $action, " +
    "$field, $before, $after, $before_ver, $before_prov, $seq)",
  lastSeq: "UPDATE space SET last_seq = $seq WHERE one = 1",
  markStep: `UPDATE commits SET undo_status = 'done' WHERE seq = $seq AND ${STEP_SQL("$seq")}`,
  deadUndone:
    "UPDATE commits SET undo_status = 'dead' WHERE principal_id = $principal AND undo_status = 'undone'",
  markUndone: "UPDATE commits SET undo_status = 'undone', undone_by = $seq WHERE seq = $target",
  markRedone: "UPDATE commits SET undo_status = 'done', undone_by = NULL WHERE seq = $target",
  markDead: "UPDATE commits SET undo_status = 'dead' WHERE seq = $target",
} as const;

export type TreeStatus = "applied" | "unchanged" | "conflict" | "rejected";

export interface TreeResult {
  status: TreeStatus;
  as_of: string;
  seq: number;
  commit?: Id<"op">;
  /** What the command did, as it said: stored with the receipt and returned on a retry. */
  result?: unknown;
  error?: { code: string; message: string; field?: string; data?: unknown };
  conflicts?: TreeConflict[];
  replayed?: true;
}

export interface TreeWriterOptions {
  machineId: string;
  random?: RandomSource;
  clock?: () => number;
  /** Called before COMMIT and after it: the crash harness stops the process there. */
  at?: (point: "before-commit" | "after-commit", result: TreeResult) => void;
}

/** The writer of one tree space, on its writer connection. Synchronous. */
export class TreeWriter {
  readonly #conn: Connection;
  readonly #machine: string;
  readonly #random: RandomSource;
  readonly #clock: () => number;
  readonly #at: TreeWriterOptions["at"];
  #last = 0;

  constructor(conn: Connection, options: TreeWriterOptions) {
    this.#conn = conn;
    this.#machine = options.machineId;
    this.#random = options.random ?? osRandom;
    this.#clock = options.clock ?? Date.now;
    this.#at = options.at;
  }

  get connection(): Connection {
    return this.#conn;
  }

  submit(request: TreeRequest): TreeResult {
    const result = this.#conn.transaction("immediate", () => {
      const decided = this.#decide(request);
      this.#at?.("before-commit", decided);
      return decided;
    });
    this.#at?.("after-commit", result);
    return result;
  }

  #space(): SpaceState {
    const r = new RowReader("space", this.#conn.prepare(SQL.space).get() ?? {});
    return {
      spaceId: r.text("space_id"),
      refPrefix: r.text("ref_prefix"),
      lastSeq: r.int("last_seq", "seq"),
      epoch: r.int("authority_epoch", "epoch"),
      incarnation: r.id("authority_incarnation", "ai"),
      machine: r.text("authority_machine"),
    };
  }

  #decide(request: TreeRequest): TreeResult {
    const space = this.#space();
    const asOf = { epoch: space.epoch, incarnation: space.incarnation, seq: space.lastSeq };
    const now = (status: TreeStatus, more: Partial<TreeResult> = {}): TreeResult => ({
      status,
      as_of: formatAsOf(asOf),
      seq: asOf.seq,
      ...more,
    });
    // Nothing here decides the intent, so nothing stores a receipt.
    if (request.space_id !== space.spaceId) {
      return now("rejected", {
        error: {
          code: "SPACE_MISMATCH",
          message: "The request names another space",
          field: "space_id",
        },
      });
    }
    if (space.machine !== this.#machine) {
      return now("rejected", {
        error: { code: "SPACE_READ_ONLY", message: "This machine is not the space's authority" },
      });
    }
    // Who asks: a principal of the kind the request says, and an author the space knows.
    const { principal_id, actor_kind, author_id } = request.actor;
    const refuse = (message: string, field: string) =>
      now("rejected", { error: { code: "VALIDATION_FAILED", message, field } });
    if (this.#conn.prepare(SQL.actor).get({ id: principal_id })?.["kind"] !== actor_kind) {
      return refuse("The principal is not an actor of that kind", "actor.principal_id");
    }
    if (
      author_id !== undefined &&
      this.#conn.prepare(SQL.actor).get({ id: author_id }) === undefined
    ) {
      return refuse("The author is not an actor of this space", "actor.author_id");
    }
    const lookup = { scope: request.actor.scope_id, request: request.request_id };
    const fingerprint = intentFingerprint({
      space_id: request.space_id,
      entry: request.entry ?? request.command,
      input: request.input,
      reason: request.reason ?? null,
    });
    const prior = this.#conn.prepare(SQL.receipt).get(lookup);
    if (prior !== undefined) {
      const stored = JSON.parse(String(prior["result"])) as TreeResult;
      if (prior["fingerprint"] === fingerprint) return { ...stored, replayed: true };
      return now("rejected", {
        error: {
          code: "REQUEST_ID_REUSED",
          message: "This request ID was used for another change: review it, then use a new ID",
          field: "request_id",
        },
      });
    }
    const result = this.#judge(request, space, now);
    const accepted = result.status === "applied" || result.status === "unchanged";
    if (accepted || request.entry === undefined) {
      this.#conn.prepare(SQL.insertReceipt).run({
        ...lookup,
        fingerprint,
        status: result.status,
        seq: result.commit === undefined ? null : result.seq,
        epoch: space.epoch,
        incarnation: space.incarnation,
        result: JSON.stringify(result),
        at: this.#instant(),
      });
    }
    return result;
  }

  /** A clock that never goes back within this writer. */
  #instant(): number {
    this.#last = Math.max(this.#last, this.#clock());
    return this.#last;
  }

  #judge(
    request: TreeRequest,
    space: SpaceState,
    now: (status: TreeStatus, more?: Partial<TreeResult>) => TreeResult,
  ): TreeResult {
    let base: number | undefined;
    if (request.base !== undefined) {
      const parsed = parseAsOf(request.base);
      if (parsed === undefined) {
        return now("rejected", {
          error: {
            code: "VALIDATION_FAILED",
            message: "Copy as_of verbatim as the base",
            field: "base",
          },
        });
      }
      if (
        parsed.epoch !== space.epoch ||
        parsed.incarnation !== incarnationTag(space.incarnation)
      ) {
        return now("rejected", {
          error: {
            code: "EPOCH_CHANGED",
            message: "The space was restored or claimed since that read: read again",
            field: "base",
          },
        });
      }
      if (parsed.seq > space.lastSeq) {
        return now("rejected", {
          error: {
            code: "BASE_FROM_FUTURE",
            message: "The base is newer than the space",
            field: "base",
          },
        });
      }
      base = parsed.seq;
    }
    const history = request.command === "undo" || request.command === "redo";
    const run = history ? undefined : COMMANDS[request.command];
    if (!history && run === undefined) {
      return now("rejected", {
        error: { code: "VALIDATION_FAILED", message: "No command of that name", field: "command" },
      });
    }
    const seq = space.lastSeq + 1;
    const at = this.#instant();
    const commit = newId("op", this.#random);
    this.#conn.exec("SAVEPOINT tree");
    let plan: HistoryRun | undefined;
    // Undo and Redo are guarded by newer work (steps.ts), not by a base.
    const guard = history ? "history" : base;
    const tx = new Tx(this.#conn, seq, at, request, space, guard, this.#random, COMMANDS);
    try {
      let said: unknown;
      if (history) {
        plan = planHistory(tx, request.command as "undo" | "redo", request.input);
      }
      this.#insertCommit(tx, commit, plan);
      if (plan !== undefined) for (const call of plan.calls) tx.call(call.command, call.input);
      else said = run?.(tx, request.input);
      if (tx.conflicts.length > 0) {
        const message = "A field changed after the base: read again";
        throw new TreeProblem("VERSION_CONFLICT", message, undefined, tx.conflicts);
      }
      const changes = tx.finish();
      if (changes.length === 0) {
        // Already as it was: a step leaves the stack, as one newer work kept.
        if (plan !== undefined)
          throw new TreeProblem("STEP_KEPT", "Already as it was", undefined, {
            target: plan.target,
            work: [],
          });
        this.#conn.exec("ROLLBACK TO tree");
        this.#conn.exec("RELEASE tree");
        return now("unchanged", said === undefined ? {} : { result: said });
      }
      const insert = this.#conn.prepare(SQL.insertChange);
      changes.forEach((c, i) => {
        insert.run({
          seq,
          n: i + 1,
          entity: c.entity,
          entity_id: c.entityId,
          node: c.node,
          action: c.action,
          field: c.field,
          before: c.before,
          after: c.after,
          before_ver: c.beforeVer,
          before_prov: c.beforeProv,
        });
      });
      if (plan !== undefined) {
        const target = plan.target;
        if (plan.kind === "undo") this.#conn.prepare(SQL.markUndone).run({ target, seq });
        else this.#conn.prepare(SQL.markRedone).run({ target });
      } else if (
        request.actor.actor_kind === "human" &&
        this.#conn.prepare(SQL.markStep).run({ seq }).changes > 0
      ) {
        // A new step ends what could be redone.
        this.#conn.prepare(SQL.deadUndone).run({ principal: request.actor.principal_id });
      }
      this.#conn.prepare(SQL.lastSeq).run({ seq });
      this.#conn.exec("RELEASE tree");
      return {
        status: "applied",
        as_of: formatAsOf({ epoch: space.epoch, incarnation: space.incarnation, seq }),
        seq,
        commit,
        ...(said === undefined ? {} : { result: said }),
      };
    } catch (error) {
      this.#conn.exec("ROLLBACK TO tree");
      this.#conn.exec("RELEASE tree");
      // A write a conflict held back can leave a later statement nothing valid to do: the request
      // was a conflict, and that is its answer, rolled back with everything else.
      if (tx.conflicts.length > 0) {
        const message = "A field changed after the base: read again";
        const conflicts: TreeConflict[] = tx.conflicts;
        return now("conflict", { error: { code: "VERSION_CONFLICT", message }, conflicts });
      }
      if (!(error instanceof TreeProblem)) throw error;
      // Newer work stands in the way, or the opposite cannot be applied now (a task in the Trash):
      // the step leaves the stack, and the answer says whose work or why.
      const kept =
        error.code === "STEP_KEPT"
          ? (error.data as { target: number; work: unknown[] })
          : plan === undefined
            ? undefined
            : { target: plan.target, work: [], reason: error.message };
      if (kept !== undefined) {
        this.#conn.prepare(SQL.markDead).run({ target: kept.target });
        return now("applied", { result: { kept } });
      }
      return now("rejected", {
        error: {
          code: error.code,
          message: error.message,
          ...(error.field === undefined ? {} : { field: error.field }),
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      });
    }
  }

  #insertCommit(tx: Tx, id: Id<"op">, plan: HistoryRun | undefined): void {
    const { actor } = tx.request;
    this.#conn.prepare(SQL.insertCommit).run({
      seq: tx.seq,
      id,
      epoch: tx.space.epoch,
      incarnation: tx.space.incarnation,
      at: tx.at,
      actor_kind: actor.actor_kind,
      principal: actor.principal_id,
      author: tx.author,
      scope: actor.scope_id,
      machine: actor.machine_id,
      session: actor.session_id ?? null,
      run: actor.run_id ?? null,
      origin: actor.origin,
      request: tx.request.request_id,
      kind: plan?.kind ?? "command",
      ops: JSON.stringify([{ v: 1, command: tx.request.command, input: tx.request.input }]),
      reason: tx.request.reason ?? null,
      undo_of: plan?.kind === "undo" ? plan.target : null,
      redo_of: plan?.kind === "redo" ? plan.target : null,
    });
  }
}
