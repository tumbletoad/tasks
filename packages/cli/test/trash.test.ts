// `ttasks delete`, `ttasks restore` and `ttasks trash` as a person reads them, and an agent's shell
// refused. The CLI in this process against a service in this process; fixture text and temporary
// folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("ctrash");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const person = (args: readonly string[], stdin?: string): Promise<Ran> =>
  runMain(args, { home: w.home, tty: true, ...(stdin === undefined ? {} : { stdin }) });

async function add(title: string): Promise<string> {
  const added = await person(["add", title, "--json"]);
  expect(added.code, added.stderr).toBe(0);
  return (JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";
}

describe("[A3.trash.cli] ttasks delete, restore and trash", () => {
  test(
    "the person moves two tasks to the Trash in one command, lists them under that change, and restores one",
    async () => {
      const [a, b] = [await add("Fixture trash first"), await add("Fixture trash second")];
      const moved = await person(["delete", a, b]);
      expect(moved.code, moved.stderr).toBe(0);
      expect(moved.stdout).toBe(`Moved ${a} and ${b} to the Trash in Mira\n`);
      const again = await person(["delete", a]);
      expect(again.stdout).toBe(`${a} was in the Trash already\n`);

      const listed = await person(["trash"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toMatch(
        new RegExp(
          `^You moved 2 tasks here, \\S+ · (op_[0-9a-z]{26})\\n  ${a}  Fixture trash first\\n  ${b}  Fixture trash second\\n$`,
          "u",
        ),
      );
      expect((await person(["trash", "SECOND"])).stdout).toContain(`  ${b}  Fixture trash second`);
      expect((await person(["show", a])).stdout).toMatch(
        new RegExp(
          `\\nIn the Trash: You moved it there at \\S+\\. Restore it with ttasks restore ${a}`,
          "u",
        ),
      );

      const back = await person(["restore", a]);
      expect(back.code, back.stderr).toBe(0);
      expect(back.stdout).toBe(`${a} is back in Open\n`);
      const change = /op_[0-9a-z]{26}/u.exec(listed.stdout)?.[0] ?? "";
      const rest = await person(["restore", "--change", change]);
      expect(rest.stdout).toBe(
        `${b} is back in Open\n${a} was back already, or moved to the Trash again since\n`,
      );
      expect((await person(["trash"])).stdout).toBe("Nothing in the Trash in Mira\n");
    },
    LONG,
  );

  test(
    "an agent's shell is refused: removing tasks is the person's",
    async () => {
      const a = await add("Fixture agent shell");
      const refused = await runMain(["delete", a, "--space", w.space], {
        home: w.home,
        tty: true,
        env: { CLAUDECODE: "1" },
      });
      expect(refused.code).toBe(EXIT_CODES.forbidden);
      expect(refused.stderr).toContain("agents cannot remove tasks yet");
      expect((await person(["show", a])).stdout).not.toContain("In the Trash");
    },
    LONG,
  );
});
