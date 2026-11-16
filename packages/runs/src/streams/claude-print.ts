// The parser for `claude -p --output-format stream-json --verbose` (A4 3.11.3, 3.11.4), shaped on
// the Claude Code 2.1.322 recordings of lab run N (fixtures/streams/claude-print/).
//
// | Event                          | Use                                                        |
// |--------------------------------|------------------------------------------------------------|
// | `system` / `init`              | native ID (`session_id`), `session` (cwd, Tasks tools)     |
// | `assistant`, `tool_use` blocks | a progress label per tool call                             |
// | `assistant`, `text` blocks     | a message; the last one is the result if `result` has none |
// | `result`                       | the final state, result text, usage, permission denials    |
// | `user`, `rate_limit_event`, other `system` subtypes, `stream_event` | known, nothing to use |
//
// The run is judged by the last `result` event's `is_error`, not by the exit code: Claude exits 0
// after Ctrl+C with `is_error: true`, and 1 after an invalid model with `subtype: success` and
// `is_error: true` (A4 3.11.3).
import { MCP_SERVER_KEY } from "@tasks/brand";
import type { AppToolsState, OutcomeReason, ProcessExit, ProgressLabel, Usage } from "./events.ts";
import {
  createParser,
  RecentKeys,
  type CliReader,
  type ReadContext,
  type StreamParser,
} from "./parser.ts";
import { addCounts, amount, array, count, nativeId, record, string, type Json } from "./values.ts";

/** Known event types that carry nothing the run needs. */
const IGNORED = new Set(["user", "rate_limit_event", "stream_event"]);

const TASKS_TOOL_PREFIX = `mcp__${MCP_SERVER_KEY}__`;

const LABELS: Readonly<Record<string, ProgressLabel>> = {
  Bash: "command",
  BashOutput: "command",
  KillShell: "command",
  KillBash: "command",
  PowerShell: "command",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Glob: "read",
  Grep: "read",
  LS: "read",
  NotebookRead: "read",
  WebSearch: "web",
  WebFetch: "web",
  TodoWrite: "plan",
  Task: "agent",
  Agent: "agent",
};

/** The progress label for a tool name. Unknown tools are "tool": the name is never passed on. */
export function claudeToolLabel(name: string | undefined): ProgressLabel {
  if (name === undefined) return "tool";
  if (name.startsWith(TASKS_TOOL_PREFIX)) return "tasks";
  return Object.hasOwn(LABELS, name) ? (LABELS[name] ?? "tool") : "tool";
}

interface FinalResult {
  /** The last result's verdict: its is_error, or its subtype when is_error is missing. */
  failed: boolean;
  subtype: string | undefined;
  terminalReason: string | undefined;
}

class ClaudeReader implements CliReader {
  private final: FinalResult | null = null;
  private readonly toolUses = new RecentKeys();

  read(event: Json, ctx: ReadContext): boolean {
    switch (event["type"]) {
      case "system":
        if (event["subtype"] === "init") this.init(event, ctx);
        return true;
      case "assistant":
        this.assistant(event, ctx);
        return true;
      case "result":
        this.result_(event, ctx);
        return true;
      default: {
        const type = event["type"];
        return typeof type === "string" && IGNORED.has(type);
      }
    }
  }

  private init(event: Json, ctx: ReadContext): void {
    // The session facts belong to the run's own session. An init of another session, or one
    // without a usable ID once the run's ID is known, is counted and leaves them as they are.
    const id = nativeId(event["session_id"]);
    if (id === undefined) {
      ctx.counts.malformed += 1;
      if (ctx.nativeId !== null) return;
    } else if (!ctx.nativeIdSeen(id)) {
      return;
    }

    const servers = array(event["mcp_servers"]);
    let appTools: AppToolsState = "absent";
    if (servers === undefined) {
      if (event["mcp_servers"] !== undefined) ctx.counts.malformed += 1;
    } else {
      for (const s of servers) {
        const server = record(s);
        if (server?.["name"] !== MCP_SERVER_KEY) continue;
        appTools = server["status"] === "connected" ? "connected" : "not-connected";
      }
    }
    ctx.sessionSeen(string(event["cwd"]) ?? null, appTools);
  }

  private assistant(event: Json, ctx: ReadContext): void {
    const content = array(record(event["message"])?.["content"]);
    if (content === undefined) {
      ctx.counts.malformed += 1;
      return;
    }
    // An API error comes as an assistant text block marked as an error message, then a result.
    const apiError = event["is_api_error_message"] === true;
    for (const b of content) {
      const block = record(b);
      if (block === undefined) continue;
      if (block["type"] === "tool_use") {
        const id = string(block["id"]);
        if (id === undefined || this.toolUses.add(id))
          ctx.progress(claudeToolLabel(string(block["name"])));
      } else if (block["type"] === "text") {
        const text = string(block["text"]);
        if (text === undefined) ctx.counts.malformed += 1;
        else if (apiError) ctx.error(text);
        else ctx.message(text);
      }
    }
  }

  private result_(event: Json, ctx: ReadContext): void {
    const isError = typeof event["is_error"] === "boolean" ? event["is_error"] : undefined;
    const subtype = string(event["subtype"]);
    // Judged by is_error. Only when a release drops the field does the subtype decide. The text
    // and the verdict are read from this one decision, so they cannot disagree.
    const failed = isError ?? subtype !== "success";
    const text = string(event["result"]);
    this.final = { failed, subtype, terminalReason: string(event["terminal_reason"]) };
    // On a failure, `result` holds the error text, not an answer.
    if (!failed && text !== undefined) ctx.answer(text, true);
    const errors = array(event["errors"]);
    const firstError = errors?.find((e) => typeof e === "string");
    if (typeof firstError === "string") ctx.error(firstError);
    else if (failed && text !== undefined) ctx.error(text);

    const denials = array(event["permission_denials"]);
    ctx.counts.permissionDenials = denials?.length ?? 0;

    const usage = this.usage(event);
    if (usage !== undefined) ctx.usageSeen(usage);
  }

  /** The run's total usage from a result event. Claude's `input_tokens` excludes cached input. */
  private usage(event: Json): Usage | undefined {
    const u = record(event["usage"]);
    const out: Usage = {};
    if (u !== undefined) {
      const fresh = count(u["input_tokens"]);
      const created = count(u["cache_creation_input_tokens"]);
      const read = count(u["cache_read_input_tokens"]);
      const input = addCounts(addCounts(fresh, created), read);
      if (input !== undefined) out.inputTokens = input;
      if (read !== undefined) out.cachedInputTokens = read;
      const output = count(u["output_tokens"]);
      if (output !== undefined) out.outputTokens = output;
    }
    const cost = amount(event["total_cost_usd"]);
    if (cost !== undefined) out.costUsd = cost;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  judge(exit: ProcessExit): { ok: boolean; reason: OutcomeReason } {
    const f = this.final;
    if (f === null) return { ok: false, reason: "no_result" };
    if (!f.failed) {
      return exit.code === 0 && exit.signal === null
        ? { ok: true, reason: "success" }
        : { ok: false, reason: "exit_status" };
    }
    if (f.subtype === "error_max_turns") return { ok: false, reason: "max_turns" };
    if (f.subtype === "error_max_budget_usd") return { ok: false, reason: "max_budget" };
    if (f.terminalReason?.startsWith("aborted") === true)
      return { ok: false, reason: "interrupted" };
    return { ok: false, reason: "agent_error" };
  }

  retained(): { keys: number; chars: number } {
    return { keys: this.toolUses.size, chars: this.toolUses.chars };
  }
}

/** A parser for one `claude-print` run's stdout. */
export function createClaudePrintParser(): StreamParser {
  return createParser("claude-print", new ClaudeReader());
}
