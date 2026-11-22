// `ttasks undo` and `ttasks redo` as a person reads them (A1 3.10.1, A2 3.10.2, 3.10.3; A7 3.10
// M3.02): the change taken back and redone, named with its tasks and the space, the part a partial
// undo kept, and the exit codes of the user-only rule and of nothing to redo. The CLI in this
// process against a service in this process; fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("cu");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** `ttasks <args>` from a terminal (the person), or from a script. */
const tasks = (args: readonly string[], terminal = true): Promise<Ran> =>
  runMain(args, { home: w.home, tty: terminal });

describe("[A3.3.2.3.history] ttasks undo and ttasks redo", () => {
  test(
    "the person undoes and redoes; a script is refused; nothing to redo is not found",
    async () => {
      expect((await tasks(["add", "Fixture task"])).code).toBe(0);
      expect((await tasks(["set", "M-1", "summary=Fixture next step"])).code).toBe(0);
      const undone = await tasks(["undo"]);
      expect(undone.code).toBe(0);
      expect(undone.stdout).toBe("Undid your change to M-1 in Mira\n");
      const redone = await tasks(["redo"]);
      expect(redone.stdout).toBe("Redid your change to M-1 in Mira\n");

      // Another actor changes the field: the undo stops, and a partial one keeps it.
      expect((await tasks(["set", "M-1", "summary=Fixture second step", "priority=1"])).code).toBe(
        0,
      );
      expect((await tasks(["set", "M-1", "summary=Fixture script step"], false)).code).toBe(0);
      // The other actor is a script: --yes undoes the person's older change without asking.
      const stopped = await tasks(["undo", "--yes"]);
      expect(stopped.code).toBe(EXIT_CODES.conflict);
      expect(stopped.stderr).toMatch(
        /^error conflict: .*Undo the rest with ttasks undo --partial, or set the value again\.$/m,
      );
      const partial = await tasks(["undo", "--partial", "--yes"]);
      expect(partial.stdout).toMatch(
        /^Undid part of your change to M-1 in Mira\nKept as others set them:\n {2}M-1 summary: script at \S+\n$/,
      );

      // A script is not the person: user-only.
      expect((await tasks(["undo"], false)).code).toBe(EXIT_CODES.forbidden);
      // A new change ends the redo.
      expect((await tasks(["set", "M-1", "priority=2"])).code).toBe(0);
      const nothing = await tasks(["redo", "--json"]);
      expect(nothing.code).toBe(EXIT_CODES.not_found);
      expect(JSON.parse(nothing.stdout)).toMatchObject({
        error: { code: "not_found", data: { cause: "NOTHING_TO_REDO" } },
      });
    },
    LONG,
  );
});
