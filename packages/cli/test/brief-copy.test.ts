// `ttasks brief --copy` and `ttasks brief --pack` as a person reads them (A4 3.4.6, 3.15.5; A7 3.14
// M6.11): the text goes to the clipboard through the clipboard seam, which stands in for the OS's
// tool (no test touches the machine's clipboard), and the CLI says so; with no tool, or a tool
// that fails, it says why and prints the text, never a copy that did not happen. The CLI in this
// process against a service in this process; fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { CopyResult } from "@ttasks/launch";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("cb");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** `tasks <args>` from a terminal, with a clipboard that answers `answer` and records the text. */
async function tasks(
  args: readonly string[],
  answer?: CopyResult,
): Promise<Ran & { copied: string[] }> {
  const copied: string[] = [];
  const ran = await runMain(args, {
    home: w.home,
    tty: true,
    main: {
      clipboard: (text) => {
        copied.push(text);
        return Promise.resolve(answer ?? { status: "copied", tool: "xclip" });
      },
    },
  });
  return { ...ran, copied };
}

describe("[A4.5.brief.copy-cli] ttasks brief --copy and --pack", () => {
  test(
    "--copy puts the pointer brief on the clipboard and says so; --pack prints the context pack",
    async () => {
      expect((await tasks(["add", "Fixture task for the brief"])).code).toBe(0);
      const copied = await tasks(["brief", "M-1", "--copy"]);
      expect(copied.code).toBe(0);
      expect(copied.copied).toHaveLength(1);
      expect(copied.copied[0]).toMatch(/^TTasks task M-1 \(launch L[0-9A-Z]{5}\)\./u);
      expect(copied.stdout).toMatch(/^Brief copied to the clipboard \(launch L[0-9A-Z]{5}\)\.\n$/u);
      expect(copied.stdout).not.toContain("Fixture task");

      // Without --copy the brief is printed, and the clipboard is not touched.
      const printed = await tasks(["brief", "M-1"]);
      expect(printed.copied).toEqual([]);
      expect(printed.stdout).toMatch(/^TTasks task M-1 \(launch L[0-9A-Z]{5}\)\./u);

      const pack = await tasks(["brief", "M-1", "--pack"]);
      expect(pack.code).toBe(0);
      expect(pack.stdout).toMatch(/^TTasks context pack for task M-1 \(launch L[0-9A-Z]{5}\)/u);
      expect(pack.stdout).toContain("```ttasks-update\ntask: M-1\n");

      const packed = await tasks(["brief", "M-1", "--pack", "--copy"]);
      expect(packed.copied[0]).toMatch(/^TTasks context pack for task M-1/u);
      expect(packed.stdout).toMatch(
        /^Context pack copied to the clipboard \(launch L[0-9A-Z]{5}\)\.\n$/u,
      );
    },
    LONG,
  );

  test(
    "with no tool, or a tool that fails, it says why on stderr and prints the brief",
    async () => {
      expect((await tasks(["add", "Fixture task without a clipboard"])).code).toBe(0);
      const none = await tasks(["brief", "M-1", "--copy"], { status: "failed", reason: "no_tool" });
      expect(none.code).toBe(0);
      expect(none.stderr.split("\n").slice(-2)).toEqual([
        "Not copied: No clipboard tool was found: install wl-clipboard (Wayland), xclip or xsel. The brief follows.",
        "",
      ]);
      expect(none.stdout).toMatch(/^TTasks task M-1 /u);
      const failed = await tasks(["brief", "M-1", "--copy"], {
        status: "failed",
        reason: "failed",
        tool: "set-clipboard",
        code: 1,
      });
      expect(failed.stderr).toBe(
        "Not copied: Set-Clipboard failed (exit code 1). The brief follows.\n",
      );
      expect(failed.stdout).toMatch(/^TTasks task M-1 /u);
      const session = await tasks(["brief", "M-1", "--copy"], {
        status: "failed",
        reason: "no_session",
      });
      expect(session.stderr).toContain("no desktop session");
    },
    LONG,
  );
});
