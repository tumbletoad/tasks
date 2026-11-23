// Where the Agents page places a task: by what asks most of the person, TTasks' own record first.
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../store/rows.ts";
import { mergeAgents } from "./agents-merge.ts";

const row = (id: string, patch: Partial<TaskRow> = {}): TaskRow => ({
  id,
  ref: `M-${id}`,
  title: `Fixture ${id}`,
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: id,
  created_at: 1,
  version: 1,
  ...patch,
});

describe("[A5.while-away.web.question-placed] an agent's question places its task under Needs you", () => {
  test("a question that waits asks as much as a run that needs the person, more than one that works", () => {
    const questions = [{ ref: "l2", by: "Codex", text: "Which export?", at: 1 }];
    const rows = new Map(
      [
        row("1", { questions }),
        row("2", { questions, run: { id: "ru_2", state: "working", instance: "codex" } }),
        row("3", { run: { id: "ru_3", state: "working", instance: "codex" } }),
        row("4"),
        // Whatever became of the task, its questions wait.
        row("5", { lifecycle: "completed", questions }),
        row("6", { lifecycle: "archived", questions }),
        row("7", { questions, deleted_at: 2 }),
      ].map((r) => [r.id, r]),
    );
    const { tasks } = mergeAgents(null, "sp_1", rows);
    expect(tasks.get("1")).toMatchObject({ state: "waiting", own: true, agents: [] });
    expect(tasks.get("2")).toMatchObject({ state: "waiting", own: true });
    expect(tasks.get("3")).toMatchObject({ state: "working", own: true });
    expect(tasks.has("4")).toBe(false);
    expect(tasks.get("5")).toMatchObject({ state: "waiting", own: true });
    expect(tasks.get("6")).toMatchObject({ state: "waiting", own: true });
    expect(tasks.has("7")).toBe(false);
  });
});
