// The person corrects an agent's note and log entry through real requests: `entry.edit` as the
// person, every read giving the corrected words with the mark of who corrected them, Undo putting
// the words before back without the mark, and agents refused. Fixture text only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;

let w: ContractWorld & { root: string };
const LONG = 180_000;

beforeAll(async () => {
  w = await contractWorld("correct-entry");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const PERSON: Caller = { class: "cli-interactive", env: {} };
/** An agent's shell (it carries an agent marker) in the world's space. */
const SHELL: Caller = {
  class: "cli-agent",
  env: {
    get TTASKS_SPACE() {
      return w.space;
    },
  },
};

let n = 0;
const rid = () => `fixture-correct-${String((n += 1)).padStart(6, "0")}`;
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
const edit = async (task: string, entry: string, text: string, base?: string) =>
  call("entry.edit", { task, entry, text, base: base ?? (await asOf()), request_id: rid() });

/** A task with an agent's note n1 and its progress entry l1. */
async function written(word: string): Promise<string> {
  const added = await call("task.add", {
    tasks: [{ title: `Fixture correct ${word}` }],
    request_id: rid(),
  });
  const task = (added["tasks"] as { ref: string }[])[0]?.ref ?? "";
  await call(
    "entry.add",
    { task, kind: "note", text: `Fixture drafted teh ${word}`, request_id: rid() },
    SHELL,
  );
  await call(
    "entry.add",
    { task, kind: "progress", text: `Fixture checked teh ${word}`, request_id: rid() },
    SHELL,
  );
  return task;
}

const sections = (task: string, who: Caller = PERSON) =>
  call("task.get", { task, sections: ["notes", "log"] }, who);
const entries = (read: Json, section: "notes" | "log"): Json[] =>
  ((read["sections"] as Json)[section] as Json[] | undefined) ?? [];

describe("[A3.entry.correct] the person corrects an agent's note and log entry through real requests", () => {
  test("the corrected words are what every read gives, marked as corrected by the person; Undo puts the words before back without the mark", async () => {
    const task = await written("a");
    expect(await edit(task, "n1", "Fixture drafted the a")).toMatchObject({
      result: "edited",
      task,
      entry: "n1",
    });
    expect(await edit(task, "l1", "Fixture checked the a")).toMatchObject({
      result: "edited",
      entry: "l1",
    });
    for (const who of [PERSON, SHELL]) {
      const read = await sections(task, who);
      expect(entries(read, "notes")).toMatchObject([
        { ref: "n1", text: "Fixture drafted the a", edited: { by: "user" } },
      ]);
      expect(entries(read, "log")).toMatchObject([
        { ref: "l1", text: "Fixture checked the a", edited: { by: "user" } },
      ]);
      // The author stays the agent's.
      expect(entries(read, "log")[0]?.["author"]).not.toBe("user");
    }
    await call("history.undo", { request_id: rid() });
    const back = entries(await sections(task), "log")[0];
    expect(back).toMatchObject({ text: "Fixture checked teh a" });
    expect(back).not.toHaveProperty("edited");
    await call("history.redo", { request_id: rid() });
    expect(entries(await sections(task), "log")[0]).toMatchObject({
      text: "Fixture checked the a",
      edited: { by: "user" },
    });
  });

  test("the same words are no change, a stale base is a conflict, and a removed note is not found", async () => {
    const task = await written("b");
    const seen = await asOf();
    expect(await edit(task, "n1", "Fixture drafted teh b")).toMatchObject({ result: "no_change" });
    await edit(task, "n1", "Fixture drafted the b");
    expect(
      await refusal("entry.edit", {
        task,
        entry: "n1",
        text: "Fixture drafted the bb",
        base: seen,
        request_id: rid(),
      }),
    ).toMatchObject({ code: "conflict" });
    await call("note.remove", { task, remove: "1", base: await asOf(), request_id: rid() });
    expect(
      await refusal("entry.edit", {
        task,
        entry: "n1",
        text: "Fixture drafted the b again",
        base: await asOf(),
        request_id: rid(),
      }),
    ).toMatchObject({ code: "not_found" });
  });

  test("an agent's shell is refused in words", async () => {
    const task = await written("c");
    const refused = await refusal(
      "entry.edit",
      { task, entry: "l1", text: "Fixture rewritten", base: await asOf(), request_id: rid() },
      SHELL,
    );
    expect(refused).toMatchObject({ code: "forbidden", data: { rule: "user_only" } });
    expect(entries(await sections(task), "log")[0]).toMatchObject({
      text: "Fixture checked teh c",
    });
  });
});
