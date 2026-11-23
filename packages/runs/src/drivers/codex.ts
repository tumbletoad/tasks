// The `codex` driver: Codex's app server (`codex app-server`), JSON-RPC lines on stdio. The order
// of calls and how the server's requests are answered follow T3 Code's Codex adapter
// (orchestration-v2/Adapters/CodexAdapterV2.ts); the message shapes are the few this driver
// reads, from what a real app server said (fixtures/codex-app-server).
//
// - Start: `initialize`, `initialized`, `thread/start` with the permission's approval policy and
//   sandbox and TTasks's own tools in the thread's configuration (the person's other tools stay as
//   they are), then `turn/start` with the request. The request goes over the protocol, never on a
//   command line. The thread works in the server's own folder, the run's: a `cwd` in
//   `thread/start` makes Codex record a git folder as trusted in the person's own settings when
//   the run may write there.
// - The work is the run's own thread. Agents it starts work in threads of their own, on the same
//   connection: their turns, answers and errors are never the run's.
// - The work is settled when the thread's turn completed, no command it started is still running
//   and no agent it started still works: what goes on in the background ends later, and the run
//   waits for it.
// - The answer is the message the protocol marks as the final answer, never just the last text.
//   Its words count as they stream in: a turn, a Stop or a server that ends before the message is
//   whole keeps them as an unfinished answer, and the turn's summary completes an answer whose own
//   message comes after it.
// - The server's requests are answered as the run's permission says, while reading goes on. A
//   question for the person is never answered for them: a blocking one interrupts the turn, one
//   the turn ends with is kept, and the work ends as needing the person, with the question as its
//   text. A question of an agent the run's agent started hears that no one answered. A request
//   kind this driver does not know gets the protocol's "method not found".
// - The thread is given work only once its folder, as the server reports it, is the run's.
// - Stop asks the server to interrupt the turn, and waits for nothing: during start-up, with no
//   turn yet, the work ends at once.
import {
  ANSWER_CAP_BYTES,
  TEXT_CAP_BYTES,
  type AppToolsState,
  type OutcomeReason,
  type ProgressLabel,
  type RunPermission,
  type Usage,
} from "@ttasks/contracts/runs";
import { realpath } from "node:fs/promises";
import { MCP_SERVER_KEY, PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";
import { array, capText, count, nativeId, record, string, type Json } from "../streams/values.ts";
import { LineRpc, NO_ANSWER, RPC_ERRORS, RpcClosed, RpcError } from "./json-rpc.ts";
import type { DriverSession, OpenDriver, Work } from "./types.ts";

/** The arguments after the program that start Codex's app server. */
export const CODEX_ARGS: readonly string[] = ["app-server"];

/**
 * Whether a folder the server reports is `folder`, as the file system resolves both: links, short
 * names and, on Windows and macOS, case. Asynchronous, because a share that stops answering would
 * otherwise hold the service's every request and timer.
 */
export function sameFolder(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): (cwd: string) => Promise<boolean> {
  const real = async (path: string): Promise<string | undefined> => {
    try {
      const resolved = await realpath(path);
      return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
    } catch {
      return undefined;
    }
  };
  return async (cwd) => {
    const [expected, said] = await Promise.all([real(folder), real(cwd)]);
    return expected !== undefined && said === expected;
  };
}

/** TTasks's own MCP server for the thread: the bridge, with the run's ticket in its environment. */
export interface CodexTools {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface CodexSession {
  /** The person's request, sent as the turn's input. */
  readonly request: string;
  readonly permission: RunPermission;
  readonly tools?: CodexTools;
  /** How long each start-up call may take. Default: 60 s. */
  readonly startMs?: number;
  /** What the client calls itself in `initialize`. */
  readonly client?: { readonly version: string };
  /**
   * Whether the folder the server says the thread works in is the run's. A program that changes
   * folder before Codex starts (a wrapper script) would otherwise have the agent work elsewhere.
   * Given, a thread whose folder is not said, or not checked within `startMs`, gets no work.
   */
  readonly inFolder?: (cwd: string) => Promise<boolean>;
}

/** How each permission runs a Codex thread: no one is ever asked, the sandbox decides. */
const POLICY: Readonly<Record<RunPermission, { approvalPolicy: string; sandbox: string }>> = {
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
  "auto-edit": { approvalPolicy: "never", sandbox: "workspace-write" },
  "read-only": { approvalPolicy: "never", sandbox: "read-only" },
};

/** The thread's configuration: TTasks's tools under their own name, beside the person's. */
export function threadConfig(tools: CodexTools | undefined): Json | undefined {
  if (tools === undefined) return undefined;
  return {
    [`mcp_servers.${MCP_SERVER_KEY}`]: {
      command: tools.command,
      args: [...tools.args],
      env: { ...tools.env },
    },
  };
}

/** The progress label of an item that started, or undefined for none. */
function labelOf(item: Json): ProgressLabel | undefined {
  switch (item["type"]) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "edit";
    case "mcpToolCall":
      return item["server"] === MCP_SERVER_KEY ? "tasks" : "tool";
    case "dynamicToolCall":
      return "tool";
    case "webSearch":
      return "web";
    case "plan":
    case "todoList":
      return "plan";
    case "collabAgentToolCall":
    case "subAgentActivity":
      return "agent";
    default:
      return undefined;
  }
}

/**
 * A question for the person as text: each question with its choices. Blocking questions name
 * theirs `question` with `{label}` choices, the ones a turn ends with `title` with plain ones.
 */
function questionText(params: Json): string {
  const questions = Array.isArray(params["questions"]) ? params["questions"] : [];
  const lines: string[] = [];
  for (const q of questions) {
    const question = record(q);
    if (question === undefined) continue;
    const text =
      string(question["question"]) ?? string(question["title"]) ?? string(question["header"]) ?? "";
    const options = (Array.isArray(question["options"]) ? question["options"] : [])
      .map((o) => string(o) ?? string(record(o)?.["label"]))
      .filter((label): label is string => label !== undefined && label !== "");
    lines.push(options.length > 0 ? `${text} (${options.join(", ")})` : text);
  }
  const message = string(params["message"]);
  if (lines.length === 0 && message !== undefined) lines.push(message);
  return lines.join("\n").trim();
}

/** A message that is an answer: the final one, or any of a server that marks none. */
const answers = (item: Json): boolean =>
  item["phase"] === "final_answer" || item["phase"] === null || item["phase"] === undefined;

/** A message the turn ends with that asks the person, rather than answers: its questions. */
const asksPerson = (item: Json): boolean =>
  item["delivery"] === "async" &&
  Array.isArray(item["questions"]) &&
  (item["questions"] as unknown[]).length > 0;

/** The protocol's answer when no one answers a request: declined, or nothing given. */
function unanswered(method: string): Json {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: "The run has ended." } } };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline" };
    default:
      throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}

/** Words of an error that say the agent is not signed in. */
const SIGNED_OUT = /\b(?:401|unauthori[sz]ed|not logged in|log ?in|sign ?in|authenticat)/iu;

/** The agent's own words, cut to TEXT_CAP_BYTES, with the sign-in command when it is signed out. */
function errorText(text: string): string {
  const said = text.trim() === "" ? "Codex ended the turn with an error." : text.trim();
  const hint = SIGNED_OUT.test(said) ? " Sign in with: codex login" : "";
  return capText(`${said}${hint}`, TEXT_CAP_BYTES).text;
}

function usageOf(tokenUsage: Json | undefined): Usage | null {
  const total = record(tokenUsage?.["total"]);
  if (total === undefined) return null;
  const usage: Usage = {};
  const input = count(total["inputTokens"]);
  const cached = count(total["cachedInputTokens"]);
  const output = count(total["outputTokens"]);
  const reasoning = count(total["reasoningOutputTokens"]);
  if (input !== undefined) usage.inputTokens = input;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  return Object.keys(usage).length === 0 ? null : usage;
}

/** `promise`, or a rejection after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("timeout"));
      }, ms);
      timer.unref();
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

export function codexDriver(session: CodexSession): OpenDriver {
  return ({ stdin, stdout }, report) => {
    const rpc = new LineRpc(stdout, stdin);
    const startMs = session.startMs ?? 60_000;
    const policy = POLICY[session.permission];
    const state: {
      thread: string | null;
      turn: string | null;
      turnDone: boolean;
      turnStatus: string | null;
      turnError: string | null;
      lastError: string | null;
      /** The latest answer: `whole` once its message completed, else the words streamed so far. */
      answer: { text: string; cut: boolean; whole: boolean } | null;
      final: boolean;
      heard: boolean;
      usage: Usage | null;
      appTools: AppToolsState | null;
      declined: number;
      question: { text: string; cut: boolean } | null;
      stopping: boolean;
    } = {
      thread: null,
      turn: null,
      turnDone: false,
      turnStatus: null,
      turnError: null,
      lastError: null,
      answer: null,
      final: false,
      heard: false,
      usage: null,
      appTools: session.tools === undefined ? null : "absent",
      declined: 0,
      question: null,
      stopping: false,
    };
    /**
     * Commands started and not completed, of the run's thread and of the agents it started, by
     * item, with the thread and turn that started them.
     */
    const running = new Map<string, { thread: string | null; turn: string | null }>();
    /** Forgets the commands of a thread, or of one of its turns: nothing will say they ended. */
    const forget = (thread: string | null, turn?: string | null): void => {
      for (const [item, of] of running) {
        if (of.thread === thread && (turn === undefined || of.turn === turn)) running.delete(item);
      }
    };
    /** Threads of agents the run's agent started that are working. */
    const children = new Set<string>();
    /** The run's answer messages that are streaming in, by item: their words so far. */
    const streaming = new Map<string, { text: string; bytes: number; cut: boolean }>();
    /** The run's messages of the current turn that completed, by item. */
    const completed = new Set<string>();
    /** Whether a message is about the run's own thread, not one of an agent it started. */
    const ours = (params: Json): boolean => {
      const thread = string(params["threadId"]);
      return thread === undefined || state.thread === null || thread === state.thread;
    };

    let done = false;
    const stopped = (): boolean => state.stopping;
    /** Whether the work is stopped or settled: read again after each wait. */
    const over = (): boolean => state.stopping || done;
    let settle: (work: Work) => void = () => undefined;
    const settled = new Promise<Work>((resolve) => {
      settle = resolve;
    });
    /**
     * What the run says: a question the agent asked, once it asked one, however the run then ends,
     * since that is what the person acts on; else its answer. The run's folder keeps the same.
     */
    const said = (): { text: string; cut: boolean; final: boolean } | null => {
      if (state.question !== null) return { ...state.question, final: false };
      if (state.answer === null) return null;
      return { text: state.answer.text, cut: state.answer.cut, final: state.final };
    };
    const keep = (): void => {
      const told = said();
      if (told !== null) report({ kind: "answer", ...told });
    };
    /** A message of the run's own thread, whole: its question, its answer, or what it reports. */
    const heard = (item: Json): void => {
      const id = string(item["id"]);
      if (id !== undefined) {
        completed.add(id);
        streaming.delete(id);
      }
      const text = string(item["text"]) ?? "";
      if (asksPerson(item)) {
        ask(
          [text.trim(), questionText({ questions: item["questions"] })]
            .filter((part) => part !== "")
            .join("\n"),
        );
      } else if (text !== "" && answers(item)) {
        const capped = capText(text, ANSWER_CAP_BYTES);
        state.answer = { text: capped.text, cut: capped.capped, whole: true };
        if (state.question === null) keep();
      } else if (text !== "") {
        report({ kind: "message", text: capText(text).text });
      }
    };
    const finish = (outcome: OutcomeReason, error: string | null = null): void => {
      if (done) return;
      done = true;
      const told = said();
      settle({
        ok: outcome === "success",
        outcome,
        nativeId: state.thread,
        text: told?.text ?? null,
        textCut: told?.cut ?? false,
        textFinal: told?.final ?? false,
        error,
        usage: state.usage,
        appTools: state.appTools,
        declined: state.declined,
        permissionDenials: 0,
      });
    };

    /** Settles once the turn completed and nothing it started still runs. */
    const check = (): void => {
      if (done || !state.turnDone || running.size > 0 || children.size > 0) return;
      if (state.turnStatus === "completed" && state.question !== null) {
        finish("needs_input");
      } else if (state.turnStatus === "completed") {
        state.final = state.answer?.whole === true;
        keep();
        finish("success");
      } else if (state.turnStatus === "interrupted") {
        finish(state.question !== null ? "needs_input" : "interrupted");
      } else {
        finish("agent_error", errorText(state.turnError ?? state.lastError ?? ""));
      }
    };

    const interruptTurn = (): void => {
      if (state.thread === null || state.turn === null || state.turnDone) return;
      rpc.request("turn/interrupt", { threadId: state.thread, turnId: state.turn }).catch(() => {
        // The turn ended meanwhile, or the server is gone: its own end says how the work went.
      });
    };

    const ask = (text: string): void => {
      const question = capText(text === "" ? "Codex asked a question." : text, ANSWER_CAP_BYTES);
      state.question = { text: question.text, cut: question.capped };
      keep();
    };

    const needsPerson = (text: string): typeof NO_ANSWER => {
      ask(text);
      interruptTurn();
      finish("needs_input");
      return NO_ANSWER;
    };

    rpc.onRequest((method, raw) => {
      // Settled work is saved as it is: a request that comes while the server closes hears that no
      // one answered, and changes nothing.
      if (done) return unanswered(method);
      state.heard = true;
      const params = record(raw) ?? {};
      // An agent the run's agent started asks its own questions: no person will answer them, and
      // that agent carries on or fails by itself, as its parent's turn goes on. Approvals are
      // answered alike for every thread: all of them are the run's work, under its permission.
      const helper = !ours(params);
      const full = session.permission === "full-access";
      const edits = full || session.permission === "auto-edit";
      switch (method) {
        case "item/commandExecution/requestApproval":
          return { decision: full ? "accept" : "decline" };
        case "item/fileChange/requestApproval":
          return { decision: edits ? "accept" : "decline" };
        case "execCommandApproval":
          return {
            decision: full
              ? "approved"
              : { denied: { rejection: "The run's permission declines it." } },
          };
        case "applyPatchApproval":
          return {
            decision: edits
              ? "approved"
              : { denied: { rejection: "The run's permission declines it." } },
          };
        case "item/permissions/requestApproval":
          return full
            ? { permissions: params["permissions"] ?? {}, scope: "turn" }
            : { permissions: {}, scope: "turn" };
        case "item/tool/requestUserInput":
        case "mcpServer/elicitation/request":
          return helper ? unanswered(method) : needsPerson(questionText(params));
        default:
          throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
      }
    });

    rpc.onNotification((method, raw) => {
      // Settled work is saved as it is: what the server says while it closes changes none of it.
      if (done) return;
      state.heard = true;
      const params = record(raw) ?? {};
      switch (method) {
        case "thread/started": {
          const id = nativeId(record(params["thread"])?.["id"]);
          if (id !== undefined && state.thread === null) {
            state.thread = id;
            report({ kind: "native-id", id });
          }
          return;
        }
        case "turn/started": {
          const id = string(record(params["turn"])?.["id"]);
          if (id === undefined) return;
          if (!ours(params)) {
            children.add(string(params["threadId"]) ?? "");
            return;
          }
          // A turn the server starts by itself after background work is the work going on.
          completed.clear();
          state.turn = id;
          state.turnDone = false;
          state.turnStatus = null;
          return;
        }
        case "item/started": {
          const item = record(params["item"]);
          if (item === undefined) return;
          const id = string(item["id"]);
          if (item["type"] === "commandExecution" && id !== undefined) {
            if (item["status"] === "inProgress") {
              running.set(id, {
                thread: string(params["threadId"]) ?? null,
                turn: string(params["turnId"]) ?? null,
              });
            }
          }
          if (
            item["type"] === "agentMessage" &&
            id !== undefined &&
            ours(params) &&
            answers(item)
          ) {
            streaming.set(id, { text: "", bytes: 0, cut: false });
          }
          const label = labelOf(item);
          if (label !== undefined) report({ kind: "progress", label });
          return;
        }
        case "item/completed": {
          const item = record(params["item"]);
          if (item === undefined) return;
          const id = string(item["id"]);
          if (id !== undefined) running.delete(id);
          if (item["status"] === "declined") state.declined += 1;
          if (item["type"] === "agentMessage" && ours(params)) heard(item);
          check();
          return;
        }
        case "item/agentMessage/delta": {
          if (!ours(params)) return;
          const words = streaming.get(string(params["itemId"]) ?? "");
          const delta = string(params["delta"]) ?? "";
          if (words === undefined || words.cut || delta === "") return;
          // Words past the answer's cap are not kept.
          const bytes = Buffer.byteLength(delta, "utf8");
          if (words.bytes + bytes > ANSWER_CAP_BYTES) {
            words.text = capText(words.text + delta, ANSWER_CAP_BYTES).text;
            words.cut = true;
          } else {
            words.text += delta;
            words.bytes += bytes;
          }
          state.answer = { text: words.text, cut: words.cut, whole: false };
          return;
        }
        case "turn/completed": {
          const turn = record(params["turn"]);
          if (turn === undefined) return;
          const id = string(turn["id"]);
          if (!ours(params)) {
            const thread = string(params["threadId"]) ?? "";
            children.delete(thread);
            if (turn["status"] !== "completed") forget(thread, id ?? null);
            check();
            return;
          }
          if (state.turn !== null && id !== state.turn) return;
          state.turn = id ?? state.turn;
          state.turnDone = true;
          state.turnStatus = string(turn["status"]) ?? "failed";
          state.turnError = string(record(turn["error"])?.["message"]) ?? null;
          // The summary holds the turn's messages whole, also one whose own message is still to
          // come: anything said after the work settled no longer counts.
          for (const summarised of array(turn["items"]) ?? []) {
            const message = record(summarised);
            if (message?.["type"] !== "agentMessage") continue;
            if (!completed.has(string(message["id"]) ?? "")) heard(message);
          }
          streaming.clear();
          if (state.turnStatus !== "completed") {
            // The work ended with the turn: what it left going has no end of its own to wait for.
            running.clear();
            children.clear();
          }
          check();
          return;
        }
        case "thread/status/changed":
        case "thread/closed": {
          // An agent the run's agent started works while its thread is active. Idle, its turn
          // ended and what it left in the background goes on; closed or failed, nothing of it
          // will say it ended.
          const thread = string(params["threadId"]);
          if (ours(params) || thread === undefined) return;
          const status = method === "thread/closed" ? "closed" : record(params["status"])?.["type"];
          if (status === "active") {
            children.add(thread);
            return;
          }
          children.delete(thread);
          if (status !== "idle") forget(thread);
          check();
          return;
        }
        case "error": {
          if (!ours(params)) return;
          const error = record(params["error"]);
          if (params["willRetry"] !== true) state.lastError = string(error?.["message"]) ?? null;
          return;
        }
        case "thread/tokenUsage/updated":
          if (!ours(params)) return;
          state.usage = usageOf(record(params["tokenUsage"])) ?? state.usage;
          if (state.usage !== null) report({ kind: "usage", ...state.usage });
          return;
        case "mcpServer/startupStatus/updated":
          if (!ours(params)) return;
          if (params["name"] !== MCP_SERVER_KEY || state.appTools === null) return;
          if (params["status"] === "ready") state.appTools = "connected";
          else if (params["status"] === "failed" || params["status"] === "error") {
            state.appTools = "not-connected";
          }
          return;
        default:
          return;
      }
    });

    /** Why the thread works outside the run's folder, or null when it works in it. */
    const outside = async (cwd: string | undefined): Promise<string | null> => {
      if (session.inFolder === undefined) return null;
      if (cwd === undefined || cwd === "") {
        return "Codex did not say which folder it works in, so it was given no work.";
      }
      let same: boolean;
      try {
        same = await within(session.inFolder(cwd), startMs);
      } catch {
        return "The task's folder did not answer in time, so Codex was given no work.";
      }
      return same
        ? null
        : `Codex started in ${cwd}, not in the task's folder, so it was given no work. Its program may change folder before it starts.`;
    };

    const start = async (): Promise<void> => {
      try {
        await within(
          rpc.request("initialize", {
            clientInfo: {
              name: PRODUCT_ID,
              title: PRODUCT_NAME,
              version: session.client?.version ?? "0.0.0",
            },
            capabilities: { experimentalApi: true },
          }),
          startMs,
        );
        rpc.notify("initialized");
        const config = threadConfig(session.tools);
        const thread = record(
          await within(
            rpc.request("thread/start", {
              approvalPolicy: policy.approvalPolicy,
              sandbox: policy.sandbox,
              ...(config === undefined ? {} : { config }),
            }),
            startMs,
          ),
        );
        const id = nativeId(record(thread?.["thread"])?.["id"]);
        if (id === undefined) throw new RpcError(RPC_ERRORS.internal, "Codex started no thread.");
        if (state.thread === null) {
          state.thread = id;
          report({ kind: "native-id", id });
        }
        if (state.stopping || done) return;
        const elsewhere = await outside(
          string(thread?.["cwd"]) ?? string(record(thread?.["thread"])?.["cwd"]),
        );
        // A Stop that came while the folder was checked ended the work already.
        if (over()) return;
        if (elsewhere !== null) {
          finish("agent_error", capText(elsewhere, TEXT_CAP_BYTES).text);
          return;
        }
        const turn = record(
          await within(
            rpc.request("turn/start", {
              threadId: id,
              input: [{ type: "text", text: session.request, text_elements: [] }],
            }),
            startMs,
          ),
        );
        const turnId = string(record(turn?.["turn"])?.["id"]);
        if (turnId !== undefined && state.turn === null) state.turn = turnId;
        // A Stop that came while the turn was being started ended the work already: the turn
        // that started meanwhile is interrupted too.
        if (stopped()) interruptTurn();
      } catch (error) {
        if (error instanceof RpcClosed || done) return;
        if (state.stopping) {
          finish("interrupted");
          return;
        }
        finish(
          "agent_error",
          error instanceof RpcError
            ? errorText(error.message)
            : "Codex did not answer its start in time.",
        );
      }
    };
    void start();

    const driver: DriverSession = {
      settled,
      interrupt: () => {
        if (done) return true;
        state.stopping = true;
        if (state.turn !== null && !state.turnDone) interruptTurn();
        // No turn to interrupt yet, or only work it left running: the work ends here.
        else finish("interrupted");
        return true;
      },
      close: () => {
        rpc.close();
        stdin.end();
      },
      ended: () => {
        rpc.close();
        if (done) return;
        // The server ended while the work went on, background work included: it did not finish.
        if (state.stopping) finish("interrupted");
        else if (!state.heard && state.thread === null) finish("no_output");
        else finish("no_result", state.lastError === null ? null : errorText(state.lastError));
      },
    };
    return driver;
  };
}
