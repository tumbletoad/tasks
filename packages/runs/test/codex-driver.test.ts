// The `codex` driver against a fake app server that speaks exactly the recorded exchanges
// (codex-server.ts, fixtures/codex-app-server), over a pair of in-memory pipes.
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { RunEvent, RunPermission } from "@tasks/contracts/runs";
import { codexDriver, type CodexSession } from "../src/drivers/codex.ts";
import type { DriverSession, Work } from "../src/drivers/types.ts";
import { serveCodex, type FakeCodex, type FakeScenario } from "./codex-server.ts";

const TOOLS = {
  command: "/opt/tasks/bin/tasks",
  args: ["mcp", "--space", "sp_x", "--instance", "codex", "--app", "codex"],
  env: { TASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
};

interface Bench {
  readonly driver: DriverSession;
  readonly fake: FakeCodex;
  readonly events: RunEvent[];
  readonly toServer: PassThrough;
}

function bench(scenario: FakeScenario, session: Partial<CodexSession> = {}): Bench {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const fake = serveCodex(toServer, fromServer, scenario);
  const events: RunEvent[] = [];
  const driver = codexDriver({
    cwd: "C:\\Users\\mira\\code\\portal",
    request: "Look into the export.",
    permission: "full-access",
    tools: TOOLS,
    ...session,
  })({ stdin: toServer, stdout: fromServer }, (event) => events.push(event));
  return { driver, fake, events, toServer };
}

/** The client's messages of one method. */
const sent = (fake: FakeCodex, method: string) =>
  fake.received.filter((m) => m["method"] === method);

/** The client's answer to the server's request `id`. */
const answerTo = (fake: FakeCodex, id: number) =>
  fake.received.find((m) => m["id"] === id && !("method" in m));

const until = async (what: string, ok: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > deadline) throw new Error(`${what}: never true`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const done = (work: Partial<Work>): unknown => expect.objectContaining(work) as unknown;

describe("[A4.3.11.codex.driver] the codex driver against the recorded app server", () => {
  test("a plain run: the request goes over the protocol, and the final answer is the work's", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-plain" });
    const work = await driver.settled;
    expect(work).toEqual(
      done({
        ok: true,
        outcome: "success",
        text: "Fixture text.",
        textFinal: true,
        nativeId: "00000000-0000-4000-8000-000000000002",
      }),
    );
    expect(events).toContainEqual({
      kind: "native-id",
      id: "00000000-0000-4000-8000-000000000002",
    });
    const [turn] = sent(fake, "turn/start");
    expect(turn?.["params"]).toMatchObject({
      input: [{ type: "text", text: "Look into the export." }],
    });
    const [thread] = sent(fake, "thread/start");
    expect(thread?.["params"]).toEqual({
      cwd: "C:\\Users\\mira\\code\\portal",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        "mcp_servers.tasks": {
          command: "/opt/tasks/bin/tasks",
          args: TOOLS.args,
          env: { TASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
        },
      },
    });
    driver.close();
    expect(await fake.done).toBe(0);
  });

  test("a narrower mode per instance runs the thread in Codex's own sandbox, and nobody is asked", async () => {
    for (const [permission, sandbox] of [
      ["auto-edit", "workspace-write"],
      ["read-only", "read-only"],
    ] as const) {
      const { driver, fake } = bench({ fixture: "windows-plain" }, { permission });
      await driver.settled;
      expect(sent(fake, "thread/start")[0]?.["params"]).toMatchObject({
        approvalPolicy: "never",
        sandbox,
      });
      driver.close();
    }
  });

  test("a run with a command, and a tool call: their progress is reported, and the run settles after them", async () => {
    const command = bench({ fixture: "windows-command" });
    expect(await command.driver.settled).toEqual(done({ ok: true, outcome: "success" }));
    expect(command.events).toContainEqual({ kind: "progress", label: "command" });
    const tool = bench({ fixture: "windows-tool" });
    expect(await tool.driver.settled).toEqual(done({ ok: true, appTools: "connected" }));
    expect(tool.events).toContainEqual({ kind: "progress", label: "tasks" });
  });

  test("each request kind is answered as the permission says, while the turn goes on", async () => {
    const requests = [
      { method: "item/commandExecution/requestApproval", params: { itemId: "exec-1" } },
      { method: "item/fileChange/requestApproval", params: { itemId: "exec-2" } },
      { method: "execCommandApproval", params: { callId: "c1", command: ["echo", "hi"] } },
      { method: "applyPatchApproval", params: { callId: "c2" } },
      {
        method: "item/permissions/requestApproval",
        params: { itemId: "exec-3", permissions: { network: { enabled: true } } },
      },
    ];
    const denied = { denied: { rejection: "The run's permission declines it." } };
    const expected: Record<RunPermission, unknown[]> = {
      "full-access": [
        { decision: "accept" },
        { decision: "accept" },
        { decision: "approved" },
        { decision: "approved" },
        { permissions: { network: { enabled: true } }, scope: "turn" },
      ],
      "auto-edit": [
        { decision: "decline" },
        { decision: "accept" },
        { decision: denied },
        { decision: "approved" },
        { permissions: {}, scope: "turn" },
      ],
      "read-only": [
        { decision: "decline" },
        { decision: "decline" },
        { decision: denied },
        { decision: denied },
        { permissions: {}, scope: "turn" },
      ],
    };
    for (const [permission, answers] of Object.entries(expected)) {
      const { driver, fake } = bench(
        { fixture: "windows-plain", requests },
        { permission: permission as RunPermission },
      );
      expect(await driver.settled, permission).toEqual(done({ ok: true }));
      expect(
        requests.map((_r, n) => answerTo(fake, 100 + n)?.["result"]),
        permission,
      ).toEqual(answers);
      driver.close();
    }
  });

  test("the recorded approvals: accepted with full access, declined and counted in a read-only run", async () => {
    const full = bench({ fixture: "windows-approval-command" });
    expect(await full.driver.settled).toEqual(done({ ok: true, declined: 0 }));
    expect(answerTo(full.fake, 0)?.["result"]).toEqual({ decision: "accept" });
    const narrow = bench({ fixture: "windows-approval-file" }, { permission: "read-only" });
    // The recording continues as its client answered; the driver's own answers are what counts.
    await narrow.driver.settled;
    expect(answerTo(narrow.fake, 0)?.["result"]).toEqual({ decision: "decline" });
    expect(answerTo(narrow.fake, 1)?.["result"]).toEqual({ decision: "decline" });
  });

  test("a blocking question ends the run as needing the person, with the question as its text, never an answer made up", async () => {
    const { driver, fake } = bench({ fixture: "windows-question" });
    const work = await driver.settled;
    expect(work).toEqual(
      done({
        ok: false,
        outcome: "needs_input",
        text: "Fixture text. (Fixture text., Fixture text.)",
      }),
    );
    expect(answerTo(fake, 0)).toBeUndefined();
    await until("the turn interrupted", () => sent(fake, "turn/interrupt").length === 1);
    driver.close();
    expect(await fake.done).toBe(0);
  });

  test("a request kind the driver does not know gets the protocol's error, and the run goes on", async () => {
    const requests = [
      { method: "item/tool/call", params: { tool: "x" } },
      { method: "account/chatgptAuthTokens/refresh", params: {} },
      { method: "something/new", params: {} },
    ];
    const { driver, fake } = bench({ fixture: "windows-plain", requests });
    expect(await driver.settled).toEqual(done({ ok: true }));
    for (const n of [0, 1, 2]) {
      expect(answerTo(fake, 100 + n)?.["error"]).toMatchObject({ code: -32601 });
    }
  });

  test("Stop during start-up ends the work at once, while the server still owes its answer", async () => {
    const { driver, fake } = bench({ fixture: "windows-plain", stallAt: "thread/start" });
    await until("the thread asked for", () => sent(fake, "thread/start").length === 1);
    expect(driver.interrupt()).toBe(true);
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted" }));
    expect(sent(fake, "turn/start")).toEqual([]);
  });

  test("Stop during a turn interrupts it over the protocol, and the work ends interrupted", async () => {
    const { driver, fake } = bench({ fixture: "windows-interrupt", stallAt: "turn/interrupt" });
    await until("the command started", () => sent(fake, "turn/start").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    driver.interrupt();
    await until("interrupt sent", () => sent(fake, "turn/interrupt").length === 1);
    driver.close();
    driver.ended({ code: 0, signal: null });
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted" }));
  });

  test("Stop of a recorded interrupt: the server's own end of the turn says interrupted", async () => {
    const { driver } = bench({ fixture: "windows-interrupt" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    driver.interrupt();
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted" }));
  });

  test("a server that stops answering: the start fails after its time, with words of its own", async () => {
    const { driver } = bench({ fixture: "windows-plain", stallAt: "turn/start" }, { startMs: 200 });
    expect(await driver.settled).toEqual(
      done({ ok: false, outcome: "agent_error", error: "Codex did not answer its start in time." }),
    );
  });

  test("background work goes on after the turn: the run settles only once it ended", async () => {
    const { driver, fake } = bench({ fixture: "windows-background", pace: 0.05 });
    let at: number | undefined;
    const t0 = performance.now();
    void driver.settled.then(() => (at = performance.now() - t0));
    await until("the turn completed", () =>
      fake.received.some((m) => m["method"] === "turn/start"),
    );
    // The recorded command ended about 10 s after the turn: here half a second.
    const work = await driver.settled;
    expect(work).toEqual(done({ ok: true, textFinal: true }));
    expect(at).toBeGreaterThan(400);
  });

  test("the answer is kept whole after megabytes of other output", async () => {
    const answer = '"\\\n\t'.repeat(256 * 1024);
    const { driver } = bench({ fixture: "windows-plain", answer, floodBytes: 20 * 1024 * 1024 });
    const work = await driver.settled;
    expect(work.text === answer).toBe(true);
    expect(work.textCut).toBe(false);
  });

  test("an app server that ends before its work settled: what it said is the work, unfinished", async () => {
    const { driver } = bench({ fixture: "windows-plain", stallAt: "turn/start" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    driver.ended({ code: 1, signal: null });
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "no_result" }));
    const silent = bench({ fixture: "windows-plain", stallAt: "initialize" });
    silent.driver.ended({ code: 1, signal: null });
    expect(await silent.driver.settled).toEqual(done({ ok: false, outcome: "no_output" }));
  });
});
