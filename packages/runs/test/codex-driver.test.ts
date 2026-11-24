// The `codex` driver against a fake app server that speaks exactly the recorded exchanges
// (codex-server.ts, fixtures/codex-app-server), over a pair of in-memory pipes.
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  ANSWER_CAP_BYTES,
  LINE_CAP_BYTES,
  type RunEvent,
  type RunPermission,
} from "@ttasks/contracts/runs";
import { codexDriver, type CodexSession } from "../src/drivers/codex.ts";
import type { DriverSession, Work } from "../src/drivers/types.ts";
import { serveCodex, type FakeCodex, type FakeScenario } from "./codex-server.ts";

const TOOLS = {
  command: "/opt/ttasks/bin/ttasks",
  args: ["mcp", "--space", "sp_x", "--instance", "codex", "--app", "codex"],
  env: { TTASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
};

interface Bench {
  readonly driver: DriverSession;
  readonly fake: FakeCodex;
  readonly events: RunEvent[];
  readonly toServer: PassThrough;
  /** Says what the server says, beside the replay. */
  readonly say: (method: string, params: Record<string, unknown>) => void;
  /** Asks what the server asks, beside the replay. */
  readonly ask: (id: number, method: string, params: Record<string, unknown>) => void;
  /** Writes what the server writes, as it is. */
  readonly raw: (text: string) => void;
}

function bench(scenario: FakeScenario, session: Partial<CodexSession> = {}): Bench {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const fake = serveCodex(toServer, fromServer, scenario);
  const events: RunEvent[] = [];
  const driver = codexDriver({
    request: "Look into the export.",
    permission: "full-access",
    tools: TOOLS,
    ...session,
  })({ stdin: toServer, stdout: fromServer }, (event) => events.push(event));
  const say = (method: string, params: Record<string, unknown>): void => {
    fromServer.write(`${JSON.stringify({ method, params })}\n`);
  };
  const ask = (id: number, method: string, params: Record<string, unknown>): void => {
    fromServer.write(`${JSON.stringify({ id, method, params })}\n`);
  };
  const raw = (text: string): void => {
    fromServer.write(text);
  };
  return { driver, fake, events, toServer, say, ask, raw };
}

/** The work, or undefined while it has not settled. */
async function settledNow(driver: DriverSession): Promise<Work | undefined> {
  // Whatever the server said was read first.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const pending = Symbol("pending");
  const first = await Promise.race([driver.settled, Promise.resolve(pending)]);
  return first === pending ? undefined : first;
}

const THREAD = "00000000-0000-4000-8000-000000000002";
const CHILD = "00000000-0000-4000-8000-0000000000c1";
const CHILD_TURN = "00000000-0000-4000-8000-0000000000c2";

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
    // No cwd: the thread works in the server's own folder, and Codex records no trust for it.
    const [thread] = sent(fake, "thread/start");
    expect(thread?.["params"]).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        "mcp_servers.ttasks": {
          command: "/opt/ttasks/bin/ttasks",
          args: TOOLS.args,
          env: { TTASKS_TICKET: "0123456789ABCDEFGHJKMNPQ" },
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

  test("each approval the permission gives is accepted, while the turn goes on", async () => {
    const requests = {
      command: { method: "item/commandExecution/requestApproval", params: { itemId: "exec-1" } },
      file: { method: "item/fileChange/requestApproval", params: { itemId: "exec-2" } },
      exec: { method: "execCommandApproval", params: { callId: "c1", command: ["echo", "hi"] } },
      patch: { method: "applyPatchApproval", params: { callId: "c2" } },
      permissions: {
        method: "item/permissions/requestApproval",
        params: { itemId: "exec-3", permissions: { network: { enabled: true } } },
      },
    };
    const given: [RunPermission, (keyof typeof requests)[], unknown[]][] = [
      [
        "full-access",
        ["command", "file", "exec", "patch", "permissions"],
        [
          { decision: "accept" },
          { decision: "accept" },
          { decision: "approved" },
          { decision: "approved" },
          { permissions: { network: { enabled: true } }, scope: "turn" },
        ],
      ],
      ["auto-edit", ["file", "patch"], [{ decision: "accept" }, { decision: "approved" }]],
    ];
    for (const [permission, kinds, answers] of given) {
      const { driver, fake } = bench(
        { fixture: "windows-plain", requests: kinds.map((kind) => requests[kind]) },
        { permission },
      );
      expect(await driver.settled, permission).toEqual(done({ ok: true }));
      expect(
        kinds.map((_k, n) => answerTo(fake, 100 + n)?.["result"]),
        permission,
      ).toEqual(answers);
      driver.close();
    }
  });

  test("an approval the permission does not give ends the run as needing the person, with what Codex asks", async () => {
    const asked: [RunPermission, string, Record<string, unknown>, string][] = [
      [
        "auto-edit",
        "item/commandExecution/requestApproval",
        { itemId: "exec-1", reason: "Fixture reason.", command: "echo hi" },
        "Codex asks to run a command: Fixture reason.\n~~~\necho hi\n~~~",
      ],
      [
        "read-only",
        "execCommandApproval",
        { callId: "c1", command: ["echo", "two words", "it's"] },
        "Codex asks to run a command.\n~~~\necho 'two words' 'it'\\''s'\n~~~",
      ],
      [
        "read-only",
        "item/commandExecution/requestApproval",
        { itemId: "exec-2", command: "cat <<X\n~~~\n```\n~~~~\nX" },
        "Codex asks to run a command.\n~~~~~\ncat <<X\n~~~\n```\n~~~~\nX\n~~~~~",
      ],
      [
        "read-only",
        "applyPatchApproval",
        { callId: "c2", fileChanges: { "/work/notes.md": {} }, grantRoot: "/work" },
        "Codex asks to change files.\n~~~\n/work/notes.md\n/work (all of it)\n~~~",
      ],
      [
        "auto-edit",
        "item/permissions/requestApproval",
        {
          itemId: "exec-3",
          permissions: { network: { enabled: true }, fileSystem: { write: ["/work/out"] } },
        },
        "Codex asks for more permissions.\n~~~\nnetwork access\nwrite /work/out\n~~~",
      ],
    ];
    for (const [permission, method, params, text] of asked) {
      const { driver, fake } = bench(
        { fixture: "windows-plain", requests: [{ method, params }] },
        { permission },
      );
      expect(await driver.settled, method).toEqual(
        done({ ok: false, outcome: "needs_input", text, textFinal: false }),
      );
      expect(answerTo(fake, 100), method).toBeUndefined();
      driver.close();
    }
  });

  test("the recorded approvals: accepted with full access; in a read-only run the file change needs the person", async () => {
    const full = bench({ fixture: "windows-approval-command" });
    expect(await full.driver.settled).toEqual(done({ ok: true, declined: 0 }));
    expect(answerTo(full.fake, 0)?.["result"]).toEqual({ decision: "accept" });
    const narrow = bench({ fixture: "windows-approval-file" }, { permission: "read-only" });
    expect(await narrow.driver.settled).toEqual(
      done({
        ok: false,
        outcome: "needs_input",
        // The file is the one the recorded change names just before it asks.
        text: "Codex asks to change files.\n~~~\nC:\\fixture\\path-3\n~~~",
      }),
    );
    expect(answerTo(narrow.fake, 0)).toBeUndefined();
    await until("the turn interrupted", () => sent(narrow.fake, "turn/interrupt").length === 1);
    narrow.driver.close();
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

  test("a question the turn ends with is kept, and the run needs the person, not done", async () => {
    const { driver } = bench({
      fixture: "windows-plain",
      notifications: [
        {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "ask-1",
              text: "Two exports exist.",
              phase: "final_answer",
              delivery: "async",
              questions: [{ title: "Which one should I fix?", options: ["CSV", "PDF"] }],
            },
          },
        },
      ],
    });
    expect(await driver.settled).toEqual(
      done({
        ok: false,
        outcome: "needs_input",
        text: "Two exports exist.\nWhich one should I fix? (CSV, PDF)",
        textFinal: false,
      }),
    );
    driver.close();
  });

  test("an agent the run's agent started works in a thread of its own: its turn and answer are never the run's", async () => {
    const { driver } = bench({
      fixture: "windows-plain",
      answer: "The run's own answer.",
      notifications: [
        { method: "thread/started", params: { thread: { id: CHILD } } },
        { method: "turn/started", params: { threadId: CHILD, turn: { id: CHILD_TURN } } },
        {
          method: "item/completed",
          params: {
            threadId: CHILD,
            turnId: CHILD_TURN,
            item: {
              type: "agentMessage",
              id: "c-1",
              text: "A helper's answer.",
              phase: "final_answer",
            },
          },
        },
        {
          method: "turn/completed",
          params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed", error: null } },
        },
      ],
    });
    expect(await driver.settled).toEqual(
      done({ ok: true, text: "The run's own answer.", textFinal: true, nativeId: THREAD }),
    );
    driver.close();
  });

  test("the run's turn completed while an agent it started still works: the run waits for it, and that agent's end is not the run's", async () => {
    const { driver, fake, say } = bench({
      fixture: "windows-plain",
      notifications: [
        { method: "turn/started", params: { threadId: CHILD, turn: { id: CHILD_TURN } } },
      ],
    });
    await fake.replayed;
    expect(await settledNow(driver)).toBeUndefined();
    say("turn/completed", {
      threadId: CHILD,
      turn: { id: CHILD_TURN, status: "failed", error: { message: "A helper failed." } },
    });
    expect(await driver.settled).toEqual(
      done({ ok: true, text: "Fixture text.", textFinal: true }),
    );
    driver.close();
  });

  test("an agent the run's agent started whose thread stops without ending its turn no longer holds the run", async () => {
    const { driver, fake, say } = bench({
      fixture: "windows-plain",
      notifications: [
        {
          method: "thread/status/changed",
          params: { threadId: CHILD, status: { type: "active" } },
        },
      ],
    });
    await fake.replayed;
    expect(await settledNow(driver)).toBeUndefined();
    say("thread/status/changed", { threadId: CHILD, status: { type: "systemError" } });
    expect(await driver.settled).toEqual(done({ ok: true, text: "Fixture text." }));
    driver.close();
  });

  test("a helper whose thread is closed while its command runs in the background no longer holds the run", async () => {
    const { driver, fake, say } = bench({
      fixture: "windows-plain",
      notifications: [
        { method: "turn/started", params: { threadId: CHILD, turn: { id: CHILD_TURN } } },
        {
          method: "item/started",
          params: {
            threadId: CHILD,
            turnId: CHILD_TURN,
            item: { type: "commandExecution", id: "exec-child", status: "inProgress" },
          },
        },
        {
          method: "turn/completed",
          params: { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed", error: null } },
        },
      ],
    });
    await fake.replayed;
    // The helper's turn ended, and its command goes on in the background: the run waits.
    expect(await settledNow(driver)).toBeUndefined();
    say("thread/closed", { threadId: CHILD });
    expect(await driver.settled).toEqual(done({ ok: true, text: "Fixture text." }));
    driver.close();
  });

  test("a question the turn ended with is kept when the wait for its background work is stopped", async () => {
    const { driver, fake } = bench({
      fixture: "windows-plain",
      notifications: [
        {
          method: "item/started",
          params: { item: { type: "commandExecution", id: "exec-bg", status: "inProgress" } },
        },
        {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "ask-2",
              text: "",
              phase: "final_answer",
              delivery: "async",
              questions: [{ title: "Keep the old export?" }],
            },
          },
        },
      ],
    });
    await fake.replayed;
    expect(await settledNow(driver)).toBeUndefined();
    driver.interrupt();
    expect(await driver.settled).toEqual(
      done({ ok: false, outcome: "interrupted", text: "Keep the old export?" }),
    );
    driver.close();
  });

  test("a question from an agent the run's agent started is that agent's: it hears no one answered, and the run's turn goes on", async () => {
    const requests = [
      {
        method: "item/tool/requestUserInput",
        params: {
          threadId: CHILD,
          turnId: CHILD_TURN,
          itemId: "ask-c",
          isBlocking: true,
          questions: [{ id: "q1", header: "Export", question: "Which one?", options: [] }],
        },
      },
      {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: CHILD,
          turnId: CHILD_TURN,
          serverName: "docs",
          mode: "form",
          message: "Fill in the export's name.",
          requestedSchema: { type: "object", properties: {} },
        },
      },
    ];
    const { driver, fake } = bench({ fixture: "windows-plain", requests });
    expect(await driver.settled).toEqual(
      done({ ok: true, outcome: "success", text: "Fixture text.", textFinal: true }),
    );
    expect(answerTo(fake, 100)?.["result"]).toEqual({ answers: {} });
    expect(answerTo(fake, 101)?.["result"]).toEqual({ action: "decline" });
    expect(sent(fake, "turn/interrupt")).toEqual([]);
    driver.close();
  });

  test("a form the run's own thread is asked to fill in ends the run as needing the person", async () => {
    const requests = [
      {
        method: "mcpServer/elicitation/request",
        params: {
          serverName: "docs",
          mode: "form",
          message: "Fill in the export's name.",
          requestedSchema: { type: "object", properties: {} },
        },
      },
    ];
    const { driver, fake } = bench({ fixture: "windows-plain", requests });
    expect(await driver.settled).toEqual(
      done({ ok: false, outcome: "needs_input", text: "Fill in the export's name." }),
    );
    expect(answerTo(fake, 100)).toBeUndefined();
    driver.close();
  });

  test("a question the turn ended with stays what the run says when a later answer comes: in what is saved, too", async () => {
    const { driver, fake, events, say } = bench({
      fixture: "windows-plain",
      answer: "An answer after the question.",
      notifications: [
        {
          method: "item/started",
          params: { item: { type: "commandExecution", id: "exec-bg", status: "inProgress" } },
        },
        {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "ask-3",
              text: "",
              phase: "final_answer",
              delivery: "async",
              questions: [{ title: "Keep the old export?" }],
            },
          },
        },
      ],
    });
    await fake.replayed;
    expect(await settledNow(driver)).toBeUndefined();
    // What the run's folder keeps is the last answer event: a crash now recovers it.
    const saved = events.filter((e) => e.kind === "answer").at(-1);
    expect(saved).toMatchObject({ text: "Keep the old export?", final: false });
    say("item/completed", {
      item: { type: "commandExecution", id: "exec-bg", status: "completed" },
    });
    expect(await driver.settled).toEqual(
      done({ ok: false, outcome: "needs_input", text: "Keep the old export?", textFinal: false }),
    );
    expect(events.filter((e) => e.kind === "answer").at(-1)).toMatchObject({
      text: "Keep the old export?",
    });
    driver.close();
  });

  test("a question or form that comes after the work settled hears no one answered, and changes nothing the run says", async () => {
    const { driver, fake, events, ask } = bench({ fixture: "windows-plain" });
    expect(await driver.settled).toEqual(done({ ok: true, text: "Fixture text." }));
    const before = events.length;
    ask(900, "item/tool/requestUserInput", {
      itemId: "late-1",
      isBlocking: true,
      questions: [{ id: "q1", header: "Export", question: "Which one?", options: [] }],
    });
    ask(901, "mcpServer/elicitation/request", {
      serverName: "docs",
      mode: "form",
      message: "Fill in the export's name.",
      requestedSchema: { type: "object", properties: {} },
    });
    ask(902, "item/commandExecution/requestApproval", { itemId: "late-2" });
    await until("the late requests answered", () => answerTo(fake, 902) !== undefined);
    expect(answerTo(fake, 900)?.["result"]).toEqual({ answers: {} });
    expect(answerTo(fake, 901)?.["result"]).toEqual({ action: "decline" });
    expect(answerTo(fake, 902)?.["result"]).toEqual({ decision: "decline" });
    // What the run's folder keeps is the last answer event: none came after the work settled.
    expect(events.slice(before)).toEqual([]);
    expect(sent(fake, "turn/interrupt")).toEqual([]);
    driver.close();
  });

  test("a thread the server says works in another folder than the run's is given no work", async () => {
    const { driver, fake } = bench(
      { fixture: "windows-plain" },
      { inFolder: (cwd) => Promise.resolve(cwd === "C:\\Users\\mira\\code\\portal") },
    );
    const work = await driver.settled;
    expect(work).toEqual(done({ ok: false, outcome: "agent_error" }));
    expect(work.error).toContain("C:\\fixture\\work");
    expect(sent(fake, "turn/start")).toEqual([]);
    driver.close();
  });

  test("a thread the server names no folder for is given no work when the folder is checked", async () => {
    const { driver, fake } = bench(
      { fixture: "windows-plain", cwd: null },
      { inFolder: () => Promise.resolve(true) },
    );
    const work = await driver.settled;
    expect(work).toEqual(done({ ok: false, outcome: "agent_error" }));
    expect(work.error).toContain("did not say which folder");
    expect(sent(fake, "turn/start")).toEqual([]);
    driver.close();
  });

  test("a folder check that does not answer: Stop still ends the work at once, and no turn starts after it", async () => {
    let answer: (same: boolean) => void = () => undefined;
    let asked = false;
    const { driver, fake } = bench(
      { fixture: "windows-plain" },
      {
        inFolder: () => {
          asked = true;
          return new Promise<boolean>((resolve) => {
            answer = resolve;
          });
        },
      },
    );
    await until("the folder checked", () => asked);
    driver.interrupt();
    expect(await driver.settled).toEqual(done({ ok: false, outcome: "interrupted" }));
    answer(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent(fake, "turn/start")).toEqual([]);
    driver.close();
  });

  test("a folder check that does not answer in time gives no work, in words of its own", async () => {
    const { driver, fake } = bench(
      { fixture: "windows-plain" },
      { startMs: 200, inFolder: () => new Promise<boolean>(() => undefined) },
    );
    const work = await driver.settled;
    expect(work).toEqual(done({ ok: false, outcome: "agent_error" }));
    expect(work.error).toContain("did not answer in time");
    expect(sent(fake, "turn/start")).toEqual([]);
    driver.close();
  });

  test("an app server that ends while background work still runs: the work did not finish", async () => {
    const { driver, fake } = bench({
      fixture: "windows-plain",
      notifications: [
        {
          method: "item/started",
          params: { item: { type: "commandExecution", id: "exec-bg", status: "inProgress" } },
        },
      ],
    });
    await fake.replayed;
    expect(await settledNow(driver)).toBeUndefined();
    driver.ended({ code: 1, signal: null });
    expect(await driver.settled).toEqual(
      done({ ok: false, outcome: "no_result", text: "Fixture text.", textFinal: false }),
    );
  });

  /** A run whose turn is the test's to tell: the server says nothing more of its own. */
  async function toldTurn(): Promise<Bench> {
    const told = bench({ fixture: "windows-plain", stallAt: "turn/start" });
    await until("the turn asked for", () => sent(told.fake, "turn/start").length === 1);
    told.say("turn/started", { threadId: THREAD, turn: { id: "turn-told" } });
    return told;
  }

  test("words that stream in from the agent's commentary or from a helper's thread are never the run's answer", async () => {
    const { driver, events, say } = await toldTurn();
    say("item/started", {
      threadId: THREAD,
      item: { type: "agentMessage", id: "note-1", text: "", phase: "commentary" },
    });
    say("item/agentMessage/delta", { threadId: THREAD, itemId: "note-1", delta: "Looking." });
    say("item/started", {
      threadId: CHILD,
      item: { type: "agentMessage", id: "help-1", text: "", phase: "final_answer" },
    });
    say("item/agentMessage/delta", { threadId: CHILD, itemId: "help-1", delta: "A helper's." });
    expect(await settledNow(driver)).toBeUndefined();
    driver.ended({ code: 1, signal: null });
    expect(await driver.settled).toEqual(done({ outcome: "no_result", text: null }));
    expect(events.filter((e) => e.kind === "answer")).toEqual([]);
  });

  test("a question in the turn's summary, before its own message, ends the run as needing the person", async () => {
    const { driver, say } = await toldTurn();
    const ask = {
      type: "agentMessage",
      id: "ask-4",
      text: "Two exports exist.",
      phase: "final_answer",
      delivery: "async",
      questions: [{ title: "Which one should I fix?", options: ["CSV", "PDF"] }],
    };
    say("turn/completed", {
      threadId: THREAD,
      turn: { id: "turn-told", items: [ask], itemsView: "summary", status: "completed" },
    });
    say("item/completed", { threadId: THREAD, item: ask });
    expect(await driver.settled).toEqual(
      done({
        outcome: "needs_input",
        text: "Two exports exist.\nWhich one should I fix? (CSV, PDF)",
        textFinal: false,
      }),
    );
  });

  test("an answer that streams in past the cap keeps its first megabyte, marked as cut", async () => {
    const { driver, say } = await toldTurn();
    say("item/started", {
      threadId: THREAD,
      item: { type: "agentMessage", id: "long-1", text: "", phase: "final_answer" },
    });
    const head = "x".repeat(ANSWER_CAP_BYTES - 3);
    for (const delta of [head, "éé", "more"]) {
      say("item/agentMessage/delta", { threadId: THREAD, itemId: "long-1", delta });
    }
    expect(await settledNow(driver)).toBeUndefined();
    driver.ended({ code: 1, signal: null });
    const work = await driver.settled;
    expect(work).toEqual(done({ outcome: "no_result", textCut: true, textFinal: false }));
    expect(work.text === `${head}é`).toBe(true);
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

  test("a command whose completion is too long to read still ends: the turn's work settles with its answer", async () => {
    const { driver, fake } = bench({
      fixture: "windows-plain",
      notifications: [
        {
          method: "item/started",
          params: { item: { type: "commandExecution", id: "exec-big", status: "inProgress" } },
        },
        {
          method: "item/completed",
          params: {
            item: {
              type: "commandExecution",
              id: "exec-big",
              status: "completed",
              aggregatedOutput: "x".repeat(LINE_CAP_BYTES),
              exitCode: 0,
            },
          },
        },
      ],
    });
    await fake.replayed;
    expect(await settledNow(driver)).toEqual(
      done({ ok: true, outcome: "success", text: "Fixture text.", textFinal: true }),
    );
    driver.close();
  });

  test("a message that cannot be read ends the run at once as failed, with what the agent said, not final", async () => {
    const { driver, say, raw } = bench({ fixture: "windows-plain", stallAt: "initialize" });
    say("thread/started", { thread: { id: THREAD } });
    say("turn/started", { threadId: THREAD, turn: { id: "turn-1" } });
    say("item/started", {
      threadId: THREAD,
      item: { type: "agentMessage", id: "say-1", text: "", phase: "final_answer" },
    });
    say("item/agentMessage/delta", { threadId: THREAD, itemId: "say-1", delta: "Half done." });
    say("item/started", {
      threadId: THREAD,
      item: { type: "commandExecution", id: "exec-1", status: "inProgress" },
    });
    // The command's completion, longer than a line read whole, breaks off: it is not JSON.
    const completion = JSON.stringify({
      method: "item/completed",
      params: {
        threadId: THREAD,
        item: {
          type: "commandExecution",
          id: "exec-1",
          aggregatedOutput: "x".repeat(LINE_CAP_BYTES),
        },
      },
    });
    raw(`${completion.slice(0, -3)}\n`);
    expect(await settledNow(driver)).toEqual(
      done({ ok: false, outcome: "agent_error", text: "Half done.", textFinal: false }),
    );
    driver.close();
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
