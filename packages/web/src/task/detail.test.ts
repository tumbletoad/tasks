import { describe, expect, test } from "vitest";
import { mergePages, rowOfFacts, type TaskFacts } from "./detail.ts";

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
