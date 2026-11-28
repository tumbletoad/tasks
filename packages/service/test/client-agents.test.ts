// What agents did, on the phone (@ttasks/client), against the real service: the tasks an agent
// changed under Today's Changes, with who and when; the pages an agent changed; a question an agent
// left, which marks its task as needing the person; a task with a run, its badge and its runs read
// for its card; a page's change counted for its task; and all of it kept for when the computer is
// away. A run is made as the run host records one, without starting an agent. Fixture data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runLine, spaceSession, type Keep, type Saved, type SpaceView } from "@ttasks/client/link";
import { questionsWaiting } from "@ttasks/client/store";
import { agentPages, CHANGES_DAYS, CHANGES_LIMIT, todayOf } from "@ttasks/client/today";
import { localDate } from "@ttasks/contracts/day";
import { RUN_LIMITS } from "@ttasks/contracts/runs";
import { SpaceExecutionStore } from "@ttasks/launch";
import { memory, pairedPhone, phone, phoneWorld, until } from "./phone-link.ts";
import type { PhoneKey } from "./phone-client.ts";

let w: Awaited<ReturnType<typeof phoneWorld>>;

beforeAll(async () => {
  w = await phoneWorld("phone-agents");
}, 300_000);

afterAll(async () => {
  await w.end();
});

function started(key: PhoneKey, saved: Saved, keep: Keep = memory()) {
  const seen: { view?: SpaceView } = {};
  const live = spaceSession({
    connect: phone(key).connect,
    saved,
    keep,
    newId: randomUUID,
    report: (view) => {
      seen.view = view;
    },
    retryMs: 50,
    resendMs: 50,
    callMs: 2_000,
  });
  live.start();
  return { live, seen };
}

/** A page operation as the page calls it, in Mira; its result. */
const op = async (name: string, input: Record<string, unknown>) => {
  const done = await w.op(name, { ...input, request_id: randomUUID() });
  if (done.status !== 200) throw new Error(`${name}: ${String(done.status)}`);
  return done.result ?? {};
};

/** Mira's run records, written as the run host writes them, with no agent started. */
async function runs() {
  const service = w.world.service;
  const served = service.ops.spaces().find((space) => space.reader !== undefined);
  const writer = served?.writer;
  if (writer === undefined || served?.id === undefined) throw new Error("no space is open");
  const machine = service.ops.machine.id;
  const store = new SpaceExecutionStore({
    writer,
    spaceId: served.id,
    credential: {
      scope_id: `runs:${machine}`,
      principal_id: await writer.actor("human", "user"),
      actor_kind: "human",
      machine_id: machine,
      origin: "ui",
    },
  });
  return {
    /** A run queued on the task: its row says the run works. */
    queue: (task: string) =>
      store.createRun(
        {
          task,
          machine,
          instance: "fixture-runner",
          adapter: "codex",
          place: null,
          request: "Fixture request",
          briefHash: "0123456789abcdef".repeat(4),
          permission: "full-access",
          limits: RUN_LIMITS.task,
        },
        randomUUID(),
      ),
    /** The run ended on a question for the person. */
    asks: (run: { readonly id: string; readonly version: number }) =>
      store.transitionRun(run.id, { state: "queued", version: run.version }, "failed", {
        reason: "needs_input",
        result: {
          ok: false,
          outcome: "needs_input",
          exitCode: 0,
          signal: null,
          nativeId: null,
          text: "Fixture: which export did you mean?",
          error: null,
          usage: null,
          appTools: null,
          declined: 0,
          permissionDenials: 0,
          durationMs: 1,
        },
      }),
  };
}

const clock = () => {
  const now = Date.now();
  return { now, today: localDate(now, "UTC"), timeZone: "UTC", locale: "en" };
};

describe("[S5.phone.agents] what agents did, on the phone", () => {
  test(
    "an agent's change shows under Changes with who made it, its page under the pages agents changed, and both stay while the computer is away",
    { timeout: 180_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Agents");
      // In the Inbox: Changes takes no task a section above it (Focus, This week, Next) holds.
      const made = await w.op("task.add", {
        tasks: [{ title: "Fixture task an agent works on", inbox: true }],
        request_id: randomUUID(),
      });
      const ref = (made.result?.["tasks"] as { ref: string; id: string }[] | undefined)?.[0];
      if (ref === undefined) throw new Error("no task");
      const keep = memory();
      const s = started(key, saved, keep);
      await until(() => s.seen.view?.live === true && s.seen.view.tasks.has(ref.id));

      await w.asAgent("entry.add", {
        task: ref.ref,
        kind: "progress",
        text: "Fixture: looked into it.",
      });
      await w.asAgent("page.write", {
        action: "create",
        on: ref.ref,
        title: "Fixture page an agent wrote",
        brief: "What the agent found",
        body: "Fixture body.",
        why: "fixture",
      });

      await until(() => s.seen.view?.changes.some((c) => c.task === ref.id) === true);
      const change = s.seen.view?.changes.find((c) => c.task === ref.id);
      expect(change?.actor).not.toBe("user");
      const today = todayOf(s.seen.view?.tasks.values() ?? [], clock(), {
        changes: s.seen.view?.changes ?? [],
      });
      expect(
        today.sections.find((section) => section.key === "changes")?.tasks.map((t) => t.id),
      ).toContain(ref.id);
      await until(() =>
        agentPages(s.seen.view?.pages.values() ?? [], Date.now(), CHANGES_DAYS, CHANGES_LIMIT).some(
          (page) => page.title === "Fixture page an agent wrote",
        ),
      );

      // Without the computer, and after a restart of the app: what was last read.
      await w.stop();
      await until(() => s.seen.view?.link.kind === "offline");
      s.live.stop();
      const away = started(key, saved, keep);
      expect(away.seen.view?.live).toBe(false);
      expect(away.seen.view?.changes.map((c) => c.task)).toContain(ref.id);
      expect([...(away.seen.view?.pages.values() ?? [])].map((p) => p.title)).toContain(
        "Fixture page an agent wrote",
      );
      away.live.stop();
      await w.restart();
    },
  );

  test(
    "a question an agent left marks its task as waiting for the person",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Asked");
      const task = await w.added("Fixture task with a question");
      const s = started(key, saved);
      await until(() => s.seen.view?.tasks.has(task.id) === true);
      expect(questionsWaiting(s.seen.view?.tasks.get(task.id) ?? ({} as never))).toBe(0);
      await w.asAgent("entry.add", {
        task: task.ref,
        kind: "question",
        text: "Fixture: which export did you mean?",
      });
      await until(() => {
        const row = s.seen.view?.tasks.get(task.id);
        return row !== undefined && questionsWaiting(row) > 0;
      });
      expect(s.seen.view?.tasks.get(task.id)?.questions?.[0]?.text).toBe(
        "Fixture: which export did you mean?",
      );
      // Finished with the question open, it leaves Today and still waits for the person.
      const base = (await w.op("task.get", { task: task.ref })).result?.["as_of"];
      await op("task.finish", { task: task.ref, base });
      await until(() => s.seen.view?.tasks.has(task.id) === false);
      await until(() => s.seen.view?.asking.has(task.id) === true);
      s.live.stop();
    },
  );

  test(
    "an agent that changes only a task's page puts the task under Changes and moves its row, so its open card reads again; a move moves both tasks",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Pages");
      const made = await w.op("task.add", {
        tasks: [
          { title: "Fixture task whose page an agent edits", inbox: true },
          { title: "Fixture task a page moves to", inbox: true },
        ],
        request_id: randomUUID(),
      });
      const [first, second] = (made.result?.["tasks"] ?? []) as { ref: string; id: string }[];
      if (first === undefined || second === undefined) throw new Error("no tasks");
      const page = String(
        (
          await op("page.write", {
            action: "create",
            on: first.ref,
            title: "Fixture page on a task",
            brief: "Written by the person",
            body: "Fixture body.",
            why: "fixture",
          })
        )["target"],
      );
      const s = started(key, saved);
      const row = (id: string) => s.seen.view?.tasks.get(id);
      await until(() => s.seen.view?.live === true && row(first.id) !== undefined);
      expect(s.seen.view?.changes.some((c) => c.task === first.id)).toBe(false);
      const touched = (id: string) => row(id)?.touched ?? 0;

      let before = touched(first.id);
      await w.asAgent("page.write", {
        action: "append",
        target: page,
        text: "Fixture: found it.",
        why: "fixture",
      });
      await until(() => s.seen.view?.changes.some((c) => c.task === first.id) === true);
      expect(touched(first.id)).toBeGreaterThan(before);

      // To the Trash and back, as the person does it: the card's Knowledge follows both.
      before = touched(first.id);
      await op("page.write", { action: "trash", target: page, why: "fixture" });
      await until(() => touched(first.id) > before);
      before = touched(first.id);
      await op("page.write", { action: "restore", target: page, why: "fixture" });
      await until(() => touched(first.id) > before);
      const card = await s.live.card(first.id);
      expect(card.kind === "read" ? card.value.pages.map((p) => p.title) : []).toContain(
        "Fixture page on a task",
      );

      const was = { first: touched(first.id), second: touched(second.id) };
      await op("page.write", { action: "move", target: page, to: second.ref, why: "fixture" });
      await until(() => touched(first.id) > was.first && touched(second.id) > was.second);
      s.live.stop();
    },
  );
});

describe("[S5.phone.run-badge] a task with a run stays on the phone, with how its run stands", () => {
  test(
    "a run reaches the phone as its ID and state only, in a batch and in a snapshot; the task stays, and its runs are read for its card and kept",
    { timeout: 180_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Runs");
      const task = await w.added("Fixture task an agent runs on");
      const host = await runs();
      const s = started(key, saved, memory());
      await until(() => s.seen.view?.live === true && s.seen.view.tasks.has(task.id));

      // In a batch: the run's badge, without the instance it runs with.
      const queued = await host.queue(task.id);
      await until(() => s.seen.view?.tasks.get(task.id)?.run?.state === "working");
      expect(s.seen.view?.tasks.get(task.id)?.run).toEqual({ id: queued.id, state: "working" });
      await host.asks(queued);
      await until(() => s.seen.view?.tasks.get(task.id)?.run?.state === "needs_you");

      // In a snapshot: a phone that reads the space afresh holds the task and its run.
      const fresh = started(key, saved);
      await until(() => fresh.seen.view?.live === true);
      expect(fresh.seen.view?.tasks.get(task.id)?.run).toEqual({
        id: queued.id,
        state: "needs_you",
      });
      fresh.live.stop();

      const read = await s.live.runs(task.id);
      const newest = read.kind === "read" ? read.value[0] : undefined;
      expect(newest?.id).toBe(queued.id);
      expect(newest === undefined ? undefined : runLine(newest).tone).toBe("needs_you");

      await w.stop();
      await until(() => s.seen.view?.link.kind === "offline");
      expect(await s.live.runs(task.id)).toMatchObject({
        kind: "read",
        live: false,
        value: [{ id: queued.id }],
      });
      s.live.stop();
      await w.restart();
    },
  );
});
