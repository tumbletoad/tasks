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
import { PREFERENCES } from "@ttasks/contracts/preferences";
import { RowReader } from "../rows.ts";
import { agentLabel, notTheAuthority, spaceHuman } from "../write/actors.ts";
import { intentFingerprint } from "../write/receipts.ts";
import { formatTaskRef } from "../refs.ts";
import {
  checkBaseOf,
  checkEnvelope,
  checkHistoryEnvelope,
  checkIntent,
  checkRequest,
  Fields,
  formatAsOf,
  keptResult,
  RequestProblem,
  type CheckedRequest,
  type FieldConflict,
  type NewerWork,
  type Operation,
  type OpResult,
  type WriteProblem,
  type WriteResult,
} from "../write/request.ts";
import { runPlan } from "./plan.ts";
import { checkHistory } from "./commands.ts";
import { COMMANDS } from "./registry.ts";
import { TreeProblem } from "./fields.ts";
import { DERIVED } from "./schema.ts";
import { planHistory, STEP_SQL, stepFacts } from "./steps.ts";
import { indexTreeChanges } from "./search.ts";
import {
  Tx,
  type CheckedTreeRequest,
  type HistoryRun,
  type SpaceState,
  type TreeConflict,
} from "./tx.ts";

export type { CheckedTreeRequest, TreeActor, TreeRequest } from "./tx.ts";

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
    "before_ver, before_prov, after_prov, op) VALUES ($seq, $n, $entity, $entity_id, $node, " +
    "$action, $field, $before, $after, $before_ver, $before_prov, $seq, $op)",
  lastSeq: "UPDATE space SET last_seq = $seq WHERE one = 1",
  markStep: `UPDATE commits SET undo_status = 'done' WHERE seq = $seq AND ${STEP_SQL("$seq")}`,
  deadUndone:
    "UPDATE commits SET undo_status = 'dead' WHERE principal_id = $principal AND undo_status = 'undone'",
  markUndone: "UPDATE commits SET undo_status = 'undone', undone_by = $seq WHERE seq = $target",
  markRedone: "UPDATE commits SET undo_status = 'done', undone_by = NULL WHERE seq = $target",
  markDead: "UPDATE commits SET undo_status = 'dead' WHERE seq = $target",
  preference: "SELECT version FROM preferences WHERE key = $key",
  preferenceRow: "SELECT * FROM preferences WHERE key = $key",
  machine: "SELECT * FROM machines WHERE id = $id",
  insertMachine:
    "INSERT INTO machines (id, name, os, first_seen, created_seq, version) " +
    "VALUES ($id, $name, $os, $at, $seq, $seq)",
  system: "SELECT id FROM actors WHERE kind = 'system' ORDER BY created_at, id LIMIT 1",
  firstHuman: "SELECT id FROM actors WHERE kind = 'human' ORDER BY created_at, id LIMIT 1",
  actorByLabel: "SELECT id FROM actors WHERE kind = $kind AND label = $label",
  insertActor: "INSERT INTO actors (id, kind, label, created_at) VALUES ($id, $kind, $label, $at)",
  /** Who made commit `$seq`, and when. */
  author:
    "SELECT k.author_id AS actor, a.kind AS kind, a.label AS label, k.origin AS origin, k.at AS at " +
    "FROM commits k JOIN actors a ON a.id = k.author_id WHERE k.seq = $seq",
  ref: "SELECT t.ref AS ref, s.ref_prefix AS prefix FROM tasks t, space s WHERE t.id = $id",
} as const;

/** The command a request of today's operations runs as (plan.ts). */
const PLAN = "plan";
const PLAN_RUN = {
  check: (f: Fields) => f.raw("ops") as Record<string, unknown>,
  run: (tx: Tx, input: Record<string, unknown>) => runPlan(tx, input["ops"] as Operation[]),
};

/** Today's names of the tree's task fields that a conflict names. */
const TODAY_FIELD: Readonly<Record<string, string>> = {
  brief: "summary",
  description: "context",
};

/**
 * A plan's result as today's writer gives it: one result per operation, the conflicts on a task
 * named as a task's fields, and the space's authority. A result already in today's shape (from a
 * receipt) is returned as it is.
 */
function written(result: TreeResult, space: SpaceState): WriteResult {
  const error = result.error;
  // An Undo's or a Redo's facts (steps.ts stepFacts), and whose work kept it.
  const history = isHistory(result.result) ? result.result : undefined;
  return {
    status: result.status,
    as_of: result.as_of,
    epoch: space.epoch,
    incarnation: space.incarnation,
    seq: result.seq,
    ...(result.commit === undefined ? {} : { commit: result.commit }),
    results: Array.isArray(result.result)
      ? (result.result as OpResult[])
      : history === undefined
        ? []
        : [
            {
              i: 0,
              status: result.status === "applied" ? "updated" : "unchanged",
              id: history.commit,
              tasks: history.tasks,
              task_count: history.task_count,
              ...(history.lifecycles === undefined ? {} : { lifecycles: history.lifecycles }),
              version: result.seq,
            },
          ],
    ...(history?.kept === undefined
      ? {}
      : {
          kept: true,
          ...(history.kept.reason === undefined ? {} : { why: history.kept.reason }),
          ...(history.kept.work.length === 0
            ? {}
            : { newer: { work: history.kept.work as NewerWork["work"] } }),
        }),
    conflicts: (result.conflicts ?? []).map(
      ({ task, ...c }) =>
        ({
          ...c,
          op: c.op ?? 0,
          entity: c.entity === "nodes" ? "tasks" : (c.entity as FieldConflict["entity"]),
          field: TODAY_FIELD[c.field] ?? c.field,
          ...(task === undefined ? {} : { task }),
        }) as FieldConflict,
    ),
    ...(error === undefined
      ? {}
      : {
          error: {
            code: error.code as WriteProblem["code"],
            message: error.message,
            ...(error.op === undefined ? {} : { op: error.op }),
            ...(error.field === undefined
              ? {}
              : { field: TODAY_FIELD[error.field] ?? error.field }),
            ...(error.at === undefined ? {} : { at: error.at }),
            ...holdersOf(error.data),
          },
        }),
    warnings: result.warnings ?? [],
    ...(result.answer === undefined ? {} : { answer: result.answer }),
    ...(result.replayed === true ? { replayed: true } : {}),
  };
}

/** The tasks that hold a size a refused change of levels drops (prefs.ts). */
function holdersOf(data: unknown): Pick<WriteProblem, "holders"> {
  const holders = (data as Pick<WriteProblem, "holders"> | undefined)?.holders;
  return holders === undefined ? {} : { holders };
}

interface HistoryFacts {
  commit: Id<"op">;
  tasks: string[];
  task_count: number;
  lifecycles?: string[];
  kept?: { work: unknown[]; reason?: string };
}

const isHistory = (said: unknown): said is HistoryFacts =>
  typeof said === "object" && said !== null && !Array.isArray(said) && "commit" in said;

/** What a preview throws to roll its transaction back. */
const PREVIEW = new Error("A preview rolls its transaction back");

export type TreeStatus = "applied" | "unchanged" | "conflict" | "rejected";

export interface TreeResult {
  status: TreeStatus;
  as_of: string;
  seq: number;
  commit?: Id<"op">;
  /** What the command did, as it said: stored with the receipt and returned on a retry. */
  result?: unknown;
  error?: {
    code: string;
    message: string;
    field?: string;
    at?: number;
    data?: unknown;
    /** The operation of a plan that met it. */
    op?: number;
  };
  conflicts?: TreeConflict[];
  /** What the caller found before the writer, said with an accepted result and replayed. */
  warnings?: string[];
  /** What the caller decided before the writer, kept with an accepted result. */
  answer?: Record<string, unknown>;
  /** A preview's: the version of the preference it would change, 0 when the space holds none. */
  version?: number;
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

  /**
   * Registers this machine in the space once, by a system commit with the machine's create row.
   * Only the authority writes. Returns whether it wrote.
   */
  registerMachine(machine: { name: string; os: "linux" | "windows" | "macos" }): boolean {
    return this.#conn.transaction("immediate", () => {
      if (this.#conn.prepare(SQL.machine).get({ id: this.#machine }) !== undefined) return false;
      if (this.#space().machine !== this.#machine) return false;
      const input = { name: machine.name, os: machine.os };
      this.#system(
        `register-machine-${this.#machine.slice(2)}`,
        "machine.register",
        input,
        (seq, at) => {
          this.#conn.prepare(SQL.insertMachine).run({ id: this.#machine, ...input, at, seq });
          const row = this.#conn.prepare(SQL.machine).get({ id: this.#machine }) ?? {};
          return [{ entity: "machines", id: this.#machine, row }];
        },
      );
      return true;
    });
  }

  /**
   * The actor a connection writes as: the space's person for `human`, or the agent of that label,
   * which joins the space on its first act by a system commit with no change rows (an actor has no
   * versions). A label is one line of 1 to 100 characters, as today's writer takes it.
   */
  actor(kind: "human" | "agent", label: string): Id<"ac"> {
    if (kind === "human") {
      const found = this.#conn.transaction("deferred", () =>
        this.#conn.prepare(SQL.firstHuman).get(),
      );
      return spaceHuman(found?.["id"]);
    }
    const name = agentLabel(label);
    return this.#conn.transaction("immediate", () => {
      const found = this.#conn.prepare(SQL.actorByLabel).get({ kind, label: name })?.["id"];
      if (typeof found === "string") return found as Id<"ac">;
      if (this.#space().machine !== this.#machine) throw notTheAuthority();
      const id = newId("ac", this.#random);
      this.#system(
        `register-actor-${id.slice(3)}`,
        "actor.register",
        { kind, label: name },
        (_, at) => {
          this.#conn.prepare(SQL.insertActor).run({ id, kind, label: name, at });
          return [];
        },
      );
      return id;
    });
  }

  /**
   * Stores the default of each preference a space always holds (PreferenceSpec.stored) where it
   * holds none, as the space's system actor, a request each. Safe to call again.
   */
  storeDefaults(): boolean {
    const { missing, system, space } = this.#conn.transaction("deferred", () => ({
      missing: PREFERENCES.filter(
        (p) =>
          p.scope === "space" &&
          p.stored === true &&
          this.#conn.prepare(SQL.preferenceRow).get({ key: p.key }) === undefined,
      ),
      system: this.#conn.prepare(SQL.system).get()?.["id"] as Id<"ac">,
      space: this.#space(),
    }));
    if (missing.length === 0 || space.machine !== this.#machine) return false;
    for (const p of missing) {
      const result = this.submit({
        space_id: space.spaceId,
        request_id: `store-defaults-${newId("op", this.#random).slice(3)}`,
        actor: {
          scope_id: "defaults",
          principal_id: system,
          actor_kind: "system",
          machine_id: this.#machine,
          origin: "system",
        },
        base: formatAsOf({
          epoch: space.epoch,
          incarnation: space.incarnation,
          seq: this.#space().lastSeq,
        }),
        command: "pref.set",
        input: { key: p.key, value: p.default },
      });
      if (result.status !== "applied")
        throw new Error("The space's default preferences were not stored");
    }
    return true;
  }

  /**
   * One system commit in the caller's transaction: the commit row, the rows `write` makes with
   * their create rows, and the space's last seq. A system commit has no receipt.
   */
  #system(
    request: string,
    command: string,
    input: Record<string, unknown>,
    write: (
      seq: number,
      at: number,
    ) => { entity: string; id: string; row: Record<string, unknown> }[],
  ): void {
    const space = this.#space();
    const seq = space.lastSeq + 1;
    const at = this.#instant();
    const system = this.#conn.prepare(SQL.system).get()?.["id"];
    this.#conn.prepare(SQL.insertCommit).run({
      seq,
      id: newId("op", this.#random),
      epoch: space.epoch,
      incarnation: space.incarnation,
      at,
      actor_kind: "system",
      principal: String(system),
      author: String(system),
      scope: "system",
      machine: this.#machine,
      session: null,
      run: null,
      origin: "system",
      request,
      kind: command,
      ops: JSON.stringify([{ v: 1, command, input }]),
      reason: null,
      undo_of: null,
      redo_of: null,
    });
    write(seq, at).forEach((made, i) => {
      const after = Object.fromEntries(Object.entries(made.row).filter(([c]) => !DERIVED.has(c)));
      this.#conn.prepare(SQL.insertChange).run({
        seq,
        n: i + 1,
        entity: made.entity,
        entity_id: made.id,
        node: null,
        action: "create",
        field: null,
        before: null,
        after: JSON.stringify(after),
        before_ver: null,
        before_prov: null,
        op: null,
      });
    });
    this.#conn.prepare(SQL.lastSeq).run({ seq });
  }

  /**
   * Decides one request. Its shape is checked first, by the checks today's writer runs
   * (write/request.ts `checkEnvelope`) and the command's own: such a refusal depends on the input
   * alone, so it is decided by nothing and stores nothing, and the same request ID can carry the
   * corrected request.
   */
  submit(input: unknown): TreeResult {
    let request: CheckedTreeRequest;
    try {
      request = checkTreeRequest(input);
    } catch (error) {
      if (!(error instanceof RequestProblem)) throw error;
      const space = this.#conn.transaction("deferred", () => this.#space());
      return {
        status: "rejected",
        as_of: formatAsOf({
          epoch: space.epoch,
          incarnation: space.incarnation,
          seq: space.lastSeq,
        }),
        seq: space.lastSeq,
        error: problemOf(error.problem),
      };
    }
    if (request.dry_run === true) {
      const { versions, ...would } = this.#preview(request, [String(request.input["key"])]);
      return { ...would, version: versions[0] ?? 0 };
    }
    return this.#submitted(request);
  }

  /**
   * Decides a request of today's operations (plan.ts), with today's checks of it, and answers with
   * today's result. Its receipt keeps that result under the fingerprint of the caller's intent, as
   * today's writer keeps it, so the service answers a retry the same way on both.
   */
  submitPlan(input: unknown): WriteResult {
    let checked: CheckedRequest;
    try {
      checked = checkRequest(input);
    } catch (error) {
      return this.#refused(error);
    }
    const { ops, intent, ...envelope } = checked;
    // An Undo or a Redo is a request of its own (request.ts): the tree's, guarded by newer work.
    const [first] = ops;
    const history = first?.kind === "undo" || first?.kind === "redo" ? first : undefined;
    const request: CheckedTreeRequest = {
      ...envelope,
      command: history?.kind ?? PLAN,
      input:
        history === undefined
          ? { ops }
          : history.commit === undefined
            ? {}
            : { commit: history.commit },
      plan: true,
      ...(intent === undefined ? {} : { entry: intent.entry, intent }),
    };
    if (checked.dry_run === true) {
      // As today's preview: each result says the version of the preference it would change.
      const keys = ops.map((op) => (op.kind === "pref.set" ? op.key : ""));
      const { versions, ...would } = this.#preview(request, keys);
      const said = written(
        would,
        this.#conn.transaction("deferred", () => this.#space()),
      );
      return { ...said, results: said.results.map((r) => ({ ...r, version: versions[r.i] ?? 0 })) };
    }
    const result = this.#submitted(request);
    if (result.replayed === true && "results" in result) return result as unknown as WriteResult;
    // An Undo's or a Redo's refusal is of its one operation, as today's writer says it.
    if (history !== undefined && result.error !== undefined) result.error.op ??= 0;
    return written(
      result,
      this.#conn.transaction("deferred", () => this.#space()),
    );
  }

  /**
   * Decides a request of one of the tree's own commands, for what today's operations have no form
   * of, and answers it, and keeps its receipt, as `submitPlan` does: in today's shape, under the
   * fingerprint of the caller's intent when it names one.
   */
  submitCommand(input: unknown): WriteResult {
    let request: CheckedTreeRequest;
    try {
      request = checkTreeRequest(input);
    } catch (error) {
      return this.#refused(error);
    }
    const result = this.#submitted({ ...request, plan: true });
    if (result.replayed === true && "results" in result) return result as unknown as WriteResult;
    return written(
      result,
      this.#conn.transaction("deferred", () => this.#space()),
    );
  }

  /** A request whose shape is refused, in today's shape: decided by nothing, stored nowhere. */
  #refused(error: unknown): WriteResult {
    if (!(error instanceof RequestProblem)) throw error;
    const space = this.#conn.transaction("deferred", () => this.#space());
    return written(
      { status: "rejected", ...this.#asOf(space), error: problemOf(error.problem) },
      space,
    );
  }

  #asOf(space: SpaceState): { as_of: string; seq: number } {
    const asOf = { epoch: space.epoch, incarnation: space.incarnation, seq: space.lastSeq };
    return { as_of: formatAsOf(asOf), seq: space.lastSeq };
  }

  #submitted(request: CheckedTreeRequest): TreeResult {
    const result = this.#conn.transaction("immediate", () => {
      const decided = this.#decide(request);
      this.#at?.("before-commit", decided);
      return decided;
    });
    this.#at?.("after-commit", result);
    return result;
  }

  /**
   * A preview: decided whole, its receipt included, then rolled back, so nothing of it stays. Its
   * answer says the space as it is, and the version of each preference of `keys` as it is, 0 when
   * the space holds none.
   */
  #preview(
    request: CheckedTreeRequest,
    keys: readonly string[],
  ): TreeResult & { versions: number[] } {
    let would: (TreeResult & { versions: number[] }) | undefined;
    try {
      this.#conn.transaction("immediate", () => {
        const asOf = this.#space();
        const versions = keys.map((key) =>
          Number(this.#conn.prepare(SQL.preference).get({ key })?.["version"] ?? 0),
        );
        const decided = this.#decide(request);
        would = {
          ...decided,
          as_of: formatAsOf({
            epoch: asOf.epoch,
            incarnation: asOf.incarnation,
            seq: asOf.lastSeq,
          }),
          seq: asOf.lastSeq,
          versions,
        };
        delete would.commit;
        throw PREVIEW;
      });
    } catch (error) {
      if (error !== PREVIEW) throw error;
    }
    if (would === undefined) throw new Error("A preview is decided before it is rolled back");
    return would;
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

  #decide(request: CheckedTreeRequest): TreeResult {
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
    // Retries are kept apart by writer scope: the scope is part of the receipt's key.
    const lookup = { scope: request.actor.scope_id, request: request.request_id };
    // A plan's is the caller's intent, as today's writer's is (receipts.ts requestFingerprint).
    const fingerprint = intentFingerprint({
      space_id: request.space_id,
      entry: request.intent?.entry ?? request.entry ?? request.command,
      input: request.intent?.input ?? request.input,
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
          // When the first use was decided, so the caller can find it, as today's writer says it.
          at: Number(prior["at"]),
        },
      });
    }
    const judged = this.#judge(request, space, now);
    // What the caller found before the writer goes with an accepted result and into its receipt, so
    // a replay is answered from the same record.
    const accepted = judged.status === "applied" || judged.status === "unchanged";
    const result: TreeResult = !accepted
      ? judged
      : {
          ...judged,
          ...(request.warnings === undefined || request.warnings.length === 0
            ? {}
            : { warnings: [...request.warnings] }),
          ...(request.answer === undefined ? {} : { answer: request.answer }),
        };
    // A poll that wrote nothing is decided again at the next look under the same request ID.
    const polled = COMMANDS[request.command]?.poll === true && result.commit === undefined;
    if (!polled && (accepted || request.entry === undefined)) {
      this.#conn.prepare(SQL.insertReceipt).run({
        ...lookup,
        fingerprint,
        status: result.status,
        seq: result.commit === undefined ? null : result.seq,
        epoch: space.epoch,
        incarnation: space.incarnation,
        result: JSON.stringify(
          request.plan === true ? written(storedResult(result), space) : storedResult(result),
        ),
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
    request: CheckedTreeRequest,
    space: SpaceState,
    now: (status: TreeStatus, more?: Partial<TreeResult>) => TreeResult,
  ): TreeResult {
    const asOf = { epoch: space.epoch, incarnation: space.incarnation, seq: space.lastSeq };
    if (request.base !== undefined) {
      try {
        checkBaseOf(request.base, asOf);
      } catch (error) {
        if (!(error instanceof RequestProblem)) throw error;
        return now("rejected", { error: problemOf(error.problem) });
      }
    }
    const base = request.base?.seq;
    const history = request.command === "undo" || request.command === "redo";
    const run = history
      ? undefined
      : request.command === PLAN
        ? PLAN_RUN
        : COMMANDS[request.command];
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
      if (plan !== undefined) {
        for (const call of plan.calls) tx.call(call.command, call.input);
        said = stepFacts(this.#conn, plan.target, space.refPrefix);
      } else said = run?.run(tx, request.input);
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
          op: c.op,
        });
      });
      indexTreeChanges(this.#conn, seq, changes);
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
        const conflicts = this.#attributed(tx.conflicts);
        return now("conflict", { error: { code: "VERSION_CONFLICT", message }, conflicts });
      }
      // An opposite or a follow-up whose input does not hold: decided, as any refusal of the run.
      if (error instanceof RequestProblem)
        return now("rejected", { error: problemOf(error.problem) });
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
        return now("unchanged", {
          result: { kept, ...stepFacts(this.#conn, kept.target, space.refPrefix) },
        });
      }
      return now("rejected", {
        error: {
          code: error.code,
          message: error.message,
          ...(error.field === undefined ? {} : { field: error.field }),
          ...(error.data === undefined ? {} : { data: error.data }),
          ...(error.op === undefined ? {} : { op: error.op }),
        },
      });
    }
  }

  /**
   * The conflicts as a person reads them: the task's reference, the value now, and who changed it
   * and when, from the commit of each field's version.
   */
  #attributed(conflicts: readonly TreeConflict[]): TreeConflict[] {
    return conflicts.map((c) => {
      const by = this.#conn.prepare(SQL.author).get({ seq: c.version });
      const ref =
        c.task === undefined ? undefined : this.#conn.prepare(SQL.ref).get({ id: c.task });
      return {
        ...c,
        ...(typeof ref?.["ref"] === "number"
          ? { ref: formatTaskRef(String(ref["prefix"]), ref["ref"]) }
          : {}),
        ...(by === undefined
          ? {}
          : {
              by: {
                actor: String(by["actor"]),
                kind: String(by["kind"]),
                label: String(by["label"]),
                origin: String(by["origin"]),
              },
              at: Number(by["at"]),
            }),
      };
    });
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
      // Today's request keeps today's record: each operation by its kind, as a change names it.
      kind: plan?.kind ?? (tx.request.command === PLAN ? "ops" : "command"),
      ops: JSON.stringify(
        tx.request.command === PLAN
          ? (tx.request.input["ops"] as Operation[]).map((op) => ({ v: 1, op: op.kind, input: op }))
          : [{ v: 1, command: tx.request.command, input: tx.request.input }],
      ),
      reason: tx.request.reason ?? null,
      undo_of: plan?.kind === "undo" ? plan.target : null,
      redo_of: plan?.kind === "redo" ? plan.target : null,
    });
  }
}

/**
 * The checks a tree request meets before any transaction: today's writer's envelope, then the
 * command's own check of its input (commands.ts), text normalised by both. Throws RequestProblem.
 */
export function checkTreeRequest(value: unknown): CheckedTreeRequest {
  const { envelope, fields: f } = checkEnvelope(value);
  const command = f.raw("command");
  const history = command === "undo" || command === "redo";
  const named = typeof command === "string" && !history ? COMMANDS[command] : undefined;
  if (!history && named === undefined) {
    return f.fail("VALIDATION_FAILED", "No command of that name", "command");
  }
  // The input's fields are named as the command names them (`tasks.0.title`), as a refusal of its
  // run names them too.
  const input = new Fields(f.raw("input"), "");
  const request: CheckedTreeRequest = {
    ...envelope,
    command: command as string,
    input: history ? checkHistory(input) : (named?.check(input) ?? {}),
  };
  if (f.has("entry")) request.entry = f.text("entry", { chars: 64, line: true });
  if (f.has("intent")) request.intent = checkIntent(f.raw("intent"));
  // A preview decides preferences only, as today.
  if (envelope.dry_run === true && command !== "pref.set") {
    f.fail("VALIDATION_FAILED", "A dry run decides preferences only", "dry_run");
  }
  if (history) checkHistoryEnvelope(f, envelope);
  f.done();
  return request;
}

/** A refusal as a result carries it: the code, a fixed message, and the field. */
function problemOf(problem: WriteProblem): NonNullable<TreeResult["error"]> {
  return {
    code: problem.code,
    message: problem.message,
    ...(problem.field === undefined ? {} : { field: problem.field }),
  };
}

/** The result as a receipt stores it: a conflict's values left out, its attribution kept. */
function storedResult(result: TreeResult): TreeResult {
  // A plan's results, with of a move's folders those today's receipt keeps.
  const said = Array.isArray(result.result)
    ? { result: (result.result as OpResult[]).map(keptResult) }
    : {};
  if (result.conflicts === undefined) return { ...result, ...said };
  const conflicts = result.conflicts.map((c) => {
    const kept = { ...c };
    delete kept.value;
    return kept;
  });
  return { ...result, ...said, conflicts };
}
