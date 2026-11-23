// The `claude` driver: Claude Code's print mode with JSON lines both ways
// (`claude -p --input-format stream-json --output-format stream-json`), as a real Claude Code
// spoke it in fixtures/claude-stream. The flags, event names and fields are Claude Code's own; T3
// Code's Claude adapter showed which ones an unattended client needs and how its modes map.
//
// Every decision is one cell of STEPS: where the run is (`Phase`) against what the driver hears
// (`Heard`), each line of the program, its end, or the person's Stop. A cell says what goes to the
// program's input and where the run goes on, or how the work settles.
//
// - The request is the first line on the program's input, never on its command line. The input
//   stays open while the agent works: a Stop goes over it, and background work reports over it.
// - Background work holds the run: a helper agent, a workflow, or a command the agent left
//   running. When it ends, Claude Code starts a turn of its own to report on it, and that turn's
//   answer is the run's. A command that never ends, a server, holds the run until the person
//   stops it; the run then keeps the last turn's answer. A turn that fails ends the run at once.
// - Nobody is there to answer: a question (`AskUserQuestion`), a permission the person's own
//   Claude Code setup asks for, or a question of an MCP tool, is never answered for them. It is
//   turned down so the turn stops, and the work ends as needing the person, with what was asked
//   as its text. Answering a prompt with a permission would make Claude Code write it into the
//   person's settings: this driver never does.
// - Each line is read once (streams/json-lines.ts), and the stream parser, which keeps the answer,
//   reads what the driver acts on. A line that cannot be read ends the work at once as failed.
import {
  ANSWER_CAP_BYTES,
  TEXT_CAP_BYTES,
  type ProcessExit,
  type RunPermission,
} from "@ttasks/contracts/runs";
import { MCP_SERVER_KEY, PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";
import { createClaudePrintParser, startsTurn } from "../streams/claude-print.ts";
import { JsonLines, type JsonLine } from "../streams/json-lines.ts";
import { array, capText, record, string, type Json } from "../streams/values.ts";
import { workOf } from "./print.ts";
import type { OpenDriver, Work } from "./types.ts";

/** TTasks's own MCP server for the run: the bridge, with the run's ticket in its environment. */
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
 * TTasks's own tools are allowed in every mode: they are how the run reports its work, and a
 * read-only run reads its own task through them.
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
 * The tools file's text: TTasks's tools under their own name. A server of that name in the person's
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
/** Why the run ended when a line could not be read. */
const UNREADABLE = `Claude Code sent a message too long for ${PRODUCT_NAME} to read, so it could not tell what the work did.`;

/** A value of a prompt longer than this is cut: the person needs to recognise it, not read it all. */
const VALUE_SHOWN = 1_000;

const shown = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > VALUE_SHOWN ? `${text.slice(0, VALUE_SHOWN)}…` : text;
};

/** Words of a question for the person: each question with its choices. */
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

/**
 * Words of a permission prompt: the tool, what it would do as Claude Code describes it, and what
 * it would act on (the command, the file, the address, the query, an MCP tool's arguments), so
 * the person can tell what to allow.
 */
function permissionText(request: Json): string {
  const tool = string(request["display_name"]) ?? string(request["tool_name"]) ?? "a tool";
  const input = record(request["input"]) ?? {};
  const description = string(request["description"]) ?? string(input["description"]) ?? "";
  const asks = `Claude Code asks to use ${tool}${description === "" ? "." : `: ${description}`}`;
  const details = Object.entries(input)
    .filter(([key, value]) => key !== "description" && value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${shown(value)}`)
    .join("\n");
  if (details === "") return asks;
  // As code, so a command's characters show as they are where the text is read as Markdown; the
  // fence is one no line of it closes.
  const fence = /^\s*~~~/mu.test(details) ? "```" : "~~~";
  return `${asks}\n${fence}\n${details}\n${fence}`;
}

/** Words of an MCP tool's question (`elicitation`): who asks, what, and the choices of each field. */
function elicitationText(request: Json): string {
  const server = string(request["mcp_server_name"]);
  const message = string(request["message"]) ?? "";
  const lines = [server === undefined ? message : `${server} asks: ${message}`];
  const url = string(request["url"]);
  if (url !== undefined) lines.push(url);
  const fields = record(record(request["requested_schema"])?.["properties"]) ?? {};
  for (const [key, value] of Object.entries(fields)) {
    const field = record(value);
    if (field === undefined) continue;
    const name = string(field["title"]) ?? string(field["description"]) ?? key;
    // A field of several choices holds them in its `items`.
    const options = record(field["items"]) ?? field;
    const choices = (
      array(options["enumNames"]) ??
      array(options["enum"]) ??
      (array(options["oneOf"]) ?? array(options["anyOf"]) ?? []).map(
        (o) => record(o)?.["title"] ?? record(o)?.["const"],
      )
    )
      .map((choice) => (typeof choice === "string" ? choice : undefined))
      .filter((choice): choice is string => choice !== undefined && choice !== "");
    lines.push(choices.length > 0 ? `${name} (${choices.join(", ")})` : name);
  }
  return lines.join("\n").trim();
}

/** Where a run is: the one fact every decision of the driver reads. */
export const PHASES = [
  /** A turn goes on: from the request, or a turn the program starts by itself, to its result. */
  "turn",
  /** The last turn ended with a result, and background work or a queued turn brings another. */
  "between",
  /** The person stopped the run during a turn: the turn's end is awaited. */
  "stopping",
  /** The work is settled. */
  "settled",
] as const;
export type Phase = (typeof PHASES)[number];

/** What the driver hears: each line of the program is one of these, and so are its end and Stop. */
export const HEARD = [
  /** A line of a turn of the run's own agent: its start, or one of its messages. */
  "turn",
  /** Any other line: a helper agent's, the list of background work, what nothing decides on. */
  "other",
  /** A turn's result, with nothing more to come. */
  "result",
  /** A turn's result while background work or a queued turn brings another. */
  "result, more",
  /** A turn's result that says it failed. */
  "failed",
  /** A request for the person: a question, a permission prompt, an MCP tool's question. */
  "asks",
  /** A request the driver does not know. */
  "unknown request",
  /** A line that could not be read: it may have been anything. */
  "unreadable",
  /** The program's output ended. */
  "exit",
  /** The person's Stop. */
  "stop",
] as const;
export type Heard = (typeof HEARD)[number];

/** How the work settles: as the program's last result judged it, or as the run decided. */
type Settle = "judged" | "interrupted" | "unfinished" | "needs the person" | "unreadable";

interface Step {
  /** The phase the run goes on in, or how the work settles. */
  readonly then: Phase | Settle;
  /** What goes to the program's input first. */
  readonly say?: "turn down" | "turn down, stopped" | "error" | "interrupt" | "end";
}

const STEPS: Readonly<Record<Phase, Readonly<Record<Heard, Step>>>> = {
  turn: {
    turn: { then: "turn" },
    other: { then: "turn" },
    result: { then: "judged" },
    "result, more": { then: "between" },
    failed: { then: "judged" },
    asks: { then: "needs the person", say: "turn down" },
    "unknown request": { then: "turn", say: "error" },
    unreadable: { then: "unreadable", say: "interrupt" },
    exit: { then: "judged" },
    stop: { then: "stopping", say: "interrupt" },
  },
  between: {
    turn: { then: "turn" },
    other: { then: "between" },
    // A turn of the program's own whose first line was its result.
    result: { then: "judged" },
    "result, more": { then: "between" },
    failed: { then: "judged" },
    asks: { then: "needs the person", say: "turn down" },
    "unknown request": { then: "between", say: "error" },
    unreadable: { then: "unreadable", say: "end" },
    // The background work it was to report on never was.
    exit: { then: "unfinished" },
    // No turn goes on: the end of the input ends what was left running.
    stop: { then: "interrupted", say: "end" },
  },
  stopping: {
    turn: { then: "stopping" },
    other: { then: "stopping" },
    result: { then: "interrupted" },
    "result, more": { then: "interrupted" },
    failed: { then: "interrupted" },
    asks: { then: "stopping", say: "turn down, stopped" },
    "unknown request": { then: "stopping", say: "error" },
    unreadable: { then: "interrupted" },
    exit: { then: "interrupted" },
    stop: { then: "stopping" },
  },
  settled: {
    turn: { then: "settled" },
    other: { then: "settled" },
    result: { then: "settled" },
    "result, more": { then: "settled" },
    failed: { then: "settled" },
    asks: { then: "settled" },
    "unknown request": { then: "settled" },
    unreadable: { then: "settled" },
    exit: { then: "settled" },
    stop: { then: "settled" },
  },
};

const isPhase = (then: Phase | Settle): then is Phase =>
  (PHASES as readonly string[]).includes(then);

/** A request of the program, as the driver answers it. */
interface Request {
  readonly id: string | number;
  /** For a request for the person: what it asks, and the answer that turns it down. */
  readonly asked?: string;
  readonly turnDown?: (message: string) => Json;
}

export function claudeDriver(session: ClaudeSession): OpenDriver {
  return ({ stdin, stdout }, report) => {
    const parser = createClaudePrintParser();
    const lines = new JsonLines();
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
    const answer = (id: string | number, response: Json): void => {
      write({
        type: "control_response",
        response: { subtype: "success", request_id: id, response },
      });
    };

    /** The work, from what the program said and how the run decided it settles. */
    const conclude = (how: Settle, exit: ProcessExit, asked: string | undefined): void => {
      phase = "settled";
      const end = parser.end(exit);
      for (const event of end.events) report(event);
      let work = workOf(end.outcome);
      switch (how) {
        case "needs the person": {
          const capped = capText(asked ?? "Claude Code asked a question.", ANSWER_CAP_BYTES);
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
          break;
        }
        case "interrupted":
          if (work.outcome !== "interrupted") work = { ...work, ok: false, outcome: "interrupted" };
          break;
        case "unfinished":
          work = { ...work, ok: false, outcome: "no_result", textFinal: false };
          break;
        case "unreadable":
          work = {
            ...work,
            ok: false,
            outcome: "agent_error",
            textFinal: false,
            error: UNREADABLE,
          };
          break;
        case "judged":
          break;
      }
      if (!work.ok && signedOut) {
        const said = `${(work.error ?? "Claude Code is not signed in.").trim()} Sign in with: claude auth login`;
        work = { ...work, error: capText(said, TEXT_CAP_BYTES).text };
      }
      settle(work);
    };

    /** One cell of STEPS. A result settles at once: it says how the turn ended. */
    const hear = (
      heard: Heard,
      request?: Request,
      exit: ProcessExit = { code: 0, signal: null },
    ) => {
      const step = STEPS[phase][heard];
      switch (step.say) {
        case "turn down":
          if (request?.turnDown !== undefined) answer(request.id, request.turnDown(FOR_THE_PERSON));
          interruptTurn();
          break;
        case "turn down, stopped":
          if (request?.turnDown !== undefined) answer(request.id, request.turnDown(STOPPED));
          break;
        case "error":
          if (request !== undefined) {
            write({
              type: "control_response",
              response: { subtype: "error", request_id: request.id, error: "Not supported" },
            });
          }
          break;
        case "interrupt":
          interruptTurn();
          break;
        case "end":
          interruptTurn();
          endInput();
          break;
        case undefined:
          break;
      }
      if (isPhase(step.then)) phase = step.then;
      else conclude(step.then, exit, request?.asked);
    };

    /** A control request: what it is, and how it is turned down. */
    const requestOf = (message: Json): { heard: Heard; request?: Request } => {
      const id = message["request_id"];
      if (typeof id !== "string" && typeof id !== "number") return { heard: "other" };
      const request = record(message["request"]) ?? {};
      switch (request["subtype"]) {
        case "can_use_tool": {
          const question = request["requires_user_interaction"] === true;
          const asked = question ? questionText(record(request["input"])) : permissionText(request);
          return {
            heard: "asks",
            request: {
              id,
              asked: asked === "" ? "Claude Code asked a question." : asked,
              // A decline that stops the turn, and no permission: nothing is written to settings.
              turnDown: (said) => ({ behavior: "deny", message: said, interrupt: true }),
            },
          };
        }
        case "elicitation":
          return {
            heard: "asks",
            request: {
              id,
              asked: elicitationText(request),
              turnDown: () => ({ action: "cancel" }),
            },
          };
        default:
          return { heard: "unknown request", request: { id } };
      }
    };

    /** One line, read once: the parser reads it first, so the work it settles has its words. */
    const take = (line: JsonLine): void => {
      for (const event of parser.read(line)) report(event);
      if (line.kind === "lost") hear("unreadable");
      // A line that is not JSON says nothing the run decides on.
      else if (line.kind === "json") read(line.value);
    };

    const read = (value: unknown): void => {
      const message = record(value);
      if (message === undefined) return;
      switch (message["type"]) {
        case "result": {
          const isError = message["is_error"];
          const failed =
            typeof isError === "boolean" ? isError : string(message["subtype"]) !== "success";
          const queued = message["queued_turn_count"];
          const more = background > 0 || (typeof queued === "number" && queued > 0);
          hear(failed ? "failed" : more ? "result, more" : "result");
          return;
        }
        case "control_request": {
          const { heard, request } = requestOf(message);
          hear(heard, request);
          return;
        }
        case "system":
          if (message["subtype"] === "background_tasks_changed") {
            background = (array(message["tasks"]) ?? []).length;
          }
          break;
        case "assistant":
          if (message["error"] === "authentication_failed") signedOut = true;
          break;
        default:
          break;
      }
      hear(startsTurn(message) ? "turn" : "other");
    };

    // One line at a time, so the work settles at the same line however the output was cut into
    // chunks, and nothing after that line counts.
    stdout.on("data", (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length && phase !== "settled") {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline + 1;
        const piece = chunk.subarray(start, end);
        start = end;
        for (const line of lines.push(piece)) take(line);
      }
    });

    // A program that closes its output and lives on has said its last line.
    stdout.on("end", () => {
      for (const line of lines.end()) take(line);
    });

    write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: session.request }] },
    });

    return {
      settled,
      interrupt: () => {
        // Nothing to say it over: the host interrupts the program itself.
        if (phase === "turn" && inputEnded) return false;
        hear("stop");
        return true;
      },
      close: endInput,
      ended: (exit) => {
        for (const line of lines.end()) take(line);
        hear("exit", undefined, exit);
      },
    };
  };
}
