// The parser for `codex exec --json` (A4 3.11.3, 3.11.4), shaped on the codex-cli 0.167.2
// recordings of lab run N (fixtures/streams/codex-exec/).
//
// | Event                                         | Use                                         |
// |-----------------------------------------------|---------------------------------------------|
// | `thread.started {thread_id}`                  | native ID (repeated by `exec resume`)       |
// | `item.started` / `item.updated` / `item.completed` | a progress label per item; a completed `agent_message` is a message, the last one the result; a `declined` command is counted; an `error` item is kept as the last error |
// | `turn.started`                                | the turn began                              |
// | `turn.completed {usage}`                      | the turn succeeded; usage (summed per turn) |
// | `turn.failed {error}`, `error {message}`      | the turn failed, with the message           |
//
// A cancel flushes no event (A4 3.11.3), so a run without a
// final `turn.completed` or `turn.failed` ends as `no_result`, judged with the exit code.
import { MCP_SERVER_KEY } from "@tasks/brand";
import type { OutcomeReason, ProcessExit, ProgressLabel, Usage } from "./events.ts";
import {
  createParser,
  RecentKeys,
  type CliReader,
  type ReadContext,
  type StreamParser,
} from "./parser.ts";
import { addCounts, count, nativeId, record, string, type Json } from "./values.ts";

const ITEM_EVENTS = new Set(["item.started", "item.updated", "item.completed"]);

/** Item types and their progress label; null for items that are not a step of their own. */
const ITEM_LABELS: Readonly<Record<string, ProgressLabel | null>> = {
  command_execution: "command",
  file_change: "edit",
  mcp_tool_call: "tool", // "tasks" when the server is Tasks's
  web_search: "web",
  todo_list: "plan",
  agent_message: null,
  reasoning: null,
  error: null,
};

type Turn = "none" | "started" | "completed" | "failed";

class CodexReader implements CliReader {
  private turn: Turn = "none";
  private readonly labelled = new RecentKeys();
  private readonly declined = new RecentKeys();

  read(event: Json, ctx: ReadContext): boolean {
    const type = event["type"];
    if (typeof type !== "string") return false;
    if (ITEM_EVENTS.has(type)) return this.item(type, event, ctx);
    switch (type) {
      case "thread.started": {
        const id = nativeId(event["thread_id"]);
        if (id === undefined) ctx.counts.malformed += 1;
        else ctx.nativeIdSeen(id);
        return true;
      }
      case "turn.started":
        this.turn = "started";
        return true;
      case "turn.completed":
        this.turn = "completed";
        this.usage(event, ctx);
        return true;
      case "turn.failed": {
        this.turn = "failed";
        const message = string(record(event["error"])?.["message"]);
        if (message === undefined) ctx.counts.malformed += 1;
        else ctx.error(message);
        return true;
      }
      case "error": {
        // Also sent for problems the turn recovers from, so it does not end the turn by itself.
        const message = string(event["message"]);
        if (message === undefined) ctx.counts.malformed += 1;
        else ctx.error(message);
        return true;
      }
      default:
        return false;
    }
  }

  private item(type: string, event: Json, ctx: ReadContext): boolean {
    const item = record(event["item"]);
    const itemType = string(item?.["type"]);
    if (item === undefined || itemType === undefined) {
      ctx.counts.malformed += 1;
      return true;
    }
    if (!Object.hasOwn(ITEM_LABELS, itemType)) return false;
    const id = string(item["id"]);
    const completed = type === "item.completed";

    if (itemType === "agent_message") {
      if (completed) {
        const text = string(item["text"]);
        if (text === undefined) ctx.counts.malformed += 1;
        else ctx.message(text);
      }
      return true;
    }
    if (itemType === "error") {
      const message = string(item["message"]);
      if (message !== undefined) ctx.error(message);
      return true;
    }
    if (itemType === "command_execution" && item["status"] === "declined") {
      // Counted once per item, whichever of its events says so.
      if (id === undefined || this.declined.add(id)) ctx.counts.declined += 1;
    }
    let label = ITEM_LABELS[itemType] ?? null;
    if (label === null) return true;
    if (itemType === "mcp_tool_call" && item["server"] === MCP_SERVER_KEY) label = "tasks";
    // One label per item: an item that starts, updates and completes is one step.
    if (id === undefined || this.labelled.add(id)) ctx.progress(label);
    return true;
  }

  /** Adds one turn's usage to the run's total. Codex's `input_tokens` includes cached input. */
  private usage(event: Json, ctx: ReadContext): void {
    const u = record(event["usage"]);
    if (u === undefined) {
      if (event["usage"] !== undefined) ctx.counts.malformed += 1;
      return;
    }
    const prev = ctx.usage ?? {};
    const next: Usage = {};
    const add = (key: keyof Usage, field: string): void => {
      const v = addCounts(prev[key], count(u[field]));
      if (v !== undefined) next[key] = v;
    };
    add("inputTokens", "input_tokens");
    add("cachedInputTokens", "cached_input_tokens");
    add("outputTokens", "output_tokens");
    add("reasoningOutputTokens", "reasoning_output_tokens");
    ctx.usageSeen(next);
  }

  judge(exit: ProcessExit): { ok: boolean; reason: OutcomeReason } {
    switch (this.turn) {
      case "completed":
        return exit.code === 0 && exit.signal === null
          ? { ok: true, reason: "success" }
          : { ok: false, reason: "exit_status" };
      case "failed":
        return { ok: false, reason: "agent_error" };
      default:
        return { ok: false, reason: "no_result" };
    }
  }

  result(): string | null {
    return null;
  }

  retained(): { keys: number; chars: number } {
    return {
      keys: this.labelled.size + this.declined.size,
      chars: this.labelled.chars + this.declined.chars,
    };
  }
}

/** A parser for one `codex-exec` run's stdout. */
export function createCodexExecParser(): StreamParser {
  return createParser("codex-exec", new CodexReader());
}
