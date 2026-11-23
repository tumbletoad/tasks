// Where the Agents page places a task: by what asks most of the person, TTasks' own record first;
// and a task in the Trash, read because the monitor links an agent to it, by the same rule as a
// live one, only its mark differing. Fixture data only.
import type { AgentsPicture, AgentsSession, AgentsTask } from "@ttasks/contracts/monitor";
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../store/rows.ts";
import { linkedOutside, mergeAgents } from "./agents-merge.ts";
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

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const OTHER = "sp_abcdefghjkmnpqrs0123456789";

const numbered = (n: number, fields: Partial<TaskRow> = {}): TaskRow => ({
  id: `t_${String(n).padStart(5, "0")}`,
  ref: `M-${String(n)}`,
  title: `Task ${String(n)}`,
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: `p${String(n)}`,
  created_at: 0,
  version: 1,
  ...fields,
});

const task = (n: number, space = SPACE, started: "run" | "terminal" = "run"): AgentsTask => ({
  space,
  spaceName: "Mira",
  id: `t_${String(n).padStart(5, "0")}`,
  ref: `M-${String(n)}`,
  started,
  of: `r_${String(n)}`,
});

const session = (n: number, space = SPACE, started: "run" | "terminal" = "run"): AgentsSession => ({
  key: `s${String(n)}`,
  task: task(n, space, started),
  app: "codex",
  appName: "Codex",
  account: "work",
  title: "Fixture conversation",
  folder: null,
  activity: "idle",
  ageMs: 1_000,
  quietMs: 1_000,
  nested: [],
});

const picture = (sessions: AgentsSession[], unseen: AgentsTask[] = []): AgentsPicture => ({
  ageMs: 0,
  settling: false,
  sessions,
  unseen,
  accounts: [],
});

describe("[A5.trash.web.agents] a task in the Trash on the Agents page", () => {
  test("the tasks the monitor links an agent to that the live store does not hold are named once, sorted, for this space only", () => {
    const live = new Map([[numbered(1).id, numbered(1)]]);
    const shown = picture(
      [session(1), session(3), session(2), session(2), session(9, OTHER)],
      [task(4, SPACE, "terminal")],
    );
    expect(linkedOutside(shown, SPACE, live)).toEqual([
      numbered(2).id,
      numbered(3).id,
      numbered(4).id,
    ]);
    expect(linkedOutside(null, SPACE, live)).toEqual([]);
  });

  test("a removed task whose run ended is placed where a live one is, and so is one that runs; only the mark differs", () => {
    const live = numbered(1);
    const removed = numbered(2, { deleted_at: 1 });
    const working = numbered(3, {
      deleted_at: 1,
      run: { id: "r_3", state: "working", instance: "c" },
    });
    const rows = new Map([live, removed, working].map((r) => [r.id, r]));
    const merged = mergeAgents(picture([session(1), session(2)]), SPACE, rows);
    expect(merged.tasks.get(removed.id)?.state).toBe(merged.tasks.get(live.id)?.state);
    expect(merged.tasks.get(working.id)?.state).toBe("working");
    // Restored, the same row without its mark: the same place.
    const restored = numbered(2);
    const back = new Map<string, TaskRow>([...rows, [restored.id, restored]]);
    expect(
      mergeAgents(picture([session(1), session(2)]), SPACE, back).tasks.get(removed.id),
    ).toEqual(merged.tasks.get(removed.id));
  });
});
