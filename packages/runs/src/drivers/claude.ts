// The `claude` driver: Claude Code's print mode with JSON lines both ways
// (`claude -p --input-format stream-json --output-format stream-json`), as a real Claude Code
// spoke it in fixtures/claude-stream. The flags, event names and fields are Claude Code's own; T3
// Code's Claude adapter showed which ones an unattended client needs and how its modes map.
//
// - The request is the first line on the program's input, never on its command line. The input
//   stays open while the agent works, so a Stop can go over it.
// - The program exits when its input ends. The input ends after a turn once no command the agent
//   started in the background still runs: when one ends, Claude Code starts a turn of its own to
//   report on it, and its answer is the run's. The work settles with that last successful result,
//   or else when the program exits; a program that does not exit after its work is the cleanup's.
// - The answer and the verdict are the last result event's own (streams/claude-print.ts).
// - Nobody is there to answer: a permission prompt reaches this driver (`--permission-prompt-tool
//   stdio`) and is declined, and the program counts it in the result. A question for the person
//   (`AskUserQuestion`, which needs their own words) is never answered for them: it is declined,
//   the turn is interrupted, and the work ends as needing the person with the question as its text.
//   Any other request gets the protocol's error. Answering a prompt with a permission of its own
//   would make Claude Code write it into the person's settings: this driver never does.
// - Stop asks over the input to interrupt the turn and waits for nothing; between turns, the
//   input also ends, which ends what the agent left running in the background.
import {
  ANSWER_CAP_BYTES,
  LINE_CAP_BYTES,
  TEXT_CAP_BYTES,
  type ProcessExit,
  type RunEvent,
  type RunPermission,
} from "@tasks/contracts/runs";
import { MCP_SERVER_KEY, PRODUCT_ID } from "@tasks/brand";
import { createClaudePrintParser } from "../streams/claude-print.ts";
import { LineSplitter } from "../streams/lines.ts";
import { array, capText, record, string, type Json } from "../streams/values.ts";
import { workOf } from "./print.ts";
import type { OpenDriver, Work } from "./types.ts";

/** Tasks' own MCP server for the run: the bridge, with the run's ticket in its environment. */
export interface ClaudeTools {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ClaudeSession {
  /** The person's request, sent as the first line of the program's input. */
  readonly request: string;
}

/**
 * How each permission runs Claude Code, in its own modes. Tasks' own tools are allowed in every
 * mode: they are how the run reports its work.
 */
const MODES: Readonly<Record<RunPermission, readonly string[]>> = {
  "full-access": ["--permission-mode", "bypassPermissions"],
  "auto-edit": ["--permission-mode", "acceptEdits", "--allowedTools", `mcp__${MCP_SERVER_KEY}`],
  "read-only": [
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read,Glob,Grep",
    "--allowedTools",
    `mcp__${MCP_SERVER_KEY}`,
  ],
};

/** The arguments after the program: print mode, the permission, and the tools file when given. */
export function claudeArgs(permission: RunPermission, toolsFile?: string): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    ...MODES[permission],
    ...(toolsFile === undefined ? [] : ["--mcp-config", toolsFile]),
  ];
}

/**
 * The tools file's text: Tasks' tools under their own name. A server of that name in the person's
 * own configuration gives way to it for the run; their other servers stay.
 */
export function claudeToolsFile(tools: ClaudeTools): string {
  return `${JSON.stringify({
    mcpServers: {
      [MCP_SERVER_KEY]: {
        type: "stdio",
        command: tools.command,
        args: [...tools.args],
        env: { ...tools.env },
      },
    },
  })}\n`;
}

/** What the program hears when a prompt is declined: no one is there to approve it. */
const DECLINED = "This is a background run: no one is there to approve this, so it is declined.";
/** What it hears when its question is declined: the person will read it in the run's record. */
const UNANSWERED =
  "This is a background run: no one is there to answer now. The run ends with your question.";

/** Words of an error that say the program is not signed in. */
const SIGNED_OUT = /\b(?:401|unauthori[sz]ed|not logged in|log ?in|sign ?in|authenticat)/iu;

/** A question for the person as text: each question with its choices. */
function questionText(input: Json | undefined): string {
  const lines: string[] = [];
  for (const q of array(input?.["questions"]) ?? []) {
    const question = record(q);
    if (question === undefined) continue;
    const text = string(question["question"]) ?? string(question["header"]) ?? "";
    const options = (array(question["options"]) ?? [])
      .map((o) => string(o) ?? string(record(o)?.["label"]))
      .filter((label): label is string => label !== undefined && label !== "");
    lines.push(options.length > 0 ? `${text} (${options.join(", ")})` : text);
  }
  return lines.join("\n").trim();
}

export function claudeDriver(session: ClaudeSession): OpenDriver {
  return ({ stdin, stdout }, report) => {
    const parser = createClaudePrintParser();
    const lines = new LineSplitter(LINE_CAP_BYTES);
    let inputEnded = false;
    /** A turn goes on: from the request, or a turn the program starts by itself, to its result. */
    let turn = true;
    /** Commands the agent left running in the background, as the program last listed them. */
    let background = 0;
    let stopping = false;
    let signedOut = false;
    let question: { text: string; cut: boolean } | null = null;
    let done = false;
    let next = 0;
    let settle: (work: Work) => void = () => undefined;
    const settled = new Promise<Work>((resolve) => {
      settle = resolve;
    });

    stdin.on("error", () => undefined);
    const write = (message: Json): void => {
      if (inputEnded) return;
      try {
        stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // The program is gone: its end says how the work went.
      }
    };
    const endInput = (): void => {
      if (inputEnded) return;
      inputEnded = true;
      stdin.end();
    };
    const interruptTurn = (): void => {
      next += 1;
      write({
        type: "control_request",
        request_id: `${PRODUCT_ID}-${String(next)}`,
        request: { subtype: "interrupt" },
      });
    };
    const answer = (id: unknown, response: Json): void => {
      write({
        type: "control_response",
        response: { subtype: "success", request_id: id, response },
      });
    };

    /** What the parser says, as the run's events: once the agent asked, its question stays. */
    const relay = (event: RunEvent): void => {
      if (event.kind === "answer" && question !== null) return;
      report(event);
    };

    const control = (message: Json): void => {
      const id = message["request_id"];
      if (typeof id !== "string" && typeof id !== "number") return;
      const request = record(message["request"]) ?? {};
      if (request["subtype"] !== "can_use_tool") {
        write({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: id,
            error: `Not supported: ${string(request["subtype"]) ?? "unknown"}`,
          },
        });
        return;
      }
      if (request["requires_user_interaction"] !== true) {
        answer(id, { behavior: "deny", message: DECLINED });
        return;
      }
      if (question === null && !stopping) {
        const asked = questionText(record(request["input"]));
        const capped = capText(
          asked === "" ? "Claude Code asked a question." : asked,
          ANSWER_CAP_BYTES,
        );
        question = { text: capped.text, cut: capped.capped };
        report({ kind: "answer", text: question.text, final: false, cut: question.cut });
      }
      answer(id, { behavior: "deny", message: UNANSWERED, interrupt: true });
      interruptTurn();
    };

    /** The work, from what the program said and how it ended. */
    const conclude = (exit: ProcessExit): void => {
      if (done) return;
      const end = parser.end(exit);
      for (const event of end.events) relay(event);
      done = true;
      let work = workOf(end.outcome);
      if (question !== null) {
        work = {
          ...work,
          ok: false,
          outcome: "needs_input",
          text: question.text,
          textCut: question.cut,
          textFinal: false,
          error: null,
        };
      } else if (stopping && work.outcome !== "interrupted") {
        work = { ...work, ok: false, outcome: "interrupted" };
      }
      if (!work.ok && work.error !== null && (signedOut || SIGNED_OUT.test(work.error))) {
        const said = `${work.error.trim()} Sign in with: claude auth login`;
        work = { ...work, error: capText(said, TEXT_CAP_BYTES).text };
      }
      settle(work);
    };

    const read = (text: string): void => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      const message = record(value);
      if (message === undefined) return;
      switch (message["type"]) {
        case "system":
          if (message["subtype"] === "init") turn = true;
          else if (message["subtype"] === "background_tasks_changed") {
            background = array(message["tasks"])?.length ?? 0;
          }
          return;
        case "assistant":
          if (message["error"] === "authentication_failed") signedOut = true;
          return;
        case "result":
          turn = false;
          // The program ends once its input does. Background work it still waits for keeps the
          // input open: its own turn about that work follows, and Stop can still reach it.
          if (stopping || question !== null || background === 0) {
            endInput();
            // Done and said so: a program that then does not exit is the cleanup's to end.
            if (!stopping && question === null && message["is_error"] === false) {
              conclude({ code: 0, signal: null });
            }
          }
          return;
        case "control_request":
          control(message);
          return;
        default:
          return;
      }
    };

    stdout.on("data", (chunk: Buffer) => {
      if (done) return;
      for (const event of parser.push(chunk)) relay(event);
      for (const line of lines.push(chunk)) if (line.kind === "line") read(line.line.text);
    });

    write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: session.request }] },
    });

    return {
      settled,
      interrupt: () => {
        if (done) return true;
        // Nothing to say it over: the host interrupts the program itself.
        if (inputEnded) return false;
        stopping = true;
        interruptTurn();
        if (!turn) endInput();
        return true;
      },
      close: endInput,
      ended: conclude,
    };
  };
}
