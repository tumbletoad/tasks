// The live store above its core (A5 3.15 items 3 and 4): per-frame batching with a fake frame
// clock, and own writes that only the feed confirms.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { FakeFrames } from "../../test/fake-frames.ts";
import { FeedModel, ModelSubscription, SPACE, type Op } from "../../test/feed-model.ts";
import { LiveCore } from "./core.ts";
import { FrameQueue, type FrameClock } from "./frame.ts";
import type { BatchMessage, SnapshotMessage, TaskRow } from "./rows.ts";
import { LiveStore } from "./store.ts";

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("add" as const), hidden: fc.constant(false), area: fc.nat(9) }),
  fc.record({ op: fc.constant("retitle" as const), task: fc.nat(20) }),
  fc.record({ op: fc.constant("complete" as const), task: fc.nat(20) }),
  fc.record({ op: fc.constant("reopen" as const), task: fc.nat(20) }),
  fc.record({ op: fc.constant("note" as const), task: fc.nat(20) }),
  fc.record({ op: fc.constant("area" as const) }),
);

function newStore(frames: FrameClock, asked: string[] = []) {
  return new LiveStore({
    space: SPACE,
    frames,
    onResnapshot: (reason) => asked.push(reason),
    newRequest: (() => {
      let n = 0;
      return () => `own-${String((n += 1))}`;
    })(),
  });
}

/** A space of three open tasks at seq 3. */
function seeded() {
  const model = new FeedModel();
  for (let i = 0; i < 3; i += 1) model.apply({ op: "add", hidden: false, area: 0 });
  const sub = new ModelSubscription(model);
  const [snapshot] = sub.subscribe(undefined) as [SnapshotMessage];
  return { model, sub, snapshot };
}

const ids = (store: LiveStore) => [...store.getState().tasks.keys()];
const title = (store: LiveStore, id: string) => store.getState().tasks.get(id)?.title;

/** A batch of one commit that sets a task's title, with the request ID of the write it was. */
function titled(from: number, row: TaskRow, text: string, request: string): BatchMessage {
  return {
    type: "batch",
    space_id: SPACE,
    epoch: 1,
    incarnation: "ai_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    from,
    through: from + 1,
    events: [
      {
        seq: from + 1,
        request_id: request,
        actor: { kind: "user", label: "" },
        kind: "ops",
        entities: [
          {
            type: "task",
            id: row.id,
            row: { ...row, title: text, version: from + 1 },
            changed: ["title"],
            created: false,
          },
        ],
      },
    ],
  };
}

const asOf = (seq: number) => ({ as_of: `1.${String(seq)}.aaaaaaaa` });

describe("[A5.3.15.web.store.frames] per-frame batching", () => {
  test("messages apply once per frame, all of them and in arrival order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(opArb, fc.integer({ min: 1, max: 3 }), fc.boolean()), {
          maxLength: 60,
          size: "max",
        }),
        (steps) => {
          const { model, sub, snapshot } = seeded();
          const frames = new FakeFrames();
          const store = newStore(frames);
          const reference = new LiveCore(SPACE);
          let emits = 0;
          let frameCount = 0;
          store.subscribe(() => {
            emits += 1;
          });
          const deliver = (message: SnapshotMessage | BatchMessage) => {
            store.push(message);
            reference.receive(message);
          };
          deliver(snapshot);
          for (const [op, limit, frameNow] of steps) {
            model.apply(op);
            for (const m of sub.pump(limit)) deliver(m);
            // Nothing applies between frames: the state is the one the last frame made.
            if (frameNow && frames.asked > 0) {
              frames.frame();
              frameCount += 1;
            }
          }
          if (frames.asked > 0) {
            frames.frame();
            frameCount += 1;
          }
          // Every message applied, in order: the same rows as applying them one by one.
          const want = reference.publish();
          expect(store.getState().tasks).toEqual(want?.tasks);
          expect(store.getState().areas).toEqual(want?.areas);
          // One render per frame at most.
          expect(emits).toBeLessThanOrEqual(frameCount);
          expect(frames.asked).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("a burst waits for its frame; a reconnect applies what is queued before it resumes", () => {
    const { model, sub, snapshot } = seeded();
    const frames = new FakeFrames();
    const store = newStore(frames);
    let emits = 0;
    store.subscribe(() => {
      emits += 1;
    });
    store.push(snapshot);
    expect(store.getState().tasks.size).toBe(0);
    frames.frame();
    expect(emits).toBe(1);
    expect(store.getState().phase).toBe("live");
    for (let i = 0; i < 5; i += 1) {
      model.apply({ op: "retitle", task: i });
      for (const m of sub.pump(1)) store.push(m);
    }
    // One frame was asked for the whole burst, and nothing applied before it.
    expect(frames.asked).toBe(1);
    expect(emits).toBe(1);
    // The socket drops and comes back: the cursor it resumes from includes the queued batches.
    expect(store.resumeFrom()).toEqual(model.head);
    expect(emits).toBe(2);
    expect(frames.asked).toBe(0);
  });

  test("a gap asks for a fresh snapshot once, and batches wait for it", () => {
    const { model, sub, snapshot } = seeded();
    const frames = new FakeFrames();
    const asked: string[] = [];
    const store = newStore(frames, asked);
    store.push(snapshot);
    model.apply({ op: "retitle", task: 0 });
    model.apply({ op: "retitle", task: 1 });
    const [lost, next] = [...sub.pump(1), ...sub.pump(1)] as BatchMessage[];
    expect(lost?.through).toBe(4);
    if (next === undefined) throw new Error("no batch");
    store.push(next);
    store.push(next);
    frames.frame();
    expect(asked).toEqual(["gap"]);
    expect(store.resumeFrom()).toBeUndefined();
    // The rows stay on screen until the snapshot replaces them.
    expect(ids(store)).toHaveLength(3);
    store.push(model.snapshot());
    frames.frame();
    expect(store.resumeFrom()).toEqual(model.head);
  });
});

describe("[A5.3.15.web.store.own-writes] own writes", () => {
  function live() {
    const { model, snapshot } = seeded();
    const frames = new FakeFrames();
    const store = newStore(frames);
    store.push(snapshot);
    frames.frame();
    const [id] = ids(store);
    const row = id === undefined ? undefined : store.getState().tasks.get(id);
    if (id === undefined || row === undefined) throw new Error("no task");
    return { model, frames, store, id, row };
  }

  test("an overlay shows at once and stays after the answer, until its event arrives", async () => {
    const { frames, store, id, row } = live();
    let answer!: (value: unknown) => void;
    const sent = store.write(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      { tasks: [{ id, set: { title: "Mine" } }] },
    );
    expect(title(store, id)).toBe("Mine");
    // Someone else's commit is 4, this write's is 5.
    answer(asOf(5));
    await sent.answer;
    // The HTTP answer alone confirms nothing: the overlay stays.
    expect(title(store, id)).toBe("Mine");
    expect(store.pending).toBe(1);
    // Someone else's change to the row comes first: the overlay stays on top of it.
    store.push(titled(3, row, "Theirs", "someone-else"));
    frames.frame();
    expect(title(store, id)).toBe("Mine");
    // The write's own event: the confirmed row holds it, the overlay goes.
    store.push(titled(4, { ...row, title: "Theirs" }, "Mine", sent.request));
    frames.frame();
    expect(await sent.settled).toBe("confirmed");
    expect(store.pending).toBe(0);
    expect(title(store, id)).toBe("Mine");
  });

  test("a write that made no commit settles when the feed reaches its as_of, a snapshot too", async () => {
    const { model, frames, store, id } = live();
    const sent = store.write(() => Promise.resolve(asOf(5)), {
      tasks: [{ id, set: { status: "waiting" } }],
    });
    await sent.answer;
    expect(store.getState().tasks.get(id)?.status).toBe("waiting");
    // A heartbeat at 3 is not far enough; then a snapshot at 5 covers it.
    store.push({
      ...titled(3, store.getState().tasks.get(id) as TaskRow, "x", "r"),
      through: 3,
      events: [],
    });
    frames.frame();
    expect(store.pending).toBe(1);
    model.apply({ op: "retitle", task: 2 });
    model.apply({ op: "retitle", task: 2 });
    store.push(model.snapshot());
    frames.frame();
    expect(await sent.settled).toBe("confirmed");
    expect(store.getState().tasks.get(id)?.status).toBe("open");
  });

  test("a write whose authority another claim replaced at the same epoch settles", async () => {
    const { model, frames, store, id } = live();
    const sent = store.write(() => Promise.resolve(asOf(5)), {
      tasks: [{ id, set: { status: "waiting" } }],
    });
    await sent.answer;
    expect(store.pending).toBe(1);
    // A second claim of one backup: the same epoch, another incarnation, its seqs reused.
    store.push({
      ...model.snapshot(),
      cursor: { epoch: 1, incarnation: "ai_bbbbbbbbbbbbbbbbbbbbbbbbbb", seq: 2 },
    });
    frames.frame();
    expect(await sent.settled).toBe("confirmed");
    expect(store.pending).toBe(0);
    expect(store.getState().tasks.get(id)?.status).toBe("open");
  });

  test("a write answered by an authority the feed has not reached yet waits for it", async () => {
    const { model, frames, store, id } = live();
    const newer = "ai_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const sent = store.write(() => Promise.resolve({ as_of: "1.5.bbbbbbbb" }), {
      tasks: [{ id, set: { status: "waiting" } }],
    });
    await sent.answer;
    // A heartbeat of the old authority: the write's is still ahead.
    store.push({
      ...titled(3, store.getState().tasks.get(id) as TaskRow, "x", "r"),
      through: 3,
      events: [],
    });
    frames.frame();
    expect(store.pending).toBe(1);
    expect(store.getState().tasks.get(id)?.status).toBe("waiting");
    // The feed reaches the new authority at the write's seq.
    store.push({ ...model.snapshot(), cursor: { epoch: 1, incarnation: newer, seq: 5 } });
    frames.frame();
    expect(await sent.settled).toBe("confirmed");
  });

  test("a write that landed in an authority the tab already left settles on its answer", async () => {
    const { model, frames, store, id } = live();
    let answer!: (value: unknown) => void;
    const sent = store.write(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      { tasks: [{ id, set: { status: "waiting" } }] },
    );
    store.push({
      ...model.snapshot(),
      cursor: { epoch: 1, incarnation: "ai_bbbbbbbbbbbbbbbbbbbbbbbbbb", seq: 2 },
    });
    frames.frame();
    expect(store.pending).toBe(1);
    // The answer names the old authority, which the feed has already left behind.
    answer(asOf(5));
    await sent.answer;
    expect(await sent.settled).toBe("confirmed");
    expect(store.pending).toBe(0);
  });

  test("a refused write leaves nothing behind", async () => {
    const { store, id, row } = live();
    const before = store.getState().tasks;
    const sent = store.write(() => Promise.reject(new Error("refused")), {
      tasks: [{ id, remove: true }],
    });
    expect(store.getState().tasks.has(id)).toBe(false);
    await expect(sent.answer).rejects.toThrow("refused");
    expect(await sent.settled).toBe("refused");
    expect(store.pending).toBe(0);
    expect(store.getState().tasks).toEqual(before);
    expect(store.getState().tasks.get(id)).toEqual(row);
  });

  test("an event before the answer confirms the write; the late answer changes nothing", async () => {
    const { frames, store, id, row } = live();
    let answer!: (value: unknown) => void;
    const sent = store.write(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      { tasks: [{ id, set: { title: "Mine" } }] },
    );
    store.push(titled(3, row, "Mine", sent.request));
    frames.frame();
    expect(await sent.settled).toBe("confirmed");
    answer(asOf(4));
    await sent.answer;
    expect(store.pending).toBe(0);
    expect(title(store, id)).toBe("Mine");
  });

  test("whatever the order of answers, events and refusals, no overlay outlives its write", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            task: fc.nat(2),
            outcome: fc.constantFrom("commit", "noop", "refuse"),
            eventFirst: fc.boolean(),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (writes) => {
          const { frames, store } = live();
          const confirmed = () => store.getState().tasks;
          let seq = 3;
          const all = [];
          for (const [i, w] of writes.entries()) {
            const id = ids(store)[w.task] ?? "";
            const row = store.getState().tasks.get(id);
            let settle!: (value: unknown) => void;
            let refuse!: (error: Error) => void;
            const sent = store.write(
              () =>
                new Promise((resolve, reject) => {
                  settle = resolve;
                  refuse = reject;
                }),
              { tasks: [{ id, set: { title: `Pending ${String(i)}` } }] },
            );
            expect(title(store, id)).toBe(`Pending ${String(i)}`);
            const event = () => {
              if (row === undefined) return;
              store.push(titled(seq, row, `Done ${String(i)}`, sent.request));
              seq += 1;
              frames.frame();
            };
            if (w.outcome === "refuse") {
              refuse(new Error("refused"));
            } else if (w.outcome === "noop") {
              settle(asOf(seq));
            } else if (w.eventFirst) {
              event();
              settle(asOf(seq));
            } else {
              settle(asOf(seq + 1));
              await Promise.resolve();
              event();
            }
            all.push(sent.answer.catch(() => undefined));
          }
          await Promise.all(all);
          expect(store.pending).toBe(0);
          // With nothing pending, the tasks the views see are the confirmed rows themselves.
          for (const row of confirmed().values()) expect(row.title).not.toMatch(/^Pending/);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("[A5.3.15.web.store.frames] the frame queue", () => {
  test("a message that arrives while a frame drains waits for the next frame", () => {
    const frames = new FakeFrames();
    const seen: number[][] = [];
    const queue: FrameQueue<number> = new FrameQueue(frames, (items) => {
      seen.push([...items]);
      if (items.includes(2)) queue.push(3);
    });
    queue.push(1);
    queue.push(2);
    frames.frame();
    expect(seen).toEqual([[1, 2]]);
    frames.frame();
    expect(seen).toEqual([[1, 2], [3]]);
    queue.push(4);
    queue.clear();
    frames.frame();
    expect(seen).toEqual([[1, 2], [3]]);
  });
});
