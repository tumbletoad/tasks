// A note the person takes back, through real requests: `note.remove` as the person at a terminal,
// every read of notes skipping the note from then on, the person's read listing it with who took it
// back, and agents refused. Fixture text only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { renderResult } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;

let w: ContractWorld & { root: string };
const LONG = 180_000;

beforeAll(async () => {
  w = await contractWorld("retract-note");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const PERSON: Caller = { class: "cli-interactive", env: {} };
/** An agent's shell (it carries an agent marker) in the world's space, and a script. */
const SHELL: Caller = {
  class: "cli-agent",
  env: {
    get TTASKS_SPACE() {
      return w.space;
    },
  },
};
const SCRIPT: Caller = { class: "cli-script", env: {} };

let n = 0;
const rid = () => `fixture-retract-${String((n += 1)).padStart(6, "0")}`;
const call = async (op: string, input: Json, who: Caller = PERSON): Promise<Json> =>
  (await opCall(w.service.ops, who, { op, input })) as Json;
async function refusal(op: string, input: Json, who: Caller = PERSON): Promise<ErrorBody> {
  const error = await call(op, input, who).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.toBody();
}
const asOf = async () => (await call("space.status", {}))["as_of"] as string;
const remove = async (task: string, note: string, extra: Json = {}) =>
  call("note.remove", { task, remove: note, base: await asOf(), request_id: rid(), ...extra });
const putBack = async (task: string, note: string) =>
  call("note.remove", { task, put_back: note, base: await asOf(), request_id: rid() });
const note = (task: string, text: string, extra: Json = {}) =>
  call("entry.add", { task, kind: "note", text, request_id: rid(), ...extra });

/** A task with three notes: n1 to agents, n2 and n3 the person's own. */
async function noted(word: string): Promise<string> {
  const added = await call("task.add", {
    tasks: [{ title: `Fixture retract ${word}` }],
    request_id: rid(),
  });
  const task = (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
  await note(task, `Fixture to agents ${word}`, { for_agents: true });
  await note(task, `Fixture wrongword${word} meant for another task`);
  await note(task, `Fixture kept ${word}`);
  return task;
}

/** Every note text a read gives, from its digest, its sections and the notes it names. */
function texts(read: Json): string[] {
  const task = (read["task"] ?? {}) as Json;
  const sections = (read["sections"] ?? {}) as Json;
  return [
    task["instructions"],
    task["notes"],
    sections["instructions"],
    sections["notes"],
    read["notes"],
  ].flatMap((list) => ((list as Json[] | undefined) ?? []).map((n) => String(n["text"])));
}

describe("[A3.note.retract] a note taken back through real requests", () => {
  test("the person takes a note back by its number; every read skips it, and the person's read lists it to put back", async () => {
    const task = await noted("a");
    const removed = await remove(task, "2");
    expect(removed).toMatchObject({ result: "removed", task, note: "n2" });

    const digest = await call("task.get", { task });
    expect(texts(digest)).not.toContain("Fixture wrongworda meant for another task");
    expect(((digest["task"] as Json)["more"] as Json)["notes"]).toBe(0);
    expect(digest["removed_notes"]).toMatchObject([
      {
        ref: "n2",
        author: "user",
        text: "Fixture wrongworda meant for another task",
        removed: { by: "user" },
      },
    ]);
    const sections = await call("task.get", { task, sections: ["instructions", "notes"] });
    expect(texts(sections)).toEqual(["Fixture to agents a", "Fixture kept a"]);
    expect(sections).not.toHaveProperty("removed_notes");
    // Named by its reference, as a session's request is read, it is not there.
    expect(texts(await call("task.get", { task, notes: ["n2", "n3"] }))).not.toContain(
      "Fixture wrongworda meant for another task",
    );
    const found = await call("task.search", { q: "wrongworda", scope: "all" });
    expect(found["rows"]).toEqual([]);

    // Put back: the same note, with its number and author, read and found again.
    expect(await putBack(task, "n2")).toMatchObject({ result: "put_back", note: "n2" });
    const back = await call("task.get", { task, notes: ["n2"] });
    expect(back["notes"]).toMatchObject([{ ref: "n2", author: "user", for_agents: false }]);
    expect(back).not.toHaveProperty("removed_notes");
    const again = await call("task.search", { q: "wrongworda", scope: "all" });
    expect((again["rows"] as Json[]).map((r) => r["ref"])).toContain(task);
  });

  test("a note to agents taken back is no instruction any more, and an agent's read never lists what was taken back", async () => {
    const task = await noted("b");
    await remove(task, "n1");
    const read = await call("task.get", { task }, SHELL);
    expect(texts(read)).toEqual(["Fixture kept b", "Fixture wrongwordb meant for another task"]);
    expect(read).not.toHaveProperty("removed_notes");
    const text = renderResult("task.get", read);
    expect(text).not.toContain("Fixture to agents b");
    expect(renderResult("task.get", await call("task.get", { task }, SCRIPT))).not.toContain(
      "Fixture to agents b",
    );
  });

  test("a repeat is no change, a stale base is a conflict, and a number the task has no note under removes nothing", async () => {
    const task = await noted("c");
    const seen = await asOf();
    await remove(task, "3");
    expect(await remove(task, "3")).toMatchObject({ result: "no_change", note: "n3" });
    await putBack(task, "3");
    expect(
      await refusal("note.remove", {
        task,
        remove: "3",
        base: seen,
        request_id: rid(),
      }),
    ).toMatchObject({ code: "conflict" });
    const missing = await refusal("note.remove", {
      task,
      remove: "9",
      base: await asOf(),
      request_id: rid(),
    });
    expect(missing).toMatchObject({ code: "not_found" });
    expect(
      await refusal("note.remove", { task, base: await asOf(), request_id: rid() }),
    ).toMatchObject({
      code: "invalid_input",
    });
    // The task is where it was, with every note.
    const read = await call("task.get", { task });
    expect((read["task"] as Json)["deleted"]).toBeUndefined();
    expect(texts(read)).toHaveLength(3);
  });

  test("an agent's shell and a script are refused in words", async () => {
    const task = await noted("d");
    for (const who of [SHELL, SCRIPT]) {
      const refused = await refusal(
        "note.remove",
        { task, remove: "2", base: await asOf(), request_id: rid() },
        who,
      );
      expect(refused).toMatchObject({ code: "forbidden", data: { rule: "user_only" } });
      expect(refused.message).toBe(
        "Only the user takes back a note or puts one back: agents cannot remove notes.",
      );
    }
  });
});
