// One table of the orders in which an agent's words can reach its driver, run against every
// driver: whatever the agent said by the time its work settles is the work's text, and work that
// succeeded never has an empty answer when one was given. Each driver's agent says each step in
// its own protocol, or says nothing where that protocol has no words for it.
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, test } from "vitest";
import type { OutcomeReason, RunEvent } from "@ttasks/contracts/runs";
import { claudeDriver } from "../src/drivers/claude.ts";
import { codexDriver } from "../src/drivers/codex.ts";
import { printDriver } from "../src/drivers/print.ts";
import type { DriverSession, OpenDriver, Work } from "../src/drivers/types.ts";

type Step =
  /** Part of an answer, before its message is whole. */
  | { readonly kind: "streams"; readonly text: string }
  /** The answer's message, whole. */
  | { readonly kind: "message"; readonly text: string }
  /** The turn ends, with the answer in its summary or without one. */
  | { readonly kind: "turn ends"; readonly summary: string | null }
  | { readonly kind: "output ends" }
  | { readonly kind: "stop" };

/** One agent program's protocol, as a fake of it says each step. */
interface Agent {
  readonly driver: DriverSession;
  /** Whether the protocol says `step`: false when it has no words for it. */
  readonly says: (step: Step) => boolean;
  readonly say: (step: Step) => Promise<void>;
}

type Speaker = () => Promise<Agent>;

/** Lets whatever was written be read. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

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
const TURN = "00000000-0000-4000-8000-000000000003";
const SESSION = "00000000-0000-4000-8000-0000000000a1";

/** Codex's app server: a final-answer item that streams, completes, and a turn with its summary. */
const codex: Speaker = async () => {
  const { toAgent, fromAgent, write } = pipes();
  const events: RunEvent[] = [];
  let started: () => void = () => undefined;
  const turnStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let item = 0;
  let open = false;
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
        write({ id: message.id, result: { turn: { id: TURN } } });
        write({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
        started();
        return;
      case "turn/interrupt":
        write({ id: message.id, result: {} });
        write({
          method: "turn/completed",
          params: {
            threadId: THREAD,
            turn: { id: TURN, items: [], itemsView: "notLoaded", status: "interrupted" },
          },
        });
        return;
      default:
        write({ id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  });
  const driver = codexDriver({ request: "Look into the export.", permission: "full-access" })(
    { stdin: toAgent, stdout: fromAgent },
    (event) => events.push(event),
  );
  await turnStarted;
  const answerItem = (text: string) => ({
    type: "agentMessage",
    id: `answer-${String(item)}`,
    text,
    phase: "final_answer",
    delivery: null,
    questions: null,
  });
  const of = { threadId: THREAD, turnId: TURN };
  return {
    driver,
    says: () => true,
    say: async (step) => {
      switch (step.kind) {
        case "streams":
          if (!open) {
            item += 1;
            open = true;
            write({ method: "item/started", params: { ...of, item: answerItem("") } });
          }
          write({
            method: "item/agentMessage/delta",
            params: { ...of, itemId: `answer-${String(item)}`, delta: step.text },
          });
          break;
        case "message":
          if (!open) item += 1;
          open = false;
          write({ method: "item/completed", params: { ...of, item: answerItem(step.text) } });
          break;
        case "turn ends":
          write({
            method: "turn/completed",
            params: {
              threadId: THREAD,
              turn: {
                id: TURN,
                items: step.summary === null ? [] : [answerItem(step.summary)],
                itemsView: step.summary === null ? "notLoaded" : "summary",
                status: "completed",
                error: null,
              },
            },
          });
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
  (open: OpenDriver, stops: boolean): Speaker =>
  () => {
    const { toAgent, fromAgent, write } = pipes();
    toAgent.resume();
    const driver = open({ stdin: toAgent, stdout: fromAgent }, () => undefined);
    write({ type: "system", subtype: "init", session_id: SESSION, mcp_servers: [] });
    const says = (step: Step): boolean =>
      step.kind !== "streams" && (step.kind !== "stop" || stops);
    return Promise.resolve({
      driver,
      says,
      say: async (step) => {
        switch (step.kind) {
          case "streams":
            break;
          case "message":
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
              result: step.summary ?? "",
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
            if (!stops) break;
            driver.interrupt();
            write({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              session_id: SESSION,
              terminal_reason: "aborted_streaming",
            });
            break;
        }
        await settle();
      },
    });
  };

/** Each driver, and whether its protocol can stop the agent: else the host interrupts its process. */
const SPEAKERS: Readonly<Record<string, { readonly speaker: Speaker; readonly stops: boolean }>> = {
  codex: { speaker: codex, stops: true },
  claude: {
    speaker: claudeLike(claudeDriver({ request: "Look into the export." }), true),
    stops: true,
  },
  "claude-print": { speaker: claudeLike(printDriver("claude-print"), false), stops: false },
};

const ANSWER = "The export drops the last row.";
const streams = (text: string): Step => ({ kind: "streams", text });
const message: Step = { kind: "message", text: ANSWER };
const turnEnds = (summary: string | null): Step => ({ kind: "turn ends", summary });
const outputEnds: Step = { kind: "output ends" };
const stop: Step = { kind: "stop" };

/** Each order, and how the work settles: its text is what the agent said by then. */
const ORDERS: readonly {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly outcome: OutcomeReason;
}[] = [
  {
    name: "the answer streams, then the output ends",
    steps: [streams("The export "), streams("drops"), outputEnds],
    outcome: "no_result",
  },
  {
    name: "the answer is whole, then the output ends",
    steps: [streams("The export "), message, outputEnds],
    outcome: "no_result",
  },
  {
    name: "the answer, then the turn's end with it",
    steps: [streams("The export "), message, turnEnds(ANSWER)],
    outcome: "success",
  },
  {
    name: "the turn's end with the answer comes before the answer's own message",
    steps: [streams("The export "), turnEnds(ANSWER), message],
    outcome: "success",
  },
  {
    name: "the turn's end without a summary comes while the answer streams",
    steps: [streams("The export "), streams("drops"), turnEnds(null)],
    outcome: "success",
  },
  {
    name: "Stop while the answer streams",
    steps: [streams("The export "), streams("drops"), stop],
    outcome: "interrupted",
  },
  {
    name: "a whole answer, then a later one streams, then the output ends",
    steps: [message, streams("Also "), streams("the header"), outputEnds],
    outcome: "no_result",
  },
];

/** What the agent said by the time the work settled, as far as its protocol carried it. */
function said(agent: Agent, steps: readonly Step[], work: Work): Partial<Work> {
  let text: string | null = null;
  let whole = false;
  let streaming = false;
  for (const step of steps) {
    if (!agent.says(step)) continue;
    if (step.kind === "streams") {
      text = streaming ? `${text ?? ""}${step.text}` : step.text;
      streaming = true;
      whole = false;
    } else if (step.kind === "message") {
      text = step.text;
      streaming = false;
      whole = true;
    } else if (step.kind === "turn ends" && step.summary !== null) {
      text = step.summary;
      whole = true;
    }
    // Nothing after the step the work settled at counts.
    if (step.kind !== "streams" && step.kind !== "message") break;
  }
  return {
    ok: work.outcome === "success",
    text,
    textFinal: work.outcome === "success" && whole,
    textCut: false,
  };
}

describe("[A4.3.11.drivers.answer-orders] every driver keeps what the agent said by the time its work settles, in every order of its messages", () => {
  for (const [name, { speaker, stops }] of Object.entries(SPEAKERS)) {
    describe(name, () => {
      for (const order of ORDERS) {
        if (!stops && order.steps.includes(stop)) continue;
        test(order.name, async () => {
          const agent = await speaker();
          for (const step of order.steps) await agent.say(step);
          const work = await agent.driver.settled;
          expect(work.outcome).toBe(order.outcome);
          expect(work).toMatchObject(said(agent, order.steps, work));
          agent.driver.close();
        });
      }
    });
  }
});
