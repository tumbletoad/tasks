// How each CLI's events become normalised run events and an outcome (A4 3.11.1, 3.11.4). The
// inputs are small synthetic events; assertions are on kinds, labels, counts and reasons.
import { describe, expect, test } from "vitest";
import {
  claudeToolLabel,
  createStreamParser,
  parseStream,
  type ProcessExit,
  type RunEvent,
} from "./index.ts";

const exit0: ProcessExit = { code: 0, signal: null };
const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const jsonl = (...events: object[]): string => events.map((e) => JSON.stringify(e) + "\n").join("");
const ofKind = <K extends RunEvent["kind"]>(events: RunEvent[], kind: K) =>
  events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind);

const init = (servers: object[] = [{ name: "tasks", status: "connected" }]) => ({
  type: "system",
  subtype: "init",
  session_id: ID,
  cwd: "/w",
  mcp_servers: servers,
});
const toolUse = (id: string, name: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});
const text = (t: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text: t }] },
});
const result = (fields: object) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  ...fields,
});

describe("[A4.5.parsers.events] claude-print events", () => {
  test("tool names map to label keys; a name is never passed on", () => {
    expect(claudeToolLabel("Bash")).toBe("command");
    expect(claudeToolLabel("PowerShell")).toBe("command");
    expect(claudeToolLabel("Edit")).toBe("edit");
    expect(claudeToolLabel("Read")).toBe("read");
    expect(claudeToolLabel("WebFetch")).toBe("web");
    expect(claudeToolLabel("TodoWrite")).toBe("plan");
    expect(claudeToolLabel("Task")).toBe("agent");
    expect(claudeToolLabel("mcp__tasks__get_task")).toBe("tasks");
    expect(claudeToolLabel("mcp__other__get_task")).toBe("tool");
    expect(claudeToolLabel("SomethingNew")).toBe("tool");
    expect(claudeToolLabel("__proto__")).toBe("tool");
    expect(claudeToolLabel("constructor")).toBe("tool");
    expect(claudeToolLabel(undefined)).toBe("tool");
  });

  test("init gives the native ID and the session; one label per tool call; text is a message", () => {
    const { events, outcome } = parseStream(
      "claude-print",
      jsonl(
        init(),
        toolUse("t1", "Bash"),
        toolUse("t1", "Bash"), // the same call repeated
        toolUse("t2", "mcp__tasks__probe"),
        text("first"),
        text("second"),
        result({ result: "final" }),
      ),
      exit0,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "native-id",
      "session",
      "progress",
      "progress",
      "message",
      "message",
      "finished",
    ]);
    expect(ofKind(events, "progress").map((e) => e.label)).toEqual(["command", "tasks"]);
    expect(ofKind(events, "session")[0]).toEqual({
      kind: "session",
      cwd: "/w",
      appTools: "connected",
    });
    expect(outcome.nativeId).toBe(ID);
    // The result event's text is the final result, not the last message.
    expect(outcome.result?.length).toBe(5);
    expect(outcome.reason).toBe("success");
  });

  test("a Tasks server that did not connect, and no Tasks server, are told apart", () => {
    const failed = parseStream(
      "claude-print",
      jsonl(init([{ name: "tasks", status: "failed" }])),
      exit0,
    );
    expect(failed.outcome.session?.appTools).toBe("not-connected");
    const absent = parseStream(
      "claude-print",
      jsonl(init([{ name: "other", status: "connected" }])),
      exit0,
    );
    expect(absent.outcome.session?.appTools).toBe("absent");
  });

  test("a second, different session ID is counted as malformed and the first is kept", () => {
    const { events, outcome } = parseStream(
      "claude-print",
      jsonl(init(), { ...init(), session_id: ID2 }, { ...init(), session_id: "not an id!" }),
      exit0,
    );
    expect(ofKind(events, "native-id")).toHaveLength(1);
    expect(outcome.nativeId).toBe(ID);
    expect(outcome.counts.malformed).toBe(2);
  });

  test("an init of another session does not replace the run's session facts", () => {
    const { events, outcome } = parseStream(
      "claude-print",
      jsonl(
        init(),
        { ...init([{ name: "tasks", status: "failed" }]), session_id: ID2, cwd: "/other" },
        { ...init([]), session_id: "not an id!", cwd: "/third" },
        { ...init([{ name: "tasks", status: "connected" }]), cwd: "/w2" }, // the same session
      ),
      exit0,
    );
    expect(outcome.nativeId).toBe(ID);
    expect(outcome.session).toEqual({ cwd: "/w2", appTools: "connected" });
    expect(ofKind(events, "session").map((e) => e.cwd)).toEqual(["/w", "/w2"]);
  });

  test("an init without a usable ID still gives the session when it is the first", () => {
    const { outcome } = parseStream("claude-print", jsonl({ ...init(), session_id: 7 }), exit0);
    expect(outcome.nativeId).toBeNull();
    expect(outcome.session).toEqual({ cwd: "/w", appTools: "connected" });
  });

  test("a type that is not a string is an unknown event, never a handler fault", () => {
    const stream =
      jsonl({ type: { toString: null } }, { type: ["user"] }) +
      `{"type":${"[".repeat(100_000)}${"]".repeat(100_000)}}\n`;
    for (const kind of ["claude-print", "codex-exec"] as const) {
      const { outcome } = parseStream(kind, stream, exit0);
      expect(outcome.counts.handlerFaults).toBe(0);
      expect(outcome.counts.unknownEvents).toBe(3);
    }
  });

  test("a BOM before a line is dropped the same way by push() and line()", () => {
    const lines = [init(), result({ result: "r" })].map((e) => "﻿" + JSON.stringify(e));
    const pushed = parseStream("claude-print", lines.join("\n") + "\n", exit0).outcome;
    const parser = createStreamParser("claude-print");
    for (const l of lines) parser.line(l);
    const fed = parser.end(exit0).outcome;
    expect(pushed.reason).toBe("success");
    expect(fed).toEqual(pushed);
  });

  test("the run is judged by is_error, then the exit; the subtype names the limit", () => {
    const judge = (fields: object, exit: ProcessExit = exit0) =>
      parseStream("claude-print", jsonl(init(), result(fields)), exit).outcome;
    expect(judge({})).toMatchObject({ ok: true, reason: "success" });
    expect(judge({}, { code: 1, signal: null })).toMatchObject({
      ok: false,
      reason: "exit_status",
    });
    expect(judge({}, { code: null, signal: "SIGTERM" }).reason).toBe("exit_status");
    // An invalid model: subtype success, is_error true, exit 1 (A4 3.11.3).
    expect(judge({ is_error: true, result: "e" }, { code: 1, signal: null })).toMatchObject({
      ok: false,
      reason: "agent_error",
      result: null,
    });
    // Ctrl+C: exit 0, is_error true, aborted.
    expect(
      judge({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" })
        .reason,
    ).toBe("interrupted");
    expect(judge({ subtype: "error_max_turns", is_error: true }).reason).toBe("max_turns");
    expect(judge({ subtype: "error_max_budget_usd", is_error: true }).reason).toBe("max_budget");
    expect(judge({ subtype: "error_during_execution", is_error: true }).reason).toBe("agent_error");
    // A release without is_error falls back to the subtype.
    expect(judge({ is_error: undefined }).reason).toBe("success");
    expect(judge({ is_error: "maybe", subtype: "error_new_kind" }).reason).toBe("agent_error");
    // Without is_error, a failed subtype's result text is the error, not the answer.
    expect(
      judge({ is_error: undefined, subtype: "error_during_execution", result: "went wrong" }),
    ).toMatchObject({ ok: false, reason: "agent_error", result: null, error: "went wrong" });
  });

  test("an API error's text is the error, not a message", () => {
    const { events, outcome } = parseStream(
      "claude-print",
      jsonl(
        init(),
        { ...text("api says no"), is_api_error_message: true, error: "model_not_found" },
        result({ is_error: true, result: "api says no" }),
      ),
      { code: 1, signal: null },
    );
    expect(ofKind(events, "message")).toHaveLength(0);
    expect(outcome.error?.length).toBe(11);
    expect(outcome.result).toBeNull();
  });

  test("the error of a failed result is its first errors entry", () => {
    const { outcome } = parseStream(
      "claude-print",
      jsonl(
        init(),
        result({ subtype: "error_during_execution", is_error: true, errors: [7, "boom"] }),
      ),
      exit0,
    );
    expect(outcome.error?.length).toBe(4);
  });

  test("usage totals include cached input; denials are counted", () => {
    const { events, outcome } = parseStream(
      "claude-print",
      jsonl(
        init(),
        result({
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 5,
          },
          total_cost_usd: 0.25,
          permission_denials: [{}, {}],
        }),
      ),
      exit0,
    );
    expect(ofKind(events, "usage")).toEqual([
      { kind: "usage", inputTokens: 60, cachedInputTokens: 30, outputTokens: 5, costUsd: 0.25 },
    ]);
    expect(outcome.usage).toEqual({
      inputTokens: 60,
      cachedInputTokens: 30,
      outputTokens: 5,
      costUsd: 0.25,
    });
    expect(outcome.counts.permissionDenials).toBe(2);
  });

  test("negative, fractional, huge or non-numeric usage values are left out", () => {
    const { outcome } = parseStream(
      "claude-print",
      jsonl(
        init(),
        result({
          usage: { input_tokens: -1, output_tokens: 1.5, cache_read_input_tokens: "9" },
          total_cost_usd: Infinity,
        }),
      ),
      exit0,
    );
    expect(outcome.usage).toBeNull();
  });
});

const thread = (id = ID) => ({ type: "thread.started", thread_id: id });
const item = (type: string, item: object) => ({ type, item });

describe("[A4.5.parsers.events] codex-exec events", () => {
  test("a repeated thread.started (exec resume) gives one native ID", () => {
    const { events } = parseStream("codex-exec", jsonl(thread(), thread()), exit0);
    expect(ofKind(events, "native-id")).toHaveLength(1);
  });

  test("one label per item; Tasks's MCP server is told apart; the last agent message is the result", () => {
    const cmd = { id: "i1", type: "command_execution", status: "in_progress" };
    const { events, outcome } = parseStream(
      "codex-exec",
      jsonl(
        thread(),
        { type: "turn.started" },
        item("item.started", cmd),
        item("item.updated", cmd),
        item("item.completed", { ...cmd, status: "completed" }),
        item("item.started", {
          id: "i2",
          type: "mcp_tool_call",
          server: "tasks",
          status: "in_progress",
        }),
        item("item.started", {
          id: "i3",
          type: "mcp_tool_call",
          server: "other",
          status: "in_progress",
        }),
        item("item.completed", { id: "i4", type: "file_change", status: "completed" }),
        item("item.completed", { id: "i5", type: "web_search" }),
        item("item.completed", { id: "i6", type: "todo_list" }),
        item("item.completed", { id: "i7", type: "reasoning", text: "r" }),
        item("item.started", { id: "i8", type: "agent_message", text: "partial" }),
        item("item.completed", { id: "i8", type: "agent_message", text: "one" }),
        item("item.completed", { id: "i9", type: "agent_message", text: "three" }),
        { type: "turn.completed", usage: { input_tokens: 1 } },
      ),
      exit0,
    );
    expect(ofKind(events, "progress").map((e) => e.label)).toEqual([
      "command",
      "tasks",
      "tool",
      "edit",
      "web",
      "plan",
    ]);
    expect(ofKind(events, "message")).toHaveLength(2);
    expect(outcome.result?.length).toBe(5);
    expect(outcome.reason).toBe("success");
  });

  test("a declined command is counted once", () => {
    const cmd = { id: "i1", type: "command_execution", status: "declined" };
    const { outcome } = parseStream(
      "codex-exec",
      jsonl(thread(), item("item.updated", cmd), item("item.completed", cmd)),
      exit0,
    );
    expect(outcome.counts.declined).toBe(1);
  });

  test("usage is summed over turns, and each usage event carries the total", () => {
    const usage = {
      input_tokens: 10,
      cached_input_tokens: 4,
      output_tokens: 2,
      reasoning_output_tokens: 1,
    };
    const { events } = parseStream(
      "codex-exec",
      jsonl(thread(), { type: "turn.completed", usage }, { type: "turn.completed", usage }),
      exit0,
    );
    expect(ofKind(events, "usage").at(-1)).toEqual({
      kind: "usage",
      inputTokens: 20,
      cachedInputTokens: 8,
      outputTokens: 4,
      reasoningOutputTokens: 2,
    });
  });

  test("the last turn event decides; a recovered error does not fail the run", () => {
    const judge = (exit: ProcessExit, ...events: object[]) =>
      parseStream("codex-exec", jsonl(thread(), ...events), exit).outcome;
    const completed = { type: "turn.completed", usage: {} };
    const failed = { type: "turn.failed", error: { message: "bad" } };
    expect(judge(exit0, { type: "error", message: "retrying" }, completed)).toMatchObject({
      ok: true,
      reason: "success",
      error: null,
    });
    const f = judge({ code: 1, signal: null }, { type: "turn.started" }, failed);
    expect(f.reason).toBe("agent_error");
    expect(f.error?.length).toBe(3);
    expect(judge({ code: 1, signal: null }, completed).reason).toBe("exit_status");
    expect(judge({ code: 1, signal: null }, { type: "turn.started" }).reason).toBe("no_result");
    expect(judge({ code: 0, signal: null }, { type: "turn.started" }).reason).toBe("no_result");
  });

  test("an error item is kept as the last error, and an unknown item type is counted", () => {
    const { outcome } = parseStream(
      "codex-exec",
      jsonl(
        thread(),
        item("item.completed", { id: "e", type: "error", message: "abc" }),
        item("item.completed", { id: "x", type: "hologram" }),
      ),
      { code: 1, signal: null },
    );
    expect(outcome.error?.length).toBe(3);
    expect(outcome.counts.unknownEvents).toBe(1);
  });

  test("a stream with no event at all is no_output, whatever the exit", () => {
    expect(parseStream("codex-exec", "", exit0).outcome.reason).toBe("no_output");
    expect(parseStream("codex-exec", "garbage\n\n", exit0).outcome.reason).toBe("no_output");
    expect(parseStream("claude-print", "", { code: 1, signal: null }).outcome.reason).toBe(
      "no_output",
    );
  });
});
