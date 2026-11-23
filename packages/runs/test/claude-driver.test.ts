// The `claude` driver against a fake Claude Code that speaks exactly the recorded exchanges
// (claude-fake.ts, fixtures/claude-stream), over a pair of in-memory pipes. As the run host does,
// the driver is closed once its work settled, and the program's end is told to the driver once the
// fake's input ended and it exited.
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { LINE_CAP_BYTES, type RunEvent } from "@ttasks/contracts/runs";
import {
  claudeArgs,
  claudeDriver,
  claudeToolsFile,
  HEARD,
  PHASES,
  type Heard,
  type Phase,
} from "../src/drivers/claude.ts";
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

/** What the program says, line by line, to bring the driver to each phase or to make it hear. */
const RECORDED = readClaudeFixture("windows-plain").filter((l) => l.dir === "recv");
const INIT = RECORDED.find((l) => l.msg["subtype"] === "init")?.msg ?? {};
const RESULT = RECORDED.find((l) => l.msg["type"] === "result")?.msg ?? {};
const own = (text: string) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text }] },
});
const backgroundOf = (n: number) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: Array.from({ length: n }, () => ({ task_type: "local_bash" })),
});
type Json = Record<string, unknown>;
/** Each request for the person, and the words of it the run shows. */
const ASKS: readonly { readonly request: Json; readonly asked: string }[] = [
  {
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      requires_user_interaction: true,
      input: { questions: [{ question: "Which export?", options: [{ label: "CSV" }] }] },
    },
    asked: "Which export? (CSV)",
  },
  {
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "rm -rf dist && npm test", description: "Run the cleanup script" },
      description: "Run the cleanup script",
    },
    asked:
      "Claude Code asks to use Bash: Run the cleanup script\n~~~\ncommand: rm -rf dist && npm test\n~~~",
  },
  {
    request: {
      subtype: "elicitation",
      mcp_server_name: "reports",
      message: "Which format should the export use?",
      requested_schema: {
        type: "object",
        properties: { format: { type: "string", title: "Format", enum: ["CSV", "PDF"] } },
      },
    },
    asked: "reports asks: Which format should the export use?\nFormat (CSV, PDF)",
  },
];

/** The words of the request the run heard, in a cell of TABLE. */
const ASKED = Symbol("the request's words");
/** The words of a run that ended on a line it could not read: TTasks's own, not the agent's. */
const UNREAD = expect.any(String) as string;

/** The answer the run shows: its words, and whether they are the agent's final answer. */
type Answer = readonly [text: string | null | typeof ASKED, final: boolean];

type Expected =
  /** The run goes on in this phase, after writing `wrote` to the program. */
  | {
      readonly goesOn: Exclude<Phase, "settled">;
      readonly answer: Answer;
      readonly wrote?: readonly string[];
    }
  /** The work settles with this. */
  | {
      readonly settles: Partial<Omit<Work, "text" | "textFinal">>;
      readonly answer: Answer;
      readonly wrote?: readonly string[];
    }
  /** Nothing changes: the work stays as it settled, and nothing reaches the program. */
  | "unchanged";

/**
 * Every phase against everything the driver can hear. A kind of line or a phase the driver adds
 * has no cell here: the type and the test both fail until it has one. Before it hears, a turn has
 * said nothing yet, and between turns the last turn's final answer is "First.".
 */
const TABLE: Readonly<Record<Phase, Readonly<Record<Heard, Expected>>>> = {
  turn: {
    turn: { goesOn: "turn", answer: ["Newer words.", false] },
    other: { goesOn: "turn", answer: [null, false] },
    result: { settles: { ok: true, outcome: "success" }, answer: ["Done.", true] },
    "result, more": { goesOn: "between", answer: ["Done.", true] },
    failed: {
      settles: { ok: false, outcome: "agent_error", error: "The API failed." },
      answer: [null, false],
    },
    asks: {
      settles: { outcome: "needs_input" },
      answer: [ASKED, false],
      wrote: ["turned down", "interrupt"],
    },
    "unknown request": { goesOn: "turn", answer: [null, false], wrote: ["error"] },
    unreadable: {
      settles: { ok: false, outcome: "agent_error", error: UNREAD },
      answer: [null, false],
      wrote: ["interrupt"],
    },
    exit: { settles: { ok: false, outcome: "no_result" }, answer: [null, false] },
    stop: { goesOn: "stopping", answer: [null, false], wrote: ["interrupt"] },
  },
  between: {
    turn: { goesOn: "turn", answer: ["Newer words.", false] },
    other: { goesOn: "between", answer: ["First.", true] },
    result: { settles: { ok: true, outcome: "success" }, answer: ["Done.", true] },
    "result, more": { goesOn: "between", answer: ["Done.", true] },
    // A turn whose first line is its result: what the last turn said is no answer of this one.
    failed: {
      settles: { ok: false, outcome: "agent_error", error: "The API failed." },
      answer: ["First.", false],
    },
    asks: {
      settles: { outcome: "needs_input" },
      answer: [ASKED, false],
      wrote: ["turned down", "interrupt"],
    },
    "unknown request": { goesOn: "between", answer: ["First.", true], wrote: ["error"] },
    unreadable: {
      settles: { ok: false, outcome: "agent_error", error: UNREAD },
      answer: ["First.", false],
      wrote: ["interrupt", "end"],
    },
    exit: { settles: { ok: false, outcome: "no_result" }, answer: ["First.", false] },
    stop: {
      settles: { ok: false, outcome: "interrupted" },
      answer: ["First.", true],
      wrote: ["interrupt", "end"],
    },
  },
  stopping: {
    turn: { goesOn: "stopping", answer: ["Newer words.", false] },
    other: { goesOn: "stopping", answer: [null, false] },
    result: { settles: { ok: false, outcome: "interrupted" }, answer: ["Done.", true] },
    "result, more": { settles: { ok: false, outcome: "interrupted" }, answer: ["Done.", true] },
    failed: { settles: { ok: false, outcome: "interrupted" }, answer: [null, false] },
    asks: { goesOn: "stopping", answer: [null, false], wrote: ["turned down"] },
    "unknown request": { goesOn: "stopping", answer: [null, false], wrote: ["error"] },
    unreadable: { settles: { ok: false, outcome: "interrupted" }, answer: [null, false] },
    exit: { settles: { ok: false, outcome: "interrupted" }, answer: [null, false] },
    stop: { goesOn: "stopping", answer: [null, false] },
  },
  settled: {
    turn: "unchanged",
    other: "unchanged",
    result: "unchanged",
    "result, more": "unchanged",
    failed: "unchanged",
    asks: "unchanged",
    "unknown request": "unchanged",
    unreadable: "unchanged",
    exit: "unchanged",
    stop: "unchanged",
  },
};

/** A driver brought to `phase`, with what it writes to the program summed up as it comes. */
async function driverIn(phase: Phase) {
  const toProgram = new PassThrough();
  const fromProgram = new PassThrough();
  const wrote: string[] = [];
  let pending = "";
  toProgram.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const m = JSON.parse(line) as { type: string; request?: Json; response?: Json };
      if (m.type === "control_request") wrote.push(String(m.request?.["subtype"]));
      else if (m.type === "control_response")
        wrote.push(m.response?.["subtype"] === "success" ? "turned down" : "error");
      else wrote.push(m.type);
    }
  });
  toProgram.on("finish", () => wrote.push("end"));
  let answer: Answer = [null, false];
  const driver = claudeDriver({ request: "Look." })(
    { stdin: toProgram, stdout: fromProgram },
    (event) => {
      if (event.kind === "answer") answer = [event.text, event.final];
    },
  );
  /** Writes `text` as the program does, and lets it be read. */
  const raw = async (text: string) => {
    fromProgram.write(text);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const say = (...messages: unknown[]) =>
    raw(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  await say(INIT);
  if (phase === "between") await say(backgroundOf(1), { ...RESULT, result: "First." });
  if (phase === "settled") await say({ ...RESULT, result: "First." });
  if (phase === "stopping") driver.interrupt();
  await say();
  wrote.splice(0);
  /** Closes the program's output, as a program does that then lives on. */
  const closeOutput = async () => {
    fromProgram.end();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { driver, wrote, say, raw, closeOutput, answer: () => answer };
}

/** Longer than a line read whole: a file a tool wrote, say. */
const BULK = "x".repeat(LINE_CAP_BYTES + 1);

/**
 * Makes the driver hear `heard`; `ask` is the request for the person, when it hears one. `long`:
 * the line it hears also carries more than a line read whole.
 */
async function makeHear(
  { driver, say, raw }: Awaited<ReturnType<typeof driverIn>>,
  heard: Heard,
  ask: (typeof ASKS)[number],
  long = false,
): Promise<void> {
  const line = (message: Json): Json => (long ? { ...message, bulk: BULK } : message);
  switch (heard) {
    case "turn":
      return say(line(own("Newer words.")));
    case "other":
      return say(line({ ...own("A helper's notes."), parent_tool_use_id: "toolu_h1" }));
    case "result":
      return say(backgroundOf(0), line({ ...RESULT, result: "Done." }));
    case "result, more":
      return say(line({ ...RESULT, result: "Done.", queued_turn_count: 1 }));
    case "failed":
      return say(
        line({
          ...RESULT,
          is_error: true,
          subtype: "error_during_execution",
          result: "The API failed.",
        }),
      );
    case "asks":
      return say(line({ type: "control_request", request_id: "r1", request: ask.request }));
    case "unreadable":
      // Longer than a line read whole, and not JSON: nothing of it can be read.
      return raw(`${BULK}\n`);
    case "unknown request":
      return say(
        line({ type: "control_request", request_id: "r2", request: { subtype: "later_kind" } }),
      );
    case "exit":
      driver.ended({ code: 1, signal: null });
      return say();
    case "stop":
      driver.interrupt();
      return say();
  }
}

describe("[A4.3.11.claude.driver] the claude driver's decisions: every phase against everything it hears", () => {
  // A line too long to read whole is heard as its short twin is: the work and its answer come from
  // the same reading of it.
  for (const long of [false, true]) {
    for (const phase of PHASES) {
      for (const heard of HEARD) {
        const name = `${phase}, hears ${heard}${long ? ", in a line too long to read whole" : ""}`;
        test(name, async () => {
          const expected = TABLE[phase][heard] as Expected | undefined;
          expect(expected, `no cell for ${phase} × ${heard}`).toBeDefined();
          if (expected === undefined) return;
          for (const ask of heard === "asks" ? ASKS : ASKS.slice(0, 1)) {
            const bench = await driverIn(phase);
            const before = await settledNow(bench.driver);
            await makeHear(bench, heard, ask, long);
            const work = await settledNow(bench.driver);
            if (expected === "unchanged") {
              expect(work).toEqual(before);
              expect(bench.wrote).toEqual([]);
              continue;
            }
            expect(bench.wrote).toEqual(expected.wrote ?? []);
            const [text, final] = expected.answer;
            const answer = [text === ASKED ? ask.asked : text, final];
            if ("settles" in expected) {
              expect(before).toBeUndefined();
              expect(work).toEqual(done(expected.settles));
              expect([work?.text, work?.textFinal], "the answer").toEqual(answer);
              continue;
            }
            expect(work).toBeUndefined();
            expect(bench.answer(), "the answer").toEqual(answer);
            // Which phase it goes on in shows in what a Stop then does.
            bench.wrote.splice(0);
            bench.driver.interrupt();
            await bench.say();
            const stopped = await settledNow(bench.driver);
            if (expected.goesOn === "between") {
              expect(stopped).toEqual(done({ outcome: "interrupted" }));
              expect(bench.wrote).toEqual(["interrupt", "end"]);
            } else {
              expect(stopped).toBeUndefined();
              expect(bench.wrote).toEqual(expected.goesOn === "turn" ? ["interrupt"] : []);
            }
          }
        });
      }
    }
  }

  test("a result the program ends on without a line end settles the work as one with it does, short or too long to read whole", async () => {
    for (const phase of ["turn", "between"] as const) {
      for (const long of [false, true]) {
        const bench = await driverIn(phase);
        const result = { ...RESULT, result: "Done.", ...(long ? { bulk: BULK } : {}) };
        await bench.say(backgroundOf(0));
        await bench.raw(JSON.stringify(result));
        bench.driver.ended({ code: 0, signal: null });
        expect(await settledNow(bench.driver), `${phase}, long: ${String(long)}`).toEqual(
          done({ ok: true, outcome: "success", text: "Done.", textFinal: true }),
        );
      }
    }
  });

  test("a result without a line end settles the work when the program closes its output, before it exits", async () => {
    for (const long of [false, true]) {
      const bench = await driverIn("turn");
      const result = { ...RESULT, result: "Done.", ...(long ? { bulk: BULK } : {}) };
      await bench.say(backgroundOf(0));
      await bench.raw(JSON.stringify(result));
      expect(await settledNow(bench.driver), `held, long: ${String(long)}`).toBeUndefined();
      await bench.closeOutput();
      expect(await settledNow(bench.driver), `long: ${String(long)}`).toEqual(
        done({ ok: true, outcome: "success", text: "Done.", textFinal: true }),
      );
      expect(bench.answer()).toEqual(["Done.", true]);
    }
  });

  test("a follow-up turn that ends at once with no words leaves the last turn's words provisional, in one write or several", async () => {
    for (const together of [true, false]) {
      const bench = await driverIn("between");
      const lines = [backgroundOf(0), { ...RESULT, result: "" }];
      if (together) await bench.say(...lines);
      else for (const line of lines) await bench.say(line);
      const work = await settledNow(bench.driver);
      expect(work, `together: ${String(together)}`).toEqual(
        done({ ok: true, outcome: "success", text: "First.", textFinal: false }),
      );
    }
  });
});

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
      expect.arrayContaining(["acceptEdits", "--allowedTools", "mcp__ttasks"]),
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
        command: "/opt/ttasks/bin/ttasks",
        args: ["mcp", "--space", "sp_x"],
        env: { TTASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
      }),
    ) as unknown;
    expect(file).toEqual({
      mcpServers: {
        ttasks: {
          type: "stdio",
          command: "/opt/ttasks/bin/ttasks",
          args: ["mcp", "--space", "sp_x"],
          env: { TTASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
        },
      },
    });
  });

  test("a run with a command, and a call of TTasks's tools: their progress is reported, and the tools connected", async () => {
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
        text: "Claude Code asks to use Bash: Fixture text.\n~~~\ncommand: Fixture text.\n~~~",
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
      text: "Claude Code asks to use Bash: Fixture text.\n~~~\ncommand: Fixture text.\n~~~",
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

  test("an MCP tool's question ends the run as needing the person, with the question and its choices, and is answered with no choice made", async () => {
    // One choice, and several choices in both of the forms MCP gives them.
    const fields: readonly Record<string, unknown>[] = [
      { type: "string", title: "Format", enum: ["CSV", "PDF"] },
      { type: "array", title: "Format", items: { type: "string", enum: ["CSV", "PDF"] } },
      {
        type: "array",
        title: "Format",
        items: {
          anyOf: [
            { const: "csv", title: "CSV" },
            { const: "pdf", title: "PDF" },
          ],
        },
      },
    ];
    for (const format of fields) {
      const requests = [
        {
          subtype: "elicitation",
          mcp_server_name: "reports",
          message: "Which format should the export use?",
          requested_schema: { type: "object", properties: { format } },
        },
      ];
      const { driver, fake } = bench({ fixture: "windows-plain", requests });
      expect(await driver.settled, JSON.stringify(format)).toEqual(
        done({
          ok: false,
          outcome: "needs_input",
          text: "reports asks: Which format should the export use?\nFormat (CSV, PDF)",
        }),
      );
      const answers = ofType(fake, "control_response").map((m) => m["response"]);
      expect(answers[0]).toEqual({
        subtype: "success",
        request_id: "fake-request-0",
        response: { action: "cancel" },
      });
    }
  });

  test("a permission prompt says what would run or change: the command, the file, the address, an MCP tool's arguments", async () => {
    const asked = async (request: Record<string, unknown>) => {
      const toProgram = new PassThrough();
      const fromProgram = new PassThrough();
      const driver = claudeDriver({ request: "Look." })(
        { stdin: toProgram, stdout: fromProgram },
        () => undefined,
      );
      const prompt = { type: "control_request", request_id: "p1", request };
      fromProgram.write(`${JSON.stringify(INIT)}\n${JSON.stringify(prompt)}\n`);
      const work = await driver.settled;
      driver.close();
      return work.text;
    };
    expect(
      await asked({
        subtype: "can_use_tool",
        tool_name: "Bash",
        description: "Run the cleanup script",
        input: { command: "rm -rf dist && npm test", description: "Run the cleanup script" },
      }),
    ).toBe(
      "Claude Code asks to use Bash: Run the cleanup script\n~~~\ncommand: rm -rf dist && npm test\n~~~",
    );
    expect(
      await asked({
        subtype: "can_use_tool",
        tool_name: "WebFetch",
        input: { url: "https://example.com/report", prompt: "Summarise it." },
      }),
    ).toBe(
      "Claude Code asks to use WebFetch.\n~~~\nurl: https://example.com/report\nprompt: Summarise it.\n~~~",
    );
    expect(
      await asked({
        subtype: "can_use_tool",
        tool_name: "mcp__calendar__create_event",
        input: { title: "Export review", day: "2026-11-24", attendees: ["Ana"] },
      }),
    ).toBe(
      'Claude Code asks to use mcp__calendar__create_event.\n~~~\ntitle: Export review\nday: 2026-11-24\nattendees: ["Ana"]\n~~~',
    );
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

  test("an error that only mentions a login, such as a plugin's, gets no hint to sign in to Claude Code", async () => {
    const recorded = readClaudeFixture("windows-plain").filter((l) => l.dir === "recv");
    const init = recorded.find((l) => l.msg["subtype"] === "init")?.msg ?? {};
    const result = recorded.find((l) => l.msg["type"] === "result")?.msg ?? {};
    const failed = {
      ...result,
      is_error: true,
      subtype: "error_during_execution",
      result: "The docs plugin's login server timed out.",
    };
    const toProgram = new PassThrough();
    const fromProgram = new PassThrough();
    const driver = claudeDriver({ request: "Look." })(
      { stdin: toProgram, stdout: fromProgram },
      () => undefined,
    );
    fromProgram.write(`${JSON.stringify(init)}\n${JSON.stringify(failed)}\n`);
    expect((await driver.settled).error).toBe("The docs plugin's login server timed out.");
    driver.close();
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
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_type: "local_agent" }],
      },
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
