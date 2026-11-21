// `pnpm accept m1 --part cli` (A7 3.8 M1.10): the CLI as child processes against a real service
// child in a temporary TTASKS_HOME. Fixture text only. With `--installed` (M1.13) the same tests
// run against a built version folder through its launchers, and `ttasks mcp` through the launcher
// must be the build's own bridge (A2 3.7.1).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PRODUCT_NAME } from "@ttasks/brand";
import { TaskAddResult, TaskGetResult, TaskUpdateResult } from "@ttasks/contracts";
import { tempRoot } from "@ttasks/service/test/harness";
import { layoutTestInstall } from "@ttasks/testkit";
import { BIN, cliEnv, FAULTY, INSTALLED, NEWER, startWorld, type CliWorld } from "./cli-harness.ts";

let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("cli");
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

const json = (stdout: string): unknown => JSON.parse(stdout) as unknown;

type Message = Record<string, unknown>;

/**
 * Talks MCP to `file argv` over stdio: sends each message, waits for the reply to each request
 * before the next, then closes stdin and waits for the exit. Every stdout line must be a JSON-RPC
 * 2.0 message; anything else fails the test.
 */
async function mcpExchange(
  file: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  messages: readonly Message[],
): Promise<{ code: number | null; replies: Map<unknown, Message>; stderr: string }> {
  const child = spawn(file, argv, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const replies = new Map<unknown, Message>();
  const waiting = new Map<unknown, () => void>();
  let stderr = "";
  let pending = "";
  const stray: string[] = [];
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      let message: Message | undefined;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        stray.push(line);
      }
      if (message?.["jsonrpc"] !== "2.0") {
        stray.push(line);
        continue;
      }
      if ("id" in message && !("method" in message)) {
        replies.set(message["id"], message);
        waiting.get(message["id"])?.();
      }
    }
  });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    for (const message of messages) {
      const id = message["id"];
      const replied =
        id === undefined
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${JSON.stringify(message)}\n`);
      await Promise.race([replied, exit]);
    }
    child.stdin.end();
    const code = await exit;
    expect(stray, stderr).toEqual([]);
    expect(pending).toBe("");
    return { code, replies, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
const errorOf = (stdout: string) =>
  (json(stdout) as { error: { code: string; class: string; data?: Record<string, unknown> } })
    .error;

describe("[A2.3.10.cli.accept] the M1 acceptance of the CLI", () => {
  test("the service and the CLI are the build under test: the source, or the built folder", async () => {
    // Against a build (pnpm accept --installed), both report the build label its manifest names.
    const build =
      world.install === undefined
        ? "source"
        : (
            JSON.parse(
              readFileSync(join(world.install.versionFolder, "manifest.json"), "utf8"),
            ) as { build: string }
          ).build;
    expect(world.json["build"]).toBe(build);
    const version = await world.tasks(["version"]);
    expect(version.code, version.stderr).toBe(0);
    expect(version.stdout).toMatch(new RegExp(`^${PRODUCT_NAME} \\S+ \\(${build}\\)\\r?\\n$`));
    if (world.install !== undefined) {
      // The folder under test is whole: every file as its manifest lists it, and the runtime gate.
      const doctor = await world.tasks(["doctor", "--self-test", "--json"]);
      const rows = (json(doctor.stdout) as { checks: { id: string; status: string }[] }).checks;
      for (const id of ["integrity", "runtime"]) {
        expect(rows.find((row) => row.id === id)?.status, `${id}: ${doctor.stdout}`).toBe("ok");
      }
    }
  }, 180_000);

  test("ttasks mcp through the launcher is the build's bridge: offline answers, MCP frames only", async () => {
    // A home of its own with no service: the bridge answers from its offline file (A2 3.7.3), the
    // build's lib/mcp-offline.json beside lib/bridge.mjs, or the source's.
    const temp = tempRoot("cli-mcp");
    try {
      const home = join(temp.root, "h");
      const install = INSTALLED === undefined ? undefined : layoutTestInstall(INSTALLED, home);
      const offline = JSON.parse(
        readFileSync(
          install === undefined
            ? fileURLToPath(new URL("../../bridge/lib/mcp-offline.json", import.meta.url))
            : join(install.versionFolder, "lib", "mcp-offline.json"),
          "utf8",
        ),
      ) as { tools_list: { result: unknown } };
      const args = ["mcp", "--space", "sp_test", "--instance", "test-agent", "--app", "test"];
      const [file, ...argv] =
        install === undefined ? [process.execPath, BIN, ...args] : [install.launcher, ...args];
      const bridge = await mcpExchange(file, argv, cliEnv(home), [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "fixture-client", version: "1.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]);
      expect(bridge.code, bridge.stderr).toBe(0);
      expect(bridge.replies.get(1)).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
      expect(JSON.stringify(bridge.replies.get(2)?.["result"])).toBe(
        JSON.stringify(offline.tools_list.result),
      );
      for (const line of bridge.stderr.split(/\r?\n/).filter((l) => l !== "")) {
        expect(line).toMatch(/^mcp bridge: /);
      }
    } finally {
      temp.cleanup();
    }
  }, 180_000);

  test("two parallel ttasks add give distinct IDs and references", async () => {
    const [a, b] = await Promise.all([
      world.tasks(["add", "Fixture task A", "--json"]),
      world.tasks(["add", "Fixture task B", "-p", "2", "--json"]),
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const ta = TaskAddResult.parse(json(a.stdout)).tasks[0];
    const tb = TaskAddResult.parse(json(b.stdout)).tasks[0];
    expect(ta?.id).not.toBe(tb?.id);
    expect(ta?.ref).not.toBe(tb?.ref);
    expect(new Set([ta?.ref, tb?.ref])).toEqual(new Set(["M-1", "M-2"]));
  }, 180_000);

  test("ttasks show M-1 --json matches its schema", async () => {
    const shown = await world.tasks(["show", "M-1", "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    const result = TaskGetResult.parse(json(shown.stdout));
    expect(result).toMatchObject({ view: "digest", task: { ref: "M-1" } });
    // Without --json: text for a person on stdout.
    const text = await world.tasks(["show", "M-1"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^M-1 {2}Fixture task/);
  }, 180_000);

  test("a stale base exits 4", async () => {
    const before = TaskGetResult.parse(json((await world.tasks(["show", "M-1", "--json"])).stdout));
    const first = await world.tasks(["set", "M-1", "summary=Fixture summary one"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^Updated M-1 in Mira: summary/);
    const stale = await world.tasks(["set", "--input", "-", "--json"], {
      stdin: JSON.stringify({
        task: "M-1",
        set: { summary: "Fixture summary two" },
        base: before.as_of,
      }),
    });
    expect(stale.code).toBe(4);
    expect(errorOf(stale.stdout)).toMatchObject({ code: "conflict", class: "conflict" });
  }, 180_000);

  test("a lost reply, then the same command with the same --request-id in a new process after another write, replays", async () => {
    const id = "fixture-lost-reply-0001";
    const args = ["set", "M-2", "summary=Fixture summary three", "--request-id", id, "--json"];
    // The service applies the change, and its reply is lost on the way back: exit 6, and the
    // command says how to retry.
    const lost = await world.tasks(args, {
      script: FAULTY,
      env: { TTASKS_TEST_FAULT: "lose-write" },
    });
    expect(lost.code, lost.stderr).toBe(6);
    expect(errorOf(lost.stdout)).toMatchObject({
      code: "service_unavailable",
      class: "service",
      data: { reason: "connection_lost", retryable: true },
    });
    expect(lost.stderr).toContain(`Retry with: --request-id ${id}`);
    const applied = TaskGetResult.parse(
      json((await world.tasks(["show", "M-2", "--json"])).stdout),
    );
    expect(applied).toMatchObject({ task: { summary: "Fixture summary three" } });

    const other = await world.tasks(["log", "M-2", "Fixture entry", "--json"]);
    expect(other.code, other.stderr).toBe(0);
    const between = TaskGetResult.parse(
      json((await world.tasks(["show", "M-2", "--json"])).stdout),
    );

    // The retry asks for its receipt first and reads no fresh base (A2 3.10.2): the operations
    // it calls are the receipt lookup and the write, which replays.
    const retry = await world.tasks(args, { script: FAULTY, env: { TTASKS_TEST_FAULT: "trace" } });
    expect(retry.code, retry.stderr).toBe(0);
    expect(retry.stderr.match(/^trace .+$/gm)).toEqual(["trace receipt.get", "trace task.update"]);
    const replayed = TaskUpdateResult.parse(json(retry.stdout));
    expect(replayed).toMatchObject({
      result: "updated",
      task: "M-2",
      fields: ["summary"],
      as_of: applied.as_of,
      replayed: true,
    });
    // Nothing was written again.
    const after = TaskGetResult.parse(json((await world.tasks(["show", "M-2", "--json"])).stdout));
    expect(after.as_of).toBe(between.as_of);
    // The receipt is in the CLI's stable writer scope.
    const receipt = await world.tasks(["receipt", id, "--json"]);
    expect(json(receipt.stdout)).toMatchObject({
      found: true,
      status: "applied",
      as_of: applied.as_of,
    });
    // The same command with a new request ID is a new change, on a fresh base.
    const again = await world.tasks(["set", "M-2", "summary=Fixture summary four", "--json"]);
    expect(again.code, again.stderr).toBe(0);
    expect(TaskUpdateResult.parse(json(again.stdout)).as_of).not.toBe(between.as_of);
  }, 180_000);

  test("a CLI newer than the running service gets service_too_old and exits 7", async () => {
    const newer = await world.tasks(["status", "--json"], { script: NEWER });
    expect(newer.code).toBe(7);
    expect(errorOf(newer.stdout)).toMatchObject({
      code: "service_unavailable",
      class: "version",
      data: { reason: "service_too_old" },
    });
    const text = await world.tasks(["status"], { script: NEWER });
    expect(text.code).toBe(7);
    expect(text.stderr).toContain("Restart the service: ttasks service restart.");
  }, 180_000);
});
