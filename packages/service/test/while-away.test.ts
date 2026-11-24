// What the page's snapshot tells a person who comes back: the tasks agents changed in the last
// seven days, newest first, with who changed each last and when, and on a task's row the
// question an agent asked that still waits for the person. Against a real space in this thread,
// with the writer's clock set per request. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError } from "@ttasks/contracts";
import {
  newId,
  type Credential,
  type Id,
  type Operation,
  type ReceiptLookup,
  type SpaceWriterHandle,
  type WriteRequest,
} from "@ttasks/storage";
import { MACHINE, writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { readBatch, readSnapshot } from "../src/http/feed.ts";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { readReplied } from "../src/ops/read.ts";
import { runBrief, WORK_ON_IT } from "../src/runs/agent.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
const DAY = 86_400_000;
/** A week after the fixture's own writes: the writer's commit times only move forward. */
const START = Date.now() + 7 * DAY;
let clock = START;

beforeAll(async () => {
  temp = tempRoot("while-away");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder, { flush: false });
  fx.reopen({ now: () => clock });
}, 60_000);

afterAll(() => {
  fx.close();
  temp.cleanup();
});

/** The service's request path over the fixture's writer, at the writer's clock. */
const host = (): OpsHost => ({
  machine: { id: MACHINE.id },
  spaces: () => [
    {
      id: fx.spaceId,
      name: "Mira",
      state: "open",
      writer: {
        spaceId: fx.spaceId,
        submit: (request: WriteRequest) => Promise.resolve(fx.writer.submit(request)),
        receipt: (lookup: ReceiptLookup) => Promise.resolve(fx.writer.receipt(lookup)),
        actor: (kind: "human" | "agent", label: string) =>
          Promise.resolve(fx.writer.actor(kind, label)),
      } as unknown as SpaceWriterHandle,
      reader: readerOf(fx.reader),
    },
  ],
  now: () => clock,
  timeZone: () => "Europe/Lisbon",
});
const PERSON: Caller = { class: "cli-interactive", env: {} };
let n = 0;
const rid = () => `fixture-away-${String((n += 1)).padStart(6, "0")}`;
const call = (op: string, input: Record<string, unknown>) =>
  opCall(host(), PERSON, { op, input }) as Promise<Record<string, unknown>>;

/** `ops` as `actor` at `at`; the person's change goes on their undo stack, and an undo has no base. */
function submit(actor: Credential, ops: Operation[], at: number): void {
  clock = at;
  const undo = ops.some((op) => op.kind === "undo");
  const own = actor === fx.human && !undo ? { undoable: true } : {};
  const result = fx.writer.submit(fx.request(actor, ops, undo ? {} : { base: fx.base(), ...own }));
  if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
}

describe("[A5.while-away.service.recent] a snapshot holds the tasks agents changed lately", () => {
  test("newest first, each with its last agent and when; not the person's own, a deleted one or one older than a week", async () => {
    const [mine, logged, finished, old, deleted] = [
      newId("t"),
      newId("t"),
      newId("t"),
      newId("t"),
      newId("t"),
    ];
    const create = (id: Id<"t">, title: string): Operation => ({
      kind: "task.create",
      id,
      title,
      area: fx.areas.home,
    });
    submit(
      fx.human,
      [
        create(mine, "Fixture mine"),
        create(logged, "Fixture logged"),
        create(old, "Fixture old"),
        create(deleted, "Fixture deleted"),
      ],
      START,
    );
    submit(fx.codex, [{ kind: "log.add", task: old, body: "Fixture early" }], START + DAY);
    const now = START + 10 * DAY;
    submit(fx.codex, [{ kind: "log.add", task: logged, body: "Fixture one" }], now - 3 * DAY);
    submit(fx.claude, [create(finished, "Fixture finished")], now - 2 * DAY);
    submit(fx.codex, [{ kind: "log.add", task: deleted, body: "Fixture two" }], now - 2 * DAY);
    submit(fx.human, [{ kind: "task.delete", task: deleted }], now - 2 * DAY);
    submit(fx.claude, [{ kind: "task.complete", task: finished }], now - DAY);
    // The person's later change leaves the agent's in place.
    submit(fx.human, [{ kind: "task.patch", task: logged, set: { priority: 1 } }], now - DAY);
    submit(fx.human, [{ kind: "task.patch", task: mine, set: { priority: 2 } }], now);

    const snapshot = await readSnapshot(readerOf(fx.reader), undefined, now);
    expect(snapshot.agent_changes.map(({ task, actor, at }) => ({ task, actor, at }))).toEqual([
      { task: finished, actor: "Claude Code · work", at: now - DAY },
      { task: logged, actor: "Codex · work", at: now - 3 * DAY },
    ]);
    // The finished task is in no open row: its change brings its row.
    expect(snapshot.agent_changes[0]?.row).toMatchObject({ id: finished, lifecycle: "completed" });
    expect(snapshot.agent_changes[1]?.row).toBeUndefined();
    // Read a week later, nothing is that recent.
    expect(
      (await readSnapshot(readerOf(fx.reader), undefined, now + 8 * DAY)).agent_changes,
    ).toEqual([]);
  });
});

describe("[A5.while-away.service.question] the questions agents asked wait on their task's row", () => {
  /** A fresh task of the person's, with what its row says now. */
  function asking() {
    const task = newId("t");
    const next = () => (clock += 60_000);
    submit(
      fx.human,
      [{ kind: "task.create", id: task, title: "Fixture asks", area: fx.areas.home }],
      next(),
    );
    const row = async () =>
      (await readSnapshot(readerOf(fx.reader), undefined, clock)).tasks.find(
        (t) => t["id"] === task,
      );
    return {
      task,
      next,
      ask: (actor: Credential, body: string) => {
        submit(actor, [{ kind: "log.add", task, body, log_kind: "question" }], next());
      },
      row,
      refs: async () =>
        (((await row())?.["questions"] ?? []) as readonly { ref: string }[]).map((q) => q.ref),
    };
  }

  test("each waits, newest first, until the person's note after it: not the person's own question, nor one an agent's note follows", async () => {
    const { task, ask, row, refs, next } = asking();
    ask(fx.human, "Fixture mine?");
    submit(fx.codex, [{ kind: "log.add", task, body: "Fixture progress" }], next());
    expect(await row()).not.toHaveProperty("questions");

    const head = (await readSnapshot(readerOf(fx.reader), undefined, clock)).cursor.seq;
    ask(fx.codex, "Fixture which one?");
    const asked = clock;
    ask(fx.claude, "Fixture and which day?");
    expect((await row())?.["questions"]).toEqual([
      { ref: "l4", by: "Claude Code · work", text: "Fixture and which day?", at: clock },
      { ref: "l3", by: "Codex · work", text: "Fixture which one?", at: asked },
    ]);
    // The batch of a question carries the task's row with it.
    const { batch } = await readBatch(readerOf(fx.reader), head);
    const carried = batch.events.at(-1)?.entities.find((e) => e.type === "task" && e.id === task);
    expect(carried?.row?.["questions"]).toHaveLength(2);

    submit(fx.claude, [{ kind: "note.add", task, body: "Fixture agent note" }], next());
    expect(await refs()).toEqual(["l4", "l3"]);
    // The person's note answers every question before it, and none after it.
    submit(fx.human, [{ kind: "note.add", task, body: "Fixture answer" }], next());
    expect(await row()).not.toHaveProperty("questions");
    ask(fx.codex, "Fixture and now?");
    expect(await refs()).toEqual(["l5"]);
  });

  test("[A3.note.retract.question] a note the person takes back answers nothing: the question waits again, and put back it is answered", async () => {
    const { task, ask, refs, next } = asking();
    ask(fx.codex, "Fixture which one?");
    submit(fx.human, [{ kind: "note.add", task, body: "Fixture answer" }], next());
    expect(await refs()).toEqual([]);
    submit(fx.human, [{ kind: "note.delete", task, ordinal: 1 }], next());
    expect(await refs()).toEqual(["l1"]);
    submit(fx.human, [{ kind: "note.restore", task, ordinal: 1 }], next());
    expect(await refs()).toEqual([]);
  });

  test("Dismiss sets aside the question it names and those before it; one asked after it still waits, an Undo brings them back, and the answer names the field", async () => {
    const { task, ask, refs } = asking();
    ask(fx.codex, "Fixture first?");
    ask(fx.codex, "Fixture second?");
    // The person saw l1; l2 arrived before their Dismiss did.
    const dismissed = await call("task.update", {
      task,
      set: { reviewed: "l1" },
      request_id: rid(),
    });
    expect(dismissed).toMatchObject({ result: "updated", fields: ["reviewed"] });
    expect(await refs()).toEqual(["l2"]);
    // A stale Dismiss of l1 from another tab takes nothing back.
    await call("task.update", { task, set: { reviewed: "l1" }, request_id: rid() });
    expect(await refs()).toEqual(["l2"]);
    await call("task.update", { task, set: { reviewed: "l2" }, request_id: rid() });
    expect(await refs()).toEqual([]);
    await call("history.undo", { request_id: rid() });
    expect(await refs()).toEqual(["l2"]);
    // An entry that is no question of the task is refused and changes nothing.
    const refused: unknown = await call("task.update", {
      task,
      set: { reviewed: "l9" },
      request_id: rid(),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).toBody().code).toBe("invalid_input");
    expect(await refs()).toEqual(["l2"]);
  });

  test("a log reference names its question with leading zeros too", async () => {
    const { task, ask, refs } = asking();
    ask(fx.codex, "Fixture first?");
    ask(fx.codex, "Fixture second?");
    await expect(
      call("task.update", { task, set: { reviewed: "l01" }, request_id: rid() }),
    ).resolves.toMatchObject({ result: "updated", fields: ["reviewed"] });
    expect(await refs()).toEqual(["l2"]);
  });

  test("a question that arrived in the same millisecond after the one dismissed still waits", async () => {
    const { task, refs, next } = asking();
    submit(
      fx.codex,
      [{ kind: "log.add", task, body: "Fixture one?", log_kind: "question" }],
      next(),
    );
    submit(
      fx.claude,
      [{ kind: "log.add", task, body: "Fixture two?", log_kind: "question" }],
      clock,
    );
    await call("task.update", { task, set: { reviewed: "l1" }, request_id: rid() });
    expect(await refs()).toEqual(["l2", "l1"]);
    await call("task.update", { task, set: { reviewed: "l2" }, request_id: rid() });
    expect(await refs()).toEqual([]);
  });

  test("a question asked after a Dismiss waits even when the clock has not moved since the one dismissed", async () => {
    const { task, refs, next } = asking();
    submit(
      fx.codex,
      [{ kind: "log.add", task, body: "Fixture one?", log_kind: "question" }],
      next(),
    );
    await call("task.update", { task, set: { reviewed: "l1" }, request_id: rid() });
    expect(await refs()).toEqual([]);
    submit(
      fx.claude,
      [{ kind: "log.add", task, body: "Fixture two?", log_kind: "question" }],
      clock,
    );
    expect(await refs()).toEqual(["l2"]);
  });

  test("a Dismiss sent together with another field keeps that field's own check against a newer value", async () => {
    const { task, ask, refs } = asking();
    ask(fx.codex, "Fixture which?");
    const alone = async (set: Record<string, unknown>) =>
      call("task.update", { task, set, request_id: rid() }).then(
        () => "updated",
        (e: unknown) => (e as AppError).toBody().code,
      );
    // Whatever a title sent without a base answers, the same title with a Dismiss answers too.
    const title = await alone({ title: "Fixture renamed without a base" });
    const both = await alone({ title: "Fixture renamed again", reviewed: "l1" });
    expect(both).toBe(title);
    if (both !== "updated") expect(await refs()).toEqual(["l1"]);
  });

  test("on a completed or dropped task they wait too: the snapshot brings its row, and Dismiss works there", async () => {
    for (const end of ["task.complete", "task.archive"] as const) {
      const { task, ask, next } = asking();
      ask(fx.codex, "Fixture after the end?");
      submit(fx.human, [{ kind: end, task }], next());
      // A month on, long out of the recent changes.
      const shown = async () =>
        (await readSnapshot(readerOf(fx.reader), undefined, clock + 30 * DAY)).asking.find(
          (r) => r["id"] === task,
        );
      expect((await shown())?.["questions"]).toMatchObject([{ ref: "l1" }]);
      ask(fx.claude, "Fixture still there?");
      expect((await shown())?.["questions"]).toMatchObject([{ ref: "l2" }, { ref: "l1" }]);
      await expect(
        call("task.update", { task, set: { reviewed: "l2" }, request_id: rid() }),
      ).resolves.toMatchObject({ result: "updated", fields: ["reviewed"] });
      expect(await shown()).toBeUndefined();
    }
  });

  test("a row carries ten, newest first, counts the rest, and cuts each at 300 characters", async () => {
    const { task, row, next } = asking();
    const long = `${"x".repeat(298)}\u{1F600}\u{1F600} and more`;
    submit(
      fx.codex,
      Array.from({ length: 12 }, (_, k): Operation => ({
        kind: "log.add",
        task,
        body: k === 11 ? long : `Fixture ${String(k)}?`,
        log_kind: "question",
      })),
      next(),
    );
    const read = await row();
    const questions = read?.["questions"] as readonly { ref: string; text: string }[];
    expect(questions.map((q) => q.ref)).toEqual(
      Array.from({ length: 10 }, (_, k) => `l${String(12 - k)}`),
    );
    expect(read?.["questions_more"]).toBe(2);
    expect(questions[0]?.text).toBe(`${"x".repeat(298)}…`);
  });
});

describe("[A5.while-away.service.run-question] a run that ended asking keeps its question on the task's row until it is answered", () => {
  const ui = (): Credential => ({ ...fx.human, scope_id: "ui:fixture", origin: "ui" });
  /** A run of `task` queued now, its ID. */
  function queue(task: Id<"t">, request = "Fixture request"): Id<"ru"> {
    clock += 60_000;
    const result = fx.writer.submit(
      fx.request(ui(), [
        {
          kind: "run.create",
          task,
          instance: "codex-work",
          adapter: "codex",
          place: null,
          request,
          brief_hash: "a1b2c3d4".repeat(8),
          permission: "full-access",
          limits: { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 },
        },
      ]),
    );
    if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
    return result.results[0]?.id as Id<"ru">;
  }
  function move(run: Id<"ru">, next: string, more: Record<string, unknown> = {}): void {
    clock += 60_000;
    const record = fx.writer.run(run);
    const result = fx.writer.submit(
      fx.request(ui(), [
        {
          kind: "run.transition",
          run,
          expect: record?.state,
          expect_version: record?.version ?? 0,
          next,
          ...more,
        } as Operation,
      ]),
    );
    if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
  }
  const QUESTION = "Fixture which draft?\n1. The short one\n2. The long one";
  function asks(run: Id<"ru">, text = QUESTION): void {
    move(run, "starting");
    move(run, "running");
    move(run, "failed", {
      reason: "needs_input",
      result: {
        ok: false,
        outcome: "needs_input",
        exit_code: 0,
        signal: null,
        native_id: null,
        text,
        error: null,
        usage: null,
        app_tools: null,
        declined: 0,
        permission_denials: 0,
        duration_ms: 1,
      },
    });
  }
  function task(): {
    task: Id<"t">;
    row: () => Promise<Readonly<Record<string, unknown>> | undefined>;
  } {
    const id = newId("t");
    submit(
      fx.human,
      [{ kind: "task.create", id, title: "Fixture runs", area: fx.areas.home }],
      (clock += 60_000),
    );
    return {
      task: id,
      row: async () =>
        (await readSnapshot(readerOf(fx.reader), undefined, clock)).tasks.find(
          (t) => t["id"] === id,
        ),
    };
  }

  test("a run queued before the question neither hides it while it works nor takes it along when it is stopped", async () => {
    const { task: id, row } = task();
    const first = queue(id);
    const second = queue(id);
    asks(first);
    const waiting = {
      questions: [{ ref: first, by: "codex-work", instance: "codex-work", text: QUESTION }],
    };
    expect(await row()).toMatchObject({ ...waiting, run: { id: second, state: "working" } });
    move(second, "cancelled");
    expect(await row()).toMatchObject({ ...waiting, run: { id: first, state: "needs_you" } });
    // A run the person queues after it carries the reply; one that never ran answers nothing.
    const reply = queue(id);
    expect(await row()).not.toHaveProperty("questions");
    expect(await row()).toMatchObject({ run: { id: reply, state: "working" } });
    move(reply, "cancelled");
    expect(await row()).toMatchObject({ ...waiting, run: { id: first, state: "needs_you" } });
    const ran = queue(id);
    move(ran, "starting");
    move(ran, "running");
    move(ran, "cancelling");
    move(ran, "cancelled");
    expect(await row()).not.toHaveProperty("questions");
    expect(await row()).not.toHaveProperty("run");
  });

  test("the person's note answers it, Dismiss sets it aside and Undo brings it back, on a finished task too", async () => {
    const { task: id, row } = task();
    const run = queue(id);
    asks(run);
    submit(fx.human, [{ kind: "note.add", task: id, body: "Fixture answer" }], (clock += 60_000));
    expect(await row()).not.toHaveProperty("questions");
    expect(await row()).not.toHaveProperty("run");

    const later = queue(id);
    asks(later);
    submit(fx.human, [{ kind: "task.complete", task: id }], (clock += 60_000));
    const asking = async () =>
      (await readSnapshot(readerOf(fx.reader), undefined, clock)).asking.find(
        (r) => r["id"] === id,
      );
    expect(await asking()).toMatchObject({ questions: [{ ref: later }] });
    await expect(
      call("task.update", { task: id, set: { reviewed: later }, request_id: rid() }),
    ).resolves.toMatchObject({ result: "updated", fields: ["reviewed"] });
    expect(await asking()).toBeUndefined();
    await call("history.undo", { request_id: rid() });
    expect(await asking()).toMatchObject({
      questions: [{ ref: later }],
      run: { id: later, state: "needs_you" },
    });
  });

  test("[A4.3.11.run.reply-brief] the run that carries the reply is given the question it answers, as the agent asked it, before the person's words", async () => {
    const { task: id } = task();
    const reader = readerOf(fx.reader);
    const before = queue(id);
    const first = queue(id);
    asks(first);
    // The brief the run starts with, as buildRun makes it from the run's record.
    const brief = async (run: Id<"ru">) => {
      const record = fx.writer.run(run);
      return runBrief(
        "M-1",
        "Fixture runs",
        record?.request ?? null,
        await readReplied(reader, run),
      );
    };
    const reply = queue(id, "The second one");
    const built = await brief(reply);
    expect(built).toContain(`\n~~~\n${QUESTION}\n~~~\n`);
    expect(built.indexOf(QUESTION)).toBeLessThan(built.indexOf("The second one"));
    expect(built.endsWith("\n\nThe second one")).toBe(true);
    // Built again, after a restart or once the question is answered, it is the same brief.
    move(reply, "starting");
    move(reply, "running");
    expect(await brief(reply)).toBe(built);
    // A run queued before the question, or after the reply that ran, replies to nothing.
    expect(await readReplied(reader, before)).toEqual([]);
    expect(await readReplied(reader, queue(id))).toEqual([]);
    // Nor does one after the person's note answered it.
    const again = queue(id);
    move(again, "cancelled");
    move(reply, "succeeded", {
      result: {
        ok: true,
        outcome: "success",
        exit_code: 0,
        signal: null,
        native_id: null,
        text: "Fixture done",
        error: null,
        usage: null,
        app_tools: null,
        declined: 0,
        permission_denials: 0,
        duration_ms: 1,
      },
    });
    const third = queue(id);
    asks(third);
    submit(fx.human, [{ kind: "note.add", task: id, body: "Fixture answer" }], (clock += 60_000));
    expect(await readReplied(reader, queue(id))).toEqual([]);
    // Run without words after a question: the agent hears the question, and to work on the task.
    const fourth = queue(id);
    asks(fourth);
    const plain = await brief(queue(id, WORK_ON_IT));
    expect(plain).toContain(QUESTION);
    expect(plain).not.toContain("The person's reply:");
    expect(plain.endsWith(`\n\n${WORK_ON_IT}`)).toBe(true);
  });

  test("[A4.3.11.run.reply-kept] a reply answers the questions that waited when it was queued, whatever changes before it starts", async () => {
    const { task: id } = task();
    const replied = (run: Id<"ru">) => readReplied(readerOf(fx.reader), run);
    const [one, two] = ["Fixture one?", "Fixture two?"];
    // One stays one: the person's retracted note is put back after the reply was queued.
    asks(queue(id), one);
    submit(fx.human, [{ kind: "note.add", task: id, body: "Fixture answer" }], (clock += 60_000));
    submit(fx.human, [{ kind: "note.delete", task: id, ordinal: 1 }], (clock += 60_000));
    const kept = queue(id, "Fixture the first");
    submit(fx.human, [{ kind: "note.restore", task: id, ordinal: 1 }], (clock += 60_000));
    expect(await replied(kept)).toEqual([one]);
    move(kept, "cancelled");
    // None stays none: a Dismiss undone after the reply was queued.
    const asked = queue(id);
    asks(asked, two);
    await call("task.update", { task: id, set: { reviewed: asked }, request_id: rid() });
    const none = queue(id, "Fixture go on");
    await call("history.undo", { request_id: rid() });
    expect(await replied(none)).toEqual([]);
    // None stays none: an earlier queued reply carried the question, and is cancelled.
    const later = queue(id, "Fixture also");
    move(none, "cancelled");
    expect(await replied(later)).toEqual([]);
    move(later, "cancelled");
    // Two stay two, oldest first, when they are dismissed after the reply was queued: the words
    // were written to them.
    const [a, b] = [queue(id), queue(id)];
    asks(a, "Fixture a?");
    asks(b, "Fixture b?");
    const both = queue(id, "Fixture both");
    await call("task.update", { task: id, set: { reviewed: b }, request_id: rid() });
    expect(await replied(both)).toEqual(["Fixture a?", "Fixture b?"]);
  });
});

describe("[A5.while-away.service.reads] a waiting question breaks no read of task rows", () => {
  test("the views' snapshot, Completed, search, status and a task's read, with one on an active, a completed and a dropped task", async () => {
    const next = () => (clock += 60_000);
    const [active, done, dropped] = [newId("t"), newId("t"), newId("t")];
    submit(
      fx.human,
      [active, done, dropped].map((id): Operation => ({
        kind: "task.create",
        id,
        title: "Fixture reads",
        area: fx.areas.home,
      })),
      next(),
    );
    for (const task of [active, done, dropped]) {
      submit(
        fx.codex,
        [{ kind: "log.add", task, body: "Fixture which way?", log_kind: "question" }],
        next(),
      );
    }
    // Checked off: Completed's first list.
    submit(fx.human, [{ kind: "task.complete", task: done }], next());
    submit(fx.human, [{ kind: "task.archive", task: dropped }], next());

    const snapshot = await readSnapshot(readerOf(fx.reader), undefined, clock);
    expect(snapshot.tasks.find((t) => t["id"] === active)?.["questions"]).toMatchObject([
      { text: "Fixture which way?" },
    ]);
    expect(snapshot.asking.map((r) => r["id"])).toEqual(expect.arrayContaining([done, dropped]));
    const completed = (await call("task.finished", { checked_off: true })) as {
      rows: Record<string, unknown>[];
    };
    const other = (await call("task.finished", { checked_off: false })) as {
      rows: Record<string, unknown>[];
    };
    expect(completed.rows.find((r) => r["id"] === done)?.["questions"]).toMatchObject([
      { text: "Fixture which way?" },
    ]);
    expect(other.rows.find((r) => r["id"] === dropped)?.["questions"]).toMatchObject([
      { text: "Fixture which way?" },
    ]);
    for (const scope of ["active", "finished", "all"]) {
      await expect(call("task.search", { q: "Fixture reads", scope })).resolves.toMatchObject({
        rows: expect.any(Array) as unknown,
      });
    }
    await expect(
      call("space.status", {
        include: ["today", "week", "review", "waiting", "inbox", "changes"],
      }),
    ).resolves.toMatchObject({ space: expect.any(Object) as unknown });
    for (const task of [active, done, dropped]) {
      await expect(call("task.get", { task })).resolves.toMatchObject({
        task: { id: task },
      });
    }
  });
});

describe("[A5.while-away.service.recent-limits] the recent read is what happened in the week", () => {
  test("a hundred tasks agents changed and the person then deleted take no place of the hundred still there", async () => {
    const at = (clock += DAY);
    const make = (count: number) => Array.from({ length: count }, () => newId("t"));
    const [kept, deleted] = [make(100), make(100)];
    submit(
      fx.human,
      [...kept, ...deleted].map((id): Operation => ({
        kind: "task.create",
        id,
        title: "Fixture many",
        area: fx.areas.home,
      })),
      at,
    );
    for (const list of [kept, deleted]) {
      submit(
        fx.codex,
        list.map((task): Operation => ({ kind: "log.add", task, body: "Fixture touched" })),
        (clock += 60_000),
      );
    }
    submit(
      fx.human,
      deleted.map((task): Operation => ({ kind: "task.delete", task })),
      (clock += 60_000),
    );
    const listed = (await readSnapshot(readerOf(fx.reader), undefined, clock)).agent_changes;
    expect(new Set(listed.map((c) => c.task))).toEqual(new Set(kept));
  });

  test("a change six days back is found behind tens of thousands of later commits", async () => {
    const task = newId("t");
    submit(
      fx.human,
      [{ kind: "task.create", id: task, title: "Fixture behind", area: fx.areas.home }],
      (clock += DAY),
    );
    submit(fx.codex, [{ kind: "log.add", task, body: "Fixture early" }], (clock += 60_000));
    const asked = clock;
    const busy = newId("t");
    submit(
      fx.human,
      [{ kind: "task.create", id: busy, title: "Fixture busy", area: fx.areas.home }],
      clock,
    );
    for (let k = 0; k < 25_000; k += 1) {
      submit(fx.human, [{ kind: "task.patch", task: busy, set: { priority: (k % 4) + 1 } }], clock);
    }
    const listed = (await readSnapshot(readerOf(fx.reader), undefined, asked + 6 * DAY))
      .agent_changes;
    expect(listed.find((c) => c.task === task)).toMatchObject({ at: asked });
  }, 120_000);
});
