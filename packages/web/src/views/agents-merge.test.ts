// A task in the Trash on the Agents page (A5's Trash): the monitor's agents of a task the live store
// does not hold are named for the page to read, and once read the task is placed by the same rule
// as a live one; only its mark differs. Fixture data only.
import type { AgentsPicture, AgentsSession, AgentsTask } from "@ttasks/contracts/monitor";
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../store/rows.ts";
import { linkedOutside, mergeAgents } from "./agents-merge.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const OTHER = "sp_abcdefghjkmnpqrs0123456789";

const row = (n: number, fields: Partial<TaskRow> = {}): TaskRow => ({
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
    const live = new Map([[row(1).id, row(1)]]);
    const shown = picture(
      [session(1), session(3), session(2), session(2), session(9, OTHER)],
      [task(4, SPACE, "terminal")],
    );
    expect(linkedOutside(shown, SPACE, live)).toEqual([row(2).id, row(3).id, row(4).id]);
    expect(linkedOutside(null, SPACE, live)).toEqual([]);
  });

  test("a removed task whose run ended is placed where a live one is, and so is one that runs; only the mark differs", () => {
    const live = row(1);
    const removed = row(2, { deleted_at: 1 });
    const working = row(3, { deleted_at: 1, run: { id: "r_3", state: "working", instance: "c" } });
    const rows = new Map([live, removed, working].map((r) => [r.id, r]));
    const merged = mergeAgents(picture([session(1), session(2)]), SPACE, rows);
    expect(merged.tasks.get(removed.id)?.state).toBe(merged.tasks.get(live.id)?.state);
    expect(merged.tasks.get(working.id)?.state).toBe("working");
    // Restored, the same row without its mark: the same place.
    const restored = row(2);
    const back = new Map<string, TaskRow>([...rows, [restored.id, restored]]);
    expect(
      mergeAgents(picture([session(1), session(2)]), SPACE, back).tasks.get(removed.id),
    ).toEqual(merged.tasks.get(removed.id));
  });
});
