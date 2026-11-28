import { describe, expect, test } from "vitest";
import { areaNode, projectNode, treeOf } from "@ttasks/client/test/nodes";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { mergePages, PAGES, readDetail, readOlder, rowOfFacts, type TaskFacts } from "./detail.ts";

const FACTS: TaskFacts = {
  id: "t_0123456789abcdefghjkmnpqrs",
  ref: "M-3",
  title: "Fix DST bug in reports",
  lifecycle: "completed",
  status: "review",
  inbox: false,
  priority: 2,
  due: "2026-11-13",
  area: "Client work",
  project: "Lumen Health",
  summary: "Convert from UTC once",
  context: "",
  focus: false,
  created: "2026-11-09T08:00:00.000Z",
  learnings: [],
  instructions: [],
  notes: [],
  log: [],
  sources: [],
  more: { instructions: 0, notes: 0, log: 0, sources: 0, learnings: 0 },
  version: 7,
};

describe("[A5.3.7.web.detail] the expanded task's detail from the pages of a sections read", () => {
  test("pages join: a text split by a page boundary is one entry; notes and log oldest first", () => {
    const detail = mergePages(
      FACTS,
      [
        {
          instructions: [
            {
              ref: "n3",
              author: "user",
              for_agents: true,
              at: "2026-11-12T09:00:00Z",
              text: "Keep ",
            },
          ],
        },
        {
          instructions: [
            {
              ref: "n3",
              author: "user",
              for_agents: true,
              at: "2026-11-12T09:00:00Z",
              text: "the format.",
            },
          ],
          context: "Times drift ",
        },
        {
          context: "by one hour.",
          notes: [
            {
              ref: "n1",
              author: "user",
              for_agents: false,
              at: "2026-11-10T09:00:00Z",
              text: "First.",
            },
          ],
          log: [
            {
              ref: "l2",
              kind: "evidence",
              author: "agent:codex",
              at: "2026-11-12T10:00:00Z",
              text: "Seen.",
            },
            {
              ref: "l1",
              kind: "progress",
              author: "agent:codex",
              at: "2026-11-11T10:00:00Z",
              text: "Started.",
            },
          ],
          outcome: { outcome: "Reports convert once.", learnings: ["Store UTC.", "Store UTC."] },
        },
      ],
      false,
    );
    expect(detail.context).toBe("Times drift by one hour.");
    expect(detail.notes.map((n) => [n.ref, n.text, n.forAgents])).toEqual([
      ["n1", "First.", false],
      ["n3", "Keep the format.", true],
    ]);
    expect(detail.log.map((l) => l.ref)).toEqual(["l1", "l2"]);
    expect(detail.outcome).toBe("Reports convert once.");
    expect(detail.learnings).toEqual(["Store UTC."]);
  });

  test("a task the live rows do not hold becomes a row with its area and project by name", () => {
    const row = rowOfFacts(
      FACTS,
      treeOf(
        areaNode({ id: "ar_1", title: "Client work", position: "a" }),
        projectNode("ar_1", { id: "pj_1", title: "Lumen Health", position: "a" }),
      ),
      "2026-11-14",
    );
    expect(row).toMatchObject({
      id: FACTS.id,
      ref: "M-3",
      lifecycle: "completed",
      parent: "pj_1",
      due_date: "2026-11-13",
      position: "",
      created_at: Date.parse("2026-11-09T08:00:00.000Z"),
    });
    expect(row).not.toHaveProperty("focus_on");
  });
});

describe("[A5.while-away.web.thread-pages] a thread reads as many pages as the person asked for", () => {
  /** A task whose sections come in `count` pages of one note each, newest first. */
  const client = (count: number, asked: string[]): Client =>
    ({
      task: {
        get: (input: { before?: string; sections?: readonly string[] }) => {
          if (input.sections === undefined) {
            return Promise.resolve({ view: "digest", task: FACTS, as_of: "1.1.a" });
          }
          const page = input.before === undefined ? 0 : Number(input.before);
          asked.push(String(page));
          const ordinal = count - page;
          return Promise.resolve({
            view: "sections",
            sections: {
              notes: [
                {
                  ref: `n${String(ordinal)}`,
                  author: "user",
                  at: new Date(Date.UTC(2026, 10, 1) + ordinal * 60_000).toISOString(),
                  text: `Note ${String(ordinal)}`,
                  for_agents: false,
                },
              ],
            },
            ...(page + 1 < count ? { before: String(page + 1) } : {}),
            as_of: "1.1.a",
          });
        },
      },
    }) as unknown as Client;

  test("the first pages, then each press reads on from where the last read ended, up to the first entry; a read no one waits for stops", async () => {
    const asked: string[] = [];
    const count = 2 * PAGES + 5;
    const first = await readDetail(client(count, asked), "M-3", []);
    expect(first.detail.partial).toBe(true);
    expect(first.detail.notes).toHaveLength(PAGES);
    expect(asked).toHaveLength(PAGES);
    asked.length = 0;
    const second = await readOlder(client(count, asked), "M-3", first);
    // Only the pages after the last one read.
    expect(asked).toEqual(Array.from({ length: PAGES }, (_, k) => String(PAGES + k)));
    expect(second.detail.partial).toBe(true);
    asked.length = 0;
    const all = await readOlder(client(count, asked), "M-3", second);
    expect(asked).toHaveLength(5);
    expect(all.detail.partial).toBe(false);
    expect(all.detail.notes.map((n) => n.text)).toEqual(
      Array.from({ length: count }, (_, k) => `Note ${String(k + 1)}`),
    );
    asked.length = 0;
    let reads = 0;
    await readDetail(client(5, asked), "M-3", [], 6, () => (reads += 1) > 1);
    expect(asked).toEqual(["0"]);
  });

  test("a first page with no entry but more behind it is partial, not an empty thread", async () => {
    const empty = {
      task: {
        get: (input: { before?: string; sections?: readonly string[] }) =>
          Promise.resolve(
            input.sections === undefined
              ? { view: "digest", task: FACTS, as_of: "1.1.a" }
              : { view: "sections", sections: { context: "x" }, before: "c1", as_of: "1.1.a" },
          ),
      },
    } as unknown as Client;
    const read = await readDetail(empty, "M-3", [], 1);
    expect(read.detail.notes).toEqual([]);
    expect(read.detail.log).toEqual([]);
    expect(read.detail.partial).toBe(true);
  });
});

describe("[A5.entry.correct.web.whole] the card knows which texts it holds whole", () => {
  test("a text longer than the pages read so far is partial, and whole once the rest is read", () => {
    const part = (text: string, from: number, of: number) => ({
      ref: "n2",
      author: "agent:codex",
      for_agents: false,
      at: "2026-11-12T09:00:00Z",
      text,
      slice: { from, to: from + text.length, of },
    });
    const log = (text: string, from: number, of: number) => ({
      ref: "l1",
      kind: "progress" as const,
      author: "agent:codex",
      at: "2026-11-12T10:00:00Z",
      text,
      slice: { from, to: from + text.length, of },
    });
    const first = {
      context: "Times drift ",
      context_slice: { from: 0, to: 12, of: 24 },
      notes: [part("Drafted ", 0, 17)],
      log: [log("Checked ", 0, 16)],
    };
    const cut = mergePages(FACTS, [first], true);
    expect(cut.contextPartial).toBe(true);
    expect(cut.notes.map((n) => [n.text, n.partial])).toEqual([["Drafted ", true]]);
    expect(cut.log.map((l) => [l.text, l.partial])).toEqual([["Checked ", true]]);

    const all = mergePages(
      FACTS,
      [
        first,
        {
          context: "by one hour.",
          context_slice: { from: 12, to: 24, of: 24 },
          notes: [part("the reply", 8, 17)],
          log: [log("the site", 8, 16)],
        },
      ],
      false,
    );
    expect(all.contextPartial).toBeUndefined();
    expect(all.notes.map((n) => [n.text, n.partial])).toEqual([["Drafted the reply", undefined]]);
    expect(all.log.map((l) => [l.text, l.partial])).toEqual([["Checked the site", undefined]]);
  });
});
