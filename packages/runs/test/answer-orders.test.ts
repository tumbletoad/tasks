// One table of the orders in which an agent's words can reach its driver, run against every
// driver whose protocol can say them: whatever the agent said by the time its work settles is the
// work's text, and work that succeeded never has an empty answer when one was given. A row names
// the drivers it applies to; the others list it as skipped. A fake that is asked to say a step its
// protocol has no words for fails the row.
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OutcomeReason } from "@ttasks/contracts/runs";
import { claudeDriver } from "../src/drivers/claude.ts";
import { codexDriver } from "../src/drivers/codex.ts";
import { printDriver } from "../src/drivers/print.ts";
import type { DriverSession, OpenDriver } from "../src/drivers/types.ts";

/** What a message is in Codex's protocol: its answer, its commentary, or not said (null). */
type Phase = "final_answer" | "commentary" | null;

type Step =
  /** Part of message `item`, before it is whole. Empty: the message only starts. */
  | {
      readonly kind: "streams";
      readonly item: string;
      readonly text: string;
      readonly phase: Phase;
    }
  /** Message `item`, whole; of an earlier turn when `turn` names one. */
  | {
      readonly kind: "message";
      readonly item: string;
      readonly text: string;
      readonly phase: Phase;
      /** A question for the person the message ends with. */
      readonly asks?: string;
      readonly turn?: number;
    }
  /** The turn ends, its summary naming the answer's message with its words, or naming none. */
  | {
      readonly kind: "turn ends";
      readonly names: { readonly item: string; readonly text: string } | null;
    }
  /** The agent starts a turn of its own on the same run. */
  | { readonly kind: "turn starts" }
  /** A command the agent leaves running in the background starts, or ends. */
  | { readonly kind: "command starts" }
  | { readonly kind: "command ends" }
  /** Longer than any wait for a message still to come. */
  | { readonly kind: "time passes" }
  | { readonly kind: "output ends" }
  | { readonly kind: "stop" };

interface Agent {
  readonly driver: DriverSession;
  readonly say: (step: Step) => Promise<void>;
}

type Speaker = () => Promise<Agent>;

/** Lets whatever was written be read. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const noWords = (driver: string, step: Step): Error =>
  new Error(`${driver} has no words for "${step.kind}": the row does not apply to it`);

function pipes(): { toAgent: PassThrough; fromAgent: PassThrough; write: (line: object) => void } {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  return {
    toAgent,
    fromAgent,
    // An agent that exited says nothing more.
    write: (line) => {
      if (!fromAgent.writableEnded) fromAgent.write(`${JSON.stringify(line)}\n`);
    },
  };
}

const THREAD = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-0000000000a1";
const turnId = (turn: number): string => `turn-${String(turn)}`;

/** Codex's app server: messages of a turn by item, streamed or whole, and turns with summaries. */
const codex: Speaker = async () => {
  const { toAgent, fromAgent, write } = pipes();
  let started: () => void = () => undefined;
  const turnStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let turn = 1;
  let command = 0;
  const begun = new Set<string>();
  createInterface({ input: toAgent }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.id === undefined) return;
    switch (message.method) {
      case "initialize":
        write({ id: message.id, result: {} });
        return;
      case "thread/start":
        write({ id: message.id, result: { thread: { id: THREAD } } });
        return;
      case "turn/start":
        write({ id: message.id, result: { turn: { id: turnId(turn) } } });
        write({ method: "turn/started", params: { threadId: THREAD, turn: { id: turnId(turn) } } });
        started();
        return;
      case "turn/interrupt":
        write({ id: message.id, result: {} });
        write({
          method: "turn/completed",
          params: {
            threadId: THREAD,
            turn: { id: turnId(turn), items: [], itemsView: "notLoaded", status: "interrupted" },
          },
        });
        return;
      default:
        write({ id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  });
  const driver = codexDriver({ request: "Look into the export.", permission: "full-access" })(
    { stdin: toAgent, stdout: fromAgent },
    () => undefined,
  );
  await turnStarted;
  const id = (item: string, of = turn): string => `${turnId(of)}-${item}`;
  const agentMessage = (
    item: string,
    text: string,
    phase: Phase,
    asks?: string,
    of?: number,
  ): object => ({
    type: "agentMessage",
    id: id(item, of),
    text,
    phase,
    delivery: asks === undefined ? null : "async",
    questions: asks === undefined ? null : [{ title: asks, options: ["CSV", "PDF"] }],
  });
  const of = (at = turn) => ({ threadId: THREAD, turnId: turnId(at) });
  return {
    driver,
    say: async (step) => {
      switch (step.kind) {
        case "streams":
          if (!begun.has(id(step.item))) {
            begun.add(id(step.item));
            write({
              method: "item/started",
              params: { ...of(), item: agentMessage(step.item, "", step.phase) },
            });
          }
          if (step.text !== "") {
            write({
              method: "item/agentMessage/delta",
              params: { ...of(), itemId: id(step.item), delta: step.text },
            });
          }
          break;
        case "message":
          write({
            method: "item/completed",
            params: {
              ...of(step.turn),
              item: agentMessage(step.item, step.text, step.phase, step.asks, step.turn),
            },
          });
          break;
        case "turn ends":
          write({
            method: "turn/completed",
            params: {
              threadId: THREAD,
              turn: {
                id: turnId(turn),
                items:
                  step.names === null
                    ? []
                    : [agentMessage(step.names.item, step.names.text, "final_answer")],
                itemsView: step.names === null ? "notLoaded" : "summary",
                status: "completed",
                error: null,
              },
            },
          });
          break;
        case "turn starts":
          turn += 1;
          write({
            method: "turn/started",
            params: { threadId: THREAD, turn: { id: turnId(turn) } },
          });
          break;
        case "command starts":
          command += 1;
          write({
            method: "item/started",
            params: {
              ...of(),
              item: {
                type: "commandExecution",
                id: `cmd-${String(command)}`,
                status: "inProgress",
              },
            },
          });
          break;
        case "command ends":
          write({
            method: "item/completed",
            params: {
              ...of(),
              item: { type: "commandExecution", id: `cmd-${String(command)}`, status: "completed" },
            },
          });
          break;
        case "time passes":
          await settle();
          vi.advanceTimersByTime(60_000);
          break;
        case "output ends":
          driver.ended({ code: 1, signal: null });
          break;
        case "stop":
          driver.interrupt();
          break;
      }
      await settle();
    },
  };
};

/**
 * Claude Code's print mode, through `open`: whole messages and a result. Without partial messages,
 * which no driver asks for, nothing is said while a message is being written. With `stops`, Stop
 * goes over its input; else the program exits after its result.
 */
const claudeLike =
  (name: string, open: OpenDriver, stops: boolean): Speaker =>
  () => {
    const { toAgent, fromAgent, write } = pipes();
    toAgent.resume();
    const driver = open({ stdin: toAgent, stdout: fromAgent }, () => undefined);
    write({ type: "system", subtype: "init", session_id: SESSION, mcp_servers: [] });
    return Promise.resolve({
      driver,
      say: async (step) => {
        switch (step.kind) {
          case "message":
            if (step.phase !== "final_answer" || step.asks !== undefined || step.turn) {
              throw noWords(name, step);
            }
            write({
              type: "assistant",
              session_id: SESSION,
              message: { role: "assistant", content: [{ type: "text", text: step.text }] },
            });
            break;
          case "turn ends":
            write({
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: SESSION,
              result: step.names?.text ?? "",
            });
            if (!stops) {
              fromAgent.end();
              await settle();
              driver.ended({ code: 0, signal: null });
            }
            break;
          case "output ends":
            fromAgent.end();
            await settle();
            driver.ended({ code: 1, signal: null });
            break;
          case "stop":
            if (!stops) throw noWords(name, step);
            driver.interrupt();
            write({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              session_id: SESSION,
              terminal_reason: "aborted_streaming",
            });
            break;
          default:
            throw noWords(name, step);
        }
        await settle();
      },
    });
  };

const SPEAKERS: Readonly<Record<string, Speaker>> = {
  codex,
  claude: claudeLike("claude", claudeDriver({ request: "Look into the export." }), true),
  "claude-print": claudeLike("claude-print", printDriver("claude-print"), false),
};

const ANSWER = "The export drops the last row.";
const streams = (item: string, text: string, phase: Phase = "final_answer"): Step => ({
  kind: "streams",
  item,
  text,
  phase,
});
const message = (
  item: string,
  text: string,
  more: { phase?: Phase; asks?: string; turn?: number } = {},
): Step => ({ kind: "message", item, text, phase: "final_answer", ...more });
const turnEnds = (item?: string, text?: string): Step => ({
  kind: "turn ends",
  names: item === undefined ? null : { item, text: text ?? "" },
});
const turnStarts: Step = { kind: "turn starts" };
const commandStarts: Step = { kind: "command starts" };
const commandEnds: Step = { kind: "command ends" };
const timePasses: Step = { kind: "time passes" };
const outputEnds: Step = { kind: "output ends" };
const stop: Step = { kind: "stop" };

/** Every driver; the ones that can stop their agent over the protocol; Codex alone. */
const ALL = ["codex", "claude", "claude-print"] as const;
const STOPS = ["codex", "claude"] as const;
const CODEX = ["codex"] as const;

/** Each order, and how the work settles: its outcome, its text, and whether that is final. */
const ORDERS: readonly {
  readonly name: string;
  readonly for: readonly string[];
  readonly steps: readonly Step[];
  readonly outcome: OutcomeReason;
  readonly text: string | null;
  readonly final: boolean;
}[] = [
  {
    name: "the answer streams, then the output ends",
    for: CODEX,
    steps: [streams("A", "The export "), streams("A", "drops"), outputEnds],
    outcome: "no_result",
    text: "The export drops",
    final: false,
  },
  {
    name: "the answer is whole, then the output ends",
    for: ALL,
    steps: [message("A", ANSWER), outputEnds],
    outcome: "no_result",
    text: ANSWER,
    final: false,
  },
  {
    name: "the answer streams and is whole, then the output ends",
    for: CODEX,
    steps: [streams("A", "The export "), message("A", ANSWER), outputEnds],
    outcome: "no_result",
    text: ANSWER,
    final: false,
  },
  {
    name: "the answer, then the turn's end with it",
    for: ALL,
    steps: [message("A", ANSWER), turnEnds("A", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the answer streams and is whole, then the turn's end with it",
    for: CODEX,
    steps: [streams("A", "The export "), message("A", ANSWER), turnEnds("A", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the turn's end with the answer comes before the answer's own message",
    for: CODEX,
    steps: [streams("A", "The export "), turnEnds("A", ANSWER), message("A", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the turn's end without a summary comes while the answer streams, and nothing more comes",
    for: CODEX,
    steps: [streams("A", "The export "), streams("A", "drops"), turnEnds(), timePasses],
    outcome: "success",
    text: "The export drops",
    final: false,
  },
  {
    name: "Stop while the answer streams",
    for: CODEX,
    steps: [streams("A", "The export "), streams("A", "drops"), stop],
    outcome: "interrupted",
    text: "The export drops",
    final: false,
  },
  {
    name: "Stop after a whole message",
    for: STOPS,
    steps: [message("A", ANSWER), stop],
    outcome: "interrupted",
    text: ANSWER,
    final: false,
  },
  {
    name: "a whole answer, then a later one streams, then the output ends",
    for: CODEX,
    steps: [message("A", ANSWER), streams("B", "Also "), streams("B", "the header"), outputEnds],
    outcome: "no_result",
    text: "Also the header",
    final: false,
  },
  {
    name: "the turn's summary names a whole answer after a later message of only spaces",
    for: ALL,
    steps: [message("A", ANSWER), message("B", "  "), turnEnds("A", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the turn's summary names the answer after a late piece of an earlier message",
    for: CODEX,
    steps: [
      streams("A", "Looking "),
      message("B", ANSWER),
      streams("A", "further"),
      turnEnds("B", ANSWER),
    ],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the answer completes empty, then the turn's summary gives its words",
    for: CODEX,
    steps: [message("A", ""), turnEnds("A", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the answer streams, then the turn's summary gives it empty",
    for: CODEX,
    steps: [streams("A", "The export "), turnEnds("A", "")],
    outcome: "success",
    text: "The export ",
    final: false,
  },
  {
    name: "the answer streams, then the turn's summary names another message",
    for: CODEX,
    steps: [streams("A", "Looking"), turnEnds("B", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "an answer of only spaces is no answer",
    for: CODEX,
    steps: [message("A", "  "), turnEnds("A", "  ")],
    outcome: "success",
    text: null,
    final: false,
  },
  {
    name: "the turn's end without a summary, then the answer's own message",
    for: CODEX,
    steps: [streams("A", ""), turnEnds(), message("A", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the turn's end without a summary while the answer streams, then its own message",
    for: CODEX,
    steps: [streams("A", "The export "), turnEnds(), message("A", ANSWER)],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "the turn's end without a summary while the answer streams, then it asks the person",
    for: CODEX,
    steps: [
      streams("A", "Two exports exist."),
      turnEnds(),
      message("A", "Two exports exist.", { asks: "Which one should I fix?" }),
    ],
    outcome: "needs_input",
    text: "Two exports exist.\nWhich one should I fix? (CSV, PDF)",
    final: false,
  },
  {
    name: "background work holds the run: words of the answer that stream after the turn's end are kept",
    for: CODEX,
    steps: [
      commandStarts,
      streams("A", "The export "),
      turnEnds(),
      streams("A", "drops"),
      commandEnds,
      timePasses,
    ],
    outcome: "success",
    text: "The export drops",
    final: false,
  },
  {
    name: "background work holds the run, and a turn of the agent's own says nothing: the earlier answer is the last message",
    for: CODEX,
    steps: [
      commandStarts,
      message("A", ANSWER),
      turnEnds("A", ANSWER),
      turnStarts,
      turnEnds(),
      commandEnds,
    ],
    outcome: "success",
    text: ANSWER,
    final: false,
  },
  {
    name: "a late message of an earlier turn changes nothing of the present one",
    for: CODEX,
    steps: [
      commandStarts,
      streams("A", "Looking"),
      turnEnds(),
      turnStarts,
      message("B", ANSWER),
      message("A", "Old words.", { turn: 1 }),
      turnEnds(),
      commandEnds,
    ],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "a question of an earlier turn gives way to the answer of the present one",
    for: CODEX,
    steps: [
      commandStarts,
      message("A", "Two exports exist.", { asks: "Which one should I fix?" }),
      turnEnds(),
      turnStarts,
      message("B", ANSWER),
      turnEnds("B", ANSWER),
      commandEnds,
    ],
    outcome: "success",
    text: ANSWER,
    final: true,
  },
  {
    name: "a message without a phase streams, then completes as commentary: it is no answer",
    for: CODEX,
    steps: [
      streams("A", "Looking.", null),
      message("A", "Looking.", { phase: "commentary" }),
      turnEnds(),
    ],
    outcome: "success",
    text: null,
    final: false,
  },
];

describe("[A4.3.11.drivers.answer-orders] every driver keeps what the agent said by the time its work settles, in every order of its messages", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  for (const [name, speaker] of Object.entries(SPEAKERS)) {
    describe(name, () => {
      for (const order of ORDERS) {
        test.skipIf(!order.for.includes(name))(order.name, async () => {
          const agent = await speaker();
          for (const step of order.steps) await agent.say(step);
          const work = await agent.driver.settled;
          expect(work).toMatchObject({
            ok: order.outcome === "success",
            outcome: order.outcome,
            text: order.text,
            textFinal: order.final,
            textCut: false,
          });
          agent.driver.close();
        });
      }
    });
  }
});
