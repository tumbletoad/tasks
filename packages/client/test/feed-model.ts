// A model of the service's change feed (A5 3.15; A1 3.7) for the live store's property tests:
// a space whose commits change tasks, nodes and children, a filter that hides some commits, and a
// subscription that sends what the service's feed sends, `snapshot` and `batch` with coverage
// intervals, as packages/service/src/http/feed.ts and ws.ts build them:
//
// - a batch covers `(from, through]` with at most `limit` commits, and its events are the visible
//   commits in it;
// - a row is read at the head, so it is withheld (`row: null`) when a commit after `through`, or a
//   hidden commit in the batch, touched it; a child's change touches its task's row (`touched`);
// - a subscription with a cursor resumes from it when the authority is the same and the cursor is
//   not ahead of the head, and takes a snapshot otherwise;
// - an authority change (a new epoch and incarnation) makes the next read a snapshot;
// - an entity's `changed` names logical fields, as the service's change rows do (A1 3.4): `lifecycle`
//   stands for its completion columns too, `deleted` for `deleted_at`. The task map is the page's
//   TASK_FIELD_COLUMNS, which the real-feed test (live-store.test.ts) holds equal to storage's
//   TASK_FIELDS; this file stays free of storage's Node code, since the page's tests import it.
//
// Hidden commits touch only tasks of the hidden audience, and a subscriber's snapshot leaves those
// tasks out: the row-level rule of A5 3.15, built in M3.12. So "the snapshot at that point" is the
// visible state at a seq. Tests only.
import {
  TASK_FIELD_COLUMNS,
  type BatchMessage,
  type Cursor,
  type FeedEvent,
  type SnapshotMessage,
} from "../src/store/rows.ts";

/** The columns of each logical field, by kind of row: storage's own map for tasks. */
const COLUMNS: Record<ModelRow["type"], Readonly<Record<string, readonly string[]>>> = {
  task: TASK_FIELD_COLUMNS,
  node: { title: ["title"], deleted: ["deleted_at"] },
};

export const SPACE = "sp_0000000000000000000000000a";
export const OTHER_SPACE = "sp_0000000000000000000000000b";
const SPACE_NODE = { id: SPACE, kind: "space", title: "Mira", state: "active" };

type Fields = Record<string, string | number | boolean>;

interface ModelRow {
  readonly type: "task" | "node";
  readonly fields: Fields;
  /** Tasks only: whether this subscriber's audience sees it. */
  readonly hidden: boolean;
}

interface State {
  readonly rows: ReadonlyMap<string, ModelRow>;
}

interface ModelEntity {
  readonly type: string;
  readonly id: string;
  readonly task?: string;
  readonly changed: readonly string[];
  readonly created: boolean;
}

interface Commit {
  readonly seq: number;
  readonly epoch: number;
  readonly incarnation: string;
  readonly visible: boolean;
  readonly request_id: string;
  readonly kind: string;
  readonly entities: readonly ModelEntity[];
  /** The keys (`type:id`) of the rows this commit changed, a child's task included. */
  readonly rows: ReadonlySet<string>;
}

export type Op =
  | { readonly op: "add"; readonly hidden: boolean; readonly area: number }
  | { readonly op: "retitle"; readonly task: number }
  | { readonly op: "retitle2"; readonly task: number; readonly other: number }
  | { readonly op: "complete"; readonly task: number }
  | { readonly op: "reopen"; readonly task: number }
  | { readonly op: "delete"; readonly task: number }
  | { readonly op: "restore"; readonly task: number }
  | { readonly op: "note"; readonly task: number }
  | { readonly op: "move"; readonly task: number; readonly area: number }
  | { readonly op: "launch"; readonly task: number }
  | { readonly op: "area" }
  | { readonly op: "rename_area"; readonly area: number }
  | { readonly op: "delete_area"; readonly area: number }
  | { readonly op: "project"; readonly area: number };

const key = (type: string, id: string) => `${type}:${id}`;

export class FeedModel {
  epoch = 1;
  incarnation = "ai_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  seq = 0;
  readonly commits: Commit[] = [];
  /** The state after each seq: index 0 is the start. */
  readonly states: State[] = [{ rows: new Map() }];
  /** The seqs at which each authority began and ended (inclusive). */
  readonly authorities: { epoch: number; incarnation: string; from: number; to: number }[] = [
    { epoch: 1, incarnation: "ai_aaaaaaaaaaaaaaaaaaaaaaaaaa", from: 0, to: 0 },
  ];
  #n = 0;
  #requests = 0;

  get head(): Cursor {
    return { epoch: this.epoch, incarnation: this.incarnation, seq: this.seq };
  }

  get state(): State {
    const state = this.states[this.seq];
    if (state === undefined) throw new Error("no state");
    return state;
  }

  #ids(type: "task" | "node", filter: (row: ModelRow) => boolean = () => true) {
    return [...this.state.rows.entries()]
      .filter(([k, row]) => k.startsWith(`${type}:`) && filter(row))
      .map(([k]) => k.slice(type.length + 1));
  }

  #pick(type: "task" | "node", n: number, filter?: (row: ModelRow) => boolean) {
    const ids = this.#ids(type, filter);
    return ids.length === 0 ? undefined : ids[n % ids.length];
  }

  /** A project at the top: what the page calls an area. */
  #area(n: number, live = false) {
    return this.#pick(
      "node",
      n,
      (r) => r.fields["parent"] === SPACE && (!live || r.fields["deleted_at"] === undefined),
    );
  }

  /** A new authority (a claim elsewhere): the same rows, a new epoch and incarnation. */
  claim(): void {
    this.epoch += 1;
    const letter = String.fromCharCode(97 + (this.epoch % 26));
    this.incarnation = `ai_${letter.repeat(26)}`;
    this.authorities.push({
      epoch: this.epoch,
      incarnation: this.incarnation,
      from: this.seq,
      to: this.seq,
    });
  }

  /** Applies one operation as one commit. Returns false when it found nothing to act on. */
  apply(op: Op): boolean {
    const seq = this.seq + 1;
    const rows = new Map(this.state.rows);
    const entities: ModelEntity[] = [];
    const touched = new Set<string>();
    let hidden = false;
    const set = (type: ModelRow["type"], id: string, fields: Fields, changed: string[]) => {
      const before = rows.get(key(type, id));
      if (before === undefined) throw new Error("no row");
      // A logical field the change names is written whole: its columns the change does not set are
      // cleared, absent from the compact row.
      const columns = new Set(changed.flatMap((field) => COLUMNS[type][field] ?? [field]));
      const next: Fields = Object.fromEntries(
        Object.entries({ ...before.fields, ...fields, version: seq }).filter(
          ([column]) => !columns.has(column) || column in fields,
        ),
      );
      if (type === "task") next["touched"] = seq;
      rows.set(key(type, id), { ...before, fields: next });
      entities.push({
        type,
        id,
        ...(type === "task" ? { task: id } : {}),
        changed,
        created: false,
      });
      touched.add(key(type, id));
      if (before.hidden) hidden = true;
    };
    const task = (n: number, filter?: (row: ModelRow) => boolean) => this.#pick("task", n, filter);
    const active = (row: ModelRow) =>
      row.fields["lifecycle"] === "active" && row.fields["deleted_at"] === undefined;
    switch (op.op) {
      case "add": {
        this.#n += 1;
        const id = `t_${String(this.#n).padStart(26, "0")}`;
        const area = op.area % 3 === 0 ? undefined : this.#area(op.area);
        const fields: Fields = {
          id,
          ref: `M-${String(this.#n)}`,
          title: `Task ${String(this.#n)}`,
          lifecycle: "active",
          status: "open",
          inbox: area === undefined,
          priority: 4,
          position: `a${String(this.#n).padStart(4, "0")}`,
          created_at: seq * 1000,
          version: seq,
          touched: seq,
          parent: area ?? SPACE,
        };
        rows.set(key("task", id), { type: "task", fields, hidden: op.hidden });
        entities.push({ type: "task", id, task: id, changed: [], created: true });
        touched.add(key("task", id));
        hidden = op.hidden;
        break;
      }
      case "retitle":
      case "retitle2": {
        const id = task(op.task);
        if (id === undefined) return false;
        set("task", id, { title: `Title ${String(seq)}` }, ["title"]);
        if (op.op === "retitle2") {
          const other = task(op.other, (r) => r.hidden === rows.get(key("task", id))?.hidden);
          if (other !== undefined && other !== id) {
            set("task", other, { title: `Other ${String(seq)}` }, ["title"]);
          }
        }
        break;
      }
      case "complete": {
        const id = task(op.task, active);
        if (id === undefined) return false;
        set("task", id, { lifecycle: "completed", completed_at: seq * 1000 }, ["lifecycle"]);
        break;
      }
      case "reopen": {
        const id = task(op.task, (r) => r.fields["lifecycle"] === "completed");
        if (id === undefined) return false;
        set("task", id, { lifecycle: "active" }, ["lifecycle"]);
        break;
      }
      case "delete": {
        const id = task(op.task, (r) => r.fields["deleted_at"] === undefined);
        if (id === undefined) return false;
        set("task", id, { deleted_at: seq * 1000 }, ["deleted"]);
        break;
      }
      case "restore": {
        const id = task(op.task, (r) => r.fields["deleted_at"] !== undefined);
        if (id === undefined) return false;
        set("task", id, {}, ["deleted"]);
        break;
      }
      case "note": {
        const id = task(op.task);
        if (id === undefined) return false;
        const row = rows.get(key("task", id));
        if (row === undefined) return false;
        // A child changes: the task's row moves only its `touched` (A1 3.5).
        rows.set(key("task", id), { ...row, fields: { ...row.fields, touched: seq } });
        entities.push({
          type: "note",
          id: `n_${String(seq)}`,
          task: id,
          changed: [],
          created: true,
        });
        touched.add(key("task", id));
        hidden = row.hidden;
        break;
      }
      case "launch": {
        const id = task(op.task, (r) => !r.hidden);
        if (id === undefined) return false;
        // A launch is no child of its task: no task on its change, no `touched` (launches.ts).
        entities.push({
          type: "launch",
          id: `l_${String(seq)}`,
          changed: ["state"],
          created: false,
        });
        break;
      }
      case "move": {
        const id = task(op.task);
        const area = this.#area(op.area);
        if (id === undefined || area === undefined) return false;
        // `grouping` is written whole: the parent and the place it keeps.
        const position = rows.get(key("task", id))?.fields["position"] ?? "a";
        set("task", id, { parent: area, position, inbox: false }, ["grouping", "inbox"]);
        break;
      }
      case "area": {
        this.#n += 1;
        const id = `ar_${String(this.#n).padStart(25, "0")}`;
        rows.set(key("node", id), {
          type: "node",
          hidden: false,
          fields: {
            id,
            kind: "project",
            parent: SPACE,
            title: `Area ${String(this.#n)}`,
            position: `a${String(this.#n)}`,
            state: "active",
          },
        });
        entities.push({ type: "node", id, changed: [], created: true });
        touched.add(key("node", id));
        break;
      }
      case "rename_area": {
        const id = this.#area(op.area, true);
        if (id === undefined) return false;
        set("node", id, { title: `Area at ${String(seq)}` }, ["title"]);
        break;
      }
      case "delete_area": {
        const id = this.#area(op.area, true);
        if (id === undefined) return false;
        set("node", id, { deleted_at: seq * 1000 }, ["deleted"]);
        break;
      }
      case "project": {
        const area = this.#area(op.area);
        this.#n += 1;
        const id = `pj_${String(this.#n).padStart(25, "0")}`;
        rows.set(key("node", id), {
          type: "node",
          hidden: false,
          fields: {
            id,
            kind: "project",
            parent: area ?? SPACE,
            title: `Project ${String(this.#n)}`,
            position: `p${String(this.#n)}`,
            state: "active",
          },
        });
        entities.push({ type: "node", id, changed: [], created: true });
        touched.add(key("node", id));
        break;
      }
    }
    this.#requests += 1;
    this.commits.push({
      seq,
      epoch: this.epoch,
      incarnation: this.incarnation,
      visible: !hidden,
      request_id: `req-${String(this.#requests)}`,
      kind: op.op,
      entities,
      rows: touched,
    });
    this.seq = seq;
    this.states.push({ rows });
    const authority = this.authorities.at(-1);
    if (authority !== undefined) authority.to = seq;
    return true;
  }

  /** The request ID of the newest commit. */
  get lastRequest(): string {
    return this.commits.at(-1)?.request_id ?? "";
  }

  /** What this subscriber may see at `seq`, as the store holds it: open tasks and live nodes. */
  visibleAt(seq: number): { tasks: Map<string, Fields>; nodes: Map<string, Fields> } {
    const state = this.states[seq];
    if (state === undefined) throw new Error(`no state at ${String(seq)}`);
    const out = {
      tasks: new Map<string, Fields>(),
      nodes: new Map<string, Fields>([[SPACE, SPACE_NODE]]),
    };
    for (const row of state.rows.values()) {
      const f = row.fields;
      if (f["deleted_at"] !== undefined || row.hidden) continue;
      const id = String(f["id"]);
      if (row.type === "task" && f["lifecycle"] === "active") out.tasks.set(id, f);
      if (row.type === "node") out.nodes.set(id, f);
    }
    return out;
  }

  /** Whether `cursor` names a point this space really had. */
  hadCursor(cursor: Cursor): boolean {
    return this.authorities.some(
      (a) =>
        a.epoch === cursor.epoch &&
        a.incarnation === cursor.incarnation &&
        cursor.seq >= a.from &&
        cursor.seq <= a.to,
    );
  }

  snapshot(): SnapshotMessage {
    const visible = this.visibleAt(this.seq);
    return {
      type: "snapshot",
      space: { id: SPACE, name: "Mira", ref_prefix: "M" },
      cursor: this.head,
      tasks: [...visible.tasks.values()] as unknown as SnapshotMessage["tasks"],
      nodes: [...visible.nodes.values()] as unknown as SnapshotMessage["nodes"],
      instances: [],
    };
  }

  /** The service's batch after `after` (feed.ts's readBatch), at most `limit` commits. */
  batch(after: number, limit: number): BatchMessage {
    const through = Math.max(after, Math.min(this.seq, after + limit));
    const inBatch = this.commits.filter((c) => c.seq > after && c.seq <= through);
    const withheld = new Set<string>();
    for (const c of this.commits) if (c.seq > through) for (const k of c.rows) withheld.add(k);
    for (const c of inBatch) if (!c.visible) for (const k of c.rows) withheld.add(k);
    const head = this.state;
    const events: FeedEvent[] = inBatch
      .filter((c) => c.visible)
      .map((c) => ({
        seq: c.seq,
        request_id: c.request_id,
        actor: { kind: "agent", label: "Codex" },
        kind: c.kind,
        entities: c.entities.map((e) => {
          const k = key(e.type, e.id);
          const row = withheld.has(k) ? undefined : head.rows.get(k)?.fields;
          return {
            type: e.type,
            id: e.id,
            ...(e.task === undefined ? {} : { task: e.task }),
            row: row ?? null,
            changed: e.changed,
            created: e.created,
          };
        }),
      }));
    return {
      type: "batch",
      space_id: SPACE,
      epoch: this.epoch,
      incarnation: this.incarnation,
      from: after,
      through,
      events,
    };
  }
}

/**
 * One subscription as ws.ts serves it: the cursor it has sent up to, and what it sends next. A
 * resubscription replaces it.
 */
export class ModelSubscription {
  readonly #model: FeedModel;
  cursor: Cursor | undefined;

  constructor(model: FeedModel) {
    this.#model = model;
  }

  /** `subscribe {cursor?}`: a snapshot, or nothing when the cursor resumes. */
  subscribe(cursor: Cursor | undefined): (SnapshotMessage | BatchMessage)[] {
    const head = this.#model.head;
    if (
      cursor === undefined ||
      cursor.epoch !== head.epoch ||
      cursor.incarnation !== head.incarnation ||
      cursor.seq > head.seq
    ) {
      const snapshot = this.#model.snapshot();
      this.cursor = snapshot.cursor;
      return [snapshot];
    }
    this.cursor = cursor;
    return [];
  }

  /** One read of the pump: a snapshot after an authority change, else the next batch, if any. */
  pump(limit: number): (SnapshotMessage | BatchMessage)[] {
    const cursor = this.cursor;
    if (cursor === undefined) return [];
    const head = this.#model.head;
    if (cursor.epoch !== head.epoch || cursor.incarnation !== head.incarnation) {
      const snapshot = this.#model.snapshot();
      this.cursor = snapshot.cursor;
      return [snapshot];
    }
    const batch = this.#model.batch(cursor.seq, limit);
    if (batch.through === cursor.seq) return [];
    this.cursor = { ...cursor, seq: batch.through };
    return [batch];
  }

  /**
   * A batch that starts `back` commits behind what this subscription sent (A1 3.7's "from is
   * behind the cursor"): the service never sends one, and the store must take it all the same.
   */
  rewind(back: number, limit: number): BatchMessage[] {
    const cursor = this.cursor;
    const head = this.#model.head;
    if (
      cursor === undefined ||
      cursor.epoch !== head.epoch ||
      cursor.incarnation !== head.incarnation
    ) {
      return [];
    }
    const batch = this.#model.batch(Math.max(0, cursor.seq - back), limit);
    if (batch.through > cursor.seq) this.cursor = { ...cursor, seq: batch.through };
    return [batch];
  }

  /** The heartbeat: an empty batch `(seq, seq]`. */
  heartbeat(): BatchMessage[] {
    const cursor = this.cursor;
    if (cursor === undefined) return [];
    return [
      {
        type: "batch",
        space_id: SPACE,
        epoch: cursor.epoch,
        incarnation: cursor.incarnation,
        from: cursor.seq,
        through: cursor.seq,
        events: [],
      },
    ];
  }
}
