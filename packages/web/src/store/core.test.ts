// The live store's core against a model of the service (A7 3.12 M5.02's Verify line: any
// interleaving applied in order equals the snapshot at that point). The model (test/feed-model.ts)
// makes commits, hides some, and sends snapshots and batches as the service's feed does: capped
// batches with withheld rows, empty heartbeats, resumed and fresh subscriptions, authority changes.
// The network between them loses, repeats, reorders and replays messages, and slips in another
// space's. After every message the core holds exactly the model's visible state at its cursor, or
// has asked for a fresh snapshot. At the end, an orderly delivery brings it to the head.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  FeedModel,
  ModelSubscription,
  OTHER_SPACE,
  SPACE,
  type Op,
} from "../../test/feed-model.ts";
import { LiveCore, type Outcome } from "./core.ts";
import type { BatchMessage, SnapshotMessage } from "./rows.ts";

type Message = SnapshotMessage | BatchMessage;

/** A task of another space. */
const STRANGER = {
  id: "t_zzzzzzzzzzzzzzzzzzzzzzzzzz",
  ref: "O-1",
  title: "Elsewhere",
  lifecycle: "active",
  status: "open",
  inbox: true,
  position: "a",
  created_at: 0,
  version: 1,
};

type Action =
  | { readonly k: "op"; readonly op: Op }
  | { readonly k: "pump"; readonly limit: number }
  | { readonly k: "heartbeat" }
  | {
      readonly k: "deliver";
      readonly how: "next" | "second" | "repeat" | "drop" | "replay";
      readonly pick: number;
    }
  | { readonly k: "reconnect" }
  | { readonly k: "claim" }
  | { readonly k: "foreign" }
  | { readonly k: "rewind"; readonly back: number; readonly limit: number };

const n = fc.nat({ max: 50 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ op: fc.constant("add" as const), hidden: fc.boolean(), area: n }),
  },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("retitle" as const), task: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("retitle2" as const), task: n, other: n }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("complete" as const), task: n }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("reopen" as const), task: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("delete" as const), task: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("restore" as const), task: n }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("note" as const), task: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("launch" as const), task: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("move" as const), task: n, area: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("area" as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("rename_area" as const), area: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("delete_area" as const), area: n }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("project" as const), area: n }) },
);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 6, arbitrary: opArb.map((op) => ({ k: "op" as const, op })) },
  {
    weight: 4,
    arbitrary: fc.integer({ min: 1, max: 4 }).map((limit) => ({ k: "pump" as const, limit })),
  },
  { weight: 1, arbitrary: fc.constant({ k: "heartbeat" as const }) },
  {
    weight: 10,
    arbitrary: fc.record({
      k: fc.constant("deliver" as const),
      how: fc.constantFrom("next", "next", "next", "next", "second", "repeat", "drop", "replay"),
      pick: n,
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: "reconnect" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "claim" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "foreign" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("rewind" as const),
      back: fc.integer({ min: 1, max: 3 }),
      limit: fc.integer({ min: 1, max: 6 }),
    }),
  },
);

/** The core's rows as plain maps, to compare with the model's. */
function held(core: LiveCore) {
  const state = core.publish();
  if (state === undefined) return undefined;
  return {
    tasks: new Map(state.tasks),
    areas: new Map(state.areas),
    projects: new Map(state.projects),
  };
}

/** Runs one scripted world; returns what it saw, for the coverage checks. */
function run(actions: readonly Action[]): Record<Outcome["kind"] | "skipped_events", number> {
  const model = new FeedModel();
  for (let i = 0; i < 3; i += 1) model.apply({ op: "add", hidden: false, area: 0 });
  model.apply({ op: "area" });
  const core = new LiveCore(SPACE);
  let sub = new ModelSubscription(model);
  let net: Message[] = [];
  const seen: Message[] = [];
  const counts = { snapshot: 0, applied: 0, ignored: 0, resnapshot: 0, skipped_events: 0 };

  const subscribe = () => {
    sub = new ModelSubscription(model);
    net.push(...sub.subscribe(core.resumeFrom));
  };

  const check = () => {
    const cursor = core.cursor;
    if (cursor === undefined) return;
    if (core.awaiting) return;
    expect(model.hadCursor(cursor)).toBe(true);
    const visible = model.visibleAt(cursor.seq);
    expect(held(core)).toEqual(visible);
  };

  const receive = (message: Message) => {
    seen.push(message);
    const before = core.cursor?.seq;
    const outcome = core.receive(message);
    counts[outcome.kind] += 1;
    // Each commit is reported once: an applied batch names only the commits past the old cursor.
    if (outcome.kind === "applied" && message.type === "batch") {
      const fresh = message.events.filter((e) => e.seq > (before ?? 0)).map((e) => e.request_id);
      expect(outcome.requests).toEqual(fresh);
    }
    if (
      outcome.kind === "applied" &&
      message.type === "batch" &&
      before !== undefined &&
      message.from < before
    ) {
      counts.skipped_events += 1;
    }
    // The core asked for a fresh snapshot: the client subscribes again without a cursor.
    if (outcome.kind === "resnapshot") {
      expect(core.awaiting).toBe(true);
      expect(core.resumeFrom).toBeUndefined();
      subscribe();
    }
    check();
  };

  subscribe();
  for (const action of actions) {
    switch (action.k) {
      case "op":
        model.apply(action.op);
        break;
      case "pump":
        net.push(...sub.pump(action.limit));
        break;
      case "heartbeat":
        net.push(...sub.heartbeat());
        break;
      case "claim":
        model.claim();
        break;
      case "reconnect":
        // The socket drops: what was in flight is lost; the new one resumes from the cursor.
        net = [];
        subscribe();
        break;
      case "rewind":
        // A batch that starts behind what was sent: its first events are repeats.
        net.push(...sub.rewind(action.back, action.limit));
        break;
      case "foreign": {
        // Another space's messages at this space's cursor, with a task this space never had.
        const cursor = sub.cursor ?? model.head;
        const stranger = { ...STRANGER, version: cursor.seq + 1 };
        const event = {
          seq: cursor.seq + 1,
          request_id: "other-space",
          actor: { kind: "agent", label: "Codex" },
          kind: "add",
          entities: [{ type: "task", id: STRANGER.id, row: stranger, changed: [], created: true }],
        };
        net.push({
          type: "batch",
          space_id: OTHER_SPACE,
          epoch: cursor.epoch,
          incarnation: cursor.incarnation,
          from: cursor.seq,
          through: cursor.seq + 1,
          events: [event],
        });
        net.push({
          ...model.snapshot(),
          space: { id: OTHER_SPACE, name: "Other", ref_prefix: "O" },
          tasks: [stranger],
        });
        break;
      }
      case "deliver": {
        if (action.how === "replay") {
          const old = seen[action.pick % Math.max(1, seen.length)];
          if (old !== undefined) receive(old);
          break;
        }
        const first = net[0];
        if (first === undefined) break;
        if (action.how === "drop") {
          net.shift();
        } else if (action.how === "repeat") {
          receive(first);
        } else if (action.how === "second" && net.length > 1) {
          const [second] = net.splice(1, 1);
          if (second !== undefined) receive(second);
        } else {
          net.shift();
          receive(first);
        }
        break;
      }
    }
  }

  // Then an orderly network. A real socket that lost a message is a socket that closed: the tab
  // reconnects and resumes from its cursor (or takes a snapshot). Everything then arrives in
  // order, the pump runs dry, and the core holds the head.
  net = [];
  subscribe();
  for (let rounds = 0; rounds < 1_000; rounds += 1) {
    const next = net.shift();
    if (next !== undefined) {
      receive(next);
      continue;
    }
    const more = sub.pump(1 + (rounds % 4));
    if (more.length === 0) break;
    net.push(...more);
  }
  expect(core.awaiting).toBe(false);
  expect(core.cursor).toEqual(model.head);
  expect(held(core)).toEqual(model.visibleAt(model.seq));
  return counts;
}

describe("[A5.3.15.web.store.interleavings] the live store's core against a model of the feed", () => {
  test("any interleaving applied in order equals the snapshot at that point, or asks for one", () => {
    const totals = { snapshot: 0, applied: 0, ignored: 0, resnapshot: 0, skipped_events: 0 };
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 200, size: "max" }), (actions) => {
        const counts = run(actions);
        for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += counts[k];
      }),
      { numRuns: 400 },
    );
    // The runs reached every path: batches applied, repeats and old messages ignored, overlaps
    // skipped in part, fresh snapshots asked for and taken.
    for (const count of Object.values(totals)) expect(count).toBeGreaterThan(0);
  });

  test("an orderly feed never needs a fresh snapshot beyond its withheld rows", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 80, size: "max" }),
        fc.integer({ min: 1, max: 100 }),
        (ops, limit) => {
          const model = new FeedModel();
          const core = new LiveCore(SPACE);
          const sub = new ModelSubscription(model);
          for (const m of sub.subscribe(undefined)) core.receive(m);
          for (const op of ops) {
            model.apply(op);
            // The service pumps after every write: one commit per batch, nothing withheld.
            for (const m of sub.pump(limit)) {
              expect(core.receive(m).kind).toBe("applied");
            }
          }
          expect(held(core)).toEqual(model.visibleAt(model.seq));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("[A5.while-away.web.asking] the page holds every finished task a question waits on", () => {
  test("from the snapshot and the batches after it: a row with questions outside the open set joins, one without them or deleted leaves, an open one stays with the open tasks", () => {
    const task = (id: string, patch: Record<string, unknown> = {}) => ({
      id,
      ref: `M-${id.slice(-1)}`,
      title: "Fixture",
      lifecycle: "completed",
      status: "open",
      inbox: false,
      position: "a",
      created_at: 0,
      version: 1,
      ...patch,
    });
    const questions = [{ ref: "l1", by: "Codex", text: "Fixture which?", at: 1 }];
    const [a, b, c] = [
      "t_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      "t_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      "t_cccccccccccccccccccccccccc",
    ];
    const core = new LiveCore();
    core.receive({
      type: "snapshot",
      space: { id: SPACE, name: "Mira", ref_prefix: "M" },
      cursor: { epoch: 1, incarnation: "i", seq: 10 },
      tasks: [task(c, { lifecycle: "active", questions })],
      asking: [task(a, { questions })],
      areas: [],
      projects: [],
      instances: [],
    } as unknown as SnapshotMessage);
    const asking = () => [...(core.publish()?.asking.keys() ?? [])].sort();
    expect(asking()).toEqual([a]);
    const batch = (seq: number, row: Record<string, unknown>): BatchMessage => ({
      type: "batch",
      space_id: SPACE,
      epoch: 1,
      incarnation: "i",
      from: seq - 1,
      through: seq,
      events: [
        {
          seq,
          request_id: "",
          actor: { kind: "agent", label: "Codex" },
          kind: "log.add",
          entities: [{ type: "task", id: String(row["id"]), row, changed: [], created: false }],
        },
      ],
    });
    // A question on a dropped task the page did not hold.
    core.receive(batch(11, task(b, { lifecycle: "archived", questions })));
    expect(asking()).toEqual([a, b]);
    // Dismissed; and deleted.
    core.receive(batch(12, task(a)));
    core.receive(batch(13, task(b, { lifecycle: "archived", questions, deleted_at: 5 })));
    expect(asking()).toEqual([]);
    // Reopened with its question: it is an open task again.
    core.receive(batch(14, task(b, { lifecycle: "active", questions })));
    expect(asking()).toEqual([]);
    expect(core.publish()?.tasks.has(b)).toBe(true);
  });
});
