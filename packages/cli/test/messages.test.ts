// What the CLI says when something did not go as the person meant (A3 3.4.8, 3.5, 3.7.4): a task
// finished already, a required flag left out, and an undo that a newer change by a script does not
// reach. The CLI in this process against a service in this process; fixture text and temporary
// folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES } from "@tasks/contracts";
import { contractWorld, type ContractWorld } from "@tasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("cm");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** `tasks <args>` from a terminal (the person), or from a script. */
const tasks = (args: readonly string[], terminal = true, stdin?: string): Promise<Ran> =>
  runMain(args, { home: w.home, tty: terminal, ...(stdin === undefined ? {} : { stdin }) });

describe("[A3.3.4.finish.already-wrapped] tasks done on a finished task", () => {
  test(
    "no outcome: already completed, exit 0; another outcome: a conflict that says so, never a stale base",
    async () => {
      expect((await tasks(["add", "Fixture finished task"])).stdout).toBe("Added M-1 to Mira\n");
      const done = await tasks(["done", "M-1", "--outcome", "Fixture outcome one"]);
      expect(done.code).toBe(0);
      expect(done.stdout).toBe("Completed M-1 in Mira\n");

      const again = await tasks(["done", "M-1"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toBe("M-1 is already completed in Mira\n");
      // The same outcome again changes nothing either.
      expect((await tasks(["done", "M-1", "--outcome", "Fixture outcome one"])).stdout).toBe(
        "M-1 is already completed in Mira\n",
      );

      const other = await tasks(["done", "M-1", "--outcome", "Fixture outcome two"]);
      expect(other.code).toBe(EXIT_CODES.conflict);
      expect(other.stdout).toBe("");
      expect(other.stderr).toMatch(
        /^request \S+\nerror conflict: The task is already wrapped up with another outcome or other learnings, so nothing was changed\. To add to it, log an entry: add_entry \(tasks log\)\. To finish it again, reopen it first: reopen_task \(tasks reopen\)\.\n {2}M-1 wrap: user at \S+\n$/,
      );
      expect(other.stderr).not.toContain("base");
    },
    LONG,
  );
});

describe("[A3.3.5.error-text] a required flag left out", () => {
  test(
    "the CLI names the flag before any call; --input without it is reported missing, not a wrong type",
    async () => {
      const bare = await tasks(["reopen", "M-1"]);
      expect(bare.code).toBe(EXIT_CODES.usage);
      expect(bare.stderr).toMatch(/^error invalid_input: tasks reopen needs --reason\. /);

      const input = await tasks(["reopen", "--input", "-", "--json"], true, '{"task":"M-1"}');
      expect(input.code).toBe(EXIT_CODES.usage);
      expect(JSON.parse(input.stdout)).toMatchObject({
        error: {
          code: "invalid_input",
          data: { issues: [{ path: "reason", message: "Missing" }] },
        },
      });
    },
    LONG,
  );
});

describe("[A3.3.7.actors.script-undo-note] tasks undo after a script's change", () => {
  test(
    "the person's own change is undone, and a newer change by a script is named in one line",
    async () => {
      expect((await tasks(["add", "Fixture second task"])).stdout).toBe("Added M-2 to Mira\n");
      expect((await tasks(["add", "Fixture third task"])).stdout).toBe("Added M-3 to Mira\n");
      expect((await tasks(["set", "M-2", "priority=1"])).code).toBe(0);
      // A script (no terminal) completes M-3: the actor `script`, on no undo stack.
      const scripted = await tasks(["done", "M-3", "--outcome", "Fixture script outcome"], false);
      expect(scripted.code).toBe(0);

      const undone = await tasks(["undo"]);
      expect(undone.code).toBe(0);
      expect(undone.stdout).toBe(
        "Undid your change to M-2 in Mira\n" +
          "Not undone: a script completed M-3 after that, and a script's changes are not on your undo stack.\n",
      );

      // A change of the person's after the script's: its undo has nothing more to say.
      expect((await tasks(["set", "M-2", "priority=2"])).code).toBe(0);
      const json = await tasks(["undo", "--json"]);
      expect(json.code).toBe(0);
      const result = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(result).toMatchObject({ result: "undone", tasks: ["M-2"] });
      expect(result).not.toHaveProperty("script_change");
      // The script's completion still stands.
      expect((await tasks(["done", "M-3"])).stdout).toBe("M-3 is already completed in Mira\n");
    },
    LONG,
  );
});
