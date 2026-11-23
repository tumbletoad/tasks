// `ttasks note <task> --remove <n>` and `--put-back <n>` as a person reads them: on `note`, so a
// missing or mistyped number never reaches the task itself; `ttasks show` lists what was taken
// back, to the person only; an agent's shell is refused. The CLI in this process against a service
// in this process; fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("cretract");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const person = (args: readonly string[]): Promise<Ran> =>
  runMain(args, { home: w.home, tty: true });
const agentShell = (args: readonly string[]): Promise<Ran> =>
  runMain([...args, "--space", w.space], { home: w.home, tty: true, env: { CLAUDECODE: "1" } });

async function noted(title: string): Promise<string> {
  const added = await person(["add", title, "--json"]);
  expect(added.code, added.stderr).toBe(0);
  const task = (JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";
  expect((await person(["note", task, "Fixture first note"])).code).toBe(0);
  expect((await person(["note", task, "Fixture note for another task"])).code).toBe(0);
  return task;
}

describe("[A3.note.retract.cli] ttasks note --remove and --put-back", () => {
  test(
    "the person takes a note back and puts it back; show lists it meanwhile, with the way back",
    async () => {
      const task = await noted("Fixture retract at the terminal");
      const removed = await person(["note", task, "--remove", "2"]);
      expect(removed.code, removed.stderr).toBe(0);
      expect(removed.stdout).toBe(
        `Removed note n2 from ${task} in Mira: put it back with ttasks note ${task} --put-back 2\n`,
      );
      expect((await person(["note", task, "--remove", "n2"])).stdout).toBe(
        `No change to note n2 on ${task} in Mira\n`,
      );
      const shown = await person(["show", task, "--section", "notes"]);
      expect(shown.stdout).toContain("Fixture first note");
      expect(shown.stdout).not.toContain("Fixture note for another task");
      const digest = await person(["show", task]);
      expect(digest.stdout).toMatch(
        /\n {2}n2 removed \S+ by user: Fixture note for another task\nPut a note back with ttasks note M-\d+ --put-back <number>\n/u,
      );

      const back = await person(["note", task, "--put-back", "2"]);
      expect(back.code, back.stderr).toBe(0);
      expect(back.stdout).toBe(`Put back note n2 on ${task} in Mira\n`);
      expect((await person(["show", task])).stdout).not.toContain("removed");
      // The note verb still writes a note.
      expect((await person(["note", task, "Fixture third note"])).stdout).toContain("Noted n3");
    },
    LONG,
  );

  test(
    "a missing or mistyped note number removes nothing, and never the task",
    async () => {
      const task = await noted("Fixture mistyped number");
      const missing = await person(["note", task, "--remove"]);
      expect(missing.code).toBe(EXIT_CODES.usage);
      const wrong = await person(["note", task, "--remove", "9"]);
      expect(wrong.code).toBe(EXIT_CODES.not_found);
      const word = await person(["note", task, "--remove", "all"]);
      expect(word.code).toBe(EXIT_CODES.usage);
      const shown = await person(["show", task, "--section", "notes"]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).not.toContain("In the Trash");
      expect(shown.stdout).toContain("Fixture note for another task");
    },
    LONG,
  );

  test(
    "an agent's shell is refused, and its show never lists what the person took back",
    async () => {
      const task = await noted("Fixture agent shell and notes");
      const refused = await agentShell(["note", task, "--remove", "2"]);
      expect(refused.code).toBe(EXIT_CODES.forbidden);
      expect(refused.stderr).toContain("agents cannot remove notes");
      expect((await person(["note", task, "--remove", "2"])).code).toBe(0);
      const shown = await agentShell(["show", task]);
      expect(shown.stdout).not.toContain("Fixture note for another task");
      expect(shown.stdout).not.toContain("removed");
      expect((await agentShell(["note", task, "--put-back", "2"])).code).toBe(EXIT_CODES.forbidden);
    },
    LONG,
  );
});
