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
// - A message that cannot be read (streams/json-lines.ts) ends the work at once as failed, with
//   what the agent said: nothing tells whom it was for, or what it ended.
// - The answer is the message the protocol marks as the final answer, never just the last text.
//   Messages are kept by item, per turn, and the run's answer is its last turn's: the message the
//   turn's summary names, else the turn's last answer, whole or as far as it streamed. A message
//   of another turn changes nothing of this one. A turn that ends while its last answer is still
//   coming waits LATE_MS for it, and a turn that said nothing leaves an earlier turn's words as
//   the run's last message, not as its answer.
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

/**
 * How long a turn that ended waits for the completion of its last answer, when its summary names
 * none: the server sends that completion in the same burst as the turn's end, so a second is
 * plenty on a loaded machine, and only a run whose answer races its turn's end pays it.
 */
const LATE_MS = 1_000;

/** Text the agent said, cut to its cap. */
interface Words {
  readonly text: string;
  readonly cut: boolean;
}

/** A message of the run's own thread, by item. */
interface Message {
  /** Its phase as last said: none (null or undefined) from a server that marks none. */
  phase: unknown;
  /** Its completion's text, else its words streamed so far. */
  text: string;
  bytes: number;
  cut: boolean;
  /** Its completion was heard. */
  done: boolean;
  /** `text` is its completion's, whole. */
  whole: boolean;
  /** The question for the person it ends with. */
  asks: Words | null;
}

/** One turn of the run's own thread: its messages only. */
interface Turn {
  id: string | null;
  /** By item, in the order they began. */
  readonly messages: Map<string, Message>;
  /** The item its summary names as the answer. */
  named: string | null;
  end: { readonly status: string; readonly error: string | null } | null;
  /** Its wait for a late answer is over. */
  waited: boolean;
}

const newTurn = (id: string | null): Turn => ({
  id,
  messages: new Map(),
  named: null,
  end: null,
  waited: false,
});

/** A message that began, with nothing said yet. */
const begun = (phase: unknown): Message => ({
  phase,
  text: "",
  bytes: 0,
  cut: false,
  done: false,
  whole: false,
  asks: null,
});

/** A phase of an answer: the final one, or none from a server that marks none. */
const answers = (phase: unknown): boolean =>
  phase === "final_answer" || phase === null || phase === undefined;

const blank = (text: string): boolean => text.trim() === "";

/** Whether a message is an answer with words. */
const isAnswer = (message: Message | undefined): message is Message =>
  message !== undefined && answers(message.phase) && !blank(message.text);

/** What a turn says: the question it ends with, else the answer its summary names, else its last. */
function saidBy(turn: Turn): (Words & { final: boolean }) | null {
  const messages = [...turn.messages.values()];
  const asks = messages.findLast((m) => m.asks !== null)?.asks;
  if (asks !== undefined && asks !== null) return { ...asks, final: false };
  const named = turn.named === null ? undefined : turn.messages.get(turn.named);
  const answer = isAnswer(named) ? named : messages.findLast(isAnswer);
  return answer === undefined ? null : { text: answer.text, cut: answer.cut, final: answer.whole };
}

/** A question for the person, cut to the answer's cap. */
function question(text: string): Words {
  const capped = capText(text === "" ? "Codex asked a question." : text, ANSWER_CAP_BYTES);
  return { text: capped.text, cut: capped.capped };
}

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
      lastError: string | null;
      heard: boolean;
      usage: Usage | null;
      appTools: AppToolsState | null;
      declined: number;
      /** A question a request asked the person: it ends the work at once. */
      asked: Words | null;
      stopping: boolean;
    } = {
      thread: null,
      lastError: null,
      heard: false,
      usage: null,
      appTools: session.tools === undefined ? null : "absent",
      declined: 0,
      asked: null,
      stopping: false,
    };
    /** The run's present turn, and what its earlier turns said. */
    let turn = newTurn(null);
    let earlier: Words | null = null;
    let late: NodeJS.Timeout | undefined;
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
    /** Whether a message is about the run's own thread, not one of an agent it started. */
    const ours = (params: Json): boolean => {
      const thread = string(params["threadId"]);
      return thread === undefined || state.thread === null || thread === state.thread;
    };
    /** Whether a message of the run's own thread is about its present turn. */
    const now = (params: Json): boolean => {
      const id = string(params["turnId"]);
      return id === undefined || turn.id === null || id === turn.id;
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
     * What the run says: a question the agent asked in its last turn, however the run then ends,
     * since that is what the person acts on; else that turn's answer; else, unfinished, what an
     * earlier turn said. The run's folder keeps the same.
     */
    const said = (): (Words & { final: boolean }) | null => {
      if (state.asked !== null) return { ...state.asked, final: false };
      return saidBy(turn) ?? (earlier === null ? null : { ...earlier, final: false });
    };
    /** What the run says as of now, in its folder: final only once its work succeeded. */
    let kept: (Words & { final: boolean }) | null = null;
    const keep = (succeeded = false): void => {
      const told = said();
      if (told === null) return;
      const final = succeeded && told.final;
      if (kept?.text === told.text && kept.cut === told.cut && kept.final === final) return;
      kept = { ...told, final };
      report({ kind: "answer", ...kept });
    };
    /**
     * A message of the present turn, whole, from its own completion or the turn's summary: what it
     * says replaces the words streamed so far, unless it says nothing. Returns its item.
     */
    const complete = (item: Json): string => {
      const key = string(item["id"]) ?? `unnamed-${String(turn.messages.size)}`;
      const known = turn.messages.get(key);
      const message = known ?? begun(item["phase"]);
      const first = !message.done;
      const text = string(item["text"]) ?? "";
      message.phase = item["phase"];
      message.done = true;
      message.asks = asksPerson(item)
        ? question(
            [text.trim(), questionText({ questions: item["questions"] })]
              .filter((part) => part !== "")
              .join("\n"),
          )
        : null;
      if (!blank(text) || blank(message.text)) {
        const capped = capText(text, ANSWER_CAP_BYTES);
        message.text = capped.text;
        message.cut = capped.capped;
        message.whole = !blank(text);
      }
      if (known === undefined) turn.messages.set(key, message);
      if (first && message.asks === null && !answers(message.phase) && text !== "") {
        report({ kind: "message", text: capText(text).text });
      }
      return key;
    };
    const finish = (outcome: OutcomeReason, error: string | null = null): void => {
      if (done) return;
      done = true;
      clearTimeout(late);
      const told = said();
      settle({
        ok: outcome === "success",
        outcome,
        nativeId: state.thread,
        text: told?.text ?? null,
        textCut: told?.cut ?? false,
        textFinal: outcome === "success" && told?.final === true,
        error,
        usage: state.usage,
        appTools: state.appTools,
        declined: state.declined,
        permissionDenials: 0,
      });
    };

    /** Whether the person is asked something: by a request, or by a message of the present turn. */
    const asking = (): boolean =>
      state.asked !== null || [...turn.messages.values()].some((m) => m.asks !== null);
    /**
     * Whether the turn's answer may still come within its wait: its last answer is not complete,
     * or the summary named none and no answer was seen yet (its messages can follow the summary).
     */
    const arriving = (): boolean => {
      if (turn.named !== null || turn.waited) return false;
      const last = [...turn.messages.values()].findLast((m) => answers(m.phase));
      return last === undefined || !last.done;
    };

    /** Settles once the turn completed and nothing it started still runs. */
    const check = (): void => {
      if (done || turn.end === null || running.size > 0 || children.size > 0) return;
      const { status, error } = turn.end;
      if (status === "completed" && asking()) {
        finish("needs_input");
      } else if (status === "completed" && arriving()) {
        if (late !== undefined) return;
        const waiting = turn;
        late = setTimeout(() => {
          late = undefined;
          waiting.waited = true;
          check();
        }, LATE_MS);
        late.unref();
      } else if (status === "completed") {
        keep(true);
        finish("success");
      } else if (status === "interrupted") {
        finish(asking() ? "needs_input" : "interrupted");
      } else {
        finish("agent_error", errorText(error ?? state.lastError ?? ""));
      }
    };

    const interruptTurn = (): void => {
      if (state.thread === null || turn.id === null || turn.end !== null) return;
      rpc.request("turn/interrupt", { threadId: state.thread, turnId: turn.id }).catch(() => {
        // The turn ended meanwhile, or the server is gone: its own end says how the work went.
      });
    };

    const needsPerson = (text: string): typeof NO_ANSWER => {
      state.asked = question(text);
      keep();
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

    /**
     * A message that could not be read: the work ends now, failed, with what the agent said so
     * far, since nothing tells whom the message was for or what it ended.
     */
    const unreadable = (): void => {
      finish(
        "agent_error",
        `Codex sent a message too long for ${PRODUCT_NAME} to read, so it could not tell when the work ended.`,
      );
    };

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
          if (turn.id === null) turn.id = id;
          if (id === turn.id) return;
          // A turn the server starts by itself after background work is the work going on, and
          // what it says is the run's answer from here on.
          earlier = saidBy(turn) ?? earlier;
          clearTimeout(late);
          late = undefined;
          turn = newTurn(id);
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
            now(params) &&
            !turn.messages.has(id)
          ) {
            turn.messages.set(id, begun(item["phase"]));
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
          if (item["type"] === "agentMessage" && ours(params) && now(params)) {
            complete(item);
            keep();
          }
          check();
          return;
        }
        case "item/agentMessage/delta": {
          if (!ours(params) || !now(params)) return;
          const message = turn.messages.get(string(params["itemId"]) ?? "");
          const delta = string(params["delta"]) ?? "";
          if (message === undefined || message.done || message.cut || delta === "") return;
          if (!answers(message.phase)) return;
          // Words past the answer's cap are not kept.
          const bytes = Buffer.byteLength(delta, "utf8");
          if (message.bytes + bytes > ANSWER_CAP_BYTES) {
            message.text = capText(message.text + delta, ANSWER_CAP_BYTES).text;
            message.cut = true;
          } else {
            message.text += delta;
            message.bytes += bytes;
          }
          return;
        }
        case "turn/completed": {
          const ended = record(params["turn"]);
          if (ended === undefined) return;
          const id = string(ended["id"]);
          if (!ours(params)) {
            const thread = string(params["threadId"]) ?? "";
            children.delete(thread);
            if (ended["status"] !== "completed") forget(thread, id ?? null);
            check();
            return;
          }
          if (turn.id !== null && id !== turn.id) return;
          turn.id = id ?? turn.id;
          turn.end = {
            status: string(ended["status"]) ?? "failed",
            error: string(record(ended["error"])?.["message"]) ?? null,
          };
          // The summary holds the turn's messages whole, also one whose own completion is still to
          // come, and names the answer among them.
          for (const summarised of array(ended["items"]) ?? []) {
            const item = record(summarised);
            if (item?.["type"] !== "agentMessage") continue;
            const key = complete(item);
            if (isAnswer(turn.messages.get(key))) turn.named = key;
          }
          keep();
          if (turn.end.status !== "completed") {
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
    rpc.onLost(unreadable);

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
        const started = record(
          await within(
            rpc.request("turn/start", {
              threadId: id,
              input: [{ type: "text", text: session.request, text_elements: [] }],
            }),
            startMs,
          ),
        );
        const turnId = string(record(started?.["turn"])?.["id"]);
        if (turnId !== undefined && turn.id === null) turn.id = turnId;
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
        if (turn.id !== null && turn.end === null) interruptTurn();
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
        // The turn had completed and only its last words were waited for: they will not come now,
        // and the work is as the turn said. Once that settled it, the lines below change nothing.
        if (late !== undefined) {
          clearTimeout(late);
          late = undefined;
          turn.waited = true;
          check();
        }
        // The server ended while the work went on, background work included: it did not finish.
        if (state.stopping) finish("interrupted");
        else if (!state.heard && state.thread === null) finish("no_output");
        else finish("no_result", state.lastError === null ? null : errorText(state.lastError));
      },
    };
    return driver;
  };
}
