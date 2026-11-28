// What agents did, on the phone (@ttasks/client), against the real service: the tasks an agent
// changed under Today's Changes, with who and when; the pages an agent changed; a question an agent
// left, which marks its task as needing the person; a task's runs read for its card; and all of it
// kept for when the computer is away. Fixture data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spaceSession, type Keep, type Saved, type SpaceView } from "@ttasks/client/link";
import { questionsWaiting } from "@ttasks/client/store";
import { agentPages, CHANGES_DAYS, CHANGES_LIMIT, todayOf } from "@ttasks/client/today";
import { localDate } from "@ttasks/contracts/day";
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
      s.live.stop();
    },
  );

  test(
    "a task's runs are read for its card, and kept for when the computer is away",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Runs");
      const task = await w.added("Fixture task without a run");
      const keep = memory();
      const s = started(key, saved, keep);
      await until(() => s.seen.view?.live === true);
      const runs = await s.live.runs(task.id);
      expect(runs).toMatchObject({ kind: "read", live: true, value: [] });
      await w.stop();
      await until(() => s.seen.view?.link.kind === "offline");
      expect(await s.live.runs(task.id)).toMatchObject({ kind: "read", live: false, value: [] });
      s.live.stop();
      await w.restart();
    },
  );
});
