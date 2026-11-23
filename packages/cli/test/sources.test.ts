// `ttasks set --remove-source` and `--put-back-source` as a person reads them, and `ttasks show`
// listing each source's ID and the detached ones. The CLI in this process against a service in
// this process; fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("csrc");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const tasks = (args: readonly string[], stdin?: string): Promise<Ran> =>
  runMain(args, { home: w.home, tty: true, ...(stdin === undefined ? {} : { stdin }) });

describe("[A3.source.detach] ttasks set --remove-source and --put-back-source", () => {
  test(
    "the person detaches by key, show lists it with its ID, an ambiguous URL names the IDs, put back by ID",
    async () => {
      const url = "https://tickets.example/same";
      const draft = {
        tasks: [
          {
            title: "Fixture wrong source",
            sources: [
              { kind: "ticket", key: "fix:CLI-1", title: "Fixture printer ticket" },
              { kind: "issue", title: "Fixture first", url },
              { kind: "issue", title: "Fixture second", url },
            ],
          },
        ],
      };
      const added = await tasks(["add", "--input", "-", "--json"], JSON.stringify(draft));
      expect(added.code).toBe(0);
      const ref = (JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";

      const shown = await tasks(["show", ref, "--section", "sources"]);
      expect(shown.code).toBe(0);
      const ids = [...shown.stdout.matchAll(/s_[0-9a-z]{26}/gu)].map((m) => m[0]);
      expect(ids).toHaveLength(3);
      expect(shown.stdout).toContain("source: Fixture printer ticket [fix:CLI-1 · ");

      const detached = await tasks(["set", ref, "--remove-source", "fix:CLI-1"]);
      expect(detached.code, detached.stderr).toBe(0);
      const after = await tasks(["show", ref, "--section", "sources"]);
      expect(after.stdout).toMatch(
        /^ {2}detached \d{4}-\d{2}-\d{2} by user: Fixture printer ticket \[fix:CLI-1 · s_/mu,
      );

      const both = await tasks(["set", ref, "--remove-source", url]);
      expect(both.code).toBe(EXIT_CODES.not_found);
      expect(both.stderr).toContain(ids[1] ?? "?");
      expect(both.stderr).toContain(ids[2] ?? "?");

      const back = await tasks(["set", ref, "--put-back-source", ids[0] ?? ""]);
      expect(back.code, back.stderr).toBe(0);
      const again = await tasks(["show", ref, "--section", "sources"]);
      expect(again.stdout).not.toContain("detached");
    },
    LONG,
  );
});
