// `tasks session` from the CLI (A3 3.7.3 "Rebinding", M4.06): the user ends, unbinds or rebinds
// an agent session from an interactive terminal; a script or an agent's shell is refused before the
// service changes anything. What each change does to a session is the service's test
// (packages/service/test/binding-complete.test.ts). A real service child, fixture IDs only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "@tasks/storage";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("ss");
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

const run = (argv: string[], tty = false, env: Record<string, string> = {}) =>
  runMain(argv, { home: world.home, cwd: world.root, tty, env });
const parsed = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe("[A3.3.7.binding.user-ops] tasks session from the CLI", () => {
  test(
    "a person at a terminal reaches the service; a script and an agent's shell are refused; the arguments are checked first",
    { timeout: 120_000 },
    async () => {
      const session = newId("se");
      const script = await run(["session", "end", session, "--json"]);
      expect(script.code).toBe(5);
      expect(parsed(script.stdout)).toMatchObject({ error: { code: "forbidden" } });
      const shell = await run(["session", "unbind", session, "--json"], true, { CLAUDECODE: "1" });
      expect(shell.code).toBe(5);

      const unknown = await run(["session", "rebind", session, "M-1", "--json"], true);
      expect(parsed(unknown.stdout)).toMatchObject({ error: { code: "not_found" } });
      const malformed = await run(["session", "end", "not-a-session", "--json"], true);
      expect(parsed(malformed.stdout)).toMatchObject({ error: { code: "invalid_input" } });

      const usage = await run(["session", "rebind", session], true);
      expect(usage.code).toBe(2);
      expect((await run(["session", "close", session], true)).code).toBe(2);
      expect((await run(["help", "session"])).stdout).toContain("tasks session <command>");
    },
  );
});
