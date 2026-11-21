// The `claude` driver against a fake Claude Code that speaks exactly the recorded exchanges
// (claude-fake.ts, fixtures/claude-stream), over a pair of in-memory pipes. As the run host does,
// the driver is closed once its work settled, and the program's end is told to the driver once the
// fake's input ended and it exited.
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { RunEvent } from "@tasks/contracts/runs";
import { claudeArgs, claudeDriver, claudeToolsFile } from "../src/drivers/claude.ts";
import type { DriverSession, Work } from "../src/drivers/types.ts";
import {
  readClaudeFixture,
  serveClaude,
  type FakeClaude,
  type FakeClaudeScenario,
} from "./claude-fake.ts";

interface Bench {
  readonly driver: DriverSession;
  readonly fake: FakeClaude;
  readonly events: RunEvent[];
  /** Tells the driver the program exited. */
  readonly exit: (code: number | null) => void;
  /** Whether the program's input was still open when the work settled. */
  readonly openAtSettle: Promise<boolean>;
}

function bench(scenario: FakeClaudeScenario, request = "Look into the export."): Bench {
  const toProgram = new PassThrough();
  const fromProgram = new PassThrough();
  const fake = serveClaude(toProgram, fromProgram, scenario);
  const events: RunEvent[] = [];
  const driver = claudeDriver({ request })({ stdin: toProgram, stdout: fromProgram }, (event) => {
    events.push(event);
  });
  const openAtSettle = driver.settled.then(() => {
    const open = !toProgram.writableEnded;
    driver.close();
    return open;
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
  return { driver, fake, events, exit, openAtSettle };
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
    const { driver, fake, events, openAtSettle } = bench({
      fixture: "windows-plain",
      answer: "All done.",
    });
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
    // The work settles before anything is closed; closing the input is what lets the program exit.
    expect(await openAtSettle).toBe(true);
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
    // Read-only is a mode that brings every prompt of the person's own setup to the driver.
    const narrow = claudeArgs("read-only");
    expect(narrow).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    expect(narrow).not.toContain("--mcp-config");
    // No mode narrows the person's own tools.
    for (const mode of ["full-access", "auto-edit", "read-only"] as const) {
      expect(claudeArgs(mode)).not.toContain("--tools");
    }
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

  test("a permission prompt of the person's own setup is not answered for them: the run needs the person, with what Claude Code asked to do", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-denied" });
    expect(await driver.settled).toEqual(
      done({
        ok: false,
        outcome: "needs_input",
        text: "Claude Code asks to use Bash: Fixture text.",
        textFinal: false,
      }),
    );
    const [answer] = ofType(fake, "control_response");
    expect(answer?.["response"]).toMatchObject({
      subtype: "success",
      response: { behavior: "deny", interrupt: true },
    });
    // Turning a prompt down never carries a permission: the program would write it into settings.
    expect(JSON.stringify(answer)).not.toContain("updatedPermissions");
    expect(events.filter((e) => e.kind === "answer").at(-1)).toMatchObject({
      text: "Claude Code asks to use Bash: Fixture text.",
    });
    await fake.inputEnded;
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

  test("a request the driver does not know gets the protocol's error, and the run goes on", async () => {
    const requests = [
      { subtype: "elicitation", mcp_server_name: "docs", message: "Fill in the export's name." },
    ];
    const { driver, fake } = bench({ fixture: "windows-plain", requests });
    expect(await driver.settled).toEqual(done({ ok: true, outcome: "success" }));
    const answers = ofType(fake, "control_response").map((m) => m["response"]);
    expect(answers[0]).toMatchObject({ subtype: "error", request_id: "fake-request-0" });
  });

  test("a question settles the work when it comes, from a program that then says nothing more", async () => {
    const init = readClaudeFixture("windows-plain").find((l) => l.msg["subtype"] === "init")?.msg;
    const question = {
      type: "control_request",
      request_id: "q1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        requires_user_interaction: true,
        input: { questions: [{ question: "Which export?", options: [{ label: "CSV" }] }] },
        tool_use_id: "toolu_x4",
      },
    };
    const toProgram = new PassThrough();
    const fromProgram = new PassThrough();
    const driver = claudeDriver({ request: "Look." })(
      { stdin: toProgram, stdout: fromProgram },
      () => undefined,
    );
    fromProgram.write(`${JSON.stringify(init)}\n${JSON.stringify(question)}\n`);
    expect(await settledNow(driver)).toEqual(
      done({ ok: false, outcome: "needs_input", text: "Which export? (CSV)" }),
    );
    driver.close();
  });

  test("a second question after the first changes nothing: the first is the run's text", async () => {
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

  test("a helper agent working in the background holds the work: the program's own turn about it is the answer", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-background-agent", pace: 0.05 });
    const work = await driver.settled;
    expect(work).toEqual(done({ ok: true, outcome: "success", textFinal: true }));
    // Both turns ended with a result: the run waited for the second.
    expect(events.filter((e) => e.kind === "answer" && e.final)).toHaveLength(2);
    await fake.inputEnded;
  });

  test("a finite command left in the background holds the work: the program's own turn about its end is the answer", async () => {
    const { driver, fake, events, openAtSettle } = bench({
      fixture: "windows-background",
      pace: 0.05,
    });
    await until("the first turn ended", () => events.some((e) => e.kind === "answer" && e.final));
    // The command still runs: the work is not settled, and its input stays open for the report.
    expect(await settledNow(driver)).toBeUndefined();
    expect(await driver.settled).toEqual(done({ ok: true, outcome: "success", textFinal: true }));
    expect(events.filter((e) => e.kind === "answer" && e.final)).toHaveLength(2);
    expect(await openAtSettle).toBe(true);
    await fake.inputEnded;
  });

  test("a server left running in the background holds the run until Stop, which ends it and keeps the last turn's answer", async () => {
    const { driver, fake, events } = bench({
      fixture: "windows-stop-background",
      pace: 0.05,
      answer: "The server listens.",
    });
    await until("the turn ended", () => events.some((e) => e.kind === "answer" && e.final));
    expect(await settledNow(driver)).toBeUndefined();
    expect(driver.interrupt()).toBe(true);
    // Between turns the Stop waits for nothing: the end of the input is what ends the server.
    expect(await settledNow(driver)).toEqual(
      done({ ok: false, outcome: "interrupted", text: "The server listens.", textFinal: true }),
    );
    await fake.inputEnded;
    // Nothing but the interrupt reached the input after the request.
    expect(fake.received.map((m) => m["type"])).toEqual(["user", "control_request"]);
  });

  test("a turn that begins after a result makes that result provisional: its newer words are kept, and without its own result the work did not finish", async () => {
    const recorded = readClaudeFixture("windows-plain").filter((l) => l.dir === "recv");
    const init = recorded.find((l) => l.msg["subtype"] === "init")?.msg ?? {};
    const result = recorded.find((l) => l.msg["type"] === "result")?.msg ?? {};
    const said = (text: string) => ({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text }] },
    });
    for (const [code, withInit] of [
      [0, true],
      [1, true],
      [0, false],
    ] as const) {
      const toProgram = new PassThrough();
      const fromProgram = new PassThrough();
      const events: RunEvent[] = [];
      const driver = claudeDriver({ request: "Look." })(
        { stdin: toProgram, stdout: fromProgram },
        (event) => events.push(event),
      );
      const stream = [
        init,
        { ...result, result: "First.", queued_turn_count: 1 },
        ...(withInit ? [init] : []),
        said("Halfway through the second."),
      ];
      fromProgram.write(stream.map((m) => `${JSON.stringify(m)}\n`).join(""));
      expect(await settledNow(driver)).toBeUndefined();
      // What a restart would recover is the newer words, not the first turn's answer.
      expect(events.filter((e) => e.kind === "answer").at(-1)).toMatchObject({
        text: "Halfway through the second.",
        final: false,
      });
      driver.ended({ code, signal: null });
      expect(await driver.settled).toEqual(
        done({
          ok: false,
          outcome: "no_result",
          text: "Halfway through the second.",
          textFinal: false,
        }),
      );
    }
  });

  test("a helper agent's words are not the run's answer", async () => {
    const recorded = readClaudeFixture("windows-plain").filter((l) => l.dir === "recv");
    const init = recorded.find((l) => l.msg["subtype"] === "init")?.msg ?? {};
    const result = recorded.find((l) => l.msg["type"] === "result")?.msg ?? {};
    const toProgram = new PassThrough();
    const fromProgram = new PassThrough();
    const driver = claudeDriver({ request: "Look." })(
      { stdin: toProgram, stdout: fromProgram },
      () => undefined,
    );
    const lines = [
      init,
      { type: "system", subtype: "background_tasks_changed", tasks: [{ task_type: "local_agent" }] },
      { ...result, result: "A helper looks." },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_h1",
        message: { content: [{ type: "text", text: "Helper's notes." }] },
      },
    ];
    fromProgram.write(lines.map((m) => `${JSON.stringify(m)}\n`).join(""));
    expect(await settledNow(driver)).toBeUndefined();
    driver.interrupt();
    expect(await driver.settled).toEqual(done({ text: "A helper looks.", textFinal: true }));
  });

  test("a question in the program's own turn about a finished helper reaches the driver and ends the run as needing the person", async () => {
    const question = {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      requires_user_interaction: true,
      input: { questions: [{ question: "Keep the export?", options: [{ label: "Yes" }] }] },
      tool_use_id: "toolu_x3",
    };
    const { driver, fake } = bench({
      fixture: "windows-background-agent",
      pace: 0.05,
      requests: [question],
    });
    expect(await driver.settled).toEqual(
      done({ ok: false, outcome: "needs_input", text: "Keep the export? (Yes)" }),
    );
    expect(ofType(fake, "control_response").map((m) => m["response"])).toContainEqual(
      expect.objectContaining({ request_id: "fake-request-0" }),
    );
    await fake.inputEnded;
  });

  test("a result with a turn queued after it does not settle the work: the queued turn's result does", async () => {
    const recorded = readClaudeFixture("windows-plain").filter((l) => l.dir === "recv");
    const init = recorded.find((l) => l.msg["subtype"] === "init")?.msg ?? {};
    const result = recorded.find((l) => l.msg["type"] === "result")?.msg ?? {};
    const stream = [
      init,
      { ...result, result: "First.", queued_turn_count: 1 },
      init,
      { ...result, result: "Second.", queued_turn_count: 0 },
    ];
    const toProgram = new PassThrough();
    const fromProgram = new PassThrough();
    const driver = claudeDriver({ request: "Look." })(
      { stdin: toProgram, stdout: fromProgram },
      () => undefined,
    );
    fromProgram.write(`${JSON.stringify(stream[0])}\n${JSON.stringify(stream[1])}\n`);
    expect(await settledNow(driver)).toBeUndefined();
    fromProgram.write(`${JSON.stringify(stream[2])}\n${JSON.stringify(stream[3])}\n`);
    expect(await driver.settled).toEqual(done({ ok: true, text: "Second." }));
    driver.close();
  });

  test("the work settles at the same line however the output is cut into chunks", async () => {
    const recorded = readClaudeFixture("windows-plain").filter((l) => l.dir === "recv");
    const init = recorded.find((l) => l.msg["subtype"] === "init")?.msg ?? {};
    const result = recorded.find((l) => l.msg["type"] === "result")?.msg ?? {};
    const failed = { ...result, is_error: true, subtype: "error_during_execution", result: "" };
    const lines = [init, { ...result, result: "Done." }, failed].map(
      (m) => `${JSON.stringify(m)}\n`,
    );
    const verdicts: unknown[] = [];
    for (const chunks of [[lines.join("")], lines]) {
      const toProgram = new PassThrough();
      const fromProgram = new PassThrough();
      const events: RunEvent[] = [];
      const driver = claudeDriver({ request: "Look." })(
        { stdin: toProgram, stdout: fromProgram },
        (event) => events.push(event),
      );
      for (const chunk of chunks) fromProgram.write(chunk);
      const work = await driver.settled;
      verdicts.push({ ok: work.ok, outcome: work.outcome, text: work.text });
      // Nothing after the settling line reaches the run's events.
      expect(events.filter((e) => e.kind === "answer")).toHaveLength(1);
      driver.close();
    }
    expect(verdicts).toEqual([
      { ok: true, outcome: "success", text: "Done." },
      { ok: true, outcome: "success", text: "Done." },
    ]);
  });

  test("a failed result or a question settles the work without waiting for a program that does not exit", async () => {
    const failed = bench({ fixture: "windows-signed-out", ignoreEnd: true });
    expect(await failed.driver.settled).toEqual(done({ ok: false, outcome: "agent_error" }));
    const asked = bench({ fixture: "windows-question", ignoreEnd: true });
    expect(await asked.driver.settled).toEqual(done({ ok: false, outcome: "needs_input" }));
  });

  test("Stop between turns, while a helper works in the background: the input ends, and the work is interrupted", async () => {
    const { driver, fake, events } = bench({ fixture: "windows-background-agent", pace: 0.05 });
    await until("the first turn ended", () => events.some((e) => e.kind === "answer" && e.final));
    expect(await settledNow(driver)).toBeUndefined();
    expect(driver.interrupt()).toBe(true);
    await fake.inputEnded;
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted" }));
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

  test("a program that does not exit after its work: the work settles with its answer, and a Stop then changes nothing", async () => {
    const { driver, fake } = bench({ fixture: "windows-plain", ignoreEnd: true });
    await fake.inputEnded;
    expect(await driver.settled).toEqual(done({ ok: true, outcome: "success", textFinal: true }));
    expect(driver.interrupt()).toBe(true);
    driver.ended({ code: 1, signal: null });
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
