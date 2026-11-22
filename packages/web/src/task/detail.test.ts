import { describe, expect, test } from "vitest";
import type { Client } from "@tasks/contracts/generated/client.ts";
import { MAX_PAGES, mergePages, readDetail, rowOfFacts, type TaskFacts } from "./detail.ts";

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
  more: { instructions: 0, notes: 0, log: 0, sources: 0 },
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
      new Map([["ar_1", { id: "ar_1", title: "Client work", position: "a" }]]),
      new Map([["pj_1", { id: "pj_1", area_id: "ar_1", title: "Lumen Health", position: "a" }]]),
      "2026-11-14",
    );
    expect(row).toMatchObject({
      id: FACTS.id,
      ref: "M-3",
      lifecycle: "completed",
      area_id: "ar_1",
      project_id: "pj_1",
      due_date: "2026-11-13",
      position: "",
      created_at: Date.parse("2026-11-09T08:00:00.000Z"),
    });
    expect(row).not.toHaveProperty("focus_on");
  });
});

/**
 * A client whose task holds instructions that fill more pages than the page reads, and `count`
 * notes of the person's, one a page, newest first: n<count> down to n1.
 */
function longTask(count: number) {
  const reads: string[][] = [];
  const note = (n: number) => ({
    ref: `n${String(n)}`,
    author: "user",
    for_agents: false,
    at: new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString(),
    text: `Note ${String(n)}`,
  });
  const client = {
    task: {
      get: (input: { sections?: string[]; before?: string }) => {
        if (input.sections === undefined) return Promise.resolve({ view: "digest", task: FACTS });
        reads.push(input.sections);
        const page = Number(input.before ?? "0");
        const next = { before: String(page + 1) };
        if (input.sections.includes("instructions")) {
          const instruction = { ...note(10_000), for_agents: true, text: "x" };
          return Promise.resolve({
            view: "sections",
            sections: { instructions: [instruction] },
            ...next,
          });
        }
        const n = count - page;
        return Promise.resolve({
          view: "sections",
          sections: { notes: [note(n)] },
          ...(n > 1 ? next : {}),
        });
      },
    },
  } as unknown as Client;
  return { client, reads };
}

describe("[A5.3.9.web.thread-request] the request a session names is in the detail whatever the task holds", () => {
  test("instructions that fill every page leave the person's notes, newest first, their own pages", async () => {
    const { client } = longTask(3);
    const detail = await readDetail(client, FACTS.id);
    expect(detail.notes.filter((n) => !n.forAgents).map((n) => n.ref)).toEqual(["n1", "n2", "n3"]);
    expect(detail.partial).toBe(true);
  });

  test("a session's request older than the pages read is read on to, and no further", async () => {
    const count = MAX_PAGES + 15;
    const { client, reads } = longTask(count);
    const wanted = `n${String(count - MAX_PAGES - 5)}`;
    const detail = await readDetail(client, FACTS.id, [wanted]);
    expect(detail.notes.some((n) => n.ref === wanted)).toBe(true);
    expect(reads.filter((r) => r.includes("notes"))).toHaveLength(MAX_PAGES + 6);
    expect(detail.partial).toBe(true);
    // The newest session's note is gone (an undo took it back): no page more is read for it.
    const { client: again, reads: more } = longTask(count);
    await readDetail(again, FACTS.id, [`n${String(count + 1)}`]);
    expect(more.filter((r) => r.includes("notes"))).toHaveLength(MAX_PAGES);
  });
});
