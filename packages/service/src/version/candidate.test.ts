// The candidate's own checks (A2 3.12.6; A7 3.8 M1.14), from source: a temporary
// space through the worker threads, a temporary endpoint with a handshake, and a bridge answering
// tools/list from its offline file, each in a folder of its own below `<state>/tmp/` that is gone
// afterwards. The installed version's run of them is in scripts/install/install.test.ts.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hostFacts } from "../hub/paths.ts";
import {
  bridgeCheck,
  candidateChecks,
  endpointCheck,
  spaceCheck,
  type CandidateOptions,
} from "./candidate.ts";

const CLI = fileURLToPath(new URL("../../../cli/src/bin.ts", import.meta.url));
const OFFLINE = fileURLToPath(new URL("../../../bridge/lib/mcp-offline.json", import.meta.url));

let work: string;
let count = 0;
beforeAll(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "kc-")));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A separate install's state folder of its own, and the options that point the checks at it. */
function options(extra: Partial<CandidateOptions> = {}): CandidateOptions {
  count += 1;
  const home = join(work, `h${String(count)}`);
  const state = join(home, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return {
    state,
    build: { version: "0.1.0-dev.1", build: "candidate0test" },
    facts: hostFacts({ ...process.env, TASKS_HOME: home }),
    env: process.env,
    ...extra,
  };
}

const leftovers = (state: string): string[] =>
  existsSync(join(state, "tmp")) ? readdirSync(join(state, "tmp")) : [];

describe("[A2.3.12.6.candidate.checks] the candidate's checks: a temporary space, endpoint and bridge", () => {
  test("a temporary space is made, written through a writer and backed up, and removed", async () => {
    const o = options();
    const row = await spaceCheck(o);
    expect(row, row.detail).toMatchObject({ id: "candidate-space", status: "ok" });
    expect(leftovers(o.state)).toEqual([]);
  }, 120_000);

  test.skipIf(process.platform === "win32")(
    "a check writes nothing into a state or tmp folder another user can change (A2 3.2.2 rule 5)",
    async () => {
      const o = options();
      const tmp = join(o.state, "tmp");
      mkdirSync(tmp, { mode: 0o700 });
      chmodSync(tmp, 0o777);
      const row = await spaceCheck(o);
      expect(row).toEqual({
        id: "candidate-space",
        status: "fail",
        detail: "No temporary folder for the check: unsafe_permissions.",
      });
      expect(leftovers(o.state)).toEqual([]);
      // A tmp the checks make themselves is exactly 0700, whatever the umask.
      rmSync(tmp, { recursive: true });
      expect((await spaceCheck(o)).status).toBe("ok");
      expect(statSync(tmp).mode & 0o777).toBe(0o700);
    },
    120_000,
  );

  test("a temporary endpoint takes a handshake and a call, and its socket folder is removed", async () => {
    const o = options();
    const row = await endpointCheck(o);
    expect(row, row.detail).toMatchObject({ id: "candidate-endpoint", status: "ok" });
    expect(row.detail).toMatch(process.platform === "win32" ? /pipe/ : /socket/);
    expect(leftovers(o.state)).toEqual([]);
    expect(readdirSync(o.state).filter((name) => name.includes("candidate"))).toEqual([]);
  }, 60_000);

  test("the bridge answers tools/list from its offline file in an empty home, with MCP frames only", async () => {
    const o = options({ entry: [process.execPath, CLI], offline: OFFLINE });
    const row = await bridgeCheck(o);
    expect(row, row.detail).toMatchObject({ id: "candidate-bridge", status: "ok" });
    expect(leftovers(o.state)).toEqual([]);
    // From source there is no entry to check: skipped, not passed.
    expect(await bridgeCheck(options())).toMatchObject({ status: "skip" });
  }, 120_000);

  test("a bridge whose answer is not its offline file, or that writes anything else, fails", async () => {
    const other = join(work, "other-offline.json");
    const offline = JSON.parse(readFileSync(OFFLINE, "utf8")) as {
      tools_list: { result: unknown };
    };
    writeFileSync(other, JSON.stringify({ ...offline, tools_list: { result: { tools: [] } } }));
    const differs = await bridgeCheck(options({ entry: [process.execPath, CLI], offline: other }));
    expect(differs).toMatchObject({ status: "fail" });
    expect(differs.detail).toMatch(/not its offline answer/);
    const junk = join(work, "junk.mjs");
    writeFileSync(junk, 'process.stdout.write("not mcp\\n");\n');
    const noisy = await bridgeCheck(options({ entry: [process.execPath, junk], offline: OFFLINE }));
    expect(noisy).toMatchObject({ status: "fail" });
  }, 120_000);

  test("a state folder the checks cannot work in fails each check instead of throwing", async () => {
    const o = options({ entry: [process.execPath, CLI], offline: OFFLINE });
    writeFileSync(join(o.state, "tmp"), "a file where the folder belongs");
    const rows = await candidateChecks(o);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["candidate-space", "fail"],
      ["candidate-endpoint", "ok"],
      ["candidate-bridge", "fail"],
    ]);
  }, 120_000);
});
