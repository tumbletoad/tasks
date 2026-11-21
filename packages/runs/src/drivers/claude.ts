// The `claude` driver: Claude Code's print mode with JSON lines both ways
// (`claude -p --input-format stream-json --output-format stream-json`), as a real Claude Code
// spoke it in fixtures/claude-stream. The flags, event names and fields are Claude Code's own; T3
// Code's Claude adapter showed which ones an unattended client needs and how its modes map.
//
// One state, `phase`, alone decides what may still go to the program's input and when the work is
// settled, with which result:
//
//   turn ──result, nothing pending──▶ settled with the result
//   turn ──result, background work or a queued turn──▶ between ──a turn starts──▶ turn
//   turn | between ──a question or a prompt for the person──▶ settled as needing the person
//   turn ──Stop──▶ stopping ──result or exit──▶ settled as interrupted
//   between ──Stop──▶ settled as interrupted with the last turn's answer; the input ends
//
// - The request is the first line on the program's input, never on its command line. The input
//   stays open while the agent works: a Stop goes over it, and background work reports over it.
// - Background work holds the run: a helper agent, a workflow, or a command the agent left
//   running. When it ends, Claude Code starts a turn of its own to report on it, and that turn's
//   answer is the run's. A command that never ends, a server, holds the run until the person
//   stops it; the run then keeps the last turn's answer.
// - Nobody is there to answer: a prompt for the person, a question (`AskUserQuestion`) or a
//   permission the person's own Claude Code setup asks for, is never answered for them. It is
//   turned down so the turn stops, and the work ends as needing the person, with what was asked as
//   its text. Answering a prompt with a permission would make Claude Code write it into the
//   person's settings: this driver never does. Any other request gets the protocol's error.
// - From a Stop on, nothing but the interrupt and answers that turn a prompt down reaches the
//   input.
import {
  ANSWER_CAP_BYTES,
  LINE_CAP_BYTES,
  TEXT_CAP_BYTES,
  type ProcessExit,
  type RunPermission,
} from "@tasks/contracts/runs";
import { MCP_SERVER_KEY, PRODUCT_ID } from "@tasks/brand";
import { createClaudePrintParser, startsTurn } from "../streams/claude-print.ts";
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
 * How each permission runs Claude Code, in its own modes, with the person's own tools and rules.
 * Tasks' own tools are allowed in every mode: they are how the run reports its work.
 */
const MODES: Readonly<Record<RunPermission, readonly string[]>> = {
  "full-access": ["--permission-mode", "bypassPermissions"],
  "auto-edit": ["--permission-mode", "acceptEdits", "--allowedTools", `mcp__${MCP_SERVER_KEY}`],
  // Not `dontAsk`: it refuses a question before this driver hears it, and the run would end as if
  // done. In `default`, whatever the person's setup does not allow reaches the driver as a prompt.
  "read-only": ["--permission-mode", "default", "--allowedTools", `mcp__${MCP_SERVER_KEY}`],
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

/** What the program hears when its prompt is turned down: the person will read it in the run. */
const FOR_THE_PERSON =
  "This is a background run: no one is there to answer now. The run ends here and the person reads what you asked.";
/** What it hears for a prompt after a Stop. */
const STOPPED = "The person stopped this run.";

/** Words of a prompt for the person: each question with its choices. */
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

/** Words of a permission prompt: the tool, and what it would do as Claude Code describes it. */
function permissionText(request: Json): string {
  const tool = string(request["display_name"]) ?? string(request["tool_name"]) ?? "a tool";
  const input = record(request["input"]);
  const what =
    string(request["description"]) ??
    string(input?.["description"]) ??
    string(input?.["command"]) ??
    string(input?.["file_path"]) ??
    string(input?.["plan"]) ??
    "";
  return `Claude Code asks to use ${tool}${what === "" ? "." : `: ${what}`}`;
}

/** Where a run is: the one fact every decision of the driver reads. */
type Phase =
  /** A turn goes on: from the request, or a turn the program starts by itself, to its result. */
  | "turn"
  /** The last turn ended with a result, and background work or a queued turn brings another. */
  | "between"
  /** The person stopped the run during a turn: the turn's end is awaited. */
  | "stopping"
  /** The work is settled. */
  | "settled";

export function claudeDriver(session: ClaudeSession): OpenDriver {
  return ({ stdin, stdout }, report) => {
    const parser = createClaudePrintParser();
    const lines = new LineSplitter(LINE_CAP_BYTES);
    let phase: Phase = "turn";
    let inputEnded = false;
    /** Background work the program last listed: each brings a turn of its own when it ends. */
    let background = 0;
    let signedOut = false;
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
    const turnDown = (id: unknown, message: string, interrupt: boolean): void => {
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: id,
          response: { behavior: "deny", message, ...(interrupt ? { interrupt: true } : {}) },
        },
      });
    };

    /** The work, from what the program said: how it ended, or `as` when the run decided it. */
    const conclude = (exit: ProcessExit, as?: { asked: string } | "interrupted"): void => {
      if (phase === "settled") return;
      const stopped = phase === "stopping" || as === "interrupted";
      // The program ended while background work it was to report on still went on.
      const unfinished = phase === "between" && as === undefined;
      phase = "settled";
      const end = parser.end(exit);
      for (const event of end.events) report(event);
      let work = workOf(end.outcome);
      if (typeof as === "object") {
        const capped = capText(as.asked, ANSWER_CAP_BYTES);
        report({ kind: "answer", text: capped.text, final: false, cut: capped.capped });
        work = {
          ...work,
          ok: false,
          outcome: "needs_input",
          text: capped.text,
          textCut: capped.capped,
          textFinal: false,
          error: null,
        };
      } else if (stopped && work.outcome !== "interrupted") {
        work = { ...work, ok: false, outcome: "interrupted" };
      } else if (unfinished && work.ok) {
        work = { ...work, ok: false, outcome: "no_result" };
      }
      if (!work.ok && signedOut) {
        const said = `${(work.error ?? "Claude Code is not signed in.").trim()} Sign in with: claude auth login`;
        work = { ...work, error: capText(said, TEXT_CAP_BYTES).text };
      }
      settle(work);
    };

    /** A prompt for the person: turned down so the turn stops, and the work needs the person. */
    const askPerson = (id: unknown, asked: string): void => {
      turnDown(id, FOR_THE_PERSON, true);
      interruptTurn();
      conclude({ code: null, signal: null }, { asked });
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
      if (phase === "stopping" || phase === "settled") {
        turnDown(id, STOPPED, false);
        return;
      }
      if (request["requires_user_interaction"] === true) {
        const asked = questionText(record(request["input"]));
        askPerson(id, asked === "" ? "Claude Code asked a question." : asked);
      } else {
        askPerson(id, permissionText(request));
      }
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
      if (phase === "between" && startsTurn(message)) phase = "turn";
      switch (message["type"]) {
        case "system":
          if (message["subtype"] === "background_tasks_changed") {
            background = (array(message["tasks"]) ?? []).length;
          }
          return;
        case "assistant":
          if (message["error"] === "authentication_failed") signedOut = true;
          return;
        case "result": {
          if (phase === "stopping") {
            conclude({ code: 0, signal: null });
            return;
          }
          const queued = message["queued_turn_count"];
          const more = background > 0 || (typeof queued === "number" && queued > 0);
          // The result says how the turn ended, so the exit is not waited for.
          if (more) phase = "between";
          else conclude({ code: 0, signal: null });
          return;
        }
        case "control_request":
          control(message);
          return;
        default:
          return;
      }
    };

    // One line at a time through both the parser and the driver, so the work settles at the same
    // line however the output was cut into chunks, and nothing after that line counts.
    stdout.on("data", (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length && phase !== "settled") {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline + 1;
        const piece = chunk.subarray(start, end);
        start = end;
        for (const event of parser.push(piece)) report(event);
        for (const line of lines.push(piece)) if (line.kind === "line") read(line.line.text);
      }
    });

    write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: session.request }] },
    });

    return {
      settled,
      interrupt: () => {
        switch (phase) {
          case "settled":
          case "stopping":
            return true;
          case "between":
            // No turn goes on: the end of the input ends what was left running.
            interruptTurn();
            endInput();
            conclude({ code: 0, signal: null }, "interrupted");
            return true;
          case "turn":
            // Nothing to say it over: the host interrupts the program itself.
            if (inputEnded) return false;
            phase = "stopping";
            interruptTurn();
            return true;
        }
      },
      close: endInput,
      ended: conclude,
    };
  };
}
