// A task's card on the phone (@ttasks/client/link `card` and `page`) against the real service: its
// Description, notes and log newest first with who wrote each, its Knowledge, a page opened from
// it, a note the computer adds while it is open, and what it shows with the computer away. Fixture
// data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  forgetReads,
  Outbox,
  spaceSession,
  type Keep,
  type Saved,
  type SpaceView,
} from "@ttasks/client/link";
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
    "a long Description, many notes and a long page are read to their end, never a part shown as all",
    { timeout: 300_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Card long");
      const task = await w.added("Card long task");
      const got = await w.op("task.get", { task: task.ref });
      const description = Array.from(
        { length: 1_200 },
        (_, i) => `Fixture line ${String(i)} of a long description.`,
      ).join("\n");
      await op("task.update", {
        task: task.ref,
        base: got.result?.["as_of"],
        context: { mode: "replace", text: description },
      });
      for (let i = 0; i < 60; i += 1) {
        await op("entry.add", { task: task.ref, kind: "note", text: `Fixture note ${String(i)}.` });
      }
      const body = Array.from(
        { length: 500 },
        (_, i) => `Fixture page line ${String(i)} of a long page.`,
      ).join("\n");
      const page = await op("page.write", {
        action: "create",
        on: task.ref,
        title: "Fixture long page",
        brief: "Long",
        body,
        why: "fixture",
      });
      const s = started(key, saved);
      await until(() => s.seen.view?.live === true);
      const card = await s.live.card(task.id);
      if (card.kind !== "read") throw new Error("the card read nothing");
      expect(card.value.partial).toBe(false);
      expect(card.value.description).toBe(description);
      expect(card.value.entries).toHaveLength(60);
      const opened = await s.live.page(String(page["target"]));
      if (opened.kind !== "read") throw new Error("the page read nothing");
      expect(opened.value.partial).toBe(false);
      expect(opened.value.body.length).toBeGreaterThanOrEqual(body.length);
      expect(opened.value.body).toContain("Fixture page line 499 of a long page.");
      s.live.stop();
    },
  );

  test(
    "a task finished or moved to the Trash on the computer is told as such to the card that shows it",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Card left");
      const done = await w.added("Card left done");
      const trashed = await w.added("Card left trashed");
      const s = started(key, saved);
      await until(
        () => s.seen.view?.tasks.has(done.id) === true && s.seen.view.tasks.has(trashed.id),
      );
      const base = async (ref: string) => (await w.op("task.get", { task: ref })).result?.["as_of"];
      await op("task.finish", { task: done.ref, base: await base(done.ref) });
      await op("task.delete", { tasks: [trashed.ref], base: await base(trashed.ref) });
      await until(() => s.seen.view?.left.get(done.id) === "done");
      await until(() => s.seen.view?.left.get(trashed.id) === "trash");
      expect(s.seen.view?.tasks.has(done.id)).toBe(false);
      expect(s.seen.view?.tasks.has(trashed.id)).toBe(false);
      s.live.stop();
    },
  );

  test(
    "a page moved to the Trash on the computer reads as gone, and the phone's copy goes with it",
    { timeout: 120_000 },
    async () => {
      const { key, saved } = await pairedPhone(w, "Card gone");
      const task = await w.added("Card gone task");
      const page = await op("page.write", {
        action: "create",
        on: task.ref,
        title: "Fixture page to go",
        brief: "Goes",
        body: "Fixture body that goes.",
        why: "fixture",
      });
      const ref = String(page["target"]);
      const keep = memory();
      const s = started(key, saved, keep);
      await until(() => s.seen.view?.live === true);
      expect((await s.live.page(ref)).kind).toBe("read");
      await op("page.write", { action: "trash", target: ref, why: "fixture" });
      expect(await s.live.page(ref)).toEqual({ kind: "gone" });
      s.live.stop();
      // Without the computer, nothing of it is shown any more.
      const away = started(key, saved, keep);
      expect(await away.live.page(ref)).toEqual({ kind: "none" });
      away.live.stop();
    },
  );

  test("a new pairing forgets what the phone read under the old one, and keeps what waits there", () => {
    const keep = memory();
    const old: Saved = {
      addrs: ["127.0.0.1:9"],
      pin: "A".repeat(43),
      space: { id: "sp_old", name: "Old" },
    };
    const outbox = new Outbox(keep, old.pin, old.space.id);
    outbox.add(
      { kind: "add", draft: { title: "Waits", inbox: true }, text: "Waits" },
      "r-waits-000000000000",
      1,
    );
    keep.write(
      "reads",
      JSON.stringify({
        [`${old.pin} ${old.space.id}`]: {
          cards: {
            t_1: {
              at: 1,
              value: { description: "", entries: [], pages: [], above: [], partial: false },
            },
          },
          pages: {},
        },
      }),
    );
    keep.write(
      "rows",
      JSON.stringify({ [`${old.pin} ${old.space.id}`]: { at: 1, tasks: [], nodes: [] } }),
    );
    forgetReads(keep, old);
    expect(keep.read("reads")).toBe("{}");
    expect(keep.read("rows")).toBe("{}");
    expect(new Outbox(keep, old.pin, old.space.id).waiting.map((e) => e.request)).toEqual([
      "r-waits-000000000000",
    ]);
  });

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
