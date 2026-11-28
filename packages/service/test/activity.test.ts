// The read behind the Activity screen (`activity.list`): one line per change an agent or a routine
// made, newest first, with the tasks it touched and what it did, read a page at a time by commit
// number. Against a real space in this thread, through the request path. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ActivityListResult } from "@ttasks/contracts";
import { newId, type Credential, type Id, type Operation } from "@ttasks/storage";
import { MACHINE, writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;

beforeAll(async () => {
  temp = tempRoot("activity");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder, { flush: false });
}, 60_000);

afterAll(() => {
  fx.close();
  temp.cleanup();
});

const host = (): OpsHost => ({
  machine: { id: MACHINE.id },
  spaces: () => [
    { id: fx.spaceId, name: "Mira", state: "open", writer: undefined, reader: readerOf(fx.reader) },
  ],
  now: () => Date.now(),
  timeZone: () => "Europe/Lisbon",
});
const user: Caller = { class: "cli-interactive", env: {} };

type Result = ReturnType<typeof ActivityListResult.parse>;
type Line = Result["lines"][number];

const activity = async (input: Record<string, unknown> = {}): Promise<Result> =>
  ActivityListResult.parse(await opCall(host(), user, { op: "activity.list", input }));

/** One request by `actor`: its commit number. */
function submit(actor: Credential, ops: Operation[]): number {
  const result = fx.writer.submit(fx.request(actor, ops, { base: fx.base() }));
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
  return result.seq;
}

const create = (actor: Credential, title: string, extra: Partial<Operation> = {}): Id<"t"> => {
  const id = newId("t");
  submit(actor, [{ kind: "task.create", id, title, ...extra } as Operation]);
  return id;
};

const only = (lines: readonly Line[], seq: number): Line => {
  const line = lines.find((l) => l.seq === seq);
  if (line === undefined) throw new Error(`no line for ${String(seq)}`);
  return line;
};

/** The ops each target of a line names, by target ID. */
const opsOf = (line: Line): Record<string, string[]> =>
  Object.fromEntries(line.targets.map((t) => [t.id, [...new Set(t.acts.map((a) => a.op))]]));

describe("[A5.activity.service] the lines of what agents did", () => {
  test("one line per change of an agent, newest first; the person's own changes are not there", async () => {
    const mine = create(fx.human, "Fixture person's task");
    const a = create(fx.codex, "Fixture agent task", { priority: 2 });
    const patched = submit(fx.codex, [
      { kind: "task.patch", task: a, set: { priority: 1, due: { date: "2026-12-03" } } },
    ]);
    submit(fx.human, [{ kind: "task.patch", task: mine, set: { priority: 1 } }]);

    const { lines } = await activity();
    expect(lines.map((l) => l.seq)).toEqual([...lines.map((l) => l.seq)].sort((x, y) => y - x));
    expect(lines.every((l) => l.actor === "agent")).toBe(true);
    expect(lines.some((l) => l.targets.some((t) => t.id === mine))).toBe(false);
    // Two fields set by one request: one line, each field with its value before and after.
    expect(only(lines, patched)).toMatchObject({
      by: "Codex · work",
      count: 1,
      targets: [
        {
          kind: "task",
          id: a,
          name: "Fixture agent task",
          acts: [
            { op: "task.patch", field: "priority", from: 2, to: 1 },
            { op: "task.patch", field: "due", from: null, to: "2026-12-03" },
          ],
        },
      ],
    });
  });

  test("several tasks made by one request are one line, each with the place it was made in", async () => {
    const ids = [newId("t"), newId("t"), newId("t")];
    const seq = submit(fx.claude, [
      { kind: "task.create", id: ids[0], title: "Fixture batch 0", project: fx.project },
      { kind: "task.create", id: ids[1], title: "Fixture batch 1", area: fx.areas.home },
      { kind: "task.create", id: ids[2], title: "Fixture batch 2", project: fx.project },
    ] as Operation[]);
    const line = only((await activity()).lines, seq);
    expect(line.count).toBe(3);
    expect(line.targets.map((t) => [t.id, t.created, t.acts])).toEqual([
      [ids[0], true, [{ op: "task.create", to: "Portal" }]],
      [ids[1], true, [{ op: "task.create", to: "Home" }]],
      [ids[2], true, [{ op: "task.create", to: "Portal" }]],
    ]);
  });

  test("a finish that makes a follow-up names both, each with what happened to it", async () => {
    const task = create(fx.codex, "Fixture finished with a follow-up");
    const next = newId("t");
    const seq = submit(fx.codex, [
      { kind: "task.complete", task },
      { kind: "task.create", id: next, title: "Fixture follow-up" },
    ]);
    const line = only((await activity()).lines, seq);
    expect(line.targets.map((t) => [t.id, t.name, t.created === true])).toEqual([
      [task, "Fixture finished with a follow-up", false],
      [next, "Fixture follow-up", true],
    ]);
    expect(opsOf(line)).toEqual({ [task]: ["task.complete"], [next]: ["task.create"] });
  });

  test("free text says that it changed, never what it says; a move names where", async () => {
    const task = create(fx.codex, "Fixture text task", { area: fx.areas.home });
    const text = submit(fx.codex, [
      { kind: "task.patch", task, set: { summary: "Fixture words that stay off the line" } },
    ]);
    const waiting = submit(fx.codex, [
      { kind: "task.patch", task, set: { waiting_on: "Fixture person waited on" } },
    ]);
    const moved = submit(fx.codex, [{ kind: "task.move", task, project: fx.project }]);
    const { lines } = await activity();
    expect(only(lines, text).targets[0]?.acts).toEqual([{ op: "task.patch", field: "summary" }]);
    expect(only(lines, waiting).targets[0]?.acts).toEqual([
      { op: "task.patch", field: "waiting_on" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Fixture words");
    expect(JSON.stringify(lines)).not.toContain("Fixture person waited on");
    expect(only(lines, moved).targets[0]?.acts).toEqual([
      { op: "task.move", field: "grouping", from: "Home", to: "Portal" },
    ]);
  });

  test("the Inbox flag reads as a flag, both ways", async () => {
    const task = create(fx.codex, "Fixture inbox task", { inbox: false });
    const into = submit(fx.codex, [{ kind: "task.patch", task, set: { inbox: true } }]);
    const out = submit(fx.codex, [{ kind: "task.patch", task, set: { inbox: false } }]);
    const { lines } = await activity();
    expect(only(lines, into).targets[0]?.acts).toEqual([
      { op: "task.patch", field: "inbox", from: false, to: true },
    ]);
    expect(only(lines, out).targets[0]?.acts).toEqual([
      { op: "task.patch", field: "inbox", from: true, to: false },
    ]);
  });

  test("a change to a project names the project; a task's note and Trash name their task", async () => {
    const renamed = submit(fx.codex, [
      { kind: "project.patch", project: fx.project, set: { title: "Fixture portal renamed" } },
    ]);
    const task = create(fx.codex, "Fixture finished by an agent");
    const note = submit(fx.codex, [{ kind: "note.add", task, body: "Fixture note body" }]);
    const trashed = submit(fx.codex, [{ kind: "task.delete", task }]);
    const { lines } = await activity();
    expect(only(lines, renamed).targets).toEqual([
      {
        kind: "project",
        id: fx.project,
        name: "Fixture portal renamed",
        acts: [{ op: "project.patch", field: "title" }],
      },
    ]);
    expect(opsOf(only(lines, note))).toEqual({ [task]: ["note.add"] });
    expect(only(lines, trashed).targets).toMatchObject([{ id: task, trash: true }]);
    expect(JSON.stringify(lines)).not.toContain("Fixture note body");
  });

  test("pages by commit number: older ones before the last, newer ones after the first, none twice", async () => {
    for (let i = 0; i < 7; i += 1) create(fx.codex, `Fixture paged ${String(i)}`);
    const every = (await activity({ limit: 200 })).lines;
    const seen: number[] = [];
    let page = await activity({ limit: 3 });
    seen.push(...page.lines.map((l) => l.seq));
    while (page.more) {
      page = await activity({ limit: 3, before: seen.at(-1) });
      seen.push(...page.lines.map((l) => l.seq));
    }
    expect(seen).toEqual(every.map((l) => l.seq));

    const top = every[0]?.seq ?? 0;
    expect(await activity({ after: top })).toEqual({ lines: [], more: false });
    const fresh = [create(fx.claude, "Fixture newer 1"), create(fx.claude, "Fixture newer 2")];
    const newer = await activity({ after: top, limit: 1 });
    expect(newer.more).toBe(true);
    expect(newer.lines.map((l) => l.targets[0]?.id)).toEqual([fresh[0]]);
    const rest = await activity({ after: newer.lines[0]?.seq });
    expect(rest).toMatchObject({ more: false, lines: [{ targets: [{ id: fresh[1] }] }] });
  });
});
