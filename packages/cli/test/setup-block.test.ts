// `tasks setup agents --parts block` and `print-block` through the CLI (A3 3.12, 3.13.1, 3.14;
// A7 3.11 M4.04): the block part names no space and needs no service, so this runs the CLI in this
// process with no service at all, on scratch homes in a temporary folder. No test reads or changes
// a real agent home: detection looks only in the scratch user folder, with an empty PATH.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CLI_NAME } from "@tasks/brand";
import { stateOf, tempRoot } from "@tasks/service/test/harness";
import type { AgentsSetupOptions } from "../src/setup-agents.ts";
import { runMain } from "./cli-harness.ts";

const SLOW = 180_000;

let root: string;
let home: string;
let user: string;
let cleanup: () => void;

beforeAll(() => {
  const temp = tempRoot("sb");
  cleanup = temp.cleanup;
  root = temp.root;
  home = join(root, "h");
  user = join(root, "u");
  mkdirSync(join(user, ".claude"), { recursive: true });
  mkdirSync(join(user, ".codex"), { recursive: true });
});

afterAll(() => {
  cleanup();
});

const claudeMd = () => join(user, ".claude", "CLAUDE.md");
const agentsMd = () => join(user, ".codex", "AGENTS.md");
const blocksRecord = () => join(stateOf(home), "setup", "blocks.json");

/** The scratch user folder, an empty PATH (no app's command, no git), no other home variable. */
const agents = (): AgentsSetupOptions => ({
  env: { PATH: "", TASKS_HOME: home },
  home: user,
  systemApplications: join(root, "Applications"),
});

/** `tasks <argv>` as a person at a terminal (tty), or a script. */
const run = (argv: string[], tty = true) =>
  runMain(argv, { home, tty, main: { agents: agents() } });

interface Report {
  checks: { id: string; status: string; detail: string }[];
}

async function blockRow(): Promise<{ status: string; detail: string } | undefined> {
  const ran = await run(["doctor", "--json"], false);
  return (JSON.parse(ran.stdout) as Report).checks.find((c) => c.id === "block");
}

describe("[A3.3.12.setup.block-cli] the instruction block through the CLI", () => {
  test(
    "print-block, the preview, apply, doctor's row and remove",
    async () => {
      const mine = "# My rules\r\n\r\n- Answer briefly.\r\n";
      writeFileSync(claudeMd(), mine);

      // Usage: the part and print-block take only what they need.
      for (const argv of [
        ["setup", "agents", "--status", "--parts", "block"],
        ["setup", "agents", "print-block"],
        ["setup", "agents", "print-block", "--for", "cursor"],
        ["setup", "agents", "print-block", "--for", "claude", "--app", "codex"],
        ["setup", "agents", "--for", "claude"],
        ["setup", "agents", "--remove", "--parts", "approve-tools"],
      ]) {
        expect((await run(argv)).code, argv.join(" ")).toBe(2);
      }

      // print-block prints the block and where it goes, and writes nothing.
      const printed = await run(["setup", "agents", "print-block", "--for", "claude"], false);
      expect(printed.code, printed.stderr).toBe(0);
      expect(printed.stdout).toContain(join(user, ".claude", "CLAUDE.md"));
      expect(printed.stdout).toContain(
        "<!-- tasks:begin v1 (from tasks setup agents print-block; remove it by hand) -->",
      );
      expect(printed.stdout).toContain("<!-- tasks:end -->\nNothing was changed.\n");
      const json = await run(
        ["setup", "agents", "print-block", "--for", "agents", "--json"],
        false,
      );
      expect(JSON.parse(json.stdout)).toMatchObject({
        for: "agents",
        files: [agentsMd(), join(user, ".codex", "AGENTS.override.md")],
      });
      expect(readFileSync(claudeMd(), "utf8")).toBe(mine);
      expect(existsSync(agentsMd())).toBe(false);
      expect(existsSync(stateOf(home))).toBe(false);

      // Doctor before any block: information only, and no home is read.
      expect((await blockRow())?.status).toBe("skip");

      // The preview: each file's unified diff, the apply with the plan and the part. It writes
      // nothing, and asks no service: none runs.
      const text = await run(["setup", "agents", "--parts", "block"], false);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain("adds the block at the end of the file:");
      expect(text.stdout).toContain("creates the file with the block:");
      expect(text.stdout).toContain(`--- ${claudeMd()}`);
      expect(text.stdout).toContain("+<!-- tasks:begin v1 (added by tasks setup;");
      const preview = await run(["setup", "agents", "--parts", "block", "--json"], false);
      const planned = JSON.parse(preview.stdout) as {
        plan: string;
        apply: string[];
        blocks: { app: string; state: string; file: string; change?: { kind: string } }[];
      };
      expect(planned.apply).toEqual([
        CLI_NAME,
        "setup",
        "agents",
        "--apply",
        "--plan",
        planned.plan,
        "--parts",
        "block",
      ]);
      expect(planned.blocks.map((b) => [b.app, b.state, b.file, b.change?.kind]).sort()).toEqual([
        ["claude-code", "absent", claudeMd(), "add"],
        ["codex", "absent", agentsMd(), "add"],
      ]);
      expect(text.stdout).toContain(`run: ${planned.apply.join(" ")}`);
      expect(readFileSync(claudeMd(), "utf8")).toBe(mine);
      expect(existsSync(agentsMd())).toBe(false);
      expect(existsSync(blocksRecord())).toBe(false);

      // Only the user applies; a plan the files no longer match changes nothing.
      expect((await run([...planned.apply.slice(1), "--json"], false)).code).toBe(5);
      writeFileSync(claudeMd(), `${mine}- One more.\r\n`);
      const stale = await run([...planned.apply.slice(1), "--json"]);
      expect(JSON.parse(stale.stdout)).toMatchObject({ error: { code: "conflict" } });
      writeFileSync(claudeMd(), mine);
      expect(existsSync(agentsMd())).toBe(false);

      const applied = await run([...planned.apply.slice(1)]);
      expect(applied.code, applied.stdout + applied.stderr).toBe(0);
      expect(applied.stdout).toContain("instruction block added");
      const withBlock = readFileSync(claudeMd(), "utf8");
      expect(withBlock.startsWith(`${mine}\r\n<!-- tasks:begin v1 `)).toBe(true);
      expect(withBlock.endsWith("<!-- tasks:end -->\r\n")).toBe(true);
      expect(readFileSync(agentsMd(), "utf8")).toMatch(/^<!-- tasks:begin v1 [^\r]*\n/u);
      expect((await blockRow())?.status).toBe("ok");

      // A second preview has nothing to do.
      const again = JSON.parse(
        (await run(["setup", "agents", "--parts", "block", "--json"], false)).stdout,
      ) as { plan?: string; blocks: { state: string }[] };
      expect(again.plan).toBeUndefined();
      expect(again.blocks.map((b) => b.state)).toEqual(["current", "current"]);

      // Text added before the block pushes it past the 32 KiB Codex reads: doctor warns.
      const codexBlock = readFileSync(agentsMd(), "utf8");
      writeFileSync(agentsMd(), `${"x".repeat(33 * 1024)}\n${codexBlock}`);
      const past = await blockRow();
      expect(past?.status).toBe("warn");
      expect(past?.detail).toContain(
        "Codex (codex): the block now ends past the first 32 KiB of its file",
      );

      // The block taken out of AGENTS.md by hand: doctor warns, with the fix.
      writeFileSync(agentsMd(), "mine now\n");
      const missing = await blockRow();
      expect(missing?.status).toBe("warn");
      expect(missing?.detail).toContain("Codex (codex): the block setup wrote is gone");
      expect(missing?.detail).toContain(`${CLI_NAME} setup agents --parts block`);
      // A file marked as generated now is managed elsewhere: information only.
      writeFileSync(agentsMd(), "<!-- generated by a skills installer -->\n");
      writeFileSync(claudeMd(), withBlock);
      const managed = await blockRow();
      expect(managed?.status).toBe("ok");
      expect(managed?.detail).toContain("managed elsewhere now");
      expect(managed?.detail).toContain("print-block --for agents");
      // The preview names the notice's line and the way on, for a file that is the person's own.
      const delegated = await run(["setup", "agents", "--parts", "block"], false);
      expect(delegated.stdout).toContain(
        `delegated: line 1 of its file says the file is generated or managed by another tool, so setup writes nothing there. Add the block at its source, or by hand if the file is your own: ${CLI_NAME} setup agents print-block --for agents prints it`,
      );

      // A remove of the entries leaves the blocks and says so.
      const entries = await run(["setup", "agents", "--remove"]);
      expect(entries.stdout).toContain("--remove --parts block takes them out");
      expect(readFileSync(claudeMd(), "utf8")).toBe(withBlock);

      // Only the user removes; the remove takes the block out byte for byte.
      expect((await run(["setup", "agents", "--remove", "--parts", "block"], false)).code).toBe(5);
      const removed = await run(["setup", "agents", "--remove", "--parts", "block", "--json"]);
      const outcome = JSON.parse(removed.stdout) as { blocks: { app: string; result: string }[] };
      expect(outcome.blocks.map((b) => [b.app, b.result]).sort()).toEqual([
        ["claude-code", "removed"],
        ["codex", "left"],
      ]);
      expect(readFileSync(claudeMd(), "utf8")).toBe(mine);
      expect(readFileSync(agentsMd(), "utf8")).toBe("<!-- generated by a skills installer -->\n");
    },
    SLOW,
  );
});
