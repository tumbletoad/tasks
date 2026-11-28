// The phone's outbox against the real service, through the sequences a review found: each fault is
// injected at the link's socket (phone-link.ts `faulty`), and each sequence ends with the phone
// showing what the computer holds and nothing waiting. Fixture data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spaceSession, type Keep, type Saved, type SpaceView } from "@ttasks/client/link";
import { faulty, memory, pairedPhone, phone, phoneWorld, until } from "./phone-link.ts";
import type { PhoneKey } from "./phone-client.ts";

let w: Awaited<ReturnType<typeof phoneWorld>>;

beforeAll(async () => {
  w = await phoneWorld("phone-outbox");
}, 300_000);

afterAll(async () => {
  await w.end();
});

/** A started session of a paired phone, its faults, and its last view. */
function started(key: PhoneKey, saved: Saved, keep: Keep = memory()) {
  const { connect, faults } = faulty(phone(key).connect);
  const seen: { view?: SpaceView } = {};
  const live = spaceSession({
    connect,
    saved,
    keep,
    newId: randomUUID,
    report: (view) => {
      seen.view = view;
    },
    retryMs: 50,
    resendMs: 50,
    callMs: 300,
  });
  live.start();
  const row = (title: string) =>
    [...(seen.view?.tasks.values() ?? [])].find(
      (t) => t.title === title && t.lifecycle === "active",
    );
  /** All is answered and the feed shows it: nothing waits, nothing settles, the rows are live. */
  const quiet = () =>
    until(() => seen.view?.live === true && seen.view.waiting.length === 0 && !seen.view.settling);
  return { live, faults, seen, row, quiet, keep };
}

async function ready(name: string, title: string) {
  const { key, saved } = await pairedPhone(w, name);
  const task = await w.added(title);
  const s = started(key, saved);
  await until(() => s.row(title) !== undefined && s.seen.view?.live === true);
  return { ...s, key, saved, task };
}

const shown = (s: { row: (title: string) => unknown }, title: string) => s.row(title) !== undefined;

/** The row the phone shows for `title`. */
function rowOf<T>(row: (title: string) => T | undefined, title: string): T {
  const found = row(title);
  if (found === undefined) throw new Error(`the phone shows no "${title}"`);
  return found;
}

describe(
  "[S5.phone.sequences] the phone's outbox through the sequences a review found",
  { timeout: 120_000 },
  () => {
    test("the computer applies a check-off, its answer is lost with the link, then Undo: open on both", async () => {
      const s = await ready("Lost answer", "Lost answer");
      s.faults.dropAnswer = 1;
      const request = s.live.finish(rowOf(s.row, "Lost answer"));
      await until(async () => (await w.lifecycle(s.task.ref)) === "completed");
      s.live.undo(request);
      await s.quiet();
      await until(async () => (await w.lifecycle(s.task.ref)) === "active");
      await until(() => shown(s, "Lost answer"));
      expect(s.seen.view?.refused).toEqual([]);
      s.live.stop();
    });

    test("Undo before the feed showed the check-off: the reopening goes from where it landed, no conflict", async () => {
      const s = await ready("Early undo", "Early undo");
      s.faults.holdFeed = true;
      const request = s.live.finish(rowOf(s.row, "Early undo"));
      await until(async () => (await w.lifecycle(s.task.ref)) === "completed");
      await until(() => s.seen.view?.waiting.length === 0);
      s.live.undo(request);
      await until(() => s.seen.view?.waiting.length === 0);
      s.faults.release();
      await s.quiet();
      expect(s.seen.view?.refused).toEqual([]);
      expect(await w.lifecycle(s.task.ref)).toBe("active");
      await until(() => shown(s, "Early undo"));
      s.live.stop();
    });

    test("the feed shows a check-off before its answer, then the computer reopens it: the phone shows it", async () => {
      const s = await ready("Feed first", "Feed first");
      s.faults.holdAnswers = true;
      s.live.finish(rowOf(s.row, "Feed first"));
      await until(async () => (await w.lifecycle(s.task.ref)) === "completed");
      s.faults.release();
      await s.quiet();
      const got = await w.op("task.get", { task: s.task.ref });
      const base = got.result?.["as_of"] as string;
      const reopened = await w.op("task.reopen", {
        task: s.task.ref,
        base,
        request_id: randomUUID(),
      });
      expect(reopened.status).toBe(200);
      await until(() => shown(s, "Feed first"));
      s.live.stop();
    });

    test("an answer withheld on an open link: the same request goes again, and the next waits its turn", async () => {
      const s = await ready("Withheld", "Withheld");
      s.faults.withholdAnswer = 1;
      s.live.add({ title: "Withheld capture one", inbox: true }, "Withheld capture one");
      s.live.add({ title: "Withheld capture two", inbox: true }, "Withheld capture two");
      await s.quiet();
      expect(s.seen.view?.link.kind).toBe("connected");
      expect(await w.found('"Withheld capture one"')).toBe(1);
      expect(await w.found('"Withheld capture two"')).toBe(1);
      s.live.stop();
    });

    test("after a capture, a task the computer adds shows on the phone", async () => {
      const s = await ready("After capture", "After capture");
      s.live.add({ title: "After capture capture", inbox: true }, "After capture capture");
      await s.quiet();
      await w.added("After capture added");
      await until(() => shown(s, "After capture added"));
      expect(shown(s, "After capture capture")).toBe(true);
      s.live.stop();
    });

    test("a 503 that says it will never work is shown, and the next entry goes", async () => {
      const s = await ready("Never", "Never");
      s.faults.answer = {
        status: 503,
        body: {
          error: {
            code: "space_unavailable",
            message: "Gone for good.",
            data: { retryable: false },
          },
        },
      };
      s.live.add({ title: "Never capture one", inbox: true }, "Never capture one");
      s.live.add({ title: "Never capture two", inbox: true }, "Never capture two");
      await s.quiet();
      expect(s.seen.view?.refused.map((r) => [r.words, r.why])).toEqual([
        ["Never capture one", "Gone for good."],
      ]);
      expect(await w.found('"Never capture two"')).toBe(1);
      s.live.stop();
    });

    test("a refused capture outlasts a restart of the app until the person read it", async () => {
      const s = await ready("Refused", "Refused");
      s.faults.answer = {
        status: 400,
        body: { error: { code: "invalid_input", message: "Not like that." } },
      };
      s.live.add({ title: "Refused capture", inbox: true }, "Refused capture");
      await until(() => s.seen.view?.refused.length === 1);
      s.live.stop();
      const again = started(s.key, s.saved, s.keep);
      await until(() => again.seen.view !== undefined);
      expect(again.seen.view?.refused.map((r) => r.words)).toEqual(["Refused capture"]);
      again.live.dismiss(again.seen.view?.refused[0]?.request ?? "");
      again.live.stop();
      const third = started(s.key, s.saved, s.keep);
      await until(() => third.seen.view !== undefined);
      expect(third.seen.view?.refused).toEqual([]);
      third.live.stop();
    });

    test("a space closed on the computer is not live and says how old its rows are; open again, live", async () => {
      const s = await ready("Closed", "Closed");
      await w.close();
      await until(() => s.seen.view?.live === false);
      expect(s.seen.view?.link.kind).toBe("connected");
      expect(s.seen.view?.asOf).toBeTypeOf("number");
      expect(shown(s, "Closed")).toBe(true);
      await w.open();
      await until(() => s.seen.view?.live === true);
      s.live.stop();
    });
  },
);
