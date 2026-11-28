// A task's card on the phone (@ttasks/client/link `card` and `page`) against the real service: its
// Description, notes and log newest first with who wrote each, its Knowledge, a page opened from
// it, a note the computer adds while it is open, and what it shows with the computer away. Fixture
// data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spaceSession, type Keep, type Saved, type SpaceView } from "@ttasks/client/link";
import { memory, pairedPhone, phone, phoneWorld, until } from "./phone-link.ts";
import type { PhoneKey } from "./phone-client.ts";

let w: Awaited<ReturnType<typeof phoneWorld>>;

beforeAll(async () => {
  w = await phoneWorld("phone-card");
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

/** An entry or a page written on the computer, as the page writes them. */
const op = async (name: string, input: Record<string, unknown>) => {
  const done = await w.op(name, { ...input, request_id: randomUUID() });
  if (done.status !== 200) throw new Error(`${name}: ${String(done.status)}`);
  return done.result ?? {};
};

describe("[S5.phone.card] a task's card on the phone reads its detail, its Knowledge and its pages", () => {
  test(
    "the Description, notes and log newest first with who wrote each, the Knowledge, a page opened from it",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Card");
      const task = await w.added("Card task");
      const got = await w.op("task.get", { task: task.ref });
      await op("task.update", {
        task: task.ref,
        base: got.result?.["as_of"],
        context: { mode: "replace", text: "Fixture description of the card." },
      });
      await op("entry.add", { task: task.ref, kind: "note", text: "Fixture first note." });
      await op("entry.add", { task: task.ref, kind: "progress", text: "Fixture log entry." });
      const page = await op("page.write", {
        action: "create",
        on: task.ref,
        title: "Fixture card page",
        brief: "What the card's page holds",
        body: "Fixture body of the card's page.",
        why: "fixture",
      });
      await op("page.write", {
        action: "create",
        on: "space",
        title: "Fixture space page",
        brief: "What the space knows",
        body: "Fixture body of the space's page.",
        why: "fixture",
      });

      const s = started(key, saved);
      await until(() => s.seen.view?.live === true);
      const card = await s.live.card(task.id);
      if (card.kind !== "read") throw new Error("the card read nothing");
      expect(card.live).toBe(true);
      expect(card.value.description).toBe("Fixture description of the card.");
      expect(card.value.entries.map((e) => [e.kind, e.text, e.by])).toEqual([
        ["log", "Fixture log entry.", "user"],
        ["note", "Fixture first note.", "user"],
      ]);
      expect(card.value.pages.map((p) => [p.title, p.brief])).toEqual([
        ["Fixture card page", "What the card's page holds"],
      ]);
      expect(card.value.above.find((l) => l.kind === "space")?.pages.map((p) => p.title)).toEqual([
        "Fixture space page",
      ]);

      const opened = await s.live.page(String(page["target"]));
      if (opened.kind !== "read") throw new Error("the page read nothing");
      expect(opened.value.title).toBe("Fixture card page");
      expect(opened.value.body).toContain("Fixture body of the card's page.");
      s.live.stop();
    },
  );

  test(
    "a note the computer adds while the card is open moves the row, and the next read has it",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Card live");
      const task = await w.added("Card live task");
      const s = started(key, saved);
      await until(() => s.seen.view?.tasks.has(task.id) === true);
      const before = s.seen.view?.tasks.get(task.id);
      if (before === undefined) throw new Error("no row");
      const first = await s.live.card(task.id);
      expect(first.kind === "read" ? first.value.entries : undefined).toEqual([]);
      await op("entry.add", { task: task.ref, kind: "note", text: "Fixture note while open." });
      // What the card follows to read again: the row's version or its `touched`.
      await until(() => {
        const row = s.seen.view?.tasks.get(task.id);
        return (
          row !== undefined && (row.touched !== before.touched || row.version !== before.version)
        );
      });
      const again = await s.live.card(task.id);
      expect(again.kind === "read" ? again.value.entries.map((e) => e.text) : undefined).toEqual([
        "Fixture note while open.",
      ]);
      s.live.stop();
    },
  );

  test(
    "with the computer away a card shows the phone's last read and its age; one never read, none",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Card away");
      const read = await w.added("Card away read");
      const never = await w.added("Card away never");
      const keep = memory();
      const s = started(key, saved, keep);
      await until(() => s.seen.view?.live === true);
      const first = await s.live.card(read.id);
      expect(first.kind).toBe("read");
      await w.stop();
      await until(() => s.seen.view?.link.kind === "offline");
      const away = await s.live.card(read.id);
      expect(away).toMatchObject({ kind: "read", live: false });
      expect(away.kind === "read" ? away.at : undefined).toBe(first.kind === "read" ? first.at : 0);
      expect(await s.live.card(never.id)).toEqual({ kind: "none" });
      s.live.stop();
      // A restart of the app, still without the computer: the read is kept.
      const again = started(key, saved, keep);
      expect(await again.live.card(read.id)).toMatchObject({ kind: "read", live: false });
      again.live.stop();
      await w.restart();
    },
  );
});
