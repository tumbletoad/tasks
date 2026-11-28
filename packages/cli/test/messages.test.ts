// What the CLI says when something did not go as the person meant (A3 3.4.8, 3.5, 3.7.4): a task
// finished already, a required flag left out, and an undo that a newer change by a script does not
// reach. The CLI in this process against a service in this process; fixture text and temporary
// folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("cm");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** `ttasks <args>` from a terminal (the person), or from a script. */
const tasks = (args: readonly string[], terminal = true, stdin?: string): Promise<Ran> =>
  runMain(args, { home: w.home, tty: terminal, ...(stdin === undefined ? {} : { stdin }) });

describe("[A3.3.4.finish.already-wrapped] ttasks done on a finished task", () => {
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
      // The way out in the commands a person types, never an agent's tools, and no request ID:
      // a retry would not help.
      expect(other.stderr).toMatch(
        /^error conflict: The task is already wrapped up with another outcome or other learnings, so nothing was changed\. To add to it, log an entry: ttasks log M-1 <text>\. To finish it again, reopen it first: ttasks reopen M-1 --reason <why>\.\n {2}M-1 wrap: user at \S+\n$/,
      );
      expect(other.stderr).not.toContain("base");
    },
    LONG,
  );
});

describe("[A3.3.5.error-text] a required flag left out", () => {
  test(
    "a field a script must give is named by its path and reported missing, not a wrong type; the person may leave it out",
    async () => {
      const bare = await tasks(["reopen", "M-1"], false);
      expect(bare.code).toBe(EXIT_CODES.usage);
      expect(bare.stderr).toMatch(/^error invalid_input: /m);
      expect(bare.stderr).toContain("reason");

      const input = await tasks(["reopen", "--input", "-", "--json"], false, '{"task":"M-1"}');
      expect(input.code).toBe(EXIT_CODES.usage);
      expect(JSON.parse(input.stdout)).toMatchObject({
        error: {
          code: "invalid_input",
          data: { issues: [{ path: "reason", message: "Missing" }] },
        },
      });

      const person = await tasks(["reopen", "M-1"]);
      expect(person.code).toBe(0);
      expect(person.stdout).toContain("M-1");
    },
    LONG,
  );
});

describe("[A3.3.7.actors.script-undo-note] ttasks undo after a script's change", () => {
  test(
    "undo asks before it takes back an older change of the person's, and names the script's newer one",
    async () => {
      expect((await tasks(["add", "Fixture second task"])).stdout).toBe("Added M-2 to Mira\n");
      expect((await tasks(["add", "Fixture third task"])).stdout).toBe("Added M-3 to Mira\n");
      expect((await tasks(["set", "M-2", "title=Fixture second task, renamed"])).code).toBe(0);
      // A script (no terminal) completes M-3: the actor `script`, on no undo stack.
      const scripted = await tasks(["done", "M-3", "--outcome", "Fixture script outcome"], false);
      expect(scripted.code).toBe(0);

      // No one to ask: nothing is undone, and the conflict names both changes and --yes.
      const refused = await tasks(["undo"]);
      expect(refused.code).toBe(EXIT_CODES.conflict);
      expect(refused.stderr).toBe(
        "error conflict: A script changed M-3 after your newest change, so nothing was undone: an undo now would take back your older change to M-2. Undo it anyway with --yes, or leave it.\n",
      );
      const json = await tasks(["undo", "--json"]);
      expect(JSON.parse(json.stdout)).toMatchObject({
        error: {
          code: "conflict",
          data: {
            reason: "script_change_after",
            tasks: ["M-2"],
            change: "task.patch",
            script_change: { task: "M-3", change: "task.complete" },
          },
        },
      });

      const named = (JSON.parse(json.stdout) as { error: { data: { commit: string } } }).error.data
        .commit;

      // Asked on the terminal: no undoes nothing; yes undoes the change the question named.
      const questions: string[] = [];
      const interrupts: (string | undefined)[] = [];
      const answering = (answer: boolean) =>
        runMain(["undo"], {
          home: w.home,
          tty: true,
          interrupts,
          main: {
            ask: (question) => {
              questions.push(question);
              return Promise.resolve(answer);
            },
          },
        });
      const declined = await answering(false);
      expect(declined.code).toBe(EXIT_CODES.conflict);
      expect(declined.stderr).toBe("Nothing was undone.\n");
      expect(questions).toEqual([
        "A script completed M-3 after your newest change, and undo never takes back a script's change. Undo your change to M-2 (changed) instead? [y/N] ",
      ]);
      // While the question waits, Ctrl+C has no write in doubt to name.
      expect(interrupts.at(-1)).toBeUndefined();
      expect(interrupts.slice(0, 2)).toEqual([
        expect.stringMatching(/^Retry with: --request-id \S+\n$/u),
        undefined,
      ]);
      interrupts.length = 0;
      const undone = await answering(true);
      expect(undone.code, undone.stderr).toBe(0);
      // Ctrl+C while the confirmed undo is sent names the change, so the retry replays it.
      expect(interrupts).toContainEqual(
        expect.stringMatching(
          new RegExp(`^Retry with: --commit ${named} --request-id \\S+\\n$`, "u"),
        ),
      );
      expect(interrupts.at(-1)).toBeUndefined();
      expect(undone.stdout).toBe(
        "Undid your change to M-2 in Mira\n" +
          "Not undone: a script completed M-3 after that, and a script's changes are not on your undo stack.\n",
      );
      const retryId = /--request-id (\S+)/u.exec(
        interrupts.find((note) => note?.includes("--commit") === true) ?? "",
      )?.[1];
      const retried = await tasks([
        "undo",
        "--commit",
        named,
        "--request-id",
        retryId ?? "-",
        "--json",
      ]);
      expect(retried.code, retried.stdout + retried.stderr).toBe(0);
      expect(JSON.parse(retried.stdout)).toMatchObject({ replayed: true, commit: named });

      // --yes undoes without asking.
      expect((await tasks(["set", "M-2", "title=Fixture second task, again"])).code).toBe(0);
      expect((await tasks(["add", "Fixture script task"], false)).code).toBe(0);
      const yes = await tasks(["undo", "--yes"]);
      expect(yes.code, yes.stderr).toBe(0);
      expect(yes.stdout).toBe(
        "Undid your change to M-2 in Mira\n" +
          "Not undone: a script added M-4 after that, and a script's changes are not on your undo stack.\n",
      );

      // A change of the person's after the script's: its undo has nothing more to say.
      expect((await tasks(["set", "M-2", "title=Fixture second task, last"])).code).toBe(0);
      const last = await tasks(["undo", "--json"]);
      expect(last.code).toBe(0);
      const result = JSON.parse(last.stdout) as Record<string, unknown>;
      expect(result).toMatchObject({ result: "undone", tasks: ["M-2"] });
      expect(result).not.toHaveProperty("script_change");
      // The script's completion still stands.
      expect((await tasks(["done", "M-3"])).stdout).toBe("M-3 is already completed in Mira\n");
    },
    LONG,
  );
});
