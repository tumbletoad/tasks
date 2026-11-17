// The `claude` driver against a fake Claude Code that speaks exactly the recorded exchanges
// (claude-fake.ts, fixtures/claude-stream), over a pair of in-memory pipes. As the run host does,
// the program's end is told to the driver once the fake's input ended and it exited.
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { RunEvent } from "@tasks/contracts/runs";
import { claudeArgs, claudeDriver, claudeToolsFile } from "../src/drivers/claude.ts";
import type { DriverSession, Work } from "../src/drivers/types.ts";
import { serveClaude, type FakeClaude, type FakeClaudeScenario } from "./claude-fake.ts";

interface Bench {
  readonly driver: DriverSession;
  readonly fake: FakeClaude;
  readonly events: RunEvent[];
  /** Tells the driver the program exited. */
  readonly exit: (code: number | null) => void;
}

function bench(scenario: FakeClaudeScenario, request = "Look into the export."): Bench {
  const toProgram = new PassThrough();
  const fromProgram = new PassThrough();
  const fake = serveClaude(toProgram, fromProgram, scenario);
  const events: RunEvent[] = [];
  const driver = claudeDriver({ request })({ stdin: toProgram, stdout: fromProgram }, (event) => {
    events.push(event);
  });
  const exit = (code: number | null): void => {
    // What the program wrote before it exited is read first.
    setImmediate(() => {
      driver.ended({ code, signal: null });
    });
  };
  // The program exits once its replay and its input ended, as the real one does.
  void fake.done.then((code) => {
    exit(code);
  });
  return { driver, fake, events, exit };
}

/** The work, or undefined while it has not settled. */
async function settledNow(driver: DriverSession): Promise<Work | undefined> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const pending = Symbol("pending");
  const first = await Promise.race([driver.settled, Promise.resolve(pending)]);
  return first === pending ? undefined : first;
}

const until = async (what: string, ok: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > deadline) throw new Error(`${what}: never true`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const SESSION = "00000000-0000-4000-8000-000000000001";
const done = (work: Partial<Work>): unknown => expect.objectContaining(work) as unknown;
const ofType = (fake: FakeClaude, type: string) => fake.received.filter((m) => m["type"] === type);

describe("[A4.3.11.claude.driver] the claude driver against the recorded print mode", () => {
  test("a plain run: the request is the program's first line of input, and the result's answer is the work's", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-plain", answer: "All done." });
    expect(await driver.settled).toEqual(
      done({
        ok: true,
        outcome: "success",
        text: "All done.",
        textFinal: true,
        nativeId: SESSION,
        error: null,
      }),
    );
    expect(fake.received[0]).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Look into the export." }] },
    });
    expect(events).toContainEqual({ kind: "native-id", id: SESSION });
    // The input ended after the result: that is what lets the program exit.
    await fake.inputEnded;
  });

  test("the arguments: print mode with JSON lines both ways, prompts to the driver, the permission in Claude Code's own modes, and no request", () => {
    const full = claudeArgs("full-access", "/state/runs/ru_x/tools.json");
    expect(full).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      "bypassPermissions",
      "--mcp-config",
      "/state/runs/ru_x/tools.json",
    ]);
    expect(claudeArgs("auto-edit")).toEqual(
      expect.arrayContaining(["acceptEdits", "--allowedTools", "mcp__tasks"]),
    );
    const narrow = claudeArgs("read-only");
    expect(narrow).toEqual(expect.arrayContaining(["dontAsk", "--tools", "Read,Glob,Grep"]));
    expect(narrow).not.toContain("--mcp-config");
    const file = JSON.parse(
      claudeToolsFile({
        command: "/opt/tasks/bin/tasks",
        args: ["mcp", "--space", "sp_x"],
        env: { TASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
      }),
    ) as unknown;
    expect(file).toEqual({
      mcpServers: {
        tasks: {
          type: "stdio",
          command: "/opt/tasks/bin/tasks",
          args: ["mcp", "--space", "sp_x"],
          env: { TASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
        },
      },
    });
  });

  test("a run with a command, and a call of Tasks' tools: their progress is reported, and the tools connected", async () => {
    const command = bench({ fixture: "windows-command" });
    expect(await command.driver.settled).toEqual(done({ ok: true, outcome: "success" }));
    expect(command.events).toContainEqual({ kind: "progress", label: "command" });
    const tool = bench({ fixture: "windows-tool" });
    expect(await tool.driver.settled).toEqual(done({ ok: true, appTools: "connected" }));
    expect(tool.events).toContainEqual({ kind: "progress", label: "tasks" });
  });

  test("a permission prompt is declined, since nobody is there to answer it, and the program counts it", async () => {
    const { driver, fake } = bench({ fixture: "windows-denied" });
    expect(await driver.settled).toEqual(done({ ok: true, permissionDenials: 1 }));
    const [answer] = ofType(fake, "control_response");
    expect(answer?.["response"]).toMatchObject({
      subtype: "success",
      response: { behavior: "deny" },
    });
    // A decline never carries a permission of its own: the program would write it into settings.
    expect(JSON.stringify(answer)).not.toContain("updatedPermissions");
  });

  test("a question for the person ends the run as needing the person, with the question as its text, never an answer made up", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-question" });
    const work = await driver.settled;
    expect(work).toEqual(
      done({
        ok: false,
        outcome: "needs_input",
        text: "Fixture text. (Fixture text., Fixture text.)",
        textFinal: false,
      }),
    );
    const [answer] = ofType(fake, "control_response");
    expect(answer?.["response"]).toMatchObject({
      response: { behavior: "deny", interrupt: true },
    });
    expect(
      ofType(fake, "control_request").some(
        (m) => (m["request"] as { subtype?: string }).subtype === "interrupt",
      ),
    ).toBe(true);
    // What the run's folder keeps is the last answer event: the question.
    expect(events.filter((e) => e.kind === "answer").at(-1)).toMatchObject({
      text: "Fixture text. (Fixture text., Fixture text.)",
      final: false,
    });
  });

  test("a request the driver does not know gets the protocol's error, a second question changes nothing, and the run goes on", async () => {
    const requests = [
      { subtype: "elicitation", mcp_server_name: "docs", message: "Fill in the export's name." },
      {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hi" },
        tool_use_id: "toolu_x1",
      },
    ];
    const { driver, fake } = bench({ fixture: "windows-plain", requests });
    expect(await driver.settled).toEqual(done({ ok: true, outcome: "success" }));
    const answers = ofType(fake, "control_response").map((m) => m["response"]);
    expect(answers[0]).toMatchObject({ subtype: "error", request_id: "fake-request-0" });
    expect(answers[1]).toMatchObject({
      subtype: "success",
      request_id: "fake-request-1",
      response: { behavior: "deny" },
    });
  });

  test("a later question after the first one is declined and the first stays the run's text", async () => {
    const later = {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      requires_user_interaction: true,
      input: { questions: [{ question: "Which export?", options: [{ label: "CSV" }] }] },
      tool_use_id: "toolu_x2",
    };
    const { driver, events } = bench({ fixture: "windows-question", requests: [later] });
    expect(await driver.settled).toEqual(
      done({ outcome: "needs_input", text: "Which export? (CSV)" }),
    );
    expect(events.filter((e) => e.kind === "answer")).toHaveLength(1);
  });

  test("a signed-out Claude Code ends the run with its own words and the command to sign in", async () => {
    const { driver } = bench({ fixture: "windows-signed-out" });
    const work = await driver.settled;
    expect(work).toEqual(done({ ok: false, outcome: "agent_error" }));
    expect(work.error).toBe("Fixture text. Sign in with: claude auth login");
  });

  test("background work goes on after the turn: the input stays open, and the program's own turn about it is the answer", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-background", pace: 0.05 });
    const work = await driver.settled;
    expect(work).toEqual(done({ ok: true, outcome: "success", textFinal: true }));
    // Both turns ended with a result: the run waited for the second.
    expect(events.filter((e) => e.kind === "answer" && e.final)).toHaveLength(2);
    await fake.inputEnded;
  });

  test("Stop between turns, while background work goes on: the input ends, and the work is interrupted with its answer kept", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-stop-background" });
    await until("the first turn ended", () => events.some((e) => e.kind === "answer" && e.final));
    expect(await settledNow(driver)).toBeUndefined();
    expect(driver.interrupt()).toBe(true);
    await fake.inputEnded;
    expect(await driver.settled).toEqual(
      done({ ok: false, outcome: "interrupted", text: "Fixture text." }),
    );
  });

  test("Stop during the turn interrupts it over the input, and the work ends interrupted", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-interrupt", pace: 0.2 });
    await until("the command started", () =>
      events.some((e) => e.kind === "progress" && e.label === "command"),
    );
    expect(driver.interrupt()).toBe(true);
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted", error: null }));
    await fake.inputEnded;
  });

  test("Stop during start-up, before the program said anything, is heard at once", async () => {
    const { driver, fake } = bench({ fixture: "windows-plain", pace: 1 });
    expect(driver.interrupt()).toBe(true);
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted" }));
    await fake.inputEnded;
  });

  test("Stop of a program that says nothing at all: the host ends it, and the work is interrupted", async () => {
    const { driver, exit } = bench({ fixture: "windows-plain", stallAt: "init" });
    expect(driver.interrupt()).toBe(true);
    expect(await settledNow(driver)).toBeUndefined();
    exit(null);
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted" }));
  });

  test("Stop once the work is done and the program is exiting: the host ends the program, and the work stays done", async () => {
    const { driver, fake, exit } = bench({ fixture: "windows-plain", ignoreEnd: true });
    await fake.inputEnded;
    // Nothing to say it over: the host interrupts the program itself.
    expect(driver.interrupt()).toBe(false);
    exit(1);
    expect(await driver.settled).toEqual(done({ ok: true, outcome: "success" }));
  });

  test("a program that stops writing in the middle of its turn: what it said is the work, unfinished", async () => {
    const { driver, exit } = bench({ fixture: "windows-command", stallAt: "result" });
    expect(await settledNow(driver)).toBeUndefined();
    exit(null);
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "no_result" }));
  });

  test("the answer is kept whole after megabytes of other output around it", async () => {
    const answer = '"\\\n\t'.repeat(256 * 1024);
    const { driver } = bench({ fixture: "windows-plain", answer, floodBytes: 20 * 1024 * 1024 });
    const work = await driver.settled;
    expect(work.text === answer).toBe(true);
    expect(work.textCut).toBe(false);
  });
});
